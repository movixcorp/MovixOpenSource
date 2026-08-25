const path = require('path');

const ALLOWED_SYNC_USER_TYPES = Object.freeze(['oauth', 'bip39']);
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_SYNC_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;
const SAFE_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_PROFILE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_GUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const SYNCABLE_EXACT_KEYS = new Set([
  'access_code',
  'access_code_expires',
  'adWarningAccepted',
  'anti_spoiler',
  'continueWatching',
  'custom_lists',
  'episodeReleaseAlerts',
  'favorite_collections',
  'favorite_movie',
  'favorite_movies',
  'favorites_tv',
  'live_tv_favorite_channels',
  'live_tv_favorite_iptv_categories',
  'miniPlayerPosition',
  'miniPlayerVolume',
  'movix_intro_enabled',
  'movix_intro_seen',
  'privacy_data_collection',
  'recentEmojis',
  'screensaver_enabled',
  'screensaver_mode',
  'screensaver_timeout',
  'shared_list_favorites',
  'snow_enabled',
  'subtitleStyle',
  'support_popup_seen',
  'user_language',
  'is_vip',
  'watched_movie',
  'watched_tv',
  'watchPartyNickname'
]);

const SYNCABLE_PREFIXES = Object.freeze([
  'favorite_',
  'favorites_',
  'miniPlayer',
  'movix_intro_',
  'player',
  'progress_',
  'screensaver_',
  'settings_',
  'watchlist_',
  'watched_'
]);

const BLOCKED_SYNC_KEYS = new Set([
  'access_token',
  'auth',
  'auth_method',
  'auth_token',
  'avatar_url',
  'bip39_auth',
  'clear',
  'discord_auth',
  'discord_last_check',
  'discord_rate_limit',
  'discord_token',
  'discord_user',
  'episodeAlertsLastCheck',
  'google_auth',
  'google_token',
  'google_user',
  'guest_uuid',
  'is_admin',
  'lastCommentTime',
  'lastReplyTime',
  'movix_pending_auth_action',
  'removeItem',
  'resolved_user_id',
  'resolved_user_type',
  'selectedProfile',
  'selected_profile',
  'selected_profile_id',
  'session_id',
  'setItem',
  'user_id',
  'user_name',
  'user_type'
]);

const SYNC_LIMITS = Object.freeze({
  maxRequestBytes: 5 * 1024 * 1024,
  maxOpsPerRequest: 200,
  maxKeysPerProfile: 600,
  maxDeltaProperties: 200,
  maxStringValueBytes: 256 * 1024,
  maxStructuredValueBytes: 128 * 1024,
  maxProfileBytes: 5 * 1024 * 1024,
  maxLegacyUserBytes: 512 * 1024,
  maxUserDataBytes: 1024 * 1024,
  maxValueDepth: 8
});

// Bornes affichage des identifiants utilisateur.
// `profileName` = nom du profil Movix (créé via /api/profiles ou /api/oauth/profiles).
// `displayName` = pseudo OAuth (Discord/Google) tel qu'on l'affiche dans l'UI.
//   Discord limite à 32 chars ; Google peut aller plus loin → on tronque à 64.
const IDENTITY_LIMITS = Object.freeze({
  profileNameMin: 1,
  profileNameMax: 32,
  displayNameMax: 64,
});

class SyncPolicyError extends Error {
  constructor(message, status = 400, code = 'SYNC_POLICY_ERROR') {
    super(message);
    this.name = 'SyncPolicyError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Valide un nom de profil utilisateur.
 *
 *  - Trim
 *  - Retire les caractères de contrôle (U+0000–U+001F, U+007F) qui peuvent
 *    casser l'affichage ou être utilisés pour des attaques de spoofing.
 *  - Refuse les caractères zero-width (U+200B-U+200D, U+FEFF) pour la même raison.
 *  - Borne la longueur entre `profileNameMin` (1) et `profileNameMax` (32).
 *
 * Throw `SyncPolicyError` si invalide. Sinon retourne la chaîne nettoyée.
 */
// Caracteres dangereux a stripper avant validation/affichage des noms :
//   \x00-\x1F\x7F : controle ASCII
//   \u200B-\u200D  : zero-width (spoofing)
//   \uFEFF         : BOM
const DANGEROUS_NAME_CHARS = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g;

function cleanNameInput(raw) {
  return String(raw).replace(DANGEROUS_NAME_CHARS, '').trim();
}

function validateProfileName(raw) {
  if (typeof raw !== 'string') {
    throw new SyncPolicyError('Le nom de profil doit etre une chaine', 400, 'INVALID_PROFILE_NAME');
  }
  const cleaned = cleanNameInput(raw);
  if (cleaned.length < IDENTITY_LIMITS.profileNameMin) {
    throw new SyncPolicyError('Le nom de profil ne peut pas etre vide', 400, 'PROFILE_NAME_TOO_SHORT');
  }
  if (cleaned.length > IDENTITY_LIMITS.profileNameMax) {
    throw new SyncPolicyError(
      `Le nom de profil ne peut pas depasser ${IDENTITY_LIMITS.profileNameMax} caracteres`,
      400,
      'PROFILE_NAME_TOO_LONG',
    );
  }
  return cleaned;
}

/**
 * Version booléenne de validateProfileName : ne throw pas, retourne juste
 * un boolean. Utilisé sur les chemins de lecture (vérifier si le username
 * stocké respecte la policy → si non, forcer l'user à le changer).
 */
function isProfileNameValid(raw) {
  if (typeof raw !== 'string') return false;
  const cleaned = cleanNameInput(raw);
  return cleaned.length >= IDENTITY_LIMITS.profileNameMin
    && cleaned.length <= IDENTITY_LIMITS.profileNameMax;
}

/**
 * Tronque proprement un display name (pseudo OAuth provider) pour l'affichage.
 * Pas de throw : on accepte les valeurs legacy deja stockees, on les coupe juste
 * si elles depassent. Ajoute une ellipse si tronque.
 */
function truncateDisplayName(raw, max = IDENTITY_LIMITS.displayNameMax) {
  if (typeof raw !== 'string') return '';
  const cleaned = cleanNameInput(raw);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, Math.max(1, max - 1)) + "\u2026";
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(baseDir, targetPath) {
  const normalizedBase = canonicalPath(baseDir);
  const normalizedTarget = canonicalPath(targetPath);
  const baseWithSep = normalizedBase.endsWith(path.sep) ? normalizedBase : `${normalizedBase}${path.sep}`;
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(baseWithSep);
}

function resolveInside(baseDir, ...segments) {
  const resolved = path.resolve(baseDir, ...segments);
  if (!isPathInside(baseDir, resolved)) {
    throw new SyncPolicyError('Chemin de stockage invalide', 400, 'INVALID_STORAGE_PATH');
  }
  return resolved;
}

function getUtf8ByteLength(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8');
}

function assertWithinBytes(value, maxBytes, message, status = 413, code = 'PAYLOAD_TOO_LARGE') {
  if (getUtf8ByteLength(value) > maxBytes) {
    throw new SyncPolicyError(message, status, code);
  }
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function ensureSafeSegment(value, label, pattern, code = 'INVALID_IDENTIFIER') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SyncPolicyError(`${label} manquant`, 400, code);
  }

  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new SyncPolicyError(`${label} invalide`, 400, code);
  }

  return normalized;
}

function ensureValidUserType(userType) {
  if (!ALLOWED_SYNC_USER_TYPES.includes(userType)) {
    throw new SyncPolicyError('Type d\'utilisateur invalide', 400, 'INVALID_USER_TYPE');
  }
  return userType;
}

function ensureSafeUserId(userId) {
  return ensureSafeSegment(userId, 'userId', SAFE_USER_ID_PATTERN, 'INVALID_USER_ID');
}

function ensureSafeProfileId(profileId) {
  return ensureSafeSegment(profileId, 'profileId', SAFE_PROFILE_ID_PATTERN, 'INVALID_PROFILE_ID');
}

function ensureSafeGuestId(guestId) {
  return ensureSafeSegment(guestId, 'guestId', SAFE_GUEST_ID_PATTERN, 'INVALID_GUEST_ID');
}

function ensureSafeNestedKey(key) {
  if (typeof key !== 'string' || !key || key.length > 120 || RESERVED_OBJECT_KEYS.has(key)) {
    throw new SyncPolicyError('Cle interne invalide dans les donnees synchronisees', 400, 'INVALID_NESTED_KEY');
  }
  return key;
}

function isSyncableStorageKey(key) {
  if (typeof key !== 'string') return false;
  if (BLOCKED_SYNC_KEYS.has(key)) return false;
  if (RESERVED_OBJECT_KEYS.has(key)) return false;
  if (!SAFE_SYNC_KEY_PATTERN.test(key)) return false;
  if (SYNCABLE_EXACT_KEYS.has(key)) return true;
  return SYNCABLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function ensureSyncableStorageKey(key) {
  if (!isSyncableStorageKey(key)) {
    throw new SyncPolicyError(`Cle de synchronisation refusee: ${String(key)}`, 400, 'INVALID_SYNC_KEY');
  }
  return key;
}

function sanitizeStructuredValue(value, depth = 0) {
  if (depth > SYNC_LIMITS.maxValueDepth) {
    throw new SyncPolicyError('Structure de donnees trop profonde', 400, 'VALUE_TOO_DEEP');
  }

  if (value === null) {
    return null;
  }

  const valueType = typeof value;
  if (valueType === 'string') {
    assertWithinBytes(value, SYNC_LIMITS.maxStructuredValueBytes, 'Valeur trop volumineuse', 413, 'VALUE_TOO_LARGE');
    return value;
  }

  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new SyncPolicyError('Nombre invalide dans les donnees synchronisees', 400, 'INVALID_NUMBER');
    }
    return value;
  }

  if (valueType === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const next = value.map((item) => sanitizeStructuredValue(item, depth + 1));
    assertWithinBytes(next, SYNC_LIMITS.maxStructuredValueBytes, 'Tableau trop volumineux', 413, 'VALUE_TOO_LARGE');
    return next;
  }

  if (!isPlainObject(value)) {
    throw new SyncPolicyError('Structure de donnees non supportee', 400, 'INVALID_VALUE_TYPE');
  }

  const next = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    next[ensureSafeNestedKey(entryKey)] = sanitizeStructuredValue(entryValue, depth + 1);
  }

  assertWithinBytes(next, SYNC_LIMITS.maxStructuredValueBytes, 'Objet trop volumineux', 413, 'VALUE_TOO_LARGE');
  return next;
}

function sanitizeDelta(delta) {
  if (!isPlainObject(delta)) {
    throw new SyncPolicyError('Delta de synchronisation invalide', 400, 'INVALID_DELTA');
  }

  const rawSet = delta.set === undefined ? {} : delta.set;
  const rawRemove = delta.remove === undefined ? [] : delta.remove;

  if (!isPlainObject(rawSet) || !Array.isArray(rawRemove)) {
    throw new SyncPolicyError('Delta de synchronisation invalide', 400, 'INVALID_DELTA');
  }

  const setEntries = Object.entries(rawSet);
  if (setEntries.length + rawRemove.length > SYNC_LIMITS.maxDeltaProperties) {
    throw new SyncPolicyError('Trop de modifications dans une seule operation', 413, 'DELTA_TOO_LARGE');
  }

  const set = {};
  for (const [key, value] of setEntries) {
    set[ensureSafeNestedKey(key)] = sanitizeStructuredValue(value);
  }

  const remove = rawRemove.map((key) => ensureSafeNestedKey(key));

  return { set, remove };
}

function validateAndNormalizeOps(ops) {
  if (!Array.isArray(ops)) {
    throw new SyncPolicyError('Operations de synchronisation invalides', 400, 'INVALID_OPS');
  }

  if (ops.length > SYNC_LIMITS.maxOpsPerRequest) {
    throw new SyncPolicyError('Trop d\'operations de synchronisation dans une seule requete', 413, 'TOO_MANY_OPS');
  }

  return ops.map((rawOp) => {
    if (!isPlainObject(rawOp)) {
      throw new SyncPolicyError('Operation de synchronisation invalide', 400, 'INVALID_OP');
    }

    const key = ensureSyncableStorageKey(rawOp.key);
    const op = typeof rawOp.op === 'string' ? rawOp.op : '';

    switch (op) {
      case 'set': {
        if (typeof rawOp.value !== 'string') {
          throw new SyncPolicyError('Valeur de synchronisation invalide', 400, 'INVALID_SET_VALUE');
        }
        assertWithinBytes(rawOp.value, SYNC_LIMITS.maxStringValueBytes, 'Valeur trop volumineuse', 413, 'VALUE_TOO_LARGE');
        return { op, key, value: rawOp.value };
      }

      case 'remove':
      case 'arrayClear':
        return { op, key };

      case 'arrayAdd':
      case 'arrayRemove': {
        const value = sanitizeStructuredValue(rawOp.value);
        return { op, key, value };
      }

      case 'objPatch':
        return { op, key, delta: sanitizeDelta(rawOp.delta) };

      default:
        throw new SyncPolicyError('Operation de synchronisation inconnue', 400, 'INVALID_OP');
    }
  });
}

function sanitizeStorageObject(rawData, options = {}) {
  const {
    maxBytes = SYNC_LIMITS.maxProfileBytes,
    maxKeys = SYNC_LIMITS.maxKeysPerProfile
  } = options;

  const sanitized = {};
  let changed = !isPlainObject(rawData);

  if (isPlainObject(rawData)) {
    for (const [key, value] of Object.entries(rawData)) {
      if (!isSyncableStorageKey(key) || typeof value !== 'string') {
        changed = true;
        continue;
      }

      if (getUtf8ByteLength(value) > SYNC_LIMITS.maxStringValueBytes) {
        changed = true;
        continue;
      }

      sanitized[key] = value;
    }
  }

  const keyCount = Object.keys(sanitized).length;
  if (keyCount > maxKeys) {
    throw new SyncPolicyError('Trop de cles synchronisees pour ce profil', 413, 'TOO_MANY_KEYS');
  }

  const bytes = keyCount === 0 ? 0 : getUtf8ByteLength(sanitized);
  if (bytes > maxBytes) {
    throw new SyncPolicyError('Quota de stockage depasse pour ce profil', 413, 'PROFILE_QUOTA_EXCEEDED');
  }

  return {
    data: sanitized,
    changed,
    stats: {
      bytes,
      keyCount
    }
  };
}

function sanitizeProfileData(rawData) {
  return sanitizeStorageObject(rawData, {
    maxBytes: SYNC_LIMITS.maxProfileBytes,
    maxKeys: SYNC_LIMITS.maxKeysPerProfile
  });
}

function sanitizeLegacySyncData(rawData) {
  return sanitizeStorageObject(rawData, {
    maxBytes: SYNC_LIMITS.maxLegacyUserBytes,
    maxKeys: SYNC_LIMITS.maxKeysPerProfile
  });
}

function assertUserDataSize(rawData) {
  assertWithinBytes(rawData, SYNC_LIMITS.maxUserDataBytes, 'Donnees utilisateur trop volumineuses', 413, 'USER_DATA_TOO_LARGE');
}

function getUserDataFilePath({ usersDir, guestsDir }, userType, userId) {
  if (userType === 'guest') {
    const safeGuestId = ensureSafeGuestId(userId);
    return resolveInside(guestsDir, `guest-${safeGuestId}.json`);
  }

  const safeUserType = ensureValidUserType(userType);
  const safeUserId = ensureSafeUserId(userId);
  const fileName = safeUserType === 'bip39' ? `bip39-${safeUserId}.json` : `${safeUserId}.json`;
  return resolveInside(usersDir, fileName);
}

function getProfileFilePath(usersDir, userType, userId, profileId) {
  const safeUserType = ensureValidUserType(userType);
  const safeUserId = ensureSafeUserId(userId);
  const safeProfileId = ensureSafeProfileId(profileId);
  return resolveInside(usersDir, 'profiles', safeUserType, safeUserId, `${safeProfileId}.json`);
}

function getOwnedProfile(userData, profileId) {
  const safeProfileId = ensureSafeProfileId(profileId);
  const profiles = Array.isArray(userData?.profiles) ? userData.profiles : [];
  const profile = profiles.find((item) => item && item.id === safeProfileId);

  if (!profile) {
    throw new SyncPolicyError('Profil introuvable', 404, 'PROFILE_NOT_FOUND');
  }

  return profile;
}

module.exports = {
  ALLOWED_SYNC_USER_TYPES,
  BLOCKED_SYNC_KEYS,
  IDENTITY_LIMITS,
  SYNC_LIMITS,
  SyncPolicyError,
  assertUserDataSize,
  ensureSafeProfileId,
  ensureSafeUserId,
  ensureValidUserType,
  getOwnedProfile,
  getProfileFilePath,
  getUserDataFilePath,
  getUtf8ByteLength,
  isSyncableStorageKey,
  resolveInside,
  sanitizeLegacySyncData,
  isProfileNameValid,
  sanitizeProfileData,
  truncateDisplayName,
  validateAndNormalizeOps,
  validateProfileName
};
