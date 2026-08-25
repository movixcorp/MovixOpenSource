/**
 * FStream routes.
 * Extracted from server.js -- FStream authentication, search, scraping, player extraction, and routes.
 * Mount point: app.use('/api/fstream', router)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fsp = require('fs').promises;

const { getRedis } = require('../config/redis');
const { fetchTmdbDetails } = require('../utils/tmdbCache');
const {
  CACHE_DIR,
  generateFStreamCacheKey,
  getFStreamFromCache,
  saveFStreamToCache,
  ongoingFStreamRequests,
  getOrCreateFStreamRequest
} = require('../utils/cacheManager');
const axiosHelpers = require('../utils/axiosHelpers');
const { axiosFStreamRequest } = axiosHelpers;
const { respondWithResolvedSources } = require('../utils/embedExtraction');

/** Séries : résout les m3u8 de l'épisode demandé (`?episode=N`), pour un VIP. */
const respondWithEpisodeSources = (req, res, payload, status = 200) =>
  respondWithResolvedSources(req, res, payload, { status, label: 'FSTREAM TV' });

/** Films : la map de langues vit sous `players`. */
const respondWithMovieSources = (req, res, payload, status = 200) =>
  respondWithResolvedSources(req, res, payload, {
    status,
    movieMapKey: 'players',
    label: 'FSTREAM MOVIE',
  });
const { PROXIES, DARKINO_PROXIES, getProxyAgent, getDarkinoHttpProxyAgent } = require('../utils/proxyManager');

// === FStream Configuration ===
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const FSTREAM_BASE_URL = 'https://french-stream.one';
const FSTREAM_SEARCH_URL = `${FSTREAM_BASE_URL}/engine/ajax/search.php`;

// === FStream Authentication (disabled) ===
const FSTREAM_LOGIN_NAME = process.env.FSTREAM_LOGIN_NAME || '';
const FSTREAM_LOGIN_PASSWORD = process.env.FSTREAM_LOGIN_PASSWORD || '';

let fstreamLoginPromise = null;

// Configuration des cookies FStream
const fstreamCookies = {
  'PHPSESSID': '',
  'dle_user_id': '',
  'dle_password': '',
  'dle_skin': 'VFV25',
  'dle_newpm': '0',
  '__cf_logged_in': '1',
  'CF_VERIFIED_DEVICE_ae9bb95a6761c08a92f916b7ed7d2c4a985eb220591d1410240412c516f37b0c': '1756239054',
  // Anti-bot "fsschal": le challenge JS de FStream pose juste ce cookie statique puis recharge.
  // Sans lui, search.php / episodes_p.php / film_api.php renvoient la page "Verification..." (1466b)
  // au lieu des donnees. Les fichiers /static/ en sont exempts. Valeur overridable si elle tourne.
  'fsschal': process.env.FSTREAM_FSSCHAL || '1'
};

// Construit le header Cookie complet depuis fstreamCookies, pour les requetes axios
// directes (episodes_p, film_api, static) qui ne passent pas par withOptionalFStreamCookies.
function buildFStreamCookieHeader() {
  return Object.entries(fstreamCookies)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

let fstreamRequestCounter = 0;
const MAX_REQUESTS_PER_SESSION = 5;

function extractCookieValue(cookies, name) {
  if (!cookies || !Array.isArray(cookies)) return null;
  const target = cookies.find(c => typeof c === 'string' && c.startsWith(`${name}=`));
  if (!target) return null;
  const semi = target.indexOf(';');
  const pair = semi !== -1 ? target.slice(0, semi) : target;
  const idx = pair.indexOf('=');
  return idx !== -1 ? pair.slice(idx + 1) : null;
}

function hasFStreamAuthCookies() {
  return Boolean(fstreamCookies['dle_user_id'] && fstreamCookies['dle_password']);
}

function hasUsableFStreamSession() {
  return hasFStreamAuthCookies() || Boolean(fstreamCookies['PHPSESSID']);
}

function canUseFStreamAuth() {
  return false;
}

async function loginToFStream() {
  if (!canUseFStreamAuth()) return false;
  if (fstreamLoginPromise) return fstreamLoginPromise;
  fstreamLoginPromise = (async () => {
    try {
      // We need the raw axiosFStream instance for login (no proxy)
      // Use axios directly for the login request
      const formData = new URLSearchParams();
      formData.append('login_name', FSTREAM_LOGIN_NAME);
      formData.append('login_password', FSTREAM_LOGIN_PASSWORD);
      formData.append('login', 'submit');

      const response = await axios({
        method: 'post',
        url: FSTREAM_BASE_URL,
        data: formData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': FSTREAM_BASE_URL,
          'Referer': FSTREAM_BASE_URL,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true
      });

      const setCookie = response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']);
      const phpsessid = extractCookieValue(setCookie, 'PHPSESSID');
      const dleUserId = extractCookieValue(setCookie, 'dle_user_id');
      const dlePassword = extractCookieValue(setCookie, 'dle_password');
      const dleNewpm = extractCookieValue(setCookie, 'dle_newpm');

      fstreamCookies['PHPSESSID'] = phpsessid || '';
      if (dleUserId) fstreamCookies['dle_user_id'] = dleUserId;
      if (dlePassword) fstreamCookies['dle_password'] = dlePassword;
      if (dleNewpm) fstreamCookies['dle_newpm'] = dleNewpm;

      if (!hasFStreamAuthCookies()) {
        console.warn('[FSTREAM LOGIN] Cookies d\'auth non presents dans set-cookie, poursuite sans authentification');
        return false;
      }
      // Connexion reussie, cookies recuperes

      // Changer le skin vers VFV25 via POST
      try {
        const skinCookieHeader = Object.entries(fstreamCookies)
          .filter(([, v]) => v !== '' && v != null)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        const skinFormData = new URLSearchParams();
        skinFormData.append('skin_name', 'VFV25');
        skinFormData.append('action_skin_change', 'yes');

        await axios({
          method: 'post',
          url: FSTREAM_BASE_URL,
          data: skinFormData,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': FSTREAM_BASE_URL,
            'Referer': FSTREAM_BASE_URL + '/',
            'Cookie': skinCookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: 15000,
          maxRedirects: 5,
          validateStatus: () => true
        });

        fstreamCookies['dle_skin'] = 'VFV25';
        // Skin change vers VFV25
      } catch (skinError) {
        console.warn('[FSTREAM LOGIN] Erreur changement de skin:', skinError.message);
      }

      return true;
    } finally {
      fstreamLoginPromise = null;
    }
  })();
  return fstreamLoginPromise;
}

async function ensureFStreamSession() {
  if (!canUseFStreamAuth()) return false;
  if (!hasUsableFStreamSession() || fstreamRequestCounter >= MAX_REQUESTS_PER_SESSION) {
    try {
      const loggedIn = await loginToFStream();
      if (loggedIn) {
        fstreamRequestCounter = 0;
      }
      return loggedIn;
    } catch (error) {
      console.warn('[FSTREAM LOGIN] Auth optionnelle indisponible, poursuite sans cookies:', error.message);
      return false;
    }
  }
  return true;
}

// Inject fstream session management into axiosHelpers so axiosFStreamRequest works
axiosHelpers.configure({
  ensureFStreamSession,
  fstreamCookies,
  getFstreamRequestCounter: () => fstreamRequestCounter,
  incrementFstreamRequestCounter: () => { fstreamRequestCounter++; }
});

// === TMDB Helper (cached via Redis) ===
async function getFStreamTMDBDetails(id, type) {
  try {
    const [frData, enData] = await Promise.all([
      fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, id, type, 'fr-FR'),
      fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, id, type, 'en-US')
    ]);

    if (!frData) return null;

    return {
      id: frData.id,
      title: type === 'movie' ? frData.title : frData.name,
      original_title: type === 'movie' ? frData.original_title : frData.original_name,
      name_no_lang: enData ? (type === 'movie' ? enData.title : enData.name) : null,
      release_date: type === 'movie' ? frData.release_date : frData.first_air_date,
      overview: frData.overview
    };
  } catch (error) {
    console.error(`Erreur lors de la recuperation des details TMDB pour ${id} (${type}):`, error);
    return null;
  }
}

// === Title Similarity (local copy for FStream matching) ===
function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();
  const normalize = (str) => str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const norm1 = normalize(t1);
  const norm2 = normalize(t2);
  if (norm1 === norm2) return 1.0;

  // Token overlap approach
  const tokens1 = new Set(norm1.split(' ').filter(Boolean));
  const tokens2 = new Set(norm2.split(' ').filter(Boolean));
  let intersection = 0;
  for (const t of tokens1) { if (tokens2.has(t)) intersection++; }
  const union = new Set([...tokens1, ...tokens2]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizeFStreamBaseTitle(value) {
  return (value || '')
    .replace(/\s*\(\d{4}\)\s*/g, ' ')
    .replace(/\s*-\s*Saison\s+\d+.*$/i, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFStreamCachedSelectionValid(cachedData, requestedSeason) {
  const tmdbTitle = cachedData?.tmdb?.title;
  const bestMatch = cachedData?.search?.bestMatch;
  if (!tmdbTitle || !bestMatch) return true;

  const requestedSeasonNumber = parseInt(requestedSeason, 10);
  const cachedSeasonNumber = parseInt(bestMatch.seasonNumber, 10);
  if (
    !Number.isNaN(requestedSeasonNumber) &&
    !Number.isNaN(cachedSeasonNumber) &&
    cachedSeasonNumber !== requestedSeasonNumber
  ) {
    return false;
  }

  const normalizedTmdbTitle = normalizeFStreamBaseTitle(tmdbTitle);
  const normalizedMatchTitle = normalizeFStreamBaseTitle(
    bestMatch.originalTitle || bestMatch.title,
  );
  const tmdbTokens = normalizedTmdbTitle.split(' ').filter(Boolean);

  if (tmdbTokens.length === 1) {
    return normalizedMatchTitle === normalizedTmdbTitle;
  }

  return true;
}

// === Search Functions ===
async function searchFStream(query, page = 1) {
  try {
    const formData = new URLSearchParams();
    formData.append('query', query);
    formData.append('page', page.toString());

    const response = await axiosFStreamRequest({
      method: 'post',
      url: FSTREAM_SEARCH_URL,
      data: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.status !== 200) throw new Error(`Erreur HTTP: ${response.status}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 429 || status === 403 || status === 503 || status === 502) throw error;
    }
    console.error(`Erreur lors de la recherche FStream: ${error.message}`);
    throw error;
  }
}

async function searchFStreamDirect(query, page = 1) {
  try {
    const formData = new URLSearchParams();
    formData.append('query', query);
    formData.append('page', page.toString());

    const response = await axiosFStreamRequest({
      method: 'post',
      url: FSTREAM_SEARCH_URL,
      data: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.status !== 200) throw new Error(`Erreur HTTP: ${response.status}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 429 || status === 403 || status === 503 || status === 502) throw error;
    }
    throw error;
  }
}

// Fallback "fuzzy" : search.php avec titre nu + filtre permissif (pas de filtre annee).
// Remplace l'ancien get_seasons.php (mort cote upstream depuis ~2026-05) qui prenait
// un TMDB id ; on simule le meme role en listant toutes les saisons matchant le titre.
async function fetchFStreamSeasonSearchResults(tmdbId, serieTitle) {
  if (!serieTitle) return [];
  try {
    const formData = new URLSearchParams();
    formData.append('query', serieTitle);

    const response = await axiosFStreamRequest({
      method: 'post',
      url: FSTREAM_SEARCH_URL,
      data: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 6000
    });

    const html = typeof response.data === 'string' ? response.data : '';
    if (!html.trim()) return [];

    const $ = cheerio.load(html);
    const normalize = (s) => (s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[''`´]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedSerie = normalize(serieTitle);
    if (!normalizedSerie) return [];

    const results = [];
    const exactResults = [];
    const normalizedSerieTokens = normalizedSerie.split(' ').filter(Boolean);
    $('div.search-item').each((_, element) => {
      const $el = $(element);
      const rawTitle = $el.find('.search-title').text().trim();
      const onclickAttr = $el.attr('onclick') || '';
      const linkMatch = onclickAttr.match(/location\.href=['"]([^'"]+)['"]/);
      const link = linkMatch ? linkMatch[1] : null;
      if (!rawTitle || !link) return;

      const seasonMatch = rawTitle.match(/Saison\s+(\d+)/i);
      if (!seasonMatch) return;
      const seasonNumber = parseInt(seasonMatch[1], 10);
      if (Number.isNaN(seasonNumber)) return;

      const baseTitle = rawTitle.replace(/\s*-\s*Saison\s+\d+.*$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const normalizedBase = normalize(baseTitle);
      if (!normalizedBase) return;
      const isExactTitle = normalizedBase === normalizedSerie;
      if (normalizedSerieTokens.length === 1 && !isExactTitle) return;
      if (!normalizedBase.includes(normalizedSerie) && !normalizedSerie.includes(normalizedBase)) return;

      const titleYearMatch = rawTitle.match(/\((\d{4})\)/);
      const urlYearMatch = link.match(/-(\d{4})\.html/);
      const year = titleYearMatch ? parseInt(titleYearMatch[1], 10)
        : urlYearMatch ? parseInt(urlYearMatch[1], 10) : null;

      const cleanTitle = baseTitle ? `${baseTitle} - Saison ${seasonNumber}` : rawTitle;
      const normalizedLink = link.startsWith('http')
        ? link
        : `${FSTREAM_BASE_URL}${link.startsWith('/') ? '' : '/'}${link}`;

      const target = isExactTitle ? exactResults : results;
      target.push({
        title: cleanTitle,
        originalTitle: rawTitle,
        link: normalizedLink,
        seasonNumber,
        year
      });
    });

    return exactResults.length > 0 ? exactResults : results;
  } catch (error) {
    console.error(`[FSTREAM TV] Erreur lors de la recuperation des saisons pour ${tmdbId}: ${error.message}`);
    return [];
  }
}

// get_seasons.php (ajax related-seasons de DLE) est toujours vivant cote upstream,
// contrairement a l'hypothese de fetchFStreamSeasonSearchResults. serie_tag = s-<tmdbId>
// (l'id TMDB brut), news_id = page id d'une saison deja trouvee via search. Retourne
// TOUTES les saisons de la serie (id, title, full_url), y compris celles que search.php
// ne liste pas (ex: Mayans MC -> search ne voit que S4/S5, get_seasons rend S1/S2/S3/S5).
// Fallback quand la saison demandee est absente des resultats search mais existe cote FStream.
async function fetchFStreamSeasonsAjax(tmdbId, newsId, baseUrl) {
  if (!tmdbId || !newsId) return [];
  const apiUrl = `${baseUrl}/engine/ajax/get_seasons.php?serie_tag=s-${tmdbId}&news_id=${newsId}`;

  const proxies = getShuffledAllProxies();
  const maxAttempts = Math.min(proxies.length, 3);

  for (let i = 0; i < maxAttempts; i++) {
    const entry = proxies[i];
    const agents = getAgentForProxy(entry);
    try {
      const response = await axios({
        method: 'get',
        url: apiUrl,
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': `${baseUrl}/`,
          'Accept': 'application/json, text/javascript, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': buildFStreamCookieHeader()
        },
        ...(agents ? { httpAgent: agents.httpAgent || agents, httpsAgent: agents.httpsAgent || agents, proxy: false } : {})
      });

      if (response.status === 429) continue;
      if (response.status !== 200 || !response.data) return [];

      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (!Array.isArray(data)) return [];

      return data.map(item => {
        const seasonMatch = (item.title || '').match(/Saison\s+(\d+)/i);
        const seasonNumber = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
        const rawUrl = item.full_url || '';
        const link = !rawUrl ? null
          : rawUrl.startsWith('http') ? rawUrl
          : `${baseUrl}/${rawUrl.replace(/^\//, '')}`;
        return { title: item.title || `Saison ${seasonNumber}`, originalTitle: item.title || '', link, seasonNumber, year: null };
      }).filter(r => r.link && r.seasonNumber);
    } catch (error) {
      if (error.response?.status === 429) continue;
      console.error(`[FStream] Erreur get_seasons.php (proxy ${entry.type} #${i}): ${error.message}`);
      continue;
    }
  }

  return [];
}

// === Scraping Functions ===
async function scrapeFStreamRecentMovies() {
  try {
    const response = await axiosFStreamRequest({
      method: 'get',
      url: `${FSTREAM_BASE_URL}/films/`,
      timeout: 10000
    });

    if (response.status !== 200) throw new Error(`Erreur HTTP: ${response.status}`);
    if (!response.data || typeof response.data !== 'string') throw new Error('La reponse n\'est pas du HTML valide');

    const $ = cheerio.load(response.data);
    const movies = [];

    const dleContent = $('#dle-content');
    let filmElements;

    if (dleContent.length > 0) {
      filmElements = dleContent.find('.short.film');
      if (filmElements.length === 0) filmElements = dleContent.find('div.short.film');
      if (filmElements.length === 0) filmElements = dleContent.find('div[class*="short"][class*="film"]');
      if (filmElements.length === 0) {
        const shortInDle = dleContent.find('.short');
        if (shortInDle.length > 0) filmElements = shortInDle;
      }
    } else {
      filmElements = $('.short.film');
      if (filmElements.length === 0) filmElements = $('div.short.film');
      if (filmElements.length === 0) filmElements = $('div[class*="short"][class*="film"]');
      if (filmElements.length === 0) {
        const allShorts = $('.short');
        if (allShorts.length > 0) filmElements = allShorts;
      }
    }

    filmElements.each((index, element) => {
      try {
        const $el = $(element);
        const titleElement = $el.find('.short-title');
        if (titleElement.length === 0) return;
        const title = titleElement.text().trim();
        if (!title) return;

        const linkElement = $el.find('a.short-poster');
        if (linkElement.length === 0) return;
        const href = linkElement.attr('href');
        if (!href) return;

        const fullLink = href.startsWith('http') ? href
          : href.startsWith('/') ? `${FSTREAM_BASE_URL}${href}`
          : `${FSTREAM_BASE_URL}/${href}`;

        let movieId = null;
        const idMatch = href.match(/(\d+)/);
        if (idMatch) movieId = idMatch[1];

        let trailerId = null;
        if (movieId) {
          let trailerElement = $el.find(`span#trailer-${movieId}`);
          if (trailerElement.length === 0) trailerElement = $(`span#trailer-${movieId}`);
          if (trailerElement.length > 0) trailerId = trailerElement.text().trim();
        }

        let description = null;
        if (movieId) {
          let descElement = $el.find(`span#desc-${movieId}`);
          if (descElement.length === 0) descElement = $(`span#desc-${movieId}`);
          if (descElement.length > 0) description = descElement.text().trim();
        }

        const quality = $el.find('.film-quality a').text().trim() || null;
        const version = $el.find('.film-version a').text().trim() || null;

        const imgElement = $el.find('img');
        let posterUrl = null;
        if (imgElement.length > 0) {
          posterUrl = imgElement.attr('src');
          if (posterUrl && !posterUrl.startsWith('http')) {
            posterUrl = posterUrl.startsWith('/')
              ? `${FSTREAM_BASE_URL}${posterUrl}`
              : `${FSTREAM_BASE_URL}/${posterUrl}`;
          }
        }

        const ratingElement = $el.find('.vote-score');
        let rating = null;
        if (ratingElement.length > 0) {
          const ratingText = ratingElement.text().trim();
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          if (ratingMatch) rating = parseFloat(ratingMatch[1]);
        }

        movies.push({
          title, link: fullLink, id: movieId, trailerId, description,
          quality, version, posterUrl, rating, source: 'fstream_recent'
        });
      } catch (error) {
        console.error(`[FSTREAM RECENT] Erreur lors du parsing d'un film: ${error.message}`);
      }
    });

    return movies;
  } catch (error) {
    console.error(`[FSTREAM RECENT] Erreur lors du scraping: ${error.message}`);
    return [];
  }
}

async function scrapeFStreamRecentSeries() {
  try {
    const response = await axiosFStreamRequest({
      method: 'get',
      url: `${FSTREAM_BASE_URL}/s-tv/`,
      timeout: 10000
    });

    if (response.status !== 200) throw new Error(`Erreur HTTP: ${response.status}`);

    const $ = cheerio.load(response.data);
    const series = [];
    const seriesElements = $('#dle-content .short.serie');

    seriesElements.each((index, element) => {
      try {
        const $el = $(element);
        const titleElement = $el.find('.short-title');
        if (titleElement.length === 0) return;
        const title = titleElement.text().trim();
        if (!title) return;

        const linkElement = $el.find('a.short-poster');
        if (linkElement.length === 0) return;
        const href = linkElement.attr('href');
        if (!href) return;

        const fullLink = href.startsWith('http') ? href : `${FSTREAM_BASE_URL}${href}`;

        let seriesId = null;
        const idMatch = href.match(/(\d+)/);
        if (idMatch) seriesId = idMatch[1];

        series.push({
          title, link: fullLink, id: seriesId, tmdbId: null, source: 'fstream_recent_series'
        });
      } catch (error) {
        console.error(`[FSTREAM RECENT SERIES] Erreur lors du parsing d'une serie: ${error.message}`);
      }
    });

    return series;
  } catch (error) {
    console.error(`[FSTREAM RECENT SERIES] Erreur lors du scraping: ${error.message}`);
    return [];
  }
}

// === Finding Functions ===
async function findMovieInRecentFStream(tmdbTitle, tmdbYear) {
  try {
    const recentMovies = await scrapeFStreamRecentMovies();
    if (recentMovies.length === 0) return null;

    const extractYear = (title) => {
      const yearMatch = title.match(/\((\d{4})\)/);
      return yearMatch ? yearMatch[1] : null;
    };

    const removeYear = (title) => title.replace(/\s*\((\d{4})\)\s*$/, '').trim();

    const normalizeTitle = (str) => {
      if (!str) return '';
      let cleaned = removeYear(str);
      return cleaned.toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    let yearToMatch = tmdbYear;
    if (!yearToMatch) yearToMatch = extractYear(tmdbTitle);

    const tmdbTitleWithoutYear = removeYear(tmdbTitle);
    const normalizedTmdbTitle = normalizeTitle(tmdbTitleWithoutYear);

    let bestMatch = null;
    let bestSimilarity = 0;

    for (const movie of recentMovies) {
      const normalizedMovieTitle = normalizeTitle(movie.title);
      if (normalizedMovieTitle === normalizedTmdbTitle) return movie;

      const similarity = calculateTitleSimilarity(normalizedTmdbTitle, normalizedMovieTitle);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = movie;
      }
    }

    if (bestMatch && bestSimilarity >= 0.7) return bestMatch;

    if (bestMatch && bestSimilarity >= 0.6 && normalizedTmdbTitle.length > 3) {
      const tmdbWords = normalizedTmdbTitle.split(/\s+/).filter(w => w.length > 2);
      const movieWords = normalizeTitle(bestMatch.title).split(/\s+/).filter(w => w.length > 2);
      const allWordsMatch = tmdbWords.length > 0 && (
        tmdbWords.every(word => movieWords.some(mw => mw.includes(word) || word.includes(mw))) ||
        movieWords.every(word => tmdbWords.some(tw => tw.includes(word) || word.includes(tw)))
      );
      if (allWordsMatch) {
        // Verifier que les tokens bruts (sans filtre de longueur) ont un recouvrement suffisant
        const rawTmdbTokens = normalizedTmdbTitle.split(/\s+/).filter(Boolean);
        const rawMovieTokens = new Set(normalizeTitle(bestMatch.title).split(/\s+/).filter(Boolean));
        const rawCoverage = rawTmdbTokens.length > 0 ? rawTmdbTokens.filter(t => rawMovieTokens.has(t)).length / rawTmdbTokens.length : 0;
        if (rawCoverage >= 0.75) return bestMatch;
      }
    }

    return null;
  } catch (error) {
    console.error(`[FSTREAM RECENT] Erreur lors de la recherche: ${error.message}`);
    return null;
  }
}

async function findSeriesInRecentFStream(tmdbTitle, tmdbYear) {
  try {
    const recentSeries = await scrapeFStreamRecentSeries();
    if (recentSeries.length === 0) return null;

    const normalizeTitle = (str) => (str || '')
      .toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const normalizedTmdbTitle = normalizeTitle(tmdbTitle);

    for (const series of recentSeries) {
      const normalizedSeriesTitle = normalizeTitle(series.title);
      if (normalizedSeriesTitle === normalizedTmdbTitle) return series;
      const similarity = calculateTitleSimilarity(normalizedTmdbTitle, normalizedSeriesTitle);
      if (similarity > 0.8) return series;
    }

    return null;
  } catch (error) {
    console.error(`[FSTREAM RECENT SERIES] Erreur lors de la recherche: ${error.message}`);
    return null;
  }
}

// === API-based extraction helpers ===
function extractPageIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/(\d+)-[^/]+\.html/);
  return match ? match[1] : null;
}

function extractBaseUrlFromLink(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return FSTREAM_BASE_URL;
  }
}

// Construit une liste melangee de proxies SOCKS5 + Darkino HTTP
function getShuffledAllProxies() {
  const all = [];
  // Ajouter les SOCKS5
  if (PROXIES && PROXIES.length > 0) {
    PROXIES.forEach(p => all.push({ proxy: p, type: 'socks5' }));
  }
  // Ajouter les Darkino HTTP
  if (DARKINO_PROXIES && DARKINO_PROXIES.length > 0) {
    DARKINO_PROXIES.forEach(p => all.push({ proxy: p, type: 'darkino' }));
  }
  // Melanger
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function getAgentForProxy(entry) {
  if (entry.type === 'socks5') {
    const agent = getProxyAgent(entry.proxy);
    return { httpAgent: agent, httpsAgent: agent };
  }
  // darkino HTTP proxy
  return getDarkinoHttpProxyAgent(entry.proxy);
}

// Parse le payload episodes FStream (shape commune {vf,vostfr,vo,info}) en map normalisee.
// Partage entre la source statique (<base>/static/series) et l'API dynamique (episodes_p.php).
function parseEpisodesPayload(data) {
  if (!data || typeof data !== 'object') return null;

  const episodes = {};
  const langMap = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VOENG' };

  for (const [langKey, langLabel] of Object.entries(langMap)) {
    const langData = data[langKey];
    if (!langData || typeof langData !== 'object') continue;

    for (const [epNum, providers] of Object.entries(langData)) {
      const epNumber = parseInt(epNum);
      if (isNaN(epNumber) || epNumber === 0) continue;

      if (!episodes[epNumber]) {
        episodes[epNumber] = {
          number: epNumber,
          title: `Episode ${epNumber}`,
          languages: { VF: [], VOSTFR: [], VOENG: [], Default: [] }
        };
      }

      for (const [provider, url] of Object.entries(providers)) {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
        let displayName = provider;
        if (provider === 'premium') displayName = 'Premium';
        else if (provider === 'vidzy') displayName = 'Vidzy';
        else if (provider === 'uqload') displayName = 'Uqload';
        else if (provider === 'netu') displayName = 'Netu';
        else if (provider === 'voe') displayName = 'Voe';
        else displayName = provider.charAt(0).toUpperCase() + provider.slice(1);

        const exists = episodes[epNumber].languages[langLabel].some(p => p.url === url);
        if (!exists) {
          episodes[epNumber].languages[langLabel].push({ url, type: 'embed', quality: 'HD', player: displayName });
        }
      }
    }
  }

  // Enrichir avec les infos (titres, synopsis) si disponibles
  if (data.info && typeof data.info === 'object') {
    for (const [epNum, info] of Object.entries(data.info)) {
      const epNumber = parseInt(epNum);
      if (episodes[epNumber] && info.title) {
        episodes[epNumber].title = info.title;
      }
    }
  }

  if (Object.keys(episodes).length > 0) return episodes;
  return null;
}

// Source statique prioritaire: <base>/static/series/<id>.js (JSON fige, frais, inclut premium).
// Meme domaine que le lien de recherche (base url), pas un host distinct.
async function fetchEpisodesFromStaticJs(pageUrl) {
  const pageId = extractPageIdFromUrl(pageUrl);
  if (!pageId) return null;

  const baseUrl = extractBaseUrlFromLink(pageUrl);
  const apiUrl = `${baseUrl}/static/series/${pageId}.js?v=${Date.now()}`;

  const proxies = getShuffledAllProxies();
  const maxAttempts = Math.min(proxies.length, 3);
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const entry = proxies[i];
    const agents = getAgentForProxy(entry);

    try {
      const response = await axios({
        method: 'get',
        url: apiUrl,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': pageUrl,
          'Accept': 'application/json, text/javascript, */*',
          'Cookie': buildFStreamCookieHeader()
        },
        ...(agents ? { httpAgent: agents.httpAgent || agents, httpsAgent: agents.httpsAgent || agents, proxy: false } : {})
      });

      if (response.status === 429) {
        console.log(`[FStream] static series.js: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      if (response.status !== 200 || !response.data) return null;

      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      return parseEpisodesPayload(data);
    } catch (error) {
      lastError = error;
      if (error.response?.status === 429) {
        console.log(`[FStream] static series.js: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      console.error(`[FStream] Erreur static series.js (proxy ${entry.type} #${i}): ${error.message}`);
      continue;
    }
  }

  if (lastError) console.error(`[FStream] static series.js: tous les proxies ont echoue. Derniere erreur: ${lastError.message}`);
  return null;
}

async function fetchEpisodesFromApi(pageUrl) {
  const pageId = extractPageIdFromUrl(pageUrl);
  if (!pageId) return null;

  const baseUrl = extractBaseUrlFromLink(pageUrl);
  const apiUrl = `${baseUrl}/engine/ajax/episodes_p.php?id=${pageId}`;

  const proxies = getShuffledAllProxies();
  const maxAttempts = Math.min(proxies.length, 3);
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const entry = proxies[i];
    const agents = getAgentForProxy(entry);

    try {
      const response = await axios({
        method: 'get',
        url: apiUrl,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': pageUrl,
          'Accept': 'application/json, text/plain, */*',
          'Cookie': buildFStreamCookieHeader()
        },
        ...(agents ? { httpAgent: agents.httpAgent || agents, httpsAgent: agents.httpsAgent || agents, proxy: false } : {})
      });

      if (response.status === 429) {
        console.log(`[FStream] API episodes_p: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      if (response.status !== 200 || !response.data) return null;

      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      return parseEpisodesPayload(data);
    } catch (error) {
      lastError = error;
      if (error.response?.status === 429) {
        console.log(`[FStream] API episodes_p: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      console.error(`[FStream] Erreur API episodes_p (proxy ${entry.type} #${i}): ${error.message}`);
      continue;
    }
  }

  if (lastError) console.error(`[FStream] API episodes_p: tous les proxies ont echoue. Derniere erreur: ${lastError.message}`);
  return null;
}

async function fetchMoviePlayersFromApi(pageUrl) {
  const pageId = extractPageIdFromUrl(pageUrl);
  if (!pageId) return null;

  const baseUrl = extractBaseUrlFromLink(pageUrl);
  const apiUrl = `${baseUrl}/engine/ajax/film_api.php?id=${pageId}`;

  const proxies = getShuffledAllProxies();
  const maxAttempts = Math.min(proxies.length, 3);
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const entry = proxies[i];
    const agents = getAgentForProxy(entry);

    try {
      const response = await axios({
        method: 'get',
        url: apiUrl,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': pageUrl,
          'Accept': 'application/json, text/plain, */*',
          'Cookie': buildFStreamCookieHeader()
        },
        ...(agents ? { httpAgent: agents.httpAgent || agents, httpsAgent: agents.httpsAgent || agents, proxy: false } : {})
      });

      if (response.status === 429) {
        console.log(`[FStream] API film_api: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      if (response.status !== 200 || !response.data) return null;

      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (!data || !data.players || typeof data.players !== 'object') return null;

      const players = [];
      const versionMap = { 'default': 'Default', 'vf': 'VF', 'vfq': 'VFQ', 'vff': 'VFF', 'vostfr': 'VOSTFR' };

      for (const [provider, versions] of Object.entries(data.players)) {
        if (!versions || typeof versions !== 'object') continue;

        for (const [versionKey, url] of Object.entries(versions)) {
          if (!url || typeof url !== 'string') continue;
          let finalUrl = url;
          if (provider === 'netu' && !url.startsWith('http')) {
            finalUrl = `https://www.fembed.com/v/${url}`;
          }
          if (!finalUrl.startsWith('http')) continue;

          let displayName = provider;
          if (provider === 'premium') displayName = 'Premium';
          else if (provider === 'vidzy') displayName = 'Vidzy';
          else if (provider === 'uqload') displayName = 'Uqload';
          else if (provider === 'netu') displayName = 'Netu';
          else if (provider === 'voe') displayName = 'Voe';
          else if (provider === 'dood') displayName = 'Dood';
          else if (provider === 'filmoon') displayName = 'Filmoon';
          else displayName = provider.charAt(0).toUpperCase() + provider.slice(1);

          const version = versionMap[versionKey] || versionKey.toUpperCase();
          players.push({ url: finalUrl, type: 'embed', quality: 'HD', player: displayName, version });
        }
      }

      if (players.length > 0) {
        return players;
      }
      return null;
    } catch (error) {
      lastError = error;
      if (error.response?.status === 429) {
        console.log(`[FStream] API film_api: 429 avec proxy ${entry.type} #${i}, retry...`);
        continue;
      }
      console.error(`[FStream] Erreur API film_api (proxy ${entry.type} #${i}): ${error.message}`);
      continue;
    }
  }

  if (lastError) console.error(`[FStream] API film_api: tous les proxies ont echoue. Derniere erreur: ${lastError.message}`);
  return null;
}

// === High-level wrappers: API-first, HTML fallback ===
// Bypass le fetch HTML (souvent 429) en appelant l'API directe d'abord
async function getSeriesPlayersForUrl(pageUrl) {
  // 1. Source statique <base>/static/series/<id>.js (prioritaire: fraiche, premium, inclut tous les eps)
  let apiEpisodes = await fetchEpisodesFromStaticJs(pageUrl);

  // 2. Fallback: API dynamique episodes_p.php (si la statique 404/echoue ou host a tourne)
  if (!apiEpisodes || Object.keys(apiEpisodes).length === 0) {
    apiEpisodes = await fetchEpisodesFromApi(pageUrl);
  }

  if (apiEpisodes && Object.keys(apiEpisodes).length > 0) {
    const organizedPlayers = { VF: [], VOSTFR: [], VOENG: [], Default: [] };
    let totalPlayers = 0;
    Object.values(apiEpisodes).forEach(episode => {
      Object.entries(episode.languages).forEach(([lang, players]) => {
        if (players.length > 0) {
          if (organizedPlayers[lang]) organizedPlayers[lang].push(...players);
          totalPlayers += players.length;
        }
      });
    });
    return { organized: organizedPlayers, episodes: apiEpisodes, total: totalPlayers, fstreamReleaseDate: null, fromApi: true };
  }

  // 3. Fallback: fetch HTML (scrape direct de la page french-stream.one)
  console.log(`[FStream] getSeriesPlayersForUrl: sources JSON echouees, fallback HTML pour ${pageUrl}`);
  const contentResponse = await axiosFStreamRequest({ method: 'get', url: pageUrl });
  if (contentResponse.status !== 200) return { organized: { VF: [], VOSTFR: [], VOENG: [], Default: [] }, episodes: {}, total: 0, fstreamReleaseDate: null };
  return await extractFStreamPlayers(contentResponse.data, true, pageUrl);
}

async function getMoviePlayersForUrl(pageUrl) {
  // 1. API directe
  const apiPlayers = await fetchMoviePlayersFromApi(pageUrl);
  if (apiPlayers && apiPlayers.length > 0) {
    const uniquePlayers = [];
    const seenUrls = new Set();
    apiPlayers.forEach(player => {
      if (!seenUrls.has(player.url)) { seenUrls.add(player.url); uniquePlayers.push(player); }
    });
    const organized = { VFQ: [], VFF: [], VOSTFR: [], Default: [] };
    uniquePlayers.forEach(player => {
      const version = (player.version && organized[player.version]) ? player.version : 'Default';
      organized[version].push({ url: player.url, type: player.type, quality: player.quality, player: player.player || 'Lecteur' });
    });
    return { organized, total: uniquePlayers.length, fromApi: true };
  }

  // 2. Fallback: fetch HTML
  console.log(`[FStream] getMoviePlayersForUrl: API echouee, fallback HTML pour ${pageUrl}`);
  const contentResponse = await axiosFStreamRequest({ method: 'get', url: pageUrl });
  if (contentResponse.status !== 200) return { organized: { VFQ: [], VFF: [], VOSTFR: [], Default: [] }, total: 0 };
  return await extractFStreamPlayers(contentResponse.data, false, pageUrl);
}

// === Player Extraction ===
async function extractFStreamPlayers(htmlContent, isSeries = false, pageUrl = null) {
  try {
    const $ = cheerio.load(htmlContent);
    let players = [];

    if (isSeries) {
      return await extractFStreamSeriesPlayers(htmlContent, pageUrl);
    } else {
      // Methode API (la plus fiable)
      if (pageUrl) {
        const apiPlayers = await fetchMoviePlayersFromApi(pageUrl);
        if (apiPlayers && apiPlayers.length > 0) {
          players = apiPlayers;
        }
      }

      // Pour les films - extraction via #film-data
      const filmData = $('#film-data');
      if (players.length === 0 && filmData.length > 0) {
        const providers = ['premium', 'vidzy', 'uqload', 'dood', 'voe', 'filmoon', 'netu'];
        providers.forEach(provider => {
          const versions = { 'vostfr': 'VOSTFR', 'vff': 'VFF', 'vfq': 'VFQ', '': 'Default' };
          Object.entries(versions).forEach(([suffix, label]) => {
            const attr = `data-${provider}${suffix}`;
            const value = filmData.attr(attr);
            if (value && value.trim() !== '') {
              let url = value;
              if (provider === 'netu' && !value.startsWith('http')) {
                url = `https://www.fembed.com/v/${value}`;
              }
              if (url.startsWith('http')) {
                players.push({ url, type: 'embed', quality: 'HD', player: provider, version: label });
              }
            }
          });
        });
      }

      // Fallback: script parsing
      if (players.length === 0) {
        const scriptContent = $('script').text();
        const playerUrlsMatch = scriptContent.match(/var\s+playerUrls\s*=\s*({[\s\S]*?});/);
        if (playerUrlsMatch && playerUrlsMatch[1]) {
          try {
            const playerUrlsStr = playerUrlsMatch[1];
            const playerPattern = /"([^"]+)":\s*{([^}]+)}/g;
            let playerMatch;
            while ((playerMatch = playerPattern.exec(playerUrlsStr)) !== null) {
              const playerName = playerMatch[1];
              const versionsStr = playerMatch[2];
              const versionPattern = /"([^"]+)":\s*"([^"]*)"/g;
              let versionMatch;
              while ((versionMatch = versionPattern.exec(versionsStr)) !== null) {
                const version = versionMatch[1];
                const url = versionMatch[2];
                if (url && url.trim() !== '') {
                  players.push({ url, type: 'embed', quality: 'HD', player: playerName, version });
                }
              }
            }
            if (players.length === 0) {
              const urlPattern = /"([^"]+)":\s*"([^"]+)"/g;
              let match;
              while ((match = urlPattern.exec(playerUrlsStr)) !== null) {
                const key = match[1];
                const url = match[2];
                if (url && url.includes('http') && !key.includes('Default') && !key.includes('VFQ') && !key.includes('VFF') && !key.includes('VOSTFR')) {
                  players.push({ url, type: 'embed', quality: 'HD', player: key });
                }
              }
            }
          } catch (parseError) {
            console.error('Erreur lors du parsing de playerUrls:', parseError.message);
          }
        }

        if (players.length === 0) {
          const urlPattern = /https?:\/\/[^\s"']+/g;
          const urls = scriptContent.match(urlPattern);
          if (urls) {
            urls.forEach(url => {
              if (url.includes('embed') || url.includes('player')) {
                players.push({ url, type: 'embed', quality: 'HD' });
              }
            });
          }
        }
      }

      // Fallback: iframes
      if (players.length === 0) {
        $('iframe[src], a[href*="embed"], a[href*="player"]').each((_, element) => {
          const $el = $(element);
          const src = $el.attr('src') || $el.attr('href');
          if (src && !src.includes('episodes-suivant')) {
            players.push({
              url: src.startsWith('http') ? src : `${FSTREAM_BASE_URL}${src}`,
              type: 'embed', quality: 'HD'
            });
          }
        });
      }
    }

    // Deduplicate and organize
    const uniquePlayers = [];
    const seenUrls = new Set();
    players.forEach(player => {
      if (!seenUrls.has(player.url)) {
        seenUrls.add(player.url);
        uniquePlayers.push(player);
      }
    });

    const organizedPlayers = { VFQ: [], VFF: [], VOSTFR: [], Default: [] };
    uniquePlayers.forEach(player => {
      const version = (player.version && organizedPlayers[player.version]) ? player.version : 'Default';
      organizedPlayers[version].push({
        url: player.url, type: player.type, quality: player.quality, player: player.player || 'Lecteur'
      });
    });

    return { organized: organizedPlayers, total: uniquePlayers.length };
  } catch (error) {
    console.error(`Erreur lors de l'extraction des lecteurs FStream: ${error.message}`);
    return { organized: { VFQ: [], VFF: [], VOSTFR: [], Default: [] }, total: 0 };
  }
}

async function extractFStreamSeriesPlayers(htmlContent, pageUrl = null) {
  try {
    const $ = cheerio.load(htmlContent);
    let episodes = {};

    // Extract release date (toujours depuis le HTML)
    let fstreamReleaseDate = null;
    const selectors = [
      'html body div:nth-child(2) div div:nth-child(2) article div:nth-child(2) div:nth-child(1) div:nth-child(1) div:nth-child(1) span:nth-child(2)',
      'span.release', 'div[class*="release"] span', 'article div span[class*="release"]',
      'div[class*="info"] span[class*="release"]', 'div[class*="meta"] span[class*="release"]'
    ];
    for (const selector of selectors) {
      const releaseSpan = $(selector);
      if (releaseSpan.length > 0) {
        const releaseText = releaseSpan.text().trim();
        const yearMatch = releaseText.match(/(\d{4})/);
        if (yearMatch) { fstreamReleaseDate = yearMatch[1]; break; }
      }
    }
    if (!fstreamReleaseDate) {
      const allText = $.text();
      const yearMatches = allText.match(/(\d{4})\s*-\s*/g);
      if (yearMatches && yearMatches.length > 0) {
        const firstYear = yearMatches[0].match(/(\d{4})/)[1];
        if (parseInt(firstYear) >= 1900 && parseInt(firstYear) <= new Date().getFullYear() + 2) {
          fstreamReleaseDate = firstYear;
        }
      }
    }

    // Methode API (la plus fiable)
    let foundEpisodesData = false;
    if (pageUrl) {
      const apiEpisodes = await fetchEpisodesFromApi(pageUrl);
      if (apiEpisodes) {
        Object.assign(episodes, apiEpisodes);
        foundEpisodesData = true;
      }
    }

    // New method: HTML IDs
    if (!foundEpisodesData) try {
      const versionMap = {
        '#episodes-vf-data': 'VF',
        '#episodes-vostfr-data': 'VOSTFR',
        '#episodes-vo-data': 'VOENG'
      };
      for (const [selector, langKey] of Object.entries(versionMap)) {
        const container = $(selector);
        if (container.length > 0) {
          container.children('div').each((_, element) => {
            const $el = $(element);
            const epNumStr = $el.attr('data-ep');
            if (!epNumStr) return;
            const epNum = parseInt(epNumStr);
            if (isNaN(epNum) || epNum === 0) return;

            const attributes = {
              'data-premium': 'FSvid', 'data-vidzy': 'Vidzy',
              'data-uqload': 'Uqload', 'data-netu': 'Netu', 'data-voe': 'Voe'
            };
            const playersToAdd = [];
            Object.entries(attributes).forEach(([attr, playerName]) => {
              const url = $el.attr(attr);
              if (url && url.startsWith('http')) {
                playersToAdd.push({ url, type: 'embed', quality: 'HD', player: playerName });
              }
            });

            if (playersToAdd.length > 0) {
              if (!episodes[epNum]) {
                episodes[epNum] = { number: epNum, title: `Episode ${epNum}`, languages: { VF: [], VOSTFR: [], VOENG: [], Default: [] } };
              }
              playersToAdd.forEach(player => {
                const exists = episodes[epNum].languages[langKey].some(p => p.url === player.url);
                if (!exists) episodes[epNum].languages[langKey].push(player);
              });
            }
          });
          if (Object.keys(episodes).length > 0) foundEpisodesData = true;
        }
      }
      if (foundEpisodesData) {
        // Donnees trouvees via les IDs HTML
      }
    } catch (newMethodError) {
      console.error(`[FStream] Erreur nouvelle methode extraction: ${newMethodError.message}`);
    }

    // Legacy: episodesData from script
    if (!foundEpisodesData) $('script').each((_, scriptEl) => {
      const scriptContent = $(scriptEl).html() || '';
      const episodesDataMatch = scriptContent.match(/var\s+episodesData\s*=\s*(\{[\s\S]*?\});(?:\s*var|\s*\n\s*var|\s*\n\s*\n)/);
      if (episodesDataMatch && episodesDataMatch[1]) {
        try {
          let jsonStr = episodesDataMatch[1];
          const vfMatch = jsonStr.match(/vf:\s*\{([\s\S]*?)\},\s*(?:vostfr|vo):/);
          const vostfrMatch = jsonStr.match(/vostfr:\s*\{([\s\S]*?)\},\s*vo:/);
          const voMatch = jsonStr.match(/vo:\s*\{([\s\S]*?)\}\s*\}/);

          const parseLanguageEpisodes = (langContent, langKey) => {
            if (!langContent) return;
            const episodePattern = /(\d+):\s*\{([^}]+)\}/g;
            let epMatch;
            while ((epMatch = episodePattern.exec(langContent)) !== null) {
              const epNum = parseInt(epMatch[1]);
              const playersContent = epMatch[2];
              if (!episodes[epNum]) {
                episodes[epNum] = { number: epNum, title: `Episode ${epNum}`, languages: { VF: [], VOSTFR: [], VOENG: [], Default: [] } };
              }
              const playerPattern = /(\w+):"([^"]+)"/g;
              let playerMatch;
              while ((playerMatch = playerPattern.exec(playersContent)) !== null) {
                const playerName = playerMatch[1];
                const playerUrl = playerMatch[2];
                if (!playerUrl || playerUrl.includes('&#91;') || playerUrl.includes('xfvalue_')) continue;
                let displayName = playerName.toUpperCase();
                if (playerName === 'vidzy') displayName = 'Vidzy';
                else if (playerName === 'uqload') displayName = 'Uqload';
                else if (playerName === 'netu') displayName = 'Netu';
                else if (playerName === 'voe') displayName = 'Voe';
                else if (playerName === 'premium') displayName = 'Premium';
                const player = { url: playerUrl, type: 'embed', quality: 'HD', player: displayName };
                const targetLang = langKey === 'vo' ? 'VOENG' : (langKey === 'vostfr' ? 'VOSTFR' : 'VF');
                const exists = episodes[epNum].languages[targetLang].some(p => p.url === playerUrl);
                if (!exists) episodes[epNum].languages[targetLang].push(player);
              }
            }
          };

          if (vfMatch && vfMatch[1]) parseLanguageEpisodes(vfMatch[1], 'vf');
          if (vostfrMatch && vostfrMatch[1]) parseLanguageEpisodes(vostfrMatch[1], 'vostfr');
          if (voMatch && voMatch[1]) parseLanguageEpisodes(voMatch[1], 'vo');

          foundEpisodesData = Object.keys(episodes).length > 0;
          if (foundEpisodesData) {
            console.log(`[FStream] Parsed episodesData: ${Object.keys(episodes).length} episodes found`);
          }
        } catch (parseError) {
          console.error('[FStream] Erreur parsing episodesData:', parseError.message);
        }
      }
    });

    // Legacy HTML method
    if (!foundEpisodesData) {
      console.log('[FStream] episodesData non trouve, utilisation de la methode legacy...');
      $('div.fullsfeature').each((_, element) => {
        const $episode = $(element);
        const titleSpan = $episode.find('.selink span').first();
        const episodeTitle = titleSpan.text().trim();
        if (!episodeTitle || episodeTitle.trim() === '') return;

        let language = 'Default';
        if (episodeTitle.toLowerCase().includes('vostfr')) language = 'VOSTFR';
        else if (episodeTitle.toLowerCase().includes('vf')) language = 'VFF';

        const episodeMatch = episodeTitle.match(/episode\s+(\d+)/i);
        const episodeNumber = episodeMatch ? parseInt(episodeMatch[1]) : 1;
        const episodePlayers = [];
        $episode.find('ul.btnss a.fsctab').each((_, linkElement) => {
          const $link = $(linkElement);
          const href = $link.attr('href');
          const playerName = $link.text().trim();
          if (href && href.startsWith('http') && !href.includes('episodes-suivant')) {
            episodePlayers.push({ url: href, type: 'embed', quality: 'HD', player: playerName });
          }
        });

        if (episodePlayers.length > 0) {
          if (!episodes[episodeNumber]) {
            episodes[episodeNumber] = { number: episodeNumber, title: episodeTitle, languages: { VF: [], VOSTFR: [], VOENG: [], Default: [] } };
          }
          const langKey = language === 'VOSTFR' ? 'VOSTFR' : 'VF';
          episodes[episodeNumber].languages[langKey] = episodePlayers;
        }
      });

      $('div.elink a.fstab').each((_, linkElement) => {
        const $link = $(linkElement);
        const href = $link.attr('href');
        const linkText = $link.text().trim();
        if (!href || !href.startsWith('http') || linkText.trim() === '') return;

        const episodeMatch = linkText.match(/episode\s+(\d+)/i);
        if (!episodeMatch) return;
        const episodeNumber = parseInt(episodeMatch[1]);

        let language = 'Default';
        const lowerText = linkText.toLowerCase();
        if (lowerText.includes('vosteng') || lowerText.includes('voeng')) language = 'VOENG';
        else if (lowerText.includes('vostfr')) language = 'VOSTFR';
        else if (lowerText.includes('vf')) language = 'VFF';

        let playerName = 'Unknown';
        if (href.includes('fsvid.lol')) playerName = 'FSvid';
        else if (href.includes('vidzy.org')) playerName = 'Vidzy';
        else if (href.includes('uqload')) playerName = 'Uqload';
        else if (href.includes('voe.sx')) playerName = 'Voe';

        const player = { url: href, type: 'embed', quality: 'HD', player: playerName };
        if (!episodes[episodeNumber]) {
          episodes[episodeNumber] = { number: episodeNumber, title: linkText, languages: { VF: [], VOSTFR: [], VOENG: [], Default: [] } };
        }
        const langKey = language === 'VOENG' ? 'VOENG' : (language === 'VOSTFR' ? 'VOSTFR' : 'VF');
        const existingPlayer = episodes[episodeNumber].languages[langKey].find(p => p.url === href);
        if (!existingPlayer) episodes[episodeNumber].languages[langKey].push(player);
      });
    }

    // Organize by language
    const organizedPlayers = { VF: [], VOSTFR: [], VOENG: [], Default: [] };
    let totalPlayers = 0;
    Object.values(episodes).forEach(episode => {
      Object.entries(episode.languages).forEach(([lang, players]) => {
        if (players.length > 0) {
          organizedPlayers[lang].push(...players);
          totalPlayers += players.length;
        }
      });
    });

    return { organized: organizedPlayers, episodes, total: totalPlayers, fstreamReleaseDate };
  } catch (error) {
    console.error(`Erreur lors de l'extraction des lecteurs serie FStream: ${error.message}`);
    return { organized: { VF: [], VOSTFR: [], VOENG: [], Default: [] }, episodes: {}, total: 0, fstreamReleaseDate: null };
  }
}

// === Filtering ===
function filterFStreamResults(results, originalTitle, releaseYear) {
  try {
    const $ = cheerio.load(results);
    const filteredResults = [];

    $('div.search-item').each((_, element) => {
      const $el = $(element);
      const titleElement = $el.find('.search-title');
      const title = titleElement.text().trim();
      const onclickAttr = $el.attr('onclick');
      let link = null;
      if (onclickAttr) {
        const linkMatch = onclickAttr.match(/location\.href=['"]([^'\"]+)['"]/);
        if (linkMatch) link = linkMatch[1];
      }
      if (!title || !link) return;

      let cleanTitle = title;
      let seasonNumber = null;
      let year = null;

      const yearMatch = title.match(/\((\d{4})\)/);
      if (yearMatch) {
        year = parseInt(yearMatch[1]);
        cleanTitle = title.replace(/\s*\(\d{4}\)/, '').trim();
      }

      // Fallback: extraire l'annee de l'URL (ex: magnum-saison-5-1980.html)
      if (!year && link) {
        const urlYearMatch = link.match(/-(\d{4})\.html/);
        if (urlYearMatch) year = parseInt(urlYearMatch[1]);
      }

      const seasonMatch = cleanTitle.match(/Saison\s+(\d+)/i);
      if (seasonMatch) {
        seasonNumber = parseInt(seasonMatch[1]);
        cleanTitle = cleanTitle.replace(/\s*-\s*Saison\s+\d+$/i, '').trim();
      } else {
        const originalSeasonMatch = title.match(/Saison\s+(\d+)/i);
        if (originalSeasonMatch) seasonNumber = parseInt(originalSeasonMatch[1]);
      }

      const normalize = (str) => (str || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[''`\u00b4]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+-\s+/g, ' ')
        .replace(/\s+/g, ' ').trim();

      const normalizedOriginal = normalize(originalTitle);
      const normalizedClean = normalize(cleanTitle);
      const tokenize = (str) => (str || '').split(' ').filter(Boolean);

      const originalTokens = new Set(tokenize(normalizedOriginal));
      const cleanTokens = new Set(tokenize(normalizedClean));

      let intersectionSize = 0;
      for (const token of cleanTokens) { if (originalTokens.has(token)) intersectionSize += 1; }

      const largerSetSize = Math.max(1, Math.max(originalTokens.size, cleanTokens.size));
      const overlapScore = intersectionSize / largerSetSize;

      const hasBothYears = Boolean(releaseYear && year);
      const yearMatches = hasBothYears ? parseInt(releaseYear) === year : true;
      const exactTitleMatch = normalizedClean === normalizedOriginal;
      const threshold = 0.7;
      const partialLengthOk = cleanTokens.size <= originalTokens.size + 1;
      const subsetCoverage = cleanTokens.size / Math.max(1, originalTokens.size);
      const resultIsSubsetOfOriginal = Array.from(cleanTokens).every(t => originalTokens.has(t)) && subsetCoverage >= 0.75;
      const shouldInclude = yearMatches && (
        exactTitleMatch || resultIsSubsetOfOriginal || (overlapScore >= threshold && partialLengthOk)
      );

      if (shouldInclude) {
        filteredResults.push({
          title: cleanTitle, originalTitle: title,
          link: link.startsWith('http') ? link : `${FSTREAM_BASE_URL}${link}`,
          seasonNumber, year
        });
      }
    });

    return filteredResults;
  } catch (error) {
    console.error(`Erreur lors du filtrage des resultats FStream: ${error.message}`);
    return [];
  }
}

// === Routes ===

// GET /movie/:id
router.get('/movie/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = generateFStreamCacheKey('movie', id);

  try {
    const cachedData = await getFStreamFromCache(cacheKey);
    if (cachedData) {
      await respondWithMovieSources(req, res, cachedData);

      // Background update
      setImmediate(async () => {
        try {
          await getOrCreateFStreamRequest(`${cacheKey}_background`, async () => {
            const tmdbDetails = await getFStreamTMDBDetails(id, 'movie');
            if (!tmdbDetails) return;

            const searchQuery = tmdbDetails.title;
            let searchResults = await searchFStreamDirect(searchQuery);
            let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

            if (filteredResults.length === 0) {
              try {
                const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);
                if (recentMovie) {
                  const players = await getMoviePlayersForUrl(recentMovie.link);
                  if (players.total > 0) {
                    const response = {
                      success: true, source: 'FStream', type: 'movie', tmdb: tmdbDetails,
                      search: { query: tmdbDetails.title, results: 1, bestMatch: { title: recentMovie.title, originalTitle: `${recentMovie.title} (${tmdbDetails.release_date?.split('-')[0]})`, link: recentMovie.link, seasonNumber: null, year: parseInt(tmdbDetails.release_date?.split('-')[0]) } },
                      players: players.organized, total: players.total,
                      metadata: { extractedAt: new Date().toISOString(), backgroundUpdate: true, foundInRecent: true }
                    };
                    await saveFStreamToCache(cacheKey, response);
                    return;
                  }
                }
              } catch (recentError) {
                console.error(`[FSTREAM BACKGROUND] Erreur lors de la recherche dans les recents: ${recentError.message}`);
              }

              const errorResult = { success: false, error: 'Aucun resultat trouve', message: `Aucun contenu trouve pour "${tmdbDetails.title}" sur FStream`, search: { query: tmdbDetails.title, results: 0, checkedRecent: true }, timestamp: new Date().toISOString() };
              await saveFStreamToCache(cacheKey, errorResult);
              return;
            }

            let bestResult = null;
            const tmdbYear = tmdbDetails.release_date?.split('-')[0];

            if (tmdbYear) {
              const yearMatches = filteredResults.filter(result => result.year === parseInt(tmdbYear));
              if (yearMatches.length > 0) {
                bestResult = yearMatches[0];
              } else {
                try {
                  const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);
                  if (recentMovie) {
                    const players = await getMoviePlayersForUrl(recentMovie.link);
                    if (players.total > 0) {
                      const response = {
                        success: true, source: 'FStream', type: 'movie', tmdb: tmdbDetails,
                        search: { query: tmdbDetails.title, results: 1, bestMatch: { title: recentMovie.title, originalTitle: `${recentMovie.title} (${tmdbDetails.release_date?.split('-')[0]})`, link: recentMovie.link, seasonNumber: null, year: parseInt(tmdbDetails.release_date?.split('-')[0]) } },
                        players: players.organized, total: players.total,
                        metadata: { extractedAt: new Date().toISOString(), backgroundUpdate: true, foundInRecent: true }
                      };
                      await saveFStreamToCache(cacheKey, response);
                      return;
                    }
                  }
                } catch (recentError) {
                  console.error(`[FSTREAM BACKGROUND] Erreur lors de la recherche dans les recents: ${recentError.message}`);
                }
                const errorResult = { success: false, error: 'Aucune correspondance d\'annee', message: `Aucun contenu trouve avec l'annee ${tmdbYear} pour "${tmdbDetails.title}" sur FStream`, search: { query: tmdbDetails.title, results: filteredResults.length, year: tmdbYear, checkedRecent: true }, timestamp: new Date().toISOString() };
                await saveFStreamToCache(cacheKey, errorResult);
                return;
              }
            } else {
              bestResult = filteredResults[0];
            }

            if (!bestResult) {
              const errorResult = { success: false, error: 'Aucun resultat valide', message: `Aucun resultat valide trouve pour "${tmdbDetails.title}" sur FStream`, search: { query: tmdbDetails.title, results: filteredResults.length }, timestamp: new Date().toISOString() };
              await saveFStreamToCache(cacheKey, errorResult);
              return;
            }

            const players = await getMoviePlayersForUrl(bestResult.link);
            if (players.total === 0) return;

            const response = {
              success: true, source: 'FStream', type: 'movie', tmdb: tmdbDetails,
              search: { query: searchQuery, results: filteredResults.length, bestMatch: bestResult },
              players: players.organized, total: players.total,
              metadata: { extractedAt: new Date().toISOString(), backgroundUpdate: true }
            };
            await saveFStreamToCache(cacheKey, response);
            return response;
          });
        } catch (error) { /* background error, ignore */ }
      });

      return;
    }

    // No cache - make request with deduplication
    const result = await getOrCreateFStreamRequest(cacheKey, async () => {
      const tmdbDetails = await getFStreamTMDBDetails(id, 'movie');
      if (!tmdbDetails) throw new Error('Contenu TMDB non trouve');

      const searchQuery = tmdbDetails.title;
      let searchResults = await searchFStreamDirect(searchQuery);
      let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

      let bestResult = null;
      const tmdbYear = tmdbDetails.release_date?.split('-')[0];

      if (tmdbYear) {
        const yearMatches = filteredResults.filter(result => result.year === parseInt(tmdbYear));
        if (yearMatches.length > 0) {
          bestResult = yearMatches[0];
        } else {
          const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbYear);
          if (recentMovie) {
            bestResult = { title: recentMovie.title, originalTitle: `${recentMovie.title} (${tmdbYear})`, link: recentMovie.link, seasonNumber: null, year: parseInt(tmdbYear) };
          } else {
            throw new Error(`Aucun resultat trouve avec l'annee ${tmdbYear} sur FStream`);
          }
        }
      } else {
        if (filteredResults.length > 0) bestResult = filteredResults[0];
      }

      if (filteredResults.length === 0 && !bestResult) {
        const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbYear);
        if (recentMovie) {
          bestResult = { title: recentMovie.title, originalTitle: `${recentMovie.title}${tmdbYear ? ` (${tmdbYear})` : ''}`, link: recentMovie.link, seasonNumber: null, year: tmdbYear ? parseInt(tmdbYear) : null };
        } else {
          throw new Error('Aucun resultat trouve sur FStream');
        }
      }

      if (!bestResult) throw new Error('Aucun resultat valide trouve sur FStream');

      const players = await getMoviePlayersForUrl(bestResult.link);
      if (players.total === 0) {
        return res.status(404).json({ error: 'Aucun lecteur video trouve', searchQuery, bestResult: bestResult.title });
      }

      return {
        success: true, source: 'FStream', type: 'movie', tmdb: tmdbDetails,
        search: { query: searchQuery, results: filteredResults.length, bestMatch: bestResult },
        players: players.organized, total: players.total,
        metadata: { extractedAt: new Date().toISOString() }
      };
    });

    await saveFStreamToCache(cacheKey, result);
    await respondWithMovieSources(req, res, result);

  } catch (error) {
    console.error(`[FSTREAM MOVIE] Erreur: ${error.message}`);
    const errorResult = { success: false, error: 'Erreur lors de la recuperation des sources FStream', message: error.message, timestamp: new Date().toISOString() };
    await saveFStreamToCache(cacheKey, errorResult);
    res.status(500).json(errorResult);
  }
});

// GET /movie/:id/clear-cache
router.get('/movie/:id/clear-cache', async (req, res) => {
  const { id } = req.params;
  const cacheKey = generateFStreamCacheKey('movie', id);
  const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    try { const redis = getRedis(); if (redis) await redis.del(`fstream:${cacheKey}`); } catch {}
    console.log(`[FSTREAM Cache] Cache cleared for movie ${id}`);
    res.json({ success: true, message: `Cache cleared for movie ${id}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { const redis = getRedis(); if (redis) await redis.del(`fstream:${cacheKey}`); } catch {}
      res.status(404).json({ error: `No cache found for movie ${id}` });
    } else {
      console.error(`[FSTREAM Cache] Error clearing cache for movie ${id}:`, error.message);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

// GET /tv/:id/season/:season/clear-cache
router.get('/tv/:id/season/:season/clear-cache', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  const cacheKey = generateFStreamCacheKey('tv', id, season, episode || null);
  const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    try { const redis = getRedis(); if (redis) await redis.del(`fstream:${cacheKey}`); } catch {}
    console.log(`[FSTREAM Cache] Cache cleared for tv ${id} S${season}${episode ? ' E' + episode : ''}`);
    res.json({ success: true, message: `Cache cleared for tv ${id} season ${season}${episode ? ' episode ' + episode : ''}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { const redis = getRedis(); if (redis) await redis.del(`fstream:${cacheKey}`); } catch {}
      res.status(404).json({ error: `No cache found for tv ${id} season ${season}` });
    } else {
      console.error(`[FSTREAM Cache] Error clearing cache for tv ${id}:`, error.message);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

// GET /tv/:id/season/:season
router.get('/tv/:id/season/:season', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  const cacheKey = generateFStreamCacheKey('tv', id, season, episode);

  try {
    const cachedData = await getFStreamFromCache(cacheKey);
    const cachedSelectionIsValid = isFStreamCachedSelectionValid(cachedData, season);
    if (cachedData && cachedSelectionIsValid) {
      await respondWithEpisodeSources(req, res, cachedData);

      // Background update
      setImmediate(async () => {
        try {
          await getOrCreateFStreamRequest(`${cacheKey}_background`, async () => {
            const tmdbDetails = await getFStreamTMDBDetails(id, 'tv');
            if (!tmdbDetails) return;

            let searchQuery;
            if (id === '259909') { searchQuery = 'Dexter : Resurrection - Saison 1'; }
            else { searchQuery = `${tmdbDetails.title} - Saison ${season}`; }

            let searchResults = await searchFStreamDirect(searchQuery);
            let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

            if (filteredResults.length === 0) {
              const directSeasonsEarly = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
              if (directSeasonsEarly.length > 0) filteredResults = directSeasonsEarly;

              if (tmdbDetails.release_date) {
                const year = tmdbDetails.release_date.split('-')[0];
                const fallbackQuery = `${tmdbDetails.title} (${year}) - Saison ${season}`;
                try {
                  let fallbackSearchResults = await searchFStreamDirect(fallbackQuery);
                  let fallbackFilteredResults = filterFStreamResults(fallbackSearchResults, tmdbDetails.title, year);
                  if (fallbackFilteredResults.length > 0) filteredResults = fallbackFilteredResults;
                } catch (fallbackError) {
                  console.log(`[FSTREAM TV BACKGROUND] Erreur lors de la recherche de fallback avec annee: ${fallbackError.message}`);
                }
              }

              if (filteredResults.length === 0 && tmdbDetails.name_no_lang && tmdbDetails.name_no_lang !== tmdbDetails.title) {
                const noLangFallbackQuery = `${tmdbDetails.name_no_lang} - Saison ${season}`;
                try {
                  let noLangSearchResults = await searchFStreamDirect(noLangFallbackQuery);
                  let noLangFilteredResults = filterFStreamResults(noLangSearchResults, tmdbDetails.name_no_lang, tmdbDetails.release_date?.split('-')[0]);
                  if (noLangFilteredResults.length > 0) {
                    filteredResults = noLangFilteredResults;
                    console.log(`[FSTREAM TV BACKGROUND] Fallback avec nom sans langue reussi: "${noLangFallbackQuery}"`);
                  }
                } catch (noLangFallbackError) {
                  console.log(`[FSTREAM TV BACKGROUND] Erreur lors de la recherche de fallback avec nom sans langue: ${noLangFallbackError.message}`);
                }
              }

              if (filteredResults.length === 0) {
                const directSeasons = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
                if (directSeasons.length > 0) filteredResults = directSeasons;

                if (filteredResults.length === 0) {
                  const releaseDate = tmdbDetails.release_date;
                  let shouldCheckRecent = false;
                  if (releaseDate) {
                    const releaseDateTime = new Date(releaseDate);
                    const now = new Date();
                    const diffInDays = (now - releaseDateTime) / (1000 * 60 * 60 * 24);
                    if (diffInDays <= 2) shouldCheckRecent = true;
                  }

                  if (shouldCheckRecent) {
                    try {
                      const recentSeries = await findSeriesInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);
                      if (recentSeries) {
                        const players = await getSeriesPlayersForUrl(recentSeries.link);
                        if (players.total > 0) {
                          const response = {
                            success: true, source: 'FStream', type: 'tv', tmdb: tmdbDetails,
                            search: { query: `${tmdbDetails.title} - Saison ${season}`, results: 1, bestMatch: { title: recentSeries.title, originalTitle: `${recentSeries.title} (${tmdbDetails.release_date?.split('-')[0]})`, link: recentSeries.link, seasonNumber: parseInt(season), year: parseInt(tmdbDetails.release_date?.split('-')[0]) } },
                            episodes: players.episodes, total: players.total,
                            metadata: { season: parseInt(season), episode: episode ? parseInt(episode) : null, extractedAt: new Date().toISOString(), backgroundUpdate: true, foundInRecent: true }
                          };
                          await saveFStreamToCache(cacheKey, response);
                          return;
                        }
                      }
                    } catch (recentError) {
                      console.error(`[FSTREAM TV BACKGROUND] Erreur lors de la recherche dans les recents: ${recentError.message}`);
                    }
                  }

                  // Background update: ne pas écraser le cache avec une erreur
                  return;
                }
              }
            }

            const requestedSeason = parseInt(season);
            const bgTmdbYear = tmdbDetails.release_date ? parseInt(tmdbDetails.release_date.split('-')[0]) : null;

            // Trouver tous les resultats correspondant a la saison demandee
            const seasonMatches = filteredResults.filter(result => result.seasonNumber && result.seasonNumber === requestedSeason);
            let bestResult = null;
            if (seasonMatches.length > 1 && bgTmdbYear) {
              bestResult = seasonMatches.find(r => r.year === bgTmdbYear) || seasonMatches[0];
            } else if (seasonMatches.length === 1) {
              bestResult = seasonMatches[0];
            }

            if (!bestResult) {
              const titleSeasonMatches = filteredResults.filter(result => {
                if (result.originalTitle) {
                  const seasonInTitle = result.originalTitle.match(/Saison\s+(\d+)/i);
                  if (seasonInTitle) return parseInt(seasonInTitle[1]) === requestedSeason;
                }
                return false;
              });
              if (titleSeasonMatches.length > 1 && bgTmdbYear) {
                bestResult = titleSeasonMatches.find(r => r.year === bgTmdbYear) || titleSeasonMatches[0];
              } else if (titleSeasonMatches.length === 1) {
                bestResult = titleSeasonMatches[0];
              }
            }

            // Fallback: rechercher sans le numero de saison (FStream retourne parfois des resultats differents)
            if (!bestResult) {
              try {
                const noNumQuery = `${tmdbDetails.title} - Saison`;
                const noNumResults = await searchFStreamDirect(noNumQuery);
                const noNumFiltered = filterFStreamResults(noNumResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);
                const noNumSeasonMatches = noNumFiltered.filter(r => r.seasonNumber === requestedSeason);
                if (noNumSeasonMatches.length > 0) {
                  bestResult = noNumSeasonMatches.length > 1 && bgTmdbYear ? (noNumSeasonMatches.find(r => r.year === bgTmdbYear) || noNumSeasonMatches[0]) : noNumSeasonMatches[0];
                  filteredResults = noNumFiltered;
                  console.log(`[FSTREAM TV BACKGROUND] Fallback sans numero de saison reussi pour "${tmdbDetails.title}" saison ${requestedSeason}`);
                }
              } catch (e) {
                console.log(`[FSTREAM TV BACKGROUND] Erreur fallback sans numero de saison: ${e.message}`);
              }
            }

            // Fallback get_seasons.php: search ne liste pas toujours toutes les saisons.
            if (!bestResult) {
              const newsIdSource = filteredResults.find(r => extractPageIdFromUrl(r.link));
              if (newsIdSource) {
                const ajaxSeasons = await fetchFStreamSeasonsAjax(id, extractPageIdFromUrl(newsIdSource.link), extractBaseUrlFromLink(newsIdSource.link));
                const ajaxMatch = ajaxSeasons.find(r => r.seasonNumber === requestedSeason);
                if (ajaxMatch) bestResult = ajaxMatch;
              }
            }

            if (!bestResult) {
              // Background update: ne pas écraser le cache avec une erreur
              return;
            }

            const players = await getSeriesPlayersForUrl(bestResult.link);
            if (players.total === 0) return;

            let isAvailable = true;
            if (tmdbDetails.release_date) {
              const tmdbYearStr = tmdbDetails.release_date.split('-')[0];
              if (players.fromApi) {
                if (bestResult.year && bestResult.year !== parseInt(tmdbYearStr)) {
                  isAvailable = false;
                }
              } else {
                if (players.fstreamReleaseDate) {
                  if (players.fstreamReleaseDate !== tmdbYearStr) isAvailable = false;
                } else { isAvailable = false; }
              }
            }

            const response = {
              success: isAvailable, source: 'FStream', type: 'tv', tmdb: tmdbDetails,
              search: { query: searchQuery, results: filteredResults.length, bestMatch: bestResult },
              episodes: isAvailable ? players.episodes : {}, total: isAvailable ? players.total : 0,
              metadata: { season: parseInt(season), episode: episode ? parseInt(episode) : null, extractedAt: new Date().toISOString(), backgroundUpdate: true, fstreamReleaseDate: players.fstreamReleaseDate, dateValidation: { fstreamYear: players.fstreamReleaseDate, tmdbYear: tmdbDetails.release_date?.split('-')[0], isAvailable } }
            };
            await saveFStreamToCache(cacheKey, response);
            return response;
          });
        } catch (error) { /* background error, ignore */ }
      });

      return;
    }
    if (cachedData && !cachedSelectionIsValid) {
      console.warn(`[FSTREAM TV] Cache ignore: fiche incompatible avec le titre TMDB pour ${id} S${season}`);
    }

    // No cache
    const result = await getOrCreateFStreamRequest(cacheKey, async () => {
      const tmdbDetails = await getFStreamTMDBDetails(id, 'tv');
      if (!tmdbDetails) throw new Error('Contenu TMDB non trouve');

      let searchQuery;
      if (id === '259909') { searchQuery = 'Dexter : Resurrection - Saison 1'; }
      else { searchQuery = `${tmdbDetails.title} - Saison ${season}`; }

      let searchResults = await searchFStreamDirect(searchQuery);
      let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

      if (filteredResults.length === 0) {
        const directSeasonsEarly = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
        if (directSeasonsEarly.length > 0) { filteredResults = directSeasonsEarly; console.log(`[FSTREAM TV] Requete directe des saisons reussie (ajax - precoce)`); }

        if (tmdbDetails.release_date) {
          const year = tmdbDetails.release_date.split('-')[0];
          const fallbackQuery = `${tmdbDetails.title} (${year}) - Saison ${season}`;
          try {
            let fallbackSearchResults = await searchFStreamDirect(fallbackQuery);
            let fallbackFilteredResults = filterFStreamResults(fallbackSearchResults, tmdbDetails.title, year);
            if (fallbackFilteredResults.length > 0) filteredResults = fallbackFilteredResults;
          } catch (fallbackError) {
            console.log(`[FSTREAM TV] Erreur lors de la recherche de fallback avec annee: ${fallbackError.message}`);
          }
        }

        if (filteredResults.length === 0 && tmdbDetails.name_no_lang && tmdbDetails.name_no_lang !== tmdbDetails.title) {
          const noLangFallbackQuery = `${tmdbDetails.name_no_lang} - Saison ${season}`;
          try {
            let noLangSearchResults = await searchFStreamDirect(noLangFallbackQuery);
            let noLangFilteredResults = filterFStreamResults(noLangSearchResults, tmdbDetails.name_no_lang, tmdbDetails.release_date?.split('-')[0]);
            if (noLangFilteredResults.length > 0) { filteredResults = noLangFilteredResults; console.log(`[FSTREAM TV] Fallback avec nom sans langue reussi: "${noLangFallbackQuery}"`); }
          } catch (noLangFallbackError) {
            console.log(`[FSTREAM TV] Erreur lors de la recherche de fallback avec nom sans langue: ${noLangFallbackError.message}`);
          }
        }

        if (filteredResults.length === 0) {
          const directSeasons = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
          if (directSeasons.length > 0) { filteredResults = directSeasons; console.log(`[FSTREAM TV] Requete directe des saisons reussie (ajax)`); }
        }

        if (filteredResults.length === 0) throw new Error('Aucun resultat trouve sur FStream');
      }

      const requestedSeason = parseInt(season);
      const tmdbYear = tmdbDetails.release_date ? parseInt(tmdbDetails.release_date.split('-')[0]) : null;

      // Trouver tous les resultats correspondant a la saison demandee
      const seasonMatches = filteredResults.filter(result => result.seasonNumber && result.seasonNumber === requestedSeason);

      let bestResult = null;
      if (seasonMatches.length > 1 && tmdbYear) {
        // Prioriser le resultat dont l'annee correspond a l'annee TMDB
        bestResult = seasonMatches.find(r => r.year === tmdbYear) || seasonMatches[0];
      } else if (seasonMatches.length === 1) {
        bestResult = seasonMatches[0];
      }

      if (!bestResult) {
        // Fallback: chercher dans le titre original
        const titleSeasonMatches = filteredResults.filter(result => {
          if (result.originalTitle) {
            const seasonInTitle = result.originalTitle.match(/Saison\s+(\d+)/i);
            if (seasonInTitle) return parseInt(seasonInTitle[1]) === requestedSeason;
          }
          return false;
        });
        if (titleSeasonMatches.length > 1 && tmdbYear) {
          bestResult = titleSeasonMatches.find(r => r.year === tmdbYear) || titleSeasonMatches[0];
        } else if (titleSeasonMatches.length === 1) {
          bestResult = titleSeasonMatches[0];
        }
      }

      // Fallback: rechercher sans le numero de saison (FStream retourne parfois des resultats differents)
      if (!bestResult) {
        try {
          const noNumQuery = `${tmdbDetails.title} - Saison`;
          const noNumResults = await searchFStreamDirect(noNumQuery);
          const noNumFiltered = filterFStreamResults(noNumResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);
          const noNumSeasonMatches = noNumFiltered.filter(r => r.seasonNumber === requestedSeason);
          if (noNumSeasonMatches.length > 0) {
            bestResult = noNumSeasonMatches.length > 1 && tmdbYear ? (noNumSeasonMatches.find(r => r.year === tmdbYear) || noNumSeasonMatches[0]) : noNumSeasonMatches[0];
            filteredResults = noNumFiltered;
            console.log(`[FSTREAM TV] Fallback sans numero de saison reussi pour "${tmdbDetails.title}" saison ${requestedSeason}`);
          }
        } catch (e) {
          console.log(`[FSTREAM TV] Erreur fallback sans numero de saison: ${e.message}`);
        }
      }

      // Fallback get_seasons.php: search.php ne liste pas toujours toutes les saisons.
      // On a au moins une saison trouvee -> son page id sert de news_id, serie_tag = s-<tmdbId>.
      if (!bestResult) {
        const newsIdSource = filteredResults.find(r => extractPageIdFromUrl(r.link));
        if (newsIdSource) {
          const ajaxSeasons = await fetchFStreamSeasonsAjax(id, extractPageIdFromUrl(newsIdSource.link), extractBaseUrlFromLink(newsIdSource.link));
          const ajaxMatch = ajaxSeasons.find(r => r.seasonNumber === requestedSeason);
          if (ajaxMatch) {
            bestResult = ajaxMatch;
            console.log(`[FSTREAM TV] Fallback get_seasons.php reussi: saison ${requestedSeason} pour "${tmdbDetails.title}"`);
          }
        }
      }

      if (!bestResult) {
        const availableSeasons = filteredResults
          .filter(r => r.seasonNumber && r.title.toLowerCase().includes(tmdbDetails.title.toLowerCase().split(/[:\-]/)[0].trim().toLowerCase()))
          .map(r => r.seasonNumber)
          .filter((s, i, arr) => arr.indexOf(s) === i)
          .sort((a, b) => a - b);
        const seasonText = availableSeasons.length > 0
          ? `Saisons disponibles pour "${tmdbDetails.title}": ${availableSeasons.join(', ')}`
          : `Aucune saison trouvee pour "${tmdbDetails.title}"`;
        throw new Error(`Saison ${requestedSeason} non trouvee. ${seasonText}`);
      }

      // Verifier la correspondance d'annee meme quand l'API est utilisee
      if (tmdbYear && bestResult.year && bestResult.year !== tmdbYear) {
        console.log(`[FSTREAM TV] Annee non correspondante: TMDB=${tmdbYear}, FStream=${bestResult.year} pour "${bestResult.title}"`);
      }

      const players = await getSeriesPlayersForUrl(bestResult.link);
      if (players.total === 0) throw new Error('Aucun lecteur video trouve');

      let isAvailable = true;
      if (tmdbDetails.release_date) {
        const tmdbYearStr = tmdbDetails.release_date.split('-')[0];
        if (players.fromApi) {
          // Quand l'API est utilisee, valider via l'annee du resultat de recherche
          if (bestResult.year && bestResult.year !== parseInt(tmdbYearStr)) {
            isAvailable = false;
          }
        } else {
          if (players.fstreamReleaseDate) {
            if (players.fstreamReleaseDate !== tmdbYearStr) isAvailable = false;
          } else { isAvailable = false; }
        }
      }

      return {
        success: isAvailable, source: 'FStream', type: 'tv', tmdb: tmdbDetails,
        search: { query: searchQuery, results: filteredResults.length, bestMatch: bestResult },
        episodes: isAvailable ? players.episodes : {}, total: isAvailable ? players.total : 0,
        metadata: { season: parseInt(season), episode: episode ? parseInt(episode) : null, extractedAt: new Date().toISOString(), fstreamReleaseDate: players.fstreamReleaseDate, dateValidation: { fstreamYear: players.fstreamReleaseDate, tmdbYear: tmdbDetails.release_date?.split('-')[0], isAvailable } }
      };
    });

    await saveFStreamToCache(cacheKey, result);
    await respondWithEpisodeSources(req, res, result);

  } catch (error) {
    console.error(`[FSTREAM TV] Erreur: ${error.message}`);
    const errorResult = { success: false, error: 'Erreur lors de la recuperation des sources FStream', message: error.message, timestamp: new Date().toISOString() };
    await saveFStreamToCache(cacheKey, errorResult);
    res.status(500).json(errorResult);
  }
});

// GET /test/recent
router.get('/test/recent', async (req, res) => {
  try {
    const recentMovies = await scrapeFStreamRecentMovies();
    res.status(200).json({ success: true, count: recentMovies.length, movies: recentMovies.slice(0, 10), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

// GET /test/recent-series
router.get('/test/recent-series', async (req, res) => {
  try {
    const recentSeries = await scrapeFStreamRecentSeries();
    res.status(200).json({ success: true, count: recentSeries.length, series: recentSeries.slice(0, 10), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

// GET /debug/ongoing
router.get('/debug/ongoing', async (req, res) => {
  try {
    const ongoingKeys = Array.from(ongoingFStreamRequests.keys());
    res.status(200).json({ success: true, ongoingRequests: ongoingKeys.length, keys: ongoingKeys, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
