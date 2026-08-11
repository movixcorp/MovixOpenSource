const axios = require('axios');

const PLAYABLE_LEAF_KEYS = new Set([
  'decoded_url', 'embed', 'embed_url', 'file', 'hls', 'hlsurl', 'link', 'm3u8',
  'm3u8url', 'src', 'stream', 'stream_url', 'url', 'video', 'video_url',
]);
const PLAYABLE_CONTAINER_KEYS = new Set([
  'current_episode', 'data', 'default', 'episode', 'episodes', 'languages', 'links',
  'organized', 'player_links', 'players', 'results', 'sources', 'streams', 'vf',
  'vo', 'voeng', 'vostfr',
]);

function isPlayableUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
  const normalized = value.toLowerCase();
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?|$)/i.test(normalized)) return false;
  if (normalized.includes('image.tmdb.org')) return false;
  return true;
}

function hasPlayableLink(value, parentKey = '', depth = 0) {
  if (depth > 10 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return PLAYABLE_LEAF_KEYS.has(parentKey.toLowerCase()) && isPlayableUrl(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => (
      typeof item === 'string'
        ? isPlayableUrl(item)
        : hasPlayableLink(item, parentKey, depth + 1)
    ));
  }
  if (typeof value !== 'object') return false;

  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.toLowerCase();
    if (PLAYABLE_LEAF_KEYS.has(normalizedKey) && typeof child === 'string') {
      return isPlayableUrl(child);
    }
    if (!PLAYABLE_CONTAINER_KEYS.has(normalizedKey) && !/^\d+$/.test(normalizedKey)) {
      return false;
    }
    return hasPlayableLink(child, normalizedKey, depth + 1);
  });
}

function parseLinks(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function findEpisodePayloads(value, episodeNumber, depth = 0) {
  if (depth > 9 || value === null || value === undefined) return [];
  const target = Number(episodeNumber);

  if (Array.isArray(value)) {
    const exact = value.filter((item) => {
      const number = Number(item?.episode_number ?? item?.episode ?? item?.number);
      return Number.isSafeInteger(number) && number === target;
    });
    if (exact.length > 0) return exact;
    return value.flatMap((item) => findEpisodePayloads(item, target, depth + 1));
  }

  if (typeof value !== 'object') return [];
  if (value.current_episode) return [value.current_episode];

  const episodes = value.episodes;
  if (episodes && typeof episodes === 'object') {
    if (!Array.isArray(episodes)) {
      const direct = episodes[String(target)] ?? episodes[`E${target}`] ?? episodes[`e${target}`];
      if (direct) return [direct];
    }
    const nested = findEpisodePayloads(episodes, target, depth + 1);
    if (nested.length > 0) return nested;
  }

  const ownNumber = Number(value.episode_number ?? value.episode ?? value.number);
  if (Number.isSafeInteger(ownNumber) && ownNumber === target) return [value];

  return Object.entries(value)
    .filter(([key]) => ['data', 'results', 'seasons'].includes(key.toLowerCase()))
    .flatMap(([, child]) => findEpisodePayloads(child, target, depth + 1));
}

function hasPlayableEpisode(payload, episodeNumber, episodeSpecific = false) {
  if (episodeSpecific) return hasPlayableLink(payload);
  const candidates = findEpisodePayloads(payload, episodeNumber);
  return candidates.some((candidate) => hasPlayableLink(candidate));
}

function createAvailabilityChecker({ pool, baseUrl, timeoutMs = 12000, logger = console }) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/$/, '');
  const movieCache = new Map();
  const episodeCache = new Map();
  const databaseSeriesCache = new Map();

  async function request(pathname) {
    if (!normalizedBaseUrl) return null;
    try {
      const response = await axios.get(`${normalizedBaseUrl}${pathname}`, {
        timeout: timeoutMs,
        validateStatus: (status) => status >= 200 && status < 500,
      });
      return response.status >= 200 && response.status < 300 ? response.data : null;
    } catch (error) {
      logger.debug?.(`[ContentNotifications] Source indisponible ${pathname}: ${error.message}`);
      return null;
    }
  }

  async function getDatabaseEpisodes(showId) {
    const cacheKey = String(showId);
    if (!databaseSeriesCache.has(cacheKey)) {
      databaseSeriesCache.set(cacheKey, (async () => {
        const [rows] = await pool.execute(
          `SELECT season_number, episode_number, links, created_at, updated_at
             FROM series
            WHERE series_id = ?
            ORDER BY season_number, episode_number`,
          [showId],
        );
        return rows
          .filter((row) => hasPlayableLink(parseLinks(row.links), 'links'))
          .map((row) => ({
            season: Number(row.season_number),
            episode: Number(row.episode_number),
            availableAt: new Date(row.updated_at || row.created_at).getTime() || null,
            provider: 'movix',
          }));
      })());
    }
    return databaseSeriesCache.get(cacheKey);
  }

  async function checkMovieUncached(movieId) {
    const [rows] = await pool.execute('SELECT links, created_at, updated_at FROM films WHERE id = ? LIMIT 1', [movieId]);
    if (rows[0] && hasPlayableLink(parseLinks(rows[0].links), 'links')) {
      return {
        available: true,
        availableAt: new Date(rows[0].updated_at || rows[0].created_at).getTime() || null,
        provider: 'movix',
      };
    }

    const coflix = await request(`/api/tmdb/movie/${movieId}`);
    if (Array.isArray(coflix?.player_links) && coflix.player_links.some((link) => hasPlayableLink(link, 'player_links'))) {
      return { available: true, availableAt: Date.now(), provider: 'coflix' };
    }

    const providers = [
      `/api/fstream/movie/${movieId}`,
      `/api/wiflix/movie/${movieId}`,
      `/api/j1f/movie/${movieId}`,
      `/api/swiftflow/movie/${movieId}`,
      `/api/cpasmal/movie/${movieId}`,
    ];
    const responses = await Promise.all(providers.map(request));
    const index = responses.findIndex((payload) => hasPlayableLink(payload));
    return index >= 0
      ? { available: true, availableAt: Date.now(), provider: providers[index].split('/')[2] }
      : { available: false, availableAt: null, provider: null };
  }

  async function checkMovie(movieId) {
    const key = String(movieId);
    if (!movieCache.has(key)) movieCache.set(key, checkMovieUncached(movieId));
    return movieCache.get(key);
  }

  async function checkEpisodeUncached(showId, season, episode) {
    const databaseEpisodes = await getDatabaseEpisodes(showId);
    const databaseMatch = databaseEpisodes.find((item) => item.season === season && item.episode === episode);
    if (databaseMatch) return { available: true, ...databaseMatch };

    const coflix = await request(`/api/tmdb/tv/${showId}?season=${season}&episode=${episode}`);
    if (Array.isArray(coflix?.current_episode?.player_links) && coflix.current_episode.player_links.some((link) => hasPlayableLink(link, 'player_links'))) {
      return { available: true, availableAt: Date.now(), provider: 'coflix' };
    }

    const specificPath = `/api/cpasmal/tv/${showId}/${season}/${episode}`;
    const specific = await request(specificPath);
    if (hasPlayableEpisode(specific, episode, true)) {
      return { available: true, availableAt: Date.now(), provider: 'cpasmal' };
    }

    const seasonProviders = [
      `/api/fstream/tv/${showId}/season/${season}`,
      `/api/wiflix/tv/${showId}/${season}`,
      `/api/j1f/tv/${showId}/season/${season}`,
      `/api/swiftflow/tv/${showId}/season/${season}`,
    ];
    const responses = await Promise.all(seasonProviders.map(request));
    const index = responses.findIndex((payload) => hasPlayableEpisode(payload, episode));
    return index >= 0
      ? { available: true, availableAt: Date.now(), provider: seasonProviders[index].split('/')[2] }
      : { available: false, availableAt: null, provider: null };
  }

  async function checkEpisode(showId, season, episode) {
    const key = `${showId}:S${season}E${episode}`;
    if (!episodeCache.has(key)) episodeCache.set(key, checkEpisodeUncached(showId, season, episode));
    return episodeCache.get(key);
  }

  return { checkEpisode, checkMovie, getDatabaseEpisodes };
}

module.exports = {
  createAvailabilityChecker,
  findEpisodePayloads,
  hasPlayableEpisode,
  hasPlayableLink,
  isPlayableUrl,
  parseLinks,
};
