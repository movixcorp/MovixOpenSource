const EPISODE_KEY_PATTERN = /^S(\d+)E(\d+)$/i;

function parseStoredValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asMediaList(value) {
  const parsed = parseStoredValue(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeMediaItem(item, mediaType) {
  const rawId = typeof item === 'object' && item !== null ? item.id : item;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const source = typeof item === 'object' && item !== null ? item : {};
  const addedAtMs = Date.parse(source.addedAt || source.added_at || '');

  return {
    id,
    mediaType,
    title: String(source.title || source.name || '').trim(),
    posterPath: typeof source.poster_path === 'string' ? source.poster_path : null,
    addedAt: Number.isFinite(addedAtMs) ? addedAtMs : null,
  };
}

function readEpisodeMap(value) {
  const parsed = parseStoredValue(value, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();

  return new Set(
    Object.entries(parsed)
      .filter(([, watched]) => Boolean(watched))
      .map(([key]) => key.toUpperCase())
      .filter((key) => EPISODE_KEY_PATTERN.test(key)),
  );
}

function collectLegacyEpisodes(profileData, storageKey) {
  const byShow = new Map();
  const legacy = asMediaList(profileData[storageKey]);

  for (const item of legacy) {
    const showId = Number(item?.id);
    const season = Number(item?.episodeInfo?.season);
    const episode = Number(item?.episodeInfo?.episode);
    if (![showId, season, episode].every(Number.isSafeInteger) || showId <= 0 || season <= 0 || episode <= 0) {
      continue;
    }

    if (!byShow.has(showId)) byShow.set(showId, new Set());
    byShow.get(showId).add(`S${season}E${episode}`);
  }

  return byShow;
}

function deriveTrackedContent(profileData) {
  const targets = [];
  const watchlistMovies = asMediaList(profileData.watchlist_movie)
    .map((item) => normalizeMediaItem(item, 'movie'))
    .filter(Boolean);
  const watchlistTv = asMediaList(profileData.watchlist_tv)
    .map((item) => normalizeMediaItem(item, 'tv'))
    .filter(Boolean);
  const completedTv = asMediaList(profileData.watched_tv)
    .map((item) => normalizeMediaItem(item, 'tv'))
    .filter(Boolean);
  const legacyEpisodes = collectLegacyEpisodes(profileData, 'watched_tv_episodes');
  const legacyWatchlistEpisodes = collectLegacyEpisodes(profileData, 'watchlist_tv_episodes');

  for (const movie of watchlistMovies) {
    targets.push({ ...movie, mode: 'watchlist', watchedEpisodes: new Set() });
  }

  for (const show of watchlistTv) {
    const explicitEpisodes = readEpisodeMap(profileData[`watchlist_episodes_tv_${show.id}`]);
    for (const key of legacyWatchlistEpisodes.get(show.id) || []) explicitEpisodes.add(key);
    targets.push({
      ...show,
      mode: 'watchlist',
      watchedEpisodes: new Set(),
      explicitEpisodes,
      watchAllEpisodes: true,
    });
  }

  const fullWatchlistIds = new Set(watchlistTv.map((show) => show.id));
  const episodeWatchlistIds = new Set(legacyWatchlistEpisodes.keys());
  for (const key of Object.keys(profileData)) {
    const match = key.match(/^watchlist_episodes_tv_(\d+)$/);
    if (match) episodeWatchlistIds.add(Number(match[1]));
  }
  for (const showId of episodeWatchlistIds) {
    if (fullWatchlistIds.has(showId)) continue;
    const explicitEpisodes = readEpisodeMap(profileData[`watchlist_episodes_tv_${showId}`]);
    for (const key of legacyWatchlistEpisodes.get(showId) || []) explicitEpisodes.add(key);
    if (explicitEpisodes.size === 0) continue;
    targets.push({
      id: showId,
      mediaType: 'tv',
      mode: 'watchlist',
      title: '',
      posterPath: null,
      addedAt: null,
      watchedEpisodes: new Set(),
      explicitEpisodes,
      watchAllEpisodes: false,
    });
  }

  const watchedShowIds = new Set(completedTv.map((show) => show.id));
  for (const key of Object.keys(profileData)) {
    const match = key.match(/^watched_episodes_tv_(\d+)$/);
    if (match) watchedShowIds.add(Number(match[1]));
  }
  for (const showId of legacyEpisodes.keys()) watchedShowIds.add(showId);

  for (const showId of watchedShowIds) {
    const completed = completedTv.find((show) => show.id === showId) || null;
    const watchedEpisodes = readEpisodeMap(profileData[`watched_episodes_tv_${showId}`]);
    for (const key of legacyEpisodes.get(showId) || []) watchedEpisodes.add(key);

    targets.push({
      id: showId,
      mediaType: 'tv',
      mode: 'watched',
      title: completed?.title || '',
      posterPath: completed?.posterPath || null,
      addedAt: completed?.addedAt || null,
      watchedEpisodes,
      completedMarker: Boolean(completed),
    });
  }

  const unique = new Map();
  for (const target of targets) {
    unique.set(`${target.mediaType}:${target.id}:${target.mode}`, target);
  }
  return [...unique.values()];
}

function normalizeEpisode(episode, fallbackSeason) {
  const season = Number(episode?.season_number ?? fallbackSeason);
  const number = Number(episode?.episode_number);
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(number) || season <= 0 || number <= 0) {
    return null;
  }

  const airDateMs = Date.parse(episode?.air_date || '');
  return {
    season,
    episode: number,
    key: `S${season}E${number}`,
    name: String(episode?.name || '').trim(),
    airDate: Number.isFinite(airDateMs) ? airDateMs : null,
  };
}

function sortEpisodes(episodes) {
  return [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function findNextEpisodeForWatchedTarget(target, catalog, now = Date.now()) {
  const episodes = sortEpisodes(catalog).filter((episode) => episode.airDate === null || episode.airDate <= now + 7 * 86400000);
  if (episodes.length === 0) return null;

  const watched = new Set(target.watchedEpisodes || []);
  if (target.completedMarker) {
    const completedAt = target.addedAt || now;
    for (const episode of episodes) {
      if (episode.airDate !== null && episode.airDate <= completedAt) watched.add(episode.key);
    }
  }

  let watchedAny = false;
  for (const episode of episodes) {
    if (watched.has(episode.key)) {
      watchedAny = true;
      continue;
    }

    // Une lacune dans l'historique signifie que la suite logique n'est pas
    // encore atteinte. On n'alerte donc jamais pour un épisode plus lointain.
    return watchedAny ? episode : null;
  }

  return null;
}

function getWatchlistCandidates(catalog, initializedAt, now = Date.now()) {
  const lowerBound = Math.max(
    Number(initializedAt) - 7 * 86400000,
    now - 180 * 86400000,
  );
  const upperBound = now + 7 * 86400000;

  return sortEpisodes(catalog).filter((episode) => (
    episode.airDate !== null && episode.airDate >= lowerBound && episode.airDate <= upperBound
  ));
}

module.exports = {
  EPISODE_KEY_PATTERN,
  asMediaList,
  deriveTrackedContent,
  findNextEpisodeForWatchedTarget,
  getWatchlistCandidates,
  normalizeEpisode,
  parseStoredValue,
  readEpisodeMap,
  sortEpisodes,
};
