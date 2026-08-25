/**
 * Admin routes.
 * Extracted from server.js -- streaming links CRUD, VIP key management, admin checks, anime cache.
 * Mount point: app.use('/api', router)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { isAdmin, isUploaderOrAdmin } = require('../middleware/auth');
const { getPool } = require('../mysqlPool');
const { verifyAccessKey, invalidateVipCache } = require('../checkVip');
const { buildM3u8Map } = require('../utils/embedExtraction');
const { ANIME_SAMA_CACHE_DIR } = require('../utils/cacheManager');
const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const { logDownloadLinkAction } = require('../utils/downloadLinksHistory');
const { resolveAdminIdentity } = require('../utils/adminIdentity');
const { readUserData } = require('./sync');

function parseAccessKeyExpiresAt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return null;
  }

  if (/^\d+$/.test(normalizedValue)) {
    return Number(normalizedValue);
  }

  const parsed = new Date(
    normalizedValue.includes('T')
      ? normalizedValue
      : normalizedValue.replace(' ', 'T')
  );
  const timestamp = parsed.getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error('Date d\'expiration invalide');
  }

  return timestamp;
}

function buildAccessKeyExpiryFromDuration(durationLabel) {
  if (!durationLabel) {
    return null;
  }

  const now = new Date();
  const match = durationLabel.match(/(\d+)\s*(min|minute|minutes|h|hour|hours|heure|heures|d|day|days|jour|jours|m|month|months|mois|y|year|years|an|ans)/i);

  if (!match) {
    return null;
  }

  const duration = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('min')) {
    now.setMinutes(now.getMinutes() + duration);
  } else if (unit.startsWith('h')) {
    now.setHours(now.getHours() + duration);
  } else if (unit.startsWith('d') || unit.startsWith('j')) {
    now.setDate(now.getDate() + duration);
  } else if (unit.startsWith('m')) {
    now.setMonth(now.getMonth() + duration);
  } else if (unit.startsWith('y') || unit.startsWith('an')) {
    now.setFullYear(now.getFullYear() + duration);
  }

  return now.getTime();
}

// Rate limiter pour la vérification de codes VIP
// 5 tentatives par IP toutes les 15 minutes (plus strict car code bruteforceable)
const vipCodeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:admin:vip-code-check:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de tentatives de vérification. Réessayez dans 15 minutes.'
  },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false }
});

// === PUBLIC ROUTES (no authentication) ===

/**
 * GET /links/:type/:id
 * Retrieve streaming links for a movie or series
 * Params: type (movie/tv), id (TMDB ID)
 * Query: season (optional for series), episode (optional for series)
 */
router.get('/links/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode } = req.query;

    // Validation
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    const pool = getPool();
    let query, params;

    if (type === 'movie') {
      query = 'SELECT id, links FROM films WHERE id = ?';
      params = [id];
    } else {
      // Pour les séries
      if (!season || !episode) {
        // Retourner tous les épisodes de la série
        query = 'SELECT id, series_id, season_number, episode_number, links FROM series WHERE series_id = ? ORDER BY season_number, episode_number';
        params = [id];
      } else {
        // Retourner un épisode spécifique
        query = 'SELECT id, series_id, season_number, episode_number, links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?';
        params = [id, parseInt(season), parseInt(episode)];
      }
    }

    const [rows] = await pool.execute(query, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Aucun lien trouvé',
        type,
        id,
        ...(season && { season }),
        ...(episode && { episode })
      });
    }

    // Parser les liens JSON. On retire le stamp `added_by` (identité de
    // l'uploader) car cet endpoint est PUBLIC — pas de fuite d'IDs.
    const result = rows.map(row => {
      const parsed = typeof row.links === 'string' ? JSON.parse(row.links) : row.links;
      return {
        ...row,
        links: Array.isArray(parsed) ? parsed.map(stripLinkOwner) : parsed
      };
    });

    const payload = {
      success: true,
      type,
      data: type === 'movie' ? result[0] : result
    };

    // Résolution serveur des m3u8, sur demande explicite (`?resolve=1`) et pour
    // un VIP seulement. Ces liens sont soumis par les uploaders et stockés en
    // base : ils viennent donc du serveur, pas du client, au même titre que les
    // catalogues scrapés.
    //
    // Une entrée peut être une chaîne nue ou un objet {url, label, ...} : on ne
    // peut pas greffer un champ sur les premières, d'où la table parallèle
    // `m3u8ByPlayer` (même convention qu'Anime-Sama).
    //
    // Pour une série sans `season`+`episode`, la requête ci-dessus renvoie TOUS
    // les épisodes : on ne résout pas, sous peine d'extraire une saison entière
    // pour une seule lecture.
    const cibleUnique = type === 'movie' || (season && episode);
    if (String(req.query.resolve || '') === '1' && cibleUnique) {
      try {
        const accessKey = req.headers['x-access-key'] || null;
        const vipStatus = await verifyAccessKey(accessKey);
        if (vipStatus?.vip) {
          const urls = result.flatMap(row =>
            (Array.isArray(row.links) ? row.links : [])
              .map(lien => (typeof lien === 'string' ? lien : lien?.url))
          );
          payload.m3u8ByPlayer = await buildM3u8Map(urls, { accessKey });
        }
      } catch (extractionError) {
        // Bonus : les liens restent servis si la résolution échoue.
        console.error(`[LINKS] Extraction ${type}/${id} échouée: ${extractionError.message}`);
      }
    }

    res.json(payload);

  } catch (error) {
    console.error('Error fetching streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des liens',
      message: error.message
    });
  }
});

/**
 * POST /verify-access-code
 * Verify a VIP access code (used during initial code entry)
 * Body: { code: string }
 */
router.post('/verify-access-code', vipCodeRateLimit, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code d\'accès requis'
      });
    }

    // Utiliser le module centralisé checkVip
    const vipStatus = await verifyAccessKey(code);

    if (!vipStatus.vip) {
      if (vipStatus.reason === 'key_expired') {
        return res.status(410).json({
          success: false,
          error: 'Code d\'accès expiré'
        });
      }
      if (vipStatus.reason === 'key_inactive') {
        return res.status(403).json({
          success: false,
          error: 'Code d\'accès désactivé'
        });
      }
      return res.status(404).json({
        success: false,
        error: 'Code d\'accès invalide ou expiré'
      });
    }

    return res.json({
      success: true,
      message: 'Code d\'accès valide',
      data: {
        key: code,
        duration: vipStatus.duration,
        expiresAt: vipStatus.expiresAt
      }
    });

  } catch (error) {
    console.error('Error verifying access code:', error);
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification du code d\'accès'
    });
  }
});

/**
 * GET /check-vip
 * Server-side VIP status check via x-access-key header.
 * Called periodically by the frontend to ensure the key is still valid.
 * If the key is no longer valid, the frontend must revoke the local VIP status.
 */
router.get('/check-vip', async (req, res) => {
  try {
    const accessKey = req.headers['x-access-key'];

    if (!accessKey) {
      return res.json({ vip: false, reason: 'no_key' });
    }

    const vipStatus = await verifyAccessKey(accessKey);

    return res.json({
      vip: vipStatus.vip,
      expiresAt: vipStatus.expiresAt || null,
      duration: vipStatus.duration || null,
      reason: vipStatus.reason || null
    });

  } catch (error) {
    console.error('Error checking VIP status:', error);
    return res.status(500).json({ vip: false, error: 'Erreur interne' });
  }
});

// === ADMIN ROUTES (with authentication) ===

/**
 * POST /admin/links
 * Add or update streaming links
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
/**
 * Streaming links live in the `links` JSON column as either a plain URL string
 * (legacy / scraper-added) or an object ({ url, isVip, label, language, ... }).
 * Links added through the admin panel are stamped with `added_by` (same shape as
 * download links) so deletion can be scoped: an uploader may only remove the
 * streaming links they added; a full admin may remove any. Un-stamped links
 * (legacy strings/objects) have no owner and are therefore admin-only.
 */
function streamingLinkUrl(link) {
  return typeof link === 'string' ? link : (link && link.url) || JSON.stringify(link);
}

function stampStreamingLink(link, { adminId, userType }) {
  const obj = typeof link === 'string' ? { url: link } : { ...link };
  obj.added_at = new Date().toISOString();
  obj.added_by = { id: String(adminId), auth_type: userType === 'bip39' ? 'bip-39' : 'oauth' };
  return obj;
}

function ownsStreamingLink(link, admin) {
  const stamp = link && typeof link === 'object' ? link.added_by : null;
  if (!stamp) return false;
  const myAuthType = admin.userType === 'bip39' ? 'bip-39' : 'oauth';
  return String(stamp.id) === String(admin.userId) && stamp.auth_type === myAuthType;
}

function canModifyStreamingLink(link, admin) {
  return admin.role === 'admin' || ownsStreamingLink(link, admin);
}

// Removes the `added_by` owner stamp before returning links on the PUBLIC
// endpoint, so uploader user IDs are not leaked to anonymous visitors.
function stripLinkOwner(link) {
  if (!link || typeof link !== 'object') return link;
  const { added_by, ...rest } = link;
  return rest;
}

router.post('/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, links, season, episode } = req.body;

    // Validation
    if (!type || !id || !links || !Array.isArray(links)) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id, links (array)'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'tv' && (season === undefined || season === null || episode === undefined || episode === null)) {
      return res.status(400).json({
        success: false,
        error: 'Pour les séries, season et episode sont requis'
      });
    }

    const pool = getPool();

    if (type === 'movie') {
      // Récupérer les liens existants
      const [existing] = await pool.execute(
        'SELECT links FROM films WHERE id = ?',
        [id]
      );

      const stampOpts = { adminId: req.admin.userId, userType: req.admin.userType };
      let finalLinks = links.map(l => stampStreamingLink(l, stampOpts));
      let movieUrlsToLog = links.map(streamingLinkUrl);
      if (existing.length > 0 && existing[0].links) {
        // Parse existing links
        const existingLinks = typeof existing[0].links === 'string'
          ? JSON.parse(existing[0].links)
          : existing[0].links;

        // Merge with new links, avoiding duplicates
        const existingUrls = new Set(existingLinks.map(streamingLinkUrl));

        const newLinksToAdd = links.filter(link => !existingUrls.has(streamingLinkUrl(link)));

        // Keep existing links untouched (preserve their original owner stamp);
        // only the freshly added ones get stamped with the current uploader.
        finalLinks = [...existingLinks, ...newLinksToAdd.map(l => stampStreamingLink(l, stampOpts))];
        movieUrlsToLog = newLinksToAdd.map(streamingLinkUrl);
      }

      // Log each new streaming link as 'added' in history (for leaderboard scoring)
      for (const url of movieUrlsToLog) {
        try {
          await logDownloadLinkAction({
            adminId: req.admin.userId,
            userType: req.admin.userType,
            action: 'added',
            mediaType: 'movie',
            tmdbId: id,
            season: null,
            episode: null,
            linkUrl: url,
            linkType: 'streaming',
          });
        } catch (e) {
          console.error('Failed to log streaming link add:', e);
        }
      }

      const linksJson = JSON.stringify(finalLinks);

      // Insérer ou mettre à jour le film
      await pool.execute(
        'INSERT INTO films (id, links) VALUES (?, ?) ON DUPLICATE KEY UPDATE links = VALUES(links), updated_at = CURRENT_TIMESTAMP',
        [id, linksJson]
      );

      res.json({
        success: true,
        message: 'Liens de film ajoutés/mis à jour avec succès',
        type: 'movie',
        id,
        linksCount: finalLinks.length
      });

    } else {
      // Insérer ou mettre à jour l'épisode de série
      // Vérifier si l'épisode existe déjà
      const [existing] = await pool.execute(
        'SELECT id, links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episode]
      );

      const stampOpts = { adminId: req.admin.userId, userType: req.admin.userType };
      let finalLinks = links.map(l => stampStreamingLink(l, stampOpts));
      let streamingUrlsToLog = links.map(streamingLinkUrl);
      if (existing.length > 0 && existing[0].links) {
        // Parse existing links
        const existingLinks = typeof existing[0].links === 'string'
          ? JSON.parse(existing[0].links)
          : existing[0].links;

        // Merge with new links, avoiding duplicates
        const existingUrls = new Set(existingLinks.map(streamingLinkUrl));

        const newLinksToAdd = links.filter(link => !existingUrls.has(streamingLinkUrl(link)));

        // Keep existing links untouched (preserve their original owner stamp);
        // only the freshly added ones get stamped with the current uploader.
        finalLinks = [...existingLinks, ...newLinksToAdd.map(l => stampStreamingLink(l, stampOpts))];
        streamingUrlsToLog = newLinksToAdd.map(streamingLinkUrl);
      }

      // Log each new streaming link as 'added' in history (for leaderboard scoring)
      for (const url of streamingUrlsToLog) {
        try {
          await logDownloadLinkAction({
            adminId: req.admin.userId,
            userType: req.admin.userType,
            action: 'added',
            mediaType: 'tv',
            tmdbId: id,
            season: Number(season),
            episode: Number(episode),
            linkUrl: url,
            linkType: 'streaming',
          });
        } catch (e) {
          console.error('Failed to log streaming link add:', e);
        }
      }

      const linksJson = JSON.stringify(finalLinks);

      if (existing.length > 0) {
        // Mise à jour
        await pool.execute(
          'UPDATE series SET links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
          [linksJson, id, season, episode]
        );
      } else {
        // Insertion
        await pool.execute(
          'INSERT INTO series (series_id, season_number, episode_number, links) VALUES (?, ?, ?, ?)',
          [id, season, episode, linksJson]
        );
      }

      res.json({
        success: true,
        message: 'Liens d\'épisode ajoutés/mis à jour avec succès',
        type: 'tv',
        id,
        season,
        episode,
        linksCount: finalLinks.length
      });
    }

  } catch (error) {
    console.error('Error adding streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout des liens',
      message: error.message
    });
  }
});

/**
 * DELETE /admin/links
 * Delete streaming links from a movie / TV episode.
 * Body: { type, id, season?, episode?, url? }
 *  - With `url`: delete that single link (ownership enforced — uploaders may
 *    only delete a link they added; admins may delete any).
 *  - Without `url`: delete every link the caller is allowed to remove
 *    (uploader → only their own links; admin → all). Links belonging to other
 *    uploaders are preserved. Clears the `links` array in place — the film /
 *    episode row itself is kept (so download_links and other columns survive).
 */
router.delete('/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, season, episode, url } = req.body;

    // Validation
    if (!type || !id) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'tv' && (season === undefined || season === null || episode === undefined || episode === null)) {
      return res.status(400).json({ success: false, error: 'Pour les séries, season et episode sont requis' });
    }

    const pool = getPool();

    // Load the current links array for the targeted movie / episode.
    let existing;
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT links FROM films WHERE id = ?', [id]);
      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Film non trouvé' });
      }
      existing = rows[0].links
        ? (typeof rows[0].links === 'string' ? JSON.parse(rows[0].links) : rows[0].links)
        : [];
    } else {
      const [rows] = await pool.execute(
        'SELECT links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episode]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Épisode non trouvé' });
      }
      existing = rows[0].links
        ? (typeof rows[0].links === 'string' ? JSON.parse(rows[0].links) : rows[0].links)
        : [];
    }
    existing = Array.isArray(existing) ? existing : [];

    let remaining;
    let removed;
    if (url) {
      // Single-link delete.
      const target = existing.find(l => streamingLinkUrl(l) === url);
      if (!target) {
        return res.status(404).json({ success: false, error: 'Lien non trouvé' });
      }
      if (!canModifyStreamingLink(target, req.admin)) {
        return res.status(403).json({ success: false, error: 'Vous ne pouvez supprimer que les liens que vous avez ajoutés' });
      }
      remaining = existing.filter(l => streamingLinkUrl(l) !== url);
      removed = [target];
    } else {
      // Bulk delete, scoped to what the caller owns.
      removed = existing.filter(l => canModifyStreamingLink(l, req.admin));
      remaining = existing.filter(l => !canModifyStreamingLink(l, req.admin));
      if (removed.length === 0) {
        return res.status(403).json({ success: false, error: 'Aucun lien vous appartenant à supprimer' });
      }
    }

    const remainingJson = JSON.stringify(remaining);
    if (type === 'movie') {
      await pool.execute('UPDATE films SET links = ? WHERE id = ?', [remainingJson, id]);
    } else {
      await pool.execute(
        'UPDATE series SET links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [remainingJson, id, season, episode]
      );
    }

    // History logging (leaderboard scoring) for each removed link.
    for (const link of removed) {
      try {
        await logDownloadLinkAction({
          adminId: req.admin.userId,
          userType: req.admin.userType,
          action: 'removed',
          mediaType: type,
          tmdbId: id,
          season: type === 'tv' ? Number(season) : null,
          episode: type === 'tv' ? Number(episode) : null,
          linkUrl: streamingLinkUrl(link),
          linkType: 'streaming',
        });
      } catch (e) {
        console.error('Failed to log streaming link removal:', e);
      }
    }

    res.json({
      success: true,
      message: `${removed.length} lien(s) supprimé(s)`,
      type,
      id,
      ...(type === 'tv' && { season, episode }),
      removedCount: removed.length,
      totalCount: remaining.length,
    });

  } catch (error) {
    console.error('Error deleting streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression des liens',
      message: error.message
    });
  }
});

/**
 * PUT /admin/links
 * Modify streaming links (complete replacement)
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
router.put('/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, links, season, episode } = req.body;

    // Validation
    if (!type || !id || !links || !Array.isArray(links)) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id, links (array)'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'tv' && (season === undefined || season === null || episode === undefined || episode === null)) {
      return res.status(400).json({
        success: false,
        error: 'Pour les séries, season et episode sont requis'
      });
    }

    // Full-array replacement would let an uploader overwrite (and thereby delete)
    // links added by other uploaders, bypassing the per-link ownership check.
    // Reserve it for full admins; uploaders add via POST and remove via DELETE.
    if (req.admin.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Les uploaders ne peuvent pas remplacer les liens en masse. Supprimez uniquement vos propres liens.'
      });
    }

    const pool = getPool();
    const linksJson = JSON.stringify(links);

    if (type === 'movie') {
      const [result] = await pool.execute(
        'UPDATE films SET links = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [linksJson, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Film non trouvé' });
      }

      res.json({
        success: true,
        message: 'Liens de film modifiés avec succès',
        type: 'movie',
        id,
        linksCount: links.length
      });

    } else {
      const [result] = await pool.execute(
        'UPDATE series SET links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [linksJson, id, season, episode]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Épisode non trouvé' });
      }

      res.json({
        success: true,
        message: 'Liens d\'épisode modifiés avec succès',
        type: 'tv',
        id,
        season,
        episode,
        linksCount: links.length
      });
    }

  } catch (error) {
    console.error('Error updating streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification des liens',
      message: error.message
    });
  }
});

/**
 * GET /admin/streaming-links/:type/:id  (authed)
 * Like the public GET /links but KEEPS the `added_by` owner stamp, so the admin
 * panel can hide the delete button on links the current uploader doesn't own.
 */
router.get('/admin/streaming-links/:type/:id', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode } = req.query;

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type must be movie or tv' });
    }

    const pool = getPool();
    let links = [];
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT links FROM films WHERE id = ?', [id]);
      links = rows[0]?.links
        ? (typeof rows[0].links === 'string' ? JSON.parse(rows[0].links) : rows[0].links)
        : [];
    } else {
      if (season == null || episode == null) {
        return res.status(400).json({ success: false, error: 'season and episode are required for tv' });
      }
      const [rows] = await pool.execute(
        'SELECT links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, Number(season), Number(episode)]
      );
      links = rows[0]?.links
        ? (typeof rows[0].links === 'string' ? JSON.parse(rows[0].links) : rows[0].links)
        : [];
    }

    res.json({ success: true, links: Array.isArray(links) ? links : [] });
  } catch (error) {
    console.error('Error fetching streaming links (admin):', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streaming links' });
  }
});

// === ADMIN ROUTES - VIP KEY MANAGEMENT ===

/**
 * GET /admin/check
 * Verify admin rights (admin or uploader)
 */
router.get('/admin/check', isUploaderOrAdmin, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Droits d\'administration confirmés',
      admin: {
        userId: req.admin.userId,
        userType: req.admin.userType,
        adminId: req.admin.adminId,
        role: req.admin.role // Inclure le rôle dans la réponse
      }
    });
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la vérification admin' });
  }
});

// =====================================
// TEAM MANAGEMENT (admins + uploaders) — admin only
// =====================================

// Normalises an incoming auth type to the DB enum used by the admins table.
const normalizeAdminAuthType = (raw) => {
  const v = String(raw || '').toLowerCase();
  if (v === 'bip39' || v === 'bip-39') return 'bip-39';
  if (v === 'oauth') return 'oauth';
  return null;
};

/**
 * GET /admin/admins
 * List every admin + uploader with their resolved identity (first Movix
 * profile name/avatar).
 */
router.get('/admin/admins', isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM admins ORDER BY created_at ASC');
    const members = await Promise.all(rows.map(async (r) => {
      const identity = await resolveAdminIdentity(r.user_id, r.auth_type, { preferProfile: true });
      return {
        id: r.id,
        userId: r.user_id,
        authType: r.auth_type,
        role: r.role || 'admin',
        username: identity.username,
        avatar: identity.avatar,
        createdAt: r.created_at,
      };
    }));
    res.json({ success: true, members });
  } catch (error) {
    console.error('Error listing admins:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération de l\'équipe' });
  }
});

/**
 * POST /admin/admins
 * Add an uploader by their bip39 / oauth user id. Admin only.
 * Body: { userId, authType: 'oauth' | 'bip39' }
 */
router.post('/admin/admins', isAdmin, async (req, res) => {
  try {
    const cleanUserId = String(req.body?.userId || '').trim();
    const normAuth = normalizeAdminAuthType(req.body?.authType);
    if (!cleanUserId || !normAuth) {
      return res.status(400).json({ success: false, error: 'userId et authType (oauth ou bip39) requis' });
    }

    // Confirm the target account actually exists before granting rights.
    // readUserData returns {} (not null) for a missing file, so check for the
    // markers a real account always has: at least one profile, or an auth blob.
    const userType = normAuth === 'bip-39' ? 'bip39' : 'oauth';
    let userData = null;
    try {
      userData = await readUserData(userType, cleanUserId);
    } catch {
      userData = null;
    }
    const userExists = !!userData && (
      (Array.isArray(userData.profiles) && userData.profiles.length > 0) || !!userData.auth
    );
    if (!userExists) {
      return res.status(404).json({ success: false, error: 'Aucun utilisateur trouvé avec cet identifiant' });
    }

    const pool = getPool();
    // user_id is globally UNIQUE in the admins table.
    const [existing] = await pool.execute('SELECT id, role FROM admins WHERE user_id = ?', [cleanUserId]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, error: 'Cet utilisateur est déjà admin ou uploader' });
    }

    await pool.execute(
      "INSERT INTO admins (user_id, auth_type, role) VALUES (?, ?, 'uploader')",
      [cleanUserId, normAuth]
    );

    const identity = await resolveAdminIdentity(cleanUserId, normAuth, { preferProfile: true });
    res.status(201).json({
      success: true,
      member: {
        userId: cleanUserId,
        authType: normAuth,
        role: 'uploader',
        username: identity.username,
        avatar: identity.avatar,
      },
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'Cet utilisateur est déjà admin ou uploader' });
    }
    console.error('Error adding uploader:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de l\'ajout de l\'uploader' });
  }
});

/**
 * DELETE /admin/admins/:id
 * Remove an uploader. Admin only. Admins cannot be removed through this route
 * (guards against accidental / malicious privilege removal).
 */
router.delete('/admin/admins/:id', isAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'ID invalide' });
    }
    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM admins WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Membre introuvable' });
    }
    if ((rows[0].role || 'admin') !== 'uploader') {
      return res.status(403).json({ success: false, error: 'Seuls les uploaders peuvent être retirés ici' });
    }
    await pool.execute('DELETE FROM admins WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing uploader:', error);
    res.status(500).json({ success: false, error: 'Erreur lors du retrait de l\'uploader' });
  }
});

/**
 * GET /admin/team/history?userId=&authType=&page=&limit=
 * Paginated add/remove action history (streaming + download links) for a given
 * admin / uploader, so an admin can audit what someone uploaded or deleted.
 * Admin only.
 */
router.get('/admin/team/history', isAdmin, async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    const normAuth = normalizeAdminAuthType(req.query.authType);
    if (!userId || !normAuth) {
      return res.status(400).json({ success: false, error: 'userId et authType requis' });
    }
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
    const offset = (page - 1) * limit;

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT action, link_type, media_type, tmdb_id, season, episode, link_url, changed_at
       FROM download_links_history
       WHERE admin_id = ? AND admin_auth_type = ?
       ORDER BY changed_at DESC
       LIMIT ? OFFSET ?`,
      [userId, normAuth, limit, offset]
    );
    const [countRows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM download_links_history WHERE admin_id = ? AND admin_auth_type = ?',
      [userId, normAuth]
    );
    const total = countRows[0]?.total || 0;
    res.json({ success: true, history: rows, total, hasMore: total > offset + rows.length });
  } catch (error) {
    console.error('Error fetching team history:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération de l\'historique' });
  }
});

/**
 * GET /admin/vip-keys
 * Retrieve all VIP keys
 * Query: active (optional, true/false), used (optional, true/false), search, page, limit
 */
router.get('/admin/vip-keys', isAdmin, async (req, res) => {
  try {
    const { active, used } = req.query;
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (active !== undefined) {
      conditions.push('active = ?');
      params.push(active === 'true' ? 1 : 0);
    }

    if (used !== undefined) {
      conditions.push('used = ?');
      params.push(used === 'true' ? 1 : 0);
    }

    if (search) {
      const likeSearch = `%${search}%`;
      conditions.push(`(
        key_value LIKE ?
        OR COALESCE(duree_validite, '') LIKE ?
        OR COALESCE(CAST(expires_at AS CHAR), '') LIKE ?
        OR COALESCE(DATE_FORMAT(FROM_UNIXTIME(expires_at / 1000), '%Y-%m-%d %H:%i:%s'), '') LIKE ?
        OR COALESCE(DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s'), '') LIKE ?
      )`);
      params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    let whereClause = '';
    if (conditions.length > 0) {
      whereClause = ` WHERE ${conditions.join(' AND ')}`;
    }

    const pool = getPool();
    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM access_keys${whereClause}`,
      params
    );
    const total = Number(countRow?.total || 0);

    const [rows] = await pool.execute(
      `SELECT * FROM access_keys${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      keys: rows,
      count: rows.length,
      total,
      page,
      limit,
      hasMore: offset + rows.length < total
    });

  } catch (error) {
    console.error('Error fetching VIP keys:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des clés VIP',
      message: error.message
    });
  }
});

/**
 * POST /admin/vip-keys
 * Add a new VIP key
 * Body: { key: string, duree_validite?: string, expires_at?: string }
 */
router.post('/admin/vip-keys', isAdmin, async (req, res) => {
  try {
    const { key, duree_validite, expires_at } = req.body;

    // Validation
    if (!key || key.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'La clé est requise et ne peut pas être vide'
      });
    }

    if (key.length > 255) {
      return res.status(400).json({
        success: false,
        error: 'La clé ne peut pas dépasser 255 caractères'
      });
    }

    const pool = getPool();

    // Vérifier si la clé existe déjà
    const [existing] = await pool.execute(
      'SELECT key_value FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Cette clé existe déjà'
      });
    }

    // Calculer la date d'expiration si duree_validite est fournie
    let expiresAtValue = parseAccessKeyExpiresAt(expires_at);

    if (duree_validite && !expires_at) {
      expiresAtValue = buildAccessKeyExpiryFromDuration(duree_validite);
    }

    // Insérer la nouvelle clé
    await pool.execute(
      'INSERT INTO access_keys (key_value, active, used, duree_validite, expires_at, created_at) VALUES (?, 1, 0, ?, ?, NOW())',
      [key, duree_validite || null, expiresAtValue || null]
    );

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    res.status(201).json({
      success: true,
      message: 'Clé VIP créée avec succès',
      key: {
        key_value: key,
        duree_validite: duree_validite || null,
        expires_at: expiresAtValue || null,
        active: true,
        used: false
      }
    });

  } catch (error) {
    console.error('Error adding VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout de la clé VIP',
      message: error.message
    });
  }
});

/**
 * PUT /admin/vip-keys/:key
 * Modify a VIP key (expiration, duration, status)
 * Body: { duree_validite?: string, expires_at?: string, active?: boolean, used?: boolean }
 */
router.put('/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { duree_validite, expires_at, active, used } = req.body;

    const pool = getPool();

    // Vérifier si la clé existe
    const [existing] = await pool.execute(
      'SELECT * FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Clé VIP non trouvée'
      });
    }

    // Construire la requête de mise à jour dynamiquement
    const updates = [];
    const params = [];

    if (duree_validite !== undefined) {
      updates.push('duree_validite = ?');
      params.push(duree_validite || null);

      // Si duree_validite est fournie, calculer la nouvelle date d'expiration
      if (duree_validite && expires_at === undefined) {
        const computedExpiresAt = buildAccessKeyExpiryFromDuration(duree_validite);
        if (computedExpiresAt !== null) {
          updates.push('expires_at = ?');
          params.push(computedExpiresAt);
        }
      }
    }

    if (expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(parseAccessKeyExpiresAt(expires_at));
    }

    if (active !== undefined) {
      updates.push('active = ?');
      params.push(active ? 1 : 0);
    }

    if (used !== undefined) {
      updates.push('used = ?');
      params.push(used ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Aucune modification fournie'
      });
    }

    params.push(key);

    await pool.execute(
      `UPDATE access_keys SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE key_value = ?`,
      params
    );

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    // Récupérer la clé mise à jour
    const [updated] = await pool.execute(
      'SELECT * FROM access_keys WHERE key_value = ?',
      [key]
    );

    res.json({
      success: true,
      message: 'Clé VIP modifiée avec succès',
      key: updated[0]
    });

  } catch (error) {
    console.error('Error updating VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification de la clé VIP',
      message: error.message
    });
  }
});

/**
 * DELETE /admin/vip-keys/:key
 * Delete a VIP key
 */
router.delete('/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;

    const pool = getPool();
    const [result] = await pool.execute(
      'DELETE FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Clé VIP non trouvée'
      });
    }

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    res.json({
      success: true,
      message: 'Clé VIP supprimée avec succès',
      key
    });

  } catch (error) {
    console.error('Error deleting VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression de la clé VIP',
      message: error.message
    });
  }
});

function mergeDownloadLinks(existing, incoming, { adminId, userType, fullSeason }) {
  const existingLinks = Array.isArray(existing) ? existing : [];
  const existingUrls = new Set(existingLinks.map(l => l.url));
  const toAdd = [];
  for (const link of incoming) {
    if (!link || typeof link !== 'object' || !link.url) continue;
    if (existingUrls.has(link.url)) continue;
    const entry = {
      url: String(link.url),
      language: String(link.language || ''),
      quality: String(link.quality || ''),
      sub: Boolean(link.sub),
      host: String(link.host || ''),
      size: link.size ? String(link.size) : '',
      added_at: new Date().toISOString(),
      added_by: { id: String(adminId), auth_type: userType === 'bip39' ? 'bip-39' : 'oauth' },
    };
    if (fullSeason) entry.full_saison = true;
    toAdd.push(entry);
    existingUrls.add(link.url);
  }
  return { merged: [...existingLinks, ...toAdd], added: toAdd };
}

/**
 * Ownership check for download links. Each link is stamped with the uploader
 * that added it (`added_by = { id, auth_type }`, see mergeDownloadLinks).
 * Returns true only when the stamp matches the current admin's identity.
 * Links with no `added_by` (legacy, added before attribution existed) are
 * treated as not-owned.
 */
function ownsDownloadLink(link, admin) {
  const stamp = link && link.added_by;
  if (!stamp) return false;
  const myAuthType = admin.userType === 'bip39' ? 'bip-39' : 'oauth';
  return String(stamp.id) === String(admin.userId) && stamp.auth_type === myAuthType;
}

/**
 * Authorises a delete/edit on a single download link. Full admins may modify
 * any link; uploaders may only modify the links they uploaded themselves.
 */
function canModifyDownloadLink(link, admin) {
  return admin.role === 'admin' || ownsDownloadLink(link, admin);
}

router.post('/admin/download-links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, links, season, episode, fullSeason } = req.body;

    if (!type || !id || !Array.isArray(links)) {
      return res.status(400).json({ success: false, error: 'Required: type, id, links[]' });
    }
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type must be movie or tv' });
    }
    if (type === 'movie' && fullSeason) {
      return res.status(400).json({ success: false, error: 'fullSeason is only valid for tv' });
    }
    if (type === 'tv') {
      if (season == null) {
        return res.status(400).json({ success: false, error: 'season is required for tv' });
      }
      if (!fullSeason && episode == null) {
        return res.status(400).json({ success: false, error: 'episode is required for tv (or set fullSeason=true)' });
      }
    }
    for (const l of links) {
      if (!l || !l.url || !l.language || !l.quality || !l.host) {
        return res.status(400).json({ success: false, error: 'Each link must have url, language, quality, host' });
      }
    }

    const pool = getPool();
    const adminId = req.admin.userId;
    const userType = req.admin.userType;
    const episodeForStorage = type === 'tv' ? (fullSeason ? 0 : Number(episode)) : null;

    let existing;
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT download_links FROM films WHERE id = ?', [id]);
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    } else {
      const [rows] = await pool.execute(
        'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episodeForStorage]
      );
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    }

    const { merged, added } = mergeDownloadLinks(existing, links, { adminId, userType, fullSeason: Boolean(fullSeason) });
    const mergedJson = JSON.stringify(merged);

    if (type === 'movie') {
      await pool.execute(
        'INSERT INTO films (id, download_links) VALUES (?, ?) ON DUPLICATE KEY UPDATE download_links = VALUES(download_links), updated_at = CURRENT_TIMESTAMP',
        [id, mergedJson]
      );
    } else {
      const [rows] = await pool.execute(
        'SELECT id FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episodeForStorage]
      );
      if (rows.length > 0) {
        await pool.execute(
          'UPDATE series SET download_links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
          [mergedJson, id, season, episodeForStorage]
        );
      } else {
        await pool.execute(
          'INSERT INTO series (series_id, season_number, episode_number, download_links) VALUES (?, ?, ?, ?)',
          [id, season, episodeForStorage, mergedJson]
        );
      }
    }

    for (const link of added) {
      await logDownloadLinkAction({
        adminId,
        userType,
        action: 'added',
        mediaType: type,
        tmdbId: id,
        season: type === 'tv' ? season : null,
        episode: type === 'tv' ? episodeForStorage : null,
        linkUrl: link.url,
      });
    }

    res.json({ success: true, addedCount: added.length, totalCount: merged.length });
  } catch (error) {
    console.error('Error adding download links:', error);
    res.status(500).json({ success: false, error: 'Failed to add download links', message: error.message });
  }
});

router.delete('/admin/download-links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, season, episode, url, fullSeason } = req.body;
    if (!type || !id || !url) {
      return res.status(400).json({ success: false, error: 'Required: type, id, url' });
    }
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type must be movie or tv' });
    }
    if (type === 'movie' && fullSeason) {
      return res.status(400).json({ success: false, error: 'fullSeason is only valid for tv' });
    }
    if (type === 'tv') {
      if (season == null) {
        return res.status(400).json({ success: false, error: 'season is required for tv' });
      }
      if (!fullSeason && episode == null) {
        return res.status(400).json({ success: false, error: 'episode is required for tv (or set fullSeason=true)' });
      }
    }

    const pool = getPool();
    const episodeForStorage = type === 'tv' ? (fullSeason ? 0 : Number(episode)) : null;
    let existing;
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT download_links FROM films WHERE id = ?', [id]);
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    } else {
      const [rows] = await pool.execute(
        'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episodeForStorage]
      );
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    }

    const target = existing.find(l => l.url === url);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Link not found' });
    }
    // Uploaders may only delete links they uploaded; admins may delete any.
    if (!canModifyDownloadLink(target, req.admin)) {
      return res.status(403).json({ success: false, error: 'Vous ne pouvez supprimer que les liens que vous avez ajoutés' });
    }
    const remaining = existing.filter(l => l.url !== url);

    const remainingJson = JSON.stringify(remaining);
    if (type === 'movie') {
      await pool.execute('UPDATE films SET download_links = ? WHERE id = ?', [remainingJson, id]);
    } else {
      await pool.execute(
        'UPDATE series SET download_links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [remainingJson, id, season, episodeForStorage]
      );
    }

    await logDownloadLinkAction({
      adminId: req.admin.userId,
      userType: req.admin.userType,
      action: 'removed',
      mediaType: type,
      tmdbId: id,
      season: type === 'tv' ? season : null,
      episode: type === 'tv' ? episodeForStorage : null,
      linkUrl: url,
    });

    res.json({ success: true, removedCount: 1, totalCount: remaining.length });
  } catch (error) {
    console.error('Error deleting download link:', error);
    res.status(500).json({ success: false, error: 'Failed to delete download link' });
  }
});

router.put('/admin/download-links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, season, episode, oldUrl, newLink, fullSeason } = req.body;
    if (!type || !id || !oldUrl || !newLink || !newLink.url) {
      return res.status(400).json({ success: false, error: 'Required: type, id, oldUrl, newLink.url' });
    }
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type must be movie or tv' });
    }
    if (type === 'movie' && fullSeason) {
      return res.status(400).json({ success: false, error: 'fullSeason is only valid for tv' });
    }
    if (type === 'tv') {
      if (season == null) {
        return res.status(400).json({ success: false, error: 'season is required for tv' });
      }
      if (!fullSeason && episode == null) {
        return res.status(400).json({ success: false, error: 'episode is required for tv (or set fullSeason=true)' });
      }
    }

    const pool = getPool();
    const episodeForStorage = type === 'tv' ? (fullSeason ? 0 : Number(episode)) : null;
    let existing;
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT download_links FROM films WHERE id = ?', [id]);
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    } else {
      const [rows] = await pool.execute(
        'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episodeForStorage]
      );
      existing = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
    }

    const idx = existing.findIndex(l => l.url === oldUrl);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Link not found' });
    }
    const original = existing[idx];
    // Uploaders may only edit links they uploaded; admins may edit any.
    if (!canModifyDownloadLink(original, req.admin)) {
      return res.status(403).json({ success: false, error: 'Vous ne pouvez modifier que les liens que vous avez ajoutés' });
    }
    existing[idx] = {
      ...original,
      url: String(newLink.url),
      language: newLink.language != null ? String(newLink.language) : original.language,
      quality: newLink.quality != null ? String(newLink.quality) : original.quality,
      sub: newLink.sub != null ? Boolean(newLink.sub) : original.sub,
      host: newLink.host != null ? String(newLink.host) : original.host,
      size: newLink.size != null ? String(newLink.size) : original.size,
    };

    const updatedJson = JSON.stringify(existing);
    if (type === 'movie') {
      await pool.execute('UPDATE films SET download_links = ? WHERE id = ?', [updatedJson, id]);
    } else {
      await pool.execute(
        'UPDATE series SET download_links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [updatedJson, id, season, episodeForStorage]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating download link:', error);
    res.status(500).json({ success: false, error: 'Failed to update download link' });
  }
});

router.get('/admin/download-links/:type/:id', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode, fullSeason } = req.query;

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type must be movie or tv' });
    }

    const pool = getPool();
    if (type === 'movie') {
      const [rows] = await pool.execute('SELECT download_links FROM films WHERE id = ?', [id]);
      const links = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
      return res.json({ success: true, links });
    }

    if (season == null) {
      return res.status(400).json({ success: false, error: 'season is required for tv' });
    }

    const isFullSeasonQuery = fullSeason === 'true' || fullSeason === true;

    if (isFullSeasonQuery) {
      const [rows] = await pool.execute(
        'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = 0',
        [id, Number(season)]
      );
      const links = rows[0]?.download_links
        ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
        : [];
      return res.json({ success: true, links });
    }

    if (episode == null) {
      return res.status(400).json({ success: false, error: 'episode is required for tv (or set fullSeason=true)' });
    }

    const [episodeRows] = await pool.execute(
      'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
      [id, Number(season), Number(episode)]
    );
    const [seasonRows] = await pool.execute(
      'SELECT download_links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = 0',
      [id, Number(season)]
    );

    const parse = (rows) => rows[0]?.download_links
      ? (typeof rows[0].download_links === 'string' ? JSON.parse(rows[0].download_links) : rows[0].download_links)
      : [];

    const links = [...parse(episodeRows), ...parse(seasonRows)];
    res.json({ success: true, links });
  } catch (error) {
    console.error('Error fetching download links:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch download links' });
  }
});

module.exports = router;
