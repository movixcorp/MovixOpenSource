// API/Mainapi/utils/__tests__/hydrackerLive.test.js
//
// Couvre le chemin live actuel : hydracker renvoie l'URL hoster directement,
// la resolution est un GET unique. Pas de file d'attente de concurrence, pas
// de verrou Redis, pas d'aller-retour debrid — ces couches ont ete retirees.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHydrackerLive,
  _fetchHydrackerLien,
  _normalizeHydrackerLien,
} = require('../hydrackerLive');

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    exists: mock.fn(async (key) => (store.has(key) ? 1 : 0)),
    set: mock.fn(async (key, val, ...args) => {
      const flags = new Set(args);
      if (flags.has('NX') && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    }),
    del: mock.fn(async (key) => { store.delete(key); return 1; }),
    get: mock.fn(async (key) => store.get(key) ?? null),
  };
}

function makeAxiosStub(handler) {
  return { get: mock.fn(handler) };
}

const fetchDeps = () => ({
  axios: null,
  cookies: 'SERVERID=S1',
  xsrf: 'xsrf-token',
  timeoutMs: 20000,
});

test('fetchHydrackerLien: returns the direct URL and metadata on success', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async (url, cfg) => {
    assert.equal(url, 'https://hydracker.com/api/v1/content/liens/18780524');
    assert.equal(cfg.timeout, 20000);
    assert.equal(cfg.headers.cookie, 'SERVERID=S1');
    assert.equal(cfg.headers['x-xsrf-token'], 'xsrf-token');
    return { status: 200, data: {
      lien: {
        id: 18780524,
        lien: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
        id_host: 5,
        taille: 1658392158,
        created_at: '2025-12-16T12:56:27.000000Z',
      },
      raw_url: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
      directDL: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
    }};
  });
  const out = await _fetchHydrackerLien(18780524, deps);
  assert.deepEqual(out, {
    ok: true,
    directDL: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
    lienUrl: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
    id_host: 5,
    rawUrl: 'https://1fichier.com/?bluzzibv1a9sedt69saa',
    taille: 1658392158,
    created_at: '2025-12-16T12:56:27.000000Z',
  });
});

test('fetchHydrackerLien: falls back to lien.lien when directDL is absent', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => ({ status: 200, data: {
    lien: { id: 7, lien: 'https://1fichier.com/?onlylien', id_host: 5 },
  }}));
  const out = await _fetchHydrackerLien(7, deps);
  assert.equal(out.ok, true);
  assert.equal(out.directDL, 'https://1fichier.com/?onlylien');
  assert.equal(out.lienUrl, 'https://1fichier.com/?onlylien');
});

test('fetchHydrackerLien: returns ok=false with code live_no_directdl when no URL is returned', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => ({ status: 200, data: { lien: { id: 1 }, directDL: null }}));
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_no_directdl' });
});

test('fetchHydrackerLien: returns code live_hydracker_error on 5xx', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { const e = new Error('500'); e.response = { status: 500 }; throw e; });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 500 });
});

test('fetchHydrackerLien: returns code live_hydracker_error on 429', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { const e = new Error('429'); e.response = { status: 429 }; throw e; });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 429 });
});

test('fetchHydrackerLien: returns code live_hydracker_error on network failure', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { throw new Error('ECONNRESET'); });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 0 });
});

test('normalizeHydrackerLien: surfaces the real host name as the visible provider', () => {
  const out = _normalizeHydrackerLien({
    id: 19329390,
    id_host: 5,
    taille: 956860149,
    created_at: '2026-08-21T19:17:00.000000Z',
    saison: 1,
    episode: 1,
    full_saison: 0,
    host: { name: '1Fichier', icon: '/hosts/1fichier.svg' },
    qual: { qual: '1080p' },
    langues_compact: [{ name: 'VF' }],
    subs_compact: [{ name: 'VOSTFR' }],
  });
  assert.equal(out.id, 19329390);
  assert.equal(out.provider, '1Fichier');
  assert.equal(out.host_name, '1Fichier');
  assert.equal(out.host_id, 5);
  assert.equal(out.quality, '1080p');
  assert.equal(out.language, 'VF');
  assert.equal(out.sub, 'VOSTFR');
  assert.equal(out.full_saison, undefined);
  assert.equal(out.source, 'hydracker-live');
});

test('normalizeHydrackerLien: rejects rows without a numeric id', () => {
  assert.equal(_normalizeHydrackerLien(null), null);
  assert.equal(_normalizeHydrackerLien({ id: 'abc' }), null);
});

function setupLive(overrides = {}) {
  const redis = makeFakeRedis();
  const cacheStore = new Map();
  const axios = {
    get: mock.fn(async (url) => {
      if (url.startsWith('https://hydracker.com/')) {
        return { status: 200, data: {
          lien: { id: 42, taille: 1234, created_at: '2025-01-01T00:00:00Z' },
          raw_url: 'https://1fichier.com/?raw42',
          directDL: 'https://1fichier.com/?raw42',
        }};
      }
      throw new Error(`unexpected url ${url}`);
    }),
  };
  const deps = {
    redis,
    axios,
    cookies: 'c',
    xsrf: 'x',
    timeoutMs: 20000,
    cacheGet: async (_, k) => cacheStore.get(k) ?? null,
    cacheSet: async (_, k, v) => { cacheStore.set(k, v); },
    cacheKeyFor: (id) => `darkiworld_decode_v2_${id}`,
    cacheDir: '/tmp',
    ...overrides,
  };
  const live = createHydrackerLive(deps);
  return { live, redis, axios, cacheStore };
}

test('resolveLien: returns success payload with raw URL on happy path', async () => {
  const { live, axios } = setupLive();
  const out = await live.resolveLien(42);
  assert.ok(out.payload, 'expected payload');
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.id, '42');
  assert.equal(out.payload.provider, 'hydracker-live');
  assert.equal(out.payload.embed_url.lien, 'https://1fichier.com/?raw42');
  assert.equal(out.payload.embed_url.taille, 1234);
  assert.equal(out.payload.source, 'live');
  assert.equal(axios.get.mock.callCount(), 1);
});

test('resolveLien: returns failed marker live_no_directdl when hydracker has no URL', async () => {
  const { live } = setupLive({
    axios: { get: mock.fn(async () => ({ status: 200, data: { lien: { id: 42 }, directDL: null }})) },
  });
  const out = await live.resolveLien(42);
  assert.equal(out.payload, undefined);
  assert.equal(out.failed.failed, true);
  assert.equal(out.failed.debug, 'live_no_directdl');
});

test('resolveLien: returns failed marker live_hydracker_error on hydracker 5xx', async () => {
  const { live } = setupLive({
    axios: { get: mock.fn(async () => { const e = new Error('500'); e.response = { status: 500 }; throw e; }) },
  });
  const out = await live.resolveLien(42);
  assert.equal(out.failed.failed, true);
  assert.equal(out.failed.debug, 'live_hydracker_error');
});

test('resolveLien: a 5xx arms the cluster-wide cooldown and the next call short-circuits', async () => {
  const { live, redis, axios } = setupLive({
    axios: { get: mock.fn(async () => { const e = new Error('503'); e.response = { status: 503 }; throw e; }) },
  });
  await live.resolveLien(42);
  assert.equal(redis.store.has('hydracker:cooldown:5xx'), true);
  const callsAfterFirst = axios.get.mock.callCount();
  const out = await live.resolveLien(43);
  assert.equal(out.failed.debug, 'live_hydracker_cooldown');
  assert.equal(axios.get.mock.callCount(), callsAfterFirst, 'cooldown must stop outbound fetches');
});

test('resolveLien: a Redis outage must not block the live fetch (fail-open)', async () => {
  const brokenRedis = {
    store: new Map(),
    exists: async () => { throw new Error('ECONNREFUSED'); },
    set: async () => { throw new Error('ECONNREFUSED'); },
    del: async () => 0,
    get: async () => { throw new Error('ECONNREFUSED'); },
  };
  const { live, axios } = setupLive({ redis: brokenRedis });
  const out = await live.resolveLien(42);
  assert.ok(out.payload, 'live fetch must still run when Redis is down');
  assert.equal(out.payload.embed_url.lien, 'https://1fichier.com/?raw42');
  assert.equal(axios.get.mock.callCount(), 1);
});

test('resolveLien: ignores stale pre-existing sqlite_miss marker in cache and runs hydracker fetch', async () => {
  const { live, axios, cacheStore } = setupLive();
  cacheStore.set('darkiworld_decode_v2_42', {
    failed: true, failedAt: Date.now() - (60 * 1000),
    id: '42', error: 'Lien indisponible', debug: 'sqlite_miss',
  });
  const out = await live.resolveLien(42);
  assert.ok(out.payload, 'expected the live path to run past the stale marker');
  assert.equal(out.payload.embed_url.lien, 'https://1fichier.com/?raw42');
  assert.equal(axios.get.mock.callCount(), 1);
  assert.equal(cacheStore.get('darkiworld_decode_v2_42').success, true);
});

test('resolveLien: second call for the same id reuses cached hydracker response (Redis hydracker:lien cache)', async () => {
  const { live, axios } = setupLive();
  await live.resolveLien(42);
  const hydrackerCallsAfterFirst = axios.get.mock.calls.filter(
    (c) => c.arguments[0].startsWith('https://hydracker.com/'),
  ).length;
  await live.resolveLien(42);
  const hydrackerCallsAfterSecond = axios.get.mock.calls.filter(
    (c) => c.arguments[0].startsWith('https://hydracker.com/'),
  ).length;
  assert.equal(hydrackerCallsAfterFirst, 1);
  assert.equal(hydrackerCallsAfterSecond, 1, 'hydracker must not be hit twice within hydrackerLienCacheTtl');
});

function setupList(rows, overrides = {}) {
  const redis = makeFakeRedis();
  const axios = {
    get: mock.fn(async () => ({ status: 200, data: { pagination: { data: rows } } })),
  };
  const live = createHydrackerLive({
    redis,
    axios,
    cookies: 'c',
    xsrf: 'x',
    timeoutMs: 20000,
    cacheGet: async () => null,
    cacheSet: async () => {},
    cacheKeyFor: (id) => `darkiworld_decode_v2_${id}`,
    cacheDir: '/tmp',
    ...overrides,
  });
  return { live, redis, axios };
}

test('listLiensForTitle: returns every normalized row for a movie', async () => {
  const { live } = setupList([
    { id: 1, host: { name: '1Fichier' }, saison: 0, episode: null },
    { id: 2, host: { name: 'Send' }, saison: 0, episode: null },
  ]);
  const out = await live.listLiensForTitle(17323, { type: 'movie' });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

test('listLiensForTitle: keeps the matching episode and the full-season packs', async () => {
  const { live } = setupList([
    { id: 1, host: { name: 'A' }, saison: 1, episode: 1 },
    { id: 2, host: { name: 'B' }, saison: 1, episode: 2 },
    { id: 3, host: { name: 'C' }, saison: 1, episode: null, full_saison: 1 },
    { id: 4, host: { name: 'D' }, saison: 2, episode: 1 },
  ]);
  const out = await live.listLiensForTitle(17323, { type: 'tv', season: 1, episode: 1 });
  assert.deepEqual(out.map((r) => r.id), [1, 3]);
});

test('listLiensForTitle: rejects a non-numeric title id without any fetch', async () => {
  const { live, axios } = setupList([]);
  assert.deepEqual(await live.listLiensForTitle('abc'), []);
  assert.deepEqual(await live.listLiensForTitle(-1), []);
  assert.equal(axios.get.mock.callCount(), 0);
});

test('listLiensForTitle: returns an empty list instead of throwing when hydracker fails', async () => {
  const { live } = setupList([], {
    axios: { get: mock.fn(async () => { const e = new Error('500'); e.response = { status: 500 }; throw e; }) },
  });
  assert.deepEqual(await live.listLiensForTitle(17323, { type: 'movie' }), []);
});
