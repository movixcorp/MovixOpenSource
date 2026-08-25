// ============================================================================
// Fallback domain — constantes injectées au build par vite.config.ts
// ============================================================================
const DEFAULT_MIRRORS = __MOVIX_DEFAULT_MIRRORS__;
const CONFIG_URL = __MOVIX_CONFIG_URL__;
const NAV_TIMEOUT_MS = 3000;
const CONFIG_TIMEOUT_MS = 3000;
// Ping de confirmation sur un asset statique de l'origine. Volontairement
// généreux : sur mobile, sortir de veille peut prendre 3-5s (DNS + TLS +
// radio cellulaire qui se réveille). Si même ce ping fail, l'origine est
// vraiment injoignable.
const REACHABILITY_TIMEOUT_MS = 4000;
const REACHABILITY_PROBE_PATH = '/movix.png';
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ============================================================================
// Image cache — TMDB images (posters, backdrops, logos)
// ============================================================================
//
// Stratégie : cache-first sur image.tmdb.org. Premier hit = network + cache,
// hits suivants = direct depuis CacheStorage (instantané, no network).
//
// Bonus : queue de concurrence côté SW, cap à 6 simultanés. Sans throttle,
// le navigateur peut déclencher 30+ fetchs parallèles au mount du home.
//
// Bump IMAGE_CACHE_NAME pour invalider toutes les images cachées d'un coup
// (ex. quand on change la taille standard w500→w342 — sinon on continue à
// servir les vieilles URLs pendant des semaines). v2 = passage à w342 posters
// + w300 logos.
const IMAGE_CACHE_NAME = 'movix-tmdb-images-v2';
const TMDB_IMAGE_HOST = 'image.tmdb.org';
const MAX_CONCURRENT_IMAGE_FETCHES = 6;
let activeImageFetches = 0;
const imageFetchQueue = [];

// Éviction FIFO : sans ça le cache grossit sans limite jusqu'à ce que le
// quota du navigateur fasse échouer silencieusement tous les cache.put().
// On ne vérifie qu'~1 mise en cache sur 20 (hors chemin chaud du hit, donc
// pas de coût sur les hits) pour éviter d'ouvrir cache.keys() à chaque fetch.
const IMAGE_CACHE_MAX_ENTRIES = 600;
const IMAGE_CACHE_TRIM_SAMPLE_RATE = 1 / 20;

async function trimImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_MAX_ENTRIES) return;
  // cache.keys() respecte l'ordre d'insertion -> les plus vieilles entrées
  // sont en tête, donc les premières de la liste sont supprimées (FIFO).
  const staleKeys = keys.slice(0, keys.length - IMAGE_CACHE_MAX_ENTRIES);
  await Promise.all(staleKeys.map((key) => cache.delete(key)));
}

function acquireImageFetchSlot() {
  return new Promise((resolve) => {
    if (activeImageFetches < MAX_CONCURRENT_IMAGE_FETCHES) {
      activeImageFetches++;
      resolve();
    } else {
      imageFetchQueue.push(resolve);
    }
  });
}

function releaseImageFetchSlot() {
  const next = imageFetchQueue.shift();
  if (next) {
    next();
  } else {
    activeImageFetches = Math.max(0, activeImageFetches - 1);
  }
}

async function handleTmdbImage(req) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  await acquireImageFetchSlot();
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      // .clone() avant .put() : la response ne peut être consommée qu'une fois.
      // .catch silently : QuotaExceededError quand storage full → on sert la
      // réponse non-cachée à l'utilisateur, qui marche quand même.
      cache.put(req, res.clone())
        .then(() => {
          if (Math.random() < IMAGE_CACHE_TRIM_SAMPLE_RATE) {
            trimImageCache(cache).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return res;
  } finally {
    releaseImageFetchSlot();
  }
}

// ============================================================================
// Asset cache — JS / CSS / polices du build
// ============================================================================
//
// Vite hashe le contenu dans le nom de fichier : `/assets/index-a1b2c3.js` ne
// désigne jamais deux contenus différents. Un cache-first est donc sûr — et
// c'est ce qui fait la différence entre « le site recharge » et « le site est
// déjà là » : au deuxième chargement, plus une seule requête réseau pour le
// bundle, même sur une connexion lente ou en train de se réveiller.
//
// Un déploiement change les hashs, donc les nouvelles URLs manquent au cache et
// sont récupérées normalement. Les anciennes n'y sont plus référencées : d'où
// l'éviction FIFO ci-dessous, sans quoi le cache grossirait à chaque build.
const ASSET_CACHE_NAME = 'movix-assets-v1';
const ASSET_PATH_PREFIX = '/assets/';
const ASSET_CACHE_MAX_ENTRIES = 160;
const ASSET_CACHE_TRIM_SAMPLE_RATE = 1 / 10;

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= ASSET_CACHE_MAX_ENTRIES) return;
  const staleKeys = keys.slice(0, keys.length - ASSET_CACHE_MAX_ENTRIES);
  await Promise.all(staleKeys.map((key) => cache.delete(key)));
}

async function handleAsset(req) {
  const cache = await caches.open(ASSET_CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const res = await fetch(req);
  // Uniquement les vraies réussites : une 404 (chunk d'un ancien build) ou une
  // réponse opaque mises en cache seraient resservies indéfiniment.
  if (res && res.ok && res.type === 'basic') {
    cache.put(req, res.clone())
      .then(() => {
        if (Math.random() < ASSET_CACHE_TRIM_SAMPLE_RATE) {
          trimAssetCache(cache).catch(() => {});
        }
      })
      .catch(() => {});
  }
  return res;
}

// ============================================================================
// Helpers fallback domain
// ============================================================================

// Dev/LAN guard : on skip toute logique de redirect miroir quand le SW tourne
// sur localhost ou une IP privée. Sinon un backend absent en dev ou un HMR qui
// bouge déclenche des fetch failures et balance le dev sur le miroir prod.
function isLocalHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.localhost')) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

function parseConfig(text) {
  // Deux formats supportés :
  // - JSON : {"mirrors":["movix.health",...]}  (dpaste.org, gist raw, etc.)
  // - HTML : page rendue rentry.co/<slug> — on extrait les hostnames des <a href>
  //   à l'intérieur du <article>. Rentry.co exige un access code pour /raw
  //   depuis un durcissement anti-abuse ; on parse le HTML rendu à la place.
  let hostnames = [];

  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.mirrors)) {
      hostnames = parsed.mirrors
        .map((m) => (typeof m === 'string' ? m.trim().toLowerCase() : ''));
    }
  } catch {
    const articleMatch = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
    const scope = articleMatch ? articleMatch[1] : text;
    const hrefRe = /href=["']https?:\/\/([^/"'\s?#]+)/gi;
    const seen = new Set();
    let match;
    while ((match = hrefRe.exec(scope)) !== null) {
      const host = match[1].trim().toLowerCase();
      if (!seen.has(host)) {
        seen.add(host);
        hostnames.push(host);
      }
    }
  }

  // Filtre : format hostname valide + exclusion de rentry.co (lien canonique,
  // CDN-cgi, footer, etc. qui peuvent se retrouver dans le scope si <article>
  // n'est pas trouvé).
  const mirrors = hostnames
    .filter((h) => h.length > 0 && HOSTNAME_RE.test(h))
    .filter((h) => h !== 'rentry.co' && !h.endsWith('.rentry.co'));
  if (mirrors.length === 0) return null;
  return { mirrors };
}

async function loadMirrors() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    const res = await fetch(CONFIG_URL, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const text = await res.text();
      const config = parseConfig(text);
      if (config) return config.mirrors;
    }
  } catch {}
  return Array.isArray(DEFAULT_MIRRORS) ? DEFAULT_MIRRORS.slice() : [];
}

function pickNextMirror(mirrors, currentHost) {
  const candidates = mirrors.filter((h) => h !== currentHost);
  return candidates[0] || null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMirrorUrl(targetHost, { from, reason, error, via } = {}) {
  const url = new URL(`https://${targetHost}/`);
  if (from)   url.searchParams.set('from', from);
  if (reason) url.searchParams.set('reason', reason);
  if (error)  url.searchParams.set('error', String(error).slice(0, 100));
  if (via)    url.searchParams.set('via', via);
  return url.href;
}

function renderRedirectPage(url) {
  const safe = escapeHtml(url);
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${safe}">
  <title>Movix — Redirection</title>
  <link rel="canonical" href="${safe}">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      display: grid; place-items: center; }
    .wrap { text-align: center; padding: 1.5rem; max-width: 420px; }
    .logo { font-size: 2rem; font-weight: 900; color: #dc2626; letter-spacing: 0.1em; margin-bottom: 1.5rem; }
    .spinner { width: 40px; height: 40px; margin: 0 auto 1.5rem;
      border: 3px solid rgba(255,255,255,.1); border-top-color: #dc2626;
      border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { margin: 0.5rem 0; color: #aaa; font-size: 0.9rem; line-height: 1.5; }
    a { color: #dc2626; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">MOVIX</div>
    <div class="spinner"></div>
    <p>Redirection vers notre nouveau domaine…</p>
    <p><a href="${safe}">Cliquer ici si rien ne se passe</a></p>
  </div>
  <script>
    setTimeout(function () { window.location.replace(${JSON.stringify(url)}); }, 100);
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function render503Page() {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Movix — Indisponible</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff;
      font-family: system-ui, -apple-system, sans-serif; display: grid; place-items: center; }
    .wrap { text-align: center; padding: 1.5rem; max-width: 420px; }
    .logo { font-size: 2rem; font-weight: 900; color: #dc2626; letter-spacing: 0.1em; margin-bottom: 1rem; }
    h1 { font-size: 1.2rem; margin: 0 0 1rem; }
    p { margin: 0.5rem 0; color: #aaa; font-size: 0.9rem; line-height: 1.5; }
    a { display: inline-block; margin-top: 1rem; background: #229ED9; color: #fff;
      padding: 0.7rem 1.2rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">MOVIX</div>
    <h1>Site temporairement indisponible</h1>
    <p>Tous nos domaines connus sont inaccessibles depuis votre connexion.</p>
    <p>Rejoins notre canal Telegram pour recevoir l'adresse du nouveau domaine.</p>
    <a href="https://t.me/movix_site">Ouvrir Telegram</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Préserve les caches courants (images, assets) ; supprime tout le reste
      // (anciennes versions, caches légacy d'avant cette logique). Quand on
      // bumpe un nom de cache (ex. v1 → v2), l'ancienne version est supprimée
      // ici automatiquement.
      const kept = new Set([IMAGE_CACHE_NAME, ASSET_CACHE_NAME]);
      await Promise.all(
        keys
          .filter((k) => !kept.has(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ============================================================================
// Push notifications (préservé tel quel)
// ============================================================================

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const baseUrl = self.location.origin;
  event.waitUntil(
    self.registration.showNotification(data.title || 'Movix', {
      body: data.body || '',
      icon: data.icon ? new URL(data.icon, baseUrl).href : `${baseUrl}/movix-192.png`,
      badge: `${baseUrl}/movix-192.png`,
      image: data.image || undefined,
      data: data.data || {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { contentType, contentId } = event.notification.data || {};
  let url = '/';
  if (contentType && contentId) {
    url = contentType === 'movie' ? `/movie/${contentId}` : `/tv/${contentId}`;
  }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ============================================================================
// Fetch — intercepte les navigations top-level pour fallback domain
// ============================================================================

// Ping de confirmation : l'origine répond-elle réellement ? Utilisé pour
// distinguer un VRAI blocage FAI (toute l'origine bloquée) d'un échec
// transient (mobile qui sort de veille, throttling de tab background, blip
// réseau). On vise un asset statique stable, cache: 'no-store' pour forcer
// un round-trip frais.
async function probeOriginOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    // URL stable, sans cache-buster : un blocage FAI casse au niveau DNS/TLS,
    // donc même une réponse servie par l'edge CDN prouve que le domaine est
    // joignable. `no-store` suffit à bypasser le cache HTTP du navigateur
    // (round-trip réseau garanti) ; un buster unique forcerait en plus un MISS
    // CDN et ferait traverser chaque probe jusqu'au serveur pour rien.
    const url = new URL(REACHABILITY_PROBE_PATH, self.location.origin).href;
    const res = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'manual',
    });
    clearTimeout(timer);
    // 2xx, 3xx, 4xx = origine répond (même un 404 confirme que le serveur
    // est joignable). Seul un échec réseau ou un 5xx massif = injoignable.
    return res.status < 500;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

// Deux tentatives avant de conclure à un blocage. Un seul HEAD raté n'est
// pas un signal suffisant : un blip réseau ponctuel (perte de paquet, switch
// de cell tower, throttling court) peut le faire échouer. Si la 1ère échoue
// on attend 500ms et on retente — un VRAI blocage FAI est persistant et
// échouera les deux fois ; un blip transient laissera passer la 2ème.
//
// Memo 30s + single-flight (même pattern que dnsErrorDetection.ts côté page) :
// sur réseau flaky, chaque navigation échouée déclenchait jusqu'à 2 HEADs — un
// user qui spam reload générait une rafale de probes. 30s = assez long pour
// absorber un burst, assez court pour redétecter un blocage qui démarre. État
// en scope module : reset quand le browser tue le SW idle, ce qui est OK (le
// memo ne vise que les bursts, pas la persistance).
const PROBE_CACHE_MS = 30_000;
let probeInFlight = null;
let lastProbeAt = 0;
let lastProbeResult = null;

async function isOriginReachable() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  const now = Date.now();
  if (lastProbeResult !== null && now - lastProbeAt < PROBE_CACHE_MS) {
    return lastProbeResult;
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    const first = await probeOriginOnce();
    if (first) return true;
    await new Promise((r) => setTimeout(r, 500));
    return await probeOriginOnce();
  })();
  try {
    const result = await probeInFlight;
    lastProbeResult = result;
    lastProbeAt = Date.now();
    return result;
  } finally {
    probeInFlight = null;
  }
}

async function handleNavigation(req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
  try {
    const res = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    // Si l'utilisateur est offline, on laisse l'erreur réseau naturelle
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw err;
    }
    // Confirmation : l'origine est-elle vraiment injoignable ? Sinon (mobile
    // qui se réveille, network blip, tab throttlé), on relaie l'erreur
    // d'origine et on laisse le browser gérer (retry naturel, page d'erreur).
    // On ne bascule au miroir QUE si même un HEAD simple échoue.
    const reachable = await isOriginReachable();
    if (reachable) {
      throw err;
    }
    return await redirectToMirror({
      from: self.location.hostname,
      reason: 'unreachable',
      error: `${err.name}: ${err.message}`,
      via: 'sw-fetch',
    });
  }
}

async function redirectToMirror({ from, reason, error, via } = {}) {
  const mirrors = await loadMirrors();
  const target = pickNextMirror(mirrors, self.location.hostname);
  if (!target) return render503Page();
  const redirectUrl = buildMirrorUrl(target, { from, reason, error, via });
  return renderRedirectPage(redirectUrl);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 1. TMDB image cache — intercepte tous les GET sur image.tmdb.org peu
  // importe l'origine du SW. Pas de garde localhost ici : le cache est utile
  // aussi en dev pour éviter de re-fetcher les mêmes posters à chaque reload.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.hostname === TMDB_IMAGE_HOST) {
    event.respondWith(handleTmdbImage(req));
    return;
  }

  // 2. Assets du build — cache-first. Réservé à notre origine : le nom hashé
  // ne garantit l'immuabilité que pour les fichiers qu'on a produits.
  if (url.origin === self.location.origin && url.pathname.startsWith(ASSET_PATH_PREFIX)) {
    event.respondWith(handleAsset(req));
    return;
  }

  // 3. Navigation fallback (logique existante — préservée)
  if (req.mode !== 'navigate') return;
  if (isLocalHost(self.location.hostname)) return;
  event.respondWith(handleNavigation(req));
});

// ============================================================================
// Message — handle force-redirect trigger depuis la page (block detection)
// ============================================================================

self.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data || data.type !== 'MOVIX_FORCE_REDIRECT') return;
  if (isLocalHost(self.location.hostname)) return;
  try {
    // Garde-fou : la page peut compter ses erreurs de manière trop
    // optimiste (burst d'API calls qui fail au réveil mobile). On confirme
    // avant de rediriger — sinon on enverrait l'utilisateur sur un miroir
    // alors que l'origine répond très bien.
    const reachable = await isOriginReachable();
    if (reachable) return;
    const mirrors = await loadMirrors();
    const target = pickNextMirror(mirrors, self.location.hostname);
    if (!target) return;
    const url = buildMirrorUrl(target, {
      from: self.location.hostname,
      reason: 'api-errors',
      error: data.error || 'API error threshold reached',
      via: 'sw-message',
    });
    event.source?.postMessage({ type: 'MOVIX_REDIRECT_TO', url });
  } catch {}
});
