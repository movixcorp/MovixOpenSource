import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
