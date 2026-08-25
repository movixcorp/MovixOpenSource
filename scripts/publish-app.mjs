#!/usr/bin/env node
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const PATHS = {
  buildGradle: path.join(REPO_ROOT, 'app/android/app/build.gradle'),
  keystoreProps: path.join(REPO_ROOT, 'app/android/app/keystore.properties'),
  gradleWrapper: path.join(REPO_ROOT, 'app/android/gradlew'),
  apkOutput: path.join(
    REPO_ROOT,
    'app/android/app/build/outputs/apk/release/app-release.apk',
  ),
  publishedApk: path.join(REPO_ROOT, 'app/movix-android.apk'),
  manifest: path.join(REPO_ROOT, 'app/version.json'),
};

const APK_URL =
  'https://github.com/Movix-STMG/MovixOpenSource/raw/refs/heads/main/app/movix-android.apk';

function die(msg) {
  console.error(`\n[publish-app] ${msg}\n`);
  process.exit(1);
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function readBuildGradle() {
  const txt = fs.readFileSync(PATHS.buildGradle, 'utf8');
  const vc = txt.match(/versionCode\s+(\d+)/);
  const vn = txt.match(/versionName\s+"([^"]+)"/);
  if (!vc || !vn) {
    die('Could not parse versionCode/versionName from build.gradle');
  }
  return { versionCode: Number(vc[1]), versionName: vn[1] };
}

function readCurrentManifest() {
  try {
    const raw = fs.readFileSync(PATHS.manifest, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function promptMultiline(rl, label) {
  console.log(`${label} (ligne vide + Enter pour finir) :`);
  const lines = [];
  for (;;) {
    const line = await rl.question('> ');
    if (line === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

async function promptYesNo(rl, label, defaultNo = true) {
  const suffix = defaultNo ? '(y/N)' : '(Y/n)';
  const answer = (await rl.question(`${label} ${suffix} : `)).trim().toLowerCase();
  if (answer === '') return !defaultNo;
  return answer === 'y' || answer === 'yes' || answer === 'o' || answer === 'oui';
}

function runGradle() {
  const args = ['assembleRelease'];
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const cwd = path.dirname(PATHS.gradleWrapper);
  const res = spawnSync(wrapper, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) die(`gradle assembleRelease failed (exit ${res.status})`);
}

function verifyApkSigned() {
  const cmd = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  const res = spawnSync(cmd, ['verify', '--print-certs', PATHS.apkOutput], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.warn(
      '[publish-app] apksigner not found or verify failed — skipping signature check.\n' +
        '  Install Android build-tools or run apksigner manually to confirm release-signed.',
    );
    return;
  }
  if (/does not verify/i.test(res.stdout) || /debug/i.test(res.stdout)) {
    die(`APK appears debug-signed or invalid:\n${res.stdout}`);
  }
}

function computeSha256(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(65536);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function main() {
  log('1/7', 'Vérifications préalables…');

  if (!fs.existsSync(PATHS.keystoreProps)) {
    die(
      'app/android/keystore.properties absent — APK serait debug-signed (install = échec signature).\n' +
        '  Configure la release keystore avant de publier.',
    );
  }

  const { versionCode, versionName } = readBuildGradle();
  const current = readCurrentManifest();
  if (current && typeof current.buildNumber === 'number' && versionCode <= current.buildNumber) {
    die(
      `versionCode (${versionCode}) doit être > current.buildNumber (${current.buildNumber}).\n` +
        '  Bump `versionCode` dans app/android/app/build.gradle d\'abord.',
    );
  }
  console.log(
    `  ✓ keystore.properties présent\n` +
      `  ✓ versionCode=${versionCode}, versionName="${versionName}"` +
      (current ? ` (current JSON buildNumber=${current.buildNumber})` : ''),
  );

  const rl = readline.createInterface({ input, output });
  try {
    log('2/7', 'Release notes');
    const notesFr = await promptMultiline(rl, 'Locale FR (markdown)');
    const notesEn = await promptMultiline(rl, 'Locale EN (markdown)');

    log('3/7', 'Flag mandatory');
    const mandatory = await promptYesNo(rl, 'Update obligatoire ?', true);

    log('4/7', 'Build APK release (gradle assembleRelease)…');
    runGradle();
    if (!fs.existsSync(PATHS.apkOutput)) {
      die(`APK introuvable à ${PATHS.apkOutput}`);
    }

    log('5/7', 'Vérification de la signature APK…');
    verifyApkSigned();

    log('6/7', 'Copie de l\'APK + hashes…');
    fs.mkdirSync(path.dirname(PATHS.publishedApk), { recursive: true });
    fs.copyFileSync(PATHS.apkOutput, PATHS.publishedApk);
    const stat = fs.statSync(PATHS.publishedApk);
    const sha = computeSha256(PATHS.publishedApk);
    console.log(
      `  ✓ ${PATHS.publishedApk} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)\n` +
        `  ✓ SHA256=${sha}`,
    );

    log('7/7', 'Écriture de app/version.json…');
    const manifest = {
      version: versionName,
      buildNumber: versionCode,
      apkUrl: APK_URL,
      apkSizeBytes: stat.size,
      apkSha256: sha,
      mandatory,
      releasedAt: new Date().toISOString(),
      releaseNotes: { fr: notesFr, en: notesEn },
    };
    fs.writeFileSync(PATHS.manifest, JSON.stringify(manifest, null, 2) + '\n');

    console.log(
      '\n─────────────────────────────────────────────\n' +
        '✓ Publish ready. Next steps:\n\n' +
        '  git add app/version.json app/movix-android.apk app/android/app/build.gradle\n' +
        `  git commit -m "release(app): v${versionName} (build ${versionCode})"\n` +
        '  git push\n' +
        '─────────────────────────────────────────────\n',
    );
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('\n[publish-app] fatal', err);
  process.exit(1);
});
