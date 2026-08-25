/**
 * Cpasmal route module.
 * Extracted from server.js — handles Cpasmal search, link extraction, and caching.
 *
 * Mounted as: app.use('/api/cpasmal', require('./routes/cpasmal'));
 * Route paths are relative to the mount point.
 */

const express = require('express');
const router = express.Router();
const cheerio = require('cheerio');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');

const { CACHE_DIR, generateCacheKey } = require('../utils/cacheManager');
const { memoryCache } = require('../config/redis');
const { respondWithResolvedSources } = require('../utils/embedExtraction');

// Cpasmal expose la map de langues sous `links` (`{ vf: [...], vostfr: [...] }`),
// et une seule route sert film comme épisode : la même bascule couvre les deux.
const respondWithSources = (req, res, payload) =>
  respondWithResolvedSources(req, res, payload, { movieMapKey: 'links', label: 'CPASMAL' });
const { fetchTmdbDetails } = require('../utils/tmdbCache');
const { acquireRedisLock } = require('../utils/redisLock');

// ---- Lazy-bound dependencies injected via configure() ----
let deps = {
  CPASMAL_BASE_URL: '',
  TMDB_API_URL: '',
  TMDB_API_KEY: '',
  makeCpasmalRequest: async () => { throw new Error('cpasmal not configured'); },
  getFromCacheNoExpiration: async () => null,
  shouldUpdateCache: async () => true
};

/**
 * Toutes les requêtes Cpasmal passent par CycleTLS (JA3 Chrome) : Cloudflare
 * bot-challenge les requêtes axios + proxies datacenter avec un 403 (GET comme
 * POST). makeCpasmalRequest tourne un vrai JA3 Chrome sur le pool ProxyScrape.
 * Adapte la config axios-style { method, url, data, headers } du routeur vers
 * la signature de makeCpasmalRequest et renvoie un objet axios-like { data }.
 */
function _createScopedRequest() {
  return (config) => deps.makeCpasmalRequest(config.url, {
    method: config.method || 'get',
    body: config.data || '',
    headers: config.headers || {},
  });
}

function configure(injected) {
  Object.assign(deps, injected);
}

// ---- Helper: log 403 errors ----
function _log403(context, error) {
  const status = error.response?.status;
  if (status === 403) {
    const proxy = error.cpasmalProxy || 'unknown';
    const url = error.cpasmalUrl || error.config?.url || '';
    console.log(`[Cpasmal] 403 Forbidden — ${context} | proxy=${proxy} | url=${url}`);
  }
}

// ---- Helper functions ----

function hasEmptyLinks(data) {
  if (!data || !data.links) return true;
  const vf = Array.isArray(data.links.vf) ? data.links.vf : [];
  const vostfr = Array.isArray(data.links.vostfr) ? data.links.vostfr : [];
  return vf.length === 0 && vostfr.length === 0;
}

function hasPlayableCpasmalResult(data) {
  return Boolean(data && !data.notFound && !hasEmptyLinks(data));
}

async function saveCpasmalCachePreservingPlayable(cacheKey, candidate) {
  const candidateIsPlayable = hasPlayableCpasmalResult(candidate);
  const candidateIsEmpty = candidate && !candidate.notFound && hasEmptyLinks(candidate);
  const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);
  const lock = await acquireRedisLock(`cpasmal-cache-write:${cacheKey}`, {
    ttl: 10,
    retries: 20,
    retryDelay: 50,
  });

  if (!lock) {
    if (!candidateIsPlayable) {
      console.warn(`[CPASMAL CACHE] Ecriture vide ignoree sans verrou pour ${cacheKey}`);
      return false;
    }
    await fsp.writeFile(cacheFilePath, JSON.stringify(candidate), 'utf-8');
    await memoryCache.set(`${CACHE_DIR.CPASMAL}:${cacheKey}`, candidate);
    return true;
  }

  try {
    if (!candidateIsPlayable) {
      const latestCache = await deps.getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);
      if (hasPlayableCpasmalResult(latestCache)) {
        try {
          const now = new Date();
          await fsp.utimes(cacheFilePath, now, now);
        } catch (error) { /* ignore */ }
        return false;
      }
    }

    await fsp.writeFile(cacheFilePath, JSON.stringify(candidate), 'utf-8');
    await memoryCache.set(`${CACHE_DIR.CPASMAL}:${cacheKey}`, candidate);

    if (candidateIsEmpty) {
      try {
        const oldTime = new Date(Date.now() - 30 * 60 * 1000);
        await fsp.utimes(cacheFilePath, oldTime, oldTime);
      } catch (error) { /* ignore */ }
    }

    return true;
  } finally {
    await lock.release();
  }
}

function sortCpasmalLinks(links) {
  const priority = ['voe', 'uqload'];
  return links.sort((a, b) => {
    const indexA = priority.indexOf(a.server);
    const indexB = priority.indexOf(b.server);

    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return 0;
  });
}

// Helper to get TMDB details (cached via Redis)
async function getTmdbDetails(tmdbId, type) {
  return fetchTmdbDetails(deps.TMDB_API_URL, deps.TMDB_API_KEY, tmdbId, type, 'fr-FR');
}

// Scores search results from a single search query and returns { bestMatch, bestScore }
function _scoreCpasmalResults($, items, title, year, type, normalize) {
  let bestMatch = null;
  let bestScore = -1;

  items.each((i, el) => {
    const $el = $(el);
    const link = $el.find('a.th-img').attr('href');
    const titleText = $el.find('.th-desc .th-capt').text().trim();
    const yearText = $el.find('.th-desc .th-year').text().trim();
    const isSerie = $el.find('.th-Serie').length > 0;
    const isMovie = $el.find('.th-Film').length > 0;

    // Check type - strict filtering
    if (type === 'movie' && !isMovie) return;
    if (type === 'tv' && !isSerie) return;

    const normTitle = normalize(title);
    // Retirer l'annee entre parentheses du titre (deja capturee dans yearText)
    const cleanedTitleText = titleText.replace(/\s*\(\d{4}\)\s*/g, '').trim();
    const normTitleText = normalize(cleanedTitleText);

    // Calculate match score
    let score = 0;
    let titleMatchQuality = 'none';

    // Exact title match (highest priority) - 100 points
    if (normTitleText === normTitle) {
      score += 100;
      titleMatchQuality = 'exact';
    }
    // Title starts with search term (good match)
    else if (normTitleText.startsWith(normTitle + ' ')) {
      const lengthRatio = normTitle.length / normTitleText.length;
      if (lengthRatio >= 0.75) {
        score += 50;
        titleMatchQuality = 'strong';
      } else if (lengthRatio >= 0.60) {
        score += 25;
        titleMatchQuality = 'moderate';
      } else {
        score += 5;
        titleMatchQuality = 'weak';
      }
    }
    // Title ends with search term
    else if (normTitleText.endsWith(' ' + normTitle)) {
      const lengthRatio = normTitle.length / normTitleText.length;
      if (lengthRatio >= 0.75) {
        score += 50;
        titleMatchQuality = 'strong';
      } else if (lengthRatio >= 0.60) {
        score += 25;
        titleMatchQuality = 'moderate';
      } else {
        score += 5;
        titleMatchQuality = 'weak';
      }
    }
    // Search term is contained but not at start/end
    else if (normTitleText.includes(normTitle)) {
      score += 5;
      titleMatchQuality = 'weak';
    }
    // Search term contains the result title
    else if (normTitle.includes(normTitleText)) {
      score += 3;
      titleMatchQuality = 'weak';
    }
    // No match at all - skip
    else {
      return;
    }

    // Year matching bonus points
    if (year && yearText) {
      const yearDiff = Math.abs(parseInt(yearText) - parseInt(year));
      const isWeakTitle = (titleMatchQuality === 'weak');
      if (yearDiff === 0) {
        score += isWeakTitle ? 10 : 50;
      } else if (yearDiff === 1) {
        score += isWeakTitle ? 5 : 20;
      } else if (yearDiff > 5) {
        // Forte penalite: empecher un exact title match avec mauvaise annee de battre
        // un match partiel avec bonne annee (ex: "Magnum" 1980 vs "Magnum, P.I." 2018)
        score -= 100;
      } else {
        score -= 30;
      }
    }

    if (score > bestScore && score > 0) {
      bestScore = score;
      bestMatch = link;
    }
  });

  return { bestMatch, bestScore };
}

// Run a single cpasmal search query across multiple pages, return { bestMatch, bestScore }
async function _runCpasmalSearch(searchQuery, title, year, type, normalize, maxPages, requestFn) {
  const doRequest = requestFn || _createScopedRequest();
  let bestMatch = null;
  let bestScore = -1;
  let page = 1;

  while (page <= maxPages) {
    try {
      // POST form (DLE classic): Cloudflare WAF 403s the GET ?do=search querystring, POST body passes.
      const params = new URLSearchParams();
      params.append('do', 'search');
      params.append('subaction', 'search');
      params.append('search_start', String(page));
      params.append('full_search', '0');
      params.append('story', searchQuery);
      const response = await doRequest({
        method: 'post',
        url: `${deps.CPASMAL_BASE_URL}/index.php`,
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': deps.CPASMAL_BASE_URL,
          'Referer': `${deps.CPASMAL_BASE_URL}/`
        }
      });
      const $ = cheerio.load(response.data);

      const items = $('div.thumb');
      if (items.length === 0) break;

      const result = _scoreCpasmalResults($, items, title, year, type, normalize);
      if (result.bestScore > bestScore) {
        bestScore = result.bestScore;
        bestMatch = result.bestMatch;
      }

      // Only stop early if we have title + year confirmed match
      if (bestScore >= 140) break;

      page++;
    } catch (error) {
      _log403('search', error);
      break;
    }
  }

  return { bestMatch, bestScore };
}

async function searchCpasmal(title, year, type, requestFn) {
  const doRequest = requestFn || _createScopedRequest();
  // Prepare search query: normalize spaces and keep colons
  let searchQuery = title.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  // Normalize function for title comparison
  const normalize = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[:\s\-.,!?'"()]+/g, ' ').replace(/\s+/g, ' ').trim();

  // === Strategy 1: Search by title only (2 pages) ===
  let { bestMatch, bestScore } = await _runCpasmalSearch(searchQuery, title, year, type, normalize, 2, doRequest);

  // === Strategy 2: If no year-confirmed match, retry with "title year" ===
  if (bestScore < 140 && year) {
    const searchQueryWithYear = `${searchQuery} ${year}`;
    const result2 = await _runCpasmalSearch(searchQueryWithYear, title, year, type, normalize, 1, doRequest);
    if (result2.bestScore > bestScore) {
      bestScore = result2.bestScore;
      bestMatch = result2.bestMatch;
    }
  }

  // === Strategy 3: If still no good match, try full_search=1 ===
  if (bestScore < 20) {
    try {
      const params = new URLSearchParams();
      params.append('do', 'search');
      params.append('subaction', 'search');
      params.append('search_start', '1');
      params.append('full_search', '1');
      params.append('story', searchQuery);
      const response = await doRequest({
        method: 'post',
        url: `${deps.CPASMAL_BASE_URL}/index.php`,
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': deps.CPASMAL_BASE_URL,
          'Referer': `${deps.CPASMAL_BASE_URL}/`
        }
      });
      const $ = cheerio.load(response.data);
      const items = $('div.thumb');
      if (items.length > 0) {
        const result3 = _scoreCpasmalResults($, items, title, year, type, normalize);
        if (result3.bestScore > bestScore) {
          bestScore = result3.bestScore;
          bestMatch = result3.bestMatch;
        }
      }
    } catch (error) {
      _log403('full_search', error);
    }
  }

  return bestScore >= 20 ? bestMatch : null;
}

// Helper to extract links from a movie page
async function extractMovieLinks(url, requestFn) {
  const doRequest = requestFn || _createScopedRequest();
  if (process.env.DEBUG_CPASMAL) console.time(`[Cpasmal] ExtractMovieLinks ${url}`);
  try {
    const response = await doRequest({ method: 'get', url: url });
    const $ = cheerio.load(response.data);
    const links = { vf: [], vostfr: [] };
    let cpasmalYear = null;

    // Extraire l'annee de sortie depuis la page cpasmal
    $('article ul li').each((i, el) => {
      const $el = $(el);
      const infoLabel = $el.find('span.info').text().trim().toLowerCase();
      if (infoLabel.includes('date de sortie') || infoLabel.includes('ann\u00e9e') || infoLabel.includes('annee')) {
        const infoValue = $el.find('span.infos').text().trim();
        const yearMatch = infoValue.match(/(\d{4})/);
        if (yearMatch) {
          cpasmalYear = yearMatch[1];
        }
      }
    });

    // Si pas trouve, chercher avec d'autres selecteurs
    if (!cpasmalYear) {
      const infosList = $('div.content-info ul li, div.shortpost-info ul li, .fx-info ul li');
      infosList.each((i, el) => {
        const text = $(el).text().toLowerCase();
        if (text.includes('date de sortie') || text.includes('ann\u00e9e') || text.includes('annee')) {
          const yearMatch = text.match(/(\d{4})/);
          if (yearMatch) {
            cpasmalYear = yearMatch[1];
          }
        }
      });
    }

    const linkElements = $('.liens-c .lien');

    // Collect all tasks first
    const tasks = [];

    for (let i = 0; i < linkElements.length; i++) {
      const el = linkElements[i];
      const onclick = $(el).attr('onclick');
      if (onclick && onclick.includes('getxfield')) {
        const match = onclick.match(/getxfield\('([^']*)',\s*'([^']*)',\s*'([^']*)'\)/);
        if (match) {
          const [_, id, xfield, token] = match;
          const isVostfr = xfield.includes('vostfr');
          const isVf = xfield.includes('vf');

          const ajaxUrl = `${deps.CPASMAL_BASE_URL}/engine/ajax/getxfield.php?id=${id}&xfield=${xfield}&token=${token}`;
          tasks.push({ ajaxUrl, xfield, isVostfr, isVf });
        }
      }
    }

    // Execute requests sequentially
    for (const task of tasks) {
      try {
        const ajaxResponse = await doRequest({ method: 'get', url: task.ajaxUrl });
        const iframeMatch = ajaxResponse.data.match(/src="([^"]+)"/);
        if (iframeMatch) {
          const linkData = { server: task.xfield.split('_')[0], url: iframeMatch[1] };
          if (task.isVostfr) links.vostfr.push(linkData);
          if (task.isVf) links.vf.push(linkData);
        }
      } catch (err) {
        _log403('getxfield', err);
      }
    }

    links.vf = sortCpasmalLinks(links.vf);
    links.vostfr = sortCpasmalLinks(links.vostfr);
    if (process.env.DEBUG_CPASMAL) {
      console.timeEnd(`[Cpasmal] ExtractMovieLinks ${url}`);
      console.log(`[Cpasmal] Found ${links.vf.length} VF and ${links.vostfr.length} VOSTFR links`);
    }
    return { links, cpasmalYear };
  } catch (error) {
    _log403('extractMovieLinks', error);
    return { links: { vf: [], vostfr: [] }, cpasmalYear: null };
  }
}

// Helper to extract links from a series episode
async function extractSeriesLinks(seriesUrl, seasonNumber, episodeNumber, requestFn) {
  const doRequest = requestFn || _createScopedRequest();
  if (process.env.DEBUG_CPASMAL) console.time(`[Cpasmal] ExtractSeriesLinks ${seriesUrl}`);
  try {
    const response = await doRequest({ method: 'get', url: seriesUrl });
    let $ = cheerio.load(response.data);

    // Find season link
    let seasonUrl = null;
    $('.th-seas').each((i, el) => {
      const text = $(el).find('.th-count').text().trim();
      if (text.toLowerCase().includes(`saison ${seasonNumber}`)) {
        seasonUrl = $(el).closest('a').attr('href');
      }
    });

    if (!seasonUrl) {
      return { vf: [], vostfr: [] };
    }

    // Construct episode URL
    const episodeUrl = `${seasonUrl.replace('.html', '')}/${episodeNumber}-episode.html`;

    // Fetch episode page
    const epResponse = await doRequest({ method: 'get', url: episodeUrl });
    $ = cheerio.load(epResponse.data);

    const links = { vf: [], vostfr: [] };
    const linkElements = $('.liens-c .lien');

    // Collect all tasks first
    const tasks = [];

    for (let i = 0; i < linkElements.length; i++) {
      const el = linkElements[i];
      const onclick = $(el).attr('onclick');
      if (onclick && onclick.includes('playEpisode')) {
        const match = onclick.match(/playEpisode\(this,\s*'([^']*)',\s*'([^']*)'\)/);
        if (match) {
          const [_, id, xfield] = match;
          const isVostfr = xfield.includes('vostfr');
          const isVf = xfield.includes('vf');

          const ajaxUrl = `${deps.CPASMAL_BASE_URL}/engine/inc/serial/app/ajax/Season.php`;
          const params = new URLSearchParams();
          params.append('id', id);
          params.append('xfield', xfield);
          params.append('action', 'playEpisode');

          tasks.push({ ajaxUrl, data: params.toString(), xfield, isVostfr, isVf });
        }
      }
    }

    // Execute requests sequentially
    for (const task of tasks) {
      try {
        const ajaxResponse = await doRequest({
          method: 'post',
          url: task.ajaxUrl,
          data: task.data,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        const iframeMatch = ajaxResponse.data.match(/src="([^"]+)"/);
        if (iframeMatch) {
          const linkData = { server: task.xfield.split('_')[0], url: iframeMatch[1] };
          if (task.isVostfr) links.vostfr.push(linkData);
          if (task.isVf) links.vf.push(linkData);
        }
      } catch (err) {
        _log403('playEpisode', err);
      }
    }

    links.vf = sortCpasmalLinks(links.vf);
    links.vostfr = sortCpasmalLinks(links.vostfr);
    if (process.env.DEBUG_CPASMAL) {
      console.timeEnd(`[Cpasmal] ExtractSeriesLinks ${seriesUrl}`);
      console.log(`[Cpasmal] Found ${links.vf.length} VF and ${links.vostfr.length} VOSTFR links`);
    }
    return links;

  } catch (error) {
    _log403('extractSeriesLinks', error);
    return { vf: [], vostfr: [] };
  }
}

// === DATA FETCHING FUNCTIONS ===

async function fetchCpasmalMovieData(tmdbId, throwOnError = true) {
  const requestFn = _createScopedRequest();

  const tmdbData = await getTmdbDetails(tmdbId, 'movie');
  if (!tmdbData) {
    if (throwOnError) throw new Error('Movie not found on TMDB');
    return null;
  }

  const title = tmdbData.title;
  const tmdbYear = tmdbData.release_date ? tmdbData.release_date.split('-')[0] : null;

  const cpasmalUrl = await searchCpasmal(title, tmdbYear, 'movie', requestFn);
  if (!cpasmalUrl) {
    if (throwOnError) throw new Error('Movie not found on Cpasmal');
    return null;
  }
  let { links, cpasmalYear } = await extractMovieLinks(cpasmalUrl, requestFn);
  let finalCpasmalUrl = cpasmalUrl;

  // Validation post-match: reject if year mismatch, retry with explicit year search
  if (cpasmalYear && tmdbYear && cpasmalYear !== tmdbYear) {
    // Retry: search specifically with "title year"
    const normalize = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[:\s\-.,!?'"()]+/g, ' ').replace(/\s+/g, ' ').trim();
    const searchQueryWithYear = `${title.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim()} ${tmdbYear}`;
    const retryResult = await _runCpasmalSearch(searchQueryWithYear, title, tmdbYear, 'movie', normalize, 2, requestFn);

    if (retryResult.bestMatch && retryResult.bestMatch !== cpasmalUrl) {
      const retryExtract = await extractMovieLinks(retryResult.bestMatch, requestFn);
      // Accept if year matches or if year is not available on the page
      if (!retryExtract.cpasmalYear || retryExtract.cpasmalYear === tmdbYear) {
        links = retryExtract.links;
        cpasmalYear = retryExtract.cpasmalYear;
        finalCpasmalUrl = retryResult.bestMatch;
      } else {
        if (throwOnError) throw new Error('Movie not found on Cpasmal (year mismatch)');
        return null;
      }
    } else {
      if (throwOnError) throw new Error('Movie not found on Cpasmal (year mismatch)');
      return null;
    }
  }

  const year = cpasmalYear || tmdbYear;
  return { title, year, cpasmalUrl: finalCpasmalUrl, links };
}

async function fetchCpasmalTvData(tmdbId, season, episode, throwOnError = true) {
  const requestFn = _createScopedRequest();

  const tmdbData = await getTmdbDetails(tmdbId, 'tv');
  if (!tmdbData) {
    if (throwOnError) throw new Error('TV Show not found on TMDB');
    return null;
  }

  const title = tmdbData.name;
  const year = tmdbData.first_air_date ? tmdbData.first_air_date.split('-')[0] : null;

  const cpasmalUrl = await searchCpasmal(title, year, 'tv', requestFn);
  if (!cpasmalUrl) {
    if (throwOnError) throw new Error('TV Show not found on Cpasmal');
    return null;
  }

  // Validation post-match: verifier l'annee sur la page de la serie
  if (year) {
    try {
      const pageResponse = await requestFn({ method: 'get', url: cpasmalUrl });
      const $page = cheerio.load(pageResponse.data);
      let cpasmalYear = null;

      $page('article ul li').each((i, el) => {
        const $el = $page(el);
        const infoLabel = $el.find('span.info').text().trim().toLowerCase();
        if (infoLabel.includes('date de sortie') || infoLabel.includes('ann\u00e9e') || infoLabel.includes('annee')) {
          const infoValue = $el.find('span.infos').text().trim();
          const yearMatch = infoValue.match(/(\d{4})/);
          if (yearMatch) cpasmalYear = yearMatch[1];
        }
      });

      if (!cpasmalYear) {
        const infosList = $page('div.content-info ul li, div.shortpost-info ul li, .fx-info ul li');
        infosList.each((i, el) => {
          const text = $page(el).text().toLowerCase();
          if (text.includes('date de sortie') || text.includes('ann\u00e9e') || text.includes('annee')) {
            const ym = text.match(/(\d{4})/);
            if (ym) cpasmalYear = ym[1];
          }
        });
      }

      if (cpasmalYear && cpasmalYear !== year) {
        console.log(`[CPASMAL TV] Annee non correspondante: TMDB=${year}, Cpasmal=${cpasmalYear} pour "${title}" (${cpasmalUrl})`);
        // Retry avec "title year"
        const normalize = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[:\s\-.,!?'"()]+/g, ' ').replace(/\s+/g, ' ').trim();
        const searchQueryWithYear = `${title.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim()} ${year}`;
        const retryResult = await _runCpasmalSearch(searchQueryWithYear, title, year, 'tv', normalize, 2, requestFn);

        if (retryResult.bestMatch && retryResult.bestMatch !== cpasmalUrl) {
          const links = await extractSeriesLinks(retryResult.bestMatch, season, episode, requestFn);
          return { title, year, cpasmalUrl: retryResult.bestMatch, links };
        } else {
          if (throwOnError) throw new Error('TV Show not found on Cpasmal (year mismatch)');
          return null;
        }
      }
    } catch (error) {
      if (error.message && error.message.includes('year mismatch')) throw error;
      // Erreur de validation non bloquante — continuer normalement
      console.log(`[CPASMAL TV] Erreur lors de la validation d'annee: ${error.message}`);
    }
  }

  const links = await extractSeriesLinks(cpasmalUrl, season, episode, requestFn);
  return { title, year, cpasmalUrl, links };
}

// === CPASMAL REQUEST DEDUPLICATION ===
const ongoingCpasmalRequests = new Map();
const CPASMAL_REQUEST_TIMEOUT = 15000;
const CPASMAL_STALE_CLEANUP_MS = 10 * 60 * 1000;

const getOrCreateCpasmalRequest = async (cacheKey, requestFunction) => {
  if (ongoingCpasmalRequests.has(cacheKey)) {
    const existing = ongoingCpasmalRequests.get(cacheKey);
    let dedupTimer;
    return Promise.race([
      existing.promise.finally(() => clearTimeout(dedupTimer)),
      new Promise((_, reject) => { dedupTimer = setTimeout(() => reject(new Error('Cpasmal dedup timeout')), CPASMAL_REQUEST_TIMEOUT); })
    ]);
  }

  const requestPromise = (async () => {
    let timeoutTimer;
    try {
      const result = await Promise.race([
        requestFunction().finally(() => clearTimeout(timeoutTimer)),
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            ongoingCpasmalRequests.delete(cacheKey);
            reject(new Error('Cpasmal request timeout'));
          }, CPASMAL_REQUEST_TIMEOUT);
        })
      ]);
      return result;
    } finally {
      clearTimeout(timeoutTimer);
      ongoingCpasmalRequests.delete(cacheKey);
    }
  })();

  ongoingCpasmalRequests.set(cacheKey, { promise: requestPromise, createdAt: Date.now() });
  return requestPromise;
};

// Nettoyage périodique des requêtes Cpasmal bloquées
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of ongoingCpasmalRequests) {
    if (entry.createdAt && (now - entry.createdAt > CPASMAL_STALE_CLEANUP_MS)) {
      ongoingCpasmalRequests.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[CPASMAL DEDUP] Nettoyage: ${cleaned} requêtes expirées supprimées`);
}, 5 * 60 * 1000).unref();

// === BACKGROUND UPDATE ===

const updateCpasmalCache = async (cacheKey, type, ...args) => {
  try {
    const shouldUpdate = await deps.shouldUpdateCache(CACHE_DIR.CPASMAL, cacheKey);
    if (!shouldUpdate) {
      return;
    }

    let newData;
    if (type === 'movie') {
      newData = await fetchCpasmalMovieData(args[0], false);
    } else if (type === 'tv') {
      newData = await fetchCpasmalTvData(args[0], args[1], args[2], false);
    }

    const candidate = newData || { notFound: true, timestamp: Date.now() };
    await saveCpasmalCachePreservingPlayable(cacheKey, candidate);
  } catch (error) {
    // silent
  }
};

// ---- Routes ----

router.get('/movie/:tmdbid', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`movie_${tmdbid}`);

  if (process.env.DEBUG_CPASMAL) {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`[Cpasmal API] Start /movie/${tmdbid} - Memory: ${Math.round(used * 100) / 100} MB`);
    console.time(`[Cpasmal API] Total /movie/${tmdbid}`);
  }

  try {
    // 1. Try cache
    const cachedData = await deps.getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);
    if (cachedData) {
      const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);

      if (cachedData.notFound) {
        res.status(404).json({ error: 'Movie not found on Cpasmal (Cached)' });
      } else {
        // Calculer la prochaine mise à jour
        let prochaineMiseAJour = null;
        try {
          const stats = await fsp.stat(cacheFilePath);
          const nextUpdateTime = stats.mtime.getTime() + 40 * 60 * 1000;
          if (nextUpdateTime <= Date.now()) {
            prochaineMiseAJour = 'immédiate';
          } else {
            prochaineMiseAJour = new Date(nextUpdateTime).toISOString();
          }
        } catch (e) { /* ignore */ }
        await respondWithSources(req, res, { ...cachedData, prochaineMiseAJour });
      }

      // Background update if old OR if links are empty
      try {
        const stats = await fsp.stat(cacheFilePath);
        const age = Date.now() - stats.mtime.getTime();
        if (age > 20 * 60 * 1000 || hasEmptyLinks(cachedData)) {
          updateCpasmalCache(cacheKey, 'movie', tmdbid);
        }
      } catch (e) { /* ignore */ }
      return;
    }

    // 2. Fetch fresh with deduplication
    const data = await getOrCreateCpasmalRequest(cacheKey, () => fetchCpasmalMovieData(tmdbid, false));

    if (!data) {
      const notFoundData = { notFound: true, tmdbId: tmdbid, timestamp: Date.now() };
      await saveCpasmalCachePreservingPlayable(cacheKey, notFoundData);
      return res.status(404).json({ error: 'Movie not found on Cpasmal' });
    }

    await saveCpasmalCachePreservingPlayable(cacheKey, data);
    const prochaineMiseAJour = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    await respondWithSources(req, res, { ...data, prochaineMiseAJour });
    if (process.env.DEBUG_CPASMAL) console.timeEnd(`[Cpasmal API] Total /movie/${tmdbid}`);

  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route pour supprimer le cache d'un film cpasmal
router.get('/movie/:tmdbid/clear-cache', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`movie_${tmdbid}`);
  const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    res.json({ success: true, message: `Cache cleared for movie ${tmdbid}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: `No cache found for movie ${tmdbid}` });
    } else {
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

router.get('/tv/:tmdbid/:season/:episode', async (req, res) => {
  const { tmdbid, season, episode } = req.params;
  const cacheKey = generateCacheKey(`tv_${tmdbid}_s${season}_e${episode}`);

  try {
    // 1. Try cache
    const cachedData = await deps.getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);
    if (cachedData) {
      const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);

      if (cachedData.notFound) {
        res.status(404).json({ error: 'TV Show not found on Cpasmal (Cached)' });
      } else {
        // Calculer la prochaine mise à jour
        let prochaineMiseAJour = null;
        try {
          const stats = await fsp.stat(cacheFilePath);
          const nextUpdateTime = stats.mtime.getTime() + 40 * 60 * 1000;
          if (nextUpdateTime <= Date.now()) {
            prochaineMiseAJour = 'immédiate';
          } else {
            prochaineMiseAJour = new Date(nextUpdateTime).toISOString();
          }
        } catch (e) { /* ignore */ }
        await respondWithSources(req, res, { ...cachedData, prochaineMiseAJour });
      }

      // Background update if old OR if links are empty
      try {
        const stats = await fsp.stat(cacheFilePath);
        const age = Date.now() - stats.mtime.getTime();
        if (age > 20 * 60 * 1000 || hasEmptyLinks(cachedData)) {
          updateCpasmalCache(cacheKey, 'tv', tmdbid, season, episode);
        }
      } catch (e) { /* ignore */ }
      return;
    }

    // 2. Fetch fresh with deduplication
    const data = await getOrCreateCpasmalRequest(cacheKey, () => fetchCpasmalTvData(tmdbid, season, episode, false));

    if (!data) {
      const notFoundData = { notFound: true, tmdbId: tmdbid, season, episode, timestamp: Date.now() };
      await saveCpasmalCachePreservingPlayable(cacheKey, notFoundData);
      return res.status(404).json({ error: 'TV Show not found on Cpasmal' });
    }

    await saveCpasmalCachePreservingPlayable(cacheKey, data);
    const prochaineMiseAJour = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    await respondWithSources(req, res, { ...data, prochaineMiseAJour });

  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
module.exports.configure = configure;
