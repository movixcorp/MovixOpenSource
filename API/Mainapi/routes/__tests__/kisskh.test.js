const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { KisskhError } = require('../../services/kisskh/errors');

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/kisskh', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function resolution(token = 'A'.repeat(43)) {
  return {
    match: { tmdbId: 154825, kisskhDramaId: 4608, episodeId: 86439, season: 0, episode: 1 },
    sources: [{
      id: 'kisskh-primary', label: 'KissKH', type: 'hls',
      url: 'https://proxy.example/kisskh-proxy?url=https%3A%2F%2Fmedia.example%2Fmaster.m3u8', fallbackToken: token,
    }],
    subtitles: [{
      id: 'kisskh-en', lang: 'en', label: 'English', format: 'srt',
      sourceUrl: 'http://unlisted.example/en.srt',
      proxyUrl: 'https://proxy.example/kisskh-proxy?url=http%3A%2F%2Funlisted.example%2Fen.srt',
      cipher: { mode: 'none' },
    }],
  };
}

test('parseTvRequest accepts canonical integers including season zero and rejects coercible forms', () => {
  const { parseTvRequest } = require('../kisskh');
  assert.deepEqual(parseTvRequest({ tmdbId: '154825' }, { season: '0', episode: '1' }), {
    tmdbId: 154825, season: 0, episode: 1,
  });
  for (const [tmdbId, season, episode] of [
    ['', '0', '1'], ['-1', '0', '1'], ['1.5', '0', '1'], ['1e3', '0', '1'], [' 1', '0', '1'],
    ['1', '', '1'], ['1', '-1', '1'], ['1', '1.0', '1'], ['1', '1e2', '1'], ['1', ['0'], '1'],
    ['1', '0', ''], ['1', '0', '-1'], ['1', '0', '1.5'], ['1', '0', '1e2'], ['1', '0', ['1']],
  ]) {
    assert.throws(() => parseTvRequest({ tmdbId }, { season, episode }),
      (error) => error.code === 'invalid_input');
  }
});

test('parseMovieRequest accepts only a canonical TMDB ID and fixes movie coordinates', () => {
  const { parseMovieRequest } = require('../kisskh');
  assert.deepEqual(parseMovieRequest({ tmdbId: '9910' }), { tmdbId: 9910, season: 0, episode: 1 });
  for (const tmdbId of ['', '-1', '1.5', '1e3', ' 1']) {
    assert.throws(() => parseMovieRequest({ tmdbId }), (error) => error.code === 'invalid_input');
  }
});

test('runtime reuses the shared public proxy origin when the KissKH-specific URL is absent', () => {
  const { createRuntimeDependencies } = require('../kisskh');
  const runtime = createRuntimeDependencies({
    env: {
      KISSKH_ENABLED: 'false',
      PROXY_SERVER_URL: 'https://proxiesembed.example/proxy',
    },
  });

  assert.equal(runtime.publicProxyUrl, 'https://proxiesembed.example');
});

test('runtime dependency wiring applies a non-default fallback TTL from environment to Redis EX', async () => {
  const { createRuntimeDependencies } = require('../kisskh');
  const writes = [];
  const runtime = createRuntimeDependencies({
    env: {
      KISSKH_ENABLED: 'true',
      KISSKH_BASE_URL: 'https://kisskh.nl',
      KISSKH_ALLOWED_HOSTS: 'kisskh.nl',
      KISSKH_MEDIA_ALLOWED_HOSTS: 'auto.cdnvideo11.shop',
      KISSKH_SUBTITLE_ALLOWED_HOSTS: 'sub.cdnvideo11.shop',
      KISSKH_FALLBACK_TOKEN_TTL_SECONDS: '7',
      PROXIESEMBED_PUBLIC_URL: 'https://proxy.example',
    },
    redis: {
      async set(...args) {
        writes.push(args);
        return 'OK';
      },
    },
    pickProxy: () => null,
    kisskhRequest: async () => { throw new Error('unexpected metadata request'); },
  });

  await runtime.capabilityStore.create({
    url: 'https://auto.cdnvideo11.shop/video.mp4',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  const capabilityWrite = writes.find(([key]) => key.startsWith('kisskh:fallback:v1:'));
  assert.deepEqual(capabilityWrite.slice(2, 5), ['EX', 7, 'NX']);
});

test('GET returns the exact safe contract with no-store and rejects non-public proxy descendants', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    resolver: { async resolveTv() { return resolution(); } },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  });
  const server = await serve(router);
  t.after(server.close);
  const response = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), resolution());

  const badRouter = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    resolver: { async resolveTv() {
      const value = resolution();
      value.sources[0].url = 'https://evil.example/kisskh-proxy?url=https%3A%2F%2Fmedia.example%2Fsigned';
      value.sources[0].mediaUrl = 'https://media.example/signed';
      return value;
    } },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  });
  const badServer = await serve(badRouter);
  t.after(badServer.close);
  const bad = await fetch(`${badServer.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(bad.status, 502);
  assert.doesNotMatch(await bad.text(), /evil|media\.example|signed/i);
});

test('GET returns 202 immediately on a cold disk cache and warms it in background', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  let cached = null;
  let finishWarm;
  const warmFinished = new Promise((resolve) => { finishWarm = resolve; });
  let warmCalls = 0;
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver: {
      async getCachedTv() { return cached; },
      async getRetrievalProgress() {
        return { phase: 'catalog', completed: 37, total: 100, percent: 37 };
      },
      async warmTv() {
        warmCalls += 1;
        await warmFinished;
        cached = resolution();
      },
      async resolveTv() { throw new Error('the cold route must not await resolution'); },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
    logger: { error() {} },
  });
  const server = await serve(router);
  t.after(server.close);
  const pending = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get('retry-after'), '1');
  assert.deepEqual(await pending.json(), {
    code: 'retrieval_in_progress',
    message: 'Récupération KissKH en cours',
    progress: { phase: 'catalog', completed: 37, total: 100, percent: 37 },
    logs: [{
      resolutionId: 'tv:154825:0:1',
      mediaType: 'tv',
      tmdbId: 154825,
      season: 0,
      episode: 1,
      phase: 'background_started',
      elapsedMs: 0,
    }],
  });
  assert.equal(warmCalls, 1);

  const stillPending = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(stillPending.status, 202);
  await stillPending.json();
  assert.equal(warmCalls, 1, 'polling must reuse the active background retrieval');

  finishWarm();
  await warmFinished;
  await new Promise((resolve) => setImmediate(resolve));
  const ready = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), resolution());
});

test('a genuine background failure is returned with diagnostics instead of console logs', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const { KisskhError } = require('../../services/kisskh/errors');
  const errorLogs = [];
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver: {
      async getCachedTv() { return null; },
      async warmTv() {
        throw new KisskhError('provider_unavailable', 'Proxy KissKH indisponible');
      },
      async resolveTv() { throw new Error('cold route must not resolve synchronously'); },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
    logger: { error(...args) { errorLogs.push(args); } },
  });
  const server = await serve(router);
  t.after(server.close);

  const response = await fetch(`${server.url}/api/kisskh/tv/112888?season=1&episode=2`);
  assert.equal(response.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errorLogs, []);

  const failed = await fetch(`${server.url}/api/kisskh/tv/112888?season=1&episode=2`);
  assert.equal(failed.status, 502);
  const body = await failed.json();
  assert.equal(body.code, 'provider_unavailable');
  assert.equal(body.message, 'Proxy KissKH indisponible');
  assert.deepEqual(body.logs.map(({ phase }) => phase), ['background_started', 'failed']);
  assert.equal(body.logs.at(-1).reason, 'Proxy KissKH indisponible');
  assert.equal(Number.isSafeInteger(body.logs.at(-1).elapsedMs), true);
});

test('a follower stops after one distributed lock contention instead of joining a retry queue', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  let warmCalls = 0;
  let clock = 1_000;
  const infoLogs = [];
  const errorLogs = [];
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    now: () => clock,
    waitForRetrievalRetry: async () => {
      clock += 1_000;
      await new Promise((resolve) => setImmediate(resolve));
    },
    resolver: {
      async getCachedTv() { return null; },
      async warmTv() {
        warmCalls += 1;
        clock += 25;
        throw new KisskhError('provider_unavailable', 'Resolution KissKH deja en cours', {
          details: { reason: 'lock_contended' },
        });
      },
      async getRetrievalProgress() {
        await new Promise((resolve) => setImmediate(resolve));
        return null;
      },
      async resolveTv() { throw new Error('cold route must not resolve synchronously'); },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
    logger: {
      info(...args) { infoLogs.push(args); },
      error(...args) { errorLogs.push(args); },
    },
  });
  const server = await serve(router);
  t.after(server.close);

  const pending = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(pending.status, 202);
  const body = await pending.json();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(warmCalls, 1);
  assert.deepEqual(body.logs.map(({ phase }) => phase), [
    'background_started',
    'delegated_to_active_worker',
  ]);
  assert.ok(body.logs.every(({ resolutionId }) => resolutionId === 'tv:154825:0:1'));
  assert.ok(body.logs.every(({ elapsedMs }) => Number.isSafeInteger(elapsedMs)));
  assert.deepEqual(infoLogs, []);
  assert.deepEqual(errorLogs, []);
});

test('a ready KissKH request starts the full catalogue warm-up without delaying its response', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  let warmCatalogCalls = 0;
  let warmTvCalls = 0;
  let releaseCatalog;
  const catalogBlocked = new Promise((resolve) => { releaseCatalog = resolve; });
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver: {
      async warmCatalog() {
        warmCatalogCalls += 1;
        await catalogBlocked;
      },
      async getCachedTv() { return resolution(); },
      async warmTv() { warmTvCalls += 1; },
      async resolveTv() { throw new Error('ready response must use its cache'); },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
    logger: { error() {} },
  });
  const server = await serve(router);
  t.after(server.close);
  t.after(() => releaseCatalog());

  const response = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmCatalogCalls, 1);
  assert.equal(warmTvCalls, 1);
});

test('movie and TV routes warm and serve isolated entries for the same numeric TMDB ID', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const cached = new Map();
  const warmCalls = [];
  const movie = resolution();
  movie.match.tmdbId = 9910;
  movie.match.kisskhDramaId = 991001;
  movie.match.episodeId = 991011;
  const tv = resolution();
  tv.match.tmdbId = 9910;
  tv.match.kisskhDramaId = 991002;
  tv.match.episodeId = 991021;
  const resolver = {
    async getCachedMovie() { return cached.get('movie') || null; },
    async warmMovie(request) {
      if (cached.has('movie')) return;
      warmCalls.push(['movie', request]);
      cached.set('movie', movie);
    },
    async resolveMovie() { throw new Error('cold movie route must not await resolution'); },
    async getCachedTv() { return cached.get('tv') || null; },
    async warmTv(request) {
      if (cached.has('tv')) return;
      warmCalls.push(['tv', request]);
      cached.set('tv', tv);
    },
    async resolveTv() { throw new Error('cold TV route must not await resolution'); },
  };
  const server = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver,
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
    logger: { error() {} },
  }));
  t.after(server.close);

  const moviePending = await fetch(`${server.url}/api/kisskh/movie/9910`);
  assert.equal(moviePending.status, 202);
  assert.deepEqual(await moviePending.json(), {
    code: 'retrieval_in_progress',
    message: 'Récupération KissKH en cours',
    progress: { phase: 'starting', completed: 0, total: null, percent: null },
    logs: [{
      resolutionId: 'movie:9910:0:1',
      mediaType: 'movie',
      tmdbId: 9910,
      season: 0,
      episode: 1,
      phase: 'background_started',
      elapsedMs: 0,
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const movieReady = await fetch(`${server.url}/api/kisskh/movie/9910`);
  assert.equal(movieReady.status, 200);
  assert.deepEqual((await movieReady.json()).match, movie.match);

  const tvPending = await fetch(`${server.url}/api/kisskh/tv/9910?season=0&episode=1`);
  assert.equal(tvPending.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  const tvReady = await fetch(`${server.url}/api/kisskh/tv/9910?season=0&episode=1`);
  assert.equal(tvReady.status, 200);
  assert.deepEqual((await tvReady.json()).match, tv.match);
  assert.deepEqual(warmCalls, [
    ['movie', { tmdbId: 9910, season: 0, episode: 1 }],
    ['tv', { tmdbId: 9910, season: 0, episode: 1 }],
  ]);
});

test('GET accepts exactly hls and mp4 source types', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  for (const type of ['hls', 'mp4']) {
    const server = await serve(createKisskhRouter({
      enabled: true,
      publicProxyUrl: 'https://proxy.example',
      providerBaseUrl: 'https://kisskh.nl',
      resolver: { async resolveTv() { return { ...resolution(), sources: [{ ...resolution().sources[0], type }] }; } },
      capabilityStore: { async consume() { return null; } },
      proxyPolicy: { async assertCircuitClosed() {} },
    }));
    t.after(server.close);
    const response = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
    assert.equal(response.status, 200, type);
    assert.equal((await response.json()).sources[0].type, type);
  }

  const badServer = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver: { async resolveTv() { return { ...resolution(), sources: [{ ...resolution().sources[0], type: 'dash' }] }; } },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  }));
  t.after(badServer.close);
  const badResponse = await fetch(`${badServer.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(badResponse.status, 502);
});

test('route accepts txt2 AES and rejects the legacy unsupported a3 descriptor', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const txt2Track = {
    id: 'kisskh-en',
    lang: 'en',
    label: 'English',
    format: 'txt2',
    sourceUrl: 'https://subs.example/en.txt2',
    proxyUrl: 'https://subs.example/en.txt2',
    cipher: {
      mode: 'aes-128-cbc',
      keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
      ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
      payloadEncoding: 'base64-per-cue',
      padding: 'pkcs7',
    },
  };
  const createServer = async (cipher) => serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    resolver: {
      async resolveTv() {
        return { ...resolution(), subtitles: [{ ...txt2Track, cipher }] };
      },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  }));

  const validServer = await createServer(txt2Track.cipher);
  t.after(validServer.close);
  const valid = await fetch(`${validServer.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).subtitles[0].cipher, txt2Track.cipher);

  const legacyServer = await createServer({ mode: 'unsupported', scheme: 'a3' });
  t.after(legacyServer.close);
  const legacy = await fetch(`${legacyServer.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(legacy.status, 502);
});

test('GET returns direct KissKH URLs without VIP and proxy URLs with a valid VIP key', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const calls = [];
  const router = createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    verifyAccessKey: async (accessKey) => ({ vip: accessKey === 'valid-vip-key' }),
    resolver: {
      async resolveTv(_request, options) {
        calls.push(options);
        const value = resolution();
        if (options?.proxyMedia !== true) {
          value.sources[0].url = 'https://media.example/master.m3u8';
          value.subtitles[0].proxyUrl = value.subtitles[0].sourceUrl;
        }
        return value;
      },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  });
  const server = await serve(router);
  t.after(server.close);

  const freeResponse = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`);
  assert.equal(freeResponse.status, 200);
  const free = await freeResponse.json();
  assert.equal(free.sources[0].url, 'https://media.example/master.m3u8');
  assert.equal(free.subtitles[0].proxyUrl, free.subtitles[0].sourceUrl);

  const vipResponse = await fetch(`${server.url}/api/kisskh/tv/154825?season=0&episode=1`, {
    headers: { 'x-access-key': 'valid-vip-key' },
  });
  assert.equal(vipResponse.status, 200);
  const vip = await vipResponse.json();
  assert.equal(new URL(vip.sources[0].url).origin, 'https://proxy.example');
  assert.equal(new URL(vip.subtitles[0].proxyUrl).origin, 'https://proxy.example');
  assert.deepEqual(calls, [{ proxyMedia: false }, { proxyMedia: true }]);
});

test('movie route returns direct URLs for free access and proxy descendants for VIP access', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const calls = [];
  const movieResolution = (proxyMedia) => {
    const value = resolution();
    value.match.tmdbId = 9910;
    if (!proxyMedia) {
      value.sources[0].url = 'https://media.example/master.m3u8';
      value.subtitles[0].proxyUrl = value.subtitles[0].sourceUrl;
    }
    return value;
  };
  const server = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    verifyAccessKey: async (accessKey) => ({ vip: accessKey === 'valid-vip-key' }),
    resolver: {
      async getCachedMovie(_request, options) {
        calls.push(options);
        return movieResolution(options?.proxyMedia === true);
      },
      async warmMovie() { throw new Error('warmMovie must not run for a cache hit'); },
      async resolveMovie() { throw new Error('resolveMovie must not run for a cache hit'); },
      async resolveTv() { throw new Error('TV resolver must not run'); },
    },
    capabilityStore: { async consume() { return null; } },
    proxyPolicy: { async assertCircuitClosed() {} },
  }));
  t.after(server.close);

  const freeResponse = await fetch(`${server.url}/api/kisskh/movie/9910`);
  assert.equal(freeResponse.status, 200);
  const free = await freeResponse.json();
  assert.equal(free.sources[0].url, 'https://media.example/master.m3u8');
  assert.equal(free.subtitles[0].proxyUrl, free.subtitles[0].sourceUrl);

  const vipResponse = await fetch(`${server.url}/api/kisskh/movie/9910`, {
    headers: { 'x-access-key': 'valid-vip-key' },
  });
  assert.equal(vipResponse.status, 200);
  const vip = await vipResponse.json();
  const mediaProxy = new URL(vip.sources[0].url);
  const subtitleProxy = new URL(vip.subtitles[0].proxyUrl);
  assert.equal(mediaProxy.origin, 'https://proxy.example');
  assert.equal(mediaProxy.pathname, '/kisskh-proxy');
  assert.equal(mediaProxy.searchParams.get('url'), 'https://media.example/master.m3u8');
  assert.equal(subtitleProxy.origin, 'https://proxy.example');
  assert.equal(subtitleProxy.pathname, '/kisskh-proxy');
  assert.equal(subtitleProxy.searchParams.get('url'), vip.subtitles[0].sourceUrl);
  assert.deepEqual(calls, [{ proxyMedia: false }, { proxyMedia: true }]);
});

test('route status mapping is normalized', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const cases = [
    ['not_found', 404], ['episode_missing', 404], ['invalid_input', 400],
    ['provider_rate_limited', 429], ['provider_changed', 502], ['provider_security', 502],
    ['provider_unavailable', 502], ['upstream_unavailable', 502], ['proxy_unavailable', 503],
  ];
  for (const [code, expected] of cases) {
    const server = await serve(createKisskhRouter({
      enabled: true,
      publicProxyUrl: 'https://proxy.example',
      providerBaseUrl: 'https://kisskh.nl',
      mediaAllowedHosts: ['media.example'],
      resolver: { async resolveTv() { throw new KisskhError(code, 'safe'); } },
      capabilityStore: { async consume() { return null; } },
      proxyPolicy: { async assertCircuitClosed() {} },
    }));
    t.after(server.close);
    const response = await fetch(`${server.url}/api/kisskh/tv/1?season=0&episode=1`);
    assert.equal(response.status, expected, code);
    assert.deepEqual(await response.json(), { code, message: 'safe' });
  }
});

test('fallback capability is atomically consumed once and returns only the strict descriptor', async (t) => {
  const { createFallbackCapabilityStore } = require('../../services/kisskh/kisskhCache');
  let now = 1_000_000;
  const values = new Map();
  const redis = {
    async set(key, value, mode, ttl) { values.set(key, { value, expiresAt: now + ttl * 1000 }); return 'OK'; },
    async getdel(key) {
      const entry = values.get(key);
      values.delete(key);
      return entry && now < entry.expiresAt ? entry.value : null;
    },
  };
  const store = createFallbackCapabilityStore({
    redis,
    now: () => now,
    mediaAllowedHosts: ['media.example'],
    providerBaseUrl: 'https://kisskh.nl',
  });
  const expiredToken = await store.create({
    url: 'https://media.example/video.mp4?sig=sensitive',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  now += 120_000;
  const token = await store.create({
    url: 'https://media.example/video.mp4?sig=sensitive',
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  const { createKisskhRouter } = require('../kisskh');
  const server = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    now: () => now,
    resolver: { async resolveTv() { return resolution(token); } },
    capabilityStore: store,
    proxyPolicy: { async assertCircuitClosed() {} },
  }));
  t.after(server.close);

  const first = await fetch(`${server.url}/api/kisskh/fallback/${token}`, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), {
    url: 'https://media.example/video.mp4?sig=sensitive',
    expiresAt: 1_240_000,
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
  const reused = await fetch(`${server.url}/api/kisskh/fallback/${token}`, { method: 'POST' });
  const malformed = await fetch(`${server.url}/api/kisskh/fallback/not-a-token`, { method: 'POST' });
  const expired = await fetch(`${server.url}/api/kisskh/fallback/${expiredToken}`, { method: 'POST' });
  assert.equal(reused.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal(expired.status, 404);
  const reusedBody = await reused.json();
  assert.deepEqual(reusedBody, await malformed.json());
  assert.deepEqual(reusedBody, await expired.json());
});

test('fallback consumes before the shared breaker and cannot be retried after 429', async (t) => {
  const consumed = [];
  let breakerCalls = 0;
  const store = {
    async consume(token) {
      consumed.push(token);
      return consumed.length === 1
        ? { url: 'https://media.example/video.mp4', expiresAt: Date.now() + 1000, requiredHeaders: {} }
        : null;
    },
  };
  const server = await serve(require('../kisskh').createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    resolver: { async resolveTv() { return resolution(); } },
    capabilityStore: store,
    proxyPolicy: {
      async assertCircuitClosed() {
        breakerCalls += 1;
        throw new KisskhError('provider_rate_limited', 'KissKH temporairement limite');
      },
    },
  }));
  t.after(server.close);
  const token = 'B'.repeat(43);
  const first = await fetch(`${server.url}/api/kisskh/fallback/${token}`, { method: 'POST' });
  const second = await fetch(`${server.url}/api/kisskh/fallback/${token}`, { method: 'POST' });
  assert.equal(first.status, 429);
  assert.equal(second.status, 404);
  assert.equal(breakerCalls, 1);
  assert.deepEqual(consumed, [token, token]);
});

test('fallback exchange accepts a bounded HTTP URL without host allowlist or DNS resolution', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  let consumeCalls = 0;
  let breakerCalls = 0;
  const expiresAt = Date.now() + 10_000;
  const server = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    resolver: { async resolveTv() { return resolution(); } },
    capabilityStore: {
      async consume() {
        consumeCalls += 1;
        return {
          url: 'http://127.0.0.1:8080/video.mp4?sig=sensitive',
          expiresAt,
          requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
        };
      },
    },
    async resolveDns() { throw new Error('DNS must not be used'); },
    proxyPolicy: { async assertCircuitClosed() { breakerCalls += 1; } },
  }));
  t.after(server.close);

  const response = await fetch(`${server.url}/api/kisskh/fallback/${'E'.repeat(43)}`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(consumeCalls, 1);
  assert.equal(breakerCalls, 1);
  assert.deepEqual(await response.json(), {
    url: 'http://127.0.0.1:8080/video.mp4?sig=sensitive',
    expiresAt,
    requiredHeaders: { Referer: 'https://kisskh.nl/', Origin: 'https://kisskh.nl' },
  });
});

test('capability creation keeps strict headers and URL bounds but accepts arbitrary HTTP hosts', async () => {
  const { createFallbackCapabilityStore } = require('../../services/kisskh/kisskhCache');
  let writes = 0;
  const store = createFallbackCapabilityStore({
    redis: { async set() { writes += 1; return 'OK'; } },
    now: () => 1,
    randomBytes: () => Buffer.alloc(32, 1),
    mediaAllowedHosts: ['media.example'],
    providerBaseUrl: 'https://kisskh.nl',
  });
  for (const requiredHeaders of [
    { Cookie: 'secret' }, { Referer: 'ok\r\nX-Evil: yes' }, { Origin: 'x'.repeat(2049) },
    { Origin: 'https://evil.example' }, { Origin: 'https://kisskh.nl/path' },
    { Referer: 'http://kisskh.nl/' }, { Referer: 'https://evil.example/' },
  ]) {
    await assert.rejects(store.create({ url: 'https://media.example/video.mp4', requiredHeaders }),
      (error) => error.code === 'provider_security');
  }
  for (const url of [
    'ftp://media.example/video.mp4',
    'https://user:pass@media.example/video.mp4',
    'https://media.example/video.mp4#fragment',
    'https://media.example/video.mp4\r\nInjected: yes',
  ]) {
    await assert.rejects(store.create({ url, requiredHeaders: {} }),
      (error) => error.code === 'provider_security');
  }
  assert.equal(writes, 0);
  const token = await store.create({
    url: 'http://127.0.0.1:8080/video.mp4', requiredHeaders: { Origin: 'https://kisskh.nl' },
  });
  assert.match(token, /^[A-Za-z0-9_-]{22,128}$/);
  assert.equal(writes, 1);
});

test('fallback response revalidates provider headers and bounded URL syntax after atomic consume', async (t) => {
  const { createKisskhRouter } = require('../kisskh');
  const records = [
    {
      url: 'https://media.example/video.mp4', expiresAt: Date.now() + 10_000,
      requiredHeaders: { Origin: 'https://evil.example' },
    },
    {
      url: 'ftp://media.example/video.mp4', expiresAt: Date.now() + 10_000,
      requiredHeaders: { Origin: 'https://kisskh.nl' },
    },
  ];
  const server = await serve(createKisskhRouter({
    enabled: true,
    publicProxyUrl: 'https://proxy.example',
    providerBaseUrl: 'https://kisskh.nl',
    mediaAllowedHosts: ['media.example'],
    resolver: { async resolveTv() { return resolution(); } },
    capabilityStore: { async consume() { return records.shift(); } },
    proxyPolicy: { async assertCircuitClosed() {} },
  }));
  t.after(server.close);

  for (const token of ['C'.repeat(43), 'D'.repeat(43)]) {
    const response = await fetch(`${server.url}/api/kisskh/fallback/${token}`, { method: 'POST' });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /evil|ftp|media\.example/i);
  }
});
