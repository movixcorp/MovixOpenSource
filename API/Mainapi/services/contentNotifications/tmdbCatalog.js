const axios = require('axios');
const { normalizeEpisode } = require('./tracking');

const CATALOG_CACHE_TTL_SECONDS = 12 * 60 * 60;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function createTmdbCatalogService({ apiKey, apiUrl, redis, logger = console }) {
  const baseUrl = String(apiUrl || 'https://api.themoviedb.org/3').replace(/\/$/, '');
  const inFlight = new Map();

  async function readCache(showId) {
    if (!redis || typeof redis.get !== 'function') return null;
    try {
      const cached = await redis.get(`content-notifications:tmdb:${showId}`);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  }

  async function writeCache(showId, value) {
    if (!redis || typeof redis.set !== 'function') return;
    try {
      await redis.set(
        `content-notifications:tmdb:${showId}`,
        JSON.stringify(value),
        'EX',
        CATALOG_CACHE_TTL_SECONDS,
      );
    } catch {
      // Le cache ne doit jamais empêcher le scan.
    }
  }

  async function fetchCatalog(showId) {
    if (!apiKey) throw new Error('TMDB_API_KEY manquante');
    const cached = await readCache(showId);
    if (cached) return cached;

    const detailsResponse = await axios.get(`${baseUrl}/tv/${showId}`, {
      params: { api_key: apiKey, language: 'fr-FR' },
      timeout: 15000,
    });
    const details = detailsResponse.data || {};
    const seasons = (Array.isArray(details.seasons) ? details.seasons : [])
      .filter((season) => Number(season.season_number) > 0 && Number(season.episode_count) > 0);

    const seasonPayloads = await mapWithConcurrency(seasons, 4, async (season) => {
      try {
        const response = await axios.get(`${baseUrl}/tv/${showId}/season/${season.season_number}`, {
          params: { api_key: apiKey, language: 'fr-FR' },
          timeout: 15000,
        });
        return response.data || {};
      } catch (error) {
        logger.warn(`[ContentNotifications] TMDB saison ${showId}/S${season.season_number}: ${error.message}`);
        return { season_number: season.season_number, episodes: [] };
      }
    });

    const episodes = seasonPayloads.flatMap((season) => (
      (Array.isArray(season.episodes) ? season.episodes : [])
        .map((episode) => normalizeEpisode(episode, season.season_number))
        .filter(Boolean)
    ));
    const catalog = {
      id: Number(showId),
      title: String(details.name || details.original_name || '').trim(),
      posterPath: typeof details.poster_path === 'string' ? details.poster_path : null,
      episodes,
    };
    await writeCache(showId, catalog);
    return catalog;
  }

  function getCatalog(showId) {
    const key = String(showId);
    if (!inFlight.has(key)) {
      inFlight.set(key, fetchCatalog(showId).finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  return { getCatalog };
}

module.exports = { CATALOG_CACHE_TTL_SECONDS, createTmdbCatalogService, mapWithConcurrency };
