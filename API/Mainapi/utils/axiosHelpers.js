/**
 * High-level axios request helpers for each streaming site.
 * Extracted from server.js — wraps proxy logic with site-specific headers and cookies.
 *
 * Some helpers depend on axios instances / session state that live in route modules
 * (e.g. axiosFStream, axiosAnimeSama, axiosCoflix, cookieJar).
 * Call `configure(deps)` once at startup to inject those dependencies.
 */

const axios = require('axios');
const fsp = require('fs').promises;
const path = require('path');
const writeFileAtomic = require('write-file-atomic');

const {
  ENABLE_DARKINO_PROXY,
  ENABLE_COFLIX_PROXY,
  ENABLE_FRENCH_STREAM_PROXY,
  ENABLE_LECTEURVIDEO_PROXY,
  ENABLE_FSTREAM_PROXY,
  ENABLE_ANIME_PROXY,
  ENABLE_WIFLIX_PROXY,
  DARKINO_PROXIES,
  PROXIES,
  HTTP_PROXIES,
  CLOUDFLARE_WORKERS_PROXIES,
  getProxyAgent,
  getDarkinoHttpProxyAgent,
  getAvailableProxies,
  markProxyAsErrored,
  markProxyAsHealthy,
  buildProxiedUrl,
  makeRequestWithCorsFallback,
  makeCoflixRequest,
  makeLecteurVideoRequest,
  makeWiflixRequest,
  makeAnimeSamaRequest,
} = require('./proxyManager');

// Lazy-bound dependencies injected via configure()
let deps = {
  darkiHeaders: {},
  coflixHeaders: {},
  cookieJar: null,
  axiosCoflix: null,
  axiosAnimeSama: null,
  axiosFStream: null,
  COFLIX_BASE_URL: '',
  ANIME_SAMA_URL: '',
  FSTREAM_BASE_URL: '',
  ensureFStreamSession: async () => {},
  fstreamCookies: {},
  fstreamRequestCounter: 0,
  getFstreamRequestCounter: () => 0,
  incrementFstreamRequestCounter: () => {}
};

const WIFLIX_BASE_URL = 'https://flemmix.golf';

const truncateForLog = (value, maxLength = 300) => {
  if (typeof value !== 'string') return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
};

const summarizeRequestErrorForLog = (error) => {
  const responseBody = error?.response?.data;
  return {
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    responseSnippet: typeof responseBody === 'string'
      ? truncateForLog(responseBody, 500)
      : responseBody && typeof responseBody === 'object'
        ? truncateForLog(JSON.stringify(responseBody), 500)
        : undefined
  };
};

const DARKIWORLD_BASE_URL = String(process.env.DARKIWORLD_BASE_URL || 'https://darkiworld2026.com')
  .trim()
  .replace(/\/+$/, '');

/**
 * Inject site-specific dependencies that live outside this module.
 * Call once at server startup after creating axios instances.
 *
 * @param {object} injected - Map of dependency names to values
 */
function configure(injected) {
  Object.assign(deps, injected);
}

// === Proxy manager handle for Redis-backed Darkino cooldowns ===
const proxyManager = require('./proxyManager');

// Fonction utilitaire pour g\u00e9n\u00e9rer le referer dynamiquement
function generateDarkiReferer(url) {
  const baseUrl = DARKIWORLD_BASE_URL;

  if (url.includes('/season/') && url.includes('/episode/') && url.includes('/download')) {
    // Pour les \u00e9pisodes de s\u00e9ries: /titles/{titleId}/season/{seasonId}/episode/{episodeId}/download
    const match = url.match(/\/titles\/(\d+)\/season\/(\d+)\/episode\/(\d+)\/download/);
    if (match) {
      const [, titleId, seasonId, episodeId] = match;
      return `${baseUrl}/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download`;
    }
  } else if (url.includes('/titles/') && url.includes('/content/liens')) {
    // Nouvel endpoint download : /api/v1/titles/{titleId}/content/liens
    // Le navigateur envoie referer = /titles/{titleId}/download, sinon
    // l'API retourne 401 m\u00eame avec session valide.
    const match = url.match(/\/titles\/(\d+)\/content\/liens/);
    if (match) {
      const [, titleId] = match;
      return `${baseUrl}/titles/${titleId}/download`;
    }
  } else if (url.includes('/titles/') && url.includes('/download')) {
    // Pour les films: /titles/{id}/download
    const match = url.match(/\/titles\/(\d+)\/download/);
    if (match) {
      const [, titleId] = match;
      return `${baseUrl}/titles/${titleId}/download`;
    }
  } else if (url.includes('/search/')) {
    // Pour la recherche
    return `${baseUrl}/search`;
  }

  // Par d\u00e9faut, utiliser l'URL de base
  return baseUrl;
}

function splitCookieHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    return [];
  }

  return headerValue
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) {
        return null;
      }

      return [
        part.slice(0, separatorIndex).trim(),
        part.slice(separatorIndex + 1).trim()
      ];
    })
    .filter(Boolean);
}

function mergeCookieHeaders(...headerValues) {
  const cookieMap = new Map();

  for (const headerValue of headerValues) {
    for (const [name, value] of splitCookieHeader(headerValue)) {
      cookieMap.set(name, value);
    }
  }

  return [...cookieMap.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function decodeCookieValue(value) {
  if (typeof value !== 'string' || value === '') {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

async function getDarkinoJarState() {
  if (!deps.cookieJar) {
    return {
      cookieHeader: '',
      xsrfToken: ''
    };
  }

  try {
    const cookies = await deps.cookieJar.getCookies(DARKIWORLD_BASE_URL);
    const xsrfCookie = cookies.find(cookie => cookie.key.toUpperCase() === 'XSRF-TOKEN');

    return {
      cookieHeader: cookies.map(cookie => cookie.cookieString()).join('; '),
      xsrfToken: xsrfCookie ? decodeCookieValue(xsrfCookie.value) : ''
    };
  } catch (error) {
    console.warn(`[DARKINO REQUEST] Impossible de lire le cookieJar: ${error.message}`);
    return {
      cookieHeader: '',
      xsrfToken: ''
    };
  }
}

async function buildDarkinoRequestHeaders(config) {
  const dynamicReferer = generateDarkiReferer(config.url || '/');
  const jarState = await getDarkinoJarState();
  const requestHeaders = {
    ...deps.darkiHeaders,
    referer: dynamicReferer,
    ...config.headers,
  };
  const configuredCookieHeader = requestHeaders.cookie || requestHeaders.Cookie || '';
  // IMPORTANT: env cookies (DARKIWORLD_COOKIES) doivent gagner contre le
  // cookieJar. Sans ça, la réponse du GET `/` (refresh session) émet un
  // `set-cookie` avec une session anonyme qui écrase `darkiworld_session`
  // dans le jar → toutes les requêtes suivantes vers les routes auth (ex.
  // /api/v1/titles/{id}/content/liens) reçoivent 401 Unauthenticated.
  // L'ordre des arguments compte : le DERNIER argument gagne dans le merge.
  const mergedCookieHeader = mergeCookieHeaders(jarState.cookieHeader, configuredCookieHeader);

  if (mergedCookieHeader) {
    requestHeaders.cookie = mergedCookieHeader;
  }

  delete requestHeaders.Cookie;

  // x-xsrf-token : env gagne aussi. On ne fallback sur le jar que si l'env
  // ne fournit pas de token (sinon on enverrait un header qui ne matche
  // pas le cookie XSRF-TOKEN env qu'on vient de privilégier).
  if (jarState.xsrfToken && !requestHeaders['x-xsrf-token']) {
    requestHeaders['x-xsrf-token'] = jarState.xsrfToken;
  }

  return requestHeaders;
}

// Fonction utilitaire pour requ\u00eates Darkino avec proxies (SOCKS5h)
async function axiosDarkinoRequest(config) {
  // V\u00e9rifier si on est en cooldown apr\u00e8s une erreur 403 (cluster-wide via Redis)
  const cd403Ms = await proxyManager.getDarkinoCooldownRemainingMs('403');
  if (cd403Ms > 0) {
    const remainingMin = Math.ceil(cd403Ms / 60000);
    const error = new Error(`Darkino en cooldown (403 Cloudflare). R\u00e9essayez dans ${remainingMin} minute(s).`);
    error.isDarkinoCooldown = true;
    error.response = { status: 403 };
    throw error;
  }

  // V\u00e9rifier si on est en cooldown apr\u00e8s une erreur 429 (rate limit / Cloudflare Workers daily limit)
  const cd429Ms = await proxyManager.getDarkinoCooldownRemainingMs('429');
  if (cd429Ms > 0) {
    const remainingMin = Math.ceil(cd429Ms / 60000);
    const error = new Error(`Darkino en cooldown (rate limit 429). R\u00e9essayez dans ${remainingMin} minute(s).`);
    error.isDarkinoCooldown = true;
    error.response = { status: 429 };
    throw error;
  }

  // V\u00e9rifier si on est en cooldown apr\u00e8s une erreur serveur (5xx)
  const cd5xxMs = await proxyManager.getDarkinoCooldownRemainingMs('5xx');
  if (cd5xxMs > 0) {
    const remainingMin = Math.ceil(cd5xxMs / 60000);
    const error = new Error(`Darkino en cooldown (erreur serveur). R\u00e9essayez dans ${remainingMin} minute(s).`);
    error.isDarkinoCooldown = true;
    error.response = { status: 503 };
    throw error;
  }

  // Cooldown apres trop de timeouts / erreurs reseau consecutifs (cluster-wide).
  // Les cooldowns 403/429/5xx ne se declenchent que sur une reponse HTTP : un
  // timeout (ECONNABORTED) n'a pas de error.response donc rien ne s'armait,
  // l'upstream mort etait martele en boucle (RSS qui monte sans redescendre).
  const cdNeterrMs = await proxyManager.getDarkinoCooldownRemainingMs('neterr');
  if (cdNeterrMs > 0) {
    const remainingMin = Math.ceil(cdNeterrMs / 60000);
    const error = new Error(`Darkino en cooldown (trop de timeouts). Réessayez dans ${remainingMin} minute(s).`);
    error.isDarkinoCooldown = true;
    error.response = { status: 504 };
    throw error;
  }

  const requestUrl = `${DARKIWORLD_BASE_URL}${config.url}`;
  const darkinoRequestHeaders = await buildDarkinoRequestHeaders(config);

  const darkinoAuthSnapshot = {
    referer: darkinoRequestHeaders.referer,
    xsrfToken: truncateForLog(darkinoRequestHeaders['x-xsrf-token'] || '', 200),
    cookie: truncateForLog(darkinoRequestHeaders.cookie || '', 500),
    cookieLength: (darkinoRequestHeaders.cookie || '').length,
  };

  if (!ENABLE_DARKINO_PROXY) {
    // Si le proxy est d\u00e9sactiv\u00e9, faire la requ\u00eate directe
    try {
      const response = await axios({
        ...config,
        url: requestUrl,
        headers: darkinoRequestHeaders,
        timeout: 5000,
        withCredentials: false,
        decompress: true
      });

      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader && deps.cookieJar) {
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }
      return response;
    } catch (error) {
      console.error(`[DARKINO REQUEST][DIRECT ERROR] ${String(config.method || 'get').toUpperCase()} ${config.url}`, {
        ...summarizeRequestErrorForLog(error),
        auth: darkinoAuthSnapshot,
      });
      if (error.response && error.response.headers['set-cookie'] && deps.cookieJar) {
        const setCookieHeader = error.response.headers['set-cookie'];
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }
      // En cas d'erreur 403, 429 ou 5xx, activer le cooldown (cluster-wide)
      const directStatus = error.response?.status;
      if (directStatus === 403) {
        await proxyManager.armDarkinoCooldown('403');
        console.log(`[DARKINO] Erreur 403 d\u00e9tect\u00e9e (direct) - Cooldown activ\u00e9`);
      } else if (directStatus === 429) {
        await proxyManager.armDarkinoCooldown('429');
        console.log(`[DARKINO] Erreur 429 d\u00e9tect\u00e9e (direct) - Cooldown activ\u00e9`);
      } else if (directStatus >= 500 && directStatus < 600) {
        await proxyManager.armDarkinoCooldown('5xx');
        console.log(`[DARKINO] Erreur ${directStatus} d\u00e9tect\u00e9e (direct) - Cooldown activ\u00e9`);
      }
      throw error;
    }
  }

  // Utiliser les proxies HTTP sp\u00e9cifiques de Darkino avec rotation al\u00e9atoire
  const darkinoProxies = [...DARKINO_PROXIES]; // Copie pour pouvoir m\u00e9langer

  // M\u00e9langer al\u00e9atoirement les proxies
  for (let i = darkinoProxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [darkinoProxies[i], darkinoProxies[j]] = [darkinoProxies[j], darkinoProxies[i]];
  }

  if (darkinoProxies.length === 0) {
    try {
      const response = await axios({
        ...config,
        url: requestUrl,
        headers: darkinoRequestHeaders,
        timeout: 5000,
        withCredentials: false,
        decompress: true
      });

      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader && deps.cookieJar) {
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }
      return response;
    } catch (error) {
      console.error(`[DARKINO REQUEST][DIRECT NO PROXY ERROR] ${String(config.method || 'get').toUpperCase()} ${config.url}`, {
        ...summarizeRequestErrorForLog(error),
        auth: darkinoAuthSnapshot,
      });
      if (error.response && error.response.headers['set-cookie'] && deps.cookieJar) {
        const setCookieHeader = error.response.headers['set-cookie'];
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }
      const noProxyStatus = error.response?.status;
      if (noProxyStatus === 403) {
        await proxyManager.armDarkinoCooldown('403');
        console.log(`[DARKINO] Erreur 403 d\u00e9tect\u00e9e (direct sans proxy) - Cooldown activ\u00e9`);
      } else if (noProxyStatus === 429) {
        await proxyManager.armDarkinoCooldown('429');
        console.log(`[DARKINO] Erreur 429 d\u00e9tect\u00e9e (direct sans proxy) - Cooldown activ\u00e9`);
      } else if (noProxyStatus >= 500 && noProxyStatus < 600) {
        await proxyManager.armDarkinoCooldown('5xx');
        console.log(`[DARKINO] Erreur ${noProxyStatus} d\u00e9tect\u00e9e (direct sans proxy) - Cooldown activ\u00e9`);
      }
      throw error;
    }
  }

  let lastError = null;
  const maxRetries = 1; // Une seule tentative

  for (let i = 0; i < maxRetries; i++) {
    const proxy = darkinoProxies[i];
    const agents = getDarkinoHttpProxyAgent(proxy);

    try {
      const response = await axios({
        ...config,
        method: config.method || 'get',
        url: requestUrl,
        headers: darkinoRequestHeaders,
        timeout: 5000,
        withCredentials: false,
        decompress: true,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        proxy: false
      });

      // Mettre \u00e0 jour le cookieJar avec la r\u00e9ponse
      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader && deps.cookieJar) {
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }
      // Requete reussie : on n'est plus en serie d'echecs reseau.
      proxyManager.resetDarkinoNetFailures();
      return response;
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;
      console.warn(`[DARKINO REQUEST][PROXY ERROR] ${String(config.method || 'get').toUpperCase()} ${config.url}`, {
        attempt: i + 1,
        status: statusCode,
        error: summarizeRequestErrorForLog(error),
        auth: darkinoAuthSnapshot,
      });

      // Mettre \u00e0 jour les cookies m\u00eame en cas d'erreur si le header est pr\u00e9sent
      if (error.response && error.response.headers['set-cookie'] && deps.cookieJar) {
        const setCookieHeader = error.response.headers['set-cookie'];
        await Promise.all(setCookieHeader.map(cookie => deps.cookieJar.setCookie(cookie, DARKIWORLD_BASE_URL)));
      }

      // En cas d'erreur 403 (Cloudflare challenge), activer le cooldown (cluster-wide)
      if (statusCode === 403) {
        await proxyManager.armDarkinoCooldown('403');
        throw error;
      }

      // En cas d'erreur 429 (Too Many Requests / Cloudflare Workers daily limit),
      // activer le cooldown 429 (cluster-wide) \u2014 inutile de spammer un autre proxy
      // si l'upstream hydracker lui-m\u00eame rate-limit globalement.
      if (statusCode === 429) {
        await proxyManager.armDarkinoCooldown('429');
        console.log(`[DARKINO] Erreur 429 d\u00e9tect\u00e9e (proxy) - Cooldown activ\u00e9`);
        throw error;
      }

      // En cas d'erreur serveur (5xx), activer le cooldown 5xx (cluster-wide)
      if (statusCode >= 500 && statusCode < 600) {
        await proxyManager.armDarkinoCooldown('5xx');
        console.log(`[DARKINO] Erreur ${statusCode} d\u00e9tect\u00e9e (proxy) - Cooldown activ\u00e9`);
        throw error;
      }

      // Pour les autres erreurs (400, etc.), arr\u00eater imm\u00e9diatement
      if (statusCode) {
        throw error;
      }

      // Pas de statusCode = erreur reseau sans reponse HTTP (timeout
      // ECONNABORTED, ECONNRESET, ...). Compte l'echec pour le circuit
      // breaker cluster-wide : au seuil, le cooldown 'neterr' est arme.
      await proxyManager.recordDarkinoNetFailure();
    }
  }

  // Si on arrive ici, tous les proxies ont \u00e9chou\u00e9
  console.error(`[DARKINO REQUEST][ALL FAILED] ${String(config.method || 'get').toUpperCase()} ${config.url}`, {
    ...summarizeRequestErrorForLog(lastError),
    auth: darkinoAuthSnapshot,
  });
  throw lastError || new Error('Tous les proxies Darkino ont \u00e9chou\u00e9');
}

// Fonction utilitaire pour requ\u00eates Coflix avec rotation Cloudflare Workers
async function axiosCoflixRequest(config) {
  // Si URL relative, on consid\u00e8re que c'est Coflix.
  const targetUrl = config.url || '';
  const isAbsolute = /^https?:\/\//i.test(targetUrl);
  const isCoflixDomain = isAbsolute ? /^https?:\/\/(?:www\.)?coflix\.[^/]+/i.test(targetUrl) : true;

  try {
    if (!ENABLE_COFLIX_PROXY || !isCoflixDomain) {
      return await deps.axiosCoflix({ ...config });
    }

    // Utiliser makeCoflixRequest avec rotation SOCKS5
    const absoluteUrl = isAbsolute
      ? targetUrl
      : `${deps.COFLIX_BASE_URL}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;

    return await makeCoflixRequest(absoluteUrl, {
      headers: { ...deps.coflixHeaders, ...(config.headers || {}) },
      timeout: config.timeout || 7000,
      decompress: true,
      responseType: config.responseType
    });
  } catch (error) {
    // Logger les erreurs 403
    if (error.response?.status === 403) {
      console.log(`[Coflix] Erreur 403 Forbidden dans axiosCoflixRequest`);
      console.log(`[Coflix] URL: ${targetUrl}`);
      if (error.coflixProxy) {
        console.log(`[Coflix] Cloudflare Worker: ${error.coflixProxy}`);
      }
      if (error.coflixProxiedUrl) {
        console.log(`[Coflix] Proxied URL: ${error.coflixProxiedUrl}`);
      }
    }
    throw error;
  }
}

// Fonction utilitaire pour requ\u00eates French-Stream (SPA) via CORS fallback
async function axiosFrenchStreamRequest(config) {
  const targetUrl = config.url || '';
  const isAbsolute = /^https?:\/\//i.test(targetUrl);
  const baseMatches = config.baseURL && /french-?stream/i.test(config.baseURL);
  const isFrenchStream = /french-?stream/i.test(targetUrl) || baseMatches;

  if (!ENABLE_FRENCH_STREAM_PROXY || !isFrenchStream) {
    return axios({ timeout: 15000, ...config });
  }

  const absoluteUrl = isAbsolute
    ? targetUrl
    : (config.baseURL ? `${config.baseURL.replace(/\/$/, '')}/${targetUrl.replace(/^\//, '')}` : targetUrl);

  return makeRequestWithCorsFallback(absoluteUrl, {
    headers: { ...(config.headers || {}) },
    timeout: config.timeout || 5000,
    decompress: true,
    responseType: config.responseType
  });
}

// Fonction utilitaire pour requ\u00eates LecteurVideo avec proxies Wiflix
async function axiosLecteurVideoRequest(config) {
  const urlStr = config.url || '';
  const isLecteur = /lecteurvideo|lecteur-video|lecteur/i.test(urlStr) || (config.baseURL && /lecteurvideo|lecteur-video|lecteur/i.test(config.baseURL));

  if (!ENABLE_LECTEURVIDEO_PROXY || !isLecteur) {
    return axios({ timeout: 15000, ...config });
  }

  try {
    // Construire l'URL absolue si n\u00e9cessaire
    let absoluteUrl = config.url;
    if (config.baseURL && !config.url.startsWith('http')) {
      // Nettoyer les URLs avant la concat\u00e9nation pour \u00e9viter les espaces
      const cleanBaseURL = config.baseURL.trim();
      const cleanUrl = config.url.trim();
      absoluteUrl = cleanBaseURL + cleanUrl;
    }

    // Utiliser makeLecteurVideoRequest avec les proxies Wiflix
    return await makeLecteurVideoRequest(absoluteUrl, {
      timeout: config.timeout || 5000,
      headers: config.headers,
      decompress: config.decompress !== false,
      responseType: config.responseType,
      responseEncoding: config.responseEncoding
    });
  } catch (error) {
    throw error;
  }
}

// Fonction utilitaire pour requ\u00eates FStream avec proxy (retry sur 429, pool SOCKS5 + Darkino)
function withOptionalFStreamCookies(headers = {}) {
  if (headers['Cookie'] || headers['cookie']) {
    return headers;
  }

  const cookieHeader = Object.entries(deps.fstreamCookies)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  if (!cookieHeader) {
    return headers;
  }

  return {
    ...headers,
    Cookie: cookieHeader
  };
}

async function axiosFStreamRequest(config) {
  const urlStr = config.url || '';
  const fstreamBaseUrl = deps.FSTREAM_BASE_URL || '';
  const isFStream = urlStr.includes(fstreamBaseUrl.replace('https://', '').replace('http://', '')) ||
    (config.baseURL && config.baseURL.includes(fstreamBaseUrl.replace('https://', '').replace('http://', '')));

  if (!ENABLE_FSTREAM_PROXY || !isFStream) {
    await deps.ensureFStreamSession();
    const existingHeaders = config.headers || {};
    const response = await deps.axiosFStream({
      ...config,
      timeout: 8000,
      headers: withOptionalFStreamCookies(existingHeaders)
    });
    deps.incrementFstreamRequestCounter();
    return response;
  }

  // Pool combine SOCKS5 + Darkino HTTP, 1 proxy aleatoire
  const allProxies = [];
  if (PROXIES && PROXIES.length > 0) {
    PROXIES.forEach(p => allProxies.push({ proxy: p, type: 'socks5' }));
  }
  if (DARKINO_PROXIES && DARKINO_PROXIES.length > 0) {
    DARKINO_PROXIES.forEach(p => allProxies.push({ proxy: p, type: 'darkino' }));
  }

  if (allProxies.length === 0) {
    await deps.ensureFStreamSession();
    const existingHeaders = config.headers || {};
    const response = await deps.axiosFStream({
      ...config,
      timeout: 8000,
      headers: withOptionalFStreamCookies(existingHeaders)
    });
    deps.incrementFstreamRequestCounter();
    return response;
  }

  const entry = allProxies[Math.floor(Math.random() * allProxies.length)];
  const proxyLabel = `${entry.type}:${entry.proxy.host}:${entry.proxy.port}`;

  try {
    let agents;
    if (entry.type === 'socks5') {
      const agent = getProxyAgent(entry.proxy);
      agents = { httpAgent: agent, httpsAgent: agent };
    } else {
      agents = getDarkinoHttpProxyAgent(entry.proxy);
    }

    await deps.ensureFStreamSession();
    const existingHeaders = config.headers || {};
    const response = await deps.axiosFStream({
      ...config,
      timeout: 8000,
      decompress: true,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      proxy: false,
      headers: withOptionalFStreamCookies(existingHeaders)
    });
    deps.incrementFstreamRequestCounter();
    return response;
  } catch (error) {
    const status = error.response?.status;
    const method = (config.method || 'GET').toUpperCase();
    const rawUrl = config.url || '';
    const isAbs = /^https?:\/\//i.test(rawUrl);
    const fullUrl = isAbs
      ? rawUrl
      : (config.baseURL ? `${config.baseURL.replace(/\/$/, '')}/${rawUrl.replace(/^\//, '')}` : rawUrl);
    let qs = '';
    if (config.params && typeof config.params === 'object') {
      try { qs = '?' + new URLSearchParams(config.params).toString(); } catch (_) {}
    }
    console.error(`[FSTREAM REQUEST] Erreur ${status || error.code || 'unknown'} avec proxy ${proxyLabel}: ${error.message} | ${method} ${fullUrl}${qs}`);
    throw error;
  }
}

function isAnimeSamaRetriableError(error) {
  const statusCode = error?.response?.status;
  const errorCode = error?.code;
  const message = String(error?.message || '').toLowerCase();

  if (statusCode === 403 || statusCode === 407 || statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return true;
  }

  if (statusCode >= 500 && statusCode < 600) {
    return true;
  }

  if (
    errorCode === 'ECONNABORTED' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ECONNRESET' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'EHOSTUNREACH' ||
    errorCode === 'ENETUNREACH' ||
    errorCode === 'EAI_AGAIN'
  ) {
    return true;
  }

  return (
    message.includes('socks5 authentication failed') ||
    message.includes('proxy authentication') ||
    message.includes('tunneling socket could not be established')
  );
}

// Fonction utilitaire pour requ\u00eates AnimeSama via CycleTLS (JA3 Chrome) + proxies
async function axiosAnimeSamaRequest(config) {
  const debugAnimeSama = process.env.DEBUG_ANIMESAMA === 'true';
  let urlStr = config.url || '';

  const isAnimeSama = urlStr.includes('anime-sama.to') || urlStr.includes('anime-sama.si') || urlStr.includes('anime-sama.fr') ||
    (config.baseURL && (config.baseURL.includes('anime-sama.to') || config.baseURL.includes('anime-sama.si') || config.baseURL.includes('anime-sama.fr')));

  if (!ENABLE_ANIME_PROXY || !isAnimeSama) {
    return deps.axiosAnimeSama({ ...config, timeout: 30000, proxy: false });
  }

  // Construire l'URL compl\u00e8te
  let absoluteUrl = urlStr;
  if (config.baseURL && !urlStr.startsWith('http')) {
    absoluteUrl = config.baseURL + urlStr;
  } else if (!urlStr.startsWith('http') && !absoluteUrl.startsWith('http')) {
    // Si l'URL n'est pas compl\u00e8te et qu'on n'a pas de baseURL, utiliser ANIME_SAMA_URL
    absoluteUrl = deps.ANIME_SAMA_URL + (urlStr.startsWith('/') ? urlStr.substring(1) : urlStr);
  }

  // Headers pour les requ\u00eates Anime-Sama via proxy
  const animeSamaHeaders = {
    'Accept-Language': 'fr-FR,fr;q=0.6',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Priority': 'u=0, i',
    'Sec-CH-UA': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-GPC': '1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  };

  // Supprimer les headers li\u00e9s \u00e0 l'IP d'origine pour \u00e9viter de les transmettre
  const headersToRemove = ['X-Forwarded-For', 'X-Real-IP', 'X-Client-IP', 'CF-Connecting-IP', 'True-Client-IP', 'X-Original-Forwarded-For'];
  const cleanHeaders = { ...animeSamaHeaders };

  // Si config.headers existe, le nettoyer aussi
  if (config.headers) {
    const configHeaders = { ...config.headers };
    headersToRemove.forEach(header => {
      delete configHeaders[header];
      delete configHeaders[header.toLowerCase()];
    });
    Object.assign(cleanHeaders, configHeaders);
  }

  // CycleTLS (JA3 Chrome) + rotation sur pool SOCKS5/HTTP
  const method = String(config.method || 'get').toLowerCase();
  let cycleBody = '';
  if (config.data !== undefined && config.data !== null) {
    cycleBody = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
  }
  const res = await makeAnimeSamaRequest(absoluteUrl, {
    headers: cleanHeaders,
    timeout: 30,
    method,
    body: cycleBody,
  });

  if (res.status >= 200 && res.status < 400) {
    return {
      data: res.data,
      status: res.status,
      headers: res.headers,
      statusText: '',
      config,
    };
  }

  const cycleErr = new Error(`[ANIMESAMA CYCLETLS] status ${res.status}`);
  cycleErr.response = { data: res.data, status: res.status, headers: res.headers };
  if (debugAnimeSama) {
    console.warn(`[ANIMESAMA REQUEST] cycletls returned ${res.status}`, summarizeRequestErrorForLog(cycleErr));
  }
  throw cycleErr;
}

// Fonction utilitaire pour requ\u00eates Wiflix avec proxy
// D\u00e9l\u00e8gue \u00e0 makeWiflixRequest (free proxies -> Cloudflare Workers -> direct)
async function axiosWiflixRequest(config) {
  const urlStr = config.url || '';

  // Construire l'URL compl\u00e8te
  let absoluteUrl = urlStr;
  if (config.baseURL && !urlStr.startsWith('http')) {
    absoluteUrl = config.baseURL + urlStr;
  } else if (!urlStr.startsWith('http')) {
    absoluteUrl = WIFLIX_BASE_URL + (urlStr.startsWith('/') ? urlStr : '/' + urlStr);
  }

  const { url: _, baseURL: __, headers, ...restConfig } = config;

  return makeWiflixRequest(absoluteUrl, {
    method: restConfig.method || 'GET',
    headers: headers || {},
    timeout: restConfig.timeout || 15000,
    ...(restConfig.data !== undefined ? { data: restConfig.data } : {}),
    ...(restConfig.responseType ? { responseType: restConfig.responseType } : {}),
  });
}

// === UTILITY: Fusion des streaming_links par langue ===
function mergeStreamingLinks(oldLinks, newLinks) {
  // oldLinks et newLinks sont des tableaux d'objets { language, players }
  const merged = {};

  // D'abord, copier les anciens liens
  (oldLinks || []).forEach(l => {
    merged[l.language] = Array.isArray(l.players) ? [...l.players] : [];
  });

  // Ensuite, remplacer par les nouveaux liens si disponibles
  (newLinks || []).forEach(l => {
    if (l.players && l.players.length > 0) {
      // Si on a de nouveaux lecteurs, on remplace compl\u00e8tement les anciens
      merged[l.language] = Array.isArray(l.players) ? [...l.players] : [];
    }
  });

  // Retourne sous forme d'array d'objets
  return Object.entries(merged).map(([language, players]) => ({ language, players }));
}

// === UTILITY: Migration des anciens fichiers de cache s\u00e9par\u00e9s vers le cache unifi\u00e9 ===
async function migrateOldCacheFiles(safeAnimeName, animeCacheDir) {
  try {
    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
    const oldSeasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f.endsWith('.json'));

    if (oldSeasonFiles.length === 0) return;

    const migratedSeasons = {};

    for (const seasonFile of oldSeasonFiles) {
      try {
        const seasonContent = await fsp.readFile(path.join(animeCacheDir, seasonFile), 'utf-8');
        const seasonCache = JSON.parse(seasonContent);
        const seasonName = seasonFile.replace(safeAnimeName + '_', '').replace('.json', '');

        migratedSeasons[seasonName] = {
          timestamp: seasonCache.timestamp || Date.now(),
          episodes: seasonCache.episodes || []
        };
      } catch (e) {
      }
    }

    if (Object.keys(migratedSeasons).length > 0) {
      const unifiedCacheData = {
        timestamp: Date.now(),
        seasons: migratedSeasons
      };

      const animeCachePath = path.join(animeCacheDir, `${safeAnimeName}.json`);
      await writeFileAtomic(animeCachePath, JSON.stringify(unifiedCacheData), 'utf-8');

      // Nettoyer les anciens fichiers apr\u00e8s migration r\u00e9ussie
      await cleanupOldCacheFiles(safeAnimeName, animeCacheDir);
    }
  } catch (e) {
  }
}

// === UTILITY: Nettoyage des anciens fichiers de cache s\u00e9par\u00e9s ===
async function cleanupOldCacheFiles(safeAnimeName, animeCacheDir) {
  try {
    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
    const oldSeasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f.endsWith('.json'));

    for (const oldFile of oldSeasonFiles) {
      try {
        await fsp.unlink(path.join(animeCacheDir, oldFile));
      } catch (e) {
      }
    }
  } catch (e) {
  }
}

// Fonction pour supprimer les lecteurs fsvid des r\u00e9ponses FStream
function removeFsvidPlayers(data, isVip = false) {
  // Si pas de donn\u00e9es, retourner tel quel
  if (!data) {
    return data;
  }

  // Si l'utilisateur est VIP, ne pas filtrer les lecteurs fsvid
  if (isVip) {
    return data;
  }

  // Par d\u00e9faut, toujours filtrer les lecteurs fsvid (m\u00eame si remove_fsvid est false)

  // Pour les films : filtrer players.organized
  if (data.players && typeof data.players === 'object') {
    const filteredPlayers = {};
    let totalPlayers = 0;

    Object.keys(data.players).forEach(playerType => {
      if (Array.isArray(data.players[playerType])) {
        // Filtrer les lecteurs dont l'URL contient "fsvid"
        const filteredPlayerList = data.players[playerType].filter(player => {
          return !player.url || !player.url.includes('fsvid');
        });

        if (filteredPlayerList.length > 0) {
          filteredPlayers[playerType] = filteredPlayerList;
          totalPlayers += filteredPlayerList.length;
        }
      } else {
        // Si ce n'est pas un array, garder tel quel
        filteredPlayers[playerType] = data.players[playerType];
      }
    });

    return {
      ...data,
      players: filteredPlayers,
      total: totalPlayers,
      metadata: {
        ...data.metadata,
        fsvidFiltered: true
      }
    };
  }

  // Pour les s\u00e9ries : filtrer episodes
  if (data.episodes && typeof data.episodes === 'object') {
    const filteredEpisodes = {};
    let totalPlayers = 0;

    Object.keys(data.episodes).forEach(episodeKey => {
      const episode = data.episodes[episodeKey];
      if (episode && typeof episode === 'object') {
        const filteredEpisode = { ...episode };

        // V\u00e9rifier si l'\u00e9pisode a une structure "languages"
        if (episode.languages && typeof episode.languages === 'object') {
          const filteredLanguages = {};

          Object.keys(episode.languages).forEach(languageKey => {
            const languagePlayers = episode.languages[languageKey];

            if (Array.isArray(languagePlayers)) {
              // Filtrer les lecteurs dont l'URL contient "fsvid"
              const filteredPlayerList = languagePlayers.filter(player => {
                return !player.url || !player.url.includes('fsvid');
              });

              if (filteredPlayerList.length > 0) {
                filteredLanguages[languageKey] = filteredPlayerList;
                totalPlayers += filteredPlayerList.length;
              }
            } else {
              // Si ce n'est pas un array, garder tel quel
              filteredLanguages[languageKey] = languagePlayers;
            }
          });

          filteredEpisode.languages = filteredLanguages;
        } else {
          // Structure ancienne sans "languages" - filtrer directement
          Object.keys(episode).forEach(playerType => {
            if (Array.isArray(episode[playerType])) {
              // Filtrer les lecteurs dont l'URL contient "fsvid"
              const filteredPlayerList = episode[playerType].filter(player => {
                return !player.url || !player.url.includes('fsvid');
              });

              if (filteredPlayerList.length > 0) {
                filteredEpisode[playerType] = filteredPlayerList;
                totalPlayers += filteredPlayerList.length;
              }
            }
          });
        }

        // Garder l'\u00e9pisode seulement s'il a encore des lecteurs
        if (episode.languages ? Object.keys(filteredEpisode.languages).length > 0 : Object.keys(filteredEpisode).some(key => Array.isArray(filteredEpisode[key]) && filteredEpisode[key].length > 0)) {
          filteredEpisodes[episodeKey] = filteredEpisode;
        }
      }
    });

    return {
      ...data,
      episodes: filteredEpisodes,
      total: totalPlayers,
      metadata: {
        ...data.metadata,
        fsvidFiltered: true
      }
    };
  }

  return data;
}

// Fonction pour formater les erreurs Coflix
function formatCoflixError(error, context = '') {
  if (error && error.isAxiosError) {
    const url = error.config && error.config.url ? error.config.url : '';
    const statusCode = error.response ? error.response.status : '';
    const statusText = error.response ? error.response.statusText : '';

    // Ne pas logger les erreurs 400
    if (statusCode === 400) {
      return '';
    }

    return `[AxiosError] ${error.code || ''} ${error.message} ${statusCode ? `(${statusCode} ${statusText})` : ''} ${url}`;
  } else {
    const msg = error && error.message
      ? error.message
      : (typeof error === 'string' ? error : JSON.stringify(error));
    // Payloads HTML entiers (ex: le domaine Coflix redirige vers une page Telegram) :
    // ne jamais dumper des pages completes dans les logs.
    if (typeof msg === 'string' && msg.length > 300) {
      return `${msg.slice(0, 300).replace(/\s+/g, ' ')}… [tronqué, ${msg.length} chars]`;
    }
    return msg;
  }
}

module.exports = {
  configure,

  // Darkino
  generateDarkiReferer,
  axiosDarkinoRequest,

  // Coflix
  axiosCoflixRequest,
  formatCoflixError,

  // French-Stream
  axiosFrenchStreamRequest,

  // LecteurVideo
  axiosLecteurVideoRequest,

  // FStream
  axiosFStreamRequest,

  // AnimeSama
  axiosAnimeSamaRequest,

  // Wiflix
  axiosWiflixRequest,

  // Streaming link utilities
  mergeStreamingLinks,
  migrateOldCacheFiles,
  cleanupOldCacheFiles,

  // FStream player filter
  removeFsvidPlayers
};
