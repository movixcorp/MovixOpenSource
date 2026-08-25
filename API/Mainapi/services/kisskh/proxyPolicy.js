const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const KEY_PREFIX = 'kisskh:metadata';
const GLOBAL_MIN_INTERVAL_MS = 1;
const PROXY_MIN_INTERVAL_MS = 1000;
const RATE_LIMIT_QUARANTINE_MS = 60_000;
const MAX_PROXY_CANDIDATES = 1000;
const DEFAULT_RESERVATION_DEADLINE_MS = 2000;
const MAX_RESERVATION_DEADLINE_MS = 10_000;
const DEADLINE_EXCEEDED = Symbol('deadline_exceeded');

function normalizeProxyIdentity(proxy) {
  if (typeof proxy === 'string') {
    let parsed;
    try {
      parsed = new URL(proxy.trim());
    } catch {
      throw new TypeError('proxy KissKH invalide');
    }
    const protocol = parsed.protocol.toLowerCase().replace(/:$/, '').replace(/^socks5h$/, 'socks5');
    const port = parsed.port || (protocol === 'https' ? '443' : '80');
    if (!parsed.hostname || !port) throw new TypeError('proxy KissKH invalide');
    return `${protocol}://${parsed.username}:${parsed.password}@${parsed.hostname.toLowerCase()}:${port}`;
  }
  if (!proxy || typeof proxy !== 'object') throw new TypeError('proxy KissKH invalide');
  const protocol = String(proxy.type || 'socks5').toLowerCase().replace(/:$/, '').replace(/^socks5h$/, 'socks5');
  const host = String(proxy.host || '').trim().toLowerCase();
  const port = Number(proxy.port);
  if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError('proxy KissKH invalide');
  }
  return `${protocol}://${String(proxy.auth || '')}@${host}:${port}`;
}

function proxyDigest(proxy) {
  return crypto.createHash('sha256').update(normalizeProxyIdentity(proxy)).digest('hex');
}

function positiveInteger(value, fallback, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new TypeError(`${label} invalide`);
  return selected;
}

function createKisskhProxyPolicy(deps = {}) {
  const redis = deps.redis || require('../../config/redis').redis;
  const proxyManager = !deps.getProxyCandidates || !deps.reserveProxy
    ? require('../../utils/proxyManager')
    : null;
  const getProxyCandidates = deps.getProxyCandidates || proxyManager.getKisskhProxyCandidates;
  const reserveProxy = deps.reserveProxy || proxyManager.reserveKisskhProxy;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadlineNow = deps.deadlineNow || (() => performance.now());
  const maxCandidates = positiveInteger(
    deps.maxCandidates,
    MAX_PROXY_CANDIDATES,
    'maxCandidates',
  );
  const reservationDeadlineMs = positiveInteger(
    deps.reservationDeadlineMs,
    DEFAULT_RESERVATION_DEADLINE_MS,
    'reservationDeadlineMs',
  );
  const quarantineBaseMs = positiveInteger(deps.quarantineBaseMs, 30_000, 'quarantineBaseMs');
  const quarantineMaxMs = positiveInteger(deps.quarantineMaxMs, 900_000, 'quarantineMaxMs');
  if (quarantineMaxMs < quarantineBaseMs || maxCandidates > MAX_PROXY_CANDIDATES
      || reservationDeadlineMs > MAX_RESERVATION_DEADLINE_MS
      || typeof getProxyCandidates !== 'function' || typeof reserveProxy !== 'function'
      || typeof now !== 'function' || typeof sleep !== 'function' || typeof deadlineNow !== 'function') {
    throw new TypeError('policy proxy KissKH invalide');
  }
  const fallback = new Map();
  let globalNextAt = 0;

  async function reserveGlobal() {
    const requestedAt = now();
    const slot = Math.max(requestedAt, globalNextAt);
    globalNextAt = slot + GLOBAL_MIN_INTERVAL_MS;
    const waitMs = slot - requestedAt;
    if (waitMs > 0) await sleep(waitMs);
    return waitMs;
  }

  async function read(key) {
    try {
      const value = await redis?.get?.(key);
      if (value !== null && value !== undefined) return String(value);
    } catch {
      // Le fallback process-local conserve une protection minimale sans Redis.
    }
    return fallback.get(key) ?? null;
  }

  async function readMany(keys) {
    if (!keys.length) return [];
    if (typeof redis?.mget === 'function') {
      try {
        const values = await redis.mget(...keys);
        if (!Array.isArray(values) || values.length !== keys.length) {
          throw new TypeError('reponse Redis KissKH invalide');
        }
        return values.map((value, index) => value ?? fallback.get(keys[index]) ?? null);
      } catch {
        return keys.map((key) => fallback.get(key) ?? null);
      }
    }
    return Promise.all(keys.map((key) => read(key)));
  }

  async function write(key, value, ttlMs) {
    const serialized = String(value);
    fallback.set(key, serialized);
    try {
      await redis?.set?.(key, serialized, 'PX', ttlMs);
    } catch {
      // La copie process-local est deja armee.
    }
  }

  async function remove(...keys) {
    for (const key of keys) fallback.delete(key);
    try {
      await redis?.del?.(...keys);
    } catch {
      // Le fallback process-local est deja nettoye.
    }
  }

  function proxyKeys(proxy) {
    const digest = proxyDigest(proxy);
    return {
      digest,
      failures: `${KEY_PREFIX}:proxy:${digest}:failures`,
      quarantine: `${KEY_PREFIX}:proxy:${digest}:quarantine`,
    };
  }

  async function runBeforeDeadline(operation, deadlineAt) {
    // Promises Redis ne sont pas annulables ici. Apres un timeout, aucun appelant
    // ne lance l'etape suivante; une commande deja envoyee peut seulement terminer.
    const remainingMs = deadlineAt - deadlineNow();
    if (!(remainingMs > 0)) return DEADLINE_EXCEEDED;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function assertCircuitClosed() {
    return true;
  }

  async function reserve() {
    const deadlineAt = deadlineNow() + reservationDeadlineMs;
    const rawCandidates = await runBeforeDeadline(
      () => getProxyCandidates({ maxCandidates }),
      deadlineAt,
    );
    if (rawCandidates === DEADLINE_EXCEEDED) return null;
    if (!Array.isArray(rawCandidates) || rawCandidates.length > maxCandidates) {
      throw new TypeError('candidats proxy KissKH invalides');
    }

    const seen = new Set();
    const candidates = [];
    for (const proxy of rawCandidates) {
      const keys = proxyKeys(proxy);
      if (seen.has(keys.digest)) continue;
      seen.add(keys.digest);
      candidates.push({ proxy, quarantine: keys.quarantine });
    }
    if (!candidates.length) return null;

    const quarantineValues = await runBeforeDeadline(
      () => readMany(candidates.map(({ quarantine }) => quarantine)),
      deadlineAt,
    );
    if (quarantineValues === DEADLINE_EXCEEDED) return null;
    const checkedAt = now();
    const expiredKeys = [];
    const eligible = [];
    candidates.forEach((candidate, index) => {
      const rawExpiry = quarantineValues[index];
      const expiresAt = rawExpiry === null || rawExpiry === undefined ? Number.NaN : Number(rawExpiry);
      if (Number.isFinite(expiresAt) && expiresAt > checkedAt) return;
      if (Number.isFinite(expiresAt)) expiredKeys.push(candidate.quarantine);
      eligible.push(candidate.proxy);
    });
    if (expiredKeys.length) {
      const removed = await runBeforeDeadline(() => remove(...expiredKeys), deadlineAt);
      if (removed === DEADLINE_EXCEEDED) return null;
    }

    for (const proxy of eligible) {
      const reserved = await runBeforeDeadline(
        () => reserveProxy(proxy, { minIntervalMs: PROXY_MIN_INTERVAL_MS }),
        deadlineAt,
      );
      if (reserved === DEADLINE_EXCEEDED) return null;
      if (reserved === true) return proxy;
      if (reserved !== false) {
        throw new TypeError('reservation proxy KissKH invalide');
      }
    }
    return null;
  }

  async function recordFailure(proxy, kind) {
    if (!['timeout', 'transport'].includes(kind)) throw new TypeError('echec proxy KissKH invalide');
    const keys = proxyKeys(proxy);
    const previous = Number(await read(keys.failures));
    const failureCount = Math.min(Number.isSafeInteger(previous) && previous > 0 ? previous + 1 : 1, 31);
    const quarantineMs = Math.min(quarantineMaxMs, quarantineBaseMs * (2 ** (failureCount - 1)));
    const expiresAt = now() + quarantineMs;
    await write(keys.failures, failureCount, quarantineMaxMs * 2);
    await write(keys.quarantine, expiresAt, quarantineMs);
    return quarantineMs;
  }

  async function recordSuccess(proxy) {
    const keys = proxyKeys(proxy);
    await remove(keys.failures, keys.quarantine);
  }

  async function record429(proxy) {
    const keys = proxyKeys(proxy);
    const expiresAt = now() + RATE_LIMIT_QUARANTINE_MS;
    await write(keys.quarantine, expiresAt, RATE_LIMIT_QUARANTINE_MS);
    return expiresAt;
  }

  return Object.freeze({ assertCircuitClosed, record429, recordFailure, recordSuccess, reserve, reserveGlobal });
}

module.exports = { createKisskhProxyPolicy };
