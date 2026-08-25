const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WIFLIX_PROXY_REDIS_TTL_SECONDS,
  createWiflixProxyAffinity,
  isSocksWiflixProxyUrl,
  isValidWiflixProxyUrl,
  mergeWiflixProxySources,
  redactWiflixProxyUrl,
  runWiflixProxyAttempts,
} = require('../wiflixProxyAffinity');

class InMemoryRedis {
  constructor() {
    this.values = new Map();
    this.setCalls = [];
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async set(key, value, ...args) {
    this.values.set(key, value);
    this.setCalls.push([key, value, ...args]);
    return 'OK';
  }

  async eval(_script, _keyCount, key, expectedValue) {
    if (this.values.get(key) !== expectedValue) return 0;
    this.values.delete(key);
    return 1;
  }
}

test('a successful Wiflix proxy is retained in Redis for 24 hours', async () => {
  const redis = new InMemoryRedis();
  const affinity = createWiflixProxyAffinity({ redis });
  const proxyUrl = 'http://198.51.100.10:8080';

  assert.equal(await affinity.remember(proxyUrl), true);
  assert.equal(await affinity.getPreferred(), proxyUrl);
  assert.deepEqual(
    redis.setCalls.at(-1).slice(2),
    ['EX', WIFLIX_PROXY_REDIS_TTL_SECONDS],
  );
});

test('the retained Wiflix proxy is tried first, evicted on failure, then replaced by a success', async () => {
  const redis = new InMemoryRedis();
  const affinity = createWiflixProxyAffinity({ redis });
  const retained = 'http://198.51.100.10:8080';
  const replacement = 'http://198.51.100.11:8080';
  const unused = 'http://198.51.100.12:8080';
  const attempted = [];
  const deadProxies = new Set();

  await affinity.remember(retained);

  const outcome = await runWiflixProxyAttempts({
    affinity,
    proxies: [unused, replacement, retained],
    deadProxies,
    maxAttempts: 3,
    attempt: async (proxyUrl) => {
      attempted.push(proxyUrl);
      if (proxyUrl === retained) throw new Error('HTTP 429');
      if (proxyUrl === replacement) return { status: 200, data: '<html>ok</html>' };
      throw new Error('timeout');
    },
  });

  assert.deepEqual(attempted, [retained, unused, replacement]);
  assert.equal(outcome.proxyUrl, replacement);
  assert.equal(outcome.response.status, 200);
  assert.equal(deadProxies.has(retained), true);
  assert.equal(deadProxies.has(unused), true);
  assert.equal(await affinity.getPreferred(), replacement);
});

test('Redis failures never prevent Wiflix from trying local proxies', async () => {
  const unavailableAffinity = {
    async getPreferred() { throw new Error('Redis unavailable'); },
    async remember() { throw new Error('Redis unavailable'); },
    async forget() { throw new Error('Redis unavailable'); },
  };
  const localProxy = 'http://203.0.113.20:3128';

  const outcome = await runWiflixProxyAttempts({
    affinity: unavailableAffinity,
    proxies: [localProxy],
    deadProxies: new Set(),
    maxAttempts: 3,
    attempt: async () => ({ status: 200, data: '<html>ok</html>' }),
  });

  assert.equal(outcome.proxyUrl, localProxy);
  assert.equal(outcome.response.status, 200);
});

test('authenticated SOCKS5 proxies are valid Wiflix candidates', async () => {
  const socksProxy = 'socks5h://user:password@147.135.138.207:10041';

  assert.equal(isValidWiflixProxyUrl(socksProxy), true);
  assert.equal(isSocksWiflixProxyUrl(socksProxy), true);

  const attempted = [];
  const outcome = await runWiflixProxyAttempts({
    affinity: createWiflixProxyAffinity({ redis: new InMemoryRedis() }),
    proxies: [socksProxy],
    deadProxies: new Set(),
    maxAttempts: 1,
    attempt: async (proxyUrl) => {
      attempted.push(proxyUrl);
      return { status: 200, data: '<html>ok</html>' };
    },
  });

  assert.deepEqual(attempted, [socksProxy]);
  assert.equal(outcome.proxyUrl, socksProxy);
});

test('configured SOCKS5 proxies stay ahead of fetched Wiflix proxies without duplicates', () => {
  const configured = [
    'socks5h://user:password@147.135.138.207:10041',
    'socks5h://user:password@147.135.138.207:10042',
  ];
  const fetched = [
    configured[1],
    'http://198.51.100.10:8080',
  ];

  assert.deepEqual(
    mergeWiflixProxySources(configured, fetched),
    [configured[0], configured[1], fetched[1]],
  );
});

test('Wiflix logs never expose proxy credentials', () => {
  assert.equal(
    redactWiflixProxyUrl('socks5h://user:password@147.135.138.207:10041'),
    'socks5h://147.135.138.207:10041',
  );
});

test('configured Wiflix proxies take priority over an older Redis affinity', async () => {
  const redis = new InMemoryRedis();
  const affinity = createWiflixProxyAffinity({ redis });
  const retained = 'http://198.51.100.10:8080';
  const configured = 'socks5h://user:password@147.135.138.207:10041';
  const attempted = [];

  await affinity.remember(retained);

  const outcome = await runWiflixProxyAttempts({
    affinity,
    priorityProxies: [configured],
    proxies: [retained, configured],
    deadProxies: new Set(),
    maxAttempts: 2,
    attempt: async (proxyUrl) => {
      attempted.push(proxyUrl);
      return { status: 200, data: '<html>ok</html>' };
    },
  });

  assert.deepEqual(attempted, [configured]);
  assert.equal(outcome.proxyUrl, configured);
  assert.equal(await affinity.getPreferred(), configured);
});
