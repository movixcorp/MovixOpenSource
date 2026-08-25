/**
 * France.TV (FTV) routes module.
 * Extracted from server.js -- handles France.TV search, episode listing,
 * and programme/video info extraction.
 *
 * Mounted at /api/ftv  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const { CACHE_DIR, generateCacheKey } = require('../utils/cacheManager');
const {
  encodeSignedToken,
  decodeSignedToken,
  signingConfigured,
} = require('../utils/mediaSigning');

// ===========================================================================================
// ===== FRANCE.TV (FTV) SOURCE — Recherche + épisodes d'une série/collection =====
// ===========================================================================================

const FTV_BASE = 'https://www.france.tv';

// ===========================================================================
//  Jetons France.tv
// ===========================================================================
// Les adresses de pages France.tv font un aller-retour par le navigateur :
// il les reçoit ici, puis les redonne à /episodes, /info et à l'extraction DRM.
// Les confier en clair reviendrait à laisser le client choisir la cible — c'est
// exactement la faille SSRF que le reste du projet vient de fermer.
//
// Chaque URL sort donc emballée dans un jeton signé (`token`), et les endpoints
// n'acceptent plus que ce jeton. Le client transporte, il ne fabrique pas.
//
// Le middleware ci-dessous enveloppe `res.json` une fois pour toutes : il
// couvre les sept endroits qui émettent une `url`, réponses en cache comprises.

const FTV_TOKEN_ROUTE = 'ftv';
const FTV_TOKEN_MAX_DEPTH = 8;

/** Vrai si l'URL vise bien France Télévisions. */
function isFranceTvUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'france.tv' || hostname.endsWith('.france.tv');
  } catch {
    return false;
  }
}

/** Emballe une URL France.tv dans un jeton signé, ou null si elle est hors périmètre. */
function signFtvUrl(url) {
  if (!isFranceTvUrl(url) || !signingConfigured()) return null;
  return encodeSignedToken(FTV_TOKEN_ROUTE, url);
}

/** Déballe un jeton et vérifie que la cible reste une URL France.tv. */
function resolveFtvToken(token) {
  const url = decodeSignedToken(FTV_TOKEN_ROUTE, token);
  return isFranceTvUrl(url) ? url : null;
}

/** Ajoute un `token` à côté de chaque `url` France.tv de la charge utile. */
function attachFtvTokens(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > FTV_TOKEN_MAX_DEPTH) return payload;

  if (Array.isArray(payload)) {
    return payload.map((item) => attachFtvTokens(item, depth + 1));
  }

  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = attachFtvTokens(value, depth + 1);
  }

  for (const field of ['url', 'program_url']) {
    if (typeof payload[field] === 'string' && !out[`${field}_token`]) {
      const token = signFtvUrl(payload[field]);
      if (token) out[`${field}_token`] = token;
    }
  }

  return out;
}

router.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (payload) => sendJson(attachFtvTokens(payload));
  next();
});

// --- FTV: Cache du next-action hash (TTL 30 min) ---
let ftvNextActionHash = null;
let ftvNextActionExpiry = 0;

// Headers complets pour simuler un vrai navigateur Chrome sur france.tv
const FTV_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let getFromCacheWithExpiration;
let saveToCache;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.getFromCacheWithExpiration) getFromCacheWithExpiration = deps.getFromCacheWithExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
}

// ---------------------------------------------------------------------------
// getFtvNextActionHash -- dynamically retrieve the Next.js server action hash
// ---------------------------------------------------------------------------
/**
 * Récupère dynamiquement le hash next-action depuis la page /recherche/.
 * Ce hash change à chaque redéploiement de france.tv (Next.js Server Actions).
 *
 * Étapes :
 * 1. GET https://www.france.tv/recherche/
 * 2. Fallback rapide : essayer d'extraire $ACTION_ID_HASH inliné dans le HTML
 * 3. Sinon, scanner TOUS les chunks /_next/static/chunks/*.js en parallèle
 *    et chercher createServerReference("HASH", ..., "searchAction") dans chacun.
 *    On exige le marqueur "searchAction" pour ne pas confondre avec les autres
 *    Server Actions que Turbopack peut grouper dans le même chunk.
 *
 * Retente jusqu'à 3 fois en cas d'échec réseau.
 */
async function getFtvNextActionHash() {
  const now = Date.now();
  if (ftvNextActionHash && now < ftvNextActionExpiry) {
    return ftvNextActionHash;
  }

  const MAX_RETRIES = 3;
  const SEARCH_ACTION_RE = /createServerReference\)?\s*\(\s*"([a-f0-9]{40,})"[^)]*?"searchAction"/;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[FTV] Fetching next-action hash (attempt ${attempt}/${MAX_RETRIES}, direct) ...`);

    try {
      const pageResponse = await axios.get(`${FTV_BASE}/recherche/`, {
        headers: { ...FTV_BROWSER_HEADERS },
        proxy: false,
        timeout: 15000,
        maxRedirects: 5,
      });

      const html = pageResponse.data;
      let hash = null;

      // Fast path: hash inliné dans le HTML (certains layouts Next.js le font)
      const inlineMatch = html.match(/\$ACTION_ID_([a-f0-9]{40,})/);
      if (inlineMatch) {
        hash = inlineMatch[1];
        console.log(`[FTV] Found next-action hash inline in HTML: ${hash}`);
      }

      if (!hash) {
        // Lister TOUS les chunks JS — Turbopack ne respecte plus la structure /app/PAGE/page-HASH.js
        const chunkUrls = [...new Set(
          [...html.matchAll(/<script[^>]+src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)]
            .map((m) => m[1])
        )];
        console.log(`[FTV] Scanning ${chunkUrls.length} chunks for searchAction reference...`);

        const results = await Promise.allSettled(chunkUrls.map(async (url) => {
          const res = await axios.get(`${FTV_BASE}${url}`, {
            headers: {
              'User-Agent': FTV_BROWSER_HEADERS['User-Agent'],
              'Accept': '*/*',
              'Accept-Language': 'fr-FR,fr;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Referer': `${FTV_BASE}/recherche/`,
              'Sec-Ch-Ua': FTV_BROWSER_HEADERS['Sec-Ch-Ua'],
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Windows"',
              'Sec-Fetch-Dest': 'script',
              'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin',
            },
            proxy: false,
            timeout: 10000,
          });
          const m = (typeof res.data === 'string' ? res.data : '').match(SEARCH_ACTION_RE);
          return m ? m[1] : null;
        }));

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            hash = r.value;
            console.log(`[FTV] Found next-action hash in chunk: ${hash}`);
            break;
          }
        }
      }

      if (hash) {
        ftvNextActionHash = hash;
        ftvNextActionExpiry = now + 30 * 60 * 1000; // Cache 30 min
        return hash;
      }

      console.warn(`[FTV] Attempt ${attempt}: could not extract hash from page or chunks`);
    } catch (err) {
      console.error(`[FTV] Attempt ${attempt} failed (direct): ${err.response?.status || err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  console.warn('[FTV] Could not extract next-action hash after all retries');
  return null;
}

// ---------------------------------------------------------------------------
// POST /search
// Body: { "query": "ninjago" }
// Recherche sur france.tv et renvoie les programmes (séries/collections) et vidéos individuelles.
// ---------------------------------------------------------------------------
router.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Le paramètre "query" est requis' });
    }

    const searchTerm = query.trim();

    // Check cache (1h expiration for search)
    const cacheKey = generateCacheKey(`ftv_search_${searchTerm.toLowerCase()}`);
    const cached = await getFromCacheWithExpiration(CACHE_DIR.FTV, cacheKey, 1);
    if (cached) {
      console.log(`[FTV] Search cache hit for "${searchTerm}"`);
      return res.json(cached);
    }

    // Récupérer dynamiquement le hash next-action (change à chaque déploiement de france.tv)
    const nextActionHash = await getFtvNextActionHash();
    if (!nextActionHash) {
      return res.status(502).json({ success: false, error: 'Impossible de récupérer le hash de recherche France.tv. Le site a peut-être changé.' });
    }

    console.log(`[FTV] Using next-action hash: ${nextActionHash}`);

    const response = await axios.post(`${FTV_BASE}/recherche/`, [searchTerm], {
      headers: {
        'accept': 'text/x-component',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': nextActionHash,
        'next-router-state-tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22recherche%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
        'origin': FTV_BASE,
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': `${FTV_BASE}/recherche/`,
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': FTV_BROWSER_HEADERS['User-Agent'],
      },
      proxy: false,
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log(`[FTV] Search response status: ${response.status}`);
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    console.log(`[FTV] Response text length: ${text.length}`);

    // Si 404, le hash a expiré entre-temps, forcer un refresh
    if (response.status === 404) {
      console.warn('[FTV] Got 404 — next-action hash is stale, invalidating cache...');
      ftvNextActionHash = null;
      ftvNextActionExpiry = 0;
      return res.json({ success: true, programs: [], videos: [], error_hint: 'Hash expiré, réessayez' });
    }

    // Parse RSC streaming format: lines like "1:{...json...}"
    const lines = text.split('\n');
    let searchData = null;
    for (const line of lines) {
      if (line.trim()) console.log(`[FTV] RSC Line prefix: ${line.substring(0, 10)}...`);
      // Chercher la ligne de données — peut commencer par 1:, 2:, etc.
      const dataMatch = line.match(/^(\d+):\s*(\{.+)/);
      if (dataMatch) {
        console.log(`[FTV] Found data line starting with ${dataMatch[1]}: (length ${line.length})`);
        try {
          const parsed = JSON.parse(dataMatch[2]);
          // Le résultat de recherche contient taxonomy et/ou video
          if (parsed.taxonomy || parsed.video) {
            searchData = parsed;
            console.log(`[FTV] Parsed success. Taxonomy items: ${parsed.taxonomy ? parsed.taxonomy.length : 0}, Videos: ${parsed.video ? parsed.video.length : 0}`);
            break;
          }
        } catch (e) {
          console.error(`[FTV] JSON Parse error on line ${dataMatch[1]}:: ${e.message}`);
        }
      }
    }

    if (!searchData) {
      console.log('[FTV] No searchData found in RSC response lines.');
      // Log premiers 500 chars pour debug
      console.log(`[FTV] Response preview: ${text.substring(0, 500)}`);
      return res.json({ success: true, programs: [], videos: [] });
    }

    // Extract programs from taxonomy array
    const programs = (searchData.taxonomy || [])
      .filter(item => item.content && item.content.url)
      .map(item => ({
        title: item.content.title || '',
        description: item.content.description || '',
        url: `${FTV_BASE}${item.content.url}`,
        thumbnail: item.content.thumbnail?.x2 || item.content.thumbnail?.x1 || null,
        type: item.content.type || 'program', // "program" or "collection"
        channel: item.content.channel || null,
        category: item.content.category?.label || null,
        program_id: item.tracking?.program_id || null,
      }));

    // Extract videos (individual episodes / films)
    const videos = (searchData.video || [])
      .filter(item => item.content && item.content.url)
      .map(item => ({
        title: item.content.title || '',
        titleLeading: item.content.titleLeading || '',
        description: item.content.description || '',
        url: `${FTV_BASE}${item.content.url}`,
        thumbnail: item.content.thumbnail?.x2 || item.content.thumbnail?.x1 || null,
        type: item.content.type || 'video',
        channel: item.content.channel || null,
        category: item.content.category?.label || null,
        id: item.content.id || null,
        season: item.content.title?.match(/^S(\d+)/)?.[1] || null,
        episode: item.content.title?.match(/E(\d+)/)?.[1] || null,
        csa: item.content.csa || null,
        caption: item.content.caption || null,
      }));

    console.log(`[FTV] Search results - Programs: ${programs.length}, Videos: ${videos.length}`);
    const searchResult = { success: true, programs, videos };
    await saveToCache(CACHE_DIR.FTV, cacheKey, searchResult);
    return res.json(searchResult);

  } catch (error) {
    console.error('[FTV] Search error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /episodes?url=https://www.france.tv/france-3/lego-ninjago
// Récupère la page d'un programme et extrait tous les épisodes disponibles.
// Retourne la liste des épisodes avec leur URL d'extraction.
// ---------------------------------------------------------------------------
router.get('/episodes', async (req, res) => {
  try {
    // Jeton uniquement : l'ancien `?url=` se contentait d'un
    // `url.includes('france.tv')`, que `https://interne.exemple/france.tv`
    // satisfaisait — le client pouvait donc désigner n'importe quelle cible.
    const url = resolveFtvToken(req.query.token);
    if (!url) {
      return res.status(400).json({ success: false, error: 'Jeton France.tv invalide ou expiré' });
    }

    // Check cache (4h expiration for episodes)
    const epCacheKey = generateCacheKey(`ftv_episodes_${url}`);
    const epCached = await getFromCacheWithExpiration(CACHE_DIR.FTV, epCacheKey, 4);
    if (epCached) {
      console.log(`[FTV] Episodes cache hit for ${url}`);
      return res.json(epCached);
    }

    const response = await axios.get(url, {
      headers: { ...FTV_BROWSER_HEADERS },
      proxy: false,
      timeout: 15000,
    });

    const html = response.data;
    const episodes = [];
    const seen = new Set();

    // Extract JSON data from self.__next_f.push() calls in the HTML
    const scriptRegex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
    let scriptMatch;
    let fullJsonText = '';

    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      // Unescape the string content
      let chunk = scriptMatch[1];
      try {
        // The content is JSON-escaped (\\", \\n, \\u00xx, etc.)
        chunk = JSON.parse(`"${chunk}"`);
      } catch { /* use as-is */ }
      fullJsonText += chunk;
    }

    // Most reliable: extract via Cheerio + script parsing
    const $ = cheerio.load(html);

    // Gather ALL text from __next_f scripts
    let allScriptData = '';
    $('script').each((_, el) => {
      const raw = $(el).html() || '';
      if (raw.includes('__next_f')) {
        const pushMatch = raw.match(/self\.__next_f\.push\(\[1,"(.*)"\]\)/s);
        if (pushMatch) {
          try {
            allScriptData += JSON.parse(`"${pushMatch[1]}"`);
          } catch {
            allScriptData += pushMatch[1];
          }
        }
      }
    });

    // Now parse the concatenated text to find video objects
    // Split by "variant" which marks the end of each card object
    const cardChunks = allScriptData.split('"variant"');

    for (const chunk of cardChunks) {
      // Check if this chunk has a video-type content with a .html URL
      if (!chunk.includes('"type":"video"') && !chunk.includes('"type": "video"')) continue;

      const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
      if (!urlMatch) continue;

      const epUrl = urlMatch[1];
      if (seen.has(epUrl)) continue;
      seen.add(epUrl);

      // Extract fields from this chunk
      const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
      const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
      const descMatch = chunk.match(/"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
      const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/medias\.france\.tv\/[^"]+)"/);
      const idMatch = chunk.match(/"id"\s*:\s*(\d{4,})/);
      const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);

      const title = titleMatch ? titleMatch[1] : '';
      const seasonMatch = title.match(/^S(\d+)/);
      const episodeMatch = title.match(/E(\d+)/);

      let desc = descMatch ? descMatch[1] : '';
      try { desc = JSON.parse(`"${desc}"`); } catch { /* use as-is */ }

      episodes.push({
        title: title,
        program: leadMatch ? leadMatch[1] : '',
        description: desc,
        url: `${FTV_BASE}${epUrl}`,
        thumbnail: thumbMatch ? thumbMatch[1] : null,
        id: idMatch ? parseInt(idMatch[1]) : null,
        season: seasonMatch ? parseInt(seasonMatch[1]) : null,
        episode: episodeMatch ? parseInt(episodeMatch[1]) : null,
        csa: csaMatch ? csaMatch[1] : null,
      });
    }

    // Sort by season then episode
    episodes.sort((a, b) => {
      if (a.season !== b.season) return (a.season || 0) - (b.season || 0);
      return (a.episode || 0) - (b.episode || 0);
    });

    const episodesResult = {
      success: true,
      program_url: url,
      total: episodes.length,
      episodes,
    };
    await saveToCache(CACHE_DIR.FTV, epCacheKey, episodesResult);
    return res.json(episodesResult);

  } catch (error) {
    console.error('[FTV] Episodes error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// fetchSeasonEpisodesViaDeepPage -- récupère TOUS les épisodes d'une saison
// via l'API JSON publique deep-page (celle du bouton "Afficher plus").
// La page programme n'embarque côté serveur qu'UNE carte par saison ; le
// reste est chargé côté client via ce même endpoint.
// seasonPath: "/france-4/sous-les-mers/saison-4" -> slug "france-4_sous-les-mers_saison-4"
// ---------------------------------------------------------------------------
async function fetchSeasonEpisodesViaDeepPage(seasonPath, seasonNum) {
  const slug = seasonPath.replace(/^\/+|\/+$/g, '').split('/').join('_');
  const episodes = [];
  const seen = new Set();
  let page = 0;

  for (let i = 0; i < 20; i++) { // garde-fou : 20 pages x 100 = 2000 épisodes max
    const apiUrl = `${FTV_BASE}/api/deep-page/?slug=${encodeURIComponent(slug)}&type=season&page=${page}`
      + '&filter=only-visible&filter=with-no-vod&filter=only-replay&size=100&sort=episode%3Aasc';
    const { data } = await axios.get(apiUrl, {
      headers: { ...FTV_BROWSER_HEADERS, 'Accept': 'application/json' },
      proxy: false,
      timeout: 15000,
    });

    const items = Array.isArray(data?.result) ? data.result : [];
    for (const item of items) {
      const c = item?.content || {};
      const t = item?.tracking || {};
      if (c.type !== 'video' || !c.url) continue;
      if (seen.has(c.url)) continue;
      seen.add(c.url);

      const title = c.title || '';
      const epNumMatch = title.match(/E(\d+)/);

      episodes.push({
        title,
        program: '',
        description: c.description || '',
        url: `${FTV_BASE}${c.url}`,
        thumbnail: c.images?.base?.x2 || c.images?.base?.x1 || null,
        contentId: c.id || t.content_id || null,
        videoId: t.video_factory_id || null,
        season: seasonNum,
        episode: epNumMatch ? parseInt(epNumMatch[1]) : null,
        csa: c.csa || null,
        duration: c.duration || null,
      });
    }

    const next = data?.cursor?.next;
    if (next === null || next === undefined || next === page) break;
    page = next;
  }

  episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
  return episodes;
}

// ---------------------------------------------------------------------------
// GET /info?url=https://www.france.tv/france-5/le-monde-de-jamy/...
// Récupère les informations d'une page film (player) ou série (programme).
// Détecte automatiquement le type de page et retourne les données structurées.
// ---------------------------------------------------------------------------
router.get('/info', async (req, res) => {
  try {
    // Jeton uniquement — voir /episodes.
    const url = resolveFtvToken(req.query.token);
    if (!url) {
      return res.status(400).json({ success: false, error: 'Jeton France.tv invalide ou expiré' });
    }

    // Check cache (4h expiration for info)
    const infoCacheKey = generateCacheKey(`ftv_info_${url}`);
    const infoCached = await getFromCacheWithExpiration(CACHE_DIR.FTV, infoCacheKey, 4);
    if (infoCached) {
      console.log(`[FTV] Info cache hit for ${url}`);
      return res.json(infoCached);
    }

    const response = await axios.get(url, {
      headers: { ...FTV_BROWSER_HEADERS },
      proxy: false,
      timeout: 15000,
    });

    const html = response.data;

    // ---- Extract all RSC data from self.__next_f.push() calls ----
    const pushRegex = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
    let allRscText = '';
    let pushMatch;
    while ((pushMatch = pushRegex.exec(html)) !== null) {
      let chunk = pushMatch[1];
      try { chunk = JSON.parse(`"${chunk}"`); } catch { /* use as-is */ }
      allRscText += chunk;
    }

    // ---- Detect page type ----
    const isPlayer = /"pageType"\s*:\s*"player"/.test(allRscText) || /data-template-id="player-replay"/.test(html);
    const isProgramme = /"pageType"\s*:\s*"programme"/.test(allRscText) || /data-template-id="programme"/.test(html);

    if (isPlayer) {
      // ===== FILM / VIDEO PAGE =====
      const result = { success: true, type: 'video' };

      // Extract title - try JSON-LD VideoObject first
      const ldJsonRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
      let ldMatch;
      while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          if (ld['@type'] === 'VideoObject') {
            result.title = ld.name || '';
            result.description = ld.description || '';
            result.thumbnail = (ld.thumbnailUrl && ld.thumbnailUrl[0]) || '';
            result.duration = ld.duration || '';
            result.director = ld.director ? (ld.director.name || ld.director) : '';
            result.uploadDate = ld.uploadDate || '';
            result.expires = ld.expires || '';
            break;
          }
        } catch { /* skip invalid JSON-LD */ }
      }

      // Extract additional fields from RSC data
      const csaMatch = allRscText.match(/"csaCode"\s*:\s*"([^"]+)"/);
      result.csa = csaMatch ? csaMatch[1] : null;

      const channelMatch = allRscText.match(/"broadcastChannel"\s*:\s*"([^"]+)"/);
      result.channel = channelMatch ? channelMatch[1] : null;
      if (!result.channel) {
        const ch2 = allRscText.match(/"channel"\s*:\s*"([^"]+)"/);
        result.channel = ch2 ? ch2[1] : null;
      }

      // Extract title from RSC if not from JSON-LD
      if (!result.title) {
        const titleMatch = allRscText.match(/"pageName"\s*:\s*"([^"]+)"/);
        result.title = titleMatch ? titleMatch[1].replace(/_/g, ' ') : '';
      }

      // Extract description from RSC if not from JSON-LD
      if (!result.description) {
        const descMatch = allRscText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (descMatch) {
          try { result.description = JSON.parse(`"${descMatch[1]}"`); }
          catch { result.description = descMatch[1]; }
        }
      }

      // Extract thumbnail from RSC if not from JSON-LD
      if (!result.thumbnail) {
        const thumbMatch = allRscText.match(/"vignette_16x9"[^}]*?"1800"\s*:\s*"([^"]+)"/);
        result.thumbnail = thumbMatch ? thumbMatch[1] : null;
        if (!result.thumbnail) {
          const thumbAlt = allRscText.match(/https:\/\/medias\.france\.tv\/[^"]+\.jpg/);
          result.thumbnail = thumbAlt ? thumbAlt[0] : null;
        }
      }

      // Extract duration in seconds from RSC if available
      const durationSecMatch = allRscText.match(/"duration"\s*:\s*(\d{2,})/);
      result.durationSeconds = durationSecMatch ? parseInt(durationSecMatch[1]) : null;

      // Extract program name
      const progMatch = allRscText.match(/"programName"\s*:\s*"([^"]+)"/);
      result.program = progMatch ? progMatch[1].replace(/_/g, ' ') : null;

      // Extract categories
      const catMatch = allRscText.match(/"categories"\s*:\s*\["([^"]+)"\]/);
      result.category = catMatch ? catMatch[1] : null;

      await saveToCache(CACHE_DIR.FTV, infoCacheKey, result);
      return res.json(result);
    } else if (isProgramme) {
      // ===== SÉRIE / PROGRAMME PAGE =====
      const result = { success: true, type: 'programme' };

      // Extract programme title from <title> tag or RSC
      const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
      result.title = titleTagMatch ? titleTagMatch[1].replace(/ - (Regarder|France \d|France\.tv).*$/i, '').trim() : '';

      // Extract description
      const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
      result.description = metaDescMatch ? metaDescMatch[1] : '';

      // Try to get full description from RSC if meta one is truncated
      if (result.description.endsWith('...') || result.description.endsWith('\u2026') || result.description.length < 150) {
        const rscDescMatch = allRscText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (rscDescMatch) {
          try {
            const parsedDesc = JSON.parse(`"${rscDescMatch[1]}"`);
            if (parsedDesc.length > result.description.length) {
              result.description = parsedDesc;
            }
          } catch {
            if (rscDescMatch[1].length > result.description.length) {
              result.description = rscDescMatch[1];
            }
          }
        }
      }

      // Extract thumbnail from og:image
      const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
      result.thumbnail = ogImageMatch ? ogImageMatch[1] : null;

      // Extract channel
      const channelMatch = allRscText.match(/"channel"\s*:\s*"([^"]+)"/);
      result.channel = channelMatch ? channelMatch[1] : null;

      // Extract program_id
      const progIdMatch = allRscText.match(/"program_id"\s*:\s*"(\d+)"/);
      result.programId = progIdMatch ? progIdMatch[1] : null;

      // Extract category
      const catMatch = allRscText.match(/"category"\s*:\s*"([^"]+)"/);
      result.category = catMatch ? catMatch[1] : null;

      // ---- Extract cast/crew from RSC text ----
      const directorMatch = allRscText.match(/R\u00e9alis\u00e9 par\s*:\s*([^"\\]+)/);
      result.director = directorMatch ? directorMatch[1].trim() : null;

      const castMatch = allRscText.match(/Avec\s*:\s*([^"\\]+)/);
      result.cast = castMatch ? castMatch[1].trim() : null;

      // ---- Extract seasons and episodes ----
      const seasons = [];
      const $ = cheerio.load(html);

      // Gather ALL text from __next_f scripts
      let allScriptData = '';
      $('script').each((_, el) => {
        const raw = $(el).html() || '';
        if (raw.includes('__next_f')) {
          const pm = raw.match(/self\.__next_f\.push\(\[1,"(.*)"\]\)/s);
          if (pm) {
            try { allScriptData += JSON.parse(`"${pm[1]}"`); }
            catch { allScriptData += pm[1]; }
          }
        }
      });

      // More robust approach: split by "Saison" markers and extract episode blocks
      const seasonSplits = allScriptData.split(/(?=\["Saison\s+\d+")/);

      for (const block of seasonSplits) {
        const nameMatch = block.match(/^\["(Saison\s+\d+)"/);
        if (!nameMatch) continue;

        const seasonName = nameMatch[1];
        const seasonNum = parseInt(seasonName.match(/\d+/)[0]);
        const blockEpisodes = [];
        const blockSeen = new Set();

        // Split by "variant" to find individual episode cards
        const cardChunks = block.split('"variant"');

        for (const chunk of cardChunks) {
          if (!chunk.includes('"type":"video"')) continue;

          const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
          if (!urlMatch) continue;

          const epUrl = urlMatch[1];
          if (blockSeen.has(epUrl)) continue;
          blockSeen.add(epUrl);

          const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
          const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
          const descMatch = chunk.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/[^"]+)"/);
          const idMatch = chunk.match(/"content_id"\s*:\s*(\d+)/);
          let idMatch2;
          if (!idMatch) {
            idMatch2 = chunk.match(/"id"\s*:\s*(\d{4,})/);
          }
          const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);
          const durationMatch = chunk.match(/"duration"\s*:\s*"([^"]+)"/);
          const vfIdMatch = chunk.match(/"video_factory_id"\s*:\s*"([0-9a-f-]{36})"/);

          const title = titleMatch ? titleMatch[1] : '';
          const epNumMatch = title.match(/E(\d+)/);

          let desc = descMatch ? descMatch[1] : '';
          try { desc = JSON.parse(`"${desc}"`); } catch { /* use as-is */ }

          blockEpisodes.push({
            title,
            program: leadMatch ? leadMatch[1] : '',
            description: desc,
            url: `${FTV_BASE}${epUrl}`,
            thumbnail: thumbMatch ? thumbMatch[1] : null,
            contentId: (idMatch ? parseInt(idMatch[1]) : (idMatch2 ? parseInt(idMatch2[1]) : null)),
            videoId: vfIdMatch ? vfIdMatch[1] : null,
            season: seasonNum,
            episode: epNumMatch ? parseInt(epNumMatch[1]) : null,
            csa: csaMatch ? csaMatch[1] : null,
            duration: durationMatch ? durationMatch[1] : null,
          });
        }

        // Sort episodes by episode number
        blockEpisodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));

        if (blockEpisodes.length > 0) {
          seasons.push({
            name: seasonName,
            number: seasonNum,
            episodeCount: blockEpisodes.length,
            episodes: blockEpisodes,
          });
        }
      }

      // La page programme n'embarque qu'UNE carte par saison dans le payload
      // RSC serveur (le reste est lazy-loadé). On complète chaque saison via
      // l'API deep-page ; en cas d'échec on garde les épisodes extraits du RSC.
      await Promise.all(seasons.map(async (s) => {
        const firstEp = s.episodes[0];
        if (!firstEp || !firstEp.url) return;
        try {
          const epPath = new URL(firstEp.url).pathname;       // /france-4/.../saison-4/123-x.html
          const seasonPath = epPath.replace(/\/[^/]*$/, '');  // /france-4/.../saison-4
          if (!seasonPath) return;
          const fullEpisodes = await fetchSeasonEpisodesViaDeepPage(seasonPath, s.number);
          if (fullEpisodes.length > s.episodes.length) {
            s.episodes = fullEpisodes;
            s.episodeCount = fullEpisodes.length;
          }
        } catch (e) {
          console.warn(`[FTV] deep-page failed for ${s.name}: ${e.message}`);
        }
      }));

      // If no seasons found with the split approach, try the card-based approach from /episodes
      if (seasons.length === 0) {
        const fallbackEpisodes = [];
        const fallbackSeen = new Set();
        const cardChunks = allScriptData.split('"variant"');

        for (const chunk of cardChunks) {
          if (!chunk.includes('"type":"video"')) continue;
          const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
          if (!urlMatch) continue;
          const epUrl = urlMatch[1];
          if (fallbackSeen.has(epUrl)) continue;
          fallbackSeen.add(epUrl);

          const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
          const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
          const descMatch = chunk.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/[^"]+)"/);
          const idMatch = chunk.match(/"content_id"\s*:\s*(\d+)/) || chunk.match(/"id"\s*:\s*(\d{4,})/);
          const vfIdMatch = chunk.match(/"video_factory_id"\s*:\s*"([0-9a-f-]{36})"/);
          const durationMatch = chunk.match(/"duration"\s*:\s*"([^"]+)"/);
          const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);
          const title = titleMatch ? titleMatch[1] : '';

          let desc = descMatch ? descMatch[1] : '';
          try { desc = JSON.parse(`"${desc}"`); } catch {}

          const seasonMatch = title.match(/S(\d+)/);
          const epMatch = title.match(/E(\d+)/);

          fallbackEpisodes.push({
            title,
            program: leadMatch ? leadMatch[1] : '',
            description: desc,
            url: `${FTV_BASE}${epUrl}`,
            thumbnail: thumbMatch ? thumbMatch[1] : null,
            contentId: idMatch ? parseInt(idMatch[1]) : null,
            videoId: vfIdMatch ? vfIdMatch[1] : null,
            season: seasonMatch ? parseInt(seasonMatch[1]) : null,
            episode: epMatch ? parseInt(epMatch[1]) : null,
            csa: csaMatch ? csaMatch[1] : null,
            duration: durationMatch ? durationMatch[1] : null,
          });
        }

        if (fallbackEpisodes.length > 0) {
          // Group by season
          const seasonMap = {};
          for (const ep of fallbackEpisodes) {
            const sNum = ep.season || 1;
            if (!seasonMap[sNum]) seasonMap[sNum] = [];
            seasonMap[sNum].push(ep);
          }
          for (const [sNum, eps] of Object.entries(seasonMap)) {
            eps.sort((a, b) => (a.episode || 0) - (b.episode || 0));
            seasons.push({
              name: `Saison ${sNum}`,
              number: parseInt(sNum),
              episodeCount: eps.length,
              episodes: eps,
            });
          }
          seasons.sort((a, b) => a.number - b.number);
        }
      }

      result.seasons = seasons;
      result.totalEpisodes = seasons.reduce((sum, s) => sum + s.episodeCount, 0);

      await saveToCache(CACHE_DIR.FTV, infoCacheKey, result);
      return res.json(result);

    } else {
      // Unknown page type
      return res.json({
        success: false,
        error: 'Type de page non reconnu (ni player ni programme)',
        hint: 'Vérifiez que l\'URL pointe vers un film/vidéo ou une série sur france.tv',
      });
    }

  } catch (error) {
    console.error('[FTV] Info error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

console.log('FTV (france.tv) source loaded');

module.exports = router;
module.exports.configure = configure;
module.exports.getFtvNextActionHash = getFtvNextActionHash;
