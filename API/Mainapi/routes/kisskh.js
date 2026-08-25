const express = require('express');
const path = require('node:path');
const { createBundleRegistry } = require('../services/kisskh/bundleRegistry');
const {
  createFallbackCapabilityStore,
  createFallbackDescriptorValidator,
  createKisskhCache,
} = require('../services/kisskh/kisskhCache');
const { createKisskhClient } = require('../services/kisskh/kisskhClient');
const { fromEnv } = require('../services/kisskh/config');
const { KisskhError } = require('../services/kisskh/errors');
const { createKisskhProxyPolicy } = require('../services/kisskh/proxyPolicy');
const { createKisskhResolver, validatePublicProxyOrigin } = require('../services/kisskh/kisskhResolver');

const STATUS_BY_CODE = Object.freeze({
  episode_missing: 404,
  invalid_input: 400,
  not_found: 404,
  provider_changed: 502,
  provider_rate_limited: 429,
  provider_security: 502,
  provider_unavailable: 502,
  proxy_unavailable: 503,
  upstream_unavailable: 502,
});
const GENERIC_NOT_FOUND = Object.freeze({ code: 'not_found', message: 'Ressource introuvable' });
const STARTING_RETRIEVAL_PROGRESS = Object.freeze({
  phase: 'starting', completed: 0, total: null, percent: null,
});
const RETRIEVAL_FAILURE_TTL_MS = 15_000;
const RETRIEVAL_FAILURE_MAX_ENTRIES = 256;
const RETRIEVAL_LOG_MAX_ENTRIES = 256;
const RETRIEVAL_LOG_MAX_EVENTS = 64;

function invalidInput() {
  return new KisskhError('invalid_input', 'Parametre KissKH invalide');
}

function upstreamError() {
  return new KisskhError('upstream_unavailable', 'Lecture KissKH indisponible');
}

function parseCanonicalInteger(value, minimum) {
  if (typeof value !== 'string') throw invalidInput();
  const pattern = minimum === 0 ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) throw invalidInput();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw invalidInput();
  return parsed;
}

function parseTvRequest(params, query) {
  if (!params || typeof params !== 'object' || !query || typeof query !== 'object') throw invalidInput();
  return {
    tmdbId: parseCanonicalInteger(params.tmdbId, 1),
    season: parseCanonicalInteger(query.season, 0),
    episode: parseCanonicalInteger(query.episode, 1),
  };
}

function parseMovieRequest(params) {
  if (!params || typeof params !== 'object') throw invalidInput();
  return {
    tmdbId: parseCanonicalInteger(params.tmdbId, 1),
    season: 0,
    episode: 1,
  };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function publicRetrievalProgress(value) {
  if (!exactKeys(value, ['phase', 'completed', 'total', 'percent'])
      || !['starting', 'catalog', 'finalizing'].includes(value.phase)
      || !Number.isSafeInteger(value.completed) || value.completed < 0
      || (value.total !== null && (!Number.isSafeInteger(value.total) || value.total <= 0))
      || (value.percent !== null && (!Number.isSafeInteger(value.percent)
        || value.percent < 0 || value.percent > 100))) return null;
  if (value.total === null) {
    if (value.completed !== 0 || value.percent !== null) return null;
  } else if (value.completed > value.total
      || value.percent !== Math.floor((value.completed / value.total) * 100)) {
    return null;
  }
  return {
    phase: value.phase,
    completed: value.completed,
    total: value.total,
    percent: value.percent,
  };
}

async function currentRetrievalProgress(resolver) {
  if (typeof resolver?.getRetrievalProgress !== 'function') return null;
  try {
    return publicRetrievalProgress(await resolver.getRetrievalProgress());
  } catch {
    return null;
  }
}

function warmCatalogInBackground(resolver) {
  if (typeof resolver?.warmCatalog !== 'function') return;
  void resolver.warmCatalog().catch(() => {});
}

function safeString(value, maximum = 256) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\r\n\0]/.test(value)) throw upstreamError();
  return value;
}

function proxyDescendant(value, origin) {
  const raw = safeString(value, 4_096);
  let url;
  try { url = new URL(raw); } catch { throw upstreamError(); }
  const sourceUrl = url.searchParams.get('url');
  let source;
  try { source = new URL(sourceUrl); } catch { throw upstreamError(); }
  // Le proxy exige une signature HMAC : la forme attendue est `url,exp,sig`.
  // La forme nue reste tolérée pour le cas dégradé « secret non configuré »,
  // où proxiesembed refusera de toute façon la lecture.
  const params = [...url.searchParams.keys()].sort().join(',');
  if (params !== 'url' && params !== 'exp,sig,url') throw upstreamError();
  if (url.origin !== origin || url.pathname !== '/kisskh-proxy'
      || url.username || url.password || url.hash || !['http:', 'https:'].includes(source.protocol)
      || source.username || source.password || source.hash) {
    throw upstreamError();
  }
  return url.href;
}

function subtitleSource(value) {
  const raw = safeString(value, 8_192);
  let url;
  try { url = new URL(raw); } catch { throw upstreamError(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw upstreamError();
  }
  return url.href;
}

function validateCipher(value, format) {
  if (format === 'srt' && exactKeys(value, ['mode']) && value.mode === 'none') return { mode: 'none' };
  if (format === 'txt1' && exactKeys(value, ['mode', 'scheme'])
      && value.mode === 'unsupported' && value.scheme === 'a2') return { mode: 'unsupported', scheme: 'a2' };
  if (['txt', 'txt2'].includes(format) && exactKeys(value, [
    'ivBase64', 'keyBase64', 'mode', 'padding', 'payloadEncoding',
  ]) && value.mode === 'aes-128-cbc' && value.payloadEncoding === 'base64-per-cue' && value.padding === 'pkcs7') {
    for (const field of ['keyBase64', 'ivBase64']) {
      const material = safeString(value[field], 64);
      const decoded = Buffer.from(material, 'base64');
      if (decoded.length !== 16 || decoded.toString('base64') !== material) throw upstreamError();
    }
    return {
      mode: 'aes-128-cbc',
      keyBase64: value.keyBase64,
      ivBase64: value.ivBase64,
      payloadEncoding: 'base64-per-cue',
      padding: 'pkcs7',
    };
  }
  throw upstreamError();
}

function validatePublicResolution(value, expected, publicOrigin, proxyMedia) {
  if (!exactKeys(value, ['match', 'sources', 'subtitles'])
      || !exactKeys(value.match, ['episode', 'episodeId', 'kisskhDramaId', 'season', 'tmdbId'])
      || value.match.tmdbId !== expected.tmdbId || value.match.season !== expected.season
      || value.match.episode !== expected.episode || !Number.isSafeInteger(value.match.kisskhDramaId)
      || value.match.kisskhDramaId <= 0 || !Number.isSafeInteger(value.match.episodeId) || value.match.episodeId <= 0
      || !Array.isArray(value.sources) || value.sources.length !== 1
      || !Array.isArray(value.subtitles) || value.subtitles.length > 128) throw upstreamError();
  const source = value.sources[0];
  if (!exactKeys(source, ['fallbackToken', 'id', 'label', 'type', 'url'])
      || source.id !== 'kisskh-primary' || source.label !== 'KissKH'
      || !['hls', 'mp4'].includes(source.type)
      || typeof source.fallbackToken !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(source.fallbackToken)) {
    throw upstreamError();
  }
  const subtitles = value.subtitles.map((track) => {
    if (!exactKeys(track, ['cipher', 'format', 'id', 'label', 'lang', 'proxyUrl', 'sourceUrl'])
        || !['srt', 'txt', 'txt1', 'txt2'].includes(track.format)) throw upstreamError();
    return {
      id: safeString(track.id, 128),
      lang: safeString(track.lang, 64),
      label: safeString(track.label, 256),
      format: track.format,
      sourceUrl: subtitleSource(track.sourceUrl),
      proxyUrl: proxyMedia
        ? proxyDescendant(track.proxyUrl, publicOrigin)
        : subtitleSource(track.proxyUrl),
      cipher: validateCipher(track.cipher, track.format),
    };
  });
  return {
    match: { ...value.match },
    sources: [{
      id: 'kisskh-primary',
      label: 'KissKH',
      type: source.type,
      url: proxyMedia
        ? proxyDescendant(source.url, publicOrigin)
        : subtitleSource(source.url),
      fallbackToken: source.fallbackToken,
    }],
    subtitles,
  };
}

function validateFallbackRecord(value, validateDescriptor) {
  try {
    return validateDescriptor(value);
  } catch {
    throw upstreamError();
  }
}

function sendError(res, error, logs) {
  const code = Object.hasOwn(STATUS_BY_CODE, error?.code) ? error.code : 'provider_unavailable';
  const safe = error instanceof KisskhError
    ? { code, message: error.safeMessage }
    : { code, message: 'KissKH indisponible' };
  if (Array.isArray(logs) && logs.length) safe.logs = logs;
  return res.status(STATUS_BY_CODE[code]).json(safe);
}

function createKisskhRouter(deps = {}) {
  const router = express.Router();
  const enabled = deps.enabled === true;
  const publicOrigin = validatePublicProxyOrigin(deps.publicProxyUrl);
  const resolver = deps.resolver;
  const capabilityStore = deps.capabilityStore;
  const proxyPolicy = deps.proxyPolicy;
  const verifyAccessKey = deps.verifyAccessKey;
  const now = deps.now || Date.now;
  const activeRetrievals = new Map();
  const retrievalFailures = new Map();
  const retrievalLogs = new Map();
  const validateFallbackDescriptor = enabled ? createFallbackDescriptorValidator({
    providerBaseUrl: deps.providerBaseUrl,
    now: deps.now,
  }) : null;
  if (enabled && (typeof resolver?.resolveTv !== 'function' || typeof capabilityStore?.consume !== 'function'
      || typeof proxyPolicy?.assertCircuitClosed !== 'function')) throw new TypeError('route KissKH invalide');

  function retrievalKey(mediaType, request) {
    return `${mediaType}:${request.tmdbId}:${request.season}:${request.episode}`;
  }

  function appendRetrievalLog(key, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    let events = retrievalLogs.get(key);
    if (!events) {
      events = [];
    } else {
      retrievalLogs.delete(key);
    }
    retrievalLogs.set(key, events);
    events.push({ ...event, resolutionId: key });
    if (events.length > RETRIEVAL_LOG_MAX_EVENTS) {
      events.splice(0, events.length - RETRIEVAL_LOG_MAX_EVENTS);
    }
    while (retrievalLogs.size > RETRIEVAL_LOG_MAX_ENTRIES) {
      retrievalLogs.delete(retrievalLogs.keys().next().value);
    }
  }

  function currentRetrievalLogs(key) {
    return (retrievalLogs.get(key) || []).map((event) => ({ ...event }));
  }

  function currentRetrievalFailure(key) {
    const failure = retrievalFailures.get(key);
    if (!failure) return null;
    if (now() >= failure.expiresAt) {
      retrievalFailures.delete(key);
      return null;
    }
    return failure.error;
  }

  function rememberRetrievalFailure(key, error) {
    retrievalFailures.delete(key);
    retrievalFailures.set(key, { error, expiresAt: now() + RETRIEVAL_FAILURE_TTL_MS });
    while (retrievalFailures.size > RETRIEVAL_FAILURE_MAX_ENTRIES) {
      retrievalFailures.delete(retrievalFailures.keys().next().value);
    }
  }

  function startBackgroundRetrieval(key, operation, _logMessage, context) {
    const startedAt = now();
    if (activeRetrievals.has(key)) return activeRetrievals.get(key);
    retrievalFailures.delete(key);
    retrievalLogs.delete(key);
    appendRetrievalLog(key, {
      ...context,
      phase: 'background_started',
      elapsedMs: 0,
    });
    const promise = Promise.resolve()
      .then(async () => {
        try {
          await operation((event) => appendRetrievalLog(key, event));
          return { delegated: false };
        } catch (error) {
          if (error?.details?.reason !== 'lock_contended') throw error;
          appendRetrievalLog(key, {
            ...context,
            phase: 'delegated_to_active_worker',
            elapsedMs: Math.max(0, now() - startedAt),
          });
          return { delegated: true };
        }
      })
      .then(({ delegated }) => {
        if (delegated) return;
        retrievalFailures.delete(key);
        appendRetrievalLog(key, {
          ...context,
          phase: 'completed',
          elapsedMs: Math.max(0, now() - startedAt),
        });
      })
      .catch((error) => {
        rememberRetrievalFailure(key, error);
        appendRetrievalLog(key, {
          ...context,
          phase: 'failed',
          elapsedMs: Math.max(0, now() - startedAt),
          code: error?.code || 'provider_unavailable',
          reason: error?.safeMessage || 'KissKH indisponible',
        });
      })
      .finally(() => {
        if (activeRetrievals.get(key) === promise) activeRetrievals.delete(key);
      });
    activeRetrievals.set(key, promise);
    return promise;
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/tv/:tmdbId', async (req, res) => {
    if (!enabled) return sendError(res, new KisskhError('proxy_unavailable', 'KissKH desactive'));
    let parsed;
    try {
      parsed = parseTvRequest(req.params, req.query);
      const accessKey = typeof req.headers['x-access-key'] === 'string'
        ? req.headers['x-access-key']
        : null;
      const vipStatus = typeof verifyAccessKey === 'function'
        ? await verifyAccessKey(accessKey)
        : { vip: false };
      const proxyMedia = vipStatus?.vip === true;
      if (typeof resolver.getCachedTv === 'function' && typeof resolver.warmTv === 'function') {
        const key = retrievalKey('tv', parsed);
        const logContext = { mediaType: 'tv', ...parsed };
        const cached = await resolver.getCachedTv(parsed, { proxyMedia });
        if (!cached) {
          const failure = currentRetrievalFailure(key);
          if (failure) return sendError(res, failure, currentRetrievalLogs(key));
          res.setHeader('Retry-After', '1');
          startBackgroundRetrieval(
            key,
            (onProgress) => resolver.warmTv(parsed, { onProgress }),
            '[KISSKH] background resolution failed',
            logContext,
          );
          return res.status(202).json({
            code: 'retrieval_in_progress',
            message: 'Récupération KissKH en cours',
            progress: await currentRetrievalProgress(resolver) || STARTING_RETRIEVAL_PROGRESS,
            logs: currentRetrievalLogs(key),
          });
        }
        if (!currentRetrievalFailure(key)) {
          startBackgroundRetrieval(
            key,
            (onProgress) => resolver.warmTv(parsed, { onProgress }),
            '[KISSKH] background resolution refresh failed',
            logContext,
          );
        }
        warmCatalogInBackground(resolver);
        return res.json(validatePublicResolution(cached, parsed, publicOrigin, proxyMedia));
      }
      warmCatalogInBackground(resolver);
      const result = await resolver.resolveTv(parsed, { proxyMedia });
      return res.json(validatePublicResolution(result, parsed, publicOrigin, proxyMedia));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/movie/:tmdbId', async (req, res) => {
    if (!enabled) return sendError(res, new KisskhError('proxy_unavailable', 'KissKH desactive'));
    let parsed;
    try {
      parsed = parseMovieRequest(req.params);
      const accessKey = typeof req.headers['x-access-key'] === 'string'
        ? req.headers['x-access-key']
        : null;
      const vipStatus = typeof verifyAccessKey === 'function'
        ? await verifyAccessKey(accessKey)
        : { vip: false };
      const proxyMedia = vipStatus?.vip === true;
      if (typeof resolver.getCachedMovie === 'function' && typeof resolver.warmMovie === 'function') {
        const key = retrievalKey('movie', parsed);
        const logContext = { mediaType: 'movie', ...parsed };
        const cached = await resolver.getCachedMovie(parsed, { proxyMedia });
        if (!cached) {
          const failure = currentRetrievalFailure(key);
          if (failure) return sendError(res, failure, currentRetrievalLogs(key));
          res.setHeader('Retry-After', '1');
          startBackgroundRetrieval(
            key,
            (onProgress) => resolver.warmMovie(parsed, { onProgress }),
            '[KISSKH] background movie resolution failed',
            logContext,
          );
          return res.status(202).json({
            code: 'retrieval_in_progress',
            message: 'Récupération KissKH en cours',
            progress: await currentRetrievalProgress(resolver) || STARTING_RETRIEVAL_PROGRESS,
            logs: currentRetrievalLogs(key),
          });
        }
        if (!currentRetrievalFailure(key)) {
          startBackgroundRetrieval(
            key,
            (onProgress) => resolver.warmMovie(parsed, { onProgress }),
            '[KISSKH] background movie resolution refresh failed',
            logContext,
          );
        }
        warmCatalogInBackground(resolver);
        return res.json(validatePublicResolution(cached, parsed, publicOrigin, proxyMedia));
      }
      warmCatalogInBackground(resolver);
      const result = await resolver.resolveMovie(parsed, { proxyMedia });
      return res.json(validatePublicResolution(result, parsed, publicOrigin, proxyMedia));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/fallback/:token', async (req, res) => {
    if (!enabled) return sendError(res, new KisskhError('proxy_unavailable', 'KissKH desactive'));
    try {
      const record = await capabilityStore.consume(req.params.token);
      if (!record) return res.status(404).json(GENERIC_NOT_FOUND);
      await proxyPolicy.assertCircuitClosed();
      return res.json(validateFallbackRecord(record, validateFallbackDescriptor));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

function runtimeEnvironment(overrides) {
  if (overrides) return overrides;
  return {
    KISSKH_ENABLED: process.env.KISSKH_ENABLED,
    KISSKH_BASE_URL: process.env.KISSKH_BASE_URL,
    KISSKH_ALLOWED_HOSTS: process.env.KISSKH_ALLOWED_HOSTS,
    KISSKH_MEDIA_ALLOWED_HOSTS: process.env.KISSKH_MEDIA_ALLOWED_HOSTS,
    KISSKH_SUBTITLE_ALLOWED_HOSTS: process.env.KISSKH_SUBTITLE_ALLOWED_HOSTS,
    KISSKH_METADATA_TIMEOUT_MS: process.env.KISSKH_METADATA_TIMEOUT_MS,
    KISSKH_METADATA_MAX_ATTEMPTS: process.env.KISSKH_METADATA_MAX_ATTEMPTS,
    KISSKH_PROXY_QUARANTINE_BASE_MS: process.env.KISSKH_PROXY_QUARANTINE_BASE_MS,
    KISSKH_PROXY_QUARANTINE_MAX_MS: process.env.KISSKH_PROXY_QUARANTINE_MAX_MS,
    KISSKH_CIRCUIT_DEFAULT_MS: process.env.KISSKH_CIRCUIT_DEFAULT_MS,
    KISSKH_BUNDLE_CHECK_TTL_SECONDS: process.env.KISSKH_BUNDLE_CHECK_TTL_SECONDS,
    KISSKH_BUNDLE_STALE_MAX_SECONDS: process.env.KISSKH_BUNDLE_STALE_MAX_SECONDS,
    KISSKH_MATCH_TTL_SECONDS: process.env.KISSKH_MATCH_TTL_SECONDS,
    KISSKH_EPISODES_TTL_SECONDS: process.env.KISSKH_EPISODES_TTL_SECONDS,
    KISSKH_EPISODE_SUB_TTL_SECONDS: process.env.KISSKH_EPISODE_SUB_TTL_SECONDS,
    KISSKH_NOT_FOUND_TTL_SECONDS: process.env.KISSKH_NOT_FOUND_TTL_SECONDS,
    KISSKH_RESOLVE_LOCK_MS: process.env.KISSKH_RESOLVE_LOCK_MS,
    KISSKH_FALLBACK_TOKEN_TTL_SECONDS: process.env.KISSKH_FALLBACK_TOKEN_TTL_SECONDS,
    PROXIESEMBED_PUBLIC_URL: process.env.PROXIESEMBED_PUBLIC_URL,
    PROXY_SERVER_URL: process.env.PROXY_SERVER_URL,
  };
}

function resolvePublicProxyUrl(environ) {
  if (environ.PROXIESEMBED_PUBLIC_URL) {
    return validatePublicProxyOrigin(environ.PROXIESEMBED_PUBLIC_URL);
  }
  if (environ.PROXY_SERVER_URL) {
    let sharedUrl;
    try {
      sharedUrl = new URL(environ.PROXY_SERVER_URL);
    } catch {
      throw new TypeError('PROXY_SERVER_URL invalide');
    }
    if (sharedUrl.username || sharedUrl.password || sharedUrl.search || sharedUrl.hash) {
      throw new TypeError('PROXY_SERVER_URL invalide');
    }
    return validatePublicProxyOrigin(sharedUrl.origin);
  }
  return 'http://127.0.0.1:25569';
}

function positiveInteger(environ, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = environ[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)
      || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
    throw new TypeError(`${name} invalide`);
  }
  return Number(raw);
}

function boundedConfigInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} invalide`);
  }
  return value;
}

function parseRuntimeTtls(environ, config) {
  if (!environ || typeof environ !== 'object' || !config || typeof config !== 'object') {
    throw new TypeError('configuration TTL KissKH invalide');
  }
  return Object.freeze({
    bundleCheckTtlSeconds: boundedConfigInteger(
      config.bundleCheckTtlSeconds, 'KISSKH_BUNDLE_CHECK_TTL_SECONDS', 900,
    ),
    bundleStaleMaxSeconds: boundedConfigInteger(
      config.bundleStaleMaxSeconds, 'KISSKH_BUNDLE_STALE_MAX_SECONDS', 86_400,
    ),
    matchTtlSeconds: positiveInteger(environ, 'KISSKH_MATCH_TTL_SECONDS', 86_400, 86_400),
    episodesTtlSeconds: positiveInteger(environ, 'KISSKH_EPISODES_TTL_SECONDS', 21_600, 21_600),
    sensitiveTtlSeconds: positiveInteger(environ, 'KISSKH_EPISODE_SUB_TTL_SECONDS', 600, 600),
    notFoundTtlSeconds: positiveInteger(environ, 'KISSKH_NOT_FOUND_TTL_SECONDS', 900, 900),
    resolveLockMs: positiveInteger(environ, 'KISSKH_RESOLVE_LOCK_MS', 30_000, 30_000),
    fallbackTokenTtlSeconds: positiveInteger(
      environ, 'KISSKH_FALLBACK_TOKEN_TTL_SECONDS', 120, 120,
    ),
  });
}

function hostList(raw, fallback = []) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') throw new TypeError('allowlist KissKH invalide');
  const hosts = raw.split(',');
  if (hosts.some((host) => host !== host.trim() || !host)) throw new TypeError('allowlist KissKH invalide');
  return hosts;
}

function createRuntimeDependencies(deps = {}) {
  const environ = runtimeEnvironment(deps.env);
  const config = fromEnv(environ);
  const ttlOptions = parseRuntimeTtls(environ, config);
  const publicProxyUrl = resolvePublicProxyUrl(environ);
  if (!config.enabled) return { enabled: false, publicProxyUrl };
  const cache = createKisskhCache({
    redis: deps.redis,
    cacheDir: deps.cacheDir || path.join(__dirname, '..', 'cache', 'kisskh'),
    matchTtlSeconds: ttlOptions.matchTtlSeconds,
    episodesTtlSeconds: ttlOptions.episodesTtlSeconds,
    sensitiveTtlSeconds: ttlOptions.sensitiveTtlSeconds,
    notFoundTtlSeconds: ttlOptions.notFoundTtlSeconds,
    resolveLockMs: ttlOptions.resolveLockMs,
    bundleCheckTtlSeconds: ttlOptions.bundleCheckTtlSeconds,
    bundleStaleMaxSeconds: ttlOptions.bundleStaleMaxSeconds,
  });
  const providerBaseUrl = environ.KISSKH_BASE_URL || 'https://kisskh.nl';
  const capabilityStore = createFallbackCapabilityStore({
    redis: deps.redis,
    providerBaseUrl,
    fallbackTokenTtlSeconds: ttlOptions.fallbackTokenTtlSeconds,
  });
  const proxyPolicy = createKisskhProxyPolicy({
    redis: deps.redis,
    pickProxy: deps.pickProxy,
    quarantineBaseMs: positiveInteger(environ, 'KISSKH_PROXY_QUARANTINE_BASE_MS', 30_000),
    quarantineMaxMs: positiveInteger(environ, 'KISSKH_PROXY_QUARANTINE_MAX_MS', 900_000),
    circuitDefaultMs: positiveInteger(environ, 'KISSKH_CIRCUIT_DEFAULT_MS', 60_000),
  });
  const bundleRegistry = createBundleRegistry({
    checkTtlSeconds: ttlOptions.bundleCheckTtlSeconds,
    staleMaxSeconds: ttlOptions.bundleStaleMaxSeconds,
    loadCurrentMetadata: () => cache.getCurrentBundleMetadata(),
  });
  const kisskhClient = createKisskhClient({
    baseUrl: providerBaseUrl,
    allowedHosts: hostList(environ.KISSKH_ALLOWED_HOSTS, ['kisskh.nl']),
    proxyPolicy,
    bundleRegistry,
    request: deps.kisskhRequest,
    timeout: positiveInteger(environ, 'KISSKH_METADATA_TIMEOUT_MS', 10_000),
    maxAttempts: positiveInteger(environ, 'KISSKH_METADATA_MAX_ATTEMPTS', 3),
  });
  const resolver = createKisskhResolver({
    cache,
    capabilityStore,
    bundleRegistry,
    kisskhClient,
    fetchTmdbDetails: deps.fetchTmdbDetails,
    fetchTmdbAlternativeTitles: deps.fetchTmdbAlternativeTitles,
    tmdbApiUrl: deps.tmdbApiUrl,
    tmdbApiKey: deps.tmdbApiKey,
    publicProxyUrl,
  });
  return {
    enabled: true,
    publicProxyUrl,
    providerBaseUrl,
    resolver,
    capabilityStore,
    proxyPolicy,
    verifyAccessKey: deps.verifyAccessKey,
  };
}

let configuredRouter = null;
const exportedRouter = express.Router();
exportedRouter.use((req, res, next) => {
  if (configuredRouter) return configuredRouter(req, res, next);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(503).json({ code: 'proxy_unavailable', message: 'KissKH indisponible' });
});

function configure(deps) {
  configuredRouter = createKisskhRouter(createRuntimeDependencies(deps));
  return exportedRouter;
}

module.exports = exportedRouter;
module.exports.configure = configure;
module.exports.createFallbackCapabilityStore = createFallbackCapabilityStore;
module.exports.createKisskhRouter = createKisskhRouter;
module.exports.createRuntimeDependencies = createRuntimeDependencies;
module.exports.parseTvRequest = parseTvRequest;
module.exports.parseMovieRequest = parseMovieRequest;
module.exports.parseRuntimeTtls = parseRuntimeTtls;
