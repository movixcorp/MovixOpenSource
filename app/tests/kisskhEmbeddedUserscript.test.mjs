import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../..', import.meta.url);
const PRE_TASK8_EMBEDDED_SHA256 = '89f3e63e5b206c69ceaf36c762002ec64563e465a72b38c2b476749984f408d9';

function expectedOutput(userscript) {
  const source = userscript.replace(
    /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/,
    '',
  );
  const escaped = source
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  return `/**
 * Source du userscript Movix.
 *
 * AUTO-GÉNÉRÉ par scripts/build-userscript.js
 * Ne pas modifier manuellement.
 *
 * Pour régénérer : node scripts/build-userscript.js
 */

export const USERSCRIPT_SOURCE = \`${escaped}\`;
`;
}

test('embedded mobile userscript is current, exposes KissKH without the generated policy and check mode does not write', async () => {
  const userscriptUrl = new URL('userscript/movix.user.js', ROOT);
  const embeddedUrl = new URL('app/src/injection/userscript-source.ts', ROOT);
  const buildUrl = new URL('app/scripts/build-userscript.js', ROOT);
  const [userscript, embedded] = await Promise.all([
    readFile(userscriptUrl, 'utf8'),
    readFile(embeddedUrl, 'utf8'),
  ]);
  assert.equal(embedded, expectedOutput(userscript));
  assert.match(embedded, /KISSKH_FALLBACK/);
  assert.match(embedded, /movixKisskhFallback/);
  assert.doesNotMatch(embedded, /MovixKisskhPolicy|GENERATED KISSKH FALLBACK POLICY/);
  assert.notEqual(
    createHash('sha256').update(embedded).digest('hex'),
    PRE_TASK8_EMBEDDED_SHA256,
    'embedded artifact must not retain the pre-Task-8 content',
  );
  const before = createHash('sha256').update(embedded).digest('hex');
  const check = spawnSync(process.execPath, [fileURLToPath(buildUrl), '--check'], {
    cwd: fileURLToPath(ROOT),
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const after = createHash('sha256')
    .update(await readFile(embeddedUrl, 'utf8'))
    .digest('hex');
  assert.equal(after, before, '--check must be genuinely non-writing');
});

test('extensions no longer load or publish the generated KissKH policy', async () => {
  const chromeBackgroundUrl = new URL('extension/Chrome/background.js', ROOT);
  const firefoxManifestUrl = new URL('extension/Firefox/manifest.json', ROOT);
  const [chromeBackground, firefoxManifest] = await Promise.all([
    readFile(chromeBackgroundUrl, 'utf8'),
    readFile(firefoxManifestUrl, 'utf8').then(JSON.parse),
  ]);

  assert.doesNotMatch(chromeBackground, /kisskh-policy\.js|MovixKisskhPolicy/);
  assert.equal(firefoxManifest.background.scripts.includes('kisskh-policy.js'), false);

  for (const relativePath of [
    'extension/Chrome/kisskh-policy.js',
    'extension/Firefox/kisskh-policy.js',
  ]) {
    await assert.rejects(access(new URL(relativePath, ROOT)), { code: 'ENOENT' });
  }
});
