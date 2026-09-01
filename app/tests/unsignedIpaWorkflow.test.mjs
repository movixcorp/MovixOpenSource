import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('unsigned IPA packager validates inputs and produces the unsigned artifacts', async () => {
  const [packager, packageJson] = await Promise.all([
    readFile(new URL('../scripts/package-unsigned-ios.sh', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

  assert.match(packager, /IOS_APP_PATH:\?IOS_APP_PATH is required/);
  assert.match(packager, /IOS_OUTPUT_DIR:\?IOS_OUTPUT_DIR is required/);
  assert.match(packager, /Payload\/Movix\.app/);
  assert.match(packager, /_CodeSignature/);
  assert.match(packager, /embedded\.mobileprovision/);
  assert.match(packager, /shasum -a 256/);
  assert.match(packager, /source_app_input="\$IOS_APP_PATH"/);
  assert.match(packager, /while \[ "\$source_app_input" != "\/" \] && \[ "\$\{source_app_input%\/\}" != "\$source_app_input" \]; do/);
  assert.match(packager, /source_app_input="\$\{source_app_input%\/\}"/);
  assert.match(packager, /\[ -L "\$source_app_input" \]/);
  assert.match(packager, /\[ "\$resolved_output_dir" = "\/" \]/);
  assert.match(packager, /payload_dir="\$resolved_output_dir\/Payload"/);
  assert.match(packager, /source_app_path="\$\(cd "\$source_app_input" && pwd -P\)"/);
  assert.match(packager, /case "\$resolved_output_dir" in[\s\S]*"\$source_app_path"\|"\$source_app_path"\/\*/);
  assert.match(packager, /case "\$source_app_path" in[\s\S]*"\$payload_dir"\|"\$payload_dir"\/\*/);
  assert.match(packager, /export LC_ALL=C/);
  assert.match(packager, /touch -h -t 200101010000/);
  assert.match(packager, /\/usr\/bin\/find Payload -print \| \/usr\/bin\/sort \| \/usr\/bin\/zip -X -q -y Movix-unsigned\.ipa -@/);
  assert.equal(
    JSON.parse(packageJson).scripts['package:ios-unsigned'],
    'bash scripts/package-unsigned-ios.sh',
  );
});

const workflowUrl = new URL(
  '../../.github/workflows/ios-unsigned.yml',
  import.meta.url,
);

async function readWorkflow() {
  return readFile(workflowUrl, 'utf8');
}

test('unsigned IPA workflow uses the expected triggers and bounded concurrency', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /tags:\s*\n\s*- ['"]ios-v\*['"]/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress:/);
  assert.match(workflow, /timeout-minutes:/);
});

test('build job has read-only permissions and uses pinned official setup actions', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /build:[\s\S]*?permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /uses: actions\/setup-node@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /uses: actions\/download-artifact@[0-9a-f]{40}\s+# v4/);
  assert.doesNotMatch(workflow, /uses: actions\/[^@\s]+@v\d+/);
  assert.doesNotMatch(workflow, /uses: (?!actions\/)[^\s]+/);
});

test('build job installs reproducible JavaScript and ephemeral CocoaPods dependencies', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /runs-on: macos-26/);
  assert.match(workflow, /node-version: ['"]22['"]/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run build:userscript/);
  assert.match(workflow, /working-directory: app\/ios\s*\n\s*run: pod install/);
  assert.doesNotMatch(workflow, /pod install[^\n]*--deployment/);
  assert.match(workflow, /pod install[\s\S]*name: Movix-Podfile-lock-\$\{\{ steps\.artifact\.outputs\.version \}\}-\$\{\{ github\.run_number \}\}/);
  assert.match(workflow, /path: app\/ios\/Podfile\.lock/);
});

test('build job runs contracts and chooses an available iPhone simulator dynamically', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /npm run test:ios-contract/);
  assert.match(workflow, /tests\/unsignedIpaWorkflow\.test\.mjs/);
  assert.match(workflow, /tests\/mediaProxyRouting\.test\.mjs/);
  assert.match(workflow, /tests\/mediaProxyRuntime\.test\.mjs/);
  assert.match(workflow, /tests\/mediaProxyBridgeContract\.test\.mjs/);
  assert.match(workflow, /simctl list devices available/);
  assert.match(workflow, /platform=iOS Simulator,id=\$\{\{ steps\.[^.]+\.outputs\.[^}]+ \}\}/);
  assert.doesNotMatch(workflow, /OS=\d+(?:\.\d+)+/);
});

test('build job produces and validates an unsigned arm64 device IPA', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /-destination ['"]generic\/platform=iOS['"]/);
  assert.match(workflow, /-configuration Release/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /CODE_SIGNING_REQUIRED=NO/);
  assert.match(workflow, /bash scripts\/package-unsigned-ios\.sh/);
  assert.match(workflow, /PlistBuddy[\s\S]*CFBundleIdentifier/);
  assert.match(workflow, /PlistBuddy[\s\S]*MinimumOSVersion/);
  assert.match(workflow, /lipo -archs[\s\S]*grep -qw arm64/);
  assert.match(workflow, /test ! -e [^\n]*_CodeSignature/);
  assert.match(workflow, /test ! -e [^\n]*embedded\.mobileprovision/);
  assert.match(workflow, /unzip -t [^\n]*Movix-unsigned\.ipa/);
  assert.match(workflow, /\(cd build\/unsigned-ipa && shasum -a 256 -c Movix-unsigned\.ipa\.sha256\)/);
  assert.doesNotMatch(workflow, /p12|provisioning|app-store|testflight|APPLE_/i);
});

test('artifact name includes app.json version and run number', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /app\.json[\s\S]*\.version/);
  assert.match(workflow, /\[\[ ! "\$VERSION" =~ \^\[0-9\]\+/);
  assert.match(workflow, /Movix-unsigned-\$\{\{ steps\.[^.]+\.outputs\.version \}\}-\$\{\{ github\.run_number \}\}/);
  assert.match(workflow, /Movix-unsigned\.ipa\.sha256/);
});

test('tag releases are isolated in a write-enabled job fed only by the build artifact', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /release:[\s\S]*?needs: build/);
  assert.match(workflow, /release:[\s\S]*?if: startsWith\(github\.ref, ['"]refs\/tags\/ios-v['"]\)/);
  assert.match(workflow, /release:[\s\S]*?permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /uses: actions\/download-artifact@[0-9a-f]{40}\s+# v4/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
});

test('tagged releases commit the IPA next to the Android build', async () => {
  const workflow = await readWorkflow();

  // Le fichier vit dans app/ comme movix-android.apk, pour rester
  // téléchargeable depuis raw.githubusercontent.
  assert.match(
    workflow,
    /install -m 644 dist\/Movix-unsigned\.ipa app\/movix-ios-unsigner\.ipa/,
  );
  // Rien d'autre que ce chemin ne doit être indexé : dist/ est dans le workspace.
  assert.match(workflow, /git add -- app\/movix-ios-unsigner\.ipa/);
  // Le commit vient après la vérification d'empreinte, jamais avant.
  const checksumIndex = workflow.indexOf('Verify the checksum before publishing');
  const commitIndex = workflow.indexOf('Commit the IPA next to the Android build');
  assert.ok(checksumIndex > 0 && commitIndex > checksumIndex);
  // Le checkout doit précéder le download-artifact, sinon il efface dist/.
  const checkoutIndex = workflow.indexOf('default_branch }}', commitIndex - 4000);
  assert.ok(checkoutIndex > 0 && checkoutIndex < workflow.indexOf('path: dist'));
  // Une exécution concurrente ne doit pas faire échouer la publication.
  assert.match(workflow, /git pull --rebase origin "\$\{DEFAULT_BRANCH\}"/);
  assert.match(workflow, /git push origin "HEAD:\$\{DEFAULT_BRANCH\}"/);
});

const generatorPath = fileURLToPath(
  new URL('../scripts/generate-ios-source.mjs', import.meta.url),
);

function generatorEnv(overrides = {}) {
  return {
    ...process.env,
    IOS_SOURCE_VERSION: '9.9.9',
    IOS_SOURCE_BUILD_NUMBER: '42',
    IOS_SOURCE_MIN_OS: '15.1',
    // N'importe quel fichier lisible fait office d'IPA pour la taille.
    IOS_SOURCE_IPA_PATH: generatorPath,
    IOS_SOURCE_DATE: '2026-01-02T03:04:05+02:00',
    IOS_SOURCE_DOWNLOAD_URL: 'https://example.test/movix-ios-unsigner.ipa',
    IOS_SOURCE_ICON_URL: 'https://example.test/icon-1024.png',
    IOS_SOURCE_NOTES_URL: 'https://example.test/releases/tag/ios-v9.9.9',
    ...overrides,
  };
}

test('sidestore source generator produces a source consistent with its inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movix-ios-source-'));
  try {
    const output = join(dir, 'movix-ios-source.json');
    execFileSync(process.execPath, [generatorPath], {
      env: generatorEnv({
        IOS_SOURCE_OUTPUT: output,
        IOS_SCARLET_OUTPUT: join(dir, 'movix-scarlet-source.json'),
      }),
    });

    const source = JSON.parse(await readFile(output, 'utf8'));
    // Clés primaires des stores : figées pour toujours.
    assert.equal(source.identifier, 'com.movix.source');
    const app = source.apps[0];
    assert.equal(app.bundleIdentifier, 'com.movix.app');

    const latest = app.versions[0];
    assert.equal(latest.version, '9.9.9');
    assert.equal(latest.buildVersion, '42');
    assert.equal(latest.date, '2026-01-02');
    assert.equal(latest.minOSVersion, '15.1');
    assert.equal(latest.downloadURL, 'https://example.test/movix-ios-unsigner.ipa');
    assert.equal(latest.size, (await stat(generatorPath)).size);

    // Champs hérités du premier format : duplication exacte de la dernière
    // version, pour les anciens AltStore.
    assert.equal(app.version, latest.version);
    assert.equal(app.versionDate, latest.date);
    assert.equal(app.downloadURL, latest.downloadURL);
    assert.equal(app.size, latest.size);

    // L'IPA est compilée sans entitlements : la source ne doit en déclarer aucun.
    assert.deepEqual(app.appPermissions, { entitlements: [], privacy: {} });

    // Le domaine du site tourne sous blocage FAI. Le lien n'est lu que par
    // l'interface du store, mais il ne doit jamais renvoyer vers un domaine
    // mort : movix.tax ne répond plus depuis longtemps.
    assert.match(source.website, /^https:\/\//);
    assert.doesNotMatch(source.website, /movix\.tax/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scarlet source describes the same IPA in scarlet own format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movix-scarlet-source-'));
  try {
    const scarletOutput = join(dir, 'movix-scarlet-source.json');
    const output = join(dir, 'movix-ios-source.json');
    execFileSync(process.execPath, [generatorPath], {
      env: generatorEnv({
        IOS_SOURCE_OUTPUT: output,
        IOS_SCARLET_OUTPUT: scarletOutput,
      }),
    });

    const scarlet = JSON.parse(await readFile(scarletOutput, 'utf8'));
    // Format Scarlet : un bloc META, puis des seaux par catégorie. Movix n'est
    // ni un tweak ni un émulateur, donc « Other ».
    assert.equal(scarlet.META.repoName, 'Movix');
    assert.equal(scarlet.META.repoIcon, 'https://example.test/icon-1024.png');
    const entry = scarlet.Other[0];
    assert.equal(entry.name, 'Movix');
    assert.equal(entry.bundleID, 'com.movix.app');
    assert.equal(entry.version, '9.9.9');
    // `down` est l'équivalent Scarlet de `downloadURL` : la même IPA doit être
    // servie aux deux stores, jamais deux fichiers différents.
    const altStore = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(entry.down, altStore.apps[0].versions[0].downloadURL);
    assert.equal(entry.bundleID, altStore.apps[0].bundleIdentifier);
    assert.equal(entry.version, altStore.apps[0].versions[0].version);
    assert.equal(entry.contact.web, altStore.website);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sidestore source generator refuses malformed or missing inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movix-ios-source-'));
  try {
    const output = join(dir, 'movix-ios-source.json');
    const scarlet = join(dir, 'movix-scarlet-source.json');
    const cases = [
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: scarlet, IOS_SOURCE_VERSION: 'v9.9.9' },
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: scarlet, IOS_SOURCE_BUILD_NUMBER: 'quarante-deux' },
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: scarlet, IOS_SOURCE_DOWNLOAD_URL: 'http://example.test/movix.ipa' },
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: scarlet, IOS_SOURCE_IPA_PATH: join(dir, 'absent.ipa') },
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: scarlet, IOS_SOURCE_NOTES_URL: '' },
      // La sortie Scarlet est obligatoire : un oubli côté workflow doit faire
      // échouer la publication, pas produire une source sur deux.
      { IOS_SOURCE_OUTPUT: output, IOS_SCARLET_OUTPUT: '' },
    ];
    for (const overrides of cases) {
      assert.throws(
        () => execFileSync(process.execPath, [generatorPath], {
          env: generatorEnv(overrides),
          stdio: 'pipe',
        }),
        undefined,
        `should reject ${JSON.stringify(overrides)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tagged releases regenerate the sidestore source and commit it with the IPA', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /run: node app\/scripts\/generate-ios-source\.mjs/);
  // Les métadonnées viennent du job de build, jamais d'une saisie humaine.
  assert.match(workflow, /IOS_SOURCE_VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/);
  assert.match(workflow, /IOS_SOURCE_BUILD_NUMBER: \$\{\{ needs\.build\.outputs\.build_number \}\}/);
  assert.match(workflow, /IOS_SOURCE_MIN_OS: \$\{\{ needs\.build\.outputs\.min_os \}\}/);
  assert.match(workflow, /IOS_SOURCE_IPA_PATH: dist\/Movix-unsigned\.ipa/);
  // Les deux sources sortent du même run et sont commitées ensemble : jamais
  // une source à jour à côté d'une autre restée sur la version précédente.
  assert.match(workflow, /IOS_SOURCE_OUTPUT: app\/movix-ios-source\.json/);
  assert.match(workflow, /IOS_SCARLET_OUTPUT: app\/movix-scarlet-source\.json/);
  assert.match(
    workflow,
    /git add -- app\/movix-ios-unsigner\.ipa app\/movix-ios-source\.json app\/movix-scarlet-source\.json/,
  );
  // L'URL de téléchargement pointe sur l'IPA commitée dans le dépôt, pour que
  // source et IPA restent servies depuis le même commit.
  assert.match(
    workflow,
    /IOS_SOURCE_DOWNLOAD_URL: https:\/\/raw\.githubusercontent\.com\/\$\{\{ github\.repository \}\}\/\$\{\{ github\.event\.repository\.default_branch \}\}\/app\/movix-ios-unsigner\.ipa/,
  );
  assert.match(workflow, /git add -- app\/movix-ios-unsigner\.ipa app\/movix-ios-source\.json/);
  // min_os sort du binaire réellement compilé, côté build.
  assert.match(workflow, /min_os=\$MIN_OS/);
  assert.match(workflow, /min_os: \$\{\{ steps\.validate\.outputs\.min_os \}\}/);
  assert.match(workflow, /build_number=\$BUILD_NUMBER/);
  // Le build estampille l'IPA depuis app.json et la validation vérifie que le
  // binaire porte bien ces versions : la source ne peut pas diverger de l'IPA.
  assert.match(workflow, /MARKETING_VERSION=\$\{\{ steps\.artifact\.outputs\.version \}\}/);
  assert.match(workflow, /CURRENT_PROJECT_VERSION=\$\{\{ steps\.artifact\.outputs\.build_number \}\}/);
  assert.match(
    workflow,
    /test "\$\(\/usr\/libexec\/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$APP\/Info\.plist"\)" = "\$\{\{ steps\.artifact\.outputs\.version \}\}"/,
  );
  assert.match(
    workflow,
    /test "\$\(\/usr\/libexec\/PlistBuddy -c 'Print :CFBundleVersion' "\$APP\/Info\.plist"\)" = "\$\{\{ steps\.artifact\.outputs\.build_number \}\}"/,
  );
  // La génération suit la vérification d'empreinte et précède le commit.
  const checksumIndex = workflow.indexOf('Verify the checksum before publishing');
  const generateIndex = workflow.indexOf(
    'Generate the AltStore, SideStore and Scarlet sources',
  );
  const commitIndex = workflow.indexOf('Commit the IPA next to the Android build');
  assert.ok(checksumIndex > 0 && generateIndex > checksumIndex && commitIndex > generateIndex);
});

test('README explains how to download, verify, and externally sign the unsigned IPA', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /gh run download/);
  assert.match(readme, /Movix-unsigned-<version>-<run-number>/);
  assert.match(readme, /shasum -a 256 -c Movix-unsigned\.ipa\.sha256/);
  assert.match(readme, /IPA non signée/i);
  assert.match(readme, /impossible[^\n]+install/i);
  assert.match(readme, /propres moyens/i);
  assert.doesNotMatch(readme, /jamais été buildée/i);
});
