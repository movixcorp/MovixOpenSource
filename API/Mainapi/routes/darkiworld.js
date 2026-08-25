/**
 * DarkiWorld routes module.
 * Extracted from server.js — handles DarkiWorld download links, decoding,
 * seasons and episodes retrieval.
 *
 * Mounted at /api/darkiworld  (paths below are relative to that prefix).
 *
 * Under the hydracker freeze (2026-05-15), the list of links and the decode
 * step come exclusively from the local sqlite snapshots under
 * `Mainapi/darkino-backups/`. No outbound calls to hydracker.com are made
 * from this file; the only upstream surface that remains is the seasons
 * metadata endpoints in `/seasons/:titleId` and `/episodes/:titleId/:seasonNumber`.
 *
 * See: docs/superpowers/specs/2026-05-15-hydracker-freeze-sqlite-source-design.md
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const { generateCacheKey } = require('../utils/cacheManager');
const { getPool: getMovixPool } = require('../mysqlPool');
const darkiworldSqlite = require('../utils/darkiworldSqlite');
const hydrackerLiveModule = require('../utils/hydrackerLive');
const { redis: redisClient } = require('../config/redis');
const axios = require('axios');

// IDs to watch — any decode hit on these fires a Discord alert.
const SCRAPER_WATCHLIST = new Set(['17084892']);

// Comma-separated IPs in SCRAPER_BLOCKED_IPS env var get poison 200 on /decode.
// Reload needs restart; use CIDR not supported (exact match only).
function getRequestIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    ''
  );
}

function isBlockedScraper(req) {
  const raw = process.env.SCRAPER_BLOCKED_IPS || '';
  if (!raw) return false;
  const ip = getRequestIp(req);
  return raw.split(',').map(s => s.trim()).includes(ip);
}

function poisonDecodeResponse(id) {
  return {
    success: true,
    id: String(id),
    provider: 'direct',
    embed_url: {
      lien: 'https://t.me/movix_site',
      taille: null,
      created_at: null,
    },
    metadata: { size: null, upload_date: null },
    source: 'mirror',
  };
}

async function fireScraperWebhook(req, id) {
  const webhookUrl = process.env.DISCORD_SCRAPER_WEBHOOK;
  if (!webhookUrl) return;
  const ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const fields = [
    { name: 'ID', value: String(id), inline: true },
    { name: 'title_id', value: String(req.query.title_id || '-'), inline: true },
    { name: 'IP', value: ip, inline: true },
    { name: 'User-Agent', value: String(req.headers['user-agent'] || '-'), inline: false },
    { name: 'Origin', value: String(req.headers['origin'] || '-'), inline: true },
    { name: 'Referer', value: String(req.headers['referer'] || '-'), inline: true },
    { name: 'Sec-Fetch-Site', value: String(req.headers['sec-fetch-site'] || '-'), inline: true },
    { name: 'Sec-Fetch-Mode', value: String(req.headers['sec-fetch-mode'] || '-'), inline: true },
    { name: 'Accept-Language', value: String(req.headers['accept-language'] || '-'), inline: true },
    { name: 'CF-IPCountry', value: String(req.headers['cf-ipcountry'] || '-'), inline: true },
    { name: 'X-Forwarded-For (full)', value: String(req.headers['x-forwarded-for'] || '-'), inline: false },
  ];
  const embed = {
    title: `🔍 Scraper Watch — decode/${id}`,
    color: 0xff4444,
    fields,
    timestamp: new Date().toISOString(),
  };
  try {
    await axios.post(webhookUrl, { embeds: [embed] }, { timeout: 5000 });
  } catch (e) {
    console.warn('[scraperWatch] webhook failed:', e.message);
  }
}

// One-shot boot log: surface live-fallback configuration so operators can
// confirm at process start whether the live path will engage on sqlite miss.
//
// HYDRACKER_LIVE_ENABLED is the master kill-switch for outbound lien fetches.
//   true  → cache+sqlite miss falls through to hydracker.com /api/v1/content/liens
//           (decode) and /api/v1/titles/.../content/liens (list). Those responses
//           already carry the hoster URL, so it is used as-is.
//   false → cache+sqlite are the only sources. Every miss returns sqlite_miss
//           without any outbound HTTP. No new liens are discovered.
(() => {
  const enabled = process.env.HYDRACKER_LIVE_ENABLED === 'true';
  const cookiesLen = (process.env.DARKIWORLD_COOKIES || '').length;
  const xsrfLen = (process.env.DARKIWORLD_XSRF_TOKEN || '').length;
  const timeoutMs = parseInt(process.env.HYDRACKER_LIVE_TIMEOUT_MS, 10) || 20000;
  console.log(
    `[hydrackerLive][boot] enabled=${enabled} ` +
      `mode=${enabled ? 'cache+sqlite+hydracker_live' : 'cache+sqlite_only'} ` +
      `timeout=${timeoutMs}ms cookies_len=${cookiesLen} xsrf_len=${xsrfLen} pid=${process.pid}`,
  );
  if (enabled && cookiesLen === 0) {
    console.warn('[hydrackerLive][boot] DARKIWORLD_COOKIES is empty — every hydracker fetch will return live_hydracker_error');
  }
})();

const HOST_ICON_MAP = {
  '1fichier': '/hosts/1fichier.svg',
  'Mega': '/hosts/mega.svg',
  'Uploaded': '/hosts/uploaded.svg',
  'RapidGator': '/hosts/rapidgator.svg',
  'Google Drive': '/hosts/gdrive.svg',
  'Dropbox': '/hosts/dropbox.svg',
};

// Master kill-switch for outbound lien discovery.
// Returns a configured live instance only when HYDRACKER_LIVE_ENABLED=true.
// When null, both `decode` (resolveLien) and `download` (listLiensForTitle)
// fall back to cache+sqlite only — no new liens are fetched from hydracker.com.
let _hydrackerLive = null;
function getHydrackerLive() {
  if (process.env.HYDRACKER_LIVE_ENABLED !== 'true') return null;
  if (_hydrackerLive) return _hydrackerLive;
  console.log(`[hydrackerLive][init] building live instance on first decode request (pid=${process.pid})`);
  _hydrackerLive = hydrackerLiveModule.createHydrackerLive({
    redis: redisClient,
    axios,
    cookies: process.env.DARKIWORLD_COOKIES || '',
    xsrf: process.env.DARKIWORLD_XSRF_TOKEN || '',
    timeoutMs: parseInt(process.env.HYDRACKER_LIVE_TIMEOUT_MS, 10) || 20000,
    cacheDir: DOWNLOAD_CACHE_DIR,
    cacheGet: (dir, key) => getFromCacheNoExpiration(dir, key),
    cacheSet: (dir, key, val) => saveToCache(dir, key, val),
    cacheKeyFor: (id) => generateCacheKey(`darkiworld_decode_v2_${id}`),
  });
  return _hydrackerLive;
}

async function resolveMovixUsername(userId, authType) {
  try {
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, '');
    const safeUserType = authType === 'bip-39' ? 'bip39' : 'oauth';
    const userPath = path.join(__dirname, '..', 'data', 'users', safeUserType, `${safeUserId}.json`);
    const data = JSON.parse(await fsp.readFile(userPath, 'utf8'));
    if (data.profiles && data.profiles.length > 0) {
      return { username: data.profiles[0].name || 'Admin', avatar: data.profiles[0].avatar || null };
    }
  } catch { /* fall through */ }
  return { username: 'Admin', avatar: null };
}

async function fetchMovixDownloadLinks(type, id, season, episode) {
  const pool = getMovixPool();
  let raw = [];
  if (type === 'movie') {
    const [rows] = await pool.execute('SELECT download_links FROM films WHERE id = ?', [id]);
    raw = rows[0]?.download_links
      ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
      : [];
  } else {
    const seasonNum = Number(season);
    const episodeNum = Number(episode);
    const [episodeRows] = await pool.execute(
      'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
      [id, seasonNum, episodeNum]
    );
    const [seasonRows] = await pool.execute(
      'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = 0',
      [id, seasonNum]
    );
    const parse = (rows) => rows[0]?.download_links
      ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
      : [];
    raw = [...parse(episodeRows), ...parse(seasonRows)];
  }

  const normalized = await Promise.all(raw.map(async (l) => {
    const addedBy = l.added_by || {};
    const userInfo = addedBy.id
      ? await resolveMovixUsername(addedBy.id, addedBy.auth_type)
      : { username: 'Admin', avatar: null };
    const isFullSeason = Boolean(l.full_saison);
    return {
      source: 'movix',
      id: `movix:${l.url}`,
      url: l.url,
      host_id: -1,
      host_name: l.host || 'Movix',
      host_icon: HOST_ICON_MAP[l.host] || null,
      provider: 'movix',
      language: l.language,
      quality: l.quality,
      sub: Boolean(l.sub),
      size: l.size || '',
      full_saison: isFullSeason ? 1 : undefined,
      saison: type === 'tv' ? Number(season) : undefined,
      episode: type === 'tv' ? (isFullSeason ? 0 : Number(episode)) : undefined,
      added_at: l.added_at || null,
      added_by: { username: userInfo.username, avatar: userInfo.avatar },
    };
  }));

  return normalized;
}

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let DARKINO_MAINTENANCE;
let DOWNLOAD_CACHE_DIR;
let getFromCacheNoExpiration;
let saveToCache;
let shouldUpdateCache;
// Seasons routes still use axiosDarkinoRequest + refreshDarkinoSessionIfNeeded.
let axiosDarkinoRequest;
let refreshDarkinoSessionIfNeeded;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.DARKINO_MAINTENANCE !== undefined) DARKINO_MAINTENANCE = deps.DARKINO_MAINTENANCE;
  if (deps.DOWNLOAD_CACHE_DIR) DOWNLOAD_CACHE_DIR = deps.DOWNLOAD_CACHE_DIR;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.shouldUpdateCache) shouldUpdateCache = deps.shouldUpdateCache;
  if (deps.axiosDarkinoRequest) axiosDarkinoRequest = deps.axiosDarkinoRequest;
  if (deps.refreshDarkinoSessionIfNeeded) refreshDarkinoSessionIfNeeded = deps.refreshDarkinoSessionIfNeeded;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLegacySeasonsPage(titleId, page, perPage) {
  const response = await axiosDarkinoRequest({
    method: 'get',
    url: `/api/v1/titles/${titleId}/seasons?perPage=${perPage}&query=&page=${page}`
  });

  return {
    success: true,
    mode: 'legacy',
    ...response.data
  };
}

async function fetchSeasonPageForCount(titleId, seasonNumbers = []) {
  const attemptedSeasonNumbers = new Set();

  for (const rawSeasonNumber of seasonNumbers) {
    const seasonNumber = parsePositiveInt(rawSeasonNumber, null);
    if (!seasonNumber || attemptedSeasonNumbers.has(seasonNumber)) {
      continue;
    }

    attemptedSeasonNumbers.add(seasonNumber);

    try {
      const response = await axiosDarkinoRequest({
        method: 'get',
        url: `/api/v1/titles/${titleId}/seasons/${seasonNumber}?loader=seasonPage`
      });

      const seasonsCount = parsePositiveInt(response.data?.title?.seasons_count, 0);
      if (seasonsCount > 0) {
        return {
          seasonsCount,
          data: response.data
        };
      }
    } catch (_) { /* upstream 404/422 expected, others swallowed */ }
  }

  return null;
}

function buildSyntheticSeasonsResponse(titleId, page, perPage, seasonPagePayload) {
  const currentPage = parsePositiveInt(page, 1);
  const itemsPerPage = parsePositiveInt(perPage, 8);
  const seasonsCount = parsePositiveInt(seasonPagePayload?.title?.seasons_count, 0);
  const selectedSeason = seasonPagePayload?.season || null;
  const selectedSeasonNumber = parsePositiveInt(selectedSeason?.number, 0);
  const lastPage = seasonsCount > 0 ? Math.ceil(seasonsCount / itemsPerPage) : 1;
  const safePage = Math.min(currentPage, lastPage);
  const startIndex = seasonsCount > 0 ? (safePage - 1) * itemsPerPage : 0;

  const allSeasons = Array.from({ length: seasonsCount }, (_, index) => {
    const seasonNumber = index + 1;
    const isSelectedSeason = selectedSeasonNumber === seasonNumber;

    return {
      id: isSelectedSeason && selectedSeason?.id ? selectedSeason.id : seasonNumber,
      poster: isSelectedSeason ? (selectedSeason?.poster || '') : '',
      release_date: isSelectedSeason
        ? (selectedSeason?.release_date || seasonPagePayload?.title?.release_date || '')
        : '',
      number: seasonNumber,
      title_id: isSelectedSeason && selectedSeason?.title_id
        ? selectedSeason.title_id
        : parsePositiveInt(titleId, 0),
      episodes_count: isSelectedSeason
        ? parsePositiveInt(selectedSeason?.episodes_count ?? selectedSeason?.episode_count, 0)
        : 0,
      model_type: isSelectedSeason ? (selectedSeason?.model_type || 'season') : 'season',
      first_episode: isSelectedSeason ? (selectedSeason?.first_episode || null) : null
    };
  });

  const data = allSeasons.slice(startIndex, startIndex + itemsPerPage);
  const from = data.length > 0 ? startIndex + 1 : 0;
  const to = data.length > 0 ? startIndex + data.length : 0;

  return {
    success: true,
    mode: 'seasonPage',
    title: seasonPagePayload?.title || null,
    loader: seasonPagePayload?.loader || 'seasonPage',
    pagination: {
      current_page: safePage,
      data,
      from,
      last_page: lastPage,
      next_page: safePage < lastPage ? safePage + 1 : null,
      per_page: itemsPerPage,
      prev_page: safePage > 1 ? safePage - 1 : null,
      to,
      total: seasonsCount
    }
  };
}

async function fetchSeasonsCountResponse(titleId, page, perPage) {
  let seasonPageResult = await fetchSeasonPageForCount(titleId, [1]);

  if (!seasonPageResult) {
    try {
      const legacyBootstrap = await fetchLegacySeasonsPage(titleId, 1, 1);
      const firstLegacySeasonNumber = legacyBootstrap?.pagination?.data?.[0]?.number;
      seasonPageResult = await fetchSeasonPageForCount(titleId, [firstLegacySeasonNumber]);
    } catch (_) { /* upstream missing, fall through to legacy path */ }
  }

  if (!seasonPageResult) {
    return null;
  }

  return buildSyntheticSeasonsResponse(titleId, page, perPage, seasonPageResult.data);
}

// ---------------------------------------------------------------------------
// GET /download/:type/:id
// Récupérer tous les liens d'amélioration DarkiWorld pour un film ou un épisode
// Params: type (movie/tv), id (TMDB ID)
// Query: season (optionnel pour les séries), episode (optionnel pour les séries)
// ---------------------------------------------------------------------------
router.get('/download/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode, tmdbId } = req.query;

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }
    if (type === 'tv' && (!season || !episode)) {
      return res.status(400).json({ success: false, error: 'Pour les séries, les paramètres season et episode sont requis' });
    }

    const cacheKey = generateCacheKey(
      `darkiworld_download_v2_${type}_${id}${type === 'tv' ? `_${season}_${episode}` : ''}`
    );

    const movixLookupId = tmdbId ? String(tmdbId) : id;
    const movixLinks = await fetchMovixDownloadLinks(type, movixLookupId, season, episode);

    // Disk cache holds the sqlite-derived rows only (sqlite is static so
    // caching forever is safe). Live rows come from a separate Redis-cached
    // layer (titleListCacheTtl ~5min) so they refresh as hydracker keeps
    // adding new liens past the sqlite freeze cutoff.
    let darkiList;
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
    if (cachedData && Array.isArray(cachedData.all)) {
      darkiList = cachedData.all.map((r) => ({ ...r, source: r.source || 'darkiworld' }));
    } else {
      const sqliteList = darkiworldSqlite.listByTitle({
        type,
        titleId: id,
        season: type === 'tv' ? Number(season) : undefined,
        episode: type === 'tv' ? Number(episode) : undefined,
      });
      darkiList = sqliteList.map((r) => ({ ...r, source: 'darkiworld' }));
      // Background disk-cache the sqlite portion. Live portion is NOT
      // persisted to disk — Redis 5min cache + freshness on every request.
      (async () => {
        try {
          if (sqliteList.length > 0) {
            await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, {
              success: true,
              all: sqliteList.map((r) => ({ ...r, source: 'darkiworld' })),
            });
          }
        } catch (_) { /* silent */ }
      })();
    }

    // Live supplement: hydracker keeps adding liens past the sqlite freeze
    // date. Fetch the live listing (Redis-cached 5min) and merge any rows
    // that aren't already in the sqlite result set (dedup by lien id).
    let liveLinks = [];
    const live = getHydrackerLive();
    if (live && typeof live.listLiensForTitle === 'function') {
      try {
        const live0 = Date.now();
        const liveRows = await live.listLiensForTitle(id, {
          type,
          season: type === 'tv' ? Number(season) : undefined,
          episode: type === 'tv' ? Number(episode) : undefined,
        });
        const darkiIds = new Set(darkiList.map((r) => r.id));
        liveLinks = liveRows
          .filter((r) => !darkiIds.has(r.id))
          .map((r) => ({ ...r, source: 'hydracker-live' }));
        console.log(
          `[download] id=${id} type=${type} sqlite=${darkiList.length} ` +
            `live=${liveRows.length} new_from_live=${liveLinks.length} dt=${Date.now() - live0}ms`,
        );
      } catch (e) {
        console.warn(`[download] live listLiensForTitle threw id=${id}: ${e?.message}`);
      }
    }

    return res.status(200).json({
      success: true,
      all: [...movixLinks, ...darkiList, ...liveLinks],
      movixCount: movixLinks.length,
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des liens DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /decode/:id
// Extraire le lien décodé (m3u8) pour un ID de lien DarkiWorld
// Params: id (ID du lien DarkiWorld)
// ---------------------------------------------------------------------------
router.get('/decode/:id', async (req, res) => {
  const t0 = Date.now();
  const { id } = req.params;
  const { title_id, debug: debugQuery } = req.query;
  const debugMode = debugQuery === '1' || debugQuery === 'true';
  const live = getHydrackerLive();
  console.log(
    `[decode] start id=${id} title_id=${title_id || '-'} live_wired=${!!live} ` +
      `pid=${process.pid}`,
  );
  try {
    if (!id) return res.status(400).json({ success: false, error: 'ID du lien requis' });

    if (SCRAPER_WATCHLIST.has(String(id))) {
      fireScraperWebhook(req, id).catch(() => {});
    }

    if (isBlockedScraper(req)) {
      console.log(`[decode] poison id=${id} ip=${getRequestIp(req)}`);
      return res.status(200).json(poisonDecodeResponse(id));
    }

    if (DARKINO_MAINTENANCE) {
      console.log(`[decode] short-circuit maintenance id=${id}`);
      return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
    }

    const result = await darkiworldSqlite.decodeLink(id, {
      cacheDir: DOWNLOAD_CACHE_DIR,
      generateCacheKey,
      getFromCacheNoExpiration,
      saveToCache,
      hydrackerLive: live,
    });

    const dt = Date.now() - t0;
    if (result.payload) {
      console.log(
        `[decode] ok id=${id} provider=${result.payload.provider || '?'} ` +
          `source=${result.payload.source || '?'} host=${result.payload?.metadata?.host || '?'} dt=${dt}ms`,
      );
      if (debugMode) {
        return res.status(200).json({
          ...result.payload,
          _debug: { id, title_id: title_id || null, live_wired: !!live, dt_ms: dt, env_enabled: process.env.HYDRACKER_LIVE_ENABLED === 'true' },
        });
      }
      return res.status(200).json(result.payload);
    }
    if (result.failed) {
      console.log(
        `[decode] failed id=${id} debug=${result.failed.debug || '?'} ` +
          `status=${result.failed.status ?? '-'} dt=${dt}ms`,
      );
      const body = {
        success: false,
        error: result.failed.error || 'Lien non trouvé ou inaccessible',
        id: result.failed.id || id,
        debug: result.failed.debug || '',
      };
      if (debugMode) {
        body._debug = {
          title_id: title_id || null,
          live_wired: !!live,
          dt_ms: dt,
          env_enabled: process.env.HYDRACKER_LIVE_ENABLED === 'true',
          marker_status: result.failed.status ?? null,
          marker_failedAt: result.failed.failedAt ?? null,
        };
      }
      return res.status(404).json(body);
    }
    return res.status(500).json({ success: false, error: 'Unknown decode result' });

  } catch (error) {
    console.error(`[decode] throw id=${id} msg=${error?.message} stack=${error?.stack?.split('\n')[1]?.trim() || '-'}`);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors du décodage du lien DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /seasons/:titleId
// Récupérer les saisons d'une série depuis DarkiWorld
// Params: titleId (ID DarkiWorld de la série)
// Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 8)
// ---------------------------------------------------------------------------
router.get('/seasons/:titleId', async (req, res) => {
  let cacheKey;
  let dataReturned = false;
  try {
    const { titleId } = req.params;
    const { page = 1, perPage = 8, mode = 'auto' } = req.query;

    if (!titleId) {
      return res.status(400).json({
        success: false,
        error: 'ID de la série requis'
      });
    }

    const currentPage = parsePositiveInt(page, 1);
    const itemsPerPage = parsePositiveInt(perPage, 8);
    const normalizedMode = mode === 'legacy' ? 'legacy' : mode === 'seasonPage' ? 'seasonPage' : 'auto';

    // Nouvelle clÃ© de cache pour Ã©viter de ressortir l'ancien format paginÃ©.
    cacheKey = generateCacheKey(`darkiworld_seasons_v2_${normalizedMode}_${titleId}_${currentPage}_${itemsPerPage}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);

    if (cachedData) {
      // console.log(`Saisons pour ${titleId} récupérées du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Récupérer les saisons depuis DarkiWorld
    let responseData = null;

    if (normalizedMode !== 'legacy') {
      responseData = await fetchSeasonsCountResponse(titleId, currentPage, itemsPerPage);
    }

    if (!responseData) {
      responseData = await fetchLegacySeasonsPage(titleId, currentPage, itemsPerPage);
    }

    // Si on n'a pas encore retourné de données, retourner maintenant
    if (!dataReturned) {
      res.json(responseData);
    }

    // Background update du cache
    (async () => {
      try {
        // Vérifier si le cache doit être mis à jour
        const shouldUpdate = await shouldUpdateCache(DOWNLOAD_CACHE_DIR, cacheKey);
        if (!shouldUpdate) {
          return; // Ne pas mettre à jour le cache
        }

        // Si on a des données, sauvegarder dans le cache
        if (responseData && responseData.pagination) {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        }
      } catch (cacheError) {
        // Silent fail on cache save
      }
    })();

  } catch (error) {

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      // Si on a déjà retourné des données (cache), on ne fait RIEN
      if (dataReturned) return;

      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des saisons DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /episodes/:titleId/:seasonNumber
// Récupérer les épisodes d'une saison depuis DarkiWorld
// Params: titleId (ID DarkiWorld de la série), seasonNumber (numéro de la saison: 0, 1, 2, etc.)
// Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 30)
// ---------------------------------------------------------------------------
router.get('/episodes/:titleId/:seasonNumber', async (req, res) => {
  let dataReturned = false;
  try {
    const { titleId, seasonNumber } = req.params;
    const { page = 1, perPage = 30 } = req.query;

    if (!titleId || seasonNumber === undefined) {
      return res.status(400).json({
        success: false,
        error: 'ID de la série et numéro de saison requis'
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(`darkiworld_episodes_${titleId}_${seasonNumber}_${page}_${perPage}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);

    if (cachedData) {
      // console.log(`Épisodes pour ${titleId}/${seasonNumber} récupérés du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Récupérer les épisodes depuis DarkiWorld
    const episodesResponse = await axiosDarkinoRequest({
      method: 'get',
      url: `/api/v1/titles/${titleId}/seasons/${seasonNumber}/episodes?perPage=${perPage}&excludeDescription=true&query=&orderBy=episode_number&orderDir=asc&page=${page}`
    });

    const responseData = {
      success: true,
      ...episodesResponse.data
    };

    // Si on n'a pas encore retourné de données, retourner maintenant
    if (!dataReturned) {
      res.json(responseData);
    }

    // Background update du cache
    (async () => {
      try {
        // Vérifier si le cache doit être mis à jour
        const shouldUpdate = await shouldUpdateCache(DOWNLOAD_CACHE_DIR, cacheKey);
        if (!shouldUpdate) {
          return; // Ne pas mettre à jour le cache
        }

        // Si on a des données, sauvegarder dans le cache
        if (episodesResponse.data && episodesResponse.data.pagination) {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        }
      } catch (cacheError) {
        // Silent fail on cache save
      }
    })();

  } catch (error) {

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      // Si on a déjà retourné des données (cache), on ne fait RIEN
      if (dataReturned) return;

      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des épisodes DarkiWorld',
        message: error.message
      });
    }
  }
});

module.exports = router;
module.exports.configure = configure;
