const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveTrackedContent,
  findNextEpisodeForWatchedTarget,
  getWatchlistCandidates,
} = require('../../services/contentNotifications/tracking');
const {
  findEpisodePayloads,
  hasPlayableEpisode,
  hasPlayableLink,
} = require('../../services/contentNotifications/availability');
const { buildGroupNotification } = require('../../services/contentNotifications/delivery');
const { getParisClock } = require('../../services/contentNotifications/scheduler');
const {
  deliverPendingEvents,
  eventIdentity,
  recordAvailableEvents,
} = require('../../services/contentNotifications/runner');

test('deriveTrackedContent reprend les listes et épisodes synchronisés existants', () => {
  const targets = deriveTrackedContent({
    watchlist_movie: JSON.stringify([{ id: 10, title: 'Film futur', addedAt: '2026-01-01T00:00:00Z' }]),
    watchlist_tv: [{ id: 20, name: 'Série suivie' }],
    watched_tv: JSON.stringify([{ id: 30, title: 'Série terminée', addedAt: '2026-02-01T00:00:00Z' }]),
    watched_episodes_tv_30: JSON.stringify({ S1E1: true, S1E2: true }),
    watched_episodes_tv_40: { S1E1: true },
    watchlist_episodes_tv_50: JSON.stringify({ S2E3: true }),
  });

  assert.deepEqual(
    targets.map((target) => `${target.mediaType}:${target.id}:${target.mode}`).sort(),
    ['movie:10:watchlist', 'tv:20:watchlist', 'tv:30:watched', 'tv:40:watched', 'tv:50:watchlist'],
  );
  assert.deepEqual([...targets.find((target) => target.id === 30).watchedEpisodes], ['S1E1', 'S1E2']);
  assert.deepEqual([...targets.find((target) => target.id === 50).explicitEpisodes], ['S2E3']);
});

test('findNextEpisodeForWatchedTarget exige un historique sans lacune', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const catalog = [
    { season: 1, episode: 1, key: 'S1E1', airDate: now - 3 },
    { season: 1, episode: 2, key: 'S1E2', airDate: now - 2 },
    { season: 2, episode: 1, key: 'S2E1', airDate: now + 1 },
  ];

  assert.equal(
    findNextEpisodeForWatchedTarget({ watchedEpisodes: new Set(['S1E1']) }, catalog, now).key,
    'S1E2',
  );
  assert.equal(
    findNextEpisodeForWatchedTarget({ watchedEpisodes: new Set(['S1E2']) }, catalog, now),
    null,
  );
  assert.equal(
    findNextEpisodeForWatchedTarget({
      watchedEpisodes: new Set(),
      completedMarker: true,
      addedAt: now,
    }, catalog, now).key,
    'S2E1',
  );
});

test('getWatchlistCandidates borne les épisodes à surveiller autour de leur sortie', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const day = 86400000;
  const candidates = getWatchlistCandidates([
    { season: 1, episode: 1, key: 'S1E1', airDate: now - 200 * day },
    { season: 1, episode: 2, key: 'S1E2', airDate: now - day },
    { season: 1, episode: 3, key: 'S1E3', airDate: now + 6 * day },
    { season: 1, episode: 4, key: 'S1E4', airDate: now + 8 * day },
  ], now - 365 * day, now);
  assert.deepEqual(candidates.map((episode) => episode.key), ['S1E2', 'S1E3']);
});

test('la détection de disponibilité ignore les images et cible le bon épisode', () => {
  assert.equal(hasPlayableLink({ poster: 'https://image.tmdb.org/a.jpg' }), false);
  assert.equal(hasPlayableLink({ links: [{ url: 'https://video.example/embed/abc' }] }), true);

  const payload = {
    episodes: {
      1: { players: [{ url: 'https://video.example/e1' }] },
      2: { players: [{ url: 'https://video.example/e2' }] },
    },
  };
  assert.equal(findEpisodePayloads(payload, 2).length, 1);
  assert.equal(hasPlayableEpisode(payload, 2), true);
  assert.equal(hasPlayableEpisode(payload, 3), false);
});

test('les notifications de série sont groupées et reconnaissent une nouvelle saison', () => {
  const grouped = buildGroupNotification({
    contentType: 'tv',
    contentId: 42,
    title: 'Exemple',
    language: 'fr',
    events: [{ season: 3, episode: 1 }, { season: 3, episode: 2 }],
  });
  assert.equal(grouped.notificationType, 'content_season_available');
  assert.match(grouped.body, /saison 3/);
  assert.match(grouped.body, /2 épisodes/);
  assert.deepEqual(grouped.push.data.contentId, '42');
});

test('getParisClock utilise toujours la journée Europe/Paris', () => {
  assert.deepEqual(getParisClock(new Date('2026-08-10T22:30:00Z')), {
    date: '2026-08-11',
    hour: 0,
  });
});

test('la clé de déduplication est commune aux modes À voir et déjà regardé', () => {
  const base = {
    userType: 'oauth',
    userId: 'user-1',
    profileId: 'profile-1',
    target: { mediaType: 'tv', id: 50, mode: 'watchlist' },
  };
  const event = { season: 2, episode: 4 };
  assert.equal(
    eventIdentity(base, event),
    eventIdentity({ ...base, target: { ...base.target, mode: 'watched' } }, event),
  );
});

test('le premier scan et les comptes désactivés enregistrent une référence sans alerte', async () => {
  const inserts = [];
  const pool = {
    async execute(sql, params) {
      if (sql.includes('INSERT IGNORE INTO content_notification_events')) {
        inserts.push(params);
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const makeCandidate = (isInitial, userId, trackerId) => ({
    probeKey: `movie:${trackerId}`,
    context: {
      userType: 'oauth',
      userId,
      profileId: `profile-${trackerId}`,
      target: { mediaType: 'movie', id: trackerId, mode: 'watchlist' },
      tracker: { id: trackerId, isInitial },
    },
    event: { season: 0, episode: 0 },
  });
  const candidates = [makeCandidate(true, 'enabled', 1), makeCandidate(false, 'disabled', 2)];
  const availability = new Map([
    ['movie:1', { available: true, provider: 'movix', availableAt: 1 }],
    ['movie:2', { available: true, provider: 'movix', availableAt: 1 }],
  ]);

  const stats = await recordAvailableEvents(
    pool,
    candidates,
    availability,
    new Set(['oauth:disabled']),
    2,
  );
  assert.deepEqual(stats, { baselineEvents: 2, newEvents: 0 });
  assert.equal(inserts[0][5], 1);
  assert.equal(inserts[1][5], 1);
});

test('la livraison groupe plusieurs épisodes dans une notification transactionnelle', async () => {
  const transaction = [];
  const pendingRows = [1, 2].map((episode, index) => ({
    id: index + 10,
    season_number: 4,
    episode_number: episode,
    user_id: 'user-1',
    user_type: 'oauth',
    profile_id: 'profile-1',
    content_type: 'tv',
    content_id: 99,
    content_title: 'Série test',
    language: 'fr',
  }));
  const connection = {
    async beginTransaction() { transaction.push('begin'); },
    async rollback() { transaction.push('rollback'); },
    async commit() { transaction.push('commit'); },
    release() { transaction.push('release'); },
    async execute(sql) {
      if (sql.includes('SELECT id FROM content_notification_events')) {
        return [[{ id: 10 }, { id: 11 }]];
      }
      if (sql.includes('INSERT INTO notifications')) {
        transaction.push('notification');
        return [{ insertId: 77 }];
      }
      if (sql.includes('UPDATE content_notification_events')) {
        transaction.push('events');
        return [{ affectedRows: 2 }];
      }
      throw new Error(`SQL inattendu: ${sql}`);
    },
  };
  const pool = {
    async execute(sql) {
      if (sql.includes('JOIN content_notification_trackers')) return [pendingRows];
      if (sql.includes('FROM user_notification_preferences')) return [[]];
      if (sql.includes('FROM push_subscriptions')) return [[]];
      throw new Error(`SQL inattendu: ${sql}`);
    },
    async getConnection() { return connection; },
  };

  const result = await deliverPendingEvents(pool, new Set());
  assert.deepEqual(result, { notifications: 1, pushes: 0 });
  assert.deepEqual(transaction, ['begin', 'notification', 'events', 'commit', 'release']);
});
