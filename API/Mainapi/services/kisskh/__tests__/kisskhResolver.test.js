const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function createRedisDouble(now = () => Date.now()) {
  const values = new Map();
  const writes = [];
  const evalCalls = [];
  return {
    values,
    writes,
    evalCalls,
    async get(key) {
      const entry = values.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && now() >= entry.expiresAt) {
        values.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, mode, ttl, condition) {
      if (condition === 'NX' && values.has(key)) return null;
      const ttlMs = mode === 'PX' ? ttl : mode === 'EX' ? ttl * 1000 : null;
      values.set(key, { value: String(value), expiresAt: ttlMs === null ? null : now() + ttlMs });
      writes.push([key, String(value), mode, ttl, condition]);
      return 'OK';
    },
    async eval(script, keyCount, key, token, ttl) {
      evalCalls.push([script, keyCount, key, token, ttl]);
      const entry = values.get(key);
      if (entry?.value === token) {
        if (script.includes('PEXPIRE')) {
          entry.expiresAt = now() + Number(ttl);
          return 1;
        }
        values.delete(key);
        return 1;
      }
      return 0;
    },
    async getdel(key) {
      const value = await this.get(key);
      values.delete(key);
      return value;
    },
    async del(...keys) {
      keys.forEach((key) => values.delete(key));
    },
  };
}

function providerFixture() {
  return {
    match: {
      tmdbId: 154825,
      kisskhDramaId: 4608,
      episodeId: 86439,
      season: 1,
      episode: 3,
      evidence: { score: 126, titleSource: 'alternative' },
    },
    mediaUrl: 'https://media.example/master.m3u8?signature=sensitive',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
    subtitles: [
      { src: 'https://subs.example/en.srt?sig=one', label: 'English', land: 'en' },
      { src: 'https://subs.example/fr.txt?sig=two', label: 'Francais', land: 'fr' },
      { src: 'https://subs.example/legacy.txt1', label: 'Legacy a2', land: 'en' },
      { src: 'https://subs.example/legacy.txt2', label: 'Legacy a3', land: 'en' },
    ],
  };
}

function makeResolver(overrides = {}) {
  const nowState = overrides.nowState || { value: 1_000_000 };
  const now = () => nowState.value;
  const redis = overrides.redis || createRedisDouble(now);
  const deps = {
    redis,
    now,
    resolveDns: async () => [{ address: '93.184.216.34', family: 4 }],
    mediaAllowedHosts: ['media.example'],
    subtitleAllowedHosts: ['subs.example'],
    publicProxyUrl: 'https://proxy.example',
    bundleRegistry: {
      async resolveApprovedAlgorithm() {
        return {
          algorithmVersion: 'kkey-v1',
          bundleSha256: 'a'.repeat(64),
          moduleSha256: 'b'.repeat(64),
          subtitleCiphers: {
            a1: {
              keyBase64: 'MDEyMzQ1Njc4OWFiY2RlZg==',
              ivBase64: 'ZmVkY2JhOTg3NjU0MzIxMA==',
            },
            a3: {
              keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
              ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
            },
          },
        };
      },
    },
    ...overrides,
  };
  delete deps.nowState;
  const cache = require('../kisskhCache').createKisskhCache(deps);
  const capabilityStore = require('../kisskhCache').createFallbackCapabilityStore(deps);
  const resolver = require('../kisskhResolver').createKisskhResolver({
    ...deps,
    cache,
    capabilityStore,
  });
  return { resolver, redis, capabilityStore, cache, nowState };
}

test('concurrent identical resolutions share provider work and mint fresh fallback capabilities without proxy sessions', async () => {
  let providerCalls = 0;
  const setup = makeResolver({
    async resolveProvider() {
      providerCalls += 1;
      await Promise.resolve();
      return providerFixture();
    },
  });

  const results = await Promise.all(Array.from({ length: 10 }, () =>
    setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 })));

  assert.equal(providerCalls, 1);
  assert.equal(new Set(results.map((result) => result.sources[0].url)).size, 1);
  assert.equal(new Set(results.map((result) => result.sources[0].fallbackToken)).size, 10);
  assert.ok(results.every((result) => Buffer.from(result.sources[0].fallbackToken, 'base64url').length >= 16));
  const capabilityWrites = setup.redis.writes.filter(([key]) => key.startsWith('kisskh:fallback:v1:'));
  assert.equal(capabilityWrites.length, 10);
  assert.ok(capabilityWrites.every(([key, , mode, ttl]) => /^kisskh:fallback:v1:[a-f0-9]{64}$/.test(key)
    && mode === 'EX' && ttl === 120));
});

test('metadata cache TTLs are exact, sensitive payload stays in bounded local LRU, and lock release compares token', async () => {
  const setup = makeResolver({ resolveProvider: async () => providerFixture() });
  const result = await setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 });
  assert.equal(result.subtitles.length, 4);

  const matchWrite = setup.redis.writes.find(([key]) => key === 'kisskh:match:v1:tv:154825');
  const episodesWrite = setup.redis.writes.find(([key]) => key === 'kisskh:episodes:v2:4608');
  const bundleCurrentWrite = setup.redis.writes.find(([key]) => key === 'kisskh:bundle:current');
  const bundleLastKnownWrite = setup.redis.writes.find(([key]) => key === 'kisskh:bundle:last-known');
  assert.deepEqual(matchWrite.slice(2, 4), ['EX', 86_400]);
  assert.deepEqual(episodesWrite.slice(2, 4), ['EX', 21_600]);
  assert.deepEqual(bundleCurrentWrite.slice(2, 4), ['EX', 900]);
  assert.deepEqual(bundleLastKnownWrite.slice(2, 4), ['EX', 86_400]);
  assert.deepEqual(Object.keys(JSON.parse(bundleCurrentWrite[1])).sort(), [
    'algorithmVersion', 'bundleSha256', 'checkedAt', 'moduleSha256',
  ]);
  assert.equal(JSON.parse(bundleCurrentWrite[1]).checkedAt, setup.nowState.value);
  assert.deepEqual(await setup.cache.getCurrentBundleMetadata(), JSON.parse(bundleCurrentWrite[1]));
  const normalWrites = setup.redis.writes.filter(([key]) => /kisskh:(?:match|episodes|not-found):/.test(key));
  assert.doesNotMatch(JSON.stringify(normalWrites), /kkey|fallbackToken|mediaUrl|signature|keyBase64|ivBase64/i);
  assert.equal(await setup.cache.getSensitive('episode', 86439) !== null, true);
  assert.equal(await setup.cache.getSensitive('sub', 86439) !== null, true);
  assert.equal(setup.redis.writes.some(([key]) => /episode:86439|sub:86439/.test(key)), false);

  assert.equal(setup.redis.evalCalls.length, 1);
  const [script, keyCount, key, token] = setup.redis.evalCalls[0];
  assert.match(script, /GET/);
  assert.match(script, /DEL/);
  assert.equal(keyCount, 1);
  assert.equal(key, 'kisskh:lock:resolve:tv:154825:1:3');
  assert.ok(token.length >= 22);
  const lockWrite = setup.redis.writes.find(([writtenKey]) => writtenKey === key);
  assert.deepEqual(lockWrite.slice(2, 5), ['PX', 30_000, 'NX']);
});

test('distributed catalogue owner renews its lease so another worker cannot rebuild after the original TTL', async () => {
  const nowState = { value: 1_000 };
  const redis = createRedisDouble(() => nowState.value);
  let heartbeat = null;
  let finishOwner;
  let ownerStarted;
  let secondOperations = 0;
  const ownerReady = new Promise((resolve) => { ownerStarted = resolve; });
  const ownerGate = new Promise((resolve) => { finishOwner = resolve; });
  const shared = {
    redis,
    now: () => nowState.value,
    resolveLockMs: 100,
  };
  const { createKisskhCache } = require('../kisskhCache');
  const ownerCache = createKisskhCache({
    ...shared,
    setInterval(callback) { heartbeat = callback; return 1; },
    clearInterval() {},
  });
  const otherCache = createKisskhCache(shared);
  const ownerPromise = ownerCache.singleFlight(
    'kisskh:lock:catalog-refresh:v1',
    async () => {
      ownerStarted();
      await ownerGate;
      return 'owner';
    },
    { lockMs: 100, renewEveryMs: 40 },
  );
  await ownerReady;

  try {
    assert.equal(typeof heartbeat, 'function');
    nowState.value += 80;
    await heartbeat();
    nowState.value += 40;
    await assert.rejects(
      otherCache.singleFlight('kisskh:lock:catalog-refresh:v1', async () => {
        secondOperations += 1;
        return 'second';
      }, { lockMs: 100, renewEveryMs: 40 }),
      (error) => error.code === 'provider_unavailable',
    );
    assert.equal(secondOperations, 0);
  } finally {
    finishOwner();
    await ownerPromise;
  }
});

test('runtime TTL environment changes Redis EX, lock PX, local expiry, and capability expiry', async () => {
  const { parseRuntimeTtls } = require('../../../routes/kisskh');
  const ttlOptions = parseRuntimeTtls({
    KISSKH_MATCH_TTL_SECONDS: '11',
    KISSKH_EPISODES_TTL_SECONDS: '12',
    KISSKH_EPISODE_SUB_TTL_SECONDS: '3',
    KISSKH_NOT_FOUND_TTL_SECONDS: '13',
    KISSKH_RESOLVE_LOCK_MS: '14',
    KISSKH_FALLBACK_TOKEN_TTL_SECONDS: '15',
  }, {
    bundleCheckTtlSeconds: 16,
    bundleStaleMaxSeconds: 17,
  });
  const setup = makeResolver({
    ...ttlOptions,
    resolveProvider: async () => providerFixture(),
  });
  const result = await setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 });
  await setup.cache.setNotFound('tv', 154825, 1, 99, 'episode_missing');

  const writeTtl = (key) => setup.redis.writes.find(([writtenKey]) => writtenKey === key)?.slice(2, 4);
  assert.deepEqual(writeTtl('kisskh:match:v1:tv:154825'), ['EX', 11]);
  assert.deepEqual(writeTtl('kisskh:episodes:v2:4608'), ['EX', 12]);
  assert.deepEqual(writeTtl('kisskh:bundle:current'), ['EX', 16]);
  assert.deepEqual(writeTtl('kisskh:bundle:last-known'), ['EX', 17]);
  assert.deepEqual(writeTtl('kisskh:not-found:v4:tv:154825:1:99'), ['EX', 13]);
  assert.deepEqual(
    setup.redis.writes.find(([key]) => key === 'kisskh:lock:resolve:tv:154825:1:3').slice(2, 5),
    ['PX', 14, 'NX'],
  );
  const capabilityWrite = setup.redis.writes.find(([key]) => key.startsWith('kisskh:fallback:v1:'));
  assert.deepEqual(capabilityWrite.slice(2, 5), ['EX', 15, 'NX']);
  const descriptor = await setup.capabilityStore.consume(result.sources[0].fallbackToken);
  assert.equal(descriptor.expiresAt, 1_015_000);

  setup.nowState.value += 2_999;
  assert.notEqual(await setup.cache.getSensitive('episode', 86439), null);
  setup.nowState.value += 1;
  assert.equal(await setup.cache.getSensitive('episode', 86439), null);
});

test('runtime TTL parsing rejects malformed values and values above security maxima', () => {
  const { parseRuntimeTtls } = require('../../../routes/kisskh');
  const validConfig = { bundleCheckTtlSeconds: 900, bundleStaleMaxSeconds: 86_400 };
  for (const [name, value] of [
    ['KISSKH_MATCH_TTL_SECONDS', '86401'],
    ['KISSKH_EPISODES_TTL_SECONDS', '21601'],
    ['KISSKH_EPISODE_SUB_TTL_SECONDS', '601'],
    ['KISSKH_NOT_FOUND_TTL_SECONDS', '901'],
    ['KISSKH_RESOLVE_LOCK_MS', '30001'],
    ['KISSKH_FALLBACK_TOKEN_TTL_SECONDS', '121'],
    ['KISSKH_MATCH_TTL_SECONDS', '1.5'],
  ]) {
    assert.throws(() => parseRuntimeTtls({ [name]: value }, validConfig), new RegExp(name));
  }
  assert.throws(
    () => parseRuntimeTtls({}, { ...validConfig, bundleCheckTtlSeconds: 901 }),
    /KISSKH_BUNDLE_CHECK_TTL_SECONDS/,
  );
  assert.throws(
    () => parseRuntimeTtls({}, { ...validConfig, bundleStaleMaxSeconds: 86_401 }),
    /KISSKH_BUNDLE_STALE_MAX_SECONDS/,
  );
});

test('local sensitive cache expires at 600 seconds and evicts above 256 entries', async () => {
  const setup = makeResolver({ resolveProvider: async () => providerFixture() });
  for (let id = 1; id <= 257; id += 1) await setup.cache.setSensitive('episode', id, { id });
  assert.equal(await setup.cache.getSensitive('episode', 1), null);
  assert.deepEqual(await setup.cache.getSensitive('episode', 257), { id: 257 });
  setup.nowState.value += 600_000;
  assert.equal(await setup.cache.getSensitive('episode', 257), null);
});

test('episode and subtitle payloads survive a new cache instance through the disk cache', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-cache-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const nowState = { value: 1_000_000 };
  const deps = {
    cacheDir,
    now: () => nowState.value,
    sensitiveTtlSeconds: 600,
  };
  const { createKisskhCache } = require('../kisskhCache');
  const first = createKisskhCache(deps);

  await first.setSensitive('episode', 86439, {
    mediaUrl: 'https://media.example/master.m3u8',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  await first.setSensitive('sub', 86439, {
    subtitles: [{ id: 'kisskh-fr-1', lang: 'fr', sourceUrl: 'https://subs.example/fr.srt' }],
  });

  const files = await fsp.readdir(cacheDir);
  assert.equal(files.filter(file => file.endsWith('.json')).length, 2);

  const second = createKisskhCache(deps);
  assert.equal((await second.getSensitive('episode', 86439)).mediaUrl, 'https://media.example/master.m3u8');
  assert.equal((await second.getSensitive('sub', 86439)).subtitles[0].lang, 'fr');

  nowState.value += 600_000;
  const expired = createKisskhCache(deps);
  assert.equal(await expired.getSensitive('episode', 86439), null);
});

test('a resolved TV request survives a new cache instance through the disk cache', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-resolution-cache-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const { createKisskhCache } = require('../kisskhCache');
  const deps = { cacheDir, now: () => 1_000, sensitiveTtlSeconds: 600 };
  const value = {
    match: {
      tmdbId: 286506, kisskhDramaId: 123, episodeId: 456, season: 1, episode: 3,
      evidence: { score: 100, titleSource: 'localized' },
    },
    mediaUrl: 'https://media.example/master.m3u8',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
    subtitles: [],
  };

  await createKisskhCache(deps).setResolution('tv', 286506, 1, 3, value);
  assert.deepEqual(await createKisskhCache(deps).getResolution('tv', 286506, 1, 3), value);
});

test('catalogue snapshot persists atomically, can be read stale, and rejects invalid replacement', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-catalogue-cache-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const nowState = { value: 1_000 };
  const deps = { cacheDir, now: () => nowState.value };
  const { createKisskhCache } = require('../kisskhCache');
  const first = createKisskhCache(deps);
  const items = [
    { id: 12852, title: 'From - Season 4', episodesCount: 10, thumbnail: 'https://image.example/from.jpg' },
    { id: 12905, title: 'Colony (2026)', episodesCount: 1, label: 'Machine Translate' },
  ];

  await first.setCatalogSnapshot(items);
  assert.deepEqual((await createKisskhCache(deps).getCatalogSnapshot()).items, items);

  await assert.rejects(
    first.setCatalogSnapshot([{ id: 12852, title: 'Duplicate' }, { id: 12852, title: 'Duplicate again' }]),
    (error) => error.code === 'provider_security',
  );
  assert.deepEqual((await createKisskhCache(deps).getCatalogSnapshot()).items, items);

  nowState.value += 43_200_000;
  assert.equal(await createKisskhCache(deps).getCatalogSnapshot(), null);
  assert.deepEqual(
    (await createKisskhCache(deps).getCatalogSnapshot({ allowStale: true })).items,
    items,
  );
});

test('catalogue retrieval progress is shared through Redis and can be cleared', async () => {
  const redis = createRedisDouble();
  const { createKisskhCache } = require('../kisskhCache');
  const writer = createKisskhCache({ redis });
  const reader = createKisskhCache({ redis });
  const progress = { phase: 'catalog', completed: 37, total: 100, percent: 37 };

  await writer.setCatalogProgress(progress);
  assert.deepEqual(await reader.getCatalogProgress(), progress);
  await reader.clearCatalogProgress();
  assert.equal(await writer.getCatalogProgress(), null);
});

test('match cache v2 keeps seasons independently while mirroring v1 for code rollback', async () => {
  const redis = createRedisDouble();
  const cache = require('../kisskhCache').createKisskhCache({ redis });
  const match = (season, dramaId) => ({
    tmdbId: 124364,
    kisskhDramaId: dramaId,
    season,
    episodeOffset: 0,
    evidence: { score: 120, titleSource: 'localized' },
  });

  await cache.setMatch('tv', 124364, 1, match(1, 6419));
  await cache.setMatch('tv', 124364, 4, match(4, 12852));

  assert.equal((await cache.getMatch('tv', 124364, 1)).kisskhDramaId, 6419);
  assert.equal((await cache.getMatch('tv', 124364, 4)).kisskhDramaId, 12852);
  assert.ok(redis.writes.some(([key]) => key === 'kisskh:match:v2:tv:124364:1'));
  assert.ok(redis.writes.some(([key]) => key === 'kisskh:match:v2:tv:124364:4'));
  assert.ok(redis.writes.some(([key]) => key === 'kisskh:match:v1:tv:124364'));
});

test('not-found errors cache only the normalized code for exactly 900 seconds', async () => {
  let calls = 0;
  const setup = makeResolver({
    async resolveProvider() {
      calls += 1;
      const error = new Error('sensitive upstream detail');
      error.code = 'not_found';
      throw error;
    },
  });
  await assert.rejects(setup.resolver.resolveTv({ tmdbId: 154825, season: 0, episode: 1 }),
    (error) => error.code === 'not_found' && !JSON.stringify(error).includes('sensitive'));
  const write = setup.redis.writes.find(([key]) => key === 'kisskh:not-found:v4:tv:154825:0:1');
  assert.deepEqual(write.slice(1, 4), ['not_found', 'EX', 900]);
  await assert.rejects(setup.resolver.resolveTv({ tmdbId: 154825, season: 0, episode: 1 }),
    (error) => error.code === 'not_found');
  assert.equal(calls, 1);
});

test('subtitle wire formats and ciphers are finite and proxy URLs use the configured public proxy contract', async () => {
  const setup = makeResolver({ resolveProvider: async () => providerFixture() });
  const result = await setup.resolver.resolveTv(
    { tmdbId: 154825, season: 1, episode: 3 },
    { proxyMedia: true },
  );
  assert.deepEqual(result.subtitles.map((track) => [track.format, track.cipher.mode, track.cipher.scheme]), [
    ['srt', 'none', undefined],
    ['txt', 'aes-128-cbc', undefined],
    ['txt1', 'unsupported', 'a2'],
    ['txt2', 'aes-128-cbc', undefined],
  ]);
  assert.deepEqual(result.subtitles[3].cipher, {
    mode: 'aes-128-cbc',
    keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
    ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
    payloadEncoding: 'base64-per-cue',
    padding: 'pkcs7',
  });
  assert.equal(result.sources[0].type, 'hls');
  const proxied = [result.sources[0].url, ...result.subtitles.map((track) => track.proxyUrl)];
  for (const urlValue of proxied) {
    const url = new URL(urlValue);
    assert.equal(url.origin, 'https://proxy.example');
    assert.equal(url.pathname, '/kisskh-proxy');
    assert.ok(url.searchParams.get('url'));
  }
  assert.equal(new URL(result.sources[0].url).searchParams.get('url'), providerFixture().mediaUrl);
  assert.deepEqual(result.subtitles.map((track) => new URL(track.proxyUrl).searchParams.get('url')),
    providerFixture().subtitles.map((track) => track.src));
  assert.doesNotMatch(JSON.stringify(result), /kkey/i);
});

test('cached legacy txt2 subtitles are rehydrated from the current approved a3 algorithm', async () => {
  const setup = makeResolver({
    async resolveProvider() { throw new Error('legacy resolution must be served from cache'); },
  });
  const request = { tmdbId: 154825, season: 1, episode: 3 };
  await setup.cache.setResolution('tv', request.tmdbId, request.season, request.episode, {
    match: {
      tmdbId: request.tmdbId,
      kisskhDramaId: 4608,
      episodeId: 86439,
      season: request.season,
      episode: request.episode,
      evidence: { score: 126, titleSource: 'alternative' },
    },
    mediaUrl: 'https://media.example/master.m3u8',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
    subtitles: [{
      id: 'kisskh-en-1',
      lang: 'en',
      label: 'English',
      format: 'txt2',
      sourceUrl: 'https://subs.example/legacy.txt2',
      cipher: { mode: 'unsupported', scheme: 'a3' },
    }],
  });

  const result = await setup.resolver.resolveTv(request);
  assert.deepEqual(result.subtitles[0].cipher, {
    mode: 'aes-128-cbc',
    keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
    ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
    payloadEncoding: 'base64-per-cue',
    padding: 'pkcs7',
  });
});

test('legacy txt2 from the sensitive subtitle cache is rehydrated before the public response', async () => {
  const providerCalls = [];
  const setup = makeResolver({
    resolveProvider: undefined,
    async fetchTmdbDetails() { providerCalls.push('tmdb'); throw new Error('TMDB must not run'); },
    async fetchTmdbAlternativeTitles() { providerCalls.push('alternatives'); throw new Error('TMDB must not run'); },
    kisskhClient: {
      async search() { providerCalls.push('search'); throw new Error('search must not run'); },
      async getDrama() { providerCalls.push('drama'); throw new Error('drama must not run'); },
      async getEpisode() { providerCalls.push('episode'); throw new Error('episode must not run'); },
      async getSubtitles() { providerCalls.push('subtitles'); throw new Error('subtitles must not run'); },
    },
  });
  const request = { tmdbId: 154825, season: 1, episode: 3 };
  await setup.cache.setMatch('tv', request.tmdbId, request.season, {
    tmdbId: request.tmdbId,
    kisskhDramaId: 4608,
    season: request.season,
    episodeOffset: 0,
    evidence: { score: 126, titleSource: 'alternative' },
  });
  await setup.cache.setEpisodes(4608, [{ id: 86439, number: request.episode }]);
  await setup.cache.setSensitive('episode', 86439, {
    mediaUrl: 'https://media.example/master.m3u8',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  await setup.cache.setSensitive('sub', 86439, {
    subtitles: [{
      id: 'kisskh-en-1',
      lang: 'en',
      label: 'English',
      format: 'txt2',
      sourceUrl: 'https://subs.example/sensitive-legacy.txt2',
      cipher: { mode: 'unsupported', scheme: 'a3' },
    }],
  });

  const result = await setup.resolver.resolveTv(request);
  assert.deepEqual(result.subtitles[0].cipher, {
    mode: 'aes-128-cbc',
    keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
    ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
    payloadEncoding: 'base64-per-cue',
    padding: 'pkcs7',
  });
  assert.deepEqual(providerCalls, []);
});

test('cached txt2 AES subtitles do not revalidate the approved bundle', async () => {
  const setup = makeResolver({
    bundleRegistry: {
      async resolveApprovedAlgorithm() { throw new Error('valid txt2 cache must not revalidate the bundle'); },
    },
    async resolveProvider() { throw new Error('valid resolution must be served from cache'); },
  });
  const request = { tmdbId: 154825, season: 1, episode: 3 };
  const cipher = {
    mode: 'aes-128-cbc',
    keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
    ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
    payloadEncoding: 'base64-per-cue',
    padding: 'pkcs7',
  };
  await setup.cache.setResolution('tv', request.tmdbId, request.season, request.episode, {
    match: {
      tmdbId: request.tmdbId,
      kisskhDramaId: 4608,
      episodeId: 86439,
      season: request.season,
      episode: request.episode,
      evidence: { score: 126, titleSource: 'alternative' },
    },
    mediaUrl: 'https://media.example/master.m3u8',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
    subtitles: [{
      id: 'kisskh-en-1',
      lang: 'en',
      label: 'English',
      format: 'txt2',
      sourceUrl: 'https://subs.example/current.txt2',
      cipher,
    }],
  });

  const result = await setup.resolver.resolveTv(request);
  assert.deepEqual(result.subtitles[0].cipher, cipher);
});

test('resolver only emits proxy URLs when proxyMedia is explicitly enabled', async () => {
  const setup = makeResolver({ resolveProvider: async () => providerFixture() });
  const request = { tmdbId: 154825, season: 1, episode: 3 };

  const direct = await setup.resolver.resolveTv(request, { proxyMedia: false });
  assert.equal(direct.sources[0].url, providerFixture().mediaUrl);
  assert.deepEqual(
    direct.subtitles.map((track) => track.proxyUrl),
    providerFixture().subtitles.map((track) => track.src),
  );

  const proxied = await setup.resolver.resolveTv(request, { proxyMedia: true });
  assert.equal(new URL(proxied.sources[0].url).origin, 'https://proxy.example');
  assert.ok(proxied.subtitles.every((track) => new URL(track.proxyUrl).origin === 'https://proxy.example'));
});

test('resolver classifies only explicit MP4 pathnames as mp4 and defaults other media URLs to hls', async () => {
  for (const [mediaUrl, expectedType] of [
    ['https://media.example/video.MP4?signature=sensitive', 'mp4'],
    ['https://media.example/master.m3u8?signature=sensitive', 'hls'],
    ['https://media.example/opaque-stream?signature=sensitive', 'hls'],
  ]) {
    const fixture = providerFixture();
    fixture.mediaUrl = mediaUrl;
    const setup = makeResolver({ resolveProvider: async () => fixture });

    const result = await setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 });

    assert.equal(result.sources[0].type, expectedType, mediaUrl);
  }
});

test('unknown subtitle suffix is rejected before fallback capability creation', async () => {
  const fixture = providerFixture();
  fixture.subtitles = [{ src: 'https://subs.example/en.vtt', label: 'English', land: 'en' }];
  const setup = makeResolver({ resolveProvider: async () => fixture });
  await assert.rejects(setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 }),
    (error) => error.code === 'provider_security');
  assert.equal(setup.redis.writes.some(([key]) => key.startsWith('kisskh:fallback:v1:')), false);
});

test('resolver accepts bounded HTTP media and subtitle URLs without host allowlists or DNS', async () => {
  const fixture = providerFixture();
  fixture.mediaUrl = 'http://127.0.0.1:8080/video.mp4?signature=sensitive';
  fixture.subtitles = [{ src: 'http://unlisted.example/en.srt', label: 'English', land: 'en' }];
  let dnsCalls = 0;
  const setup = makeResolver({
    mediaAllowedHosts: ['different.example'],
    subtitleAllowedHosts: ['different.example'],
    async resolveDns() { dnsCalls += 1; throw new Error('DNS must not be used'); },
    resolveProvider: async () => fixture,
  });

  const result = await setup.resolver.resolveTv(
    { tmdbId: 154825, season: 1, episode: 3 },
    { proxyMedia: true },
  );
  assert.equal(dnsCalls, 0);
  assert.equal(new URL(result.sources[0].url).searchParams.get('url'), fixture.mediaUrl);
  assert.equal(new URL(result.subtitles[0].proxyUrl).searchParams.get('url'), fixture.subtitles[0].src);
  const descriptor = await setup.capabilityStore.consume(result.sources[0].fallbackToken);
  assert.equal(descriptor.url, fixture.mediaUrl);
});

test('default orchestration reuses TMDB, matcher, client and approved algorithm interfaces', async () => {
  const tmdbCalls = [];
  const clientCalls = [];
  const setup = makeResolver({
    resolveProvider: undefined,
    async fetchTmdbDetails(_url, _key, id, type, language) {
      tmdbCalls.push(['details', id, type, language]);
      return {
        id,
        name: language === 'fr-FR' ? 'Proposition commerciale' : 'A Business Proposal',
        original_name: 'Sanae Matseon',
        first_air_date: '2022-02-28',
        origin_country: ['KR'],
        number_of_seasons: 1,
      };
    },
    async fetchTmdbAlternativeTitles(_url, _key, id) {
      tmdbCalls.push(['alternatives', id]);
      return { id, results: [{ title: 'A Business Proposal' }] };
    },
    kisskhClient: {
      async search(query) {
        clientCalls.push(['search', query]);
        return [{ id: 4608, title: 'A Business Proposal', releaseDate: '2022', country: 'Korea', episodesCount: 12 }];
      },
      async getDrama(id) {
        clientCalls.push(['drama', id]);
        return {
          id,
          title: 'A Business Proposal',
          episodes: [{ id: 86874, number: 6.1 }, { id: 86439, number: 3 }],
        };
      },
      async getEpisode(id) {
        clientCalls.push(['episode', id]);
        return { Video: 'https://media.example/video.mp4?signature=sensitive' };
      },
      async getSubtitles(id) {
        clientCalls.push(['sub', id]);
        return [{ src: 'https://subs.example/en.srt', label: 'English', land: 'en' }];
      },
    },
    tmdbApiUrl: 'https://api.themoviedb.org/3',
    tmdbApiKey: 'injected-test-key',
  });

  const result = await setup.resolver.resolveTv({ tmdbId: 154825, season: 1, episode: 3 });
  assert.equal(result.match.kisskhDramaId, 4608);
  assert.deepEqual(tmdbCalls, [
    ['details', 154825, 'tv', 'fr-FR'],
    ['details', 154825, 'tv', 'en-US'],
    ['alternatives', 154825],
  ]);
  assert.ok(clientCalls.filter(([kind]) => kind === 'search').length > 0);
  assert.deepEqual(clientCalls.slice(-3), [['drama', 4608], ['episode', 86439], ['sub', 86439]]);
});

test('resolving episode 1 never collapses the cached drama list before episode 2', async () => {
  let dramaCalls = 0;
  const episodeCalls = [];
  const setup = makeResolver({
    resolveProvider: undefined,
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'True Beauty',
        original_name: 'True Beauty',
        first_air_date: '2020-12-09',
        origin_country: ['KR'],
        number_of_seasons: 1,
      };
    },
    async fetchTmdbAlternativeTitles(_url, _key, id) { return { id, results: [] }; },
    kisskhClient: {
      async search() { return [{ id: 975, title: 'True Beauty', releaseDate: '2020', episodesCount: 2 }]; },
      async getDrama() {
        dramaCalls += 1;
        return {
          id: 975,
          title: 'True Beauty',
          episodes: [{ id: 29936, number: 2 }, { id: 29922, number: 1 }],
        };
      },
      async getEpisode(id) {
        episodeCalls.push(id);
        return { Video: `https://media.example/Ep${id}.m3u8` };
      },
      async getSubtitles() { return []; },
    },
    tmdbApiUrl: 'https://api.themoviedb.org/3',
    tmdbApiKey: 'injected-test-key',
    logger: { info() {}, warn() {} },
  });

  const episode1 = await setup.resolver.resolveTv({ tmdbId: 112888, season: 1, episode: 1 });
  const episode2 = await setup.resolver.resolveTv({ tmdbId: 112888, season: 1, episode: 2 });

  assert.equal(episode1.match.episodeId, 29922);
  assert.equal(episode2.match.episodeId, 29936);
  assert.equal(dramaCalls, 1);
  assert.deepEqual(episodeCalls, [29922, 29936]);
});

test('the tmdb-only match key never reuses a season-one drama for a distinct later-season match', async () => {
  const dramaCalls = [];
  const setup = makeResolver({
    resolveProvider: undefined,
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id, name: 'Split Drama', original_name: 'Split Drama', first_air_date: '2024-01-01',
        origin_country: ['KR'], number_of_seasons: 2,
      };
    },
    async fetchTmdbAlternativeTitles(_url, _key, id) { return { id, results: [] }; },
    kisskhClient: {
      async search() {
        return [
          { id: 1, title: 'Split Drama', releaseDate: '2024', country: 'Korea', episodesCount: 1 },
          { id: 2, title: 'Split Drama Season 2', releaseDate: '2024', country: 'Korea', episodesCount: 1 },
        ];
      },
      async getDrama(id) {
        dramaCalls.push(id);
        return { id, title: id === 1 ? 'Split Drama' : 'Split Drama Season 2', episodes: [{ id: id * 100 + 1, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
    tmdbApiUrl: 'https://api.themoviedb.org/3',
    tmdbApiKey: 'injected-test-key',
  });

  const seasonOne = await setup.resolver.resolveTv({ tmdbId: 99, season: 1, episode: 1 });
  const seasonTwo = await setup.resolver.resolveTv({ tmdbId: 99, season: 2, episode: 1 });
  assert.equal(seasonOne.match.kisskhDramaId, 1);
  assert.equal(seasonTwo.match.kisskhDramaId, 2);
  assert.deepEqual(dramaCalls, [1, 2]);
});

test('TV and movie catalogue caches isolate identical TMDB coordinates on disk and Redis', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-media-cache-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const redis = createRedisDouble();
  const { createKisskhCache } = require('../kisskhCache');
  const cache = createKisskhCache({ redis, cacheDir });
  const tv = { kind: 'tv' };
  const movie = { kind: 'movie' };

  await cache.setResolution('tv', 9910, 0, 1, tv);
  await cache.setResolution('movie', 9910, 0, 1, movie);
  await cache.setNotFound('tv', 9910, 0, 2, 'episode_missing');
  await cache.setNotFound('movie', 9910, 0, 2, 'not_found');

  const fresh = createKisskhCache({ redis, cacheDir });
  assert.deepEqual(await fresh.getResolution('tv', 9910, 0, 1), tv);
  assert.deepEqual(await fresh.getResolution('movie', 9910, 0, 1), movie);
  assert.deepEqual((await fsp.readdir(cacheDir)).sort(), [
    'movie-9910-0-1.json',
    'tv-9910-0-1.json',
  ]);
  assert.ok(redis.values.has('kisskh:not-found:v4:tv:9910:0:2'));
  assert.ok(redis.values.has('kisskh:not-found:v4:movie:9910:0:2'));
});

function discoveryFixture(overrides = {}) {
  return {
    resolveProvider: undefined,
    async fetchTmdbDetails(_url, _key, id, mediaType, language) {
      return {
        id,
        name: 'Fallback Drama',
        original_name: 'Fallback Drama',
        first_air_date: '2024-01-01',
        origin_country: ['KR'],
        number_of_seasons: 1,
        seasons: [{ season_number: 1, episode_count: 1 }],
        mediaType,
        language,
      };
    },
    async fetchTmdbAlternativeTitles(_url, _key, id) { return { id, results: [] }; },
    tmdbApiUrl: 'https://api.themoviedb.org/3',
    tmdbApiKey: 'injected-test-key',
    logger: { info() {}, warn() {} },
    ...overrides,
  };
}

test('discovery falls through incompatible categories and confirms the first compatible type', async () => {
  const searchTypes = [];
  const setup = makeResolver(discoveryFixture({
    kisskhClient: {
      async search(_query, type) {
        searchTypes.push(type);
        if (type < 2) return [{ id: type + 10, title: 'Wrong Drama', episodesCount: 1 }];
        return [{ id: 22, title: 'Fallback Drama', episodesCount: 1 }];
      },
      async getDrama(id) {
        assert.equal(id, 22);
        return { id, title: 'Fallback Drama', episodes: [{ id: 2201, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 901, season: 1, episode: 1 });
  assert.equal(result.match.kisskhDramaId, 22);
  assert.deepEqual([...new Set(searchTypes)], [0, 1, 2]);
});

test('season four discovery finds From through the bare title in Hollywood category', async () => {
  const searches = [];
  const setup = makeResolver(discoveryFixture({
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'From',
        original_name: 'FROM',
        first_air_date: '2022-02-20',
        origin_country: ['US'],
        number_of_seasons: 4,
        seasons: [{ season_number: 4, episode_count: 10 }],
      };
    },
    kisskhClient: {
      async search(query, type) {
        searches.push([query, type]);
        return query === 'From' && type === 4
          ? [{ id: 12852, title: 'From - Season 4', episodesCount: 10 }]
          : [];
      },
      async getDrama(id) {
        assert.equal(id, 12852);
        return { id, title: 'From - Season 4', episodes: [{ id: 1285201, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 124364, season: 4, episode: 1 });

  assert.equal(result.match.kisskhDramaId, 12852);
  assert.ok(searches.some(([query, type]) => query === 'From' && type === 4));
});

test('discovery overlaps independent TMDB, search, episode and subtitle requests', async () => {
  const active = { tmdb: 0, search: 0, media: 0 };
  const maximum = { tmdb: 0, search: 0, media: 0 };
  async function overlap(kind, value) {
    active[kind] += 1;
    maximum[kind] = Math.max(maximum[kind], active[kind]);
    await new Promise((resolve) => setImmediate(resolve));
    active[kind] -= 1;
    return value;
  }
  const details = {
    id: 903,
    name: 'Parallel Drama',
    original_name: 'Parallel Drama',
    first_air_date: '2025-01-01',
    origin_country: ['KR'],
    number_of_seasons: 1,
    seasons: [{ season_number: 1, episode_count: 1 }],
  };
  const setup = makeResolver(discoveryFixture({
    async fetchTmdbDetails() { return overlap('tmdb', details); },
    async fetchTmdbAlternativeTitles() {
      return overlap('tmdb', { id: 903, results: [{ title: 'Parallel Drama' }] });
    },
    kisskhClient: {
      async search() {
        return overlap('search', [{ id: 9030, title: 'Parallel Drama', episodesCount: 1 }]);
      },
      async getDrama(id) {
        return { id, title: 'Parallel Drama', episodes: [{ id: 90301, number: 1 }] };
      },
      async getEpisode() {
        return overlap('media', { Video: 'https://media.example/parallel.m3u8' });
      },
      async getSubtitles() { return overlap('media', []); },
    },
  }));

  await setup.resolver.resolveTv({ tmdbId: 903, season: 1, episode: 1 });

  assert.equal(maximum.tmdb, 3);
  assert.ok(maximum.search > 1);
  assert.equal(maximum.media, 2);
});

test('discovery stops category fallback immediately on provider transport failure', async () => {
  const searchTypes = [];
  const setup = makeResolver(discoveryFixture({
    kisskhClient: {
      async search(_query, type) {
        searchTypes.push(type);
        throw new (require('../errors').KisskhError)('provider_unavailable', 'transport');
      },
      async getDrama() { throw new Error('must not fetch drama'); },
      async getEpisode() { throw new Error('must not fetch episode'); },
      async getSubtitles() { throw new Error('must not fetch subtitles'); },
    },
  }));

  await assert.rejects(
    setup.resolver.resolveTv({ tmdbId: 902, season: 1, episode: 1 }),
    (error) => error.code === 'provider_unavailable',
  );
  assert.ok(searchTypes.length > 0);
  assert.ok(searchTypes.every((type) => type === 0));
});

test('segment discovery fetches the selected drama local episode while preserving the public episode', async () => {
  const episodeCalls = [];
  const subtitleCalls = [];
  const setup = makeResolver(discoveryFixture({
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Swallowed Star',
        original_name: 'Swallowed Star',
        first_air_date: '2020-08-01',
        origin_country: ['CN'],
        number_of_seasons: 1,
        seasons: [{ season_number: 1, episode_count: 210 }],
      };
    },
    kisskhClient: {
      async search(_query, type) {
        assert.equal(type, 0);
        return [
          { id: 1272, title: 'Swallowed Star', episodesCount: 26 },
          { id: 4529, title: 'Swallowed Star Season 2+3+4', episodesCount: 208 },
        ];
      },
      async getDrama(id) {
        if (id === 1272) {
          return {
            id,
            title: 'Swallowed Star',
            episodes: Array.from({ length: 26 }, (_unused, index) => ({ id: 127_200 + index, number: index + 1 })),
          };
        }
        assert.equal(id, 4529);
        return { id, title: 'Swallowed Star Season 2+3+4', episodes: [{ id: 452901, number: 1 }] };
      },
      async getEpisode(id) { episodeCalls.push(id); return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles(id) { subtitleCalls.push(id); return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 75214, season: 1, episode: 27 });
  assert.equal(result.match.kisskhDramaId, 4529);
  assert.equal(result.match.episodeId, 452901);
  assert.equal(result.match.episode, 27);
  assert.deepEqual(episodeCalls, [452901]);
  assert.deepEqual(subtitleCalls, [452901]);
});

test('movie discovery uses the TMDB movie namespace and resolves public episode one', async () => {
  const tmdbCalls = [];
  const searchTypes = [];
  const setup = makeResolver({
    resolveProvider: undefined,
    async fetchTmdbDetails(_url, _key, id, mediaType, language) {
      tmdbCalls.push(['details', id, mediaType, language]);
      return {
        id,
        title: 'Movie Match',
        original_title: 'Movie Match',
        release_date: '2025-03-02',
        production_countries: [{ iso_3166_1: 'KR', name: 'South Korea' }],
      };
    },
    async fetchTmdbAlternativeTitles(_url, _key, id, mediaType) {
      tmdbCalls.push(['alternatives', id, mediaType]);
      return { id, titles: [{ title: 'Movie Match', iso_3166_1: 'US' }] };
    },
    kisskhClient: {
      async search(_query, type) {
        searchTypes.push(type);
        return [{ id: 991001, title: 'Movie Match', episodesCount: 1 }];
      },
      async getDrama(id) { return { id, title: 'Movie Match', episodes: [{ id: 991011, number: 1 }] }; },
      async getEpisode(id) { assert.equal(id, 991011); return { Video: 'https://media.example/movie.mp4' }; },
      async getSubtitles(id) { assert.equal(id, 991011); return []; },
    },
    tmdbApiUrl: 'https://api.themoviedb.org/3',
    tmdbApiKey: 'injected-test-key',
  });

  const result = await setup.resolver.resolveMovie({ tmdbId: 9910, season: 0, episode: 1 });
  assert.deepEqual(result.match, {
    tmdbId: 9910,
    kisskhDramaId: 991001,
    episodeId: 991011,
    season: 0,
    episode: 1,
  });
  assert.deepEqual(tmdbCalls, [
    ['details', 9910, 'movie', 'fr-FR'],
    ['details', 9910, 'movie', 'en-US'],
    ['alternatives', 9910, 'movie'],
  ]);
  assert.ok(searchTypes.length > 0);
  assert.ok(searchTypes.every((type) => type === 0));
});

test('explicit catalogue warm-up builds the complete disk snapshot independently of an episode match', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-explicit-catalogue-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const listCalls = [];
  const setup = makeResolver({
    cacheDir,
    logger: { info() {}, warn() {} },
    kisskhClient: {
      async list(page, pageSize, type) {
        listCalls.push([page, pageSize, type]);
        return page === 1
          ? { page, pageSize, totalCount: 101, data: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            title: `Catalogue ${index + 1}`,
          })) }
          : { page, pageSize, totalCount: 101, data: [{ id: 101, title: 'Catalogue 101' }] };
      },
    },
  });

  await setup.resolver.warmCatalog();

  assert.deepEqual(listCalls, [[1, 100, 0], [2, 100, 0]]);
  assert.equal((await setup.cache.getCatalogSnapshot()).items.length, 101);
  assert.equal(await setup.resolver.getRetrievalProgress(), null);
});

test('enhanced discovery builds every catalogue page and treats decimal episodes as bonuses', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-enhanced-catalogue-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const listCalls = [];
  const progressEvents = [];
  let searchCalls = 0;
  const noises = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    title: `Unrelated title ${index + 1}`,
    episodesCount: 1,
  }));
  const client = {
    async list(page, pageSize, type) {
      listCalls.push([page, pageSize, type]);
      return page === 1
        ? { page, pageSize, totalCount: 101, data: noises }
        : { page, pageSize, totalCount: 101, data: [{ id: 975, title: 'Squid Game Season 2', episodesCount: 8 }] };
    },
    async search() { searchCalls += 1; return []; },
    async getDrama(id) {
      assert.equal(id, 975);
      return {
        id,
        title: 'Squid Game Season 2',
        releaseDate: '2024-12-26',
        country: 'South Korea',
        type: 'TVSeries',
        episodesCount: 8,
        episodes: [1, 2, 3, 4, 5, 6, 7, 7.5].map((number, index) => ({ id: 97_500 + index, number })),
      };
    },
    async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
    async getSubtitles() { return []; },
  };
  const setup = makeResolver(discoveryFixture({
    cacheDir,
    logger: {
      info(message, value) {
        if (message === '[KISSKH] catalogue retrieval progress') progressEvents.push(value);
      },
      warn() {},
    },
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Squid Game',
        original_name: 'Squid Game',
        first_air_date: '2021-09-17',
        origin_country: ['KR'],
        number_of_seasons: 3,
        seasons: [{ season_number: 2, episode_count: 7 }],
      };
    },
    kisskhClient: client,
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 93405, season: 2, episode: 7 });
  assert.equal(result.match.kisskhDramaId, 975);
  assert.equal(result.match.episodeId, 97_506);
  assert.deepEqual(listCalls, [[1, 100, 0], [2, 100, 0]]);
  assert.deepEqual(progressEvents, [
    { phase: 'catalog', completed: 1, total: 2, percent: 50 },
    { phase: 'catalog', completed: 2, total: 2, percent: 100 },
    { phase: 'finalizing', completed: 2, total: 2, percent: 100 },
  ]);
  assert.equal(await setup.resolver.getRetrievalProgress(), null);
  assert.equal(searchCalls, 0);
  assert.equal((await setup.cache.getEpisodes(975)).length, 7);

  const diskSetup = makeResolver(discoveryFixture({
    cacheDir,
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Squid Game',
        original_name: 'Squid Game',
        first_air_date: '2021-09-17',
        origin_country: ['KR'],
        number_of_seasons: 3,
        seasons: [{ season_number: 2, episode_count: 7 }],
      };
    },
    kisskhClient: {
      ...client,
      async list() { throw new Error('fresh disk catalogue must avoid List'); },
    },
  }));
  const second = await diskSetup.resolver.resolveTv({ tmdbId: 93405, season: 2, episode: 6 });
  assert.equal(second.match.episodeId, 97_505);
  assert.equal(searchCalls, 0);
});

test('enhanced discovery enriches ambiguous titles with Drama year and country', async () => {
  const dramaCalls = [];
  const setup = makeResolver(discoveryFixture({
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Signal',
        original_name: 'Signal',
        first_air_date: '2016-01-22',
        origin_country: ['KR'],
        number_of_seasons: 1,
        seasons: [{ season_number: 1, episode_count: 16 }],
      };
    },
    kisskhClient: {
      async list() {
        return {
          page: 1,
          pageSize: 100,
          totalCount: 2,
          data: [
            { id: 11, title: 'Signal', episodesCount: 16 },
            { id: 22, title: 'Signal', episodesCount: 16 },
          ],
        };
      },
      async search() { throw new Error('catalogue candidates must avoid Search'); },
      async getDrama(id) {
        dramaCalls.push(id);
        return id === 11
          ? { id, title: 'Signal', releaseDate: '2016-01-22', country: 'South Korea', type: 'TVSeries', episodes: [{ id: 111, number: 1 }] }
          : { id, title: 'Signal', releaseDate: '2018-01-01', country: 'China', type: 'TVSeries', episodes: [{ id: 221, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 5019, season: 1, episode: 1 });
  assert.equal(result.match.kisskhDramaId, 11);
  assert.deepEqual(dramaCalls.sort((left, right) => left - right), [11, 22]);
});

test('legacy discovery remains selectable without reading or refreshing the catalogue', async () => {
  let listCalls = 0;
  let searchCalls = 0;
  const setup = makeResolver(discoveryFixture({
    useEnhancedCatalogMatching: false,
    kisskhClient: {
      async list() { listCalls += 1; throw new Error('legacy must not list'); },
      async search() { searchCalls += 1; return [{ id: 22, title: 'Fallback Drama', episodesCount: 1 }]; },
      async getDrama(id) { return { id, title: 'Fallback Drama', episodes: [{ id: 2201, number: 1 }] }; },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 901, season: 1, episode: 1 });
  assert.equal(result.match.kisskhDramaId, 22);
  assert.equal(listCalls, 0);
  assert.ok(searchCalls > 0);
});

test('failed catalogue refresh keeps using the complete stale disk snapshot', async (t) => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-kisskh-stale-catalogue-'));
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const nowState = { value: 1_000 };
  const setup = makeResolver(discoveryFixture({
    cacheDir,
    nowState,
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Moving',
        original_name: 'Moving',
        first_air_date: '2023-08-09',
        origin_country: ['KR'],
        number_of_seasons: 1,
        seasons: [{ season_number: 1, episode_count: 20 }],
      };
    },
    kisskhClient: {
      async list() {
        const { KisskhError } = require('../errors');
        throw new KisskhError('provider_unavailable', 'refresh failed');
      },
      async search() { throw new Error('stale catalogue must avoid Search'); },
      async getDrama(id) {
        return { id, title: 'Moving', releaseDate: '2023-08-09', country: 'South Korea', type: 'TVSeries', episodes: [{ id: 779301, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));
  await setup.cache.setCatalogSnapshot([{ id: 7793, title: 'Moving', episodesCount: 20 }]);
  nowState.value += 43_200_000;

  const result = await setup.resolver.resolveTv({ tmdbId: 126485, season: 1, episode: 1 });
  assert.equal(result.match.kisskhDramaId, 7793);
  assert.equal((await setup.cache.getCatalogSnapshot({ allowStale: true })).items[0].id, 7793);
});

test('enhanced network fallback regularizes decimal bonuses before choosing an absolute segment', async () => {
  const detailCalls = [];
  const setup = makeResolver(discoveryFixture({
    async fetchTmdbDetails(_url, _key, id) {
      return {
        id,
        name: 'Bonus Show',
        original_name: 'Bonus Show',
        first_air_date: '2024-01-01',
        origin_country: ['KR'],
        number_of_seasons: 1,
        seasons: [{ season_number: 1, episode_count: 8 }],
      };
    },
    kisskhClient: {
      async list() {
        const { KisskhError } = require('../errors');
        throw new KisskhError('provider_unavailable', 'catalogue unavailable');
      },
      async search(_query, type) {
        return type === 0 ? [
          { id: 31, title: 'Bonus Show', episodesCount: 8 },
          { id: 32, title: 'Bonus Show Season 2', episodesCount: 10 },
        ] : [];
      },
      async getDrama(id) {
        detailCalls.push(id);
        return id === 31
          ? { id, title: 'Bonus Show', episodes: [1, 2, 3, 4, 5, 6, 7, 7.5].map((number, index) => ({ id: 31_000 + index, number })) }
          : { id, title: 'Bonus Show Season 2', episodes: [{ id: 32_001, number: 1 }] };
      },
      async getEpisode(id) { return { Video: `https://media.example/${id}.mp4` }; },
      async getSubtitles() { return []; },
    },
  }));

  const result = await setup.resolver.resolveTv({ tmdbId: 8080, season: 1, episode: 8 });
  assert.equal(result.match.kisskhDramaId, 32);
  assert.equal(result.match.episodeId, 32_001);
  assert.ok(detailCalls.includes(31));
  assert.ok(detailCalls.includes(32));
});
