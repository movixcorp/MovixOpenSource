const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const POLICY_PATH = path.resolve(__dirname, '../../../../../config/kisskhFallbackPolicy.json');
const CANONICAL_HOSTS = 'auto.cdnvideo11.shop,sub.cdnvideo11.shop';

function enabledEnv(overrides = {}) {
  return {
    KISSKH_ENABLED: 'true',
    KISSKH_BROWSER_FALLBACK_ENABLED: 'true',
    KISSKH_SUBTITLE_ALLOWED_HOSTS: CANONICAL_HOSTS,
    KISSKH_SUBTITLE_MAX_BYTES: '2097152',
    ...overrides,
  };
}

test('canonical fallback policy has the exact strict shape', () => {
  const { loadFallbackPolicy } = require('../config');
  const policy = loadFallbackPolicy(POLICY_PATH);
  assert.deepEqual(Object.keys(policy), ['version', 'subtitleHosts', 'maxSubtitleBytes']);
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.subtitleHosts, ['auto.cdnvideo11.shop', 'sub.cdnvideo11.shop']);
  assert.equal(policy.maxSubtitleBytes, 2097152);
});

test('config ignores removed browser fallback and subtitle byte environment settings', () => {
  const { fromEnv } = require('../config');
  for (const value of ['0', '-1', '1.5', '1e3', ' 2097152', '2097152 ', '9007199254740992']) {
    const config = fromEnv(enabledEnv({
      KISSKH_BROWSER_FALLBACK_ENABLED: 'true',
      KISSKH_SUBTITLE_MAX_BYTES: value,
    }));
    assert.equal(config.browserFallbackEnabled, false);
    assert.equal(config.subtitleMaxBytes, 2097152);
  }
  for (const name of ['KISSKH_BUNDLE_CHECK_TTL_SECONDS', 'KISSKH_BUNDLE_STALE_MAX_SECONDS']) {
    assert.throws(() => fromEnv(enabledEnv({ [name]: '1.5' })), new RegExp(name));
  }
});

test('enabled KissKH does not require or expose an internal secret', () => {
  const { fromEnv } = require('../config');
  const config = fromEnv(enabledEnv({ KISSKH_INTERNAL_SECRET: '' }));
  assert.equal(Object.hasOwn(config, 'internalSecret'), false);
});

test('config rejects a missing or invalid canonical policy', () => {
  const { loadFallbackPolicy, validateFallbackPolicy } = require('../config');
  assert.throws(() => loadFallbackPolicy(path.join(__dirname, 'fixtures', 'missing-policy.json')), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: [], maxSubtitleBytes: 2097152 }), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: ['*.cdnvideo11.shop'], maxSubtitleBytes: 2097152 }), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: ['placeholder.example.com'], maxSubtitleBytes: 2097152 }), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: ['sub.cdnvideo11.shop', 'auto.cdnvideo11.shop'], maxSubtitleBytes: 2097152 }), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: ['auto.cdnvideo11.shop'], maxSubtitleBytes: 1000 }), /policy/i);
  assert.throws(() => validateFallbackPolicy({ version: 1, subtitleHosts: ['auto.cdnvideo11.shop'], maxSubtitleBytes: 2097152, extra: true }), /policy/i);
});

test('enabled KissKH keeps browser fallback disabled and canonical byte limit', () => {
  const { fromEnv } = require('../config');
  const config = fromEnv(enabledEnv());
  assert.equal(config.enabled, true);
  assert.equal(config.browserFallbackEnabled, false);
  assert.deepEqual(config.subtitleAllowedHosts, ['auto.cdnvideo11.shop', 'sub.cdnvideo11.shop']);
  assert.equal(config.subtitleMaxBytes, 2097152);
  assert.equal(config.bundleCheckTtlSeconds, 900);
  assert.equal(config.bundleStaleMaxSeconds, 86400);
});

test('enabled browser fallback accepts host drift separately', () => {
  const { fromEnv } = require('../config');
  const config = fromEnv(enabledEnv({ KISSKH_SUBTITLE_ALLOWED_HOSTS: 'sub.cdnvideo11.shop' }));
  assert.deepEqual(config.subtitleAllowedHosts, ['sub.cdnvideo11.shop']);
});

test('enabled KissKH ignores byte-limit drift', () => {
  const { fromEnv } = require('../config');
  const config = fromEnv(enabledEnv({ KISSKH_SUBTITLE_MAX_BYTES: '1048576' }));
  assert.equal(config.subtitleMaxBytes, 2097152);
});

test('disabled KissKH uses safe defaults without requiring a secret', () => {
  const { fromEnv } = require('../config');
  const config = fromEnv({});
  assert.equal(config.enabled, false);
  assert.equal(config.browserFallbackEnabled, false);
  assert.equal(Object.hasOwn(config, 'internalSecret'), false);
  assert.deepEqual(config.subtitleAllowedHosts, []);
  assert.equal(config.subtitleMaxBytes, 2097152);
});
