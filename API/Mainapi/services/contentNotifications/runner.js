const crypto = require('crypto');
const path = require('path');
const { createAvailabilityChecker } = require('./availability');
const { buildGroupNotification, insertInAppNotification, sendPushToUser } = require('./delivery');
const { readProfiles } = require('./profileScanner');
const {
  deriveTrackedContent,
  findNextEpisodeForWatchedTarget,
  getWatchlistCandidates,
  parseStoredValue,
} = require('./tracking');
const { createTmdbCatalogService, mapWithConcurrency } = require('./tmdbCatalog');

const DAY_MS = 24 * 60 * 60 * 1000;

function hashKey(parts) {
  return crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex');
}

function normalizeLanguage(value) {
  const parsed = parseStoredValue(value, value);
  return String(parsed || '').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

function profileKey(userId, userType, profileId) {
  return `${userType}:${userId}:${profileId}`;
}

function accountKey(userId, userType) {
  return `${userType}:${userId}`;
}

function eventIdentity(context, event) {
  return hashKey([
    context.userType,
    context.userId,
    context.profileId,
    context.target.mediaType,
    context.target.id,
    event.season || 0,
    event.episode || 0,
  ]);
}

async function getOrCreateTracker(pool, context, now) {
  const trackerKey = hashKey([
    context.userType,
    context.userId,
    context.profileId,
    context.target.mediaType,
    context.target.id,
    context.target.mode,
  ]);
  const title = String(context.target.title || '').slice(0, 255) || null;
  const posterPath = String(context.target.posterPath || '').slice(0, 255) || null;
  const [existing] = await pool.execute(
    'SELECT * FROM content_notification_trackers WHERE tracker_key = ? LIMIT 1',
    [trackerKey],
  );

  if (existing.length > 0) {
    await pool.execute(
      `UPDATE content_notification_trackers
          SET content_title = COALESCE(?, content_title),
              poster_path = COALESCE(?, poster_path), language = ?, active = 1
        WHERE id = ?`,
      [title, posterPath, context.language, existing[0].id],
    );
    return {
      ...existing[0],
      content_title: title || existing[0].content_title,
      language: context.language,
      isInitial: existing[0].active === 0 || existing[0].last_checked_at === null,
    };
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO content_notification_trackers
        (tracker_key, user_id, user_type, profile_id, content_type, content_id,
         tracking_mode, content_title, poster_path, language, initialized_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        trackerKey,
        context.userId,
        context.userType,
        context.profileId,
        context.target.mediaType,
        context.target.id,
        context.target.mode,
        title,
        posterPath,
        context.language,
        now,
      ],
    );
    return {
      id: result.insertId,
      tracker_key: trackerKey,
      initialized_at: now,
      content_title: title,
      language: context.language,
      isInitial: true,
    };
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await pool.execute(
      'SELECT * FROM content_notification_trackers WHERE tracker_key = ? LIMIT 1',
      [trackerKey],
    );
    return { ...rows[0], isInitial: false };
  }
}

async function markInactiveTrackers(pool, profiles, contexts) {
  for (const profile of profiles) {
    const ids = contexts
      .filter((context) => (
        context.userId === profile.userId &&
        context.userType === profile.userType &&
        context.profileId === profile.profileId
      ))
      .map((context) => Number(context.tracker.id))
      .filter(Number.isSafeInteger);
    const identityParams = [profile.userId, profile.userType, profile.profileId];
    if (ids.length === 0) {
      await pool.execute(
        `UPDATE content_notification_trackers SET active = 0
          WHERE user_id = ? AND user_type = ? AND profile_id = ? AND active = 1`,
        identityParams,
      );
      continue;
    }
    const placeholders = ids.map(() => '?').join(',');
    await pool.execute(
      `UPDATE content_notification_trackers SET active = 0
        WHERE user_id = ? AND user_type = ? AND profile_id = ?
          AND active = 1 AND id NOT IN (${placeholders})`,
      [...identityParams, ...ids],
    );
  }
}

async function loadDisabledAccounts(pool) {
  const [rows] = await pool.execute(
    'SELECT user_id, user_type FROM user_notification_preferences WHERE notifications_disabled = 1',
  );
  return new Set(rows.map((row) => accountKey(row.user_id, row.user_type)));
}

function addCandidate(map, context, event) {
  const season = Number(event.season) || 0;
  const episode = Number(event.episode) || 0;
  const probeKey = context.target.mediaType === 'movie'
    ? `movie:${context.target.id}`
    : `tv:${context.target.id}:S${season}E${episode}`;
  const key = `${context.tracker.id}:${probeKey}`;
  if (!map.has(key)) map.set(key, { context, event: { ...event, season, episode }, probeKey });
}

async function buildCandidates(contexts, catalogService, availabilityChecker, now, logger) {
  const candidates = new Map();
  const catalogByShow = new Map();
  const showIds = [...new Set(contexts.filter((context) => context.target.mediaType === 'tv').map((context) => context.target.id))];

  await mapWithConcurrency(showIds, 4, async (showId) => {
    try {
      catalogByShow.set(showId, await catalogService.getCatalog(showId));
    } catch (error) {
      logger.warn(`[ContentNotifications] Catalogue TMDB ${showId} ignoré: ${error.message}`);
      catalogByShow.set(showId, null);
    }
  });

  for (const context of contexts) {
    if (context.target.mediaType === 'movie') {
      addCandidate(candidates, context, { season: 0, episode: 0 });
      continue;
    }

    const catalog = catalogByShow.get(context.target.id);
    if (catalog) {
      context.target.title ||= catalog.title;
      context.target.posterPath ||= catalog.posterPath;
    }

    if (context.target.mode === 'watched') {
      const nextEpisode = catalog
        ? findNextEpisodeForWatchedTarget(context.target, catalog.episodes, now)
        : null;
      if (nextEpisode) addCandidate(candidates, context, nextEpisode);
      continue;
    }

    if (context.target.watchAllEpisodes === false) {
      for (const key of context.target.explicitEpisodes || []) {
        const match = key.match(/^S(\d+)E(\d+)$/i);
        if (!match) continue;
        const season = Number(match[1]);
        const episode = Number(match[2]);
        const metadata = catalog?.episodes.find((item) => item.season === season && item.episode === episode);
        addCandidate(candidates, context, metadata || { season, episode, key: `S${season}E${episode}` });
      }
      continue;
    }

    if (catalog) {
      for (const episode of getWatchlistCandidates(catalog.episodes, context.tracker.initialized_at, now)) {
        addCandidate(candidates, context, episode);
      }
    }

    // Les liens ajoutés directement à Movix restent autoritaires, y compris
    // quand TMDB est momentanément indisponible ou en retard.
    try {
      for (const episode of await availabilityChecker.getDatabaseEpisodes(context.target.id)) {
        addCandidate(candidates, context, episode);
      }
    } catch (error) {
      logger.warn(`[ContentNotifications] Liens série ${context.target.id} ignorés: ${error.message}`);
    }
  }

  return [...candidates.values()];
}

async function probeCandidates(candidates, availabilityChecker) {
  const uniqueProbes = new Map();
  for (const candidate of candidates) {
    if (!uniqueProbes.has(candidate.probeKey)) {
      uniqueProbes.set(candidate.probeKey, candidate);
    }
  }

  const entries = [...uniqueProbes.entries()];
  const results = await mapWithConcurrency(entries, 4, async ([probeKey, candidate]) => {
    const { target } = candidate.context;
    const availability = target.mediaType === 'movie'
      ? await availabilityChecker.checkMovie(target.id)
      : await availabilityChecker.checkEpisode(target.id, candidate.event.season, candidate.event.episode);
    return [probeKey, availability];
  });

  return new Map(results);
}

async function recordAvailableEvents(pool, candidates, availabilityByProbe, disabledAccounts, now) {
  let baselineEvents = 0;
  let newEvents = 0;

  for (const candidate of candidates) {
    const availability = availabilityByProbe.get(candidate.probeKey);
    if (!availability?.available) continue;

    const { context, event } = candidate;
    const isBaseline = context.tracker.isInitial || disabledAccounts.has(accountKey(context.userId, context.userType));
    const [result] = await pool.execute(
      `INSERT IGNORE INTO content_notification_events
        (event_key, tracker_id, season_number, episode_number, provider, is_baseline,
         notification_id, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        eventIdentity(context, event),
        context.tracker.id,
        event.season,
        event.episode,
        availability.provider || null,
        isBaseline ? 1 : 0,
        availability.availableAt || now,
        now,
      ],
    );
    if (result.affectedRows > 0) {
      if (isBaseline) baselineEvents += 1;
      else newEvents += 1;
    }
  }

  const trackerIds = [...new Set(candidates.map((candidate) => candidate.context.tracker.id))];
  if (trackerIds.length > 0) {
    const placeholders = trackerIds.map(() => '?').join(',');
    await pool.execute(
      `UPDATE content_notification_trackers SET last_checked_at = ? WHERE id IN (${placeholders})`,
      [now, ...trackerIds],
    );
  }

  return { baselineEvents, newEvents };
}

async function refreshTrackerMetadata(pool, contexts) {
  for (const context of contexts) {
    const title = String(context.target.title || '').slice(0, 255) || null;
    const posterPath = String(context.target.posterPath || '').slice(0, 255) || null;
    if (!title && !posterPath) continue;
    await pool.execute(
      `UPDATE content_notification_trackers
          SET content_title = COALESCE(?, content_title), poster_path = COALESCE(?, poster_path)
        WHERE id = ?`,
      [title, posterPath, context.tracker.id],
    );
  }
}

async function deliverPendingEvents(pool, disabledAccounts, logger = console) {
  const [pending] = await pool.execute(
    `SELECT e.id, e.season_number, e.episode_number, t.user_id, t.user_type,
            t.profile_id, t.content_type, t.content_id, t.content_title, t.language
      FROM content_notification_events e
       JOIN content_notification_trackers t ON t.id = e.tracker_id
      WHERE e.is_baseline = 0 AND e.notification_id IS NULL
      ORDER BY e.created_at ASC`,
  );
  const groups = new Map();

  for (const row of pending) {
    const key = `${profileKey(row.user_id, row.user_type, row.profile_id)}:${row.content_type}:${row.content_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let notifications = 0;
  let pushes = 0;
  for (const rows of groups.values()) {
    const first = rows[0];
    const eventIds = rows.map((row) => Number(row.id)).filter(Number.isSafeInteger);
    if (eventIds.length === 0) continue;
    const placeholders = eventIds.map(() => '?').join(',');

    const [preferenceRows] = await pool.execute(
      `SELECT notifications_disabled FROM user_notification_preferences
        WHERE user_id = ? AND user_type = ? LIMIT 1`,
      [first.user_id, first.user_type],
    );
    const currentlyDisabled = disabledAccounts.has(accountKey(first.user_id, first.user_type)) ||
      preferenceRows[0]?.notifications_disabled === 1;
    if (currentlyDisabled) {
      await pool.execute(
        `UPDATE content_notification_events SET is_baseline = 1 WHERE id IN (${placeholders}) AND notification_id IS NULL`,
        eventIds,
      );
      continue;
    }

    const message = buildGroupNotification({
      contentType: first.content_type,
      contentId: first.content_id,
      title: first.content_title,
      language: first.language,
      events: rows.map((row) => ({ season: Number(row.season_number), episode: Number(row.episode_number) })),
    });
    const connection = await pool.getConnection();
    let notificationId = null;

    try {
      await connection.beginTransaction();
      const [locked] = await connection.execute(
        `SELECT id FROM content_notification_events
          WHERE id IN (${placeholders}) AND is_baseline = 0 AND notification_id IS NULL
          FOR UPDATE`,
        eventIds,
      );
      const lockedIds = locked.map((row) => Number(row.id));
      if (lockedIds.length === 0) {
        await connection.rollback();
        continue;
      }

      notificationId = await insertInAppNotification(connection, {
        userId: first.user_id,
        userType: first.user_type,
        profileId: first.profile_id,
        contentType: first.content_type,
        contentId: first.content_id,
        notificationType: message.notificationType,
        body: message.body,
        createdAt: Date.now(),
      });
      const lockedPlaceholders = lockedIds.map(() => '?').join(',');
      await connection.execute(
        `UPDATE content_notification_events SET notification_id = ? WHERE id IN (${lockedPlaceholders})`,
        [notificationId, ...lockedIds],
      );
      await connection.commit();
      notifications += 1;
    } catch (error) {
      await connection.rollback().catch(() => {});
      logger.error(`[ContentNotifications] Livraison transactionnelle impossible: ${error.message}`);
      continue;
    } finally {
      connection.release();
    }

    if (notificationId) {
      const pushResult = await sendPushToUser(pool, first.user_id, first.user_type, message.push, logger);
      pushes += pushResult.sent;
    }
  }

  return { notifications, pushes };
}

async function runContentNotificationScan({
  pool,
  redis,
  usersDirectory = path.join(__dirname, '..', '..', 'data', 'users'),
  apiBaseUrl = process.env.CONTENT_NOTIFICATION_API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 25565}`,
  tmdbApiKey = process.env.TMDB_API_KEY,
  tmdbApiUrl = process.env.TMDB_API_URL,
  now = Date.now(),
  logger = console,
} = {}) {
  if (!pool) throw new Error('Pool MySQL requis pour les notifications de disponibilité');
  const profiles = await readProfiles(usersDirectory, logger);
  const disabledAccounts = await loadDisabledAccounts(pool);
  const availabilityChecker = createAvailabilityChecker({ pool, baseUrl: apiBaseUrl, logger });
  const catalogService = createTmdbCatalogService({ apiKey: tmdbApiKey, apiUrl: tmdbApiUrl, redis, logger });
  const contexts = [];

  for (const profile of profiles) {
    const language = normalizeLanguage(profile.data.user_language);
    for (const target of deriveTrackedContent(profile.data)) {
      const context = {
        userId: profile.userId,
        userType: profile.userType,
        profileId: profile.profileId,
        language,
        target,
      };
      context.tracker = await getOrCreateTracker(pool, context, now);
      contexts.push(context);
    }
  }

  await markInactiveTrackers(pool, profiles, contexts);

  const candidates = await buildCandidates(contexts, catalogService, availabilityChecker, now, logger);
  await refreshTrackerMetadata(pool, contexts);
  const availabilityByProbe = await probeCandidates(candidates, availabilityChecker);
  const recorded = await recordAvailableEvents(pool, candidates, availabilityByProbe, disabledAccounts, now);
  const delivered = await deliverPendingEvents(pool, disabledAccounts, logger);
  const stats = {
    profiles: profiles.length,
    trackers: contexts.length,
    candidates: candidates.length,
    ...recorded,
    ...delivered,
    durationMs: Date.now() - now,
  };
  logger.info(`[ContentNotifications] Scan terminé ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  DAY_MS,
  accountKey,
  buildCandidates,
  deliverPendingEvents,
  eventIdentity,
  getOrCreateTracker,
  hashKey,
  markInactiveTrackers,
  normalizeLanguage,
  probeCandidates,
  recordAvailableEvents,
  refreshTrackerMetadata,
  runContentNotificationScan,
};
