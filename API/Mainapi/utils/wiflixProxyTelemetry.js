const crypto = require('node:crypto');

const WIFLIX_PROXY_TELEMETRY_PREFIX = 'wiflix:proxy-telemetry';
const WIFLIX_PROXY_TELEMETRY_TTL_SECONDS = 30 * 24 * 60 * 60;
const WIFLIX_PROXY_BLOCK_DEDUPE_SECONDS = 10 * 60;
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);

function isValidDiscordWebhookUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase()) &&
      /^\/api\/webhooks\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function parseProxyIdentity(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
      return null;
    }
    const hostname = parsed.hostname;
    if (!hostname || !parsed.port) return null;
    return {
      hostname,
      endpoint: `${parsed.protocol}//${parsed.host}`,
      fingerprint: crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 24),
    };
  } catch {
    return null;
  }
}

function extractWiflixBlockStatus(error) {
  const status = Number(error?.response?.status ?? error?.wiflixStatus);
  return status === 403 || status === 429 ? status : null;
}

function safeTargetUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'non disponible';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return 'non disponible';
  }
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = Math.round((value / 1000) * 100) / 100;
  return `${seconds} s`;
}

function parseTimestampPairs(rawValues) {
  if (!Array.isArray(rawValues)) return [];
  const timestamps = [];
  for (let index = 1; index < rawValues.length; index += 2) {
    const timestamp = Number(rawValues[index]);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
  }
  return timestamps.sort((a, b) => a - b);
}

function buildTimingMetrics(timestamps, blockedAtMs) {
  const values = timestamps.length > 0 ? timestamps : [blockedAtMs];
  const intervals = values.slice(1).map((value, index) => value - values[index]);
  const elapsedMs = Math.max(0, blockedAtMs - values[0]);
  const averageIntervalMs = intervals.length > 0
    ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
    : 0;
  const requestsPerMinute = elapsedMs > 0
    ? Math.round(((values.length - 1) / (elapsedMs / 60_000)) * 100) / 100
    : values.length;

  return {
    count: values.length,
    firstAtMs: values[0],
    elapsedMs,
    lastIntervalMs: intervals.at(-1) || 0,
    averageIntervalMs,
    minIntervalMs: intervals.length > 0 ? Math.min(...intervals) : 0,
    maxIntervalMs: intervals.length > 0 ? Math.max(...intervals) : 0,
    requestsPerMinute,
  };
}

function buildDiscordPayload({ identity, status, blockedAtMs, metrics, context }) {
  return {
    username: 'Movix Wiflix Monitor',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Proxy Wiflix bloqué — HTTP ${status}`,
      color: status === 429 ? 0xe74c3c : 0xf39c12,
      timestamp: new Date(blockedAtMs).toISOString(),
      fields: [
        { name: 'IP', value: identity.hostname, inline: true },
        { name: 'Proxy', value: identity.endpoint, inline: true },
        { name: 'Statut HTTP', value: String(status), inline: true },
        { name: 'Requêtes avant blocage', value: String(metrics.count), inline: true },
        { name: 'Temps avant blocage', value: formatDuration(metrics.elapsedMs), inline: true },
        { name: 'Débit moyen', value: `${metrics.requestsPerMinute} req/min`, inline: true },
        { name: 'Intervalle dernier', value: formatDuration(metrics.lastIntervalMs), inline: true },
        { name: 'Intervalle moyen', value: formatDuration(metrics.averageIntervalMs), inline: true },
        {
          name: 'Intervalle min / max',
          value: `${formatDuration(metrics.minIntervalMs)} / ${formatDuration(metrics.maxIntervalMs)}`,
          inline: true,
        },
        { name: 'Première requête', value: new Date(metrics.firstAtMs).toISOString(), inline: false },
        { name: 'Type', value: String(context?.requestKind || 'page').slice(0, 100), inline: true },
        { name: 'Cible', value: safeTargetUrl(context?.targetUrl), inline: false },
      ],
    }],
  };
}

function createWiflixProxyTelemetry({
  redis,
  webhookEnabled = true,
  webhookUrl,
  sendWebhook,
  now = Date.now,
  createId = () => crypto.randomUUID(),
  ttlSeconds = WIFLIX_PROXY_TELEMETRY_TTL_SECONDS,
  dedupeSeconds = WIFLIX_PROXY_BLOCK_DEDUPE_SECONDS,
  logger = console,
}) {
  const enabled = webhookEnabled === true
    && isValidDiscordWebhookUrl(webhookUrl)
    && typeof sendWebhook === 'function';

  function keysFor(identity) {
    return {
      attempts: `${WIFLIX_PROXY_TELEMETRY_PREFIX}:${identity.fingerprint}:attempts`,
      blockLock: `${WIFLIX_PROXY_TELEMETRY_PREFIX}:${identity.fingerprint}:block-lock`,
    };
  }

  const telemetry = {
    async recordAttempt(proxyUrl) {
      const identity = parseProxyIdentity(proxyUrl);
      if (!identity || !redis) return false;
      const atMs = Number(now());
      const { attempts } = keysFor(identity);
      try {
        await redis
          .multi()
          .zadd(attempts, atMs, `${atMs}:${createId()}`)
          .zremrangebyscore(attempts, '-inf', atMs - (ttlSeconds * 1000))
          .expire(attempts, ttlSeconds)
          .exec();
        return true;
      } catch {
        return false;
      }
    },

    async reportBlocked(proxyUrl, status, context = {}) {
      const numericStatus = Number(status);
      const identity = parseProxyIdentity(proxyUrl);
      if (!enabled || !identity || !redis || ![403, 429].includes(numericStatus)) {
        return { notified: false, reason: 'disabled-or-invalid' };
      }

      const blockedAtMs = Number(now());
      const { attempts, blockLock } = keysFor(identity);
      let lockAcquired = false;
      try {
        lockAcquired = (
          await redis.set(blockLock, String(blockedAtMs), 'EX', dedupeSeconds, 'NX')
        ) === 'OK';
        if (!lockAcquired) return { notified: false, reason: 'duplicate' };

        const rawTimestamps = await redis.zrange(attempts, 0, -1, 'WITHSCORES');
        const metrics = buildTimingMetrics(
          parseTimestampPairs(rawTimestamps),
          blockedAtMs,
        );
        const payload = buildDiscordPayload({
          identity,
          status: numericStatus,
          blockedAtMs,
          metrics,
          context,
        });

        await sendWebhook(webhookUrl, payload);

        try {
          await redis.zremrangebyscore(attempts, '-inf', blockedAtMs);
        } catch (cleanupError) {
          logger?.warn?.(
            `[WIFLIX TELEMETRY] Nettoyage Redis impossible: ${cleanupError?.message || 'erreur inconnue'}`,
          );
        }
        return { notified: true, metrics };
      } catch (error) {
        if (lockAcquired) {
          try { await redis.del(blockLock); } catch { /* best effort */ }
        }
        logger?.warn?.(`[WIFLIX TELEMETRY] Notification impossible: ${error?.message || 'erreur inconnue'}`);
        return { notified: false, reason: 'delivery-failed' };
      }
    },

    async trackRequest(proxyUrl, request) {
      await telemetry.recordAttempt(proxyUrl);
      return request();
    },

    async reportFailure(proxyUrl, error, context = {}) {
      const status = extractWiflixBlockStatus(error);
      if (!status) return { notified: false, reason: 'not-blocked' };
      return telemetry.reportBlocked(proxyUrl, status, context);
    },
  };

  return telemetry;
}

module.exports = {
  WIFLIX_PROXY_BLOCK_DEDUPE_SECONDS,
  WIFLIX_PROXY_TELEMETRY_TTL_SECONDS,
  buildTimingMetrics,
  createWiflixProxyTelemetry,
  extractWiflixBlockStatus,
  isValidDiscordWebhookUrl,
};
