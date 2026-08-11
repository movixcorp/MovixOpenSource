const webpush = require('web-push');

const VAPID_CONFIGURED = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_CONFIGURED) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:contact@movix.blog',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

function buildGroupNotification({ contentType, contentId, title, events, language = 'fr' }) {
  const sorted = [...events].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const first = sorted[0] || { season: 0, episode: 0 };
  const safeTitle = title || (language === 'en' ? 'This title' : 'Ce contenu');
  const seasons = new Set(sorted.map((event) => event.season));
  const isSeasonRelease = contentType === 'tv' && first.episode === 1 && seasons.size === 1;
  let notificationType = 'content_episode_available';
  let body;

  if (contentType === 'movie') {
    notificationType = 'content_movie_available';
    body = language === 'en'
      ? `${safeTitle} is now available on Movix.`
      : `${safeTitle} est maintenant disponible sur Movix.`;
  } else if (isSeasonRelease) {
    notificationType = 'content_season_available';
    body = language === 'en'
      ? `Season ${first.season} of ${safeTitle} is available${sorted.length > 1 ? ` (${sorted.length} episodes)` : ''}.`
      : `La saison ${first.season} de ${safeTitle} est disponible${sorted.length > 1 ? ` (${sorted.length} épisodes)` : ''}.`;
  } else if (sorted.length === 1) {
    body = language === 'en'
      ? `Episode S${first.season}E${first.episode} of ${safeTitle} is available.`
      : `L’épisode S${first.season}E${first.episode} de ${safeTitle} est disponible.`;
  } else {
    body = language === 'en'
      ? `${sorted.length} new episodes of ${safeTitle} are available.`
      : `${sorted.length} nouveaux épisodes de ${safeTitle} sont disponibles.`;
  }

  return {
    notificationType,
    body,
    push: {
      title: 'Movix',
      body,
      icon: '/movix.png',
      data: {
        contentType,
        contentId: String(contentId),
        season: first.season || undefined,
        episode: sorted.length === 1 ? first.episode : undefined,
        notificationType,
      },
    },
  };
}

async function insertInAppNotification(connection, {
  userId,
  userType,
  profileId,
  contentType,
  contentId,
  notificationType,
  body,
  createdAt,
}) {
  const [result] = await connection.execute(
    `INSERT INTO notifications
      (user_id, user_type, profile_id, from_user_id, from_profile_id, from_username,
       from_avatar, notification_type, target_type, target_id, content_type, content_id,
       comment_preview, created_at)
     VALUES (?, ?, ?, 'movix-system', NULL, 'Movix', '/movix.png', ?,
             'content_availability', 0, ?, ?, ?, ?)`,
    [
      userId,
      userType,
      profileId,
      notificationType,
      contentType,
      String(contentId),
      body,
      createdAt,
    ],
  );
  return result.insertId;
}

async function sendPushToUser(pool, userId, userType, payload, logger = console) {
  if (!VAPID_CONFIGURED) return { sent: 0, unavailable: true };
  const [subscriptions] = await pool.execute(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND user_type = ?',
    [userId, userType],
  );
  let sent = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, JSON.stringify(payload));
      sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await pool.execute('DELETE FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint]);
      } else {
        logger.warn(`[ContentNotifications] Échec Web Push: ${error.message}`);
      }
    }
  }

  return { sent, unavailable: false };
}

module.exports = {
  VAPID_CONFIGURED,
  buildGroupNotification,
  insertInAppNotification,
  sendPushToUser,
};
