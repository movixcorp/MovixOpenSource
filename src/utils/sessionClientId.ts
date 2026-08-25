const SESSION_CLIENT_ID_STORAGE_KEY = 'movix_session_client_id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createSessionClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;

  const hex = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

/**
 * Identifie durablement un profil de navigateur, sans être lié à l'IP ou à la
 * version du navigateur. Ce n'est pas un secret d'authentification.
 */
export function getSessionClientId(): string {
  const existing = localStorage.getItem(SESSION_CLIENT_ID_STORAGE_KEY);
  if (existing && UUID_PATTERN.test(existing)) {
    return existing;
  }

  const clientId = createSessionClientId();
  localStorage.setItem(SESSION_CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

export function getSessionCreationHeaders(): Record<string, string> {
  return { 'X-Movix-Client-Id': getSessionClientId() };
}
