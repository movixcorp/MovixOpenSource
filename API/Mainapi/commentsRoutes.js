﻿const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { getPool } = require("./mysqlPool");
const { verifyAccessKey } = require("./checkVip");
// Réutiliser l'instance Redis partagée au lieu d'en créer une nouvelle (évite les fuites mémoire)
const { redis } = require("./config/redis");
const { verifyTurnstileFromRequest } = require("./utils/turnstile");
// Signalement d'une proposition de sequence deposee depuis le lecteur : elle
// n'a rien d'un commentaire, mais elle se modere au meme endroit, avec les
// memes etats et les memes notifications. Voir `target_type = 'segment'`.
const {
  deleteSubmissionAsModerator,
  ensureReportSchema: ensureSegmentReportSchema,
  getSubmissionRow: getSegmentSubmissionRow,
} = require("./services/mediaSegments/communityStore");
const webpush = require("web-push");

// === Web Push VAPID config ===
const VAPID_CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_CONFIGURED) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:contact@movix.blog",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️  VAPID keys not configured — push notifications disabled");
}

// === #15: JWT_SECRET chargé une seule fois au démarrage ===
const JWT_SECRET = process.env.JWT_SECRET;

// === Vérification de bannissement ===
async function checkBan(userId, userType, ip) {
  const now = Date.now();
  // Vérifier ban par user_id
  const userBan = await dbGet(
    `SELECT * FROM banned_users WHERE ban_type = 'user' AND ban_value = ? AND user_type = ? AND (expires_at IS NULL OR expires_at > ?)`,
    [userId, userType, now],
  );
  if (userBan)
    return {
      banned: true,
      reason: userBan.reason,
      expires_at: userBan.expires_at,
    };

  // Vérifier ban par IP
  if (ip) {
    const ipBan = await dbGet(
      `SELECT * FROM banned_users WHERE ban_type = 'ip' AND ban_value = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [ip, now],
    );
    if (ipBan)
      return {
        banned: true,
        reason: ipBan.reason,
        expires_at: ipBan.expires_at,
      };
  }

  return { banned: false };
}

// === #16: Pool MySQL caché pour éviter d'appeler getPool() à chaque query ===
let _cachedPool = null;
function getCachedPool() {
  if (!_cachedPool) _cachedPool = getPool();
  return _cachedPool;
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_COMMENTS_WEBHOOK_URL;
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL;

// Normalize user-entered content while keeping the original characters intact.
function normalizeCommentContent(text) {
  if (typeof text !== "string") return text;
  // Replace 3+ consecutive newlines (with optional spaces/tabs between them) with max 2 newlines
  return text.replace(/(\s*\n\s*){3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(text) {
  if (typeof text !== "string" || !text.includes("&")) return text;

  const namedEntities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00A0",
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lowerEntity = entity.toLowerCase();

    if (namedEntities[lowerEntity]) {
      return namedEntities[lowerEntity];
    }

    if (lowerEntity.startsWith("#x")) {
      const codePoint = parseInt(lowerEntity.slice(2), 16);
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }

    if (lowerEntity.startsWith("#")) {
      const codePoint = parseInt(lowerEntity.slice(1), 10);
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }

    return match;
  });
}

// Champs internes jamais exposés au public (fuite de données perso).
// Les routes /admin/* gardent l'accès brut (bannissement par IP).
const PRIVATE_ROW_FIELDS = ["ip_address"];

// Retire les champs privés d'une ligne SQL avant de la renvoyer au client.
function stripPrivateFields(row) {
  if (!row || typeof row !== "object") return row;
  const safe = { ...row };
  for (const field of PRIVATE_ROW_FIELDS) delete safe[field];
  return safe;
}

// Decode legacy escaped content before returning it to the frontend.
function formatContentForResponse(text) {
  let formatted = normalizeCommentContent(text);

  // Older comments were stored escaped, and some routes escaped them a second time on read.
  // Decoding twice fixes both stored legacy entities and previously double-escaped payloads.
  for (let i = 0; i < 2; i += 1) {
    const decoded = decodeHtmlEntities(formatted);
    if (decoded === formatted) break;
    formatted = decoded;
  }

  return formatted;
}

// OpenRouter API Configuration for content moderation (using DeepSeek V4 Flash)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";

// Fonction de modération avec OpenRouter (exécutée en background)
async function moderateContentWithAI(
  contentId,
  contentType,
  content,
  username,
) {
  try {
    const prompt = `Tu es un modérateur de commentaires. Analyse le commentaire ET le pseudo suivants et réponds UNIQUEMENT par un JSON valide.

Pseudo de l'utilisateur: ${JSON.stringify(username)}
Commentaire à analyser: ${JSON.stringify(content)}

Critères de modération (s'appliquent au pseudo ET au commentaire). Ne flag QUE les violations claires et évidentes ; en cas de doute, ne pas flagger :
1. INSULTES: Insultes, injures, propos haineux ou dégradants visant une personne ou un groupe. Le simple agacement, les majuscules ou la ponctuation excessive ne sont PAS des insultes.
2. EROTIQUE: Contient du contenu érotique, sexuel ou inapproprié
3. DEMANDE_AJOUT: UNIQUEMENT une demande explicite d'ajouter un nouveau film/série/contenu au catalogue (ex: "ajoutez le film X svp", "vous pouvez mettre la série Y ?"). NE PAS flagger : les questions, les signalements de bug ("les épisodes ne marchent pas", "lien mort", "ce n'est pas le bon film"), les plaintes sur du contenu manquant ou retiré ("où est la saison 5 ?", "pourquoi la saison 5 a disparu ?"), les demandes d'aide à un modérateur, ni la discussion normale.
4. PSEUDO_INAPPROPRIE: Le pseudo contient des insultes, contenu érotique, ou est inapproprié

Réponds UNIQUEMENT avec ce format JSON (sans markdown, sans backticks):
{"flagged": true/false, "reason": "INSULTES" ou "EROTIQUE" ou "DEMANDE_AJOUT" ou "PSEUDO_INAPPROPRIE" ou null, "details": "explication courte"}`;

    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 500,
        temperature: 0.1,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": FRONTEND_BASE_URL,
          "X-Title": "Movix Comment Moderation",
        },
        timeout: 15000,
      },
    );

    const responseText = response.data?.choices?.[0]?.message?.content || "";

    // Parser la réponse JSON
    let moderationResult;
    try {
      // Nettoyer la réponse (enlever les backticks markdown si présents)
      const cleanedResponse = responseText
        .replace(/```json\n?|```\n?/g, "")
        .trim();
      moderationResult = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(
        "❌ Erreur parsing réponse OpenRouter:",
        parseError,
        "Response:",
        responseText,
      );
      return { flagged: false };
    }

    if (moderationResult.flagged) {
      console.log(
        `🚨 Contenu flaggé (${contentType} ID: ${contentId}): ${moderationResult.reason} - ${moderationResult.details}`,
      );

      // Marquer le contenu comme supprimé (deleted = 1) et stocker la raison
      const table = contentType === "comment" ? "comments" : "comment_replies";
      await dbRun(
        `UPDATE ${table} SET deleted = 1, moderation_reason = ?, moderation_details = ?, moderated_at = ? WHERE id = ?`,
        [
          moderationResult.reason,
          moderationResult.details,
          Date.now(),
          contentId,
        ],
      );

      console.log(
        `✅ ${contentType} ID ${contentId} marqué comme supprimé pour modération`,
      );
    }

    return moderationResult;
  } catch (error) {
    console.error(
      "❌ Erreur modération OpenRouter (non bloquant):",
      error.message,
    );
    return { flagged: false };
  }
}

// Fonctions helper MySQL pour remplacer SQLite (#16: pool caché)
const dbRun = async (sql, params = []) => {
  const pool = getCachedPool();
  const [result] = await pool.execute(sql, params);
  return {
    lastID: result.insertId || 0,
    changes: result.affectedRows || 0,
  };
};

const dbGet = async (sql, params = []) => {
  const pool = getCachedPool();
  const [rows] = await pool.execute(sql, params);
  return rows.length > 0 ? rows[0] : null;
};

const dbAll = async (sql, params = []) => {
  const pool = getCachedPool();
  const [rows] = await pool.execute(sql, params);
  return rows;
};

// Middleware pour vérifier l'authentification avec validation session MySQL
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Non authentifié" });
  }

  // Vérifier le token JWT (#15: jwt importé au top du fichier)
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    const { sub: userId, userType, sessionId } = decoded;

    if (!["oauth", "bip39"].includes(userType) || !userId || !sessionId) {
      return res.status(401).json({ error: "Token invalide" });
    }

    // Vérifier que la session existe en MySQL
    const pool = getCachedPool();
    const [rows] = await pool.execute(
      "SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?",
      [sessionId, userId, userType],
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Session invalide ou expirée" });
    }

    req.user = {
      userId: userId,
      userType: userType,
      sessionId: sessionId,
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token invalide" });
  }
};

// Rate limit pour les actions d'écriture (commentaires/réponses/réactions/notifications)
// - Clef = userId post-auth (fallback IP CF/X-Forwarded-For derrière Cloudflare)
// - Store Redis partagé entre workers du cluster (sinon chaque worker compte indépendamment)
// - passOnStoreError: si Redis tombe, fail-open au lieu de bloquer toutes les requêtes
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { createRedisRateLimitStore } = require("./utils/redisRateLimitStore");
const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  store: createRedisRateLimitStore({
    prefix: "rate-limit:comments:write:",
    windowMs: 60 * 1000,
  }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes. Réessayez dans une minute." },
  keyGenerator: (req) => {
    if (req.user) return `u:${req.user.userType}:${req.user.userId}`;
    return (
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      ipKeyGenerator(req.ip)
    );
  },
  validate: {
    xForwardedForHeader: false,
    ip: false,
    keyGeneratorIpFallback: false,
  },
});

// Init paresseux des tables notifs/push (évite un DDL par requête, idempotent en cas de redémarrage)
let _notificationTablesInitialized = false;
let _notificationTablesInitPromise = null;
async function ensureNotificationTables() {
  if (_notificationTablesInitialized) return;
  if (_notificationTablesInitPromise) return _notificationTablesInitPromise;
  _notificationTablesInitPromise = (async () => {
    const pool = getCachedPool();
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id VARCHAR(255) NOT NULL,
        user_type VARCHAR(50) NOT NULL,
        notifications_disabled TINYINT(1) DEFAULT 0,
        updated_at BIGINT,
        PRIMARY KEY (user_id, user_type)
      )`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_type VARCHAR(50) NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at BIGINT,
        INDEX idx_user_push (user_id, user_type)
      )`
    );
    _notificationTablesInitialized = true;
  })();
  try {
    await _notificationTablesInitPromise;
  } finally {
    _notificationTablesInitPromise = null;
  }
}

// Helper to get allowed profile IDs (security check)
async function getProfileIds(userId, userType) {
  try {
    // Sanitize userId to prevent path traversal
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, "");
    let userFilePath;
    if (userType === "bip39") {
      userFilePath = path.join(
        __dirname,
        "data",
        "users",
        `bip39-${safeUserId}.json`,
      );
    } else {
      userFilePath = path.join(
        __dirname,
        "data",
        "users",
        `${safeUserId}.json`,
      );
    }

    try {
      const userFile = await fs.readFile(userFilePath, "utf8");
      const user = JSON.parse(userFile);

      const profileIds = [];
      if (user.profiles) {
        user.profiles.forEach((p) => profileIds.push(p.id));
      } else {
        // Fallback for old structure might be needed but typically not for profileId spoofing protection
      }
      return profileIds;
    } catch (err) {
      // if (err.code !== 'ENOENT') console.error('Error reading user file:', err);
      return [];
    }
  } catch (error) {
    console.error("Error getting profile IDs:", error);
    return [];
  }
}

// === #14: Cache getUserData dans Redis (TTL 5 min) pour éviter les lectures fichier à chaque requête ===
const USER_DATA_CACHE_TTL = 300; // 5 minutes en secondes

// Fonction interne pour récupérer les données utilisateur depuis le disque/MySQL (sans cache)
async function _fetchUserData(userId, userType, profileId = null) {
  try {
    let userData = {
      username: "Utilisateur",
      avatar: null,
      isVip: false,
      isAdmin: false,
    };

    // Sanitize inputs to prevent path traversal
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, "");
    const safeUserType = ["oauth", "bip39"].includes(userType)
      ? userType
      : "oauth";
    const safeProfileId = profileId
      ? String(profileId).replace(/[^a-zA-Z0-9_\-]/g, "")
      : null;

    // Chemin vers le fichier utilisateur
    let userFilePath;
    if (safeUserType === "bip39") {
      userFilePath = path.join(
        __dirname,
        "data",
        "users",
        `bip39-${safeUserId}.json`,
      );
    } else {
      userFilePath = path.join(
        __dirname,
        "data",
        "users",
        `${safeUserId}.json`,
      );
    }

    // Lire le fichier utilisateur
    try {
      const userFile = await fs.readFile(userFilePath, "utf8");
      const user = JSON.parse(userFile);

      // Récupérer le profil
      if (profileId && user.profiles) {
        const profile = user.profiles.find((p) => p.id === profileId);
        if (profile) {
          userData.username = profile.name || "Utilisateur";
          // Sanitize avatar: must start with /avatars/
          if (profile.avatar && profile.avatar.startsWith("/avatars/")) {
            userData.avatar = profile.avatar;
          } else {
            userData.avatar = "/avatars/disney/disney_avatar_1.png"; // Default fallback
          }
        }
      } else if (user.profiles && user.profiles.length > 0) {
        // Utiliser le profil par défaut
        const defaultProfile =
          user.profiles.find((p) => p.isDefault) || user.profiles[0];
        userData.username = defaultProfile.name || "Utilisateur";
        // Sanitize avatar: must start with /avatars/
        if (
          defaultProfile.avatar &&
          defaultProfile.avatar.startsWith("/avatars/")
        ) {
          userData.avatar = defaultProfile.avatar;
        } else {
          userData.avatar = "/avatars/disney/disney_avatar_1.png"; // Default fallback
        }
      }
    } catch (err) {
      // Fichier utilisateur introuvable — on garde les valeurs par défaut
    }

    // Vérifier le statut VIP en lisant l'access_code depuis les données du profil
    // puis en le vérifiant contre la table MySQL access_keys
    if (safeProfileId && safeUserId) {
      try {
        const profileDataPath = path.join(
          __dirname,
          "data",
          "users",
          "profiles",
          safeUserType,
          safeUserId,
          `${safeProfileId}.json`,
        );
        const profileData = JSON.parse(
          await fs.readFile(profileDataPath, "utf8"),
        );
        const storedAccessCode = profileData.access_code || null;
        if (storedAccessCode) {
          const vipStatus = await verifyAccessKey(storedAccessCode);
          userData.isVip = vipStatus.vip;
        }
      } catch (err) {
        // Pas de données de profil ou pas d'access_code — isVip reste false
      }
    }

    // Vérifier si Admin (en utilisant MySQL)
    try {
      const pool = getCachedPool();
      const authType = userType === "bip39" ? "bip-39" : userType;
      const [rows] = await pool.execute(
        "SELECT 1 FROM admins WHERE user_id = ? AND auth_type = ? LIMIT 1",
        [userId, authType],
      );
      userData.isAdmin = rows.length > 0;
    } catch (err) {
      console.error("❌ Erreur lors de la vérification admin:", err);
    }

    return userData;
  } catch (error) {
    console.error("Erreur _fetchUserData:", error);
    return {
      username: "Utilisateur",
      avatar: null,
      isVip: false,
      isAdmin: false,
    };
  }
}

// Fonction publique avec cache Redis (#14)
async function getUserData(userId, userType, profileId = null) {
  const cacheKey = `userData:${userType}:${userId}:${profileId || "default"}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    /* Redis indisponible, on continue sans cache */
  }

  const userData = await _fetchUserData(userId, userType, profileId);

  // Mettre en cache (fire-and-forget)
  try {
    redis
      .set(cacheKey, JSON.stringify(userData), "EX", USER_DATA_CACHE_TTL)
      .catch(() => {});
  } catch {
    /* ignore */
  }

  return userData;
}

// Fonction pour créer une notification
async function isNotificationDisabledForUser(userId, userType) {
  try {
    const [rows] = await getPool().execute(
      'SELECT notifications_disabled FROM user_notification_preferences WHERE user_id = ? AND user_type = ? LIMIT 1',
      [userId, userType]
    );
    return rows.length > 0 && rows[0].notifications_disabled === 1;
  } catch {
    return false;
  }
}

let pushTableReady = false;
async function ensurePushTable() {
  if (pushTableReady) return;
  try {
    await getPool().execute(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_type VARCHAR(50) NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at BIGINT,
        INDEX idx_user_push (user_id, user_type)
      )`
    );
    pushTableReady = true;
  } catch {}
}

async function sendPushToUser(userId, userType, payload) {
  if (!VAPID_CONFIGURED) return;
  try {
    await ensurePushTable();
    const pool = getPool();
    const [subs] = await pool.execute(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND user_type = ?',
      [userId, userType]
    );
    const data = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        }, data);
      } catch (err) {
        // Si la subscription est expirée ou invalide, la supprimer
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.execute('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
        }
      }
    }
  } catch (error) {
    console.error("Erreur lors de l'envoi push:", error);
  }
}

async function createNotification(
  toUserId,
  toUserType,
  toProfileId,
  fromUserId,
  fromProfileId,
  fromUsername,
  fromAvatar,
  notificationType,
  targetType,
  targetId,
  contentType,
  contentId,
  commentPreview,
) {
  try {
    if (await isNotificationDisabledForUser(toUserId, toUserType)) {
      return;
    }

    await dbRun(
      `INSERT INTO notifications (user_id, user_type, profile_id, from_user_id, from_profile_id, from_username, from_avatar, notification_type, target_type, target_id, content_type, content_id, comment_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toUserId,
        toUserType,
        toProfileId,
        fromUserId,
        fromProfileId,
        fromUsername,
        fromAvatar,
        notificationType,
        targetType,
        targetId,
        contentType,
        contentId,
        commentPreview,
        Date.now(),
      ],
    );

    // Envoyer une notification push
    const pushMessages = {
      reply: `${fromUsername} a répondu à votre commentaire`,
      like: `${fromUsername} a aimé votre commentaire`,
      reaction: `${fromUsername} a réagi à votre commentaire`,
      mention: `${fromUsername} vous a mentionné`,
      report_resolved: `Votre signalement a été traité`,
      report_resolved_deleted: `Votre signalement a été traité (contenu supprimé)`,
      report_dismissed: `Votre signalement a été rejeté`,
    };
    sendPushToUser(toUserId, toUserType, {
      title: "Movix",
      body: pushMessages[notificationType] || "Nouvelle notification",
      icon: "/movix.png",
      data: { contentType, contentId, notificationType },
    });
  } catch (error) {
    console.error("Erreur lors de la création de la notification:", error);
  }
}

const REPORT_NOTIFICATION_TYPES = {
  RESOLVED: "report_resolved",
  RESOLVED_DELETED: "report_resolved_deleted",
  DISMISSED: "report_dismissed",
};

async function getReportNotificationTarget(report) {
  try {
    if (report.target_type === "comment") {
      const comment = await dbGet(
        "SELECT content_type, content_id FROM comments WHERE id = ?",
        [report.target_id],
      );
      if (comment) {
        return {
          contentType: comment.content_type,
          contentId: String(comment.content_id),
          targetId: Number(report.target_id),
        };
      }
    } else if (report.target_type === "reply") {
      const reply = await dbGet(
        "SELECT comment_id FROM comment_replies WHERE id = ?",
        [report.target_id],
      );
      if (reply) {
        const comment = await dbGet(
          "SELECT content_type, content_id FROM comments WHERE id = ?",
          [reply.comment_id],
        );
        if (comment) {
          return {
            contentType: comment.content_type,
            contentId: String(comment.content_id),
            targetId: Number(report.target_id),
          };
        }
      }
    } else if (report.target_type === "shared_list") {
      const pool = getCachedPool();
      const [rows] = await pool.execute(
        "SELECT id, share_code FROM shared_lists WHERE share_code = ? OR id = ?",
        [report.target_id, report.target_id],
      );
      if (rows.length > 0) {
        const sharedList = rows[0];
        return {
          contentType: "shared_list",
          contentId: String(sharedList.share_code || sharedList.id || report.target_id),
          targetId: Number(sharedList.id) || Number(report.target_id) || 0,
        };
      }
    } else if (report.target_type === "segment") {
      const submission = await getSegmentSubmissionRow(report.target_id);
      if (submission) {
        // Le contenu vise, pas la proposition : la notification renvoie le
        // signaleur sur la fiche du film ou de la serie.
        return {
          contentType: submission.media_type,
          contentId: String(submission.tmdb_id),
          targetId: Number(report.target_id) || 0,
        };
      }
    }
  } catch (error) {
    console.error("Erreur lors de la préparation de la notification de signalement:", error);
  }

  return {
    contentType: report.target_type,
    contentId: String(report.target_id),
    targetId: Number(report.target_id) || 0,
  };
}

// === #18: Batch cascade delete — requêtes batch au lieu de récursion séquentielle ===

// Fonction helper pour récupérer tous les IDs de réponses d'un commentaire (ou sous-arbre d'une réponse)
async function getAllReplyIds(
  commentId,
  parentReplyId = null,
  includeDeleted = false,
) {
  const deletedFilter = includeDeleted ? "" : " AND deleted = 0";
  if (parentReplyId === null) {
    // Toutes les réponses du commentaire
    const replies = await dbAll(
      `SELECT id FROM comment_replies WHERE comment_id = ?${deletedFilter}`,
      [commentId],
    );
    return replies.map((r) => r.id);
  }
  // Sous-arbre d'une réponse spécifique : récupérer récursivement via hierarchical_path
  // Récupérer le path du parent
  const parent = await dbGet(
    "SELECT hierarchical_path FROM comment_replies WHERE id = ?",
    [parentReplyId],
  );
  if (!parent || !parent.hierarchical_path) return [parentReplyId];

  const descendants = await dbAll(
    `SELECT id FROM comment_replies WHERE comment_id = ? AND hierarchical_path LIKE ?${deletedFilter}`,
    [commentId, `${parent.hierarchical_path}.%`],
  );
  return [parentReplyId, ...descendants.map((r) => r.id)];
}

// Batch delete des réactions et notifications pour une liste d'IDs de réponses
async function batchDeleteReplyDependencies(replyIds) {
  if (replyIds.length === 0) return;
  const placeholders = replyIds.map(() => "?").join(",");

  // Supprimer les réactions de toutes les réponses en batch
  await dbRun(
    `DELETE FROM comment_reactions WHERE target_type = 'reply' AND target_id IN (${placeholders})`,
    replyIds,
  );

  // Supprimer les notifications liées à ces réponses en batch
  await dbRun(
    `DELETE FROM notifications WHERE target_type = 'reply' AND target_id IN (${placeholders})`,
    replyIds,
  );

  // Supprimer les notifications de réaction sur ces réponses en batch
  await dbRun(
    `DELETE FROM notifications WHERE notification_type = 'reaction' AND target_type = 'reply' AND target_id IN (${placeholders})`,
    replyIds,
  );
}

// Soft delete cascade : marquer les réponses comme supprimées en batch
async function deleteRepliesCascade(commentId, replyId = null) {
  try {
    const replyIds = await getAllReplyIds(commentId, replyId, false);
    if (replyIds.length === 0) return;

    await batchDeleteReplyDependencies(replyIds);

    // Soft delete toutes les réponses en batch
    const placeholders = replyIds.map(() => "?").join(",");
    await dbRun(
      `UPDATE comment_replies SET deleted = 1 WHERE id IN (${placeholders})`,
      replyIds,
    );

    console.log(
      `✅ ${replyIds.length} réponse(s) supprimées en cascade (soft) pour commentaire ${commentId}`,
    );
  } catch (error) {
    console.error(
      "Erreur lors de la suppression en cascade des réponses:",
      error,
    );
    throw error;
  }
}

// Soft delete cascade pour un commentaire entier
async function deleteCommentCascade(commentId) {
  try {
    // 1. Récupérer tous les IDs de réponses du commentaire
    const replyIds = await getAllReplyIds(commentId, null, false);

    // 2. Supprimer les dépendances de toutes les réponses en batch
    if (replyIds.length > 0) {
      await batchDeleteReplyDependencies(replyIds);
      const placeholders = replyIds.map(() => "?").join(",");
      await dbRun(
        `UPDATE comment_replies SET deleted = 1 WHERE id IN (${placeholders})`,
        replyIds,
      );
    }

    // 3. Supprimer les réactions du commentaire
    await dbRun(
      `DELETE FROM comment_reactions WHERE target_type = 'comment' AND target_id = ?`,
      [commentId],
    );

    // 4. Supprimer les notifications du commentaire
    await dbRun(
      `DELETE FROM notifications WHERE target_type = 'comment' AND target_id = ?`,
      [commentId],
    );
    await dbRun(
      `DELETE FROM notifications WHERE notification_type = 'reaction' AND target_type = 'comment' AND target_id = ?`,
      [commentId],
    );

    // 5. Soft delete le commentaire
    await dbRun("UPDATE comments SET deleted = 1 WHERE id = ?", [commentId]);

    console.log(
      `✅ Commentaire ${commentId} et ${replyIds.length} réponse(s) supprimés en cascade`,
    );
  } catch (error) {
    console.error(
      "Erreur lors de la suppression en cascade du commentaire:",
      error,
    );
    throw error;
  }
}

// Hard delete cascade : suppression définitive d'une réponse et ses enfants
async function hardDeleteRepliesCascade(commentId, replyId) {
  try {
    const replyIds = await getAllReplyIds(commentId, replyId, true);
    if (replyIds.length === 0) return;

    await batchDeleteReplyDependencies(replyIds);

    // Hard delete toutes les réponses en batch
    const placeholders = replyIds.map(() => "?").join(",");
    await dbRun(
      `DELETE FROM comment_replies WHERE id IN (${placeholders})`,
      replyIds,
    );

    console.log(
      `🗑️ ${replyIds.length} réponse(s) supprimées définitivement pour commentaire ${commentId}`,
    );
  } catch (error) {
    console.error(
      "Erreur lors de la suppression définitive des réponses:",
      error,
    );
    throw error;
  }
}

// Hard delete cascade pour un commentaire entier
async function hardDeleteCommentCascade(commentId) {
  try {
    // 1. Récupérer tous les IDs de réponses (y compris déjà supprimées)
    const replyIds = await getAllReplyIds(commentId, null, true);

    // 2. Supprimer les dépendances en batch
    if (replyIds.length > 0) {
      await batchDeleteReplyDependencies(replyIds);
      const placeholders = replyIds.map(() => "?").join(",");
      await dbRun(
        `DELETE FROM comment_replies WHERE id IN (${placeholders})`,
        replyIds,
      );
    }

    // 3. Supprimer les réactions et notifications du commentaire
    await dbRun(
      `DELETE FROM comment_reactions WHERE target_type = 'comment' AND target_id = ?`,
      [commentId],
    );
    await dbRun(
      `DELETE FROM notifications WHERE target_type = 'comment' AND target_id = ?`,
      [commentId],
    );
    await dbRun(
      `DELETE FROM notifications WHERE notification_type = 'reaction' AND target_type = 'comment' AND target_id = ?`,
      [commentId],
    );

    // 4. Hard delete le commentaire
    await dbRun("DELETE FROM comments WHERE id = ?", [commentId]);

    console.log(
      `🗑️ Commentaire ${commentId} et ${replyIds.length} réponse(s) supprimés définitivement`,
    );
  } catch (error) {
    console.error(
      "Erreur lors de la suppression définitive du commentaire:",
      error,
    );
    throw error;
  }
}

// Fonction pour récupérer l'adresse IP de la requête
// Priorité : cf-connecting-ip (Cloudflare, impossible à spoof) > x-real-ip > x-forwarded-for > fallbacks
function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "Unknown"
  );
}

// Fonction pour envoyer un webhook Discord
async function sendDiscordWebhook(type, data) {
  try {
    const {
      username,
      avatar,
      content,
      contentType,
      contentId,
      isSpoiler,
      isVip,
      isAdmin,
      replyToUsername,
      userId,
      userType,
      profileId,
      ipAddress,
    } = data;

    // Validation et limitation des valeurs selon les spécifications Discord
    // Description: max 2048 caractères
    const description =
      content && typeof content === "string"
        ? content.length > 2048
          ? content.substring(0, 2045) + "..."
          : content
        : "Aucun contenu";

    // Titre: max 256 caractères
    const title = (
      type === "comment" ? "💬 Nouveau commentaire" : "💬 Nouvelle réponse"
    ).substring(0, 256);

    // Champs: name max 256, value max 1024 caractères
    const usernameValue = String(username || "Utilisateur").substring(0, 1024);
    const contentTypeValue = String(
      contentType === "movie"
        ? "🎬 Film"
        : contentType === "tv"
          ? "📺 Série"
          : contentType || "Inconnu",
    ).substring(0, 1024);
    const contentIdValue = String(contentId || "N/A").substring(0, 1024);

    // Construire le lien vers le film/série
    const contentUrl =
      contentId && contentType
        ? `${FRONTEND_BASE_URL}/${contentType === "movie" ? "movie" : "tv"}/${contentId}`
        : null;

    const embed = {
      title: title,
      description: description,
      color: isAdmin ? 0xff0000 : isVip ? 0xffd700 : 0x3498db,
      url: contentUrl || undefined, // Lien cliquable sur le titre
      fields: [
        {
          name: "👤 Utilisateur".substring(0, 256),
          value: usernameValue,
          inline: true,
        },
        {
          name: "📺 Contenu".substring(0, 256),
          value: contentTypeValue,
          inline: true,
        },
        {
          name: "🆔 ID Contenu".substring(0, 256),
          value: contentIdValue,
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: String(
          isAdmin ? "👑 Administrateur" : isVip ? "⭐ VIP" : "👤 Utilisateur",
        ).substring(0, 2048),
      },
    };

    // Ajouter les informations utilisateur
    if (userId) {
      embed.fields.push({
        name: "🆔 User ID".substring(0, 256),
        value: String(userId).substring(0, 1024),
        inline: true,
      });
    }

    if (profileId) {
      embed.fields.push({
        name: "🎭 Profile ID".substring(0, 256),
        value: String(profileId).substring(0, 1024),
        inline: true,
      });
    }

    if (userType) {
      embed.fields.push({
        name: "🔐 User Type".substring(0, 256),
        value: String(userType).substring(0, 1024),
        inline: true,
      });
    }

    if (ipAddress) {
      embed.fields.push({
        name: "🌐 IP Address".substring(0, 256),
        value: String(ipAddress).substring(0, 1024),
        inline: true,
      });
    }

    // Ajouter un champ avec le lien si disponible
    if (contentUrl) {
      embed.fields.push({
        name: "🔗 Lien".substring(0, 256),
        value:
          `[Voir ${contentType === "movie" ? "le film" : "la série"}](${contentUrl})`.substring(
            0,
            1024,
          ),
        inline: false,
      });
    }

    if (isSpoiler) {
      embed.fields.push({
        name: "⚠️ Spoiler".substring(0, 256),
        value: "Oui",
        inline: true,
      });
    }

    if (type === "reply" && replyToUsername) {
      embed.fields.push({
        name: "↩️ Réponse à".substring(0, 256),
        value: String(replyToUsername).substring(0, 1024),
        inline: true,
      });
    }

    // Vérifier que l'avatar est une URL valide
    if (
      avatar &&
      typeof avatar === "string" &&
      avatar.trim().length > 0 &&
      (avatar.startsWith("http://") || avatar.startsWith("https://"))
    ) {
      embed.thumbnail = {
        url: avatar.trim().substring(0, 2048),
      };
    }

    await axios.post(
      DISCORD_WEBHOOK_URL,
      {
        embeds: [embed],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
  } catch (error) {
    console.error(
      "Erreur lors de l'envoi du webhook Discord:",
      error.response?.data || error.message,
    );
    // Ne pas bloquer l'exécution si le webhook échoue
  }
}

// ==================== ROUTES NOTIFICATIONS ====================

// GET /api/comments/notifications - Récupérer les notifications de l'utilisateur
router.get("/notifications", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly = false, profileId } = req.query;
    const safePage = Math.max(1, Math.min(parseInt(page) || 1, 1000));
    const safeLimit = Math.max(1, Math.min(parseInt(limit) || 20, 100));
    const offset = (safePage - 1) * safeLimit;

    // Validation du profileId
    if (!profileId) {
      return res.status(400).json({ error: "profileId requis" });
    }

    // Vérifier que le profileId appartient bien à l'utilisateur authentifié
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    let query =
      "SELECT * FROM notifications WHERE user_id = ? AND user_type = ? AND profile_id = ?";
    const params = [req.user.userId, req.user.userType, profileId];

    if (unreadOnly === "true") {
      query += " AND is_read = 0";
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(safeLimit, offset);

    const notifications = await dbAll(query, params);

    res.json({ notifications });
  } catch (error) {
    console.error("Erreur lors de la récupération des notifications:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/notifications/:id/read - Marquer une notification comme lue
router.put("/notifications/:id/read", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId } = req.body;

    // Validation du profileId
    if (!profileId) {
      return res.status(400).json({ error: "profileId requis" });
    }

    // Vérifier que le profileId appartient bien à l'utilisateur authentifié
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    await dbRun(
      "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ? AND user_type = ? AND profile_id = ?",
      [id, req.user.userId, req.user.userType, profileId],
    );

    res.json({ message: "Notification marquée comme lue" });
  } catch (error) {
    console.error("Erreur lors du marquage de la notification:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/notifications/read-all - Marquer toutes les notifications comme lues
router.put("/notifications/read-all", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { profileId } = req.body;

    // Validation du profileId
    if (!profileId) {
      return res.status(400).json({ error: "profileId requis" });
    }

    // Vérifier que le profileId appartient bien à l'utilisateur authentifié
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    await dbRun(
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND user_type = ? AND profile_id = ?",
      [req.user.userId, req.user.userType, profileId],
    );

    res.json({
      message: "Toutes les notifications ont été marquées comme lues",
    });
  } catch (error) {
    console.error("Erreur lors du marquage des notifications:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/notifications/:id - Supprimer une notification
router.delete("/notifications/:id", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId } = req.query;

    // Validation du profileId
    if (!profileId) {
      return res.status(400).json({ error: "profileId requis" });
    }

    // Vérifier que le profileId appartient bien à l'utilisateur authentifié
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    // Vérifier que la notification appartient à l'utilisateur et au profil
    const notification = await dbGet(
      "SELECT * FROM notifications WHERE id = ? AND user_id = ? AND user_type = ? AND profile_id = ?",
      [id, req.user.userId, req.user.userType, profileId],
    );

    if (!notification) {
      return res.status(404).json({ error: "Notification non trouvée" });
    }

    // Supprimer la notification
    await dbRun(
      "DELETE FROM notifications WHERE id = ? AND user_id = ? AND user_type = ? AND profile_id = ?",
      [id, req.user.userId, req.user.userType, profileId],
    );

    res.json({ message: "Notification supprimée" });
  } catch (error) {
    console.error("Erreur lors de la suppression de la notification:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/notifications/preferences - Récupérer les préférences de notifications
router.get("/notifications/preferences", requireAuth, async (req, res) => {
  try {
    await ensureNotificationTables();
    const pool = getCachedPool();
    const [rows] = await pool.execute(
      'SELECT notifications_disabled FROM user_notification_preferences WHERE user_id = ? AND user_type = ? LIMIT 1',
      [req.user.userId, req.user.userType]
    );

    res.json({
      success: true,
      notificationsDisabled: rows.length > 0 && rows[0].notifications_disabled === 1,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des préférences:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/notifications/preferences - Mettre à jour les préférences de notifications
router.put("/notifications/preferences", requireAuth, writeRateLimit, async (req, res) => {
  try {
    await ensureNotificationTables();
    const disabled = req.body?.notificationsDisabled === true;
    const pool = getCachedPool();
    await pool.execute(
      `INSERT INTO user_notification_preferences (user_id, user_type, notifications_disabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE notifications_disabled = VALUES(notifications_disabled), updated_at = VALUES(updated_at)`,
      [req.user.userId, req.user.userType, disabled ? 1 : 0, Date.now()]
    );

    res.json({ success: true, notificationsDisabled: disabled });
  } catch (error) {
    console.error("Erreur lors de la mise à jour des préférences:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/comments/notifications/push/subscribe - Enregistrer une subscription push
router.post("/notifications/push/subscribe", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { subscription } = req.body;
    // Validation stricte: endpoint + keys.p256dh + keys.auth requis
    if (
      !subscription ||
      typeof subscription.endpoint !== "string" ||
      !subscription.endpoint ||
      !subscription.keys ||
      typeof subscription.keys.p256dh !== "string" ||
      !subscription.keys.p256dh ||
      typeof subscription.keys.auth !== "string" ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({ error: "Subscription invalide" });
    }

    await ensureNotificationTables();
    const pool = getCachedPool();

    // Vérifier si l'endpoint existe déjà — refuser le hijack cross-user
    const [existing] = await pool.execute(
      'SELECT user_id, user_type FROM push_subscriptions WHERE endpoint = ? LIMIT 1',
      [subscription.endpoint]
    );

    if (existing.length > 0) {
      const owner = existing[0];
      if (
        String(owner.user_id) !== String(req.user.userId) ||
        String(owner.user_type) !== String(req.user.userType)
      ) {
        // Endpoint appartient à un autre compte — refuser (anti-hijack push)
        return res
          .status(409)
          .json({ error: "Endpoint déjà associé à un autre compte" });
      }
      // Même owner: rotate les clés (cas normal, le browser peut renouveler les clés)
      await pool.execute(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, created_at = ? WHERE endpoint = ? AND user_id = ? AND user_type = ?',
        [
          subscription.keys.p256dh,
          subscription.keys.auth,
          Date.now(),
          subscription.endpoint,
          req.user.userId,
          req.user.userType,
        ]
      );
    } else {
      await pool.execute(
        'INSERT INTO push_subscriptions (user_id, user_type, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          req.user.userId,
          req.user.userType,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          Date.now(),
        ]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Erreur lors de l'enregistrement push:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/notifications/push/unsubscribe - Supprimer une subscription push
router.delete("/notifications/push/unsubscribe", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "Endpoint manquant" });
    await ensureNotificationTables();
    const pool = getCachedPool();
    await pool.execute('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ? AND user_type = ?', [endpoint, req.user.userId, req.user.userType]);
    res.json({ success: true });
  } catch (error) {
    console.error("Erreur lors de la désinscription push:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/notifications/push/vapid-key - Récupérer la clé publique VAPID
router.get("/notifications/push/vapid-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ==================== ROUTES RÉACTIONS ====================

// POST /api/comments/react - Ajouter/retirer une réaction
router.post("/react", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { targetType, targetId, profileId } = req.body; // targetType: 'comment' ou 'reply'

    // Whitelist targetType pour éviter pollution de la table comment_reactions
    if (!["comment", "reply"].includes(targetType)) {
      return res.status(400).json({ error: "targetType invalide" });
    }

    // Verify profile ownership
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    // Vérifier si la réaction existe déjà
    const existingReaction = await dbGet(
      "SELECT * FROM comment_reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND user_type = ? AND profile_id = ?",
      [targetType, targetId, req.user.userId, req.user.userType, profileId],
    );

    if (existingReaction) {
      // Retirer la réaction
      await dbRun("DELETE FROM comment_reactions WHERE id = ?", [
        existingReaction.id,
      ]);

      res.json({ reacted: false });
    } else {
      // Ajouter la réaction
      await dbRun(
        "INSERT INTO comment_reactions (target_type, target_id, user_id, user_type, profile_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          targetType,
          targetId,
          req.user.userId,
          req.user.userType,
          profileId,
          Date.now(),
        ],
      );

      // Créer une notification pour l'auteur du commentaire/réponse
      let targetUserId, targetUserType, targetProfileId, contentType, contentId;
      if (targetType === "comment") {
        const comment = await dbGet("SELECT * FROM comments WHERE id = ?", [
          targetId,
        ]);
        if (comment) {
          targetUserId = comment.user_id;
          targetUserType = comment.user_type;
          targetProfileId = comment.profile_id;
          contentType = comment.content_type;
          contentId = comment.content_id;

          // Ne pas créer de notification si on réagit à son propre commentaire
          if (
            targetUserId !== req.user.userId ||
            targetUserType !== req.user.userType ||
            targetProfileId !== profileId
          ) {
            const userData = await getUserData(
              req.user.userId,
              req.user.userType,
              profileId,
            );
            await createNotification(
              targetUserId,
              targetUserType,
              targetProfileId,
              req.user.userId,
              profileId,
              userData.username,
              userData.avatar,
              "reaction",
              targetType,
              targetId,
              contentType,
              contentId,
              comment.content.substring(0, 100),
            );
          }
        }
      } else if (targetType === "reply") {
        const reply = await dbGet(
          "SELECT * FROM comment_replies WHERE id = ?",
          [targetId],
        );
        if (reply) {
          targetUserId = reply.user_id;
          targetUserType = reply.user_type;
          targetProfileId = reply.profile_id;

          // Récupérer le commentaire parent pour avoir le contentType et contentId
          const comment = await dbGet("SELECT * FROM comments WHERE id = ?", [
            reply.comment_id,
          ]);
          if (comment) {
            contentType = comment.content_type;
            contentId = comment.content_id;

            // Ne pas créer de notification si on réagit à sa propre réponse
            if (
              targetUserId !== req.user.userId ||
              targetUserType !== req.user.userType ||
              targetProfileId !== profileId
            ) {
              const userData = await getUserData(
                req.user.userId,
                req.user.userType,
                profileId,
              );
              await createNotification(
                targetUserId,
                targetUserType,
                targetProfileId,
                req.user.userId,
                profileId,
                userData.username,
                userData.avatar,
                "reaction",
                targetType,
                targetId,
                contentType,
                contentId,
                reply.content.substring(0, 100),
              );
            }
          }
        }
      }

      res.json({ reacted: true });
    }
  } catch (error) {
    console.error("Erreur lors de la gestion de la réaction:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/reactions/:targetType/:targetId - Vérifier si l'utilisateur a réagi
router.get(
  "/reactions/:targetType/:targetId",
  requireAuth,
  async (req, res) => {
    try {
      const { targetType, targetId } = req.params;
      const { profileId } = req.query;

      // Whitelist targetType
      if (!["comment", "reply"].includes(targetType)) {
        return res.status(400).json({ error: "targetType invalide" });
      }

      const reaction = await dbGet(
        "SELECT * FROM comment_reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND user_type = ? AND profile_id = ?",
        [targetType, targetId, req.user.userId, req.user.userType, profileId],
      );

      res.json({ reacted: !!reaction });
    } catch (error) {
      console.error("Erreur lors de la vérification de la réaction:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
);

// ==================== ROUTES RÉPONSES ====================

// GET /api/comments/:commentId/replies - Récupérer les réponses d'un commentaire (avec ordre hiérarchique)
// === #13: Optimisé — une seule requête SQL avec sous-requêtes au lieu de N+1 ===
router.get("/:commentId/replies", async (req, res) => {
  try {
    const { commentId } = req.params;
    const safePage = Math.max(1, Math.min(parseInt(req.query.page) || 1, 1000));
    const safeLimit = Math.max(1, Math.min(parseInt(req.query.limit) || 3, 50));
    const offset = (safePage - 1) * safeLimit;

    // Tenter de récupérer l'utilisateur connecté (optionnel)
    let currentUser = null;
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, {
          algorithms: ["HS256"],
        });
        currentUser = {
          userId: decoded.sub,
          userType: decoded.userType,
          sessionId: decoded.sessionId,
        };
      } catch (error) {
        // Token invalide, on continue sans utilisateur
      }
    }

    const { profileId } = req.query;

    // Récupérer le total de réponses
    const totalResult = await dbGet(
      "SELECT COUNT(*) as total FROM comment_replies WHERE comment_id = ? AND deleted = 0",
      [commentId],
    );

    // #13: Requête unique avec COUNT des réactions + check user reaction via sous-requête
    let repliesQuery;
    let repliesParams;

    if (currentUser && profileId) {
      repliesQuery = `
        SELECT cr.*,
          (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'reply' AND target_id = cr.id) as reaction_count,
          EXISTS(SELECT 1 FROM comment_reactions WHERE target_type = 'reply' AND target_id = cr.id
                 AND user_id = ? AND user_type = ? AND profile_id = ?) as user_reacted
        FROM comment_replies cr
        WHERE cr.comment_id = ? AND cr.deleted = 0
        ORDER BY cr.hierarchical_path ASC
        LIMIT ? OFFSET ?`;
      repliesParams = [
        currentUser.userId,
        currentUser.userType,
        profileId,
        commentId,
        safeLimit,
        offset,
      ];
    } else {
      repliesQuery = `
        SELECT cr.*,
          (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'reply' AND target_id = cr.id) as reaction_count
        FROM comment_replies cr
        WHERE cr.comment_id = ? AND cr.deleted = 0
        ORDER BY cr.hierarchical_path ASC
        LIMIT ? OFFSET ?`;
      repliesParams = [commentId, safeLimit, offset];
    }

    const replies = await dbAll(repliesQuery, repliesParams);

    // Cache utilisateur en mémoire pour cette requête (getUserData est déjà caché dans Redis via #14)
    const userDataCache = new Map();

    const repliesWithDetails = await Promise.all(
      replies.map(async (reply) => {
        const userKey = `${reply.user_id}:${reply.user_type}:${reply.profile_id || "default"}`;
        let userData = userDataCache.get(userKey);
        if (!userData) {
          userData = await getUserData(
            reply.user_id,
            reply.user_type,
            reply.profile_id,
          );
          userDataCache.set(userKey, userData);
        }

        return {
          ...stripPrivateFields(reply),
          content: formatContentForResponse(reply.content),
          username: userData.username,
          avatar: userData.avatar,
          is_vip: userData.isVip ? 1 : 0,
          is_admin: userData.isAdmin ? 1 : 0,
          reactions: reply.reaction_count,
          userReaction:
            reply.user_reacted !== undefined ? !!reply.user_reacted : null,
        };
      }),
    );

    res.json({
      replies: repliesWithDetails,
      total: totalResult.total,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + repliesWithDetails.length < totalResult.total,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des réponses:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/comments/:commentId/replies - Créer une réponse
router.post("/:commentId/replies", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { commentId } = req.params;
    let {
      content,
      isSpoiler,
      profileId,
      parentReplyId,
      replyToUsername,
      turnstileToken,
    } = req.body;

    // Vérification Turnstile
    const turnstileResult = await verifyTurnstileFromRequest(
      req,
      turnstileToken,
    );
    if (!turnstileResult.valid)
      return res
        .status(turnstileResult.status)
        .json({ error: turnstileResult.error });

    // Normalize content while preserving the original characters
    content = normalizeCommentContent(content);

    console.log("💬 Création de réponse - Données reçues:", {
      commentId,
      content,
      isSpoiler,
      profileId,
      parentReplyId,
      replyToUsername,
    });

    // Verify profile ownership
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    // Vérification de bannissement
    const replyUserData = await getUserData(
      req.user.userId,
      req.user.userType,
      profileId,
    );
    if (!replyUserData.isAdmin) {
      const banStatus = await checkBan(
        req.user.userId,
        req.user.userType,
        getClientIp(req),
      );
      if (banStatus.banned) {
        return res.status(403).json({
          error: "Vous êtes banni des commentaires.",
          reason: banStatus.reason,
          expires_at: banStatus.expires_at,
        });
      }
    }

    // Validation
    if (!content || content.length > 500) {
      return res
        .status(400)
        .json({ error: "La réponse doit contenir entre 1 et 500 caractères" });
    }

    // Vérifier que le commentaire existe
    const comment = await dbGet(
      "SELECT * FROM comments WHERE id = ? AND deleted = 0",
      [commentId],
    );
    if (!comment) {
      console.log(`❌ Commentaire ${commentId} non trouvé`);
      return res.status(404).json({ error: "Commentaire non trouvé" });
    }
    console.log(`✅ Commentaire ${commentId} trouvé`);
    // Récupérer les données utilisateur
    const userData = await getUserData(
      req.user.userId,
      req.user.userType,
      profileId,
    );
    console.log("👤 Données utilisateur pour la réponse:", userData);

    // Calculer le hierarchical_path
    let hierarchicalPath;
    if (!parentReplyId) {
      // Réponse racine : trouver le max des réponses racines
      const maxPath = await dbGet(
        `SELECT MAX(hierarchical_path) as max_path
         FROM comment_replies
         WHERE comment_id = ? AND parent_reply_id IS NULL AND deleted = 0`,
        [commentId],
      );

      if (maxPath && maxPath.max_path) {
        // Extraire le numéro et incrémenter
        const currentNum = parseInt(maxPath.max_path.split(".")[0], 10);
        hierarchicalPath = String(currentNum + 1).padStart(3, "0");
      } else {
        // Première réponse
        hierarchicalPath = "001";
      }
    } else {
      // Réponse à une autre réponse : récupérer le path du parent
      const parentReply = await dbGet(
        "SELECT hierarchical_path FROM comment_replies WHERE id = ?",
        [parentReplyId],
      );

      if (!parentReply || !parentReply.hierarchical_path) {
        return res.status(404).json({ error: "Réponse parent non trouvée" });
      }

      // Trouver le max des enfants de ce parent
      const maxChildPath = await dbGet(
        `SELECT MAX(hierarchical_path) as max_path
         FROM comment_replies
         WHERE comment_id = ? AND parent_reply_id = ? AND deleted = 0`,
        [commentId, parentReplyId],
      );

      if (maxChildPath && maxChildPath.max_path) {
        // Extraire le dernier numéro et incrémenter
        const parts = maxChildPath.max_path.split(".");
        const lastNum = parseInt(parts[parts.length - 1], 10);
        hierarchicalPath = `${parentReply.hierarchical_path}.${String(lastNum + 1).padStart(3, "0")}`;
      } else {
        // Premier enfant de ce parent
        hierarchicalPath = `${parentReply.hierarchical_path}.001`;
      }
    }

    console.log(`📊 Hierarchical path calculé: ${hierarchicalPath}`);

    // Insérer la réponse
    console.log("💾 Insertion de la réponse dans la base...");
    const result = await dbRun(
      `INSERT INTO comment_replies (comment_id, parent_reply_id, user_id, user_type, profile_id, username, avatar, reply_to_username, content, is_spoiler, is_vip, is_admin, created_at, hierarchical_path, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commentId,
        parentReplyId || null,
        req.user.userId,
        req.user.userType,
        profileId,
        userData.username,
        userData.avatar,
        replyToUsername || null,
        content,
        isSpoiler ? 1 : 0,
        userData.isVip ? 1 : 0,
        userData.isAdmin ? 1 : 0,
        Date.now(),
        hierarchicalPath,
        getClientIp(req),
      ],
    );
    console.log("✅ Réponse insérée avec ID:", result.lastID);

    // Créer une notification pour l'auteur du commentaire ou de la réponse parent
    let targetUserId, targetUserType, targetProfileId;
    if (parentReplyId) {
      const parentReply = await dbGet(
        "SELECT * FROM comment_replies WHERE id = ?",
        [parentReplyId],
      );
      targetUserId = parentReply.user_id;
      targetUserType = parentReply.user_type;
      targetProfileId = parentReply.profile_id;
    } else {
      targetUserId = comment.user_id;
      targetUserType = comment.user_type;
      targetProfileId = comment.profile_id;
    }

    // Ne pas créer de notification si on se répond à soi-même
    if (
      targetUserId !== req.user.userId ||
      targetUserType !== req.user.userType ||
      targetProfileId !== profileId
    ) {
      await createNotification(
        targetUserId,
        targetUserType,
        targetProfileId,
        req.user.userId,
        profileId,
        userData.username,
        userData.avatar,
        "reply",
        "reply",
        result.lastID,
        comment.content_type,
        comment.content_id,
        content.substring(0, 100),
      );
    }

    // Récupérer la réponse créée
    const newReply = await dbGet("SELECT * FROM comment_replies WHERE id = ?", [
      result.lastID,
    ]);

    // Envoyer le webhook Discord en arrière-plan (ne pas attendre)
    sendDiscordWebhook("reply", {
      username: userData.username,
      avatar: userData.avatar,
      content,
      contentType: comment.content_type,
      contentId: comment.content_id,
      isSpoiler,
      isVip: userData.isVip,
      isAdmin: userData.isAdmin,
      replyToUsername,
      userId: req.user.userId,
      userType: req.user.userType,
      profileId: profileId,
      ipAddress: getClientIp(req),
    }).catch((err) =>
      console.error("Erreur webhook Discord (non bloquant):", err),
    );

    // Modération automatique avec l'IA en arrière-plan (ne pas attendre)
    moderateContentWithAI(
      result.lastID,
      "reply",
      content,
      userData.username,
    ).catch((err) =>
      console.error("Erreur modération IA réponse (non bloquant):", err),
    );

    res.status(201).json({
      ...stripPrivateFields(newReply),
      content: formatContentForResponse(newReply.content),
      reactions: 0,
      userReaction: null,
    });
  } catch (error) {
    console.error("Erreur lors de la création de la réponse:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/replies/:id - Éditer une réponse
router.put("/replies/:id", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    let { content, isSpoiler, profileId } = req.body;

    // Normalize content while preserving the original characters
    content = normalizeCommentContent(content);

    // Validation
    if (!content || content.length > 500) {
      return res
        .status(400)
        .json({ error: "La réponse doit contenir entre 1 et 500 caractères" });
    }

    // Vérifier que la réponse appartient à l'utilisateur
    const reply = await dbGet("SELECT * FROM comment_replies WHERE id = ?", [
      id,
    ]);
    if (!reply) {
      return res.status(404).json({ error: "Réponse non trouvée" });
    }

    if (
      reply.user_id !== req.user.userId ||
      reply.user_type !== req.user.userType
    ) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Si la réponse a un profile_id, exiger que l'éditeur passe le même profileId
    // (empêche un autre profil du même compte d'éditer)
    if (reply.profile_id) {
      if (!profileId || String(reply.profile_id) !== String(profileId)) {
        return res
          .status(403)
          .json({ error: "Seul le profil auteur peut éditer cette réponse" });
      }
    }

    // Mettre à jour la réponse
    await dbRun(
      "UPDATE comment_replies SET content = ?, is_spoiler = ?, is_edited = 1, updated_at = ? WHERE id = ?",
      [content, isSpoiler ? 1 : 0, Date.now(), id],
    );

    // Récupérer la réponse mise à jour
    const updatedReply = await dbGet(
      "SELECT * FROM comment_replies WHERE id = ?",
      [id],
    );

    res.json({
      ...stripPrivateFields(updatedReply),
      content: formatContentForResponse(updatedReply.content),
    });
  } catch (error) {
    console.error("Erreur lors de l'édition de la réponse:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/replies/:id - Supprimer une réponse (admin ou auteur)
router.delete("/replies/:id", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId } = req.query;

    // Récupérer la réponse
    const reply = await dbGet(
      "SELECT comment_id, user_id, user_type, profile_id FROM comment_replies WHERE id = ?",
      [id],
    );
    if (!reply) {
      return res.status(404).json({ error: "Réponse non trouvée" });
    }

    // Vérifier que l'utilisateur est admin ou auteur de la réponse
    const userData = await getUserData(req.user.userId, req.user.userType);
    const userMatch =
      String(reply.user_id) === String(req.user.userId) &&
      String(reply.user_type) === String(req.user.userType);
    // Si la réponse a un profile_id, le profileId fourni doit matcher exactement
    // (empêche un kid profile de supprimer la réponse d'un adult profile du même compte)
    let profileMatch = true;
    if (reply.profile_id) {
      profileMatch =
        !!profileId && String(reply.profile_id) === String(profileId);
    }
    const isOwner = userMatch && profileMatch;

    if (!userData.isAdmin && !isOwner) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Supprimer la réponse et tous ses enfants en cascade
    await deleteRepliesCascade(reply.comment_id, id);

    res.json({
      message: "Réponse et ses réponses enfants supprimées en cascade",
    });
  } catch (error) {
    console.error("Erreur lors de la suppression de la réponse:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==================== ROUTES COMMENTAIRES ====================

// GET /api/comments/admin/list - Lister tous les commentaires (admin uniquement)
router.get("/admin/list", requireAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      contentType = "all",
    } = req.query;
    const offset = (page - 1) * limit;

    // Vérifier que l'utilisateur est admin
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    let query =
      'SELECT c.*, COUNT(r.id) as reaction_count FROM comments c LEFT JOIN comment_reactions r ON r.target_type = "comment" AND r.target_id = c.id WHERE c.deleted = 0';
    const params = [];

    if (search) {
      query +=
        " AND (c.content LIKE ? OR c.username LIKE ? OR c.content_id LIKE ?)";
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    if (contentType !== "all") {
      query += " AND c.content_type = ?";
      params.push(contentType);
    }

    query += " GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const rawComments = await dbAll(query, params);

    // Enrichir avec les données utilisateur actuelles (Username, Avatar, VIP, Admin)
    const comments = await Promise.all(
      rawComments.map(async (comment) => {
        const userData = await getUserData(
          comment.user_id,
          comment.user_type,
          comment.profile_id,
        );
        return {
          ...comment,
          content: formatContentForResponse(comment.content),
          username: userData.username,
          avatar: userData.avatar,
          is_vip: userData.isVip,
          is_admin: userData.isAdmin,
        };
      }),
    );

    // Compter le total pour la pagination
    let countQuery = "SELECT COUNT(*) as total FROM comments WHERE deleted = 0";
    const countParams = [];

    if (search) {
      countQuery +=
        " AND (content LIKE ? OR username LIKE ? OR content_id LIKE ?)";
      const searchParam = `%${search}%`;
      countParams.push(searchParam, searchParam, searchParam);
    }

    if (contentType !== "all") {
      countQuery += " AND content_type = ?";
      countParams.push(contentType);
    }

    const totalResult = await dbGet(countQuery, countParams);

    // Stats — une seule requête avec CASE pour compter les stats
    const statsResult = await dbGet(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN content_type = 'movie' THEN 1 ELSE 0 END) as movies,
        SUM(CASE WHEN content_type = 'tv' THEN 1 ELSE 0 END) as tv
      FROM comments WHERE deleted = 0
    `);
    const moderatedCount = (
      await dbGet(`
      SELECT
        (SELECT COUNT(*) FROM comments WHERE deleted = 1 AND moderation_reason IS NOT NULL) +
        (SELECT COUNT(*) FROM comment_replies WHERE deleted = 1 AND moderation_reason IS NOT NULL) as total
    `)
    ).total;

    const stats = {
      total: statsResult.total,
      movies: statsResult.movies,
      tv: statsResult.tv,
      moderated: moderatedCount,
    };

    res.json({
      comments,
      stats,
      total: totalResult.total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error(
      "Erreur lors de la récupération admin des commentaires:",
      error,
    );
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/admin/moderated - Lister les commentaires/réponses modérés (admin uniquement)
// === #17: Pagination SQL avec UNION ALL au lieu de charger tout en mémoire ===
router.get("/admin/moderated", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, type = "all" } = req.query;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.max(1, Math.min(parseInt(limit) || 50, 100));
    const offset = (safePage - 1) * safeLimit;

    // Vérifier que l'utilisateur est admin
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Construire les requêtes avec UNION ALL et pagination SQL
    let unionParts = [];
    let countParts = [];

    if (type === "all" || type === "comments") {
      unionParts.push(`
        SELECT c.id, c.user_id, c.user_type, c.profile_id, c.content, c.content_type, c.content_id,
               c.is_spoiler, c.is_edited, c.created_at, c.moderation_reason, c.moderation_details, c.moderated_at,
               'comment' as item_type,
               (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id) as reaction_count
        FROM comments c
        WHERE c.deleted = 1 AND c.moderation_reason IS NOT NULL
      `);
      countParts.push(
        `SELECT COUNT(*) as cnt FROM comments WHERE deleted = 1 AND moderation_reason IS NOT NULL`,
      );
    }

    if (type === "all" || type === "replies") {
      unionParts.push(`
        SELECT cr.id, cr.user_id, cr.user_type, cr.profile_id, cr.content, c2.content_type, c2.content_id,
               cr.is_spoiler, cr.is_edited, cr.created_at, cr.moderation_reason, cr.moderation_details, cr.moderated_at,
               'reply' as item_type,
               (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'reply' AND target_id = cr.id) as reaction_count
        FROM comment_replies cr
        JOIN comments c2 ON c2.id = cr.comment_id
        WHERE cr.deleted = 1 AND cr.moderation_reason IS NOT NULL
      `);
      countParts.push(
        `SELECT COUNT(*) as cnt FROM comment_replies WHERE deleted = 1 AND moderation_reason IS NOT NULL`,
      );
    }

    if (unionParts.length === 0) {
      return res.json({
        items: [],
        total: 0,
        page: safePage,
        limit: safeLimit,
        hasMore: false,
      });
    }

    // Compter le total
    const countQuery =
      countParts.length === 1
        ? countParts[0]
        : `SELECT (${countParts.map((q) => `(${q})`).join(" + ")}) as cnt`;
    const totalResult = await dbGet(countQuery);
    const total = totalResult.cnt;

    // Requête combinée avec UNION ALL, tri et pagination
    const dataQuery = `
      SELECT * FROM (
        ${unionParts.join(" UNION ALL ")}
      ) AS combined
      ORDER BY moderated_at DESC
      LIMIT ? OFFSET ?
    `;

    const items = await dbAll(dataQuery, [safeLimit, offset]);

    // Enrichir avec les données utilisateur (getUserData est caché dans Redis via #14)
    const userDataCache = new Map();
    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        const userKey = `${item.user_id}:${item.user_type}:${item.profile_id || "default"}`;
        let ud = userDataCache.get(userKey);
        if (!ud) {
          ud = await getUserData(item.user_id, item.user_type, item.profile_id);
          userDataCache.set(userKey, ud);
        }
        return {
          ...item,
          content: formatContentForResponse(item.content),
          username: ud.username,
          avatar: ud.avatar,
          is_vip: ud.isVip,
          is_admin: ud.isAdmin,
        };
      }),
    );

    res.json({
      items: enrichedItems,
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + enrichedItems.length < total,
    });
  } catch (error) {
    console.error(
      "Erreur lors de la récupération des contenus modérés:",
      error,
    );
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/admin/moderated/:type/:id/approve - Approuver un contenu modéré (rendre visible)
router.put(
  "/admin/moderated/:type/:id/approve",
  requireAuth,
  async (req, res) => {
    try {
      const { type, id } = req.params;

      // Validate type parameter to prevent SQL injection via table name
      if (!["comment", "reply"].includes(type)) {
        return res
          .status(400)
          .json({ error: 'Type invalide. Doit être "comment" ou "reply"' });
      }

      // Vérifier que l'utilisateur est admin
      const userData = await getUserData(req.user.userId, req.user.userType);
      if (!userData.isAdmin) {
        return res.status(403).json({ error: "Non autorisé" });
      }

      const table = type === "comment" ? "comments" : "comment_replies";

      // Remettre deleted à 0 et garder les infos de modération pour historique
      await dbRun(
        `UPDATE ${table} SET deleted = 0, approved_by_admin = 1, approved_at = ? WHERE id = ?`,
        [Date.now(), id],
      );

      console.log(`✅ ${type} ID ${id} approuvé par admin`);
      res.json({ message: "Contenu approuvé et rendu visible" });
    } catch (error) {
      console.error("Erreur lors de l'approbation du contenu:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
);

// DELETE /api/comments/admin/moderated/:type/:id - Supprimer définitivement un contenu modéré
router.delete("/admin/moderated/:type/:id", requireAuth, async (req, res) => {
  try {
    const { type, id } = req.params;

    // Validate type parameter
    if (!["comment", "reply"].includes(type)) {
      return res
        .status(400)
        .json({ error: 'Type invalide. Doit être "comment" ou "reply"' });
    }

    // Vérifier que l'utilisateur est admin
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    if (type === "comment") {
      // Supprimer définitivement le commentaire et toutes ses dépendances
      await hardDeleteCommentCascade(id);
    } else if (type === "reply") {
      // Récupérer la réponse pour obtenir le commentId
      const reply = await dbGet(
        "SELECT comment_id FROM comment_replies WHERE id = ?",
        [id],
      );
      if (reply) {
        await hardDeleteRepliesCascade(reply.comment_id, id);
      }
    }

    console.log(`🗑️ ${type} ID ${id} supprimé définitivement par admin`);
    res.json({ message: "Contenu supprimé définitivement" });
  } catch (error) {
    console.error("Erreur lors de la suppression définitive:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==================== ROUTES BANNISSEMENT ====================
// IMPORTANT: Ces routes doivent être AVANT /:contentType/:contentId pour éviter les conflits Express

// POST /api/comments/admin/ban - Bannir un utilisateur ou une IP
router.post("/admin/ban", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const {
      banType,
      banValue,
      userType: targetUserType,
      reason,
      duration,
      username,
      deleteAll,
    } = req.body;

    if (!["ip", "user"].includes(banType) || !banValue) {
      return res
        .status(400)
        .json({ error: "banType (ip/user) et banValue requis" });
    }

    if (banType === "user" && !targetUserType) {
      return res
        .status(400)
        .json({ error: "userType requis pour un ban utilisateur" });
    }

    let expiresAt = null;
    if (duration && duration !== "permanent") {
      const durations = {
        "1h": 3600000,
        "24h": 86400000,
        "7d": 604800000,
        "30d": 2592000000,
      };
      if (durations[duration]) {
        expiresAt = Date.now() + durations[duration];
      }
    }

    const userTypeValue = banType === "user" ? targetUserType : null;

    const existingBan = await dbGet(
      "SELECT id FROM banned_users WHERE ban_type = ? AND ban_value = ? AND (user_type = ? OR (user_type IS NULL AND ? IS NULL))",
      [banType, banValue, userTypeValue, userTypeValue],
    );

    if (existingBan) {
      await dbRun(
        "UPDATE banned_users SET reason = ?, banned_by = ?, banned_at = ?, expires_at = ?, username = ? WHERE id = ?",
        [
          reason || null,
          req.user.userId,
          Date.now(),
          expiresAt,
          username || null,
          existingBan.id,
        ],
      );
    } else {
      await dbRun(
        "INSERT INTO banned_users (ban_type, ban_value, user_type, reason, banned_by, banned_at, expires_at, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          banType,
          banValue,
          userTypeValue,
          reason || null,
          req.user.userId,
          Date.now(),
          expiresAt,
          username || null,
        ],
      );
    }

    let deletedCount = 0;
    if (deleteAll && banType === "user") {
      const commentsResult = await dbRun(
        "UPDATE comments SET deleted = 1 WHERE user_id = ? AND deleted = 0",
        [banValue],
      );
      const repliesResult = await dbRun(
        "UPDATE comment_replies SET deleted = 1 WHERE user_id = ? AND deleted = 0",
        [banValue],
      );
      deletedCount =
        (commentsResult.changes || 0) + (repliesResult.changes || 0);
    }

    res.json({
      message: "Utilisateur banni avec succès",
      deletedCount,
      expiresAt,
    });
  } catch (error) {
    console.error("Erreur lors du bannissement:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/admin/ban/:id - Débannir + restaurer les commentaires
router.delete("/admin/ban/:id", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const { id } = req.params;
    const restoreComments = req.query.restore === "true";

    let restoredCount = 0;
    if (restoreComments) {
      const ban = await dbGet("SELECT * FROM banned_users WHERE id = ?", [id]);
      if (ban && ban.ban_type === "user") {
        const r1 = await dbRun(
          "UPDATE comments SET deleted = 0 WHERE user_id = ? AND deleted = 1 AND moderation_reason IS NULL",
          [ban.ban_value],
        );
        const r2 = await dbRun(
          "UPDATE comment_replies SET deleted = 0 WHERE user_id = ? AND deleted = 1 AND moderation_reason IS NULL",
          [ban.ban_value],
        );
        restoredCount = (r1.changes || 0) + (r2.changes || 0);
      }
    }

    await dbRun("DELETE FROM banned_users WHERE id = ?", [id]);
    res.json({ message: "Ban supprimé avec succès", restoredCount });
  } catch (error) {
    console.error("Erreur lors du débannissement:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/admin/bans - Supprimer tous les bans + restaurer les commentaires
router.delete("/admin/bans", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const restoreComments = req.query.restore === "true";

    let restoredCount = 0;
    if (restoreComments) {
      const userBans = await dbAll(
        "SELECT ban_value FROM banned_users WHERE ban_type = 'user'",
      );
      if (userBans.length > 0) {
        const placeholders = userBans.map(() => "?").join(",");
        const userIds = userBans.map((b) => b.ban_value);
        const r1 = await dbRun(
          `UPDATE comments SET deleted = 0 WHERE user_id IN (${placeholders}) AND deleted = 1 AND moderation_reason IS NULL`,
          userIds,
        );
        const r2 = await dbRun(
          `UPDATE comment_replies SET deleted = 0 WHERE user_id IN (${placeholders}) AND deleted = 1 AND moderation_reason IS NULL`,
          userIds,
        );
        restoredCount = (r1.changes || 0) + (r2.changes || 0);
      }
    }

    const result = await dbRun("DELETE FROM banned_users");
    res.json({
      message: `${result.changes || 0} ban(s) supprimé(s)`,
      deletedCount: result.changes || 0,
      restoredCount,
    });
  } catch (error) {
    console.error("Erreur lors de la suppression de tous les bans:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/admin/bans - Lister les bans actifs
router.get("/admin/bans", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const { showExpired, page = "1", limit = "30", search } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = "";
    const params = [];
    const countParams = [];

    if (showExpired !== "true") {
      whereClause = " WHERE (expires_at IS NULL OR expires_at > ?)";
      params.push(Date.now());
      countParams.push(Date.now());
    }

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += " (ban_value LIKE ? OR username LIKE ? OR reason LIKE ?)";
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }

    const countResult = await dbAll(
      `SELECT COUNT(*) as total FROM banned_users${whereClause}`,
      countParams,
    );
    const total = countResult[0]?.total || 0;

    params.push(limitNum, offset);
    const bans = await dbAll(
      `SELECT * FROM banned_users${whereClause} ORDER BY banned_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    res.json({
      bans,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: offset + bans.length < total,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des bans:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/comments/admin/delete-all-by-user - Supprimer tous les commentaires d'un utilisateur
router.post("/admin/delete-all-by-user", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId requis" });
    }

    const commentsResult = await dbRun(
      "UPDATE comments SET deleted = 1 WHERE user_id = ? AND deleted = 0",
      [userId],
    );
    const repliesResult = await dbRun(
      "UPDATE comment_replies SET deleted = 1 WHERE user_id = ? AND deleted = 0",
      [userId],
    );

    const totalDeleted =
      (commentsResult.changes || 0) + (repliesResult.changes || 0);
    res.json({
      message: `${totalDeleted} commentaire(s) et réponse(s) supprimé(s)`,
      deletedComments: commentsResult.changes || 0,
      deletedReplies: repliesResult.changes || 0,
    });
  } catch (error) {
    console.error("Erreur lors de la suppression en masse:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Normalise le texte Unicode : petites majuscules, caractères spéciaux → ASCII, puis trim + lowercase
function normalizeText(text) {
  if (!text) return "";
  // Map des petites majuscules Unicode et variantes courantes → ASCII
  const unicodeMap = {
    ᴀ: "a",
    ʙ: "b",
    ᴄ: "c",
    ᴅ: "d",
    ᴇ: "e",
    ꜰ: "f",
    ɢ: "g",
    ʜ: "h",
    ɪ: "i",
    ᴊ: "j",
    ᴋ: "k",
    ʟ: "l",
    ᴍ: "m",
    ɴ: "n",
    ᴏ: "o",
    ᴘ: "p",
    ǫ: "q",
    ʀ: "r",
    ꜱ: "s",
    ᴛ: "t",
    ᴜ: "u",
    ᴠ: "v",
    ᴡ: "w",
    x: "x",
    ʏ: "y",
    ᴢ: "z",
    ａ: "a",
    ｂ: "b",
    ｃ: "c",
    ｄ: "d",
    ｅ: "e",
    ｆ: "f",
    ｇ: "g",
    ｈ: "h",
    ｉ: "i",
    ｊ: "j",
    ｋ: "k",
    ｌ: "l",
    ｍ: "m",
    ｎ: "n",
    ｏ: "o",
    ｐ: "p",
    ｑ: "q",
    ｒ: "r",
    ｓ: "s",
    ｔ: "t",
    ｕ: "u",
    ｖ: "v",
    ｗ: "w",
    ｘ: "x",
    ｙ: "y",
    ｚ: "z",
    Ａ: "a",
    Ｂ: "b",
    Ｃ: "c",
    Ｄ: "d",
    Ｅ: "e",
    Ｆ: "f",
    Ｇ: "g",
    Ｈ: "h",
    Ｉ: "i",
    Ｊ: "j",
    Ｋ: "k",
    Ｌ: "l",
    Ｍ: "m",
    Ｎ: "n",
    Ｏ: "o",
    Ｐ: "p",
    Ｑ: "q",
    Ｒ: "r",
    Ｓ: "s",
    Ｔ: "t",
    Ｕ: "u",
    Ｖ: "v",
    Ｗ: "w",
    Ｘ: "x",
    Ｙ: "y",
    Ｚ: "z",
    "𝐚": "a",
    "𝐛": "b",
    "𝐜": "c",
    "𝐝": "d",
    "𝐞": "e",
    "𝐟": "f",
    "𝐠": "g",
    "𝐡": "h",
    "𝐢": "i",
    "𝐣": "j",
    "𝐤": "k",
    "𝐥": "l",
    "𝐦": "m",
    "𝐧": "n",
    "𝐨": "o",
    "𝐩": "p",
    "𝐪": "q",
    "𝐫": "r",
    "𝐬": "s",
    "𝐭": "t",
    "𝐮": "u",
    "𝐯": "v",
    "𝐰": "w",
    "𝐱": "x",
    "𝐲": "y",
    "𝐳": "z",
    "⒜": "a",
    "⒝": "b",
    "⒞": "c",
    "⒟": "d",
    "⒠": "e",
    "⒡": "f",
    "⒢": "g",
    "⒣": "h",
    "⒤": "i",
    "⒥": "j",
    "⒦": "k",
    "⒧": "l",
    "⒨": "m",
    "⒩": "n",
    "⒪": "o",
    "⒫": "p",
    "⒬": "q",
    "⒭": "r",
    "⒮": "s",
    "⒯": "t",
    "⒰": "u",
    "⒱": "v",
    "⒲": "w",
    "⒳": "x",
    "⒴": "y",
    "⒵": "z",
    "．": ".",
    "。": ".",
    "·": ".",
    "⋅": ".",
    "∙": ".",
  };
  let normalized = "";
  for (const char of text) {
    normalized += unicodeMap[char] || char;
  }
  return normalized
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // supprimer les accents diacritiques
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " "); // normaliser les espaces multiples
}

// Détecte si un texte contient des caractères Unicode "fancy" (spam)
function containsFancyUnicode(text) {
  if (!text) return false;
  // IPA Extensions (ʟ,ʀ,ɴ,ʏ,ɢ,ʙ,ʜ,ɪ), petites majuscules latines, fullwidth, math bold/italic, parenthesized, circled
  return /[\u0250-\u02AF\u1D00-\u1D7F\uFF01-\uFF5E\u{1D400}-\u{1D7FF}\u2474-\u2497\u249C-\u24E9\u2460-\u2473]/u.test(
    text,
  );
}

// POST /api/comments/admin/detect-duplicates - Détecter les commentaires en doublons
router.post("/admin/detect-duplicates", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Récupérer tous les commentaires non supprimés
    const allComments = await dbAll(`
      SELECT id, user_id, user_type, profile_id, username, avatar,
             content, content_type, content_id, created_at
      FROM comments
      WHERE deleted = 0
      ORDER BY created_at ASC
    `);

    // Grouper par contenu normalisé (trim + lowercase + unicode → ASCII)
    const groupMap = new Map();
    const fancyUnicodeComments = [];

    for (const c of allComments) {
      const key = normalizeText(c.content);

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          content: c.content,
          normalizedContent: key,
          count: 0,
          firstPosted: c.created_at,
          lastPosted: c.created_at,
          comments: [],
        });
      }
      const group = groupMap.get(key);
      group.count++;
      group.lastPosted = c.created_at;
      group.comments.push({
        id: c.id,
        user_id: c.user_id,
        user_type: c.user_type,
        profile_id: c.profile_id,
        username: c.username,
        avatar: c.avatar,
        content: c.content,
        content_type: c.content_type,
        content_id: c.content_id,
        created_at: c.created_at,
        ip_address: c.ip_address,
      });

      // Détecter les commentaires avec polices Unicode spéciales (spam)
      if (containsFancyUnicode(c.content)) {
        fancyUnicodeComments.push({
          id: c.id,
          user_id: c.user_id,
          user_type: c.user_type,
          profile_id: c.profile_id,
          username: c.username,
          avatar: c.avatar,
          content: c.content,
          content_type: c.content_type,
          content_id: c.content_id,
          created_at: c.created_at,
          ip_address: c.ip_address,
        });
      }
    }

    // Ne garder que les vrais doublons (>1 commentaire par groupe)
    const duplicates = [...groupMap.values()]
      .filter((g) => g.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    // Grouper les commentaires fancy unicode
    const fancyGroup =
      fancyUnicodeComments.length > 0
        ? {
            content: "⚠️ Polices Unicode spéciales (spam)",
            normalizedContent: "__fancy_unicode__",
            count: fancyUnicodeComments.length,
            firstPosted: fancyUnicodeComments[0]?.created_at,
            lastPosted:
              fancyUnicodeComments[fancyUnicodeComments.length - 1]?.created_at,
            comments: fancyUnicodeComments,
            isFancyUnicode: true,
          }
        : null;

    res.json({ duplicates, fancyUnicode: fancyGroup });
  } catch (error) {
    console.error("Erreur lors de la détection des doublons:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/comments/admin/delete-duplicates - Supprimer les doublons et optionnellement bannir les auteurs
router.post("/admin/delete-duplicates", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    const { commentIds, banAuthors, banDuration, banReason } = req.body;

    if (!commentIds || !Array.isArray(commentIds) || commentIds.length === 0) {
      return res.status(400).json({ error: "commentIds requis (tableau)" });
    }

    const BATCH_SIZE = 500;
    let totalDeleted = 0;

    for (let i = 0; i < commentIds.length; i += BATCH_SIZE) {
      const batch = commentIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const result = await dbRun(
        `UPDATE comments SET deleted = 1 WHERE id IN (${placeholders}) AND deleted = 0`,
        batch,
      );
      totalDeleted += result.changes || 0;
    }

    let bannedCount = 0;
    if (banAuthors) {
      const allPlaceholders = commentIds.map(() => "?").join(",");
      const authors = await dbAll(
        `SELECT DISTINCT user_id, user_type, username FROM comments WHERE id IN (${allPlaceholders})`,
        commentIds,
      );

      if (authors.length > 0) {
        const adminCheckPlaceholders = authors.map(() => "(?, ?)").join(",");
        const adminCheckParams = authors.flatMap((a) => [
          a.user_id,
          a.user_type === "bip39" ? "bip-39" : a.user_type,
        ]);
        const adminRows = await dbAll(
          `SELECT user_id, auth_type FROM admins WHERE (user_id, auth_type) IN (${adminCheckPlaceholders})`,
          adminCheckParams,
        );
        const adminSet = new Set(
          adminRows.map((a) => `${a.user_id}:${a.auth_type}`),
        );

        const banCheckPlaceholders = authors.map(() => "(?, ?)").join(",");
        const banCheckParams = authors.flatMap((a) => [a.user_id, a.user_type]);
        const existingBans = await dbAll(
          `SELECT ban_value, user_type FROM banned_users WHERE ban_type = 'user' AND (ban_value, user_type) IN (${banCheckPlaceholders})`,
          banCheckParams,
        );
        const bannedSet = new Set(
          existingBans.map((b) => `${b.ban_value}:${b.user_type}`),
        );

        let expiresAt = null;
        if (banDuration && banDuration !== "permanent") {
          const durations = {
            "1h": 3600000,
            "24h": 86400000,
            "7d": 604800000,
            "30d": 2592000000,
          };
          if (durations[banDuration])
            expiresAt = Date.now() + durations[banDuration];
        }

        const now = Date.now();
        const reasonText = banReason || "Spam / Doublons";
        const toBan = authors.filter((a) => {
          const authType = a.user_type === "bip39" ? "bip-39" : a.user_type;
          const isAdmin = adminSet.has(`${a.user_id}:${authType}`);
          const alreadyBanned = bannedSet.has(`${a.user_id}:${a.user_type}`);
          return !isAdmin && !alreadyBanned;
        });

        for (let i = 0; i < toBan.length; i += 100) {
          const batch = toBan.slice(i, i + 100);
          const insertPlaceholders = batch
            .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
            .join(",");
          const insertParams = batch.flatMap((a) => [
            "user",
            a.user_id,
            a.user_type,
            reasonText,
            req.user.userId,
            now,
            expiresAt,
            a.username || null,
          ]);
          await dbRun(
            `INSERT IGNORE INTO banned_users (ban_type, ban_value, user_type, reason, banned_by, banned_at, expires_at, username) VALUES ${insertPlaceholders}`,
            insertParams,
          );
        }
        bannedCount = toBan.length;
      }
    }

    res.json({
      message: `${totalDeleted} commentaire(s) supprimé(s), ${bannedCount} utilisateur(s) banni(s)`,
      deletedCount: totalDeleted,
      bannedCount,
    });
  } catch (error) {
    console.error("Erreur lors de la suppression des doublons:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/limits - Vérifier les limites de commentaires
router.get("/limits", requireAuth, async (req, res) => {
  try {
    const { contentType, contentId, profileId } = req.query;

    if (!contentType || !contentId) {
      return res.status(400).json({ error: "contentType et contentId requis" });
    }

    const userData = await getUserData(
      req.user.userId,
      req.user.userType,
      profileId,
    );

    if (userData.isAdmin) {
      return res.json({
        movieCount: 0,
        hourCount: 0,
        movieLimit: null,
        hourLimit: null,
        isAdmin: true,
      });
    }

    const movieComments = await dbGet(
      "SELECT COUNT(*) as count FROM comments WHERE user_id = ? AND content_type = ? AND content_id = ? AND deleted = 0",
      [req.user.userId, contentType, contentId],
    );

    const oneHourAgo = Date.now() - 3600000;
    const hourComments = await dbGet(
      "SELECT COUNT(*) as count FROM comments WHERE user_id = ? AND created_at > ?",
      [req.user.userId, oneHourAgo],
    );

    res.json({
      movieCount: movieComments.count,
      hourCount: hourComments.count,
      movieLimit: 3,
      hourLimit: 10,
      isAdmin: false,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des limites:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==================== ROUTES REPORTS (avant les routes dynamiques) ====================

const reportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: createRedisRateLimitStore({
    prefix: "rate-limit:comments:report:",
    windowMs: 15 * 60 * 1000,
  }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de signalements. Réessayez dans 15 minutes." },
  keyGenerator: (req) =>
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    ipKeyGenerator(req.ip),
  validate: {
    xForwardedForHeader: false,
    ip: false,
    keyGeneratorIpFallback: false,
  },
});

const VALID_REPORT_REASONS = [
  "spam",
  "harassment",
  "sexual_content",
  "unmarked_spoiler",
  "impersonation",
  "other",
  // Bornes fantaisistes sur une proposition de sequence : c'est le seul motif
  // qui vaille pour un relevé, et il n'a pas de sens ailleurs.
  "wrong_timestamp",
];
const VALID_TARGET_TYPES = ["comment", "reply", "shared_list", "segment"];

/** Millisecondes en `h:mm:ss.mmm`, pour lire un relevé d'un coup d'oeil. */
function formatSegmentMs(totalMs) {
  const clamped = Math.max(0, Math.round(Number(totalMs) || 0));
  const ms = clamped % 1000;
  const totalSeconds = Math.floor(clamped / 1000);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${Math.floor(totalSeconds / 3600)}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}.${pad(ms, 3)}`;
}

/**
 * Proposition de sequence mise en forme pour le panneau d'administration.
 *
 * `content_type` / `content_id` sont renseignes avec le contenu vise : c'est ce
 * couple que le panneau utilise pour aller chercher l'affiche TMDB, exactement
 * comme pour un commentaire.
 */
function formatSegmentTarget(row) {
  const episode = row.season >= 0 && row.episode >= 0
    ? ` · S${row.season}E${row.episode}`
    : "";
  return {
    id: Number(row.id),
    content: `${row.segment_type} · ${formatSegmentMs(row.start_ms)} → ${formatSegmentMs(row.end_ms)}${episode}`,
    content_type: row.media_type,
    content_id: String(row.tmdb_id),
    segment_type: row.segment_type,
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
    season: Number(row.season),
    episode: Number(row.episode),
    score: Number(row.score),
    user_id: String(row.author_user_id),
    created_at: row.created_at instanceof Date ? row.created_at.getTime() : row.created_at,
  };
}

// POST /api/comments/report - Créer un signalement
router.post("/report", requireAuth, reportRateLimit, async (req, res) => {
  try {
    const { targetType, targetId, reason, details } = req.body;
    const { userId, userType } = req.user;
    const profileId = req.body.profileId;

    if (!targetType || !targetId || !reason) {
      return res
        .status(400)
        .json({ error: "targetType, targetId et reason sont requis" });
    }
    if (!VALID_TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: "targetType invalide" });
    }
    if (!VALID_REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: "reason invalide" });
    }
    if (!profileId) {
      return res.status(400).json({ error: "profileId requis" });
    }
    if (details && details.length > 500) {
      return res
        .status(400)
        .json({ error: "Les détails ne peuvent pas dépasser 500 caractères" });
    }

    const allowedProfiles = await getProfileIds(userId, userType);
    if (allowedProfiles.length > 0 && !allowedProfiles.includes(profileId)) {
      return res
        .status(403)
        .json({ error: "Ce profil ne vous appartient pas" });
    }

    if (targetType === "comment") {
      const comment = await dbGet(
        "SELECT id, user_id, profile_id FROM comments WHERE id = ? AND deleted = 0",
        [targetId],
      );
      if (!comment)
        return res.status(404).json({ error: "Commentaire non trouvé" });
      if (
        String(comment.user_id) === String(userId) &&
        String(comment.profile_id) === String(profileId)
      ) {
        return res
          .status(400)
          .json({
            error: "Vous ne pouvez pas signaler votre propre commentaire",
          });
      }
    } else if (targetType === "reply") {
      const reply = await dbGet(
        "SELECT id, user_id, profile_id FROM comment_replies WHERE id = ? AND deleted = 0",
        [targetId],
      );
      if (!reply) return res.status(404).json({ error: "Réponse non trouvée" });
      if (
        String(reply.user_id) === String(userId) &&
        String(reply.profile_id) === String(profileId)
      ) {
        return res
          .status(400)
          .json({ error: "Vous ne pouvez pas signaler votre propre réponse" });
      }
    } else if (targetType === "shared_list") {
      const pool = getCachedPool();
      const [rows] = await pool.execute(
        "SELECT id, user_id, share_code FROM shared_lists WHERE share_code = ? OR id = ?",
        [targetId, targetId],
      );
      if (rows.length === 0)
        return res.status(404).json({ error: "Liste partagée non trouvée" });
      if (String(rows[0].user_id) === String(userId)) {
        return res
          .status(400)
          .json({ error: "Vous ne pouvez pas signaler votre propre liste" });
      }
    } else if (targetType === "segment") {
      // Identifiant strictement numerique : la colonne est un BIGINT, et une
      // chaine quelconque y serait silencieusement convertie en 0 par MySQL.
      if (!/^[1-9]\d{0,18}$/.test(String(targetId))) {
        return res.status(400).json({ error: "targetId invalide" });
      }
      // Elargit l'ENUM `target_type` si ce n'est pas encore fait. Volontairement
      // ici et nulle part ailleurs : cette DDL prend un verrou sur `reports` et
      // n'a rien a faire sur le chemin de lecture des segments.
      if (!(await ensureSegmentReportSchema())) {
        return res
          .status(503)
          .json({ error: "Signalement de séquence indisponible" });
      }
      const submission = await getSegmentSubmissionRow(targetId);
      if (!submission)
        return res.status(404).json({ error: "Proposition non trouvée" });
      // Le profil ne compte pas ici : une proposition appartient au compte, pas
      // au profil qui regardait ce soir-là.
      if (
        String(submission.author_user_id) === String(userId) &&
        String(submission.author_user_type) === String(userType)
      ) {
        return res.status(400).json({
          error: "Vous ne pouvez pas signaler votre propre proposition",
        });
      }
    }

    try {
      await dbRun(
        `INSERT INTO reports (reporter_user_id, reporter_user_type, reporter_profile_id, target_type, target_id, reason, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          userType,
          profileId,
          targetType,
          targetId,
          reason,
          details || null,
          Date.now(),
        ],
      );
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: "Vous avez déjà signalé ce contenu" });
      }
      throw err;
    }

    res.status(201).json({ success: true, message: "Signalement envoyé" });
  } catch (error) {
    console.error("Erreur lors du signalement:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// GET /api/comments/admin/reports - Lister les signalements (admin)
router.get("/admin/reports", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin)
      return res.status(403).json({ error: "Non autorisé" });

    const status = req.query.status || "pending";
    const targetType = req.query.targetType || "all";
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = (pageNum - 1) * limitNum;

    let query = `SELECT r.*,
      (SELECT COUNT(*) FROM reports r2 WHERE r2.target_type = r.target_type AND r2.target_id = r.target_id AND r2.status = 'pending') as report_count
      FROM reports r WHERE 1=1`;
    const params = [];

    if (status !== "all") {
      query += " AND r.status = ?";
      params.push(status);
    }
    if (targetType !== "all") {
      query += " AND r.target_type = ?";
      params.push(targetType);
    }

    query += " ORDER BY r.created_at DESC LIMIT ? OFFSET ?";
    params.push(limitNum, offset);

    const reports = await dbAll(query, params);

    const enriched = await Promise.all(
      reports.map(async (report) => {
        let reporterData = { username: "Inconnu", avatar: null };
        try {
          reporterData = await getUserData(
            report.reporter_user_id,
            report.reporter_user_type,
            report.reporter_profile_id,
          );
        } catch {
          /* fallback */
        }

        let targetData = {};
        try {
          if (report.target_type === "comment") {
            const comment = await dbGet(
              "SELECT id, content, content_id, content_type, user_id, user_type, profile_id, username, created_at FROM comments WHERE id = ?",
              [report.target_id],
            );
            if (comment) {
              const authorData = await getUserData(
                comment.user_id,
                comment.user_type,
                comment.profile_id,
              );
              targetData = {
                ...comment,
                content: formatContentForResponse(comment.content),
                authorUsername: authorData.username,
                authorAvatar: authorData.avatar,
              };
            } else {
              targetData = { deleted: true };
            }
          } else if (report.target_type === "reply") {
            const reply = await dbGet(
              "SELECT id, content, comment_id, user_id, user_type, profile_id, username, created_at FROM comment_replies WHERE id = ?",
              [report.target_id],
            );
            if (reply) {
              const authorData = await getUserData(
                reply.user_id,
                reply.user_type,
                reply.profile_id,
              );
              const parentComment = await dbGet(
                "SELECT content_id, content_type FROM comments WHERE id = ?",
                [reply.comment_id],
              );
              targetData = {
                ...reply,
                content: formatContentForResponse(reply.content),
                authorUsername: authorData.username,
                authorAvatar: authorData.avatar,
                content_id: parentComment?.content_id,
                content_type: parentComment?.content_type,
              };
            } else {
              targetData = { deleted: true };
            }
          } else if (report.target_type === "shared_list") {
            const pool = getCachedPool();
            const [rows] = await pool.execute(
              "SELECT id, name, user_id, share_code FROM shared_lists WHERE share_code = ? OR id = ?",
              [report.target_id, report.target_id],
            );
            if (rows.length > 0) {
              targetData = rows[0];
            } else {
              targetData = { deleted: true };
            }
          } else if (report.target_type === "segment") {
            const submission = await getSegmentSubmissionRow(report.target_id);
            if (submission) {
              let authorData = { username: "Inconnu", avatar: null };
              try {
                authorData = await getUserData(
                  submission.author_user_id,
                  submission.author_user_type,
                );
              } catch {
                /* fallback */
              }
              targetData = {
                ...formatSegmentTarget(submission),
                authorUsername: authorData.username,
                authorAvatar: authorData.avatar,
              };
            } else {
              // Deja supprimee — par un vote negatif, son auteur ou une autre
              // resolution. Le signalement reste listable, sans sa cible.
              targetData = { deleted: true };
            }
          }
        } catch (err) {
          console.error("Erreur enrichissement report:", err.message);
          targetData = { error: true };
        }

        return {
          ...report,
          reporter: {
            username: reporterData.username,
            avatar: reporterData.avatar,
          },
          target: targetData,
        };
      }),
    );

    const statsResult = await dbGet(`
      SELECT
        IFNULL(COUNT(*), 0) as total,
        IFNULL(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        IFNULL(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) as resolved,
        IFNULL(SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END), 0) as dismissed,
        IFNULL(SUM(CASE WHEN target_type = 'comment' OR target_type = 'reply' THEN 1 ELSE 0 END), 0) as comments,
        IFNULL(SUM(CASE WHEN target_type = 'shared_list' THEN 1 ELSE 0 END), 0) as lists,
        IFNULL(SUM(CASE WHEN target_type = 'segment' THEN 1 ELSE 0 END), 0) as segments
      FROM reports
    `);

    let countQuery = "SELECT COUNT(*) as total FROM reports WHERE 1=1";
    const countParams = [];
    if (status !== "all") {
      countQuery += " AND status = ?";
      countParams.push(status);
    }
    if (targetType !== "all") {
      countQuery += " AND target_type = ?";
      countParams.push(targetType);
    }
    const totalResult = await dbGet(countQuery, countParams);
    const total = Number(totalResult?.total) || 0;

    res.json({
      success: true,
      reports: enriched,
      stats: {
        total: Number(statsResult?.total) || 0,
        pending: Number(statsResult?.pending) || 0,
        resolved: Number(statsResult?.resolved) || 0,
        dismissed: Number(statsResult?.dismissed) || 0,
        comments: Number(statsResult?.comments) || 0,
        lists: Number(statsResult?.lists) || 0,
        segments: Number(statsResult?.segments) || 0,
      },
      total,
      hasMore: offset + limitNum < total,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des reports:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/admin/reports/:id/resolve
router.put("/admin/reports/:id/resolve", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin)
      return res.status(403).json({ error: "Non autorisé" });

    const { id } = req.params;
    const { deleteContent } = req.body;

    const report = await dbGet("SELECT * FROM reports WHERE id = ? AND status = 'pending'", [id]);
    if (!report)
      return res.status(404).json({ error: "Signalement non trouvé" });

    const pendingReports = await dbAll(
      "SELECT reporter_user_id, reporter_user_type, reporter_profile_id, target_type, target_id FROM reports WHERE target_type = ? AND target_id = ? AND status = 'pending'",
      [report.target_type, report.target_id],
    );
    const notificationTarget = await getReportNotificationTarget(report);

    if (deleteContent) {
      if (report.target_type === "comment") {
        await deleteCommentCascade(report.target_id);
      } else if (report.target_type === "reply") {
        const reply = await dbGet(
          "SELECT comment_id FROM comment_replies WHERE id = ?",
          [report.target_id],
        );
        if (reply)
          await deleteRepliesCascade(reply.comment_id, report.target_id);
      } else if (report.target_type === "shared_list") {
        const pool = getCachedPool();
        await pool.execute(
          "DELETE FROM shared_lists WHERE share_code = ? OR id = ?",
          [report.target_id, report.target_id],
        );
      } else if (report.target_type === "segment") {
        // Les votes suivent la proposition (ON DELETE CASCADE) : rien a
        // nettoyer de plus, et le consensus la perd au prochain calcul.
        await deleteSubmissionAsModerator(report.target_id);
      }
    }

    const updateResult = await dbRun(
      `UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'pending'`,
      [req.user.userId, Date.now(), report.target_type, report.target_id],
    );

    if (updateResult.changes > 0 && pendingReports.length > 0) {
      const notificationType = deleteContent
        ? REPORT_NOTIFICATION_TYPES.RESOLVED_DELETED
        : REPORT_NOTIFICATION_TYPES.RESOLVED;

      await Promise.all(pendingReports.map(async (pendingReport) => {
        await createNotification(
          pendingReport.reporter_user_id,
          pendingReport.reporter_user_type,
          pendingReport.reporter_profile_id,
          req.user.userId,
          null,
          userData.username,
          userData.avatar,
          notificationType,
          pendingReport.target_type,
          notificationTarget.targetId,
          notificationTarget.contentType,
          notificationTarget.contentId,
          null,
        );
      }));
    }

    res.json({ success: true, message: "Signalement résolu" });
  } catch (error) {
    console.error("Erreur résolution report:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// PUT /api/comments/admin/reports/:id/dismiss
router.put("/admin/reports/:id/dismiss", requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.userId, req.user.userType);
    if (!userData.isAdmin)
      return res.status(403).json({ error: "Non autorisé" });

    const { id } = req.params;
    const report = await dbGet("SELECT * FROM reports WHERE id = ? AND status = 'pending'", [id]);
    if (!report)
      return res.status(404).json({ error: "Signalement non trouvé" });

    const pendingReports = await dbAll(
      "SELECT reporter_user_id, reporter_user_type, reporter_profile_id, target_type, target_id FROM reports WHERE target_type = ? AND target_id = ? AND status = 'pending'",
      [report.target_type, report.target_id],
    );
    const notificationTarget = await getReportNotificationTarget(report);

    const updateResult = await dbRun(
      `UPDATE reports SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'pending'`,
      [req.user.userId, Date.now(), report.target_type, report.target_id],
    );

    if (updateResult.changes > 0 && pendingReports.length > 0) {
      await Promise.all(pendingReports.map(async (pendingReport) => {
        await createNotification(
          pendingReport.reporter_user_id,
          pendingReport.reporter_user_type,
          pendingReport.reporter_profile_id,
          req.user.userId,
          null,
          userData.username,
          userData.avatar,
          REPORT_NOTIFICATION_TYPES.DISMISSED,
          pendingReport.target_type,
          notificationTarget.targetId,
          notificationTarget.contentType,
          notificationTarget.contentId,
          null,
        );
      }));
    }

    res.json({ success: true, message: "Signalement rejeté" });
  } catch (error) {
    console.error("Erreur dismiss report:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==================== ROUTES DYNAMIQUES (doivent être en dernier) ====================

// GET /api/comments/:contentType/:contentId - Récupérer les commentaires avec pagination
// === #13: Optimisé — une seule requête SQL avec sous-requêtes au lieu de N+1 ===
router.get("/:contentType/:contentId", async (req, res) => {
  try {
    const { contentType, contentId } = req.params;
    const safePage = Math.max(1, Math.min(parseInt(req.query.page) || 1, 1000));
    const safeLimit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 50));
    const offset = (safePage - 1) * safeLimit;

    // Tenter de récupérer l'utilisateur connecté (optionnel)
    let currentUser = null;
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, {
          algorithms: ["HS256"],
        });
        currentUser = {
          userId: decoded.sub,
          userType: decoded.userType,
          sessionId: decoded.sessionId,
        };
      } catch (error) {
        // Token invalide, on continue sans utilisateur
      }
    }

    const { profileId } = req.query;

    // Récupérer le total de commentaires
    const totalResult = await dbGet(
      "SELECT COUNT(*) as total FROM comments WHERE content_type = ? AND content_id = ? AND deleted = 0",
      [contentType, contentId],
    );

    // #13: Requête unique — reaction_count + replies_count + user_reacted en sous-requêtes
    let commentsQuery;
    let commentsParams;

    if (currentUser && profileId) {
      commentsQuery = `
        SELECT c.*,
          (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id) as reaction_count,
          (SELECT COUNT(*) FROM comment_replies WHERE comment_id = c.id AND deleted = 0) as replies_count,
          EXISTS(SELECT 1 FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id
                 AND user_id = ? AND user_type = ? AND profile_id = ?) as user_reacted
        FROM comments c
        WHERE c.content_type = ? AND c.content_id = ? AND c.deleted = 0
        ORDER BY (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id) DESC, c.created_at DESC
        LIMIT ? OFFSET ?`;
      commentsParams = [
        currentUser.userId,
        currentUser.userType,
        profileId,
        contentType,
        contentId,
        safeLimit,
        offset,
      ];
    } else {
      commentsQuery = `
        SELECT c.*,
          (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id) as reaction_count,
          (SELECT COUNT(*) FROM comment_replies WHERE comment_id = c.id AND deleted = 0) as replies_count
        FROM comments c
        WHERE c.content_type = ? AND c.content_id = ? AND c.deleted = 0
        ORDER BY (SELECT COUNT(*) FROM comment_reactions WHERE target_type = 'comment' AND target_id = c.id) DESC, c.created_at DESC
        LIMIT ? OFFSET ?`;
      commentsParams = [
        contentType,
        contentId,
        safeLimit,
        offset,
      ];
    }

    const comments = await dbAll(commentsQuery, commentsParams);

    // Cache utilisateur en mémoire pour cette requête (getUserData est déjà caché dans Redis via #14)
    const userDataCache = new Map();

    const commentsWithDetails = await Promise.all(
      comments.map(async (comment) => {
        const userKey = `${comment.user_id}:${comment.user_type}:${comment.profile_id || "default"}`;
        let userData = userDataCache.get(userKey);
        if (!userData) {
          userData = await getUserData(
            comment.user_id,
            comment.user_type,
            comment.profile_id,
          );
          userDataCache.set(userKey, userData);
        }

        return {
          ...stripPrivateFields(comment),
          content: formatContentForResponse(comment.content),
          username: userData.username,
          avatar: userData.avatar,
          is_vip: userData.isVip ? 1 : 0,
          is_admin: userData.isAdmin ? 1 : 0,
          repliesCount: comment.replies_count,
          reactions: comment.reaction_count,
          userReaction:
            comment.user_reacted !== undefined ? !!comment.user_reacted : null,
        };
      }),
    );

    res.json({
      comments: commentsWithDetails,
      total: totalResult.total,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + commentsWithDetails.length < totalResult.total,
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des commentaires:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/comments - Créer un commentaire
router.post("/", requireAuth, writeRateLimit, async (req, res) => {
  // Lock Redis par user pour sérialiser les créations concurrentes
  // (évite la race count >=3 / count >=10 entre SELECT et INSERT)
  const userLockKey = `comments:create:lock:${req.user.userType}:${req.user.userId}`;
  let lockAcquired = null;
  let lockHeld = false;
  try {
    try {
      lockAcquired = await redis.set(userLockKey, "1", "EX", 10, "NX");
    } catch {
      // Redis indisponible — on accepte le risque de race (best effort)
      lockAcquired = "OK";
    }
    if (!lockAcquired) {
      return res
        .status(429)
        .json({ error: "Une création est déjà en cours, réessayez." });
    }
    lockHeld = true;

    let {
      contentType,
      contentId,
      content,
      isSpoiler,
      profileId,
      turnstileToken,
    } = req.body;

    // Vérification Turnstile
    const turnstileResult = await verifyTurnstileFromRequest(
      req,
      turnstileToken,
    );
    if (!turnstileResult.valid)
      return res
        .status(turnstileResult.status)
        .json({ error: turnstileResult.error });

    // Normalize content while preserving the original characters
    content = normalizeCommentContent(content);

    // Verify profile ownership
    const userProfileIds = await getProfileIds(
      req.user.userId,
      req.user.userType,
    );
    if (!userProfileIds.includes(profileId)) {
      return res.status(403).json({ error: "Profil non autorisé" });
    }

    // Récupérer les données utilisateur
    const userData = await getUserData(
      req.user.userId,
      req.user.userType,
      profileId,
    );

    // Vérification de bannissement
    if (!userData.isAdmin) {
      const banStatus = await checkBan(
        req.user.userId,
        req.user.userType,
        getClientIp(req),
      );
      if (banStatus.banned) {
        return res.status(403).json({
          error: "Vous êtes banni des commentaires.",
          reason: banStatus.reason,
          expires_at: banStatus.expires_at,
        });
      }
    }

    // Rate Limit 1: Max 3 comments per movie/content (sauf pour les admins)
    if (!userData.isAdmin) {
      const movieComments = await dbGet(
        "SELECT COUNT(*) as count FROM comments WHERE user_id = ? AND content_type = ? AND content_id = ? AND deleted = 0",
        [req.user.userId, contentType, contentId],
      );

      if (movieComments.count >= 3) {
        return res
          .status(429)
          .json({ error: "Limite de 3 commentaires par film atteinte." });
      }

      // Rate Limit 2: Max 10 comments per hour (sauf pour les admins)
      const oneHourAgo = Date.now() - 3600000;
      const hourComments = await dbGet(
        "SELECT COUNT(*) as count FROM comments WHERE user_id = ? AND created_at > ?",
        [req.user.userId, oneHourAgo],
      );

      if (hourComments.count >= 10) {
        return res
          .status(429)
          .json({ error: "Limite de 10 commentaires par heure atteinte." });
      }
    }

    // Validation
    if (!content || content.length > 500) {
      return res
        .status(400)
        .json({
          error: "Le commentaire doit contenir entre 1 et 500 caractères",
        });
    }

    // Insérer le commentaire
    const result = await dbRun(
      `INSERT INTO comments (content_type, content_id, user_id, user_type, profile_id, username, avatar, content, is_spoiler, is_vip, is_admin, created_at, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contentType,
        contentId,
        req.user.userId,
        req.user.userType,
        profileId,
        userData.username,
        userData.avatar,
        content,
        isSpoiler ? 1 : 0,
        userData.isVip ? 1 : 0,
        userData.isAdmin ? 1 : 0,
        Date.now(),
        getClientIp(req),
      ],
    );

    // Récupérer le commentaire créé
    const newComment = await dbGet("SELECT * FROM comments WHERE id = ?", [
      result.lastID,
    ]);

    // Envoyer le webhook Discord en arrière-plan (ne pas attendre)
    sendDiscordWebhook("comment", {
      username: userData.username,
      avatar: userData.avatar,
      content,
      contentType,
      contentId,
      isSpoiler,
      isVip: userData.isVip,
      isAdmin: userData.isAdmin,
      userId: req.user.userId,
      userType: req.user.userType,
      profileId: profileId,
      ipAddress: getClientIp(req),
    }).catch((err) =>
      console.error("Erreur webhook Discord (non bloquant):", err),
    );

    // Modération automatique avec l'IA en arrière-plan (ne pas attendre)
    moderateContentWithAI(
      result.lastID,
      "comment",
      content,
      userData.username,
    ).catch((err) =>
      console.error(
        "Erreur modération IA commentaire (non bloquant):",
        err,
      ),
    );

    res.status(201).json({
      ...stripPrivateFields(newComment),
      content: formatContentForResponse(newComment.content),
      repliesCount: 0,
      reactions: 0,
      userReaction: null,
    });
  } catch (error) {
    console.error("Erreur lors de la création du commentaire:", error);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    if (lockHeld) {
      try {
        await redis.del(userLockKey);
      } catch {
        /* Redis indisponible — le lock expirera via TTL */
      }
    }
  }
});

// PUT /api/comments/:id - Éditer un commentaire
router.put("/:id", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    let { content, isSpoiler, profileId } = req.body;

    // Normalize content while preserving the original characters
    content = normalizeCommentContent(content);

    // Validation
    if (!content || content.length > 500) {
      return res
        .status(400)
        .json({
          error: "Le commentaire doit contenir entre 1 et 500 caractères",
        });
    }

    // Vérifier que le commentaire appartient à l'utilisateur
    const comment = await dbGet("SELECT * FROM comments WHERE id = ?", [id]);
    if (!comment) {
      return res.status(404).json({ error: "Commentaire non trouvé" });
    }

    if (
      comment.user_id !== req.user.userId ||
      comment.user_type !== req.user.userType
    ) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Si le commentaire a un profile_id, exiger que l'éditeur passe le même profileId
    // (empêche un autre profil du même compte d'éditer)
    if (comment.profile_id) {
      if (!profileId || String(comment.profile_id) !== String(profileId)) {
        return res
          .status(403)
          .json({ error: "Seul le profil auteur peut éditer ce commentaire" });
      }
    }

    // Mettre à jour le commentaire
    await dbRun(
      "UPDATE comments SET content = ?, is_spoiler = ?, is_edited = 1, updated_at = ? WHERE id = ?",
      [content, isSpoiler ? 1 : 0, Date.now(), id],
    );

    // Récupérer le commentaire mis à jour
    const updatedComment = await dbGet("SELECT * FROM comments WHERE id = ?", [
      id,
    ]);

    res.json({
      ...stripPrivateFields(updatedComment),
      content: formatContentForResponse(updatedComment.content),
    });
  } catch (error) {
    console.error("Erreur lors de l'édition du commentaire:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// DELETE /api/comments/:id - Supprimer un commentaire (admin ou auteur)
router.delete("/:id", requireAuth, writeRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId } = req.query;

    // Vérifier que le commentaire existe
    const comment = await dbGet(
      "SELECT id, user_id, user_type, profile_id FROM comments WHERE id = ?",
      [id],
    );
    if (!comment) {
      return res.status(404).json({ error: "Commentaire non trouvé" });
    }

    // Vérifier que l'utilisateur est admin ou auteur du commentaire
    const userData = await getUserData(req.user.userId, req.user.userType);
    const userMatch =
      String(comment.user_id) === String(req.user.userId) &&
      String(comment.user_type) === String(req.user.userType);
    // Si le commentaire a un profile_id, le profileId fourni doit matcher exactement
    // (empêche un kid profile de supprimer le commentaire d'un adult profile du même compte)
    let profileMatch = true;
    if (comment.profile_id) {
      profileMatch =
        !!profileId && String(comment.profile_id) === String(profileId);
    }
    const isOwner = userMatch && profileMatch;

    if (!userData.isAdmin && !isOwner) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    // Supprimer le commentaire et toutes ses dépendances en cascade
    await deleteCommentCascade(id);

    res.json({
      message:
        "Commentaire, réponses, réactions et notifications supprimés en cascade",
    });
  } catch (error) {
    console.error("Erreur lors de la suppression du commentaire:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
