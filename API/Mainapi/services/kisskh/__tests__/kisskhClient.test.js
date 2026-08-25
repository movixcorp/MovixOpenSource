const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const { APPROVED_ALGORITHMS } = require('../approvedAlgorithms');

const ALGORITHM = [...APPROVED_ALGORITHMS.values()][0];
const PROXIES = [
  { type: 'socks5', host: '203.0.113.10', port: 1080, auth: 'user:secret' },
  { type: 'socks5', host: '203.0.113.11', port: 1080 },
  { type: 'socks5', host: '203.0.113.12', port: 1080 },
];

function fakePolicy(overrides = {}) {
  let nextProxy = 0;
  const calls = { assert: 0, reserve: 0, reserveGlobal: 0, success: [], failure: [], rateLimited: [] };
  return {
    calls,
    async assertCircuitClosed() { calls.assert += 1; },
    async reserve() {
      calls.reserve += 1;
      const proxy = PROXIES[nextProxy % PROXIES.length];
      nextProxy += 1;
      return proxy;
    },
    async reserveGlobal() { calls.reserveGlobal += 1; },
    async recordSuccess(proxy) { calls.success.push(proxy); },
    async recordFailure(proxy, kind) { calls.failure.push([proxy, kind]); },
    async record429(headers) { calls.rateLimited.push(headers); },
    ...overrides,
  };
}

function createDeps(request, overrides = {}) {
  return {
    request,
    proxyPolicy: fakePolicy(),
    baseUrl: 'https://kisskh.nl',
    allowedHosts: ['kisskh.nl'],
    resolveDns: async () => [{ address: '93.184.216.34', family: 4 }],
    bundleRegistry: { async resolveApprovedAlgorithm() { return ALGORITHM; } },
    ...overrides,
  };
}

function ok(data) {
  const serialized = JSON.stringify(data);
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(serialized)) },
    data,
    compressedBytes: Buffer.byteLength(serialized),
    decompressedBytes: Buffer.byteLength(serialized),
  };
}

function createHttpsHarness(body = '[]') {
  const state = { options: null };
  return {
    state,
    request(options, onResponse) {
      state.options = options;
      const outgoing = new EventEmitter();
      outgoing.destroyed = false;
      outgoing.setTimeout = () => outgoing;
      outgoing.destroy = () => {
        outgoing.destroyed = true;
        return outgoing;
      };
      outgoing.end = () => {
        const incoming = Readable.from([Buffer.from(body)]);
        incoming.statusCode = 200;
        incoming.headers = {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        };
        queueMicrotask(() => onResponse(incoming));
      };
      return outgoing;
    },
  };
}

test('default metadata transport uses authenticated SOCKS5h remote DNS for ProxyScrape', async () => {
  const { createDefaultRequest } = require('../kisskhClient');
  const harness = createHttpsHarness();
  const request = createDefaultRequest({ request: harness.request });

  await request({
    url: 'https://kisskh.nl/api/DramaList/Search?q=Business+Proposal',
    headers: { Accept: 'application/json' },
    timeout: 1_000,
    maxCompressedBytes: 2 * 1024 * 1024,
    maxDecompressedBytes: 2 * 1024 * 1024,
    addresses: ['93.184.216.34'],
    proxy: PROXIES[0],
  });

  assert.equal(harness.state.options.hostname, 'kisskh.nl');
  assert.equal(harness.state.options.servername, 'kisskh.nl');
  assert.equal(harness.state.options.headers.Host, 'kisskh.nl');
  assert.equal(harness.state.options.agent.shouldLookup, false, 'SOCKS5h must resolve through the proxy');
  assert.equal(harness.state.options.lookup, undefined);

  const { SocksClient } = require('socks');
  const originalCreateConnection = SocksClient.createConnection;
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  let socksOptions;
  SocksClient.createConnection = async (options) => {
    socksOptions = options;
    return { socket };
  };
  try {
    await harness.state.options.agent.connect({ destroy() {} }, {
      host: harness.state.options.hostname,
      port: 443,
      secureEndpoint: false,
    });
  } finally {
    SocksClient.createConnection = originalCreateConnection;
  }
  assert.deepEqual(socksOptions.destination, { host: 'kisskh.nl', port: 443 });
});

test('uses the exact typed Search and Drama endpoints with bounded metadata options', async () => {
  const calls = [];
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    calls.push(options);
    return ok(options.url.includes('/Search') ? [{ id: 4608 }] : { id: 4608, episodes: [] });
  }));
  await client.search('Swallowed Star', 3);
  await client.getDrama(4608);

  const searchUrl = new URL(calls[0].url);
  assert.equal(
    `${searchUrl.pathname}${searchUrl.search}`,
    '/api/DramaList/Search?q=Swallowed+Star&type=3',
  );
  await assert.rejects(client.search('Title', 5), (error) => error.code === 'invalid_input');
  assert.equal(new URL(calls[1].url).pathname + new URL(calls[1].url).search, '/api/DramaList/Drama/4608?isq=false');
  assert.ok(calls.every((call) => call.timeout === 10_000));
  assert.ok(calls.every((call) => call.maxCompressedBytes === 2 * 1024 * 1024));
  assert.ok(calls.every((call) => call.maxDecompressedBytes === 2 * 1024 * 1024));
  assert.ok(calls.every((call) => call.headers.Referer === 'https://kisskh.nl/'));
  assert.ok(calls.every((call) => call.proxy));
  assert.notEqual(calls[0].proxy, calls[1].proxy);
});

test('uses the paginated List endpoint with strict catalogue bounds', async () => {
  const calls = [];
  const payload = { page: 2, pageSize: 100, totalCount: 12_653, data: [] };
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    calls.push(options);
    return ok(payload);
  }));

  assert.deepEqual(await client.list(2, 100, 4), payload);
  const listUrl = new URL(calls[0].url);
  assert.equal(
    `${listUrl.pathname}${listUrl.search}`,
    '/api/DramaList/List?type=4&page=2&pageSize=100',
  );
  await assert.rejects(client.list(0, 100, 0), (error) => error.code === 'invalid_input');
  await assert.rejects(client.list(1, 101, 0), (error) => error.code === 'invalid_input');
  await assert.rejects(client.list(1, 100, 5), (error) => error.code === 'invalid_input');
  assert.equal(calls.length, 1);
});

test('Episode and Sub use exact current paths and distinct approved kkey contexts', async () => {
  const calls = [];
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    calls.push(options);
    return ok(options.url.includes('/Episode/') ? { Video: 'redacted' } : []);
  }));
  await client.getEpisode(86439);
  await client.getSubtitles(86439);
  const episodeUrl = new URL(calls[0].url);
  const subUrl = new URL(calls[1].url);
  assert.equal(episodeUrl.pathname, '/api/DramaList/Episode/86439.png');
  assert.equal(episodeUrl.searchParams.get('err'), 'false');
  assert.equal(episodeUrl.searchParams.get('ts'), 'null');
  assert.equal(episodeUrl.searchParams.get('time'), 'null');
  assert.equal(subUrl.pathname, '/api/Sub/86439');
  assert.equal(episodeUrl.searchParams.get('kkey').length, 256);
  assert.equal(subUrl.searchParams.get('kkey').length, 256);
  assert.notEqual(episodeUrl.searchParams.get('kkey'), subUrl.searchParams.get('kkey'));
});

test('Episode accepts the provider JSON body served as image/png while other metadata stays JSON-only', async () => {
  const body = JSON.stringify({ id: 86439, Video: 'https://media.example/video.mp4' });
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => ({
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(Buffer.byteLength(body)) },
    data: body,
    compressedBytes: Buffer.byteLength(body),
    decompressedBytes: Buffer.byteLength(body),
    requestPath: new URL(options.url).pathname,
  })));
  assert.deepEqual(await client.getEpisode(86439), JSON.parse(body));
  await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_security');
});

test('429 opens the global breaker and is not retried on another proxy', async () => {
  const calls = [];
  const policy = fakePolicy();
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    calls.push(options);
    return { status: 429, headers: { 'retry-after': '90' }, data: {} };
  }, { proxyPolicy: policy }));
  await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_rate_limited');
  assert.equal(calls.length, 1);
  assert.equal(policy.calls.reserve, 1);
  assert.equal(policy.calls.assert, 1, 'transport rechecks the breaker after its global slot');
  assert.equal(policy.calls.rateLimited.length, 1);
  assert.equal(policy.calls.failure.length, 0);
});

test('a breaker opened during the global wait blocks transport without retrying or quarantining a proxy', async () => {
  const { KisskhError } = require('../errors');
  let breakerOpen = false;
  let slotCalls = 0;
  let breakerCalls = 0;
  let requestCalls = 0;
  const policy = fakePolicy({
    async reserveGlobal() {
      slotCalls += 1;
      breakerOpen = true;
    },
    async assertCircuitClosed() {
      breakerCalls += 1;
      if (breakerOpen) throw new KisskhError('provider_rate_limited', 'KissKH temporairement limite');
    },
  });
  const client = require('../kisskhClient').createKisskhClient(createDeps(async () => {
    requestCalls += 1;
    return ok([]);
  }, { proxyPolicy: policy }));

  await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_rate_limited');
  assert.equal(slotCalls, 1);
  assert.equal(breakerCalls, 1);
  assert.equal(requestCalls, 0);
  assert.equal(policy.calls.reserve, 1);
  assert.equal(policy.calls.failure.length, 0);
});

test('transport failures rotate proxies for at most three attempts', async () => {
  const policy = fakePolicy();
  const calls = [];
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    calls.push(options);
    throw new Error('ECONNRESET from a redacted upstream');
  }, { proxyPolicy: policy, maxAttempts: 3 }));
  await assert.rejects(client.getDrama(4608), (error) => error.code === 'provider_unavailable');
  assert.equal(calls.length, 3);
  assert.equal(policy.calls.reserve, 3);
  assert.equal(policy.calls.failure.length, 3);
  assert.deepEqual(calls.map((call) => call.proxy.host), PROXIES.map((proxy) => proxy.host));
});

test('redirects are manual and HTTPS/allowlist/public DNS is revalidated every hop', async () => {
  const requests = [];
  const dnsCalls = [];
  const policy = fakePolicy();
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    requests.push(options);
    if (requests.length === 1) {
      return { status: 302, headers: { location: '/api/DramaList/Search?q=redirected' }, data: '' };
    }
    return ok([{ id: 1 }]);
  }, {
    proxyPolicy: policy,
    resolveDns: async (hostname) => {
      dnsCalls.push(hostname);
      return [{ address: '93.184.216.34', family: 4 }];
    },
  }));
  assert.deepEqual(await client.search('Business Proposal'), [{ id: 1 }]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.redirect === 'manual'));
  assert.equal(requests[0].proxy, requests[1].proxy);
  assert.deepEqual(dnsCalls, ['kisskh.nl', 'kisskh.nl']);
  assert.equal(policy.calls.reserveGlobal, 2);
});

test('redirect to an unapproved host is rejected before another request or DNS lookup', async () => {
  let requestCalls = 0;
  let dnsCalls = 0;
  const client = require('../kisskhClient').createKisskhClient(createDeps(async () => {
    requestCalls += 1;
    return { status: 302, headers: { location: 'https://evil.example/steal' }, data: '' };
  }, {
    resolveDns: async () => { dnsCalls += 1; return [{ address: '93.184.216.34', family: 4 }]; },
  }));
  await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_security');
  assert.equal(requestCalls, 1);
  assert.equal(dnsCalls, 1);
});

test('private DNS answers are rejected before any HTTP request', async () => {
  let requestCalls = 0;
  const client = require('../kisskhClient').createKisskhClient(createDeps(async () => {
    requestCalls += 1;
    return ok([]);
  }, { resolveDns: async () => [{ address: '127.0.0.1', family: 4 }] }));
  await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_security');
  assert.equal(requestCalls, 0);
});

test('compressed and decompressed JSON bodies are independently limited to 2 MiB', async () => {
  for (const field of ['compressedBytes', 'decompressedBytes']) {
    const client = require('../kisskhClient').createKisskhClient(createDeps(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: [],
      [field]: (2 * 1024 * 1024) + 1,
    })));
    await assert.rejects(client.search('Business Proposal'), (error) => error.code === 'provider_security');
  }
});

test('safe errors redact full URLs, kkeys, query values and proxy credentials', async () => {
  const client = require('../kisskhClient').createKisskhClient(createDeps(async (options) => {
    throw new Error(`failed ${options.url} via ${options.proxy.auth}`);
  }, { maxAttempts: 1 }));
  let caught;
  try {
    await client.getEpisode(86439);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, 'provider_unavailable');
  const publicError = JSON.stringify(caught);
  assert.doesNotMatch(`${caught.message} ${publicError}`, /kisskh\.nl|kkey|86439|user|secret|https?:/i);
});

test('invalid base URLs and unbounded inputs fail closed', async () => {
  const { createKisskhClient } = require('../kisskhClient');
  assert.throws(() => createKisskhClient(createDeps(async () => ok([]), { baseUrl: 'http://kisskh.nl' })));
  const client = createKisskhClient(createDeps(async () => ok([])));
  await assert.rejects(client.search(' '.repeat(3)), (error) => error.code === 'invalid_input');
  await assert.rejects(client.search('x'.repeat(201)), (error) => error.code === 'invalid_input');
  await assert.rejects(client.getDrama('4608'), (error) => error.code === 'invalid_input');
  await assert.rejects(client.getEpisode(0), (error) => error.code === 'invalid_input');
});
