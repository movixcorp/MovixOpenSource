const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWiflixProxyTelemetry,
  extractWiflixBlockStatus,
  isValidDiscordWebhookUrl,
} = require('../wiflixProxyTelemetry');

class InMemoryRedis {
  constructor() {
    this.sortedSets = new Map();
    this.strings = new Map();
  }

  multi() {
    const operations = [];
    const chain = {
      zadd: (...args) => { operations.push(['zadd', args]); return chain; },
      zremrangebyscore: (...args) => { operations.push(['zremrangebyscore', args]); return chain; },
      expire: (...args) => { operations.push(['expire', args]); return chain; },
      exec: async () => {
        const results = [];
        for (const [command, args] of operations) {
          results.push([null, await this[command](...args)]);
        }
        return results;
      },
    };
    return chain;
  }

  async zadd(key, score, member) {
    const values = this.sortedSets.get(key) || [];
    values.push({ score: Number(score), member });
    values.sort((a, b) => a.score - b.score);
    this.sortedSets.set(key, values);
    return 1;
  }

  async zrange(key, start, end, withScores) {
    assert.equal(start, 0);
    assert.equal(end, -1);
    assert.equal(withScores, 'WITHSCORES');
    return (this.sortedSets.get(key) || []).flatMap(({ member, score }) => [member, String(score)]);
  }

  async zremrangebyscore(key, minimum, maximum) {
    const max = Number(maximum);
    const values = this.sortedSets.get(key) || [];
    this.sortedSets.set(key, values.filter(({ score }) => score > max));
    return values.length - (this.sortedSets.get(key)?.length || 0);
  }

  async expire() {
    return 1;
  }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key) {
    return this.strings.delete(key) ? 1 : 0;
  }
}

function fieldsByName(payload) {
  return Object.fromEntries(
    payload.embeds[0].fields.map((field) => [field.name, field.value]),
  );
}

test('Wiflix block telemetry survives recreation and reports persisted request timing', async () => {
  const redis = new InMemoryRedis();
  const sent = [];
  let now = 1_000;
  const options = {
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => now,
    createId: () => `id-${now}`,
    sendWebhook: async (url, payload) => sent.push({ url, payload }),
  };
  const proxyUrl = 'socks5h://user:password@78.105.167.139:46885';

  const beforeRestart = createWiflixProxyTelemetry(options);
  await beforeRestart.recordAttempt(proxyUrl);
  now = 4_000;
  await beforeRestart.recordAttempt(proxyUrl);

  const afterRestart = createWiflixProxyTelemetry(options);
  now = 10_000;
  await afterRestart.recordAttempt(proxyUrl);
  const result = await afterRestart.reportBlocked(proxyUrl, 429, {
    requestKind: 'search',
    targetUrl: 'https://wiflix.example/search?token=secret-value',
  });

  assert.equal(result.notified, true);
  assert.equal(sent.length, 1);
  const serialized = JSON.stringify(sent[0]);
  assert.doesNotMatch(serialized, /user:password|secret-value/);
  const fields = fieldsByName(sent[0].payload);
  assert.equal(fields['Statut HTTP'], '429');
  assert.equal(fields['Requêtes avant blocage'], '3');
  assert.equal(fields['Temps avant blocage'], '9 s');
  assert.equal(fields['Intervalle dernier'], '6 s');
  assert.equal(fields['Intervalle moyen'], '4.5 s');
  assert.equal(fields['Intervalle min / max'], '3 s / 6 s');
  assert.equal(fields['Type'], 'search');
  assert.equal(fields['Cible'], 'https://wiflix.example/search');
});

test('concurrent block reports emit one webhook per proxy during the dedupe window', async () => {
  const redis = new InMemoryRedis();
  let sentCount = 0;
  const telemetry = createWiflixProxyTelemetry({
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => 5_000,
    createId: () => 'request-1',
    sendWebhook: async () => { sentCount += 1; },
  });
  const proxyUrl = 'http://198.51.100.10:8080';

  await telemetry.recordAttempt(proxyUrl);
  const [first, duplicate] = await Promise.all([
    telemetry.reportBlocked(proxyUrl, 403),
    telemetry.reportBlocked(proxyUrl, 403),
  ]);

  assert.equal(sentCount, 1);
  assert.equal([first.notified, duplicate.notified].filter(Boolean).length, 1);
});

test('a failed Discord delivery releases the lock and retains Redis timings for retry', async () => {
  const redis = new InMemoryRedis();
  let sendAttempts = 0;
  const telemetry = createWiflixProxyTelemetry({
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => 7_000,
    createId: () => 'request-1',
    sendWebhook: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error('Discord unavailable');
    },
    logger: { warn() {} },
  });
  const proxyUrl = 'http://198.51.100.20:8080';

  await telemetry.recordAttempt(proxyUrl);
  const failed = await telemetry.reportBlocked(proxyUrl, 403);
  const retried = await telemetry.reportBlocked(proxyUrl, 403);

  assert.equal(failed.notified, false);
  assert.equal(retried.notified, true);
  assert.equal(sendAttempts, 2);
});

test('a Redis cleanup failure after Discord delivery does not duplicate the webhook', async () => {
  class CleanupFailureRedis extends InMemoryRedis {
    cleanupMustFail = false;

    async zremrangebyscore(...args) {
      if (this.cleanupMustFail) throw new Error('Redis cleanup unavailable');
      return super.zremrangebyscore(...args);
    }
  }

  const redis = new CleanupFailureRedis();
  let sentCount = 0;
  const telemetry = createWiflixProxyTelemetry({
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => 7_500,
    createId: () => 'request-1',
    sendWebhook: async () => {
      sentCount += 1;
      redis.cleanupMustFail = true;
    },
    logger: { warn() {} },
  });
  const proxyUrl = 'http://198.51.100.25:8080';

  await telemetry.recordAttempt(proxyUrl);
  const delivered = await telemetry.reportBlocked(proxyUrl, 429);
  const duplicate = await telemetry.reportBlocked(proxyUrl, 429);

  assert.equal(delivered.notified, true);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(sentCount, 1);
});

test('only real Wiflix 403 and 429 responses are classified as blocks', () => {
  assert.equal(extractWiflixBlockStatus({ response: { status: 403 } }), 403);
  assert.equal(extractWiflixBlockStatus({ response: { status: 429 } }), 429);
  assert.equal(extractWiflixBlockStatus({ response: { status: 500 } }), null);
  assert.equal(extractWiflixBlockStatus(new Error('HTTP 429')), null);
});

test('only HTTPS Discord webhook URLs are accepted', () => {
  assert.equal(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123/token'), true);
  assert.equal(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123/token'), false);
  assert.equal(isValidDiscordWebhookUrl('https://example.com/api/webhooks/123/token'), false);
});

test('trackRequest persists an attempt before a rejected upstream request', async () => {
  const redis = new InMemoryRedis();
  const sent = [];
  const telemetry = createWiflixProxyTelemetry({
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => 8_000,
    createId: () => 'rejected-request',
    sendWebhook: async (_url, payload) => sent.push(payload),
  });
  const proxyUrl = 'http://198.51.100.30:8080';
  const blocked = Object.assign(new Error('blocked'), { response: { status: 403 } });

  await assert.rejects(
    telemetry.trackRequest(proxyUrl, async () => { throw blocked; }),
    blocked,
  );
  await telemetry.reportFailure(proxyUrl, blocked, { requestKind: 'page' });

  assert.equal(fieldsByName(sent[0])['Requêtes avant blocage'], '1');
});

test('reportFailure ignores non-blocking HTTP failures', async () => {
  const redis = new InMemoryRedis();
  let sentCount = 0;
  const telemetry = createWiflixProxyTelemetry({
    redis,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    now: () => 9_000,
    createId: () => 'server-error',
    sendWebhook: async () => { sentCount += 1; },
  });

  const result = await telemetry.reportFailure(
    'http://198.51.100.40:8080',
    { response: { status: 500 } },
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, 'not-blocked');
  assert.equal(sentCount, 0);
});
