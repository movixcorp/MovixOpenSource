/**
 * Resolution des identifiants dont les fournisseurs ont besoin.
 *
 * Movix raisonne en identifiants TMDB partout ; SkipDB et IntroDB indexent par
 * IMDb, AniSkip par MyAnimeList. Les deux traductions sont mises en cache tres
 * longtemps : un mapping TMDB→IMDb ou TMDB→MAL ne change pratiquement jamais.
 */

const axios = require('axios');

const { memoryCache } = require('../../config/redis');
const { UPSTREAM_TIMEOUT_MS, USER_AGENT } = require('./constants');

const ARM_BASE = 'https://arm.haglund.dev/api/v2';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const CACHE_VERSION = 'v3';
const TTL_MAPPING = 30 * 24 * 3600;
const TTL_MISS = 6 * 3600;

async function cached(key, loader) {
  const hit = await memoryCache.get(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  await memoryCache.set(key, value, value ? TTL_MAPPING : TTL_MISS);
  return value;
}

/** TMDB id → identifiant IMDb (`tt…`), requis par SkipDB et IntroDB. */
async function resolveImdbId(mediaType, tmdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  return cached(`segments:${CACHE_VERSION}:imdb:${mediaType}:${tmdbId}`, async () => {
    try {
      const res = await axios.get(`${TMDB_BASE}/${mediaType}/${tmdbId}/external_ids`, {
        params: { api_key: apiKey },
        timeout: UPSTREAM_TIMEOUT_MS,
      });
      const imdbId = res.data?.imdb_id;
      return typeof imdbId === 'string' && /^tt\d+$/.test(imdbId) ? imdbId : null;
    } catch {
      return null;
    }
  });
}

/**
 * TMDB id + saison → MyAnimeList id.
 *
 * `arm` renvoie un tableau de relations sans indicateur de saison : il faut
 * l'indexer soi-meme. On ne retient que deux cas surs — au-dela on abandonne
 * plutot que de renvoyer un mapping faux, parce qu'un mauvais MAL id donne les
 * timestamps d'une autre serie, ce qui est bien pire que pas de bouton du tout.
 */
async function resolveMalId(tmdbId, season) {
  if (!Number.isInteger(season) || season < 1) return null;

  const relations = await cached(`segments:${CACHE_VERSION}:mal:${tmdbId}`, async () => {
    try {
      const res = await axios.get(`${ARM_BASE}/themoviedb`, {
        params: { id: tmdbId, include: 'myanimelist' },
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT },
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch {
      return null;
    }
  });

  if (!Array.isArray(relations) || relations.length === 0) return null;
  if (relations.length === 1) return season === 1 ? (relations[0]?.myanimelist ?? null) : null;
  if (season <= relations.length) return relations[season - 1]?.myanimelist ?? null;
  return null;
}

module.exports = { resolveImdbId, resolveMalId };
