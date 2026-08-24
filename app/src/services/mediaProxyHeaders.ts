const PROVIDER_SIGNED_USER_AGENT = 'Mozilla/5.0 Chrome/140.0.0.0';

// Fsvid/Vidzy refusent une requête HLS qui n'a pas à la fois un Referer sur un
// de leurs domaines et un en-tête Sec-Ch-Ua : fsvid répond alors par une 302
// vers son flux leurre (s1.fsvid.lol/troll/master.m3u8) et vidzy par une 403.
const PROVIDER_SEC_CH_UA =
  '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some(existing => existing.toLowerCase() === lowered);
}

function setCanonicalHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      delete headers[existing];
    }
  }
  headers[name] = value;
}

export function applyMediaProxyHeaderRules(
  url: string,
  input: Record<string, string>,
): Record<string, string> {
  const headers = { ...input };
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return headers;
  }

  const isFsvidHost = hostname === 'fsvid.lol' || hostname.endsWith('.fsvid.lol');
  const isVidzyHost =
    hostname === 'vidzy.org'
    || hostname.endsWith('.vidzy.org')
    || hostname === 'vidzy.cc'
    || hostname.endsWith('.vidzy.cc');
  if (!isFsvidHost && !isVidzyHost) {
    return headers;
  }

  if (isFsvidHost) {
    const origin = hostname === 'fsvid.lol'
      ? 'https://fs13.lol'
      : 'https://fsvid.lol';
    setCanonicalHeader(headers, 'Origin', origin);
    setCanonicalHeader(headers, 'Referer', `${origin}/`);
  } else if (!hasHeader(headers, 'Referer')) {
    // Le CDN Vidzy renvoie 403 sans Referer sur un de ses domaines.
    setCanonicalHeader(headers, 'Referer', 'https://vidzy.org/');
  }
  setCanonicalHeader(headers, 'Sec-Ch-Ua', PROVIDER_SEC_CH_UA);
  setCanonicalHeader(headers, 'Sec-Fetch-Site', 'cross-site');
  setCanonicalHeader(headers, 'Sec-Fetch-Mode', 'cors');
  setCanonicalHeader(headers, 'Sec-Fetch-Dest', 'empty');
  setCanonicalHeader(headers, 'User-Agent', PROVIDER_SIGNED_USER_AGENT);
  return headers;
}
