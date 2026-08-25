/**
 * mediaSigning.js — Signature HMAC des URLs média servies par proxiesembed.
 *
 * Pendant Node de `API/proxiesembed/media_signing.py`. Les deux
 * implémentations DOIVENT construire le payload à l'identique :
 *
 *     payload = `${route}\n${target}\n${exp}`
 *     sig     = base64url(HMAC-SHA256(MEDIA_SIGNING_SECRET, payload))  // sans '='
 *
 * Toute divergence (ordre des champs, séparateur, padding base64) casse
 * silencieusement la lecture vidéo côté client : ne modifier qu'en binôme.
 */

const crypto = require('crypto');
const net = require('net');

const SIGNING_SECRET = (process.env.MEDIA_SIGNING_SECRET || '').trim();
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

function parseIntEnv(name, fallback) {
    const raw = (process.env[name] || '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

// 12 h — doit rester identique au défaut Python (MEDIA_SIGNATURE_TTL).
const SIGNATURE_TTL = parseIntEnv('MEDIA_SIGNATURE_TTL', 43200);

const INTERNAL_KEY_HEADER = 'x-internal-key';

function signingConfigured() {
    return SIGNING_SECRET.length > 0;
}

function internalKeyConfigured() {
    return INTERNAL_API_KEY.length > 0;
}

function computeSignature(route, target, exp) {
    if (!SIGNING_SECRET) {
        throw new Error('MEDIA_SIGNING_SECRET absent');
    }
    return crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`${route}\n${target}\n${exp}`, 'utf8')
        .digest('base64url');
}

/** Fragment `exp=...&sig=...`, sans `?` ni `&` initial. */
function signQuery(route, target, ttlSeconds) {
    const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : SIGNATURE_TTL;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = computeSignature(route, target, exp);
    return `exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

/** Ajoute la signature à une URL déjà construite. */
function appendSignature(url, route, target, ttlSeconds) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${signQuery(route, target, ttlSeconds)}`;
}

/**
 * Construit une URL proxifiée signée, prête à être consommée par le player.
 *
 * @param {string} proxyBase  Origine publique de proxiesembed (sans slash final)
 * @param {string} route      Route proxy, ex. '/proxy' ou '/cinep-proxy'
 * @param {string} target     URL amont à relayer
 * @param {object} [options]  { ttlSeconds, extraParams }
 */
function buildSignedProxyUrl(proxyBase, route, target, options = {}) {
    const base = String(proxyBase || '').replace(/\/+$/, '');
    const params = new URLSearchParams({ url: target });
    for (const [key, value] of Object.entries(options.extraParams || {})) {
        if (value !== undefined && value !== null && value !== '') {
            params.set(key, String(value));
        }
    }
    const url = `${base}${route}?${params.toString()}`;
    return appendSignature(url, route, target, options.ttlSeconds);
}

// ---------------------------------------------------------------------------
//  Jetons opaques signés
// ---------------------------------------------------------------------------
// Quand une valeur d'origine serveur doit faire un aller-retour par le client
// (l'adresse d'une page France.tv, par exemple), on ne la lui confie pas en
// clair : il pourrait la remplacer. On l'emballe dans un jeton signé, que lui
// seul transporte sans pouvoir le fabriquer.
//
// Même construction que `encode_signed_drm_base` côté Python : `exp:sig:valeur`
// en base64url.

function encodeSignedToken(route, value, ttlSeconds) {
    const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : SIGNATURE_TTL;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = computeSignature(route, value, exp);
    return Buffer.from(`${exp}:${sig}:${value}`, 'utf8').toString('base64url');
}

/**
 * Décode et vérifie un jeton. Retourne la valeur d'origine, ou null si le
 * jeton est absent, malformé, expiré ou forgé.
 */
function decodeSignedToken(route, token) {
    if (!token || typeof token !== 'string' || !SIGNING_SECRET) return null;

    let decoded;
    try {
        decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
        return null;
    }

    // La valeur peut contenir des « : » (une URL en contient) : on ne découpe
    // que sur les deux premiers.
    const first = decoded.indexOf(':');
    const second = decoded.indexOf(':', first + 1);
    if (first < 0 || second < 0) return null;

    const exp = Number.parseInt(decoded.slice(0, first), 10);
    const sig = decoded.slice(first + 1, second);
    const value = decoded.slice(second + 1);
    if (!Number.isInteger(exp) || !sig || !value) return null;

    const now = Math.floor(Date.now() / 1000);
    if (exp < now || exp > now + SIGNATURE_TTL + 300) return null;

    let expected;
    try {
        expected = computeSignature(route, value, exp);
    } catch {
        return null;
    }

    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    return value;
}

/** Headers à joindre à un appel sortant mainapi -> proxiesembed. */
function internalHeaders(extra = {}) {
    if (!INTERNAL_API_KEY) {
        throw new Error('INTERNAL_API_KEY absent');
    }
    return { ...extra, [INTERNAL_KEY_HEADER]: INTERNAL_API_KEY };
}

// ---------------------------------------------------------------------------
//  Garde anti-SSRF sur la destination
// ---------------------------------------------------------------------------
// mainapi signe des URLs à la demande (Live TV). Sans ce contrôle, un porteur
// de clé VIP transformerait l'endpoint de signature en oracle SSRF capable de
// viser le réseau interne.

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
]);

const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];

function isPrivateIpv4(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local + métadonnées cloud
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    if (a === 192 && b === 0) return true;              // IETF protocol assignments
    if (a >= 224) return true;                          // multicast + réservé
    return false;
}

function isPrivateIpv6(address) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80')) return true;                 // link-local
    if (/^f[cd]/.test(normalized)) return true;                     // unique-local

    // IPv4-mapped (::ffff:a.b.c.d). Attention : le parseur d'URL de Node
    // recompresse la forme pointée en hexadécimal — `[::ffff:127.0.0.1]`
    // devient `::ffff:7f00:1`. Ne comparer que la forme pointée laissait donc
    // passer le loopback. On traite les deux écritures.
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        if (net.isIPv4(mapped)) return isPrivateIpv4(mapped);
        const hextets = mapped.split(':');
        if (hextets.length === 2) {
            const high = Number.parseInt(hextets[0], 16);
            const low = Number.parseInt(hextets[1], 16);
            if (Number.isInteger(high) && Number.isInteger(low)) {
                const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
                return isPrivateIpv4(dotted);
            }
        }
        // Forme mappée non reconnue : on refuse par défaut.
        return true;
    }
    return false;
}

/**
 * Vrai si l'URL est http(s) et ne vise pas littéralement une adresse interne.
 * Ne résout pas le DNS — la protection contre le rebinding est côté resolver.
 */
function isPublicHttpUrl(value) {
    if (!value || typeof value !== 'string') return false;

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.trim().replace(/\.$/, '').toLowerCase();
    if (!hostname) return false;
    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

    if (net.isIPv4(hostname)) return !isPrivateIpv4(hostname);

    const unbracketed = hostname.replace(/^\[|\]$/g, '');
    if (net.isIPv6(unbracketed)) return !isPrivateIpv6(unbracketed);

    return true;
}

module.exports = {
    INTERNAL_KEY_HEADER,
    SIGNATURE_TTL,
    signingConfigured,
    internalKeyConfigured,
    computeSignature,
    signQuery,
    appendSignature,
    buildSignedProxyUrl,
    encodeSignedToken,
    decodeSignedToken,
    internalHeaders,
    isPublicHttpUrl,
};
