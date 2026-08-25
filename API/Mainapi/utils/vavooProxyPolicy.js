const crypto = require("node:crypto");
const net = require("node:net");

const DEFAULT_VAVOO_LEGAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_VAVOO_NETWORK_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_VAVOO_HTTP_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_VAVOO_HEALTHY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_VAVOO_POLICY_MAX_ENTRIES = 5_000;

function ipv4ToNumber(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result * 256 + octet) >>> 0;
  }
  return result;
}

function isProxyInCidr(proxy, cidr) {
  const [networkAddress, prefixValue] = String(cidr || "").split("/");
  const prefix = Number(prefixValue);
  const hostNumber = ipv4ToNumber(proxy?.host);
  const networkNumber = ipv4ToNumber(networkAddress);

  if (
    hostNumber === null ||
    networkNumber === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (hostNumber & mask) === (networkNumber & mask);
}

function buildProxyIdentity(proxy) {
  if (!proxy?.host || !proxy?.port) return null;
  const rawIdentity = [
    String(proxy.type || "socks5").trim().toLowerCase(),
    String(proxy.host).trim().toLowerCase(),
    String(proxy.port).trim(),
    String(proxy.auth || ""),
  ].join(":");
  return crypto.createHash("sha256").update(rawIdentity).digest("hex");
}

function normalizeDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseVavooProxyJson(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isValidProxyHost(value) {
  const host = String(value || "").trim();
  if (!host || host.length > 253) return false;
  const unwrapped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (net.isIP(unwrapped)) return true;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}

function isUsableVavooSocks5Proxy(proxy) {
  const type = String(proxy?.type || "").trim().toLowerCase().replace(/:$/, "");
  const port = Number(proxy?.port);
  return (
    (type === "socks5" || type === "socks5h") &&
    isValidProxyHost(proxy?.host) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535
  );
}

function createVavooProxyPolicy(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const preferredCidrs = Array.isArray(options.preferredCidrs)
    ? options.preferredCidrs.filter(Boolean)
    : [];
  const legalCooldownMs = normalizeDuration(
    options.legalCooldownMs,
    DEFAULT_VAVOO_LEGAL_COOLDOWN_MS,
  );
  const networkCooldownMs = normalizeDuration(
    options.networkCooldownMs,
    DEFAULT_VAVOO_NETWORK_COOLDOWN_MS,
  );
  const httpCooldownMs = normalizeDuration(
    options.httpCooldownMs,
    DEFAULT_VAVOO_HTTP_COOLDOWN_MS,
  );
  const healthyTtlMs = normalizeDuration(
    options.healthyTtlMs,
    DEFAULT_VAVOO_HEALTHY_TTL_MS,
  );
  const maxEntries = Math.max(
    1,
    Math.floor(
      normalizeDuration(options.maxEntries, DEFAULT_VAVOO_POLICY_MAX_ENTRIES),
    ),
  );
  const stateByProxy = new Map();

  function getState(proxy) {
    const identity = buildProxyIdentity(proxy);
    if (!identity) return null;

    let state = stateByProxy.get(identity);
    if (!state) {
      state = {
        identity,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastFailureStatus: null,
        lastPickedAt: 0,
        lastSuccessAt: 0,
      };
      stateByProxy.set(identity, state);
    }
    return state;
  }

  function pruneStates(activeIdentities) {
    if (stateByProxy.size <= maxEntries) return;

    for (const identity of stateByProxy.keys()) {
      if (!activeIdentities.has(identity)) {
        stateByProxy.delete(identity);
      }
      if (stateByProxy.size <= maxEntries) return;
    }

    const oldest = [...stateByProxy.values()].sort(
      (left, right) =>
        Math.max(left.lastPickedAt, left.lastFailureAt, left.lastSuccessAt) -
        Math.max(right.lastPickedAt, right.lastFailureAt, right.lastSuccessAt),
    );
    for (const state of oldest) {
      stateByProxy.delete(state.identity);
      if (stateByProxy.size <= maxEntries) return;
    }
  }

  function getTier(proxy, state, timestamp) {
    if (
      state.lastSuccessAt > 0 &&
      timestamp - state.lastSuccessAt <= healthyTtlMs
    ) {
      return 0;
    }
    if (preferredCidrs.some((cidr) => isProxyInCidr(proxy, cidr))) return 1;
    if (state.lastFailureAt === 0) return 2;
    return 3;
  }

  function pick(proxies) {
    if (!Array.isArray(proxies) || proxies.length === 0) return null;

    const timestamp = Number(now()) || Date.now();
    const seen = new Set();
    const candidates = [];

    for (const proxy of proxies) {
      const state = getState(proxy);
      if (!state || seen.has(state.identity)) continue;
      seen.add(state.identity);
      if (state.cooldownUntil > timestamp) continue;
      candidates.push({
        proxy,
        state,
        tier: getTier(proxy, state, timestamp),
      });
    }

    pruneStates(seen);
    if (candidates.length === 0) return null;

    candidates.sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier;
      if (left.state.lastPickedAt !== right.state.lastPickedAt) {
        return left.state.lastPickedAt - right.state.lastPickedAt;
      }
      return left.state.identity.localeCompare(right.state.identity);
    });

    const selected = candidates[0];
    selected.state.lastPickedAt = timestamp;
    return selected.proxy;
  }

  function recordSuccess(proxy) {
    const state = getState(proxy);
    if (!state) return false;
    state.cooldownUntil = 0;
    state.lastFailureAt = 0;
    state.lastFailureStatus = null;
    state.lastSuccessAt = Number(now()) || Date.now();
    return true;
  }

  function recordFailure(proxy, status) {
    const state = getState(proxy);
    if (!state) return false;

    const timestamp = Number(now()) || Date.now();
    const normalizedStatus = Number.isInteger(Number(status))
      ? Number(status)
      : null;
    const cooldownMs = normalizedStatus === 451
      ? legalCooldownMs
      : normalizedStatus === null
        ? networkCooldownMs
        : httpCooldownMs;

    state.lastFailureAt = timestamp;
    state.lastFailureStatus = normalizedStatus;
    state.lastSuccessAt = 0;
    state.cooldownUntil = timestamp + cooldownMs;
    return true;
  }

  return {
    pick,
    recordFailure,
    recordSuccess,
  };
}

module.exports = {
  DEFAULT_VAVOO_HEALTHY_TTL_MS,
  DEFAULT_VAVOO_HTTP_COOLDOWN_MS,
  DEFAULT_VAVOO_LEGAL_COOLDOWN_MS,
  DEFAULT_VAVOO_NETWORK_COOLDOWN_MS,
  createVavooProxyPolicy,
  isProxyInCidr,
  isUsableVavooSocks5Proxy,
  parseVavooProxyJson,
};
