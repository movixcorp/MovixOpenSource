const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const PUBLIC_DNS = async () => [{ address: '104.21.48.1', family: 4 }];
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function response(body, options = {}) {
  const headers = new Map(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status: options.status ?? 200,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    compressedBytes: options.compressedBytes,
    body,
  };
}

function createHttpsHarness({ status = 200, headers = {}, chunks = [], respond = true } = {}) {
  const state = {
    options: null,
    requestDestroyed: false,
    responseDestroyed: false,
    timeoutMs: null,
    triggerTimeout: null,
  };
  function request(options, onResponse) {
    state.options = options;
    const req = new EventEmitter();
    req.setTimeout = (milliseconds, callback) => {
      state.timeoutMs = milliseconds;
      state.triggerTimeout = callback;
      return req;
    };
    req.destroy = () => {
      state.requestDestroyed = true;
      return req;
    };
    req.end = () => {
      if (!respond) return;
      const res = Readable.from(chunks);
      res.statusCode = status;
      res.headers = headers;
      const destroy = res.destroy.bind(res);
      res.destroy = (error) => {
        state.responseDestroyed = true;
        return destroy(error);
      };
      onResponse(res);
    };
    return req;
  }
  return { request, state };
}

test('known bundle and module hashes select kkey-v1 without evaluating code', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let evaluated = false;
  let fetchCalls = 0;
  const registry = createBundleRegistry({
    fetchText: async (url) => {
      fetchCalls += 1;
      return url.includes('common.js') ? 'approved module fixture' : 'approved bundle fixture';
    },
    hashText: (value) => value.includes('module') ? HASH_B : HASH_A,
    approved: new Map([[HASH_A, { algorithmVersion: 'kkey-v1', moduleSha256: HASH_B, keyHex: '00'.repeat(16), ivHex: '11'.repeat(16), contexts: {} }]]),
    now: () => 1_000,
    resolveDns: PUBLIC_DNS,
    evaluate: () => { evaluated = true; },
  });
  assert.equal((await registry.resolveApprovedAlgorithm()).algorithmVersion, 'kkey-v1');
  assert.equal(fetchCalls, 2);
  assert.equal(evaluated, false);
});

test('unknown hash fails closed as provider_changed', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  const registry = createBundleRegistry({
    fetchText: async () => 'changed',
    hashText: () => 'c'.repeat(64),
    approved: new Map(),
    now: () => 1_000,
    resolveDns: PUBLIC_DNS,
  });
  await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_changed');
});

test('approved records require a lowercase module SHA-256 and never skip the module fetch', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  for (const moduleSha256 of [undefined, 'short', HASH_B.toUpperCase()]) {
    let fetchCalls = 0;
    const registry = createBundleRegistry({
      fetchText: async () => { fetchCalls += 1; return 'bundle'; },
      hashText: () => HASH_A,
      approved: new Map([[HASH_A, { algorithmVersion: 'kkey-v1', moduleSha256 }]]),
      resolveDns: PUBLIC_DNS,
    });
    await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_changed');
    assert.equal(fetchCalls, 1);
  }
});

test('known bundle requires the exact statically approved module hash', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  const bundle = 'approved bundle';
  const moduleText = 'approved inert module';
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const algorithm = Object.freeze({ algorithmVersion: 'kkey-v1', moduleSha256: digest(moduleText) });
  const registry = createBundleRegistry({
    bundleUrl: 'https://kisskh.nl/route.js',
    moduleUrl: 'https://kisskh.nl/common.js',
    fetchText: async (url) => response(url.endsWith('common.js') ? moduleText : bundle),
    approved: new Map([[digest(bundle), algorithm]]),
    resolveDns: PUBLIC_DNS,
  });
  assert.equal(await registry.resolveApprovedAlgorithm(), algorithm);

  const changedRegistry = createBundleRegistry({
    bundleUrl: 'https://kisskh.nl/route.js',
    moduleUrl: 'https://kisskh.nl/common.js',
    fetchText: async (url) => response(url.endsWith('common.js') ? 'changed module' : bundle),
    approved: new Map([[digest(bundle), algorithm]]),
    resolveDns: PUBLIC_DNS,
  });
  await assert.rejects(changedRegistry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_changed');
});

test('registry rejects invalid origins and mixed public/private DNS before fetching', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let fetched = false;
  const invalidOrigin = createBundleRegistry({
    bundleUrl: 'https://kisskh.nl.attacker.example/route.js',
    fetchText: async () => { fetched = true; return 'bundle'; },
    approved: new Map(),
    resolveDns: PUBLIC_DNS,
  });
  await assert.rejects(invalidOrigin.resolveApprovedAlgorithm(), (error) => error.code === 'provider_security');
  assert.equal(fetched, false);

  const mixedDns = createBundleRegistry({
    fetchText: async () => { fetched = true; return 'bundle'; },
    approved: new Map(),
    resolveDns: async () => [
      { address: '104.21.48.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  });
  await assert.rejects(mixedDns.resolveApprovedAlgorithm(), (error) => error.code === 'provider_security');
  assert.equal(fetched, false);
});

test('registry manually revalidates DNS after every redirect', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let dnsCalls = 0;
  let fetchCalls = 0;
  const registry = createBundleRegistry({
    bundleUrl: 'https://kisskh.nl/first.js',
    fetchText: async () => {
      fetchCalls += 1;
      return response('', { status: 302, headers: { location: '/second.js' } });
    },
    approved: new Map(),
    resolveDns: async () => {
      dnsCalls += 1;
      return dnsCalls === 1
        ? [{ address: '104.21.48.1', family: 4 }]
        : [{ address: '10.0.0.1', family: 4 }];
    },
  });
  await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_security');
  assert.equal(dnsCalls, 2);
  assert.equal(fetchCalls, 1);
});

test('registry rejects compressed and decompressed responses over two MiB', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  const tooLarge = 2 * 1024 * 1024 + 1;
  const compressed = createBundleRegistry({
    fetchText: async () => response('small', { compressedBytes: tooLarge }),
    approved: new Map(),
    resolveDns: PUBLIC_DNS,
  });
  await assert.rejects(compressed.resolveApprovedAlgorithm(), (error) => error.code === 'provider_security');

  const decompressed = createBundleRegistry({
    fetchText: async () => response(Buffer.alloc(tooLarge)),
    approved: new Map(),
    resolveDns: PUBLIC_DNS,
  });
  await assert.rejects(decompressed.resolveApprovedAlgorithm(), (error) => error.code === 'provider_security');
});

test('default HTTPS transport pins lookup while preserving TLS SNI and Host', async () => {
  const { createPinnedHttpsFetcher } = require('../bundleRegistry');
  const harness = createHttpsHarness({ chunks: [Buffer.from('approved source')] });
  const fetchText = createPinnedHttpsFetcher({ request: harness.request, timeoutMs: 1_000 });
  const result = await fetchText('https://kisskh.nl/route.js?v=1', {
    addresses: ['104.21.48.1', '2606:4700:3030::6815:3001'],
    maxBytes: MAX_SOURCE_BYTES,
  });
  assert.equal(result.body.toString('utf8'), 'approved source');
  assert.equal(harness.state.options.hostname, 'kisskh.nl');
  assert.equal(harness.state.options.servername, 'kisskh.nl');
  assert.equal(harness.state.options.headers.Host, 'kisskh.nl');
  assert.equal(harness.state.options.agent, false);
  assert.equal(harness.state.options.path, '/route.js?v=1');
  assert.equal(harness.state.options.headers['Accept-Encoding'], 'identity');
  const lookupResult = await new Promise((resolve, reject) => {
    harness.state.options.lookup('kisskh.nl', { family: 4 }, (error, address, family) => {
      if (error) reject(error); else resolve({ address, family });
    });
  });
  assert.deepEqual(lookupResult, { address: '104.21.48.1', family: 4 });
});

test('default HTTPS transport refuses a non-public pinned address defensively', async () => {
  const { createPinnedHttpsFetcher } = require('../bundleRegistry');
  const harness = createHttpsHarness({ chunks: [Buffer.from('must not be fetched')] });
  const fetchText = createPinnedHttpsFetcher({ request: harness.request, timeoutMs: 1_000 });
  await assert.rejects(
    fetchText('https://kisskh.nl/route.js', { addresses: ['127.0.0.1'], maxBytes: MAX_SOURCE_BYTES }),
    (error) => error.code === 'provider_security',
  );
  assert.equal(harness.state.options, null);
});

test('default HTTPS transport destroys chunked responses as soon as the wire limit is exceeded', async () => {
  const { createPinnedHttpsFetcher } = require('../bundleRegistry');
  const harness = createHttpsHarness({
    headers: { 'transfer-encoding': 'chunked' },
    chunks: [Buffer.alloc(MAX_SOURCE_BYTES), Buffer.alloc(1)],
  });
  const fetchText = createPinnedHttpsFetcher({ request: harness.request, timeoutMs: 1_000 });
  await assert.rejects(
    fetchText('https://kisskh.nl/route.js', { addresses: ['104.21.48.1'], maxBytes: MAX_SOURCE_BYTES }),
    (error) => error.code === 'provider_security',
  );
  assert.equal(harness.state.responseDestroyed, true);
  assert.equal(harness.state.requestDestroyed, true);
});

test('default HTTPS transport fails closed and destroys encoded responses', async () => {
  const { createPinnedHttpsFetcher } = require('../bundleRegistry');
  const harness = createHttpsHarness({ headers: { 'content-encoding': 'gzip' }, chunks: [Buffer.from('encoded')] });
  const fetchText = createPinnedHttpsFetcher({ request: harness.request, timeoutMs: 1_000 });
  await assert.rejects(
    fetchText('https://kisskh.nl/route.js', { addresses: ['104.21.48.1'], maxBytes: MAX_SOURCE_BYTES }),
    (error) => error.code === 'provider_security',
  );
  assert.equal(harness.state.responseDestroyed, true);
  assert.equal(harness.state.requestDestroyed, true);
});

test('default HTTPS transport destroys a request on timeout', async () => {
  const { createPinnedHttpsFetcher } = require('../bundleRegistry');
  const harness = createHttpsHarness({ respond: false });
  const fetchText = createPinnedHttpsFetcher({ request: harness.request, timeoutMs: 123 });
  const pending = fetchText('https://kisskh.nl/route.js', { addresses: ['104.21.48.1'], maxBytes: MAX_SOURCE_BYTES });
  assert.equal(harness.state.timeoutMs, 123);
  harness.state.triggerTimeout();
  await assert.rejects(pending, (error) => error.code === 'provider_unavailable');
  assert.equal(harness.state.requestDestroyed, true);
});

test('registry caches for 900 seconds and uses last known only for transient checks under 86400 seconds', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let now = 0;
  let fetchCalls = 0;
  let fail = false;
  const registry = createBundleRegistry({
    fetchText: async (url) => {
      fetchCalls += 1;
      if (fail) throw new Error('temporary network failure');
      return url.includes('common.js') ? 'module' : 'known';
    },
    hashText: (value) => value === 'module' ? HASH_B : HASH_A,
    approved: new Map([[HASH_A, { algorithmVersion: 'kkey-v1', moduleSha256: HASH_B }]]),
    resolveDns: PUBLIC_DNS,
    now: () => now,
  });
  await registry.resolveApprovedAlgorithm();
  now = 899_999;
  await registry.resolveApprovedAlgorithm();
  assert.equal(fetchCalls, 2);
  fail = true;
  now = 900_001;
  assert.equal((await registry.resolveApprovedAlgorithm()).algorithmVersion, 'kkey-v1');
  now = 86_400_001;
  await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_unavailable');
});

test('concurrent cold resolutions share one bundle and module validation', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let fetchCalls = 0;
  const algorithm = { algorithmVersion: 'kkey-v1', bundleSha256: HASH_A, moduleSha256: HASH_B };
  const registry = createBundleRegistry({
    fetchText: async (url) => {
      fetchCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return url.includes('common.js') ? 'module' : 'known';
    },
    hashText: (value) => value === 'module' ? HASH_B : HASH_A,
    approved: new Map([[HASH_A, algorithm]]),
    resolveDns: PUBLIC_DNS,
  });

  const results = await Promise.all(Array.from({ length: 8 }, () => registry.resolveApprovedAlgorithm()));

  assert.equal(fetchCalls, 2);
  assert.ok(results.every((result) => result === algorithm));
});

test('a recent Redis validation seeds a fresh registry without downloading bundles', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  const now = 1_000_000;
  const algorithm = { algorithmVersion: 'kkey-v1', bundleSha256: HASH_A, moduleSha256: HASH_B };
  const registry = createBundleRegistry({
    fetchText: async () => { throw new Error('bundle download must not run'); },
    approved: new Map([[HASH_A, algorithm]]),
    resolveDns: PUBLIC_DNS,
    now: () => now,
    loadCurrentMetadata: async () => ({
      algorithmVersion: 'kkey-v1',
      bundleSha256: HASH_A,
      moduleSha256: HASH_B,
      checkedAt: now - 30_000,
    }),
  });

  assert.equal(await registry.resolveApprovedAlgorithm(), algorithm);
});

test('registry honors injected bounded check and stale TTLs', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let now = 0;
  let fetchCalls = 0;
  let fail = false;
  const registry = createBundleRegistry({
    fetchText: async (url) => {
      fetchCalls += 1;
      if (fail) throw new Error('temporary network failure');
      return url.includes('common.js') ? 'module' : 'known';
    },
    hashText: (value) => value === 'module' ? HASH_B : HASH_A,
    approved: new Map([[HASH_A, { algorithmVersion: 'kkey-v1', moduleSha256: HASH_B }]]),
    resolveDns: PUBLIC_DNS,
    now: () => now,
    checkTtlSeconds: 2,
    staleMaxSeconds: 5,
  });
  await registry.resolveApprovedAlgorithm();
  now = 1_999;
  await registry.resolveApprovedAlgorithm();
  assert.equal(fetchCalls, 2);
  fail = true;
  now = 2_000;
  assert.equal((await registry.resolveApprovedAlgorithm()).algorithmVersion, 'kkey-v1');
  now = 5_001;
  await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_unavailable');

  assert.throws(() => createBundleRegistry({ checkTtlSeconds: 901 }), /check TTL/i);
  assert.throws(() => createBundleRegistry({ staleMaxSeconds: 86_401 }), /stale TTL/i);
});

test('newly observed unknown hash is never hidden by the stale cache', async () => {
  const { createBundleRegistry } = require('../bundleRegistry');
  let now = 0;
  let text = 'known';
  const registry = createBundleRegistry({
    fetchText: async (url) => url.includes('common.js') ? 'module' : text,
    hashText: (value) => value === 'known' ? HASH_A : value === 'module' ? HASH_B : 'c'.repeat(64),
    approved: new Map([[HASH_A, { algorithmVersion: 'kkey-v1', moduleSha256: HASH_B }]]),
    resolveDns: PUBLIC_DNS,
    now: () => now,
  });
  await registry.resolveApprovedAlgorithm();
  now = 900_001;
  text = 'unknown';
  await assert.rejects(registry.resolveApprovedAlgorithm(), (error) => error.code === 'provider_changed');
});

test('KisskhError omits sensitive details from public serialization', () => {
  const { KisskhError } = require('../errors');
  const cause = new Error('internal cause');
  const error = new KisskhError('provider_changed', 'Version KissKH non approuvee', {
    cause,
    details: { kkey: 'sensitive-value', mediaUrl: 'https://media.invalid/signed?token=secret' },
  });
  assert.equal(error.cause, cause);
  assert.deepEqual(error.toJSON(), { code: 'provider_changed', message: 'Version KissKH non approuvee' });
  assert.doesNotMatch(JSON.stringify(error), /details|sensitive-value|media\.invalid|secret/i);
});
