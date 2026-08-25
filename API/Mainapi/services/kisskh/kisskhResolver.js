const { KisskhError } = require('./errors');
const {
  analyzeSeasonTitle,
  buildSeasonAwareQueries,
  buildTmdbTitleCandidates,
  regularEpisodeCount,
  rankKisskhCandidates,
  selectEpisodeSegment,
  selectConfirmedDrama,
} = require('./kisskhMatcher');
const { assertMediaType } = require('./kisskhCache');
const { appendSignature, signingConfigured } = require('../../utils/mediaSigning');

const SAFE_CODES = new Set([
  'episode_missing', 'invalid_input', 'not_found', 'provider_changed',
  'provider_rate_limited', 'provider_security', 'provider_unavailable',
  'proxy_unavailable', 'upstream_unavailable',
]);
const KISSKH_ORIGIN = 'https://kisskh.nl';
const KISSKH_REQUIRED_HEADERS = Object.freeze({
  Referer: `${KISSKH_ORIGIN}/`,
  Origin: KISSKH_ORIGIN,
});
// Retour instantane au parcours Search historique : passer cette constante a false.
const USE_ENHANCED_CATALOG_MATCHING = true;
const CATALOG_PAGE_SIZE = 100;
const CATALOG_MAX_ENTRIES = 20_000;
const CATALOG_PAGE_CONCURRENCY = 6;
const MAX_ENRICHED_CANDIDATES = 4;
const EPISODE_ASSET_TIMEOUT_MS = 45_000;

function safeError(code) {
  const messages = {
    episode_missing: 'Episode KissKH introuvable',
    invalid_input: 'Parametre KissKH invalide',
    not_found: 'Correspondance KissKH introuvable',
    provider_changed: 'Version KissKH non approuvee',
    provider_rate_limited: 'KissKH temporairement limite',
    provider_security: 'Donnees KissKH non autorisees',
    provider_unavailable: 'KissKH indisponible',
    proxy_unavailable: 'Service de lecture indisponible',
    upstream_unavailable: 'Lecture KissKH indisponible',
  };
  return new KisskhError(SAFE_CODES.has(code) ? code : 'provider_unavailable',
    messages[code] || messages.provider_unavailable);
}

function assertRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isSafeInteger(value.tmdbId) || value.tmdbId <= 0
      || !Number.isSafeInteger(value.season) || value.season < 0
      || !Number.isSafeInteger(value.episode) || value.episode <= 0) throw safeError('invalid_input');
}

function assertMovieRequest(value) {
  assertRequest(value);
  if (value.season !== 0 || value.episode !== 1) throw safeError('invalid_input');
}

function validatePublicProxyOrigin(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new TypeError('PROXIESEMBED_PUBLIC_URL invalide');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('PROXIESEMBED_PUBLIC_URL invalide'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('PROXIESEMBED_PUBLIC_URL invalide');
  }
  return url.origin;
}

function validateUpstreamUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8_192 || /[\r\n]/.test(value)) {
    throw safeError('provider_security');
  }
  let url;
  try { url = new URL(value); } catch { throw safeError('provider_security'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw safeError('provider_security');
  }
  return url.href;
}

function subtitleFormat(urlValue) {
  const pathname = new URL(urlValue).pathname.toLowerCase();
  const match = pathname.match(/\.([a-z0-9]+)$/);
  if (!match || !['srt', 'txt', 'txt1', 'txt2'].includes(match[1])) throw safeError('provider_security');
  return match[1];
}

function validateAesMaterial(value) {
  if (typeof value !== 'string' || value.length > 64) throw safeError('provider_changed');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 16 || decoded.toString('base64') !== value) throw safeError('provider_changed');
  return value;
}

function cipherFor(format, algorithm) {
  if (format === 'srt') return { mode: 'none' };
  if (format === 'txt1') return { mode: 'unsupported', scheme: 'a2' };
  const scheme = format === 'txt2' ? 'a3' : 'a1';
  return {
    mode: 'aes-128-cbc',
    keyBase64: validateAesMaterial(algorithm?.subtitleCiphers?.[scheme]?.keyBase64),
    ivBase64: validateAesMaterial(algorithm?.subtitleCiphers?.[scheme]?.ivBase64),
    payloadEncoding: 'base64-per-cue',
    padding: 'pkcs7',
  };
}

function normalizedMatch(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.tmdbId !== request.tmdbId || value.season !== request.season || value.episode !== request.episode
      || !Number.isSafeInteger(value.kisskhDramaId) || value.kisskhDramaId <= 0
      || !Number.isSafeInteger(value.episodeId) || value.episodeId <= 0) throw safeError('provider_security');
  return {
    tmdbId: request.tmdbId,
    kisskhDramaId: value.kisskhDramaId,
    episodeId: value.episodeId,
    season: request.season,
    episode: request.episode,
    evidence: {
      score: Number.isFinite(value.evidence?.score) ? value.evidence.score : 100,
      titleSource: ['localized', 'original', 'alternative'].includes(value.evidence?.titleSource)
        ? value.evidence.titleSource : 'localized',
    },
  };
}

function proxyUrl(origin, sourceUrl) {
  const url = new URL('/kisskh-proxy', origin);
  url.searchParams.set('url', sourceUrl);
  // /kisskh-proxy n'accepte plus qu'une URL signée. Sans secret configuré on
  // renvoie l'URL nue : elle sera refusée à la lecture, mais un 403 explicite
  // vaut mieux qu'une exception qui ferait tomber toute la résolution.
  if (!signingConfigured()) {
    console.error('[KISSKH] MEDIA_SIGNING_SECRET absent — URL proxy non signée');
    return url.href;
  }
  return appendSignature(url.href, '/kisskh-proxy', sourceUrl);
}

function mediaType(sourceUrl) {
  return new URL(sourceUrl).pathname.toLowerCase().endsWith('.mp4') ? 'mp4' : 'hls';
}

function normalizeCatalogPage(value, expectedPage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.page !== expectedPage || value.pageSize !== CATALOG_PAGE_SIZE
      || !Number.isSafeInteger(value.totalCount) || value.totalCount <= 0
      || value.totalCount > CATALOG_MAX_ENTRIES
      || !Array.isArray(value.data) || value.data.length > CATALOG_PAGE_SIZE) {
    throw safeError('provider_unavailable');
  }
  return value;
}

function tmdbSeasonEpisodeCount(seasons, seasonNumber) {
  if (!Array.isArray(seasons)) return null;
  const season = seasons.find((entry) => entry?.season_number === seasonNumber);
  return Number.isSafeInteger(season?.episode_count) && season.episode_count > 0
    ? season.episode_count : null;
}

function compatibleDetailedType(mediaNamespace, value) {
  const type = String(value || '').trim().toLowerCase();
  if (mediaNamespace === 'movie') return type !== 'tvseries';
  return type !== 'movie';
}

function distinctSegments(ranked) {
  const seen = new Set();
  return ranked.filter((entry) => {
    const analyzed = analyzeSeasonTitle(entry?.candidate?.title);
    const key = `${analyzed.base}\u0000${analyzed.markers.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createKisskhResolver(deps = {}) {
  const cache = deps.cache;
  const capabilityStore = deps.capabilityStore;
  const bundleRegistry = deps.bundleRegistry;
  const now = deps.now || Date.now;
  const assetTimeoutMs = deps.assetTimeoutMs === undefined
    ? EPISODE_ASSET_TIMEOUT_MS : deps.assetTimeoutMs;
  const publicOrigin = validatePublicProxyOrigin(deps.publicProxyUrl);
  const useEnhancedCatalogMatching = deps.useEnhancedCatalogMatching === undefined
    ? USE_ENHANCED_CATALOG_MATCHING : deps.useEnhancedCatalogMatching;
  if (!cache || typeof cache.singleFlight !== 'function' || typeof capabilityStore?.create !== 'function'
      || typeof bundleRegistry?.resolveApprovedAlgorithm !== 'function'
      || typeof useEnhancedCatalogMatching !== 'boolean' || typeof now !== 'function'
      || !Number.isSafeInteger(assetTimeoutMs) || assetTimeoutMs <= 0
      || assetTimeoutMs > EPISODE_ASSET_TIMEOUT_MS) {
    throw new TypeError('resolver KissKH invalide');
  }

  function resolutionTrace(mediaNamespace, request, startedAt, onProgress) {
    const resolutionId = `${mediaNamespace}:${request.tmdbId}:${request.season}:${request.episode}`;
    return (phase, details = {}) => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({
          resolutionId,
          mediaType: mediaNamespace,
          tmdbId: request.tmdbId,
          season: request.season,
          episode: request.episode,
          phase,
          elapsedMs: Math.max(0, now() - startedAt),
          ...details,
        });
      } catch {
        // Les diagnostics ne doivent jamais interrompre une resolution.
      }
    };
  }

  function providerLogDetails(provider) {
    return {
      kisskhDramaId: provider?.match?.kisskhDramaId,
      episodeId: provider?.match?.episodeId,
      subtitleCount: Array.isArray(provider?.subtitles) ? provider.subtitles.length : 0,
    };
  }

  function logCatalogPhase(trace, phase, details = {}) {
    trace?.(phase, details);
  }

  async function normalizeSensitive(provider, request, mediaNamespace) {
    const match = normalizedMatch(provider.match, request);
    await cache.setMatch(mediaNamespace, request.tmdbId, request.season, {
      tmdbId: request.tmdbId,
      kisskhDramaId: match.kisskhDramaId,
      season: request.season,
      episodeOffset: Number.isSafeInteger(provider.episodeOffset) ? provider.episodeOffset : 0,
      evidence: match.evidence,
    });
    // Ne jamais remplacer la liste complète mise en cache par le seul épisode
    // courant : sinon E1 fonctionne puis E2 devient artificiellement introuvable.
    const cachedEpisodes = await cache.getEpisodes(match.kisskhDramaId);
    if (!cachedEpisodes) {
      await cache.setEpisodes(match.kisskhDramaId, [{ id: match.episodeId, number: request.episode }]);
    }

    const mediaUrl = validateUpstreamUrl(provider.mediaUrl);
    const requiredHeaders = provider.requiredHeaders || KISSKH_REQUIRED_HEADERS;
    const algorithm = await bundleRegistry.resolveApprovedAlgorithm();
    await cache.recordBundleMetadata(algorithm);
    if (!Array.isArray(provider.subtitles) || provider.subtitles.length > 128) throw safeError('provider_security');
    const subtitles = [];
    for (let index = 0; index < provider.subtitles.length; index += 1) {
      const track = provider.subtitles[index];
      if (!track || typeof track !== 'object' || Array.isArray(track)) throw safeError('provider_security');
      const sourceUrl = validateUpstreamUrl(track.src ?? track.url);
      const format = subtitleFormat(sourceUrl);
      const rawLang = typeof (track.land ?? track.lang) === 'string' ? String(track.land ?? track.lang).toLowerCase() : 'und';
      const lang = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(rawLang) ? rawLang : 'und';
      const label = typeof track.label === 'string' && track.label.trim() && track.label.length <= 256
        ? track.label.trim() : lang;
      const id = `kisskh-${lang}-${index + 1}`;
      subtitles.push({ id, lang, label, format, sourceUrl, cipher: cipherFor(format, algorithm) });
    }
    const normalized = { match, mediaUrl, requiredHeaders, subtitles };
    await cache.setSensitive('episode', match.episodeId, { mediaUrl, requiredHeaders });
    await cache.setSensitive('sub', match.episodeId, { subtitles });
    return normalized;
  }

  async function discoverWithProductionClients(request) {
    const { fetchTmdbDetails, fetchTmdbAlternativeTitles, kisskhClient } = deps;
    if (typeof fetchTmdbDetails !== 'function' || typeof fetchTmdbAlternativeTitles !== 'function'
        || !kisskhClient || ['search', 'getDrama', 'getEpisode', 'getSubtitles']
          .some((name) => typeof kisskhClient[name] !== 'function')) throw safeError('provider_unavailable');

    let cachedMatch = await cache.getMatch('tv', request.tmdbId, request.season);
    let episodes = cachedMatch ? await cache.getEpisodes(cachedMatch.kisskhDramaId) : null;
    let evidence = cachedMatch?.evidence;
    if (!cachedMatch || !episodes) {
      const localized = await fetchTmdbDetails(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, 'tv', 'fr-FR');
      const original = await fetchTmdbDetails(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, 'tv', 'en-US');
      const alternatives = await fetchTmdbAlternativeTitles(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId);
      if (!localized || !original || !alternatives) throw safeError('provider_unavailable');
      const titles = buildTmdbTitleCandidates({ localized, original, alternatives });
      const queries = buildSeasonAwareQueries(titles, request.season);
      const candidates = [];
      const seen = new Set();
      for (const query of queries) {
        const results = await kisskhClient.search(query, 0);
        if (!Array.isArray(results)) throw safeError('provider_unavailable');
        for (const candidate of results) {
          if (Number.isSafeInteger(candidate?.id) && candidate.id > 0 && !seen.has(candidate.id)) {
            seen.add(candidate.id);
            candidates.push(candidate);
          }
        }
      }
      const ranked = rankKisskhCandidates({
        titles,
        year: localized.first_air_date,
        countries: localized.origin_country,
        seasonNumber: request.season,
        seasonCount: localized.number_of_seasons,
      }, candidates);
      if (!ranked.length) throw safeError('not_found');
      const top = ranked[0];
      const dramaId = top.candidate.id;
      const drama = await kisskhClient.getDrama(dramaId);
      if (!drama || typeof drama !== 'object') throw safeError('provider_unavailable');
      const selected = selectConfirmedDrama([{ ...top, candidate: { ...drama, id: dramaId } }], request.season, request.episode);
      episodes = selected.drama.episodes.filter((entry) => Number.isSafeInteger(entry?.number) && entry.number > 0);
      evidence = { score: top.score, titleSource: top.titleSource };
      cachedMatch = await cache.setMatch('tv', request.tmdbId, request.season, {
        tmdbId: request.tmdbId,
        kisskhDramaId: dramaId,
        season: request.season,
        evidence,
      });
      episodes = await cache.setEpisodes(dramaId, episodes);
    }
    let episodeEntry = episodes.find((entry) => entry.number === request.episode);
    if (!episodeEntry && cachedMatch) {
      // Une ancienne version écrasait ce cache avec le seul épisode consulté.
      // Rafraîchir une fois depuis KissKH évite un faux episode_missing.
      const refreshedDrama = await kisskhClient.getDrama(cachedMatch.kisskhDramaId);
      if (Array.isArray(refreshedDrama?.episodes)) {
        episodes = refreshedDrama.episodes.filter(
          (entry) => Number.isSafeInteger(entry?.number) && entry.number > 0,
        );
        episodes = await cache.setEpisodes(cachedMatch.kisskhDramaId, episodes);
        episodeEntry = episodes.find((entry) => entry.number === request.episode);
      }
    }
    if (!episodeEntry) {
      throw safeError('episode_missing');
    }
    const match = {
      tmdbId: request.tmdbId,
      kisskhDramaId: cachedMatch.kisskhDramaId,
      episodeId: episodeEntry.id,
      season: request.season,
      episode: request.episode,
      evidence,
    };
    const cachedEpisode = await cache.getSensitive('episode', episodeEntry.id);
    const cachedSub = await cache.getSensitive('sub', episodeEntry.id);
    if (cachedEpisode && cachedSub) return { match, ...cachedEpisode, ...cachedSub };
    const episodePayload = await kisskhClient.getEpisode(episodeEntry.id);
    const subtitles = await kisskhClient.getSubtitles(episodeEntry.id);
    return normalizeSensitive({
      match,
      episodeOffset: request.episode - episodeEntry.number,
      mediaUrl: episodePayload?.Video,
      requiredHeaders: KISSKH_REQUIRED_HEADERS,
      subtitles,
    }, request, 'tv');
  }

  async function discoverMediaWithProductionClientsLegacy(mediaNamespace, request, options = {}) {
    assertMediaType(mediaNamespace);
    const trace = options.trace;
    const { fetchTmdbDetails, fetchTmdbAlternativeTitles, kisskhClient } = deps;
    if (typeof fetchTmdbDetails !== 'function' || typeof fetchTmdbAlternativeTitles !== 'function'
        || !kisskhClient || ['search', 'getDrama', 'getEpisode', 'getSubtitles']
          .some((name) => typeof kisskhClient[name] !== 'function')) throw safeError('provider_unavailable');

    let cachedMatch = await cache.getMatch(mediaNamespace, request.tmdbId, request.season);
    let episodes = cachedMatch ? await cache.getEpisodes(cachedMatch.kisskhDramaId) : null;
    let evidence = cachedMatch?.evidence;
    const cachedEpisodeNumber = cachedMatch ? request.episode - cachedMatch.episodeOffset : request.episode;
    let episodeEntry = episodes?.find((entry) => entry.number === cachedEpisodeNumber) || null;
    trace?.('match_cache_checked', {
      matchCacheHit: Boolean(cachedMatch),
      episodesCacheHit: Boolean(episodes),
      episodeCacheHit: Boolean(episodeEntry),
    });

    if (!cachedMatch || !episodes || !episodeEntry) {
      trace?.('tmdb_metadata_started');
      const [localized, original, alternativePayload] = await Promise.all([
        fetchTmdbDetails(
          deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace, 'fr-FR',
        ),
        fetchTmdbDetails(
          deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace, 'en-US',
        ),
        fetchTmdbAlternativeTitles(
          deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace,
        ),
      ]);
      const alternatives = mediaNamespace === 'movie'
        ? { ...alternativePayload, results: alternativePayload?.titles }
        : alternativePayload;
      if (!localized || !original || !alternatives) throw safeError('provider_unavailable');

      const titles = buildTmdbTitleCandidates({ localized, original, alternatives });
      const queries = mediaNamespace === 'movie'
        ? titles.map((entry) => entry.value)
        : buildSeasonAwareQueries(titles, request.season);
      trace?.('tmdb_metadata_resolved', { titleCount: titles.length, queryCount: queries.length });
      const seasonCount = mediaNamespace === 'movie' ? 1 : localized.number_of_seasons;
      const tmdbSeasons = mediaNamespace === 'movie' ? [] : localized.seasons;
      const expectedEpisodeCount = mediaNamespace === 'movie'
        ? 1 : tmdbSeasonEpisodeCount(tmdbSeasons, request.season);
      const countries = mediaNamespace === 'movie'
        ? (Array.isArray(localized.production_countries) ? localized.production_countries : [])
          .map((entry) => entry?.iso_3166_1 || entry?.name).filter(Boolean)
        : localized.origin_country;
      let selectedResult = null;
      let lastCompatibilityError = null;

      for (let category = 0; category <= 4 && !selectedResult; category += 1) {
        const candidates = [];
        const seen = new Set();
        trace?.('kisskh_search_started', { category, queryCount: queries.length });
        const searchResults = await Promise.all(
          queries.map((query) => kisskhClient.search(query, category)),
        );
        for (const results of searchResults) {
          if (!Array.isArray(results)) throw safeError('provider_unavailable');
          for (const candidate of results) {
            if (Number.isSafeInteger(candidate?.id) && candidate.id > 0 && !seen.has(candidate.id)) {
              seen.add(candidate.id);
              candidates.push(candidate);
            }
          }
        }
        trace?.('kisskh_search_resolved', { category, candidateCount: candidates.length });
        const rankingCriteria = {
          titles,
          year: mediaNamespace === 'movie' ? localized.release_date : localized.first_air_date,
          countries,
          seasonNumber: mediaNamespace === 'movie' ? undefined : request.season,
          seasonCount,
          expectedEpisodeCount,
        };
        let ranked = rankKisskhCandidates(rankingCriteria, candidates);
        if (!ranked.length) continue;
        const detailedDramaById = new Map();
        if (options.regularizeAbsoluteSegments === true
            && Number(seasonCount) <= 1 && ranked.length > 1) {
          const detailedCandidates = await Promise.all(
            ranked.slice(0, MAX_ENRICHED_CANDIDATES).map(async (entry) => {
              const drama = await kisskhClient.getDrama(entry.candidate.id);
              if (!drama || typeof drama !== 'object') throw safeError('provider_unavailable');
              detailedDramaById.set(entry.candidate.id, drama);
              return {
                ...entry.candidate,
                ...drama,
                id: entry.candidate.id,
                episodesCount: regularEpisodeCount(drama.episodes) || entry.candidate.episodesCount,
              };
            }),
          );
          ranked = rankKisskhCandidates(rankingCriteria, detailedCandidates);
          if (!ranked.length) continue;
        }
        const segment = selectEpisodeSegment(ranked, {
          seasonNumber: request.season,
          episodeNumber: request.episode,
          seasonCount: mediaNamespace === 'tv' && request.season === 1 ? 1 : seasonCount,
          tmdbSeasons,
        });
        if (!segment) continue;

        const top = segment.ranked;
        const dramaId = top.candidate.id;
        trace?.('drama_details_started', { dramaId });
        const drama = detailedDramaById.get(dramaId) || await kisskhClient.getDrama(dramaId);
        if (!drama || typeof drama !== 'object') throw safeError('provider_unavailable');
        trace?.('drama_details_resolved', {
          dramaId,
          episodeCount: Array.isArray(drama.episodes) ? drama.episodes.length : 0,
        });
        if (!compatibleDetailedType(mediaNamespace, drama.type)) {
          lastCompatibilityError = 'not_found';
          continue;
        }
        const confirmedTop = rankKisskhCandidates(rankingCriteria, [{
          ...top.candidate,
          ...drama,
          id: dramaId,
        }])[0];
        if (!confirmedTop) {
          lastCompatibilityError = 'not_found';
          continue;
        }
        const markers = analyzeSeasonTitle(drama.title || top.candidate.title).markers;
        const confirmationSeason = Number(seasonCount) <= 1 && markers.length > 0
          ? markers[0]
          : request.season;
        try {
          const selected = selectConfirmedDrama(
            [{ ...confirmedTop, candidate: { ...drama, id: dramaId } }],
            confirmationSeason,
            segment.localEpisodeNumber,
          );
          selectedResult = {
            selected,
            top: confirmedTop,
            dramaId,
            localEpisodeNumber: segment.localEpisodeNumber,
          };
        } catch (error) {
          if (!['not_found', 'episode_missing'].includes(error?.code)) throw error;
          lastCompatibilityError = error.code;
        }
      }
      if (!selectedResult) throw safeError(lastCompatibilityError || 'not_found');

      const { selected, top, dramaId, localEpisodeNumber } = selectedResult;
      episodes = selected.drama.episodes.filter(
        (entry) => Number.isSafeInteger(entry?.number) && entry.number > 0,
      );
      evidence = { score: top.score, titleSource: top.titleSource };
      cachedMatch = await cache.setMatch(mediaNamespace, request.tmdbId, request.season, {
        tmdbId: request.tmdbId,
        kisskhDramaId: dramaId,
        season: request.season,
        episodeOffset: request.episode - localEpisodeNumber,
        evidence,
      });
      episodes = await cache.setEpisodes(dramaId, episodes);
      episodeEntry = selected.episode;
      trace?.('match_resolved', { dramaId, episodeCount: episodes.length });
    }

    if (!episodeEntry) throw safeError('episode_missing');
    const match = {
      tmdbId: request.tmdbId,
      kisskhDramaId: cachedMatch.kisskhDramaId,
      episodeId: episodeEntry.id,
      season: request.season,
      episode: request.episode,
      evidence,
    };
    const cachedEpisode = await cache.getSensitive('episode', episodeEntry.id);
    const cachedSub = await cache.getSensitive('sub', episodeEntry.id);
    if (cachedEpisode && cachedSub) {
      trace?.('episode_assets_cache_hit', {
        episodeId: episodeEntry.id,
        subtitleCount: Array.isArray(cachedSub.subtitles) ? cachedSub.subtitles.length : 0,
      });
      return { match, ...cachedEpisode, ...cachedSub };
    }
    trace?.('episode_assets_started', { episodeId: episodeEntry.id });
    const resolveEpisodeAsset = async (asset, operation) => {
      trace?.(`episode_${asset}_started`, { episodeId: episodeEntry.id });
      try {
        const value = await operation();
        trace?.(`episode_${asset}_resolved`, { episodeId: episodeEntry.id });
        return value;
      } catch (error) {
        trace?.(`episode_${asset}_failed`, {
          episodeId: episodeEntry.id,
          code: SAFE_CODES.has(error?.code) ? error.code : 'provider_unavailable',
          reason: error?.safeMessage || 'KissKH indisponible',
        });
        throw error;
      }
    };
    let timeout;
    const assetDeadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        trace?.('episode_assets_timeout', {
          episodeId: episodeEntry.id,
          timeoutMs: assetTimeoutMs,
        });
        reject(safeError('provider_unavailable'));
      }, assetTimeoutMs);
      timeout.unref?.();
    });
    let episodePayload;
    let subtitles;
    try {
      [episodePayload, subtitles] = await Promise.race([
        Promise.all([
          resolveEpisodeAsset('video', () => kisskhClient.getEpisode(episodeEntry.id)),
          resolveEpisodeAsset('subtitles', () => kisskhClient.getSubtitles(episodeEntry.id)),
        ]),
        assetDeadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    trace?.('episode_assets_resolved', {
      episodeId: episodeEntry.id,
      hasVideo: typeof episodePayload?.Video === 'string' && Boolean(episodePayload.Video),
      subtitleCount: Array.isArray(subtitles) ? subtitles.length : 0,
    });
    return normalizeSensitive({
      match,
      episodeOffset: request.episode - episodeEntry.number,
      mediaUrl: episodePayload?.Video,
      requiredHeaders: KISSKH_REQUIRED_HEADERS,
      subtitles,
    }, request, mediaNamespace);
  }

  async function refreshCatalog(kisskhClient, lease, trace) {
    if (typeof cache.setCatalogProgress === 'function') {
      await cache.setCatalogProgress({ phase: 'starting', completed: 0, total: null, percent: null });
    }
    logCatalogPhase(trace, 'catalog_page_started', { page: 1, pageSize: CATALOG_PAGE_SIZE });
    const first = normalizeCatalogPage(
      await kisskhClient.list(1, CATALOG_PAGE_SIZE, 0),
      1,
    );
    const pages = Math.ceil(first.totalCount / CATALOG_PAGE_SIZE);
    logCatalogPhase(trace, 'catalog_page_resolved', {
      page: 1, pages, itemCount: first.data.length, totalCount: first.totalCount,
    });
    const items = [...first.data];
    let completed = 1;
    const reportProgress = async (phase = 'catalog') => {
      const progress = {
        phase,
        completed,
        total: pages,
        percent: Math.floor((completed / pages) * 100),
      };
      if (typeof cache.setCatalogProgress === 'function') await cache.setCatalogProgress(progress);
      logCatalogPhase(trace, 'catalog_progress', {
        catalogPhase: phase,
        completed,
        total: pages,
        percent: progress.percent,
      });
    };
    await reportProgress();
    for (let start = 2; start <= pages; start += CATALOG_PAGE_CONCURRENCY) {
      const pageNumbers = Array.from(
        { length: Math.min(CATALOG_PAGE_CONCURRENCY, pages - start + 1) },
        (_unused, index) => start + index,
      );
      const payloads = await Promise.all(pageNumbers.map(async (page) => {
        logCatalogPhase(trace, 'catalog_page_started', { page, pageSize: CATALOG_PAGE_SIZE, pages });
        const payload = normalizeCatalogPage(
          await kisskhClient.list(page, CATALOG_PAGE_SIZE, 0),
          page,
        );
        logCatalogPhase(trace, 'catalog_page_resolved', {
          page, pages, itemCount: payload.data.length, totalCount: payload.totalCount,
        });
        return payload;
      }));
      for (const payload of payloads) {
        if (payload.totalCount !== first.totalCount) throw safeError('provider_unavailable');
        items.push(...payload.data);
        completed += 1;
        await reportProgress();
      }
    }
    if (items.length !== first.totalCount) throw safeError('provider_unavailable');
    await reportProgress('finalizing');
    await lease.assertOwned();
    const snapshot = await cache.setCatalogSnapshot(items);
    if (typeof cache.clearCatalogProgress === 'function') await cache.clearCatalogProgress();
    logCatalogPhase(trace, 'catalog_refresh_completed', { itemCount: items.length, pages });
    return snapshot;
  }

  async function catalogItems(kisskhClient, trace) {
    const fresh = await cache.getCatalogSnapshot();
    if (fresh) {
      logCatalogPhase(trace, 'catalog_cache_hit', { itemCount: fresh.items.length, stale: false });
      return fresh.items;
    }
    const stale = await cache.getCatalogSnapshot({ allowStale: true });
    logCatalogPhase(trace, 'catalog_refresh_waiting', {
      staleAvailable: Boolean(stale),
      staleItemCount: stale?.items?.length || 0,
    });
    try {
      const refreshed = await cache.singleFlight(
        'kisskh:lock:catalog-refresh:v1',
        (lease) => refreshCatalog(kisskhClient, lease, trace),
        { lockMs: 60_000, renewEveryMs: 20_000 },
      );
      return refreshed.items;
    } catch (error) {
      logCatalogPhase(trace, 'catalog_refresh_failed', {
        code: SAFE_CODES.has(error?.code) ? error.code : 'provider_unavailable',
        staleAvailable: Boolean(stale),
      });
      if (error?.code === 'provider_rate_limited' || error?.code === 'provider_security') throw error;
      if (stale) {
        return stale.items;
      }
      return null;
    }
  }

  async function discoverCatalogMatch(mediaNamespace, request, trace) {
    const { fetchTmdbDetails, fetchTmdbAlternativeTitles, kisskhClient } = deps;
    if (typeof kisskhClient?.list !== 'function'
        || typeof fetchTmdbDetails !== 'function' || typeof fetchTmdbAlternativeTitles !== 'function') return null;
    trace?.('tmdb_and_catalog_started');
    const [localized, original, alternativePayload, items] = await Promise.all([
      fetchTmdbDetails(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace, 'fr-FR'),
      fetchTmdbDetails(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace, 'en-US'),
      fetchTmdbAlternativeTitles(deps.tmdbApiUrl, deps.tmdbApiKey, request.tmdbId, mediaNamespace),
      catalogItems(kisskhClient, trace),
    ]);
    if (!localized || !original || !alternativePayload || !items) return null;
    const alternatives = mediaNamespace === 'movie'
      ? { ...alternativePayload, results: alternativePayload?.titles }
      : alternativePayload;
    const titles = buildTmdbTitleCandidates({ localized, original, alternatives });
    trace?.('tmdb_and_catalog_resolved', { titleCount: titles.length, catalogItemCount: items.length });
    const seasonCount = mediaNamespace === 'movie' ? 1 : localized.number_of_seasons;
    const tmdbSeasons = mediaNamespace === 'movie' ? [] : localized.seasons;
    const countries = mediaNamespace === 'movie'
      ? (Array.isArray(localized.production_countries) ? localized.production_countries : [])
        .map((entry) => entry?.iso_3166_1 || entry?.name).filter(Boolean)
      : localized.origin_country;
    const expectedEpisodeCount = mediaNamespace === 'movie'
      ? 1 : tmdbSeasonEpisodeCount(tmdbSeasons, request.season);
    const criteria = {
      titles,
      year: mediaNamespace === 'movie' ? localized.release_date : localized.first_air_date,
      countries,
      seasonNumber: mediaNamespace === 'movie' ? undefined : request.season,
      seasonCount,
      expectedEpisodeCount,
    };
    const preliminary = rankKisskhCandidates(
      { ...criteria, retainAmbiguous: true },
      items,
    );
    if (!preliminary.length) return null;
    const enriched = await Promise.all(preliminary.slice(0, MAX_ENRICHED_CANDIDATES).map(async (entry) => {
      const drama = await kisskhClient.getDrama(entry.candidate.id);
      if (!drama || typeof drama !== 'object' || !compatibleDetailedType(mediaNamespace, drama.type)) return null;
      const count = regularEpisodeCount(drama.episodes);
      return {
        ...entry.candidate,
        ...drama,
        id: entry.candidate.id,
        episodesCount: count || entry.candidate.episodesCount,
      };
    }));
    const ranked = distinctSegments(rankKisskhCandidates(criteria, enriched.filter(Boolean)));
    if (!ranked.length) return null;
    const segment = selectEpisodeSegment(ranked, {
      seasonNumber: request.season,
      episodeNumber: request.episode,
      seasonCount: mediaNamespace === 'tv' && request.season === 1 ? 1 : seasonCount,
      tmdbSeasons,
    });
    if (!segment) return null;
    const top = segment.ranked;
    const drama = top.candidate;
    const markers = analyzeSeasonTitle(drama.title).markers;
    const confirmationSeason = Number(seasonCount) <= 1 && markers.length > 0
      ? markers[0] : request.season;
    let selected;
    try {
      selected = selectConfirmedDrama([top], confirmationSeason, segment.localEpisodeNumber);
    } catch (error) {
      if (['not_found', 'episode_missing'].includes(error?.code)) return null;
      throw error;
    }
    const episodes = selected.drama.episodes.filter(
      (entry) => Number.isSafeInteger(entry?.number) && entry.number > 0,
    );
    const evidence = { score: top.score, titleSource: top.titleSource };
    await cache.setMatch(mediaNamespace, request.tmdbId, request.season, {
      tmdbId: request.tmdbId,
      kisskhDramaId: drama.id,
      season: request.season,
      episodeOffset: request.episode - segment.localEpisodeNumber,
      evidence,
    });
    await cache.setEpisodes(drama.id, episodes);
    trace?.('catalog_match_resolved', {
      dramaId: drama.id,
      episodeCount: episodes.length,
      localEpisodeNumber: segment.localEpisodeNumber,
    });
    return true;
  }

  async function discoverMediaWithProductionClients(mediaNamespace, request, trace) {
    if (!useEnhancedCatalogMatching) {
      return discoverMediaWithProductionClientsLegacy(mediaNamespace, request, { trace });
    }
    const cachedMatch = await cache.getMatch(mediaNamespace, request.tmdbId, request.season);
    const cachedEpisodes = cachedMatch ? await cache.getEpisodes(cachedMatch.kisskhDramaId) : null;
    const cachedNumber = cachedMatch ? request.episode - cachedMatch.episodeOffset : request.episode;
    const alreadyCached = cachedEpisodes?.some((entry) => entry.number === cachedNumber);
    if (!alreadyCached) {
      let matched = false;
      try {
        matched = await discoverCatalogMatch(mediaNamespace, request, trace) === true;
      } catch (error) {
        if (error?.code === 'provider_rate_limited' || error?.code === 'provider_security') throw error;
        trace?.('enhanced_catalog_fallback', {
          code: SAFE_CODES.has(error?.code) ? error.code : 'provider_unavailable',
        });
      }
      if (!matched) {
        return discoverMediaWithProductionClientsLegacy(mediaNamespace, request, {
          regularizeAbsoluteSegments: true,
          trace,
        });
      }
    }
    return discoverMediaWithProductionClientsLegacy(mediaNamespace, request, { trace });
  }

  async function prepare(mediaNamespace, request, trace) {
    trace('prepare_started');
    const cachedCode = await cache.getNotFound(mediaNamespace, request.tmdbId, request.season, request.episode);
    if (cachedCode) throw safeError(cachedCode);
    try {
      if (typeof deps.resolveProvider === 'function') {
        trace('provider_started', { providerMode: 'injected' });
        const provider = await normalizeSensitive(
          await deps.resolveProvider(request, { mediaType: mediaNamespace }), request, mediaNamespace,
        );
        trace('provider_resolved', { providerMode: 'injected', ...providerLogDetails(provider) });
        return provider;
      }
      trace('provider_started', { providerMode: 'kisskh' });
      const provider = await discoverMediaWithProductionClients(mediaNamespace, request, trace);
      trace('provider_resolved', { providerMode: 'kisskh', ...providerLogDetails(provider) });
      return provider;
    } catch (error) {
      const code = SAFE_CODES.has(error?.code) ? error.code : 'provider_unavailable';
      trace('provider_failed', {
        code,
        reason: error?.safeMessage || 'KissKH indisponible',
      });
      if (['not_found', 'episode_missing'].includes(code)) {
        await cache.setNotFound(mediaNamespace, request.tmdbId, request.season, request.episode, code);
      }
      throw safeError(code);
    }
  }

  async function providerFor(mediaNamespace, request, options = {}) {
    const cachedCode = await cache.getNotFound(mediaNamespace, request.tmdbId, request.season, request.episode);
    if (cachedCode) throw safeError(cachedCode);
    const startedAt = now();
    const trace = resolutionTrace(mediaNamespace, request, startedAt, options.onProgress);
    const key = `kisskh:lock:resolve:${mediaNamespace}:${request.tmdbId}:${request.season}:${request.episode}`;
    const provider = await cache.singleFlight(key, () => prepare(mediaNamespace, request, trace));
    await cache.setResolution(mediaNamespace, request.tmdbId, request.season, request.episode, provider);
    trace('resolution_cached', providerLogDetails(provider));
    return provider;
  }

  async function makePublicResolution(provider, request, options = {}) {
    const fallbackToken = await capabilityStore.create({
      url: provider.mediaUrl,
      requiredHeaders: provider.requiredHeaders,
    });
    const proxyMedia = options.proxyMedia === true;
    const mediaUrl = proxyMedia ? proxyUrl(publicOrigin, provider.mediaUrl) : provider.mediaUrl;
    let subtitles = provider.subtitles;
    if (subtitles.some((track) => track.format === 'txt2' && track.cipher?.mode !== 'aes-128-cbc')) {
      const algorithm = await bundleRegistry.resolveApprovedAlgorithm();
      subtitles = subtitles.map((track) => track.format === 'txt2' && track.cipher?.mode !== 'aes-128-cbc'
        ? { ...track, cipher: cipherFor('txt2', algorithm) }
        : track);
    }
    return {
      match: {
        tmdbId: request.tmdbId,
        kisskhDramaId: provider.match.kisskhDramaId,
        episodeId: provider.match.episodeId,
        season: request.season,
        episode: request.episode,
      },
      sources: [{
        id: 'kisskh-primary',
        label: 'KissKH',
        type: mediaType(provider.mediaUrl),
        url: mediaUrl,
        fallbackToken,
      }],
      subtitles: subtitles.map((track) => ({
        ...track,
        proxyUrl: proxyMedia ? proxyUrl(publicOrigin, track.sourceUrl) : track.sourceUrl,
      })),
    };
  }

  return Object.freeze({
    async warmCatalog() {
      if (!useEnhancedCatalogMatching || typeof deps.kisskhClient?.list !== 'function') return;
      await catalogItems(deps.kisskhClient);
    },
    async getRetrievalProgress() {
      return typeof cache.getCatalogProgress === 'function' ? cache.getCatalogProgress() : null;
    },
    async getCachedTv(request, options = {}) {
      assertRequest(request);
      const cachedCode = await cache.getNotFound('tv', request.tmdbId, request.season, request.episode);
      if (cachedCode) throw safeError(cachedCode);
      const provider = await cache.getResolution(
        'tv', request.tmdbId, request.season, request.episode, { allowStale: true },
      );
      return provider ? makePublicResolution(provider, request, options) : null;
    },
    async warmTv(request, options = {}) {
      assertRequest(request);
      if (await cache.getResolution('tv', request.tmdbId, request.season, request.episode)) return;
      await providerFor('tv', request, options);
    },
    async resolveTv(request, options = {}) {
      assertRequest(request);
      const cached = await cache.getResolution('tv', request.tmdbId, request.season, request.episode);
      const provider = cached || await providerFor('tv', request, options);
      return makePublicResolution(provider, request, options);
    },
    async getCachedMovie(request, options = {}) {
      assertMovieRequest(request);
      const cachedCode = await cache.getNotFound('movie', request.tmdbId, request.season, request.episode);
      if (cachedCode) throw safeError(cachedCode);
      const provider = await cache.getResolution(
        'movie', request.tmdbId, request.season, request.episode, { allowStale: true },
      );
      return provider ? makePublicResolution(provider, request, options) : null;
    },
    async warmMovie(request, options = {}) {
      assertMovieRequest(request);
      if (await cache.getResolution('movie', request.tmdbId, request.season, request.episode)) return;
      await providerFor('movie', request, options);
    },
    async resolveMovie(request, options = {}) {
      assertMovieRequest(request);
      const cached = await cache.getResolution('movie', request.tmdbId, request.season, request.episode);
      const provider = cached || await providerFor('movie', request, options);
      return makePublicResolution(provider, request, options);
    },
  });
}

module.exports = { createKisskhResolver, validatePublicProxyOrigin };
