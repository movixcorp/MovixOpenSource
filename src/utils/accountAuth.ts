export type AuthMethod = 'discord' | 'google' | 'bip39';
export type ResolvedUserType = 'oauth' | 'bip39';

interface StoredUserProfile extends Record<string, unknown> {
  id?: string | number;
  userId?: string | number;
  username?: string;
  provider?: string;
  avatar?: string;
  name?: string;
  email?: string;
  picture?: string;
  sub?: string | number;
  discriminator?: string;
  roles?: unknown[];
  isAdmin?: boolean;
}

interface PendingAuthLinkAction {
  type: 'link';
  provider: AuthMethod;
  returnTo: string;
  createdAt: number;
}

interface PendingOauthAuthorizeAction {
  type: 'oauth-authorize';
  returnTo: string;
  clientId?: string | null;
  createdAt: number;
}

type PendingAuthAction = PendingAuthLinkAction | PendingOauthAuthorizeAction;

interface ResolvedAccountPayload {
  userType?: ResolvedUserType;
  userId?: string | null;
  linked?: boolean;
}

interface AuthDataPayload {
  userProfile?: StoredUserProfile;
  provider?: string;
}

export interface ResolvedAuthResponse {
  sessionId?: string | null;
  token?: string | null;
  user?: StoredUserProfile | null;
  account?: ResolvedAccountPayload | null;
  authData?: AuthDataPayload | null;
}

interface PersistResolvedSessionOptions {
  accessToken?: string | null;
}

interface StoredAuthData {
  userProfile?: StoredUserProfile;
  provider?: string;
}

interface DecodedJwtPayload {
  sub?: string;
  userType?: string;
  authMethod?: string;
}

const DEFAULT_AVATAR = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
const PENDING_AUTH_ACTION_KEY = 'movix_pending_auth_action';
const PENDING_AUTH_ACTION_COOKIE = 'movix_pending_auth_action';
const PENDING_AUTH_ACTION_TTL_MS = 30 * 60 * 1000;
const PENDING_AUTH_ACTION_TTL_SECONDS = Math.floor(PENDING_AUTH_ACTION_TTL_MS / 1000);
// Note : selected_profile_id n'est PAS dans cette liste volontairement. Sur un
// changement de domaine (block FAI → miroir → localStorage vide), l'utilisateur
// se reconnecte ; on veut préserver son profil choisi quand c'est possible.
// Si le selected_profile_id stocké ne matche aucun profil du compte qui se
// connecte (ex: switch de compte), ProfileContext.loadProfiles fallback sur
// le profil par défaut.
const AUTH_KEYS = [
  'auth',
  'auth_token',
  'session_id',
  'discord_auth',
  'discord_user',
  'discord_token',
  'google_auth',
  'google_user',
  'google_token',
  'bip39_auth',
  'auth_method',
  'resolved_user_type',
  'resolved_user_id',
  'user_id',
] as const;

function isAuthMethod(value: string | null): value is AuthMethod {
  return value === 'discord' || value === 'google' || value === 'bip39';
}

function isResolvedUserType(value: string | null): value is ResolvedUserType {
  return value === 'oauth' || value === 'bip39';
}

function isPendingAuthLinkAction(value: PendingAuthAction | null): value is PendingAuthLinkAction {
  return Boolean(
    value &&
    value.type === 'link' &&
    isAuthMethod(value.provider) &&
    typeof value.returnTo === 'string'
  );
}

function isPendingOauthAuthorizeAction(value: PendingAuthAction | null): value is PendingOauthAuthorizeAction {
  return Boolean(
    value &&
    value.type === 'oauth-authorize' &&
    typeof value.returnTo === 'string'
  );
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const prefix = `${encodeURIComponent(name)}=`;
  const cookieEntry = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(prefix));

  if (!cookieEntry) return null;

  try {
    return decodeURIComponent(cookieEntry.slice(prefix.length));
  } catch {
    return null;
  }
}

function writeCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === 'undefined') return;

  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? '; Secure'
    : '';
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

function clearCookie(name: string) {
  if (typeof document === 'undefined') return;
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? '; Secure'
    : '';
  document.cookie = `${encodeURIComponent(name)}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function parsePendingAuthAction(raw: string | null): PendingAuthAction | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingAuthAction;
    const isFresh = typeof parsed.createdAt === 'number' && Date.now() - parsed.createdAt < PENDING_AUTH_ACTION_TTL_MS;
    if (isFresh && isPendingAuthLinkAction(parsed)) {
      return parsed;
    }

    if (isFresh && isPendingOauthAuthorizeAction(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed state.
  }

  return null;
}

function persistPendingAuthAction(payload: PendingAuthAction) {
  const serialized = JSON.stringify(payload);
  localStorage.setItem(PENDING_AUTH_ACTION_KEY, serialized);
  writeCookie(PENDING_AUTH_ACTION_COOKIE, serialized, PENDING_AUTH_ACTION_TTL_SECONDS);
}

function getStoredAuthData(): StoredAuthData | null {
  const authStr = localStorage.getItem('auth');
  if (!authStr) return null;

  try {
    const parsed = JSON.parse(authStr) as StoredAuthData;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string | null): DecodedJwtPayload | null {
  if (!token) return null;

  const [, rawPayload] = token.split('.');
  if (!rawPayload) return null;

  try {
    const normalizedPayload = rawPayload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '='
    );
    const parsed = JSON.parse(atob(paddedPayload)) as DecodedJwtPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getDiscordAvatar(rawUser?: StoredUserProfile | null) {
  if (!rawUser) return DEFAULT_AVATAR;
  if (typeof rawUser.avatar === 'string' && rawUser.avatar.startsWith('http')) {
    return rawUser.avatar;
  }
  if (rawUser.id && rawUser.avatar) {
    return `https://cdn.discordapp.com/avatars/${rawUser.id}/${rawUser.avatar}.png`;
  }
  return DEFAULT_AVATAR;
}

function getFallbackAuthProfile(method: AuthMethod, resolvedUserId: string, rawUser?: StoredUserProfile | null) {
  if (method === 'discord') {
    return {
      id: resolvedUserId,
      username: rawUser?.username || `Discord-${resolvedUserId}`,
      avatar: getDiscordAvatar(rawUser),
      provider: 'discord',
    };
  }

  if (method === 'google') {
    return {
      id: resolvedUserId,
      username: rawUser?.name || rawUser?.email || `Google-${resolvedUserId}`,
      avatar: rawUser?.picture || DEFAULT_AVATAR,
      provider: 'google',
    };
  }

  return {
    id: resolvedUserId,
    username: rawUser?.username || `Utilisateur-${resolvedUserId.slice(0, 8)}`,
    avatar: rawUser?.avatar || DEFAULT_AVATAR,
    provider: 'bip39',
  };
}

export function getCurrentAuthMethod(): AuthMethod | null {
  const storedMethod = localStorage.getItem('auth_method');
  if (isAuthMethod(storedMethod)) return storedMethod;

  const tokenPayload = decodeJwtPayload(localStorage.getItem('auth_token'));
  const tokenAuthMethod = tokenPayload?.authMethod || null;
  if (isAuthMethod(tokenAuthMethod)) return tokenAuthMethod;

  if (localStorage.getItem('discord_auth') === 'true') return 'discord';
  if (localStorage.getItem('google_auth') === 'true') return 'google';
  if (localStorage.getItem('bip39_auth') === 'true') return 'bip39';
  if (tokenPayload?.userType === 'bip39') return 'bip39';
  return null;
}

export function getResolvedUserType(): ResolvedUserType | null {
  const storedType = localStorage.getItem('resolved_user_type');
  if (isResolvedUserType(storedType)) return storedType;

  const auth = getStoredAuthData();
  const provider = typeof auth?.userProfile?.provider === 'string'
    ? auth.userProfile.provider
    : auth?.provider;
  if (provider === 'bip39') return 'bip39';

  const tokenPayload = decodeJwtPayload(localStorage.getItem('auth_token'));
  const tokenUserType = tokenPayload?.userType || null;
  if (isResolvedUserType(tokenUserType)) return tokenUserType;

  return getCurrentAuthMethod() === 'bip39' ? 'bip39' : 'oauth';
}

export function getResolvedUserId(): string | null {
  const storedId = localStorage.getItem('resolved_user_id') || localStorage.getItem('user_id');
  if (storedId) return storedId;

  const auth = getStoredAuthData();
  const authId = auth?.userProfile?.id ?? auth?.userProfile?.userId;
  if (authId) return String(authId);

  const tokenPayload = decodeJwtPayload(localStorage.getItem('auth_token'));
  if (tokenPayload?.sub) return tokenPayload.sub;

  const method = getCurrentAuthMethod();
  if (method === 'discord') {
    try {
      const user = JSON.parse(localStorage.getItem('discord_user') || '{}');
      return user?.id ? String(user.id) : null;
    } catch {
      return null;
    }
  }

  if (method === 'google') {
    try {
      const user = JSON.parse(localStorage.getItem('google_user') || '{}');
      return user?.id ? String(user.id) : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function getResolvedAccountProvider(): AuthMethod | null {
  const auth = getStoredAuthData();
  const provider = typeof auth?.userProfile?.provider === 'string'
    ? auth.userProfile.provider
    : auth?.provider;
  const normalizedProvider = provider ?? null;
  if (isAuthMethod(normalizedProvider)) return normalizedProvider;

  return getResolvedUserType() === 'bip39' ? 'bip39' : getCurrentAuthMethod();
}

export function getResolvedAccountContext() {
  return {
    authMethod: getCurrentAuthMethod(),
    accountProvider: getResolvedAccountProvider(),
    userType: getResolvedUserType(),
    userId: getResolvedUserId(),
  };
}

export function getPendingAuthAction(): PendingAuthAction | null {
  const fromLocalStorage = parsePendingAuthAction(localStorage.getItem(PENDING_AUTH_ACTION_KEY));
  if (fromLocalStorage) {
    writeCookie(PENDING_AUTH_ACTION_COOKIE, JSON.stringify(fromLocalStorage), PENDING_AUTH_ACTION_TTL_SECONDS);
    return fromLocalStorage;
  }

  const fromCookie = parsePendingAuthAction(readCookie(PENDING_AUTH_ACTION_COOKIE));
  if (fromCookie) {
    localStorage.setItem(PENDING_AUTH_ACTION_KEY, JSON.stringify(fromCookie));
    return fromCookie;
  }

  clearPendingAuthAction();
  return null;
}

export function setPendingAuthLink(provider: AuthMethod, returnTo = '/settings#accounts') {
  const payload: PendingAuthAction = {
    type: 'link',
    provider,
    returnTo,
    createdAt: Date.now(),
  };
  persistPendingAuthAction(payload);
}

export function setPendingAuthAuthorize(returnTo: string, clientId?: string | null) {
  const payload: PendingAuthAction = {
    type: 'oauth-authorize',
    returnTo,
    clientId: clientId || null,
    createdAt: Date.now(),
  };
  persistPendingAuthAction(payload);
}

export function clearPendingAuthAction() {
  localStorage.removeItem(PENDING_AUTH_ACTION_KEY);
  clearCookie(PENDING_AUTH_ACTION_COOKIE);
}

/**
 * Rafraîchit le JWT via l'API /api/auth/refresh
 * Retourne le nouveau token ou null si le refresh a échoué.
 */
let refreshPromise: Promise<string | null> | null = null;

export async function refreshAuthToken(): Promise<string | null> {
  // Éviter les appels concurrents
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const currentToken = localStorage.getItem('auth_token');
      if (!currentToken) return null;

      const { MAIN_API } = await import('../config/runtime');
      const response = await fetch(`${MAIN_API}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentToken}`,
        },
        body: JSON.stringify({ token: currentToken }),
      });

      if (!response.ok) {
        // Refresh échoué, forcer la déconnexion
        clearStoredAuthSession();
        return null;
      }

      const data = await response.json();
      if (data?.token) {
        localStorage.setItem('auth_token', data.token);
        return data.token;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function clearStoredAuthSession() {
  AUTH_KEYS.forEach((key) => localStorage.removeItem(key));
}

export function broadcastAuthChange() {
  window.dispatchEvent(new Event('storage'));
  window.dispatchEvent(new Event('auth_changed'));
}

export function persistResolvedSession(
  method: AuthMethod,
  payload: ResolvedAuthResponse,
  options: PersistResolvedSessionOptions = {}
) {
  const rawUser = payload.user || null;
  const resolvedUserType = payload.account?.userType || (method === 'bip39' ? 'bip39' : 'oauth');
  const resolvedUserId = String(
    payload.account?.userId ||
    payload.authData?.userProfile?.id ||
    rawUser?.id ||
    rawUser?.sub ||
    ''
  );

  if (!resolvedUserId) {
    throw new Error('Impossible de déterminer l’identifiant du compte résolu');
  }

  clearStoredAuthSession();

  localStorage.setItem('auth_method', method);
  localStorage.setItem('resolved_user_type', resolvedUserType);
  localStorage.setItem('resolved_user_id', resolvedUserId);
  localStorage.setItem('user_id', resolvedUserId);

  if (payload.sessionId) localStorage.setItem('session_id', payload.sessionId);
  if (payload.token) localStorage.setItem('auth_token', payload.token);

  if (method === 'discord') {
    const providerId = String(rawUser?.id || resolvedUserId);
    localStorage.setItem('discord_auth', 'true');
    localStorage.setItem('discord_user', JSON.stringify({
      id: resolvedUserId,
      providerId,
      username: rawUser?.username || payload.authData?.userProfile?.username || `Discord-${providerId}`,
      discriminator: rawUser?.discriminator,
      avatar: getDiscordAvatar(rawUser),
      roles: Array.isArray(rawUser?.roles) ? rawUser.roles : [],
      isAdmin: Boolean(rawUser?.isAdmin),
      linked: Boolean(payload.account?.linked),
    }));
    if (options.accessToken) localStorage.setItem('discord_token', options.accessToken);
  }

  if (method === 'google') {
    const providerId = String(rawUser?.sub || rawUser?.id || resolvedUserId);
    localStorage.setItem('google_auth', 'true');
    localStorage.setItem('google_user', JSON.stringify({
      id: resolvedUserId,
      providerId,
      email: rawUser?.email || '',
      name: rawUser?.name || payload.authData?.userProfile?.username || `Google-${providerId}`,
      picture: rawUser?.picture || DEFAULT_AVATAR,
      linked: Boolean(payload.account?.linked),
    }));
    if (options.accessToken) localStorage.setItem('google_token', options.accessToken);
  }

  if (method === 'bip39') {
    localStorage.setItem('bip39_auth', 'true');
  }

  const authData = payload.authData?.userProfile
    ? payload.authData
    : {
        userProfile: getFallbackAuthProfile(method, resolvedUserId, rawUser),
        provider: method,
      };

  localStorage.setItem('auth', JSON.stringify(authData));
}
