/**
 * Proxy management utilities.
 * Extracted from server.js — centralizes all proxy configuration, agent caching,
 * Cloudflare Workers proxy rotation, CORS fallback, and site-specific request helpers.
 */

const axios = require("axios");
const cluster = require("node:cluster");
const crypto = require("node:crypto");
const http = require("http");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const tough = require("tough-cookie");
const initCycleTLS = require("cycletls");
const { LruMap } = require("./lruMap");
const { redis } = require("../config/redis");
const {
  shouldRotateAnimeSamaResponse,
} = require("./animeSamaProxyPolicy");
const {
  createWiflixProxyAffinity,
  isSocksWiflixProxyUrl,
  mergeWiflixProxySources,
  redactWiflixProxyUrl,
  runWiflixProxyAttempts,
} = require("./wiflixProxyAffinity");
const {
  createWiflixProxyTelemetry,
} = require("./wiflixProxyTelemetry");
const {
  createVavooProxyPolicy,
  isUsableVavooSocks5Proxy,
  parseVavooProxyJson,
} = require("./vavooProxyPolicy");

// === PROXY AGENT CACHES ===
// LRU-capped with onEvict that destroys the underlying agent (closes its
// keep-alive socket pool) so evicted entries do not leak sockets at the OS
// level. Without this, growing proxy rotation accumulated agents indefinitely
// — the root cause of multi-GB worker RSS.
const PROXY_AGENT_CACHE_MAX = 256;

function destroyHttpAgentLike(value) {
  if (!value || typeof value !== "object") return;
  // SocksProxyAgent / HttpProxyAgent / HttpsProxyAgent all extend http.Agent
  // and expose a `destroy()` that closes pooled sockets.
  if (typeof value.destroy === "function") {
    try { value.destroy(); } catch (_) { /* ignore */ }
    return;
  }
  // Darkino/Wiflix entries wrap two agents.
  if (value.httpAgent && typeof value.httpAgent.destroy === "function") {
    try { value.httpAgent.destroy(); } catch (_) { /* ignore */ }
  }
  if (
    value.httpsAgent &&
    value.httpsAgent !== value.httpAgent &&
    typeof value.httpsAgent.destroy === "function"
  ) {
    try { value.httpsAgent.destroy(); } catch (_) { /* ignore */ }
  }
}

const proxyAgentCache = new LruMap({
  max: PROXY_AGENT_CACHE_MAX,
  onEvict: destroyHttpAgentLike,
});
const darkinoProxyAgentCache = new LruMap({
  max: PROXY_AGENT_CACHE_MAX,
  onEvict: destroyHttpAgentLike,
});
const proxyRotationState = new Map();

// Initialize global agent keep-alive with socket limits
http.globalAgent.keepAlive = true;
http.globalAgent.maxSockets = 128;
http.globalAgent.maxFreeSockets = 32;
https.globalAgent.keepAlive = true;
https.globalAgent.maxSockets = 128;
https.globalAgent.maxFreeSockets = 32;

// === PROXY CONFIGURATION FLAGS ===
const ENABLE_DARKINO_PROXY = true; // Passe \u00e0 false pour d\u00e9sactiver le proxy pour Darkino
const ENABLE_COFLIX_PROXY = true; // Passe \u00e0 false pour d\u00e9sactiver le proxy pour Coflix
// Origine Coflix utilis\u00e9e comme Referer/Origin des requ\u00eates LecteurVideo
// (le token JWT du player est \u00e9mis par Coflix ; lecteurvideo.com valide le Referer).
// Overridable via COFLIX_BASE_URL pour suivre les rotations de domaine.
const COFLIX_ORIGIN = (
  process.env.COFLIX_BASE_URL || "https://coflix.esq"
).replace(/\/$/, "");
const ENABLE_FRENCH_STREAM_PROXY = true; // Active/d\u00e9sactive le proxy pour French-Stream
const ENABLE_LECTEURVIDEO_PROXY = true; // Active/d\u00e9sactive le proxy pour LecteurVideo
const ENABLE_FSTREAM_PROXY = true; // Active/d\u00e9sactive le proxy pour FStream
const ENABLE_ANIME_PROXY = true; // Active/d\u00e9sactive le proxy pour AnimeSama (via Cloudflare Workers)
const ENABLE_WIFLIX_PROXY = true; // Active/d\u00e9sactive le proxy pour Wiflix
const WIFLIX_PROXY_BLOCK_WEBHOOK_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.WIFLIX_PROXY_BLOCK_WEBHOOK_ENABLED || 'true').trim().toLowerCase(),
);
const MAX_PROXYSCRAPE_PROXY_ATTEMPTS = 2;

// Constante pour l'enhancement Darkino
const darkiworld_premium = false; // Passe \u00e0 false pour d\u00e9sactiver l'enhancement Darkino

// === DARKINO COOLDOWNS (cluster-wide via Redis) ===
// Cooldown de 5 minutes apr\u00e8s une erreur 403 (Cloudflare challenge), 429
// (Too Many Requests / Cloudflare Workers daily limit) ou 5xx (erreur
// serveur). Stock\u00e9 en Redis pour que les 6 workers partagent le signal :
// un seul worker doit hit l'erreur pour que tous arr\u00eatent de marteler.
const DARKINO_403_COOLDOWN_MS = 5 * 60 * 1000;
const DARKINO_429_COOLDOWN_MS = 5 * 60 * 1000;
const DARKINO_5XX_COOLDOWN_MS = 5 * 60 * 1000;
const DARKINO_NETERR_COOLDOWN_MS = 5 * 60 * 1000;

const DARKINO_COOLDOWN_KEYS = {
  '403': 'darkino:cooldown:403',
  '429': 'darkino:cooldown:429',
  '5xx': 'darkino:cooldown:5xx',
  'neterr': 'darkino:cooldown:neterr',
};
const DARKINO_COOLDOWN_TTL_MS = {
  '403': DARKINO_403_COOLDOWN_MS,
  '429': DARKINO_429_COOLDOWN_MS,
  '5xx': DARKINO_5XX_COOLDOWN_MS,
  'neterr': DARKINO_NETERR_COOLDOWN_MS,
};

// === DARKINO NETWORK-FAILURE CIRCUIT BREAKER ===
// Les cooldowns 403/429/5xx ne couvrent QUE les erreurs avec une reponse HTTP.
// Un timeout / erreur reseau (ECONNABORTED, ECONNRESET, ...) n'a pas de
// error.response : aucun cooldown ne s'armait, donc chaque requete continuait
// a marteler un upstream mort -> requetes en vol qui s'accumulent (RSS qui
// monte sans redescendre). Ce compteur d'echecs reseau CONSECUTIFs est
// cluster-wide via Redis ; au seuil il arme le cooldown 'neterr'.
const DARKINO_NETERR_THRESHOLD = 20;            // echecs reseau consecutifs avant pause
const DARKINO_NETERR_WINDOW_MS = 2 * 60 * 1000; // fenetre glissante du compteur
const DARKINO_NETERR_COUNTER_KEY = 'darkino:netfail:count';

/**
 * Returns remaining cooldown in ms (0 if not active or Redis unavailable).
 * Fail-open: a Redis outage must not block Darkino traffic.
 */
async function getDarkinoCooldownRemainingMs(kind) {
  const key = DARKINO_COOLDOWN_KEYS[kind];
  if (!key) return 0;
  try {
    const pttl = await redis.pttl(key);
    return pttl > 0 ? pttl : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Arms a Darkino cooldown. NX so concurrent 5xx responses across workers
 * don't keep extending the window \u2014 first arm wins, rest are no-ops.
 * Returns true if this caller actually set the key.
 */
async function armDarkinoCooldown(kind) {
  const key = DARKINO_COOLDOWN_KEYS[kind];
  const ttlMs = DARKINO_COOLDOWN_TTL_MS[kind];
  if (!key || !ttlMs) return false;
  try {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    const armed = await redis.set(key, String(Date.now()), 'EX', ttlSec, 'NX');
    return armed === 'OK';
  } catch (_) {
    return false;
  }
}

/**
 * Compte un echec reseau Darkino (timeout / erreur de connexion sans reponse
 * HTTP). Cluster-wide via Redis INCR + fenetre glissante atomique. Au seuil,
 * arme le cooldown 'neterr' et remet le compteur a zero. Fail-open : une
 * panne Redis ne compte rien et ne bloque jamais le trafic.
 * @returns {Promise<number>} compteur courant (0 si Redis indisponible)
 */
async function recordDarkinoNetFailure() {
  try {
    const execResult = await redis.multi()
      .incr(DARKINO_NETERR_COUNTER_KEY)
      .pexpire(DARKINO_NETERR_COUNTER_KEY, DARKINO_NETERR_WINDOW_MS)
      .exec();
    const count = Number(execResult?.[0]?.[1]) || 0;
    if (count >= DARKINO_NETERR_THRESHOLD) {
      const armed = await armDarkinoCooldown('neterr');
      await redis.del(DARKINO_NETERR_COUNTER_KEY);
      if (armed) {
        console.log(`[DARKINO] ${count} echecs reseau consecutifs - cooldown ${Math.round(DARKINO_NETERR_COOLDOWN_MS / 60000)} min active`);
      }
    }
    return count;
  } catch (_) {
    return 0;
  }
}

/**
 * Reinitialise le compteur d'echecs reseau Darkino apres une requete reussie
 * (le seuil compte des echecs *consecutifs*). Fail-open.
 */
async function resetDarkinoNetFailures() {
  try {
    await redis.del(DARKINO_NETERR_COUNTER_KEY);
  } catch (_) {
    /* ignore */
  }
}

// === CPASMAL CONFIGURATION ===
const CPASMAL_BASE_URL = "https://www.cpasmal.rip";

const cpasmalJar = new tough.CookieJar(null, { rejectPublicSuffixes: false });

// Cache pour les agents SOCKS5 Cpasmal (Keep-Alive)
const cpasmalAgentCache = new LruMap({
  max: PROXY_AGENT_CACHE_MAX,
  onEvict: destroyHttpAgentLike,
});

function getCpasmalAgent(proxy) {
  if (!proxy) return null;
  const cacheKey = `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.auth}`;

  if (cpasmalAgentCache.has(cacheKey)) {
    return cpasmalAgentCache.get(cacheKey);
  }

  // Configuration Keep-Alive optimis\u00e9e
  const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 15000, // 15s keep-alive
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000,
  };

  let agent;
  if (proxy.type === "socks5" || proxy.type === "socks5h") {
    const info = {
      hostname: proxy.host,
      port: proxy.port,
      protocol: "socks:",
      tls: { rejectUnauthorized: false },
      ...agentOpts,
    };

    // Auth handling
    if (proxy.auth) {
      const parts = proxy.auth.split(":");
      info.username = parts[0]; // Correction: userId -> username
      info.password = parts[1];
    }

    agent = new SocksProxyAgent(info);
  }

  if (agent) {
    cpasmalAgentCache.set(cacheKey, agent);
  }
  return agent;
}

// Fonction pour faire des requ\u00eates vers Cpasmal avec rotation de proxies SOCKS5
async function axiosCpasmalRequest(config) {
  const urlStr = config.url || "";

  // Constante pour Cpasmal Base URL si relative
  const baseURL = CPASMAL_BASE_URL;

  // Headers par d\u00e9faut
  const defaultHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    ...(config.headers || {}),
  };

  // Gestion des cookies (r\u00e9cup\u00e9ration manuelle pour compatibilit\u00e9 avec proxy agent)
  if (urlStr || config.baseURL) {
    try {
      // Reconstitution approximative de l'URL pour les cookies
      const targetUrl = urlStr.startsWith("http")
        ? urlStr
        : (config.baseURL || baseURL) + urlStr;
      const cookieString = await cpasmalJar.getCookieString(targetUrl);
      if (cookieString) {
        defaultHeaders["Cookie"] = cookieString;
      }
    } catch (err) {
      console.error("[Cpasmal CookieJar] Error getting cookies:", err);
    }
  }

  // Déterminer les agents proxy à utiliser :
  // 1. _cpasmalAgents fournis (session scopée avec DARKINO_PROXIES HTTP)
  // 2. _cpasmalProxy fourni (SOCKS5 override)
  // 3. Sinon : proxy SOCKS5 aléatoire (legacy)
  let httpAgent, httpsAgent, proxyLabel;

  if (config._cpasmalAgents) {
    httpAgent = config._cpasmalAgents.httpAgent;
    httpsAgent = config._cpasmalAgents.httpsAgent;
    proxyLabel = config._cpasmalAgents._label || "HTTP proxy";
  } else {
    const proxy =
      config._cpasmalProxy !== undefined
        ? config._cpasmalProxy
        : pickRandomProxyOrNone();
    const agent = getCpasmalAgent(proxy);
    httpAgent = agent;
    httpsAgent = agent;
    proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : "Direct";
  }

  // Nettoyer les champs internes avant de passer à axios
  const { _cpasmalProxy, _cpasmalAgents, ...cleanConfig } = config;

  try {
    if (process.env.DEBUG_CPASMAL === "true")
      console.time(`[Cpasmal] Request ${urlStr} (Proxy: ${proxyLabel})`);

    const response = await axios({
      ...cleanConfig,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      proxy: false,
      timeout: config.timeout || 5000,
      decompress: true,
    });

    if (process.env.DEBUG_CPASMAL === "true")
      console.timeEnd(`[Cpasmal] Request ${urlStr} (Proxy: ${proxyLabel})`);

    // Gestion des cookies (sauvegarde manuelle)
    if (response.headers["set-cookie"]) {
      const cookies = response.headers["set-cookie"];
      const url = response.config.url;
      try {
        if (Array.isArray(cookies)) {
          for (const cookie of cookies) {
            await cpasmalJar.setCookie(cookie, url);
          }
        } else {
          await cpasmalJar.setCookie(cookies, url);
        }
      } catch (err) {
        console.error("[Cpasmal CookieJar] Error setting cookies:", err);
      }
    }

    return response;
  } catch (error) {
    // Ajouter infos debug
    error.cpasmalUrl = urlStr;
    error.cpasmalProxy = proxyLabel;

    // Propager l'erreur immédiatement
    throw error;
  }
}

// === CLOUDFLARE WORKERS PROXIES CONFIGURATION ===
const CLOUDFLARE_WORKERS_PROXIES = (
  process.env.CLOUDFLARE_WORKERS_PROXIES || ""
)
  .split(",")
  .map((proxy) => proxy.trim())
  .filter(Boolean);

// === CACHE POUR LES PROXIES CLOUDFLARE EN ERREUR ===
// Cache pour m\u00e9moriser les proxies en erreur (429, 500, timeout, etc.)
// Les proxies en erreur seront ignor\u00e9s pendant PROXY_ERROR_COOLDOWN_MS millisecondes
const proxyErrorCache = new Map(); // Map<proxyUrl, { errorTime: timestamp, errorCode: number|string, errorCount: number }>
const PROXY_ERROR_COOLDOWN_MS = 60000; // 60 secondes de cooldown pour un proxy en erreur
const PROXY_ERROR_COOLDOWN_429_MS = 120000; // 2 minutes de cooldown sp\u00e9cifique pour erreur 429 (rate limit)
const PROXY_ERROR_COOLDOWN_5XX_MS = 90000; // 1.5 minutes pour les erreurs serveur (500, 502, 503, 504)
const MAX_CONSECUTIVE_ERRORS = 3; // Nombre max d'erreurs cons\u00e9cutives avant cooldown prolong\u00e9
const PROXY_EXTENDED_COOLDOWN_MS = 300000; // 5 minutes de cooldown prolong\u00e9 si trop d'erreurs cons\u00e9cutives

/**
 * Marque un proxy comme \u00e9tant en erreur
 * @param {string} proxyUrl - URL du proxy
 * @param {number|string} errorCode - Code d'erreur (429, 500, 'timeout', etc.)
 */
function markProxyAsErrored(proxyUrl, errorCode) {
  const existing = proxyErrorCache.get(proxyUrl);
  const errorCount = existing ? existing.errorCount + 1 : 1;

  proxyErrorCache.set(proxyUrl, {
    errorTime: Date.now(),
    errorCode,
    errorCount,
  });

  // Log seulement si DEBUG activ\u00e9
  if (process.env.DEBUG_PROXY) {
    console.log(
      `[PROXY CACHE] Proxy marqu\u00e9 en erreur: ${proxyUrl} (code: ${errorCode}, count: ${errorCount})`,
    );
  }
}

/**
 * V\u00e9rifie si un proxy est actuellement en cooldown (\u00e0 \u00e9viter)
 * @param {string} proxyUrl - URL du proxy
 * @returns {boolean} - true si le proxy doit \u00eatre ignor\u00e9
 */
function isProxyInCooldown(proxyUrl) {
  const errorInfo = proxyErrorCache.get(proxyUrl);
  if (!errorInfo) return false;

  const now = Date.now();
  const timeSinceError = now - errorInfo.errorTime;

  // D\u00e9terminer le cooldown appropri\u00e9 selon le type d'erreur et le nombre d'erreurs
  let cooldownMs;
  if (errorInfo.errorCount >= MAX_CONSECUTIVE_ERRORS) {
    cooldownMs = PROXY_EXTENDED_COOLDOWN_MS;
  } else if (errorInfo.errorCode === 429) {
    cooldownMs = PROXY_ERROR_COOLDOWN_429_MS;
  } else if (errorInfo.errorCode >= 500 && errorInfo.errorCode < 600) {
    cooldownMs = PROXY_ERROR_COOLDOWN_5XX_MS;
  } else {
    cooldownMs = PROXY_ERROR_COOLDOWN_MS;
  }

  // Si le cooldown est pass\u00e9, supprimer l'entr\u00e9e du cache
  if (timeSinceError >= cooldownMs) {
    proxyErrorCache.delete(proxyUrl);
    return false;
  }

  return true;
}

/**
 * Retourne la liste des proxies disponibles (non en cooldown)
 * @param {string[]} allProxies - Liste de tous les proxies
 * @returns {string[]} - Liste des proxies disponibles
 */
function getAvailableProxies(allProxies) {
  const available = allProxies.filter((proxy) => !isProxyInCooldown(proxy));

  // Si tous les proxies sont en cooldown, on r\u00e9initialise le cache et on retourne tous les proxies
  // pour \u00e9viter de bloquer compl\u00e8tement le service
  if (available.length === 0) {
    if (process.env.DEBUG_PROXY) {
      console.log(
        "[PROXY CACHE] Tous les proxies sont en cooldown, r\u00e9initialisation du cache",
      );
    }
    proxyErrorCache.clear();
    return allProxies;
  }

  return available;
}

/**
 * R\u00e9initialise le compteur d'erreurs d'un proxy apr\u00e8s un succ\u00e8s
 * @param {string} proxyUrl - URL du proxy
 */
function markProxyAsHealthy(proxyUrl) {
  proxyErrorCache.delete(proxyUrl);
}

// Nettoyage p\u00e9riodique du proxyErrorCache — supprime les entr\u00e9es dont le cooldown a expir\u00e9
setInterval(
  () => {
    const now = Date.now();
    for (const [proxyUrl, errorInfo] of proxyErrorCache) {
      const maxCooldown = PROXY_EXTENDED_COOLDOWN_MS; // 5 min = cooldown le plus long
      if (now - errorInfo.errorTime > maxCooldown) {
        proxyErrorCache.delete(proxyUrl);
      }
    }
  },
  5 * 60 * 1000,
).unref(); // Toutes les 5 minutes — unref to not prevent process exit

/**
 * Construit l'URL proxy en fonction du type de proxy
 * Les proxies se terminant par '/' attendent l'URL encod\u00e9e
 * Les proxies se terminant par '?' attendent l'URL non-encod\u00e9e
 * @param {string} proxyUrl - URL du proxy Cloudflare
 * @param {string} targetUrl - URL cible \u00e0 proxyer
 * @returns {string} - URL finale \u00e0 appeler
 */
function buildProxiedUrl(proxyUrl, targetUrl) {
  if (proxyUrl.endsWith("/")) {
    // Proxy qui attend l'URL encod\u00e9e (ex: cors-worker-1)
    return proxyUrl + encodeURIComponent(targetUrl);
  } else {
    // Proxy qui attend l'URL en query string (ex: ?url=...)
    return proxyUrl + targetUrl;
  }
}

// Fonction pour faire une requ\u00eate avec fallback CORS en cas d'erreur 429
async function makeRequestWithCorsFallback(targetUrl, options = {}) {
  const {
    timeout = 7000,
    headers = {},
    decompress = true,
    method: requestMethod,
    data: requestData,
    ...otherOptions
  } = options;

  const method = (requestMethod || 'GET').toUpperCase();
  const defaultHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  if (availableProxies.length === 0) {
    return axios({
      url: targetUrl,
      method,
      headers: defaultHeaders,
      timeout,
      decompress,
      ...(requestData !== undefined ? { data: requestData } : {}),
      ...otherOptions,
    });
  }

  // Utiliser directement les proxies Cloudflare Workers disponibles
  let lastError = null;

  for (let i = 0; i < availableProxies.length; i++) {
    const currentProxy = availableProxies[i];
    try {
      const finalProxyUrl = buildProxiedUrl(currentProxy, targetUrl);

      const response = await axios({
        url: finalProxyUrl,
        method,
        headers: defaultHeaders,
        timeout,
        decompress,
        ...(requestData !== undefined ? { data: requestData } : {}),
        ...otherOptions,
      });

      // Succ\u00e8s : marquer le proxy comme sain
      markProxyAsHealthy(currentProxy);
      return response;
    } catch (proxyError) {
      lastError = proxyError;
      const statusCode = proxyError.response?.status;
      const errorCode = statusCode || proxyError.code || "unknown";

      // En cas d'erreur 400 ou 403, arr\u00eat imm\u00e9diat sans r\u00e9essayer avec d'autres proxies
      if (statusCode === 400 || statusCode === 403) {
        throw proxyError;
      }

      // Marquer le proxy en erreur pour les codes 429, 5xx, timeout, etc.
      if (
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        proxyError.code === "ECONNABORTED" ||
        proxyError.code === "ETIMEDOUT"
      ) {
        markProxyAsErrored(currentProxy, errorCode);
      }

      // Si c'est le dernier proxy et qu'on a une erreur, throw l'erreur
      if (i === availableProxies.length - 1) {
        throw proxyError;
      }
      // Sinon continuer avec le prochain proxy (429, etc.)
    }
  }

  // Si on arrive ici, tous les proxies ont \u00e9chou\u00e9
  throw lastError || new Error("Tous les proxies ont \u00e9chou\u00e9");
}

// Fonction pour faire une requ\u00eate Coflix avec rotation Cloudflare Workers.
// Classe un 429 recu via les Cloudflare Workers Coflix.
//  - 'worker' : preuve POSITIVE d'un blocage Cloudflare du worker lui-meme
//    (page "error code: 1015"/1027, "You are being rate limited", limite
//    journaliere). Roter vers un autre worker (bucket de limite distinct) aide.
//  - 'site'   : tout le reste -> 429 forwarde depuis le site Coflix (rate-limit
//    global). Defaut volontaire : sans preuve d'un 1015, on ne rote pas et on
//    ne martele pas l'upstream.
function classifyCloudflare429(body) {
  const text = typeof body === "string" ? body : String(body || "");
  return /error\s*code:?\s*(1015|1027|1029)|you are being rate limited|daily request limit/i.test(
    text,
  )
    ? "worker"
    : "site";
}

// Coflix (recherche + pages film/serie) via proxies ProxyScrape (HTTP prefere,
// SOCKS5 fallback) au lieu des Cloudflare Workers. Sur 429/403/5xx/erreur reseau
// on rote vers l'IP suivante (2 max). Si tout est 429, le flag coflixSiteRateLimited
// coupe le spam de log par titre cote route (coflix.js).
async function makeCoflixRequest(targetUrl, options = {}) {
  const {
    timeout = 15000,
    headers = {},
    decompress = true,
    ...otherOptions
  } = options;

  // Nettoyer l'URL pour \u00e9viter les espaces ind\u00e9sirables
  const cleanTargetUrl = targetUrl.trim();

  // Headers pour les requ\u00eates Coflix via proxy
  const coflixProxyHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // Supprimer les headers li\u00e9s \u00e0 l'IP d'origine pour \u00e9viter de les transmettre
  const headersToRemove = [
    "X-Forwarded-For",
    "X-Real-IP",
    "X-Client-IP",
    "CF-Connecting-IP",
    "True-Client-IP",
    "X-Original-Forwarded-For",
  ];
  const cleanHeaders = { ...coflixProxyHeaders };
  headersToRemove.forEach((header) => {
    delete cleanHeaders[header];
    delete cleanHeaders[header.toLowerCase()];
  });

  const { proxies, useSocks } = pickProxyscrapeCandidates();
  let lastError = null;

  // Aucun proxy ProxyScrape dispo -> tentative directe.
  if (!proxies || proxies.length === 0) {
    return axios({
      url: cleanTargetUrl,
      method: otherOptions.method || "GET",
      headers: cleanHeaders,
      timeout,
      decompress,
      responseType: "text",
      responseEncoding: "utf8",
      ...otherOptions,
    });
  }

  // Rotation sur 2 proxies ProxyScrape max (egress different = bucket 429 distinct).
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    // ponytail: agent non cache (<=2/req, keepAlive off -> pas de fuite socket).
    const agent = useSocks
      ? getProxyAgent(proxy)
      : new HttpsProxyAgent(`http://${auth}${proxy.host}:${proxy.port}`);

    try {
      const response = await axios({
        url: cleanTargetUrl,
        method: otherOptions.method || "GET",
        headers: cleanHeaders,
        timeout,
        decompress,
        responseType: "text",
        responseEncoding: "utf8",
        httpAgent: agent,
        httpsAgent: agent,
        ...otherOptions,
      });

      return response;
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;
      const errorCode = error.code || "unknown";

      error.coflixUrl = cleanTargetUrl;
      error.coflixProxy = `${proxy.host}:${proxy.port}`;

      // 429 = rate-limit du site Coflix. Une autre IP ProxyScrape = bucket distinct
      // -> on rote. Le flag coupe le spam de log par titre si tout est limite.
      if (statusCode === 429) {
        error.coflixSiteRateLimited = true;
        continue;
      }

      // 403 (Cloudflare), 5xx, ou erreur reseau -> proxy suivant.
      if (
        statusCode === 403 ||
        (statusCode >= 500 && statusCode < 600) ||
        errorCode === "ECONNABORTED" ||
        errorCode === "ETIMEDOUT" ||
        errorCode === "ECONNRESET" ||
        errorCode === "EHOSTUNREACH" ||
        errorCode === "ENETUNREACH"
      ) {
        continue;
      }

      // Pour les erreurs fonctionnelles (400, 404, parsing, etc.), arr\u00eater imm\u00e9diatement.
      throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error("Tous les proxies ProxyScrape ont echoue (Coflix)");
}

// Fonction pour faire une requete LecteurVideo avec CycleTLS.
// On limite volontairement la rotation a 2 proxies max pour eviter de balayer tout le pool.
// Instance CycleTLS partagee (singleton)
let cycleTLSInstance = null;
let cycleTLSInitializing = false;
const cycleTLSWaiters = [];

function cycleTlsInitOptions(workerId = cluster.worker?.id ?? 0) {
  const normalizedWorkerId = Number.isSafeInteger(workerId) && workerId >= 0 ? workerId : 0;
  const port = 9119 + normalizedWorkerId;
  if (port > 65535) throw new RangeError("identifiant worker CycleTLS invalide");
  return { port };
}

async function getCycleTLS() {
  if (cycleTLSInstance) return cycleTLSInstance;
  if (cycleTLSInitializing) {
    return new Promise((resolve) => cycleTLSWaiters.push(resolve));
  }
  cycleTLSInitializing = true;
  try {
    cycleTLSInstance = await initCycleTLS(cycleTlsInitOptions());
    cycleTLSInitializing = false;
    for (const waiter of cycleTLSWaiters) waiter(cycleTLSInstance);
    cycleTLSWaiters.length = 0;
    return cycleTLSInstance;
  } catch (err) {
    cycleTLSInitializing = false;
    // Reject all waiters so they don't leak forever
    for (const waiter of cycleTLSWaiters) waiter(Promise.reject(err));
    cycleTLSWaiters.length = 0;
    throw err;
  }
}

// Graceful shutdown: kill CycleTLS Go subprocess
async function shutdownCycleTLS() {
  if (cycleTLSInstance) {
    try {
      await cycleTLSInstance.exit();
    } catch {
      /* ignore */
    }
    cycleTLSInstance = null;
  }
}

// JA3 fingerprint Chrome 120+
const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function pickProxyscrapeCandidates() {
  const httpPool =
    HTTP_PROXIES.length > 0
      ? HTTP_PROXIES
      : parseProxyPayload(process.env.HTTP_PROXIES, "http")
          .map((entry) => sanitizeProxyEntry(entry, "http"))
          .filter(Boolean);

  const socksPool =
    PROXIES.length > 0
      ? PROXIES
      : parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
          .map((entry) => sanitizeProxyEntry(entry, "socks5"))
          .filter(Boolean);

  const preferredPool =
    httpPool.length > 0
      ? { proxies: httpPool, useSocks: false, label: "HTTP_PROXIES" }
      : { proxies: socksPool, useSocks: true, label: "SOCKS5_PROXIES" };

  if (!preferredPool.proxies || preferredPool.proxies.length === 0) {
    return {
      proxies: [],
      useSocks: false,
      label: "aucun",
      totalAvailable: 0,
    };
  }

  const selectedProxies = [...preferredPool.proxies]
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_PROXYSCRAPE_PROXY_ATTEMPTS);

  return {
    proxies: selectedProxies,
    useSocks: preferredPool.useSocks,
    label: preferredPool.label,
    totalAvailable: preferredPool.proxies.length,
  };
}

async function makeLecteurVideoRequest(targetUrl, options = {}) {
  const { headers = {} } = options;
  const cleanTargetUrl = targetUrl.trim();

  const {
    proxies,
    useSocks,
    label: proxyPoolLabel,
    totalAvailable,
  } = pickProxyscrapeCandidates();

  if (!proxies || proxies.length === 0) {
    const cycleTLS = await getCycleTLS();
    const response = await cycleTLS(
      cleanTargetUrl,
      {
        body: "",
        ja3: CHROME_JA3,
        userAgent: CHROME_UA,
        headers: {
          Referer: `${COFLIX_ORIGIN}/`,
          Origin: COFLIX_ORIGIN,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9",
          ...headers,
        },
        timeout: 15,
      },
      "get",
    );

    const body =
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);
    return {
      data: body,
      status: response.status,
      headers: response.headers || {},
    };
  }

  const cycleTLS = await getCycleTLS();
  let lastError = null;

  console.log(
    `[LECTEURVIDEO] ${proxies.length} proxy(s) retenu(s) sur ${totalAvailable} depuis ${proxyPoolLabel}`,
  );

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = useSocks
      ? `socks5h://${auth}${proxy.host}:${proxy.port}`
      : `http://${auth}${proxy.host}:${proxy.port}`;

    console.log(
      `[LECTEURVIDEO] tentative ${i + 1}/${proxies.length} via cycletls + ${proxy.host}:${proxy.port} (${proxyPoolLabel})`,
    );

    try {
      const response = await cycleTLS(
        cleanTargetUrl,
        {
          body: "",
          ja3: CHROME_JA3,
          userAgent: CHROME_UA,
          proxy: proxyUrl,
          headers: {
            Referer: `${COFLIX_ORIGIN}/`,
            Origin: COFLIX_ORIGIN,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9",
            ...headers,
          },
          timeout: 15,
        },
        "get",
      );

      const body =
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
      const title = body.match(/<title>(.*?)<\/title>/i)?.[1] || "no title";
      console.log(
        `[LECTEURVIDEO] ${proxy.host}:${proxy.port} -> ${response.status} | title: ${title} | ${body.length} chars`,
      );

      if (
        response.status === 403 &&
        (body.includes("cf-wrapper") || body.includes("cloudflare"))
      ) {
        console.warn(
          `[LECTEURVIDEO] proxy ${i + 1}/${proxies.length} (${proxy.host}) bloque par Cloudflare, retry...`,
        );
        continue;
      }

      return {
        data: body,
        status: response.status,
        headers: response.headers || {},
      };
    } catch (error) {
      console.error(
        `[LECTEURVIDEO] proxy ${i + 1}/${proxies.length} (${proxy.host}) echoue: ${error.message?.substring(0, 100)}`,
      );
      lastError = error;
      continue;
    }
  }

  console.error(
    `[LECTEURVIDEO] tous les proxies ont echoue pour ${cleanTargetUrl}`,
  );
  throw lastError || new Error("[LECTEURVIDEO] Tous les proxies ont echoue");
}

// CineStream (Cloudflare-fronted Next.js) via CycleTLS + ProxyScrape rotation,
// like LecteurVideo/AnimeSama. Plain axios + CF Workers gets hammered with 525
// (CF edge SSL errors under volume from one IP); a real Chrome JA3 over rotating
// low-volume proxy IPs survives. Returns an axios-like {data,status,headers}
// EVEN on 5xx/525 (never throws on HTTP status) so a flaky upstream degrades to
// "film not found" instead of a thrown error — the caller's regex just finds no
// tmdbid. Rotates proxies on 5xx/525/cf-block; returns 4xx immediately (a 400 on
// an exotic-script title is deterministic, not worth burning another proxy).
async function makeCinestreamRequest(targetUrl, options = {}) {
  const { headers = {}, timeout = 15 } = options;
  const cleanTargetUrl = targetUrl.trim();

  const cycleHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    Referer: "https://cinestream.info/",
    ...headers,
  };

  const isCfBlock = (status, body) =>
    status === 403 &&
    typeof body === "string" &&
    (body.includes("cf-wrapper") || body.includes("cloudflare"));
  // 5xx (incl. Cloudflare 520-527 origin/SSL errors) + cf-block -> rotate proxy.
  const shouldRotate = (status, body) =>
    (status >= 500 && status < 600) || isCfBlock(status, body);

  const cycleTLS = await getCycleTLS();
  const asAxiosLike = (resp) => ({
    data: typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body),
    status: resp.status,
    headers: resp.headers || {},
  });

  const { proxies, useSocks } = pickProxyscrapeCandidates();

  // No proxy pool -> single direct CycleTLS attempt.
  if (!proxies || proxies.length === 0) {
    const resp = await cycleTLS(
      cleanTargetUrl,
      { body: "", ja3: CHROME_JA3, userAgent: CHROME_UA, headers: cycleHeaders, timeout },
      "get",
    );
    return asAxiosLike(resp);
  }

  let lastResult = null;
  let lastError = null;

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = useSocks
      ? `socks5h://${auth}${proxy.host}:${proxy.port}`
      : `http://${auth}${proxy.host}:${proxy.port}`;

    try {
      const resp = await cycleTLS(
        cleanTargetUrl,
        { body: "", ja3: CHROME_JA3, userAgent: CHROME_UA, proxy: proxyUrl, headers: cycleHeaders, timeout },
        "get",
      );
      const result = asAxiosLike(resp);
      if (shouldRotate(result.status, result.data)) {
        lastResult = result;
        continue;
      }
      return result; // 2xx success, or a definitive 4xx
    } catch (err) {
      lastError = err;
    }
  }

  // All proxies 5xx/cf-block or errored: hand back the last response so the
  // caller parses (and quietly finds nothing) instead of throwing.
  if (lastResult) return lastResult;
  throw lastError || new Error("[CINESTREAM] Tous les proxies ont echoue");
}

// 1jour1film (Dooplay theme, Cloudflare-fronted) via CycleTLS + ProxyScrape
// rotation — same mechanism as makeCinestreamRequest, but:
//   - supports POST (the Dooplay `doo_player_ajax` admin-ajax call), and
//   - takes a caller-supplied Referer/Origin in `headers` (the domain rotates,
//     so there's no hardcoded referer here).
// Returns an axios-like {data,status,headers} and never throws on HTTP status;
// rotates proxies on 5xx / Cloudflare-block, returns 4xx as-is. A degraded
// response just yields HTML the caller's parser finds nothing in -> "not found".
// NOTE: the residential proxy pool is what gets the *full* page payload (player
// option labels, j1fEpsData, search nonce); datacenter IPs get a stripped
// variant. timeout is in SECONDS (CycleTLS), like the sibling helpers.
// Cloudflare Worker relays (CLOUDFLARE_WORKERS_PROXIES, see cloudflareproxy/
// worker.js) are tried FIRST: the 1J1F zone blocks the whole proxy pool — managed
// challenge on one range, packets silently dropped on the other — while a Worker
// reaches it in ~250ms AND gets the full page payload (J1F_SRV present).
// Relays are rotated on 429 (Workers quota / rate limit) and on 403 (the origin's
// 1020 Access Denied fired at the Worker egress), reusing the shared cooldown
// cache so a burnt relay is skipped for the next couple of minutes.
// Two relay quirks drive j1fRelayUrl():
//   - '?'-style relays (cloudflare-cors-anywhere) double-decode their query, so
//     the target is double-encoded; a raw append silently truncates any target
//     carrying an `&` (e.g. the REST search's &per_page=).
//   - they strip Origin/Referer/cf-*/x-forw* from the forwarded request, so
//     caller headers ride along in `x-cors-headers`, which the relay merges back
//     in after filtering.
const j1fRelayUrl = (relay, targetUrl) => {
  if (relay.endsWith("/")) return relay + encodeURIComponent(targetUrl); // '/'-style: single encode
  const sep = /[?&]$/.test(relay) ? "" : "?";
  return `${relay}${sep}${encodeURIComponent(encodeURIComponent(targetUrl))}`;
};

// Relay cooldown, deliberately NOT the shared proxyErrorCache: a relay burnt on
// the 1J1F zone usually still works for every other source, and marking it in the
// shared cache would sideline it for all of them. Keyed by relay URL -> expiry.
const j1fRelayCooldown = new Map();
const J1F_RELAY_COOLDOWN_MS = 60 * 1000;
const J1F_RELAY_COOLDOWN_429_MS = 2 * 60 * 1000; // Workers quota / rate limit
function j1fAvailableRelays() {
  const now = Date.now();
  const usable = CLOUDFLARE_WORKERS_PROXIES.filter(
    (r) => (j1fRelayCooldown.get(r) || 0) <= now,
  );
  // All burnt -> wipe and retry everything rather than stop serving entirely.
  if (usable.length === 0) {
    j1fRelayCooldown.clear();
    return CLOUDFLARE_WORKERS_PROXIES;
  }
  return usable;
}
const j1fBenchRelay = (relay, status) =>
  j1fRelayCooldown.set(
    relay,
    Date.now() + (status === 429 ? J1F_RELAY_COOLDOWN_429_MS : J1F_RELAY_COOLDOWN_MS),
  );

async function make1j1fRequest(targetUrl, options = {}) {
  const { headers = {}, timeout = 15, method = "get", body = "" } = options;
  const cleanTargetUrl = targetUrl.trim();
  const lowerMethod = String(method).toLowerCase();

  const cycleHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    ...headers,
  };

  const isCfBlock = (status, b) =>
    (status === 403 || status === 503) &&
    typeof b === "string" &&
    (b.includes("cf-wrapper") ||
      b.includes("Just a moment") ||
      b.includes("cloudflare"));
  // 408/0 : CycleTLS ne throw PAS sur ses propres timeouts — il résout avec un
  // statut synthétique 408 (ou 0) et un corps d'erreur Go. Sans rotation ici, un
  // relais/proxy qui timeout renvoyait ce déchet comme un « succès » et la chaîne
  // s'arrêtait au lieu d'essayer l'egress suivant.
  const shouldRotate = (status, b) =>
    status === 408 || status === 0 || (status >= 500 && status < 600) || isCfBlock(status, b);

  // Piste des échecs par egress, loggée UNIQUEMENT quand tout a échoué — sinon
  // une panne se manifeste comme un unique `via=direct` sans rien dire des
  // relais/proxies tentés avant.
  const trail = [];

  const cycleTLS = await getCycleTLS();
  // `via` tags which egress produced the response — callers log it, so a failure
  // says *where* it failed without having to re-run anything.
  const asAxiosLike = (resp, via) => ({
    data: typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body),
    status: resp.status,
    headers: resp.headers || {},
    via,
  });

  const doRequest = (proxyUrl) =>
    cycleTLS(
      cleanTargetUrl,
      {
        body,
        ja3: CHROME_JA3,
        userAgent: CHROME_UA,
        headers: cycleHeaders,
        timeout,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      },
      lowerMethod,
    );

  let lastResult = null;
  let lastError = null;

  // 1) Cloudflare Worker relays, rotated on 429/403/5xx/timeout/challenge.
  const relayFailed = (status, b) =>
    status === 429 || status === 403 || shouldRotate(status, b);
  const relays = j1fAvailableRelays();
  if (relays.length === 0) trail.push("relais=aucun (CLOUDFLARE_WORKERS_PROXIES vide)");
  for (const relay of relays) {
    const relayTag = relay.replace(/^https?:\/\//, "").slice(0, 40);
    try {
      const viaRelay = asAxiosLike(
        await cycleTLS(
          j1fRelayUrl(relay, cleanTargetUrl),
          {
            body,
            ja3: CHROME_JA3,
            userAgent: CHROME_UA,
            headers: Object.keys(headers).length
              ? { ...cycleHeaders, "x-cors-headers": JSON.stringify(headers) }
              : cycleHeaders,
            timeout,
          },
          lowerMethod,
        ),
        `relay:${relay}`,
      );
      if (relayFailed(viaRelay.status, viaRelay.data)) {
        j1fBenchRelay(relay, viaRelay.status);
        trail.push(`relay:${relayTag}=${viaRelay.status}`);
        lastResult = viaRelay;
        continue;
      }
      j1fRelayCooldown.delete(relay);
      return viaRelay;
    } catch (err) {
      j1fBenchRelay(relay, "timeout");
      trail.push(`relay:${relayTag}=${err.code || err.message || "erreur"}`);
      lastError = err;
    }
  }

  // 2) Proxy pool.
  const { proxies, useSocks } = pickProxyscrapeCandidates();
  if (!proxies || proxies.length === 0) trail.push("proxies=aucun");
  for (let i = 0; i < (proxies || []).length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = useSocks
      ? `socks5h://${auth}${proxy.host}:${proxy.port}`
      : `http://${auth}${proxy.host}:${proxy.port}`;
    try {
      const result = asAxiosLike(
        await doRequest(proxyUrl),
        `proxy:${proxy.host}:${proxy.port}`,
      );
      if (shouldRotate(result.status, result.data)) {
        trail.push(`proxy:${proxy.host}=${result.status}`);
        lastResult = result;
        continue;
      }
      return result; // 2xx success, or a definitive 4xx
    } catch (err) {
      trail.push(`proxy:${proxy.host}=${err.code || err.message || "erreur"}`);
      lastError = err;
    }
  }

  // 3) Direct, last resort — the only egress left when both relays and proxies
  // are blocked. Reaches 1J1F from a residential host; from a datacenter IP it
  // just fails like the rest, which costs one request on an already-lost path.
  try {
    const direct = asAxiosLike(await doRequest(null), "direct");
    if (!shouldRotate(direct.status, direct.data)) return direct;
    trail.push(`direct=${direct.status}`);
    lastResult = direct;
  } catch (err) {
    trail.push(`direct=${err.code || err.message || "erreur"}`);
    lastError = err;
  }

  // Tout a échoué : une seule ligne qui nomme chaque egress tenté et son verdict.
  console.warn(
    `[1J1F EGRESS] ${cleanTargetUrl.slice(0, 120)} -> ${trail.join(" | ").slice(0, 600)}`,
  );
  if (lastResult) return lastResult;
  throw lastError || new Error("[1J1F] Tous les relais et proxies ont echoue");
}

// Cpasmal (DLE, Cloudflare-fronted) via CycleTLS + ProxyScrape rotation.
// Same mechanism as make1j1fRequest: a real Chrome JA3 over rotating low-volume
// IPs beats the Cloudflare bot-challenge that plain axios + datacenter proxies
// hit (every GET/POST 403'd). Supports POST (DLE search form) and GET (detail /
// getxfield / Season.php pages). Caller supplies Referer/Origin/Content-Type in
// `headers`. timeout is in SECONDS (CycleTLS). Returns axios-like {data,status,headers}.
async function makeCpasmalRequest(targetUrl, options = {}) {
  const { headers = {}, timeout = 15, method = "get", body = "" } = options;
  const cleanTargetUrl = targetUrl.trim();
  const lowerMethod = String(method).toLowerCase();

  const cycleHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    ...headers,
  };

  const isCfBlock = (status, b) =>
    (status === 403 || status === 503) &&
    typeof b === "string" &&
    (b.includes("cf-wrapper") ||
      b.includes("Just a moment") ||
      b.includes("cloudflare"));
  const shouldRotate = (status, b) =>
    (status >= 500 && status < 600) || isCfBlock(status, b);

  const cycleTLS = await getCycleTLS();
  const asAxiosLike = (resp) => ({
    data: typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body),
    status: resp.status,
    headers: resp.headers || {},
  });

  const doRequest = (proxyUrl) =>
    cycleTLS(
      cleanTargetUrl,
      {
        body,
        ja3: CHROME_JA3,
        userAgent: CHROME_UA,
        headers: cycleHeaders,
        timeout,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      },
      lowerMethod,
    );

  const { proxies, useSocks } = pickProxyscrapeCandidates();

  // No proxy pool -> single direct CycleTLS attempt.
  if (!proxies || proxies.length === 0) {
    return asAxiosLike(await doRequest(null));
  }

  let lastResult = null;
  let lastError = null;
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = useSocks
      ? `socks5h://${auth}${proxy.host}:${proxy.port}`
      : `http://${auth}${proxy.host}:${proxy.port}`;
    try {
      const result = asAxiosLike(await doRequest(proxyUrl));
      if (shouldRotate(result.status, result.data)) {
        lastResult = result;
        continue;
      }
      return result; // 2xx success, or a definitive 4xx
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("[CPASMAL] Tous les proxies ont echoue");
}

// Fonction AnimeSama avec CycleTLS (cloudscraper-style : JA3 Chrome pour bypass Cloudflare).
// Utilise le SOCKS5_PROXIES env directement (proxies dedies) -- pas le pool ProxyScrape,
// pas de fallback direct sans proxy.
const MAX_ANIMESAMA_CYCLETLS_ATTEMPTS = 2;
const ANIMESAMA_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

async function makeAnimeSamaRequest(targetUrl, options = {}) {
  const {
    headers = {},
    timeout = 30,
    method = "get",
    body = "",
  } = options;
  const cleanTargetUrl = targetUrl.trim();
  const lowerMethod = String(method).toLowerCase();

  const defaultHeaders = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.6",
    ...headers,
  };

  const pool = [...ANIMESAMA_SOCKS5_PROXIES]
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_ANIMESAMA_CYCLETLS_ATTEMPTS);

  if (pool.length === 0) {
    throw new Error(
      "[ANIMESAMA CYCLETLS] aucun proxy SOCKS5 defini dans SOCKS5_PROXIES",
    );
  }

  const cycleTLS = await getCycleTLS();

  const asAxiosLike = (response) => {
    const data =
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);
    return { data, status: response.status, headers: response.headers || {} };
  };

  let lastError = null;
  let lastResult = null;

  for (let i = 0; i < pool.length; i++) {
    const proxy = pool[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = `socks5h://${auth}${proxy.host}:${proxy.port}`;

    try {
      const response = await cycleTLS(
        cleanTargetUrl,
        {
          body,
          ja3: CHROME_JA3,
          userAgent: CHROME_UA,
          proxy: proxyUrl,
          headers: defaultHeaders,
          timeout,
        },
        lowerMethod,
      );

      const result = asAxiosLike(response);
      if (shouldRotateAnimeSamaResponse(result.status, result.data)) {
        lastResult = result;
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("[ANIMESAMA CYCLETLS] tous les proxies ont echoue");
}

// === SOCKS5 PROXIES (from env) ===
const parseJsonArrayEnv = (envName, fallback = []) => {
  const rawValue = process.env[envName];
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const { acquireRedisLock } = require("./redisLock");

const PROXY_ROTATION_REDIS_PREFIX = "proxyscrape:rotation:v1";
const PROXY_RATE_LIMIT_REDIS_PREFIX = "proxyscrape:rate-limit:v1";
const KISSKH_METADATA_PROXY_OPTIONS = Object.freeze({
  poolName: "KISSKH_METADATA",
  minIntervalMs: 1000,
  digestIdentity: true,
  maxCandidates: 1000,
});
const proxyRateLimitState = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProxyRateLimitKey(poolName, proxy, digestIdentity = false) {
  if (!proxy || !proxy.host || !proxy.port) return null;
  const identity = `${String(proxy.type || "proxy").toLowerCase()}:${String(proxy.host).trim().toLowerCase()}:${Number(proxy.port)}:${proxy.auth || ""}`;
  const suffix = digestIdentity
    ? crypto.createHash("sha256").update(identity).digest("hex")
    : identity;
  return `${PROXY_RATE_LIMIT_REDIS_PREFIX}:${poolName}:${suffix}`;
}

function reserveLocalRateLimitedProxy(proxyKey, minIntervalMs) {
  if (!proxyKey) return false;

  const now = Date.now();
  const nextAllowedAt = proxyRateLimitState.get(proxyKey) || 0;
  if (nextAllowedAt > now) {
    return false;
  }

  proxyRateLimitState.set(proxyKey, now + minIntervalMs);
  return true;
}

async function reserveRateLimitedProxy(poolName, proxy, minIntervalMs, digestIdentity = false) {
  if (!proxy) return false;

  const safeIntervalMs = Math.max(0, Math.floor(Number(minIntervalMs) || 0));
  if (safeIntervalMs <= 0) {
    return true;
  }

  const proxyKey = buildProxyRateLimitKey(poolName, proxy, digestIdentity);
  if (!proxyKey) {
    return false;
  }

  try {
    const reserved = await redis.set(
      proxyKey,
      String(Date.now()),
      "PX",
      safeIntervalMs,
      "NX",
    );
    if (reserved === "OK") {
      return true;
    }
    return false;
  } catch {
    // Fallback local si Redis n'est pas disponible.
  }

  return reserveLocalRateLimitedProxy(proxyKey, safeIntervalMs);
}

setInterval(() => {
  const now = Date.now();
  for (const [proxyKey, nextAllowedAt] of proxyRateLimitState) {
    if (!Number.isFinite(nextAllowedAt) || nextAllowedAt <= now) {
      proxyRateLimitState.delete(proxyKey);
    }
  }
}, 30 * 1000).unref();

function reserveLocalProxyWindow(poolName, poolLength, batchSize) {
  const existingCursor = proxyRotationState.get(poolName);
  const startIndex = Number.isInteger(existingCursor)
    ? existingCursor % poolLength
    : Math.floor(Math.random() * poolLength);

  proxyRotationState.set(poolName, (startIndex + batchSize) % poolLength);
  return startIndex;
}

async function reserveProxyWindow(poolName, poolLength, batchSize = 1) {
  if (!Number.isFinite(poolLength) || poolLength <= 0) {
    return 0;
  }

  const safeBatchSize = Math.min(
    poolLength,
    Math.max(1, Math.floor(Number(batchSize) || 1)),
  );

  try {
    const rotationKey = `${PROXY_ROTATION_REDIS_PREFIX}:${poolName}`;
    const nextValue = await redis.incrby(rotationKey, safeBatchSize);
    const startIndex = Number(nextValue) - safeBatchSize;
    return ((startIndex % poolLength) + poolLength) % poolLength;
  } catch {
    return reserveLocalProxyWindow(poolName, poolLength, safeBatchSize);
  }
}

async function pickNextProxyBatch(pool, count = 1, poolName = "default") {
  if (!Array.isArray(pool) || pool.length === 0) {
    return [];
  }

  const safeCount = Math.min(
    pool.length,
    Math.max(1, Math.floor(Number(count) || 1)),
  );
  const startIndex = await reserveProxyWindow(poolName, pool.length, safeCount);
  const selected = [];

  for (let offset = 0; offset < safeCount; offset++) {
    selected.push(pool[(startIndex + offset) % pool.length]);
  }

  return selected;
}

async function pickNextRateLimitedProxy(pool, options = {}) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return null;
  }

  const {
    poolName = "default",
    minIntervalMs = 0,
    waitTimeoutMs = 0,
    retryDelayMs = 25,
    digestIdentity = false,
  } = options;

  const safeMinIntervalMs = Math.max(0, Math.floor(Number(minIntervalMs) || 0));
  if (safeMinIntervalMs <= 0) {
    const [proxy] = await pickNextProxyBatch(pool, 1, poolName);
    return proxy || null;
  }

  const deadline =
    Date.now() + Math.max(0, Math.floor(Number(waitTimeoutMs) || 0));

  while (true) {
    const startIndex = await reserveProxyWindow(poolName, pool.length, 1);

    for (let offset = 0; offset < pool.length; offset++) {
      const proxy = pool[(startIndex + offset) % pool.length];
      const reserved = await reserveRateLimitedProxy(
        poolName,
        proxy,
        safeMinIntervalMs,
        digestIdentity,
      );
      if (reserved) {
        return proxy;
      }
    }

    if (Date.now() >= deadline) {
      return null;
    }

    const remainingMs = deadline - Date.now();
    await sleep(Math.max(5, Math.min(retryDelayMs, remainingMs)));
  }
}

async function pickNextSocks5Proxy(options = {}) {
  const proxy = await pickNextRateLimitedProxy(PROXIES, {
    poolName: "SOCKS5_PROXIES",
    ...options,
  });
  return proxy || null;
}

async function getKisskhProxyCandidates(options = {}) {
  const requestedLimit = options.maxCandidates === undefined
    ? KISSKH_METADATA_PROXY_OPTIONS.maxCandidates
    : Number(options.maxCandidates);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new TypeError("maxCandidates KissKH invalide");
  }

  const poolSnapshot = PROXIES.slice();
  if (poolSnapshot.length === 0) return [];
  const scanLimit = Math.min(
    poolSnapshot.length,
    requestedLimit,
    KISSKH_METADATA_PROXY_OPTIONS.maxCandidates,
  );
  const startIndex = await reserveProxyWindow(
    KISSKH_METADATA_PROXY_OPTIONS.poolName,
    poolSnapshot.length,
    1,
  );
  const candidates = [];
  const seen = new Set();
  for (let offset = 0; offset < scanLimit; offset += 1) {
    const proxy = poolSnapshot[(startIndex + offset) % poolSnapshot.length];
    const identity = buildProxyRateLimitKey(
      KISSKH_METADATA_PROXY_OPTIONS.poolName,
      proxy,
      KISSKH_METADATA_PROXY_OPTIONS.digestIdentity,
    );
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(proxy);
  }
  return candidates;
}

function isKisskhProxyConfigured() {
  return KISSKH_PROXY_CONFIGURATION_PRESENT;
}

function reserveKisskhProxy(proxy, options = {}) {
  const requestedInterval = Math.floor(Number(options.minIntervalMs) || 0);
  const minIntervalMs = Math.max(
    KISSKH_METADATA_PROXY_OPTIONS.minIntervalMs,
    requestedInterval,
  );
  return reserveRateLimitedProxy(
    KISSKH_METADATA_PROXY_OPTIONS.poolName,
    proxy,
    minIntervalMs,
    KISSKH_METADATA_PROXY_OPTIONS.digestIdentity,
  );
}

async function pickNextKisskhProxy(options = {}) {
  const candidates = await getKisskhProxyCandidates(options);
  for (const proxy of candidates) {
    if (await reserveKisskhProxy(proxy, options)) return proxy;
  }
  return null;
}

async function pickDedicatedSocks5Proxy(options = {}) {
  const proxy = await pickNextRateLimitedProxy(DEDICATED_SOCKS5_PROXIES, {
    poolName: "DEDICATED_SOCKS5",
    ...options,
  });
  return proxy || null;
}

async function pickVavooSocks5Proxy() {
  return vavooProxyPolicy.pick(VAVOO_SOCKS5_PROXIES);
}

function markVavooProxyAsHealthy(proxy) {
  return vavooProxyPolicy.recordSuccess(proxy);
}

function markVavooProxyAsFailed(proxy, status) {
  return vavooProxyPolicy.recordFailure(proxy, status);
}

async function makeVavooBrowserRequest(targetUrl, payload, options = {}) {
  const headers = options.headers && typeof options.headers === "object"
    ? options.headers
    : {};
  const timeout = Math.max(1, Math.floor(Number(options.timeout) || 4));
  const userAgent = headers["User-Agent"] || headers["user-agent"] || CHROME_UA;
  const url = String(targetUrl).trim();
  const body = JSON.stringify(payload);
  const cycleTLS = await getCycleTLS();
  let lastError = null;

  // Un seul aller-retour CycleTLS : renvoie le JSON, ou lève avec le statut
  // HTTP attaché pour que la politique de santé sache doser la quarantaine.
  async function attempt(proxyUrl) {
    const response = await cycleTLS(
      url,
      {
        body,
        ja3: CHROME_JA3,
        userAgent,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
        headers,
        timeout,
      },
      "post",
    );
    const status = Number(response?.status) || 0;
    if (status < 200 || status >= 300) {
      const error = new Error(`[VAVOO CYCLETLS] status ${status || "unknown"}`);
      error.response = { status: status || undefined };
      throw error;
    }

    let data = response?.body;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    if (!data || typeof data !== "object") {
      const error = new Error("[VAVOO CYCLETLS] invalid JSON response");
      error.response = { status };
      throw error;
    }
    return data;
  }

  // Chemin nominal : direct. kool.to répond sans géoblocage, et le pool DE est
  // trop petit (2 IP) pour encaisser toutes les résolutions à lui seul.
  try {
    return await attempt(null);
  } catch (error) {
    lastError = error;
  }

  for (let i = 0; i < 15; i += 1) {
    const proxy = await pickVavooSocks5Proxy();
    if (!proxy) break;

    const auth = proxy.auth ? `${proxy.auth}@` : "";
    try {
      const data = await attempt(`socks5h://${auth}${proxy.host}:${proxy.port}`);
      markVavooProxyAsHealthy(proxy);
      return data;
    } catch (error) {
      lastError = error;
      markVavooProxyAsFailed(proxy, error?.response?.status);
    }
  }

  throw lastError || new Error("[VAVOO CYCLETLS] aucun proxy SOCKS5 disponible");
}

const splitCsvEnv = (envName, fallback = []) => {
  const rawValue = process.env[envName];
  if (!rawValue) return [...fallback];
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const parsePositiveIntEnv = (envName, fallback) => {
  const rawValue = process.env[envName];
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function normalizeProxyType(type, fallback = "http") {
  const normalized = String(type || fallback)
    .toLowerCase()
    .replace(/:$/, "")
    .trim();
  if (
    normalized === "socks" ||
    normalized === "socks5h" ||
    normalized.startsWith("socks5")
  ) {
    return "socks5";
  }
  if (normalized.startsWith("http")) {
    return "http";
  }
  return fallback;
}

function updateArrayInPlace(target, nextValues) {
  target.splice(0, target.length, ...nextValues);
  return target;
}

function dedupeProxyEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry || !entry.host || !entry.port) return false;
    const key = `${entry.type}:${entry.host}:${entry.port}:${entry.auth || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeProxyEntry(entry, fallbackType = "http") {
  if (!entry || !entry.host || !entry.port) return null;
  const port = Number.parseInt(entry.port, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    host: String(entry.host).trim(),
    port,
    auth: entry.auth ? String(entry.auth).trim() : undefined,
    type: normalizeProxyType(entry.type, fallbackType),
  };
}

function parseProxyString(value, defaultType = "http") {
  if (!value || typeof value !== "string") return null;
  const rawValue = value.trim();
  if (!rawValue) return null;

  if (/^[a-z]+:\/\//i.test(rawValue)) {
    try {
      const parsedUrl = new URL(rawValue);
      return sanitizeProxyEntry(
        {
          host: parsedUrl.hostname,
          port: parsedUrl.port,
          auth: parsedUrl.username
            ? `${decodeURIComponent(parsedUrl.username)}${parsedUrl.password ? `:${decodeURIComponent(parsedUrl.password)}` : ""}`
            : undefined,
          type: parsedUrl.protocol.replace(":", ""),
        },
        defaultType,
      );
    } catch {
      return null;
    }
  }

  const authSplitIndex = rawValue.lastIndexOf("@");
  let authPart = "";
  let hostPortPart = rawValue;
  if (authSplitIndex !== -1) {
    authPart = rawValue.slice(0, authSplitIndex).trim();
    hostPortPart = rawValue.slice(authSplitIndex + 1).trim();
  }

  const segments = hostPortPart
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 2) {
    return sanitizeProxyEntry(
      {
        host: segments[0],
        port: segments[1],
        auth: authPart || undefined,
        type: defaultType,
      },
      defaultType,
    );
  }

  if (!authPart && segments.length === 4) {
    const [a, b, c, d] = segments;
    if (/^\d+$/.test(b)) {
      return sanitizeProxyEntry(
        {
          host: a,
          port: b,
          auth: `${c}:${d}`,
          type: defaultType,
        },
        defaultType,
      );
    }
    if (/^\d+$/.test(d)) {
      return sanitizeProxyEntry(
        {
          host: c,
          port: d,
          auth: `${a}:${b}`,
          type: defaultType,
        },
        defaultType,
      );
    }
  }

  return null;
}

function parseProxyPayload(payload, defaultType = "http") {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return dedupeProxyEntries(
      payload
        .flatMap((item) => parseProxyPayload(item, defaultType))
        .filter(Boolean),
    );
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseProxyPayload(JSON.parse(trimmed), defaultType);
      } catch {
        // Keep parsing as raw text below.
      }
    }

    return dedupeProxyEntries(
      trimmed
        .split(/\r?\n/)
        .map((line) => parseProxyString(line, defaultType))
        .filter(Boolean),
    );
  }

  if (typeof payload === "object") {
    if (payload.host && payload.port) {
      return dedupeProxyEntries(
        [sanitizeProxyEntry(payload, defaultType)].filter(Boolean),
      );
    }

    const candidateKeys = ["proxies", "data", "items", "results", "list"];
    for (const key of candidateKeys) {
      if (payload[key] !== undefined) {
        const parsed = parseProxyPayload(payload[key], defaultType);
        if (parsed.length > 0) return parsed;
      }
    }

    const arrayValues = Object.values(payload).filter(Array.isArray);
    for (const value of arrayValues) {
      const parsed = parseProxyPayload(value, defaultType);
      if (parsed.length > 0) return parsed;
    }
  }

  return [];
}

function proxyToUrl(proxy, forcedType) {
  const safeProxy = sanitizeProxyEntry(
    proxy,
    forcedType || proxy?.type || "http",
  );
  if (!safeProxy) return null;
  const type = normalizeProxyType(forcedType || safeProxy.type, "http");
  const auth = safeProxy.auth ? `${safeProxy.auth}@` : "";
  return `${type}://${auth}${safeProxy.host}:${safeProxy.port}`;
}

const PROXY_POOL_REDIS_KEY = "proxyscrape:mainapi:pools:v1";
const PROXYSCRAPE_API_TOKEN = (
  process.env.PROXYSCRAPE_API_TOKEN ||
  process.env.PROXYSCRAPE_API_KEY ||
  ""
).trim();
const PROXYSCRAPE_ACCOUNT_ID = (
  process.env.PROXYSCRAPE_ACCOUNT_ID || ""
).trim();
const PROXYSCRAPE_ENABLED = Boolean(
  PROXYSCRAPE_API_TOKEN && PROXYSCRAPE_ACCOUNT_ID,
);
const KISSKH_PROXY_CONFIGURATION_PRESENT = Boolean(
  PROXYSCRAPE_API_TOKEN || PROXYSCRAPE_ACCOUNT_ID ||
  String(process.env.SOCKS5_PROXIES || "").trim(),
);
const PROXY_POOL_REDIS_TTL_SECONDS = 60 * 60;
const PROXYSCRAPE_ACCOUNT_BASE_URL = "https://api.proxyscrape.com";
const PROXYSCRAPE_ACCOUNT_PATH =
  "/v4/account/{accountId}/datacenter_shared/proxy-list";
const PROXYSCRAPE_TIMEOUT_MS = 12000;
const PROXYSCRAPE_REFRESH_MS = 15 * 60 * 1000;
const PROXYSCRAPE_MAX_PER_PROTOCOL = 1000;
const PROXYSCRAPE_HTTP_PROTOCOLS = ["http"];
const PROXYSCRAPE_SOCKS_PROTOCOLS = ["socks"];
const PROXYSCRAPE_ALLOW_LEGACY_FALLBACK = false;
const PROXYSCRAPE_DEBUG = false;

const legacySocksEnv =
  PROXYSCRAPE_ENABLED && !PROXYSCRAPE_ALLOW_LEGACY_FALLBACK
    ? []
    : parseJsonArrayEnv("SOCKS5_PROXIES", []);
const legacyHttpEnv =
  PROXYSCRAPE_ENABLED && !PROXYSCRAPE_ALLOW_LEGACY_FALLBACK
    ? []
    : parseJsonArrayEnv("HTTP_PROXIES", []);

const PROXIES = dedupeProxyEntries(
  (legacySocksEnv.length > 0
    ? legacySocksEnv
    : parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
  )
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

const VAVOO_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(
    parseVavooProxyJson(process.env.VAVOO_SOCKS5_PROXIES),
    "socks5",
  )
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(isUsableVavooSocks5Proxy),
);

const DEDICATED_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
    .map((entry) => sanitizeProxyEntry(entry, "socks5h"))
    .filter(Boolean),
);

const vavooProxyPolicy = createVavooProxyPolicy({
  preferredCidrs: ["65.111.31.0/24"],
});

const COFLIX_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

const HTTP_PROXIES = dedupeProxyEntries(
  (legacyHttpEnv.length > 0
    ? legacyHttpEnv
    : parseProxyPayload(process.env.HTTP_PROXIES, "http")
  )
    .map((entry) => sanitizeProxyEntry(entry, "http"))
    .filter(Boolean),
);

const DARKINO_HTTP_PROXIES = [];
const DARKINO_PROXIES = [];

function syncDerivedHttpProxyPools(httpEntries) {
  const normalizedHttpEntries = dedupeProxyEntries(
    httpEntries
      .map((entry) => sanitizeProxyEntry(entry, "http"))
      .filter(Boolean),
  );

  updateArrayInPlace(HTTP_PROXIES, normalizedHttpEntries);
  updateArrayInPlace(
    DARKINO_PROXIES,
    normalizedHttpEntries.map((entry) => ({ ...entry, type: "http" })),
  );
  updateArrayInPlace(
    DARKINO_HTTP_PROXIES,
    DARKINO_PROXIES.map((proxy) => proxyToUrl(proxy, "http")).filter(Boolean),
  );
}

syncDerivedHttpProxyPools(HTTP_PROXIES);

const proxyScrapeState = {
  refreshPromise: null,
  lastRefreshAt: 0,
  lastRefreshError: null,
  lastSuccessMeta: {
    socks: null,
    http: null,
  },
};

function getProxyPoolAgeMs(updatedAt = proxyScrapeState.lastRefreshAt) {
  const timestamp = Number(updatedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - timestamp;
}

function isProxyPoolFresh(updatedAt = proxyScrapeState.lastRefreshAt) {
  return getProxyPoolAgeMs(updatedAt) < PROXYSCRAPE_REFRESH_MS;
}

function buildProxyScrapeResult(source) {
  return {
    enabled: true,
    socks: PROXIES.length,
    http: HTTP_PROXIES.length,
    meta: proxyScrapeState.lastSuccessMeta,
    source,
  };
}

function limitProxyEntries(entries) {
  if (
    !Number.isFinite(PROXYSCRAPE_MAX_PER_PROTOCOL) ||
    PROXYSCRAPE_MAX_PER_PROTOCOL <= 0
  ) {
    return entries;
  }
  return entries.slice(0, PROXYSCRAPE_MAX_PER_PROTOCOL);
}

function buildProxyScrapeCandidates(protocol) {
  if (!PROXYSCRAPE_ACCOUNT_ID) {
    return [];
  }

  const accountPath = PROXYSCRAPE_ACCOUNT_PATH.replace(
    "{accountId}",
    PROXYSCRAPE_ACCOUNT_ID,
  );
  return [
    {
      url: `${PROXYSCRAPE_ACCOUNT_BASE_URL}${accountPath}`,
      headers: { "api-token": PROXYSCRAPE_API_TOKEN },
      params: {
        type: "getproxies",
        protocol,
        format: "credentials",
        credential_format: 2,
        status: "online",
      },
      label: `v4 account ${accountPath}`,
    },
  ];
}

function applyStoredProxyPools(storedPools) {
  if (!storedPools || typeof storedPools !== "object") return false;

  const socks = dedupeProxyEntries(
    (storedPools.socks || [])
      .map((entry) => sanitizeProxyEntry(entry, "socks5"))
      .filter(Boolean),
  );
  const httpEntries = dedupeProxyEntries(
    (storedPools.http || [])
      .map((entry) => sanitizeProxyEntry(entry, "http"))
      .filter(Boolean),
  );

  if (socks.length === 0 || httpEntries.length === 0) {
    return false;
  }

  updateArrayInPlace(
    PROXIES,
    socks.map((entry) => ({ ...entry, type: "socks5" })),
  );
  syncDerivedHttpProxyPools(httpEntries);
  proxyAgentCache.clear();
  darkinoProxyAgentCache.clear();
  cpasmalAgentCache.clear();
  return true;
}

async function loadProxyPoolsFromRedis() {
  try {
    const rawValue = await redis.get(PROXY_POOL_REDIS_KEY);
    if (!rawValue) return false;
    const parsed = JSON.parse(rawValue);
    if (!applyStoredProxyPools(parsed)) return false;
    proxyScrapeState.lastRefreshAt =
      Number(parsed.updatedAt) || proxyScrapeState.lastRefreshAt;
    proxyScrapeState.lastSuccessMeta =
      parsed.meta || proxyScrapeState.lastSuccessMeta;
    return true;
  } catch {
    return false;
  }
}

async function saveProxyPoolsToRedis(payload) {
  try {
    await redis.set(
      PROXY_POOL_REDIS_KEY,
      JSON.stringify(payload),
      "EX",
      PROXY_POOL_REDIS_TTL_SECONDS,
    );
  } catch {
    // ignore Redis persistence failures
  }
}

async function fetchProxyScrapeProtocol(defaultType, protocols) {
  const attemptErrors = [];

  for (const protocol of protocols) {
    const candidates = buildProxyScrapeCandidates(protocol);

    for (const candidate of candidates) {
      try {
        if (PROXYSCRAPE_DEBUG) {
          console.log(
            `[PROXYSCRAPE DEBUG] tentative ${candidate.label} | protocol=${protocol} | url=${candidate.url} | params=${JSON.stringify(candidate.params)}`,
          );
        }

        const response = await axios.get(candidate.url, {
          headers: candidate.headers,
          params: candidate.params,
          timeout: PROXYSCRAPE_TIMEOUT_MS,
          responseType: "text",
          transformResponse: [(data) => data],
        });

        const proxies = limitProxyEntries(
          dedupeProxyEntries(parseProxyPayload(response.data, defaultType)),
        );

        if (proxies.length === 0) {
          const message = `[PROXYSCRAPE] ${candidate.label} (${protocol}) a retourne 0 proxy`;
          attemptErrors.push(message);
          if (PROXYSCRAPE_DEBUG) {
            console.warn(
              `${message} | body=${String(response.data || "").slice(0, 300)}`,
            );
          }
          continue;
        }

        if (PROXYSCRAPE_DEBUG) {
          console.log(
            `[PROXYSCRAPE DEBUG] succes ${candidate.label} (${protocol}) -> ${proxies.length} proxies`,
          );
        }

        return {
          proxies,
          meta: {
            protocol,
            endpoint: candidate.label,
            count: proxies.length,
          },
        };
      } catch (error) {
        const status = error.response?.status;
        const message = `[PROXYSCRAPE] ${candidate.label} (${protocol}) a echoue: ${status || error.code || error.message}`;
        attemptErrors.push(message);
        if (PROXYSCRAPE_DEBUG) {
          console.warn(
            `${message} | body=${String(error.response?.data || "").slice(0, 300)}`,
          );
        }
      }
    }
  }

  throw new Error(
    attemptErrors.length > 0
      ? attemptErrors.join(" | ")
      : "[PROXYSCRAPE] Aucun endpoint n a repondu",
  );
}

async function refreshProxyScrapeProxies(options = {}) {
  const { force = false, silent = false } = options;

  if (!PROXYSCRAPE_ENABLED) {
    return {
      enabled: false,
      socks: PROXIES.length,
      http: HTTP_PROXIES.length,
    };
  }

  if (!force && proxyScrapeState.refreshPromise) {
    return proxyScrapeState.refreshPromise;
  }

  if (proxyScrapeState.refreshPromise) {
    return proxyScrapeState.refreshPromise;
  }

  if (!force) {
    const loadedFromRedis = await loadProxyPoolsFromRedis();
    if (loadedFromRedis && isProxyPoolFresh()) {
      if (!silent) {
        console.log(
          `[PROXYSCRAPE] Pools frais charges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
        );
      }
      return buildProxyScrapeResult("redis-fresh");
    }
  }

  proxyScrapeState.refreshPromise = (async () => {
    const lock = await acquireRedisLock(PROXY_POOL_REDIS_KEY, {
      ttl: Math.max(10, Math.ceil(PROXYSCRAPE_TIMEOUT_MS / 1000) * 2),
      retries: 40,
      retryDelay: 500,
    });

    if (!lock) {
      const loadedFromRedis = await loadProxyPoolsFromRedis();
      if (loadedFromRedis) {
        if (!silent) {
          console.log(
            `[PROXYSCRAPE] Pools charges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
          );
        }
        return buildProxyScrapeResult("redis");
      }
    }

    try {
      if (!force) {
        const loadedFromRedis = await loadProxyPoolsFromRedis();
        if (loadedFromRedis && isProxyPoolFresh()) {
          if (!silent) {
            console.log(
              `[PROXYSCRAPE] Pools frais recharges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
            );
          }
          return buildProxyScrapeResult("redis-fresh");
        }
      }

      const socksResult = await fetchProxyScrapeProtocol(
        "socks5",
        PROXYSCRAPE_SOCKS_PROTOCOLS,
      );
      const httpResult = await fetchProxyScrapeProtocol(
        "http",
        PROXYSCRAPE_HTTP_PROTOCOLS,
      );

      updateArrayInPlace(
        PROXIES,
        socksResult.proxies.map((proxy) => ({ ...proxy, type: "socks5" })),
      );
      syncDerivedHttpProxyPools(httpResult.proxies);

      proxyAgentCache.clear();
      darkinoProxyAgentCache.clear();
      cpasmalAgentCache.clear();

      proxyScrapeState.lastRefreshAt = Date.now();
      proxyScrapeState.lastRefreshError = null;
      proxyScrapeState.lastSuccessMeta = {
        socks: socksResult.meta,
        http: httpResult.meta,
      };

      await saveProxyPoolsToRedis({
        updatedAt: proxyScrapeState.lastRefreshAt,
        socks: PROXIES,
        http: HTTP_PROXIES,
        meta: proxyScrapeState.lastSuccessMeta,
      });

      if (!silent) {
        console.log(
          `[PROXYSCRAPE] Refresh OK: ${PROXIES.length} SOCKS5 via ${socksResult.meta.endpoint}, ${HTTP_PROXIES.length} HTTP via ${httpResult.meta.endpoint}`,
        );
      }

      return {
        enabled: true,
        socks: PROXIES.length,
        http: HTTP_PROXIES.length,
        meta: proxyScrapeState.lastSuccessMeta,
        source: "api",
      };
    } catch (error) {
      proxyScrapeState.lastRefreshError = error.message;

      const loadedFromRedis = await loadProxyPoolsFromRedis();
      if (loadedFromRedis) {
        if (!silent) {
          console.warn(
            `[PROXYSCRAPE] Refresh API echoue, fallback Redis utilise: ${error.message}`,
          );
        }
        return buildProxyScrapeResult("redis-fallback");
      }

      if (!silent) {
        console.error(`[PROXYSCRAPE] Refresh echoue: ${error.message}`);
      }
      throw error;
    } finally {
      if (lock && typeof lock.release === "function") {
        await lock.release();
      }
    }
  })().finally(() => {
    proxyScrapeState.refreshPromise = null;
  });

  return proxyScrapeState.refreshPromise;
}

function scheduleProxyScrapeRefresh() {
  if (!PROXYSCRAPE_ENABLED) return;

  setTimeout(() => {
    loadProxyPoolsFromRedis().catch(() => {});
  }, 0).unref();

  setInterval(() => {
    refreshProxyScrapeProxies({ silent: false }).catch(() => {});
  }, PROXYSCRAPE_REFRESH_MS).unref();
}

scheduleProxyScrapeRefresh();

// === WIFLIX FREE PROXY LIST (ProxyScrape v4 free) ===
const WIFLIX_FREE_PROXY_URL =
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text";
const WIFLIX_FREE_PROXY_REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const WIFLIX_FREE_PROXY_MAX_ATTEMPTS = 3; // Try up to 3 proxies per request
const WIFLIX_FREE_PROXY_TIMEOUT = 5000; // 5s per proxy attempt (fail fast)

// Cookie requis sur l'endpoint search (do=search) sinon réponse "Bot shield active.".
// Le site vérifie h_check==25 exactement (posé par son JS). Bump ici si le site change la valeur.
const WIFLIX_H_CHECK = "25";
const wiflixConfiguredProxies = ANIMESAMA_SOCKS5_PROXIES
  .map((proxy) => proxyToUrl(proxy, "socks5h"))
  .filter(Boolean);
const wiflixFreeProxies = [...wiflixConfiguredProxies];
const wiflixProxyAgentCache = new LruMap({
  max: PROXY_AGENT_CACHE_MAX,
  onEvict: destroyHttpAgentLike,
});
const wiflixDeadProxies = new Set(); // Proxies who echoue — survit entre les requetes, reset au refresh
const wiflixProxyAffinity = createWiflixProxyAffinity({ redis });
const wiflixProxyTelemetry = createWiflixProxyTelemetry({
  redis,
  webhookEnabled: WIFLIX_PROXY_BLOCK_WEBHOOK_ENABLED,
  webhookUrl: process.env.WIFLIX_PROXY_BLOCK_WEBHOOK_URL,
  sendWebhook: (webhookUrl, payload) => axios.post(webhookUrl, payload, {
    timeout: 4000,
    maxRedirects: 0,
    proxy: false,
  }),
});

async function fetchWiflixFreeProxies() {
  try {
    const res = await axios.get(WIFLIX_FREE_PROXY_URL, { timeout: 15000 });
    const text = typeof res.data === "string" ? res.data : "";
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = [];
    for (const line of lines) {
      // Only keep http/https — socks4 free proxies are too unreliable
      if (/^https?:\/\/.+:\d+$/.test(line)) {
        parsed.push(line);
      }
    }

    const mergedProxies = mergeWiflixProxySources(
      wiflixConfiguredProxies,
      parsed,
    );

    // Keep configured SOCKS5 first, then append the refreshed public HTTP pool.
    wiflixFreeProxies.length = 0;
    wiflixFreeProxies.push(...mergedProxies);
    wiflixProxyAgentCache.clear();
    wiflixDeadProxies.clear();

    console.log(
      `[WIFLIX FREE PROXY] Refresh OK: ${wiflixConfiguredProxies.length} SOCKS5 configures + ${parsed.length} HTTP publics (${lines.length - parsed.length} socks ignores)`,
    );
  } catch (err) {
    console.error(
      `[WIFLIX FREE PROXY] Refresh echoue: ${err.message}`,
    );
  }
}

function getWiflixFreeProxyAgent(proxyUrl) {
  if (wiflixProxyAgentCache.has(proxyUrl)) {
    return wiflixProxyAgentCache.get(proxyUrl);
  }

  let agents;
  if (isSocksWiflixProxyUrl(proxyUrl)) {
    const agent = new SocksProxyAgent(proxyUrl);
    agents = { httpAgent: agent, httpsAgent: agent };
  } else {
    agents = {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
  }

  wiflixProxyAgentCache.set(proxyUrl, agents);
  return agents;
}

/**
 * Wiflix request — tries free HTTP proxies first, then falls back to Cloudflare Workers.
 */
async function makeWiflixRequest(targetUrl, options = {}) {
  const {
    timeout = 10000,
    headers = {},
    decompress = true,
    method: requestMethod,
    data: requestData,
    ...otherOptions
  } = options;

  const method = (requestMethod || "GET").toUpperCase();

  // Cookie anti "Bot shield active." : l'endpoint search (do=search) l'exige.
  // Inoffensif sur les GET de pages. Mergé avec un éventuel Cookie fourni par l'appelant.
  const callerCookie = headers.cookie || headers.Cookie;
  const mergedHeaders = { ...headers };
  delete mergedHeaders.Cookie;
  mergedHeaders.cookie = callerCookie
    ? `h_check=${WIFLIX_H_CHECK}; ${callerCookie}`
    : `h_check=${WIFLIX_H_CHECK}`;
  // Re-propage à toutes les phases (le fallback CF Workers relit options.headers).
  options = { ...options, headers: mergedHeaders };

  const defaultHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...mergedHeaders,
  };

  // --- Phase 1: last Redis success first, then shuffled free proxies ---
  const outcome = await runWiflixProxyAttempts({
    affinity: wiflixProxyAffinity,
    priorityProxies: [...wiflixConfiguredProxies].sort(
      () => Math.random() - 0.5,
    ),
    proxies: mergeWiflixProxySources(
      [...wiflixConfiguredProxies].sort(() => Math.random() - 0.5),
      [...wiflixFreeProxies].sort(() => Math.random() - 0.5),
    ),
    deadProxies: wiflixDeadProxies,
    maxAttempts: WIFLIX_FREE_PROXY_MAX_ATTEMPTS,
    attempt: async (proxyUrl) => {
      const agents = getWiflixFreeProxyAgent(proxyUrl);
      const response = await wiflixProxyTelemetry.trackRequest(
        proxyUrl,
        () => axios({
          url: targetUrl,
          method,
          headers: defaultHeaders,
          timeout: WIFLIX_FREE_PROXY_TIMEOUT,
          decompress,
          ...agents,
          ...(requestData !== undefined ? { data: requestData } : {}),
          ...otherOptions,
        }),
      );

      // Verify we got a real response (not a proxy error page).
      const body = typeof response.data === "string" ? response.data : "";
      if (response.status === 200 && body.length > 100) {
        return response;
      }
      const invalidResponse = new Error(
        `[WIFLIX FREE PROXY] reponse invalide status=${response.status} size=${body.length}`,
      );
      invalidResponse.wiflixStatus = response.status;
      throw invalidResponse;
    },
    onFailure: async (proxyUrl, error) => {
      wiflixProxyAgentCache.delete(proxyUrl);
      await wiflixProxyTelemetry.reportFailure(proxyUrl, error, {
        requestKind: "page",
        targetUrl,
      });
    },
  });

  if (outcome.response) {
    console.log(
      `[WIFLIX FREE PROXY] OK via ${redactWiflixProxyUrl(outcome.proxyUrl)} (tentative ${outcome.attemptedCount}/${outcome.candidateCount})`,
    );
    return outcome.response;
  }

  if (outcome.attemptedCount > 0) {
    console.log(
      `[WIFLIX FREE PROXY] ${outcome.attemptedCount} echoues, fallback CF Workers`,
    );
  }

  // --- Phase 2: fallback to Cloudflare Workers ---
  return makeRequestWithCorsFallback(targetUrl, options);
}

// Set-Cookie[] -> "name=value; name2=value2" (drop path/expires/etc. attributes)
function extractCookieHeader(setCookie) {
  if (!Array.isArray(setCookie) || setCookie.length === 0) return "";
  return setCookie
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

// One GET (harvest the bot-shield session cookie) + one POST (search) over the
// given axios proxy agents. Returns the response if it's a real result page,
// else throws so the caller rotates to the next proxy.
async function wiflixHandshake(homeUrl, searchUrl, baseHeaders, pdata, agents, timeout, proxyUrl) {
  const home = await wiflixProxyTelemetry.trackRequest(
    proxyUrl,
    () => axios({
      url: homeUrl,
      method: "GET",
      headers: { ...baseHeaders, referer: homeUrl },
      timeout,
      decompress: true,
      ...agents,
    }),
  );

  const harvested = extractCookieHeader(home.headers["set-cookie"]);
  const cookie = harvested
    ? `${harvested}; h_check=${WIFLIX_H_CHECK}`
    : `h_check=${WIFLIX_H_CHECK}`;

  const res = await wiflixProxyTelemetry.trackRequest(
    proxyUrl,
    () => axios({
      url: searchUrl,
      method: "POST",
      headers: { ...baseHeaders, cookie },
      data: pdata,
      timeout,
      decompress: true,
      ...agents,
    }),
  );

  const body = typeof res.data === "string" ? res.data : "";
  if (
    res.status === 200 &&
    body.length > 100 &&
    !body.includes("Bot shield active")
  ) {
    return res;
  }
  const invalidResponse = new Error(`wiflix search bad response (status ${res.status}, ${body.length}b)`);
  invalidResponse.wiflixStatus = res.status;
  invalidResponse.wiflixTargetUrl = searchUrl;
  throw invalidResponse;
}

/**
 * Wiflix search — the bot shield rejects do=search unless the request carries a
 * real session cookie issued by the homepage GET (plus h_check=25). The session
 * cookie is IP-bound, so the GET (harvest) and the POST (search) MUST run on the
 * same proxy. Port of vStream wiflix.py showMovies() handshake.
 */
async function makeWiflixSearchRequest(homeUrl, searchUrl, options = {}) {
  const { timeout = 10000, headers = {}, data: pdata } = options;

  const baseHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // --- Phase 1: last Redis success first, then shuffled free proxies ---
  const outcome = await runWiflixProxyAttempts({
    affinity: wiflixProxyAffinity,
    priorityProxies: [...wiflixConfiguredProxies].sort(
      () => Math.random() - 0.5,
    ),
    proxies: mergeWiflixProxySources(
      [...wiflixConfiguredProxies].sort(() => Math.random() - 0.5),
      [...wiflixFreeProxies].sort(() => Math.random() - 0.5),
    ),
    deadProxies: wiflixDeadProxies,
    maxAttempts: WIFLIX_FREE_PROXY_MAX_ATTEMPTS,
    attempt: (proxyUrl) =>
      wiflixHandshake(
        homeUrl, searchUrl, baseHeaders, pdata,
        getWiflixFreeProxyAgent(proxyUrl), WIFLIX_FREE_PROXY_TIMEOUT, proxyUrl,
      ),
    onFailure: async (proxyUrl, error) => {
      wiflixProxyAgentCache.delete(proxyUrl);
      await wiflixProxyTelemetry.reportFailure(proxyUrl, error, {
        requestKind: "search",
        targetUrl: error?.config?.url || error?.wiflixTargetUrl || searchUrl,
      });
    },
  });

  if (outcome.response) {
    console.log(
      `[WIFLIX SEARCH] OK via free proxy ${redactWiflixProxyUrl(outcome.proxyUrl)} (${outcome.attemptedCount}/${outcome.candidateCount})`,
    );
    return outcome.response;
  }

  if (outcome.attemptedCount > 0) {
    console.log(`[WIFLIX SEARCH] ${outcome.attemptedCount} free proxies echoues, fallback CF Workers`);
  }

  // --- Phase 2: CF Workers fallback — stateless single POST (h_check only) ---
  return makeRequestWithCorsFallback(searchUrl, {
    method: "POST",
    data: pdata,
    headers: { ...headers, cookie: `h_check=${WIFLIX_H_CHECK}` },
    timeout,
  });
}

// Initial fetch + 5-min refresh
fetchWiflixFreeProxies();
setInterval(() => {
  fetchWiflixFreeProxies();
}, WIFLIX_FREE_PROXY_REFRESH_MS).unref();

// Fonction utilitaire pour choisir aléatoirement un proxy (toujours utiliser un proxy)
function pickRandomProxyOrNone() {
  // Sélectionner toujours un proxy aléatoire parmi la liste
  if (!PROXIES || PROXIES.length === 0) return null;
  const idx = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[idx] || null;
}

// Sélectionne un proxy aléatoire — retourne null si la liste est vide
function pickRandomProxy() {
  if (!PROXIES || PROXIES.length === 0) return null;
  const idx = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[idx];
}

// Fonction utilitaire pour cr\u00e9er un agent proxy SOCKS5 (avec cache)
function getProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : "";
  const proxyType = normalizeProxyType(proxy.type, "socks5");
  const cacheKey = `${proxyType}:${proxy.host}:${proxy.port}:${auth}`;

  // V\u00e9rifier le cache d'abord
  if (proxyAgentCache.has(cacheKey)) {
    return proxyAgentCache.get(cacheKey);
  }

  const protocol = proxyType === "socks5" ? "socks5h" : proxyType;
  const proxyUrl = `${protocol}://${auth}${proxy.host}:${proxy.port}`;
  const agent = new SocksProxyAgent(proxyUrl);

  // Mettre en cache l'agent
  proxyAgentCache.set(cacheKey, agent);
  return agent;
}

// Fonction utilitaire pour cr\u00e9er un agent proxy (pour Darkino) - avec cache
function getDarkinoHttpProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : "";
  const proxyType = normalizeProxyType(proxy.type, "http");
  const cacheKey = `${proxyType}:${proxy.host}:${proxy.port}:${auth}`;

  // V\u00e9rifier le cache d'abord
  if (darkinoProxyAgentCache.has(cacheKey)) {
    return darkinoProxyAgentCache.get(cacheKey);
  }

  let agents;
  if (proxyType === "socks5") {
    const proxyUrl = `socks5://${auth}${proxy.host}:${proxy.port}`;
    const agent = new SocksProxyAgent(proxyUrl);
    agents = {
      httpAgent: agent,
      httpsAgent: agent,
    };
  } else {
    const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
    agents = {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
  }

  // Mettre en cache les agents
  darkinoProxyAgentCache.set(cacheKey, agents);
  return agents;
}

module.exports = {
  // Proxy agent caches
  proxyAgentCache,
  darkinoProxyAgentCache,

  // Proxy configuration flags
  ENABLE_DARKINO_PROXY,
  ENABLE_COFLIX_PROXY,
  ENABLE_FRENCH_STREAM_PROXY,
  ENABLE_LECTEURVIDEO_PROXY,
  ENABLE_FSTREAM_PROXY,
  ENABLE_ANIME_PROXY,
  ENABLE_WIFLIX_PROXY,
  darkiworld_premium,

  // Darkino cooldowns (Redis-backed, cluster-wide)
  DARKINO_403_COOLDOWN_MS,
  DARKINO_5XX_COOLDOWN_MS,
  DARKINO_NETERR_COOLDOWN_MS,
  getDarkinoCooldownRemainingMs,
  armDarkinoCooldown,
  recordDarkinoNetFailure,
  resetDarkinoNetFailures,

  // Cpasmal
  CPASMAL_BASE_URL,
  cpasmalJar,
  getCpasmalAgent,
  axiosCpasmalRequest,

  // Cloudflare Workers proxies
  CLOUDFLARE_WORKERS_PROXIES,
  proxyErrorCache,
  markProxyAsErrored,
  isProxyInCooldown,
  getAvailableProxies,
  markProxyAsHealthy,
  buildProxiedUrl,

  // Request helpers
  makeRequestWithCorsFallback,
  makeWiflixRequest,
  makeWiflixSearchRequest,
  makeCoflixRequest,
  classifyCloudflare429,
  makeLecteurVideoRequest,
  makeAnimeSamaRequest,
  makeVavooBrowserRequest,
  makeCinestreamRequest,
  make1j1fRequest,
  makeCpasmalRequest,

  // SOCKS5 proxies
  PROXIES,
  HTTP_PROXIES,
  DARKINO_HTTP_PROXIES,
  DARKINO_PROXIES,
  refreshProxyScrapeProxies,

  // Agent helpers
  pickRandomProxyOrNone,
  pickRandomProxy,
  pickProxyscrapeCandidates,
  pickNextSocks5Proxy,
  getKisskhProxyCandidates,
  isKisskhProxyConfigured,
  reserveKisskhProxy,
  pickNextKisskhProxy,
  pickDedicatedSocks5Proxy,
  pickVavooSocks5Proxy,
  markVavooProxyAsHealthy,
  markVavooProxyAsFailed,
  getProxyAgent,
  getDarkinoHttpProxyAgent,

  // Cleanup
  cycleTlsInitOptions,
  shutdownCycleTLS,
};
