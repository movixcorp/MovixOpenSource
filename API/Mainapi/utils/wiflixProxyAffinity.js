const WIFLIX_PROXY_REDIS_KEY = 'wiflix:free-proxy:last-success';
const WIFLIX_PROXY_REDIS_TTL_SECONDS = 24 * 60 * 60;

const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function isValidWiflixProxyUrl(proxyUrl) {
  return (
    typeof proxyUrl === 'string' &&
    /^(?:https?|socks5h?):\/\/[^\s]+:\d+$/i.test(proxyUrl.trim())
  );
}

function isSocksWiflixProxyUrl(proxyUrl) {
  return (
    isValidWiflixProxyUrl(proxyUrl) &&
    /^socks5h?:\/\//i.test(proxyUrl.trim())
  );
}

function mergeWiflixProxySources(...sources) {
  const merged = [];
  const seen = new Set();

  for (const source of sources) {
    for (const proxyUrl of Array.isArray(source) ? source : []) {
      if (!isValidWiflixProxyUrl(proxyUrl)) continue;
      const normalized = proxyUrl.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }

  return merged;
}

function redactWiflixProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[proxy invalide]';
  }
}

function createWiflixProxyAffinity({
  redis,
  key = WIFLIX_PROXY_REDIS_KEY,
  ttlSeconds = WIFLIX_PROXY_REDIS_TTL_SECONDS,
}) {
  return {
    async getPreferred() {
      try {
        const proxyUrl = await redis.get(key);
        return isValidWiflixProxyUrl(proxyUrl) ? proxyUrl.trim() : null;
      } catch {
        return null;
      }
    },

    async remember(proxyUrl) {
      if (!isValidWiflixProxyUrl(proxyUrl)) return false;
      try {
        await redis.set(key, proxyUrl.trim(), 'EX', ttlSeconds);
        return true;
      } catch {
        return false;
      }
    },

    async forget(proxyUrl) {
      if (!isValidWiflixProxyUrl(proxyUrl)) return false;
      try {
        const deleted = await redis.eval(
          COMPARE_AND_DELETE_SCRIPT,
          1,
          key,
          proxyUrl.trim(),
        );
        return Number(deleted) > 0;
      } catch {
        return false;
      }
    },
  };
}

function orderWiflixProxyCandidates({
  priorityProxies = [],
  preferred,
  proxies,
  deadProxies,
  maxAttempts,
}) {
  const ordered = [];
  const seen = new Set();
  const limit = Math.max(0, Math.floor(Number(maxAttempts) || 0));

  for (const proxyUrl of [
    ...(Array.isArray(priorityProxies) ? priorityProxies : []),
    preferred,
    ...(Array.isArray(proxies) ? proxies : []),
  ]) {
    if (!isValidWiflixProxyUrl(proxyUrl)) continue;
    const normalized = proxyUrl.trim();
    if (seen.has(normalized) || deadProxies?.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
    if (ordered.length >= limit) break;
  }

  return ordered;
}

async function runWiflixProxyAttempts({
  affinity,
  priorityProxies = [],
  proxies,
  deadProxies,
  maxAttempts,
  attempt,
  onFailure,
}) {
  let preferred = null;
  try {
    preferred = await affinity?.getPreferred?.();
  } catch {
    preferred = null;
  }

  const candidates = orderWiflixProxyCandidates({
    priorityProxies,
    preferred,
    proxies,
    deadProxies,
    maxAttempts,
  });
  let lastError = null;

  for (let index = 0; index < candidates.length; index++) {
    const proxyUrl = candidates[index];
    try {
      const response = await attempt(proxyUrl, index, candidates.length);
      try {
        await affinity?.remember?.(proxyUrl);
      } catch {
        // Redis is best-effort; a cache outage must not discard a good response.
      }
      return {
        response,
        proxyUrl,
        attemptedCount: index + 1,
        candidateCount: candidates.length,
      };
    } catch (error) {
      lastError = error;
      deadProxies?.add(proxyUrl);

      if (proxyUrl === preferred) {
        try {
          await affinity?.forget?.(proxyUrl);
        } catch {
          // Fail open when Redis is unavailable.
        }
      }

      try {
        await onFailure?.(proxyUrl, error);
      } catch {
        // Cleanup hooks must not stop proxy rotation.
      }
    }
  }

  return {
    response: null,
    proxyUrl: null,
    attemptedCount: candidates.length,
    candidateCount: candidates.length,
    lastError,
  };
}

module.exports = {
  WIFLIX_PROXY_REDIS_KEY,
  WIFLIX_PROXY_REDIS_TTL_SECONDS,
  createWiflixProxyAffinity,
  isSocksWiflixProxyUrl,
  isValidWiflixProxyUrl,
  mergeWiflixProxySources,
  orderWiflixProxyCandidates,
  redactWiflixProxyUrl,
  runWiflixProxyAttempts,
};
