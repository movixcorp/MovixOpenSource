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
  'movixCalendarEntries',
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
  'watchPartyNickname',
]);

const SYNCABLE_PREFIXES = [
  'favorite_',
  'favorites_',
  'miniPlayer',
  'movix_intro_',
  'player',
  'progress_',
  'screensaver_',
  'settings_',
  'watchlist_',
  'watched_',
];

// Persistent outbox of pending sync ops. Survives refresh so a user write that
// didn't reach the server before unload (Firefox keepalive flake, network
// hiccup, browser crash) is replayed on next boot before loadProfileData wipes
// localStorage. See ProfileContext.replayOutboxIfAny.
export const SYNC_OUTBOX_STORAGE_KEY = '__movix_sync_outbox';

const BLOCKED_SYNC_KEYS = new Set([
  SYNC_OUTBOX_STORAGE_KEY,
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
  'user_type',
]);

const PROFILE_LOAD_PRESERVED_KEYS = new Set([
  SYNC_OUTBOX_STORAGE_KEY,
  // VIP credential/entitlement keys are server-authoritative (verified via
  // /api/check-vip + refreshVipState), like is_admin. They stay syncable for
  // cross-device propagation but MUST NOT be wiped during the profile-load
  // wipe-and-restore: the transient removeItem('is_vip') fired a native
  // cross-tab `storage` event that flipped VIPs to non-VIP for a tick and
  // re-triggered the ad popup on open watch tabs. See AdFreePopupContext.
  'access_code',
  'access_code_expires',
  'access_token',
  'auth',
  'auth_method',
  'auth_token',
  'avatar_url',
  'bip39_auth',
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
  'is_vip',
  'movix_pending_auth_action',
  'resolved_user_id',
  'resolved_user_type',
  'selectedProfile',
  'selected_profile',
  'selected_profile_id',
  'session_id',
  'user_id',
  'user_name',
  'user_type',
]);

const SAFE_SYNC_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;
const textEncoder = new TextEncoder();

export type NonSyncableStorageReason = 'blocked' | 'invalid_format' | 'not_allowlisted';

export interface NonSyncableLocalStorageEntry {
  key: string;
  value: string;
  bytes: number;
  reason: NonSyncableStorageReason;
}

function getEntryBytes(key: string, value: string) {
  return textEncoder.encode(key).length + textEncoder.encode(value).length;
}

export function getStorageKeySyncState(
  key: string | null | undefined
): 'syncable' | NonSyncableStorageReason {
  if (typeof key !== 'string') return 'invalid_format';
  if (BLOCKED_SYNC_KEYS.has(key)) return 'blocked';
  if (!SAFE_SYNC_KEY_PATTERN.test(key)) return 'invalid_format';
  if (SYNCABLE_EXACT_KEYS.has(key)) return 'syncable';
  if (SYNCABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'syncable';
  return 'not_allowlisted';
}

export function isSyncableStorageKey(key: string | null | undefined): key is string {
  return getStorageKeySyncState(key) === 'syncable';
}

export function shouldPreserveStorageKeyOnProfileLoad(key: string | null | undefined): key is string {
  return typeof key === 'string' && PROFILE_LOAD_PRESERVED_KEYS.has(key);
}

export function getAllLocalStorageEntries(storage: Storage = window.localStorage) {
  const entries: Record<string, string> = {};

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    entries[key] = storage.getItem(key) || '';
  }

  return entries;
}

export function getSyncableLocalStorageEntries(storage: Storage = window.localStorage) {
  const entries: Record<string, string> = {};

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!isSyncableStorageKey(key)) continue;

    const value = storage.getItem(key);
    if (typeof value !== 'string') continue;
    entries[key] = value;
  }

  return entries;
}

export function getNonSyncableLocalStorageEntries(storage: Storage = window.localStorage) {
  const entries: NonSyncableLocalStorageEntry[] = [];

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;

    const syncState = getStorageKeySyncState(key);
    if (syncState === 'syncable') continue;

    const value = storage.getItem(key) || '';
    entries.push({
      key,
      value,
      bytes: getEntryBytes(key, value),
      reason: syncState,
    });
  }

  return entries.sort((left, right) => {
    if (right.bytes !== left.bytes) return right.bytes - left.bytes;
    return left.key.localeCompare(right.key);
  });
}

export function hasSyncableLocalStorageData(storage: Storage = window.localStorage) {
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!isSyncableStorageKey(key)) continue;

    const value = storage.getItem(key);
    if (typeof value === 'string' && value.trim() !== '') {
      return true;
    }
  }

  return false;
}

export function getLocalStorageMetrics(storage: Storage = window.localStorage) {
  let totalBytes = 0;
  let syncableBytes = 0;
  let totalKeys = 0;
  let syncableKeys = 0;

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;

    const value = storage.getItem(key) || '';
    const entryBytes = getEntryBytes(key, value);

    totalKeys += 1;
    totalBytes += entryBytes;

    if (isSyncableStorageKey(key)) {
      syncableKeys += 1;
      syncableBytes += entryBytes;
    }
  }

  return {
    totalBytes,
    syncableBytes,
    totalKeys,
    syncableKeys,
  };
}

export function formatStorageBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}
