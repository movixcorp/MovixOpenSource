/**
 * VoirDrama routes module.
 * Extracted from server.js -- handles drama TV series search and source extraction
 * from the VoirDrama website.
 *
 * Mounted at /api/drama  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const cheerio = require('cheerio');
const { generateCacheKey } = require('../utils/cacheManager');
const { respondWithResolvedSources } = require('../utils/embedExtraction');

// VoirDrama ne sépare pas les langues : `data` est un tableau plat de lecteurs
// dont l'URL vit dans `link`. La route sert déjà UN épisode par appel
// (`?season=&episode=` obligatoires), donc rien à cibler en plus.
const respondWithSources = (req, res, payload) =>
  respondWithResolvedSources(req, res, payload, { movieMapKey: 'data', label: 'VOIRDRAMA' });
const { fetchTmdbDetails } = require('../utils/tmdbCache');

// === VOIRDRAMA CONFIGURATION ===
const VOIRDRAMA_BASE_URL = 'https://voirdrama.to';

// Impit — remplacement de got-scraping (Rust TLS fingerprint + HTTP/2 natif, pas de http2-wrapper)
let impitClient = null;
async function getImpitClient() {
  if (!impitClient) {
    const { Impit } = await import('impit');
    impitClient = new Impit({ browser: 'chrome' });
  }
  return impitClient;
}

async function impitFetch(url, options = {}) {
  const client = await getImpitClient();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await client.fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { statusCode: response.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let TMDB_API_KEY;
let TMDB_API_URL;
let getFromCacheNoExpiration;
let saveToCache;
let shouldUpdateCache24h;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.TMDB_API_KEY) TMDB_API_KEY = deps.TMDB_API_KEY;
  if (deps.TMDB_API_URL) TMDB_API_URL = deps.TMDB_API_URL;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.shouldUpdateCache24h) shouldUpdateCache24h = deps.shouldUpdateCache24h;
}

// ---------------------------------------------------------------------------
// fetchDramaTvData -- search VoirDrama and extract episode sources
// ---------------------------------------------------------------------------
async function fetchDramaTvData(tmdbId, season, episode) {
  try {
    // 1. Get Series Name from TMDB (cached via Redis)
    const tmdbData = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, 'tv', 'fr-FR');
    if (!tmdbData) throw new Error('TMDB data not found');

    const showName = tmdbData.name;
    const seasonInt = parseInt(season);
    const tmdbSeasons = tmdbData.seasons || [];
    const targetSeason = tmdbSeasons.find(s => s.season_number === seasonInt);
    const firstAirDate = (targetSeason && targetSeason.air_date) || tmdbData.first_air_date;

    // 2. Construct Search Query
    // Si c'est saison 1, tu prends le nom direct, si c'est saison 2, 3 etc, tu mets ex : Culinary Class Wars 2
    let searchQuery = showName;
    if (parseInt(season) > 1) {
      searchQuery += ` ${season}`;
    }

    // 3. Search on Voirdrama
    const formData = new URLSearchParams();
    formData.append('action', 'ajaxsearchpro_search');
    formData.append('aspp', searchQuery);
    formData.append('asid', '7');
    formData.append('asp_inst_id', '7_1');
    formData.append('options', 'aspf[vf__1]=vf&asp_gen[]=excerpt&asp_gen[]=content&asp_gen[]=title&filters_initial=1&filters_changed=0&qtranslate_lang=0&current_page_id=510');

    const searchResponse = await impitFetch(`${VOIRDRAMA_BASE_URL}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      body: formData.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'referer': VOIRDRAMA_BASE_URL + '/',
      },
    });

    // 4. Parse Search Result
    const rawData = searchResponse.body;
    // Extract HTML part between markers
    // ___ASPSTART_HTML___ ... ___ASPEND_HTML___
    const htmlMatch = rawData.match(/___ASPSTART_HTML___([\s\S]*?)___ASPEND_HTML___/);

    if (!htmlMatch) {
      console.log(`[VOIRDRAMA] Structure de réponse de recherche invalide ou pas de résultats HTML (statusCode=${searchResponse.statusCode}, bodyLength=${rawData?.length}, body=${rawData?.substring(0, 500)})`);
      return { success: false, error: 'Film/Série non trouvé sur Voirdrama' };
    }

    const $ = cheerio.load(htmlMatch[1]);

    let bestLink = null;
    let fallbackLink = $('div.asp_content h3 a.asp_res_url').first().attr('href');

    if (!firstAirDate) {
      bestLink = fallbackLink;
    } else {
      // Month map for parsing "Dec 12, 2025"
      const monthsMap = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
        'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };

      // Try to find a date match
      const candidates = [];
      $('div.item').each((i, el) => {
        const link = $(el).find('a.asp_res_url').attr('href');
        const dateText = $(el).find('.summary-content').text().trim();

        if (link) {
          candidates.push({ link, dateText });
        }
      });

      for (const candidate of candidates) {
        const { link, dateText } = candidate;
        let matched = false;

        // 1. Try to check date from search result if present
        if (dateText) {
          const parts = dateText.split(/[\s,]+/);
          if (parts.length >= 3) {
            const mStr = parts[0].substring(0, 3);
            const dStr = parts[1];
            const yStr = parts[2];
            const month = monthsMap[mStr];

            if (month && dStr && yStr) {
              const day = dStr.padStart(2, '0');
              const formattedDate = `${yStr}-${month}-${day}`;
              if (formattedDate === firstAirDate) {
                bestLink = link;
                matched = true;
              }
            }
          }
        }

        if (matched) break;

        // 2. If no match yet (or no dateText), fetch the page to check the date
        if (!bestLink) {
          try {
            const pageResponse = await impitFetch(link);
            const $page = cheerio.load(pageResponse.body);

            let pageDateFound = false;

            $page('.summary-content').each((_, el) => {
              const txt = $(el).text().trim();
              // Try parsing this text
              const parts = txt.split(/[\s,]+/);
              if (parts.length >= 3) {
                const mStr = parts[0].substring(0, 3);
                const dStr = parts[1];
                const yStr = parts[2];
                const month = monthsMap[mStr];
                if (month && dStr && yStr) {
                  const day = dStr.padStart(2, '0');
                  const fDate = `${yStr}-${month}-${day}`;
                  if (fDate === firstAirDate) {
                    pageDateFound = true;
                    return false;
                  }
                }
              }
            });

            if (pageDateFound) {
              bestLink = link;
              break;
            }

          } catch (err) {
            // Check next candidate
          }
        }
      }
    }

    // Fallback if no specific date match found
    if (!bestLink) {
      return { success: false, error: 'Série non trouvée sur Voirdrama (Aucune date correspondante)' };
    }

    // 5. Construct Episode URL
    // Format: https://voirdrama.to/drama/slug/ -> https://voirdrama.to/drama/slug/slug-episode-vostfr/
    // Remove trailing slash if present
    const cleanLink = bestLink.replace(/\/$/, '');
    const slug = cleanLink.split('/').pop();

    const paddedEpisode = episode.toString().padStart(2, '0');
    // Note: User example had slug repeated: /slug/slug-01-vostfr/
    const episodeUrl = `${cleanLink}/${slug}-${paddedEpisode}-vostfr/`;

    // 6. Fetch Episode Page
    const episodeResponse = await impitFetch(episodeUrl);

    // 7. Extract Sources
    const episodeHtml = episodeResponse.body;
    const sourcesMatch = episodeHtml.match(/var thisChapterSources = ({[\s\S]*?});/);

    if (!sourcesMatch) {
      return { success: false, error: 'Sources non trouvées sur la page de l\'épisode' };
    }

    const sourcesJson = JSON.parse(sourcesMatch[1]);
    const sources = [];

    for (const [key, value] of Object.entries(sourcesJson)) {
      // 1. Clean Name
      let name = key;
      try {
        name = JSON.parse(`"${key}"`); // Decode unicode if needed
      } catch (e) { }

      // Remove "☰", "LECTEUR", numbers and extra spaces
      name = name.replace(/[☰]/g, '').replace(/LECTEUR\s*\d+/i, '').trim();

      // Map common abbreviated names if possible
      if (name === 'VIDM') name = 'Vidmoly';
      if (name === 'RU') name = 'Ok.ru';
      if (name === 'VOE') name = 'Voe';
      if (name === 'UQLOAD') name = 'Uqload';
      if (name === 'UPSTREAM') name = 'Upstream';
      if (name === 'DOOD') name = 'Doodstream';


      // 2. Extract Link
      let url = null;

      // Look for iframe src specifically to avoid script tags
      const iframeMatch = value.match(/<iframe[^>]+src="([^"]+)"/i);
      if (iframeMatch) {
        url = iframeMatch[1];
      } else {
        // Fallback: try to find http links that look like video embeds
        const urlMatch = value.match(/https?:\/\/[^"\s']+/);
        if (urlMatch) {
          const candidate = urlMatch[0];
          // Exclude recaptcha, google api, and local admin-ajax
          if (!candidate.includes('google.com/recaptcha') && !candidate.includes('admin-ajax.php')) {
            url = candidate;
          }
        }
      }

      // 3. Filter and Add
      if (url) {
        sources.push({
          name: name,
          link: url,
          // raw: value // Optional: keep raw for debug if needed, but user didn't ask for it
        });
      }
    }

    return {
      success: true,
      data: sources,
      tmdbId: tmdbId,
      season: season,
      episode: episode
    };

  } catch (error) {
    console.error('[VOIRDRAMA] Error:', error.message);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// GET /:type/:tmdbid
// Route /api/drama/:type/:tmdbid
// Options: season (saison), episode (episode)
// ---------------------------------------------------------------------------
router.get('/:type/:tmdbid', async (req, res) => {
  const { type, tmdbid } = req.params;
  const { season, episode } = req.query;

  if (type !== 'tv') {
    return res.status(400).json({
      success: false,
      error: 'Ce point de terminaison ne supporte que type=tv pour le moment avec saison/episode'
    });
  }

  if (!season || !episode) {
    return res.status(400).json({
      success: false,
      error: 'Les paramètres ?season= et ?episode= sont requis.'
    });
  }

  const cacheKey = generateCacheKey(`voirdrama_${tmdbid}_${season}_${episode}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'voirdrama');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    // Stale-while-revalidate: return cached data immediately
    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // Return cached data immediately
      if (!cachedData.success) {
        res.status(404).json(cachedData);
      } else {
        await respondWithSources(req, res, cachedData);
      }
      dataReturned = true;

      // Background update if cache should be updated
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        // Background update (non-blocking)
        (async () => {
          try {
            const freshData = await fetchDramaTvData(tmdbid, season, episode);
            await saveToCache(cacheDir, cacheKey, freshData);
          } catch (bgError) {
            console.error(`[VOIRDRAMA] Background update error:`, bgError.message);
          }
        })();
      }
      return;
    }

    // No cache - fetch fresh data
    const result = await fetchDramaTvData(tmdbid, season, episode);

    // Save to cache (both success and error results)
    await saveToCache(cacheDir, cacheKey, result);

    if (!result.success) {
      return res.status(404).json(result);
    }

    await respondWithSources(req, res, result);

  } catch (error) {
    console.error('[API DRAMA] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne',
      details: error.message
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:type/:tmdbid/cache
// Supprime le cache d'une saison entière (ou d'un épisode spécifique)
// Ex: DELETE /api/drama/tv/68398/cache?season=2
// Ex: DELETE /api/drama/tv/68398/cache?season=2&episode=3
// ---------------------------------------------------------------------------
router.delete('/:type/:tmdbid/cache', async (req, res) => {
  const { tmdbid } = req.params;
  const { season, episode } = req.query;

  if (!season) {
    return res.status(400).json({ success: false, error: 'Le paramètre ?season= est requis.' });
  }

  const cacheDir = path.join(__dirname, '..', 'cache', 'voirdrama');
  const deletedFiles = [];
  const errors = [];

  try {
    if (episode) {
      // Supprimer un épisode spécifique
      const cacheKey = generateCacheKey(`voirdrama_${tmdbid}_${season}_${episode}`);
      const filePath = path.join(cacheDir, `${cacheKey}.json`);
      try {
        await fsp.unlink(filePath);
        deletedFiles.push(`S${season}E${episode}`);
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push(err.message);
      }
    } else {
      // Supprimer toute la saison — tester tous les épisodes de 1 à 200
      const prefix = `voirdrama_${tmdbid}_${season}_`;
      for (let ep = 1; ep <= 200; ep++) {
        const cacheKey = generateCacheKey(`${prefix}${ep}`);
        const filePath = path.join(cacheDir, `${cacheKey}.json`);
        try {
          await fsp.unlink(filePath);
          deletedFiles.push(`S${season}E${ep}`);
        } catch (err) {
          if (err.code !== 'ENOENT') errors.push(err.message);
        }
      }
    }

    if (deletedFiles.length > 0) {
      return res.json({
        success: true,
        message: `Cache voirdrama supprimé pour ${tmdbid} saison ${season}`,
        deleted: deletedFiles,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      return res.status(404).json({
        success: false,
        error: `Aucun cache trouvé pour ${tmdbid} saison ${season}`
      });
    }
  } catch (error) {
    console.error('[VOIRDRAMA] Cache delete error:', error);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

module.exports = router;
module.exports.configure = configure;
module.exports.fetchDramaTvData = fetchDramaTvData;
