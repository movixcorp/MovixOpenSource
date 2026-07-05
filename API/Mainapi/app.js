/**
 * Express application setup.
 * Extracted from server.js -- creates the app, mounts middleware and routes.
 * Does NOT start the server (that remains in server.js).
 */

const express = require("express");
const http = require("http");
const https = require("https");
const compression = require("compression");
const cookieParser = require("cookie-parser");

// Middleware modules
const corsMiddleware = require("./middleware/cors");
const {
  securityHeaders,
  keepAliveHeaders,
  domainRestriction,
  jsonParseErrorHandler,
} = require("./middleware/security");

// Config
const { redis } = require("./config/redis");

// Utility modules
const {
  getFromCacheWithExpiration,
  getFromCacheNoExpiration,
  saveToCache,
  touchCacheEntry,
  shouldUpdateCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  shouldUpdateCache24h,
  shouldUpdateCache48h,
  generateCacheKey,
  CACHE_DIR,
} = require("./utils/cacheManager");

const {
  limitConcurrency3,
  limitConcurrency10,
} = require("./utils/concurrency");

const {
  CPASMAL_BASE_URL,
  makeRequestWithCorsFallback,
} = require("./utils/proxyManager");

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const axiosHelpers = require("./utils/axiosHelpers");

const DEFAULT_DARKIWORLD_BASE_URL = "https://darkiworld2026.com";

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

const DARKIWORLD_BASE_URL = normalizeBaseUrl(
  process.env.DARKIWORLD_BASE_URL || DEFAULT_DARKIWORLD_BASE_URL,
);

const cookieJar = new tough.CookieJar();

// === Darkino session & headers setup ===
// UA + client hints stables (Chrome/Brave 148 Windows). darkiworld a une
// limite de session par client, donc TOUTES les requêtes (refresh `/`,
// /api/v1/titles/.../content/liens, /api/v1/download-premium/...,
// seasons/episodes) doivent partager exactement ce fingerprint pour rester
// sur une seule session côté upstream.
//
// Cookies + x-xsrf-token : viennent de l'env (DARKIWORLD_COOKIES /
// DARKIWORLD_XSRF_TOKEN). cf_clearance volontairement absent de l'env :
// Cloudflare le renouvelle régulièrement, le set-cookie de réponse arrive
// dans le tough-cookie jar et `mergeCookieHeaders(jarState, configured)`
// ajoute les cookies du jar absents de la string env sans écraser ceux fixés.
const darkiHeaders = {
  accept: "application/json",
  "accept-encoding": "gzip, deflate, br",
  "accept-language": "fr-FR,fr;q=0.6",
  "cache-control": "no-cache",
  cookie: process.env.DARKIWORLD_COOKIES || "",
  pragma: "no-cache",
  priority: "u=1, i",
  "sec-ch-ua":
    '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version-list":
    '"Chromium";v="148.0.0.0", "Brave";v="148.0.0.0", "Not/A)Brand";v="99.0.0.0"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": '""',
  "sec-ch-ua-platform": '"Windows"',
  "sec-ch-ua-platform-version": '"19.0.0"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-gpc": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "x-xsrf-token": process.env.DARKIWORLD_XSRF_TOKEN || "",
};

// Coflix config
const COFLIX_BASE_URL = "https://coflix.date";
const coflixHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  Referer: "https://coflix.date",
};

// === Axios instances for each source ===
const axiosCoflix = axios.create({
  baseURL: COFLIX_BASE_URL,
  timeout: 15000,
  headers: coflixHeaders,
  decompress: true,
});

const axiosAnimeSama = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  },
  decompress: true,
});

const FSTREAM_BASE_URL_VAL = "https://french-stream.one/";
const axiosFStream = axios.create({
  baseURL: FSTREAM_BASE_URL_VAL,
  timeout: 6000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Sec-GPC": "1",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Brave";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    Referer: "https://french-stream.one/",
  },
  decompress: true,
});

// Darkino session refresh — coordonné via Redis pour qu'un SEUL worker du
// cluster pinge l'upstream toutes les 10 minutes (et pas N workers en parallèle,
// ce qui ferait exploser la limite de session côté darkiworld).
const DARKINO_SESSION_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const DARKINO_REFRESH_LAST_KEY = "darkino:lastRefreshAt";
const DARKINO_REFRESH_LOCK_KEY = "darkino:refreshLock";
const DARKINO_REFRESH_LOCK_TTL_MS = 30 * 1000; // filet si le worker crash pendant le GET (axios timeout = 5s)

const refreshDarkinoSessionIfNeeded = async () => {
  try {
    const last = Number(await redis.get(DARKINO_REFRESH_LAST_KEY)) || 0;
    if (Date.now() - last <= DARKINO_SESSION_REFRESH_INTERVAL) return;

    // SET NX PX : seul le worker qui acquiert exécute le refresh, les autres no-op.
    const acquired = await redis.set(
      DARKINO_REFRESH_LOCK_KEY,
      String(process.pid),
      "PX",
      DARKINO_REFRESH_LOCK_TTL_MS,
      "NX",
    );
    if (!acquired) return;

    try {
      await axiosHelpers.axiosDarkinoRequest({ method: "get", url: "/" });
      await redis.set(DARKINO_REFRESH_LAST_KEY, String(Date.now()));
      console.log("[DARKINO] Session refreshed");
    } catch (error) {
      if (
        !error.response ||
        (error.response.status !== 500 && error.response.status !== 403)
      ) {
        console.error("[DARKINO] Failed to refresh session:", error.message);
      }
    } finally {
      await redis.del(DARKINO_REFRESH_LOCK_KEY).catch(() => {});
    }
  } catch (_) {
    // Redis down → skip silently. Pas de fallback in-memory : ce serait
    // réintroduire le bug N-workers-refreshent-en-parallèle.
  }
};

// Configure axiosHelpers with darkino session deps + axios instances
axiosHelpers.configure({
  darkiHeaders,
  cookieJar,
  coflixHeaders,
  COFLIX_BASE_URL,
  axiosCoflix,
  axiosAnimeSama,
  axiosFStream,
  ANIME_SAMA_URL: "https://anime-sama.to/",
  FSTREAM_BASE_URL: FSTREAM_BASE_URL_VAL,
});

// === Initialize global agent keep-alive with socket limits ===
http.globalAgent.keepAlive = true;
http.globalAgent.maxSockets = 128; // Prevent unbounded socket accumulation
http.globalAgent.maxFreeSockets = 32;
https.globalAgent.keepAlive = true;
https.globalAgent.maxSockets = 128;
https.globalAgent.maxFreeSockets = 32;

// === Create Express app ===
const app = express();

// === Mount middleware in correct order ===

// 1. Enable gzip compression for all responses
app.use(
  compression({
    level: 1, // Balanced compression level (1-9, higher = more compression, slower)
    threshold: 1024, // Only compress responses > 1KB
    filter: (req, res) => {
      // Don't compress if client doesn't accept it
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  }),
);

// 2. Cors Configuration (Restricted in production)
app.use(corsMiddleware);

// 3. Security headers (minimal set -- replaces Helmet)
app.use(securityHeaders);

// 4. Keep-Alive headers
app.use(keepAliveHeaders);

// 5. Domain restriction middleware
app.use(domainRestriction);

// 6. Body parsing
app.use(express.json({ limit: "30mb" })); // Reduced from 1000mb to prevent abuse

// 6b. Cookie parsing (for HttpOnly JWT auth cookie)
app.use(cookieParser());

// 7. JSON parse error handler (must come right after json parser)
app.use(jsonParseErrorHandler);

app.use(express.urlencoded({ extended: true, limit: "5mb" })); // Reduced from 1000mb to prevent abuse

// 8. Serve uploaded OAuth app icons (`public/oauth-icons/<filename>`).
//    Le panel admin upload ici, OAuthAuthorizePage lit `/oauth-icons/<filename>`.
const { ICON_DIR: OAUTH_ICON_DIR } = require('./utils/oauthClientsDb');
app.use(
  '/oauth-icons',
  express.static(OAUTH_ICON_DIR, {
    fallthrough: false,
    maxAge: '7d',
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  }),
);

// ==========================================================================
// Configure route modules with dependencies from extracted utilities
// ==========================================================================

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_API_URL = "https://api.themoviedb.org/3";
const DARKINO_MAINTENANCE = false;
const DARKINOS_CACHE_DIR = require("path").join(__dirname, "cache", "darkinos");
const DOWNLOAD_CACHE_DIR = require("path").join(
  __dirname,
  "cache",
  "darkinodownloadlink",
);
const ANIME_SAMA_URL = "https://anime-sama.to/";

// Shared deps object for common dependencies
const commonDeps = {
  TMDB_API_KEY,
  TMDB_API_URL,
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  getFromCacheNoExpiration,
  getFromCacheWithExpiration,
  saveToCache,
  shouldUpdateCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  shouldUpdateCache24h,
  limitConcurrency3,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
};

// --- Configure cpasmal ---
const cpasmalRouter = require("./routes/cpasmal");
cpasmalRouter.configure({
  CPASMAL_BASE_URL,
  TMDB_API_URL,
  TMDB_API_KEY,
  axiosCpasmalRequest: require("./utils/proxyManager").axiosCpasmalRequest,
  DARKINO_PROXIES: require("./utils/proxyManager").DARKINO_PROXIES,
  getDarkinoHttpProxyAgent: require("./utils/proxyManager")
    .getDarkinoHttpProxyAgent,
  getFromCacheNoExpiration,
  shouldUpdateCache,
});

// --- Configure coflix (helper, not a router) ---
const coflix = require("./routes/coflix");
coflix.configure({
  axiosCoflixRequest: axiosHelpers.axiosCoflixRequest,
  axiosLecteurVideoRequest: axiosHelpers.axiosLecteurVideoRequest,
  makeCoflixRequest: require("./utils/proxyManager").makeCoflixRequest,
  coflixHeaders,
  getFromCacheNoExpiration,
  saveToCache,
  formatCoflixError: axiosHelpers.formatCoflixError,
});

// --- Configure frenchstream (helper, not a router) ---
const frenchstream = require("./routes/frenchstream");
frenchstream.configure({
  makeRequestWithCorsFallback,
  axiosFrenchStreamRequest: axiosHelpers.axiosFrenchStreamRequest,
  // findTvSeriesOnTMDB will be injected after tmdb is configured
});

// --- Configure animeSama ---
const animeSamaRouter = require("./routes/animeSama");
animeSamaRouter.configure({
  ANIME_SAMA_URL,
  axiosAnimeSama,
  axiosAnimeSamaRequest: axiosHelpers.axiosAnimeSamaRequest,
  getFromCacheNoExpiration,
  saveToCache,
  mergeStreamingLinks: axiosHelpers.mergeStreamingLinks,
  cleanupOldCacheFiles: axiosHelpers.cleanupOldCacheFiles,
  migrateOldCacheFiles: axiosHelpers.migrateOldCacheFiles,
  limitConcurrency10,
});

// --- Configure tmdb ---
const tmdbRouter = require("./routes/tmdb");
tmdbRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  limitConcurrency3,
  // Coflix helpers
  searchCoflixByTitle: coflix.searchCoflixByTitle,
  getMovieDataFromCoflix: coflix.getMovieDataFromCoflix,
  getTvDataFromCoflix: coflix.getTvDataFromCoflix,
  filterEmmmmbedReaders: coflix.filterEmmmmbedReaders,
  // FrenchStream helpers
  getFrenchStreamMovie: frenchstream.getFrenchStreamMovie,
  getFrenchStreamSeries: frenchstream.getFrenchStreamSeries,
  getFrenchStreamSeriesDetails: frenchstream.getFrenchStreamSeriesDetails,
  extractSeriesInfo: frenchstream.extractSeriesInfo,
  mergeSeriesParts: frenchstream.mergeSeriesParts,
  cleanTvCacheData: frenchstream.cleanTvCacheData,
});

// Now inject findTvSeriesOnTMDB back into frenchstream (circular dep)
frenchstream.configure({
  findTvSeriesOnTMDB: tmdbRouter.findTvSeriesOnTMDB,
});

// --- Configure search ---
const searchRouter = require("./routes/search");
searchRouter.configure({
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  touchCacheEntry,
  shouldUpdateCache,
});

// --- Configure download ---
const downloadRouter = require("./routes/download");
downloadRouter.configure({
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  darkiHeaders,
  darkiworld_premium: false,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache,
  refreshDarkinoSessionIfNeeded,
});

// --- Configure darkiworld ---
const darkiworldRouter = require("./routes/darkiworld");
darkiworldRouter.configure({
  DARKINO_MAINTENANCE,
  DOWNLOAD_CACHE_DIR,
  darkiHeaders,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache,
  shouldUpdateCache24h,
  shouldUpdateCache48h,
  refreshDarkinoSessionIfNeeded,
  redis,
});

// --- Configure voirdrama ---
const voirdramaRouter = require("./routes/voirdrama");
voirdramaRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache24h,
});

// --- Configure francetv ---
const francetvRouter = require("./routes/francetv");
francetvRouter.configure({
  getFromCacheWithExpiration,
  saveToCache,
});

const {
  router: vipDonationsRouter,
  ensureVipDonationsTables
} = require('./routes/vipDonations');
const { router: vipPayblisRouter } = require('./routes/vipPayblis');
const oauthRouter = require('./routes/oauth');

// ==========================================================================
// Mount all route modules
// ==========================================================================

// Pre-existing routes (already extracted before this modularization)
const sharedListsRouter = require("./sharedListsRoutes");
app.use("/api/comments", require("./commentsRoutes"));
app.use("/api/likes", require("./likesRoutes"));
app.use("/api/shared-lists", sharedListsRouter);
app.use("/api/livetv", require("./liveTvRoutes"));

// New modular routes
app.use('/api/cpasmal', cpasmalRouter);
app.use('/anime', animeSamaRouter);
app.use('/api', tmdbRouter);
app.use('/', searchRouter);
app.use('/api', downloadRouter);
app.use('/api/fstream', require('./routes/fstream'));
app.use('/api/wiflix', require('./routes/wiflix'));
app.use('/api', require('./routes/sync'));
app.use('/api/profiles', require('./routes/profiles'));
app.use('/api/help', require('./routes/helpFeedback'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/oauth', oauthRouter);
app.use('/api/admin/oauth-apps', require('./routes/adminOauthApps'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api', require('./routes/debrid'));
app.use('/proxy', require('./routes/proxy'));
app.use('/api', require('./routes/admin'));
app.use('/api', vipDonationsRouter);
app.use('/api', vipPayblisRouter);
app.use('/api/darkiworld', darkiworldRouter);
app.use('/api/drama', voirdramaRouter);
app.use('/api/ftv', francetvRouter);
const purstreamRouter = require('./routes/purstream');
purstreamRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  PROXY_SERVER_URL: process.env.PROXY_SERVER_URL,
  verifyAccessKey: require("./checkVip").verifyAccessKey,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache,
});
app.use("/api/purstream", purstreamRouter);

const downloadLinksLeaderboardRouter = require('./routes/downloadLinksLeaderboard');
app.use('/api/download-links', downloadLinksLeaderboardRouter);

// ==========================================================================
// MySQL pool initialization — pool unique via mysqlPool.js
// ==========================================================================

const {
  initPool,
  getPool,
  SCHEMA_BOOTSTRAP_LOCK_NAME,
  withMysqlAdvisoryLock
} = require('./mysqlPool');
const { ensureAccountLinksStorage } = require('./utils/accountLinks');
const { ensureCloneLinksStorage } = require('./utils/cloneLinks');
const { ensureOAuthStorage } = require('./utils/oauthStorage');

const appReady = (async () => {
  try {
    const pool = await initPool();
    console.log("MySQL unified pool initialized successfully");
    await withMysqlAdvisoryLock(pool, SCHEMA_BOOTSTRAP_LOCK_NAME, async () => {
      console.log(
        `[Bootstrap] Worker ${process.pid} acquired MySQL schema lock`,
      );

      // Créer la table user_sessions si elle n'existe pas
      await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_type ENUM('oauth', 'bip39') NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_sessions_user (user_id, user_type),
        INDEX idx_user_sessions_accessed (accessed_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
      console.log("Table user_sessions initialized successfully");

      await ensureAccountLinksStorage();
      console.log("Table account_links initialized successfully");

      await ensureCloneLinksStorage();
      console.log("Table clone_links initialized successfully");

    await ensureVipDonationsTables(pool);
    console.log('VIP donations tables initialized successfully');

    await ensureOAuthStorage(pool);
    console.log('OAuth tables initialized successfully');

      // OAuth client config (table oauth_clients + stats + grants VIP).
      // ensureTables et migrateLegacyJsonIfNeeded sont protégés par le lock
      // mais idempotents — sûr sur restart cluster. reloadCache hydrate
      // le cache in-process de CE worker (chaque worker a le sien).
      const oauthClientsDb = require('./utils/oauthClientsDb');
      await oauthClientsDb.ensureTables();
      await oauthClientsDb.migrateLegacyJsonIfNeeded();
      await oauthClientsDb.reloadCache();
      console.log('OAuth client tables initialized successfully');

      // Initialize Wishboard routes
      const { createWishboardRouter } = require("./wishboardRoutes");
      const wishboardRouter = createWishboardRouter(pool, redis);
      app.use("/api/wishboard", wishboardRouter);
      app.use("/api/admin/wishboard", wishboardRouter);
      console.log("Wishboard routes initialized successfully");

      // Initialize Link Submissions routes (user-submitted streaming links)
      const {
        createLinkSubmissionsRouter,
      } = require("./linkSubmissionsRoutes");
      const linkSubmissionsRouter = createLinkSubmissionsRouter(pool, redis);
      app.use("/api/link-submissions", linkSubmissionsRouter);
      // Create link_submissions table if not exists
      await pool.execute(`
      CREATE TABLE IF NOT EXISTS link_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255) NOT NULL,
        tmdb_id INT NOT NULL,
        media_type ENUM('movie', 'tv') NOT NULL,
        season_number INT DEFAULT NULL,
        episode_number INT DEFAULT NULL,
        url VARCHAR(2048) NOT NULL,
        source_name VARCHAR(100) DEFAULT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        rejection_reason TEXT DEFAULT NULL,
        reviewed_by VARCHAR(255) DEFAULT NULL,
        reviewed_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ls_status (status),
        INDEX idx_ls_profile (profile_id),
        INDEX idx_ls_tmdb (tmdb_id, media_type),
        INDEX idx_ls_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
      console.log("Link Submissions routes initialized successfully");

      // Download links schema (admin-managed downloads + history/leaderboard)
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS download_links_history (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          admin_id VARCHAR(255) NOT NULL,
          admin_auth_type ENUM('oauth','bip-39') NOT NULL,
          action ENUM('added','removed') NOT NULL,
          media_type ENUM('movie','tv') NOT NULL,
          tmdb_id BIGINT NOT NULL,
          season INT NULL,
          episode INT NULL,
          link_url TEXT NOT NULL,
          link_type ENUM('streaming','download') NOT NULL DEFAULT 'download',
          changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_dlh_admin (admin_id, admin_auth_type),
          INDEX idx_dlh_changed (changed_at),
          INDEX idx_dlh_action (action),
          INDEX idx_dlh_link_type (link_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Ensure download_links JSON column on films and series (idempotent)
      const ensureColumn = async (tableName, columnName, definitionSql) => {
        const [rows] = await pool.execute(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
          [tableName, columnName]
        );
        if (rows.length === 0) {
          await pool.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definitionSql}`);
        }
      };
      await ensureColumn('films', 'download_links', 'download_links JSON NULL');
      await ensureColumn('series', 'download_links', 'download_links JSON NULL');
      // Retro-migration: ensure link_type column exists on download_links_history (for installations that created the table before this column was added)
      await ensureColumn('download_links_history', 'link_type', "link_type ENUM('streaming','download') NOT NULL DEFAULT 'download'");
      console.log("Download links schema initialized successfully");

      // Initialize Top 10 routes (public ranking)
      const { router: top10Router, initTop10Routes } = require("./top10Routes");
      initTop10Routes(pool, redis);
      app.use("/api/top10", top10Router);
      console.log("Top 10 routes initialized successfully");

      // Initialize Wrapped routes (Movix Wrapped 2026 data collection)
      const {
        router: wrappedRouter,
        initWrappedRoutes,
        initTables: initWrappedTables,
      } = require("./wrappedRoutes");
      initWrappedRoutes(pool, redis);
      await initWrappedTables();
      app.use("/api/wrapped", wrappedRouter);
      console.log("Wrapped routes initialized successfully");
    });
  } catch (error) {
    console.error("MySQL connection error:", error.message);
    throw error;
  }
})();

// === Pool getter for other modules ===
function getAppPool() {
  return getPool();
}

// === Hydracker queue drain timer ===
// Every worker fires the tick. drainQueueOnce uses Redis worker_lock so only
// one worker actually drains; the others get { drained: false, reason: 'lock_taken' }
// and skip. This means the drain runs in a worker process which has full
// darkiworld auth context (cookies, XSRF, darkiHeaders, axiosDarkinoRequest
// configured via axiosHelpers.configure earlier in this file).
const hydrackerQueue = require('./utils/hydrackerQueue');
const DRAIN_INTERVAL_MS = 5000;
if (hydrackerQueue.BATCHING_ENABLED) {
  setInterval(async () => {
    try {
      const result = await hydrackerQueue.drainQueueOnce({
        redis,
        cacheDir: DOWNLOAD_CACHE_DIR,
        generateCacheKey,
        getFromCacheNoExpiration,
        saveToCache,
        axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
        refreshDarkinoSessionIfNeeded
      });
      if (result.drained) {
        console.log(`[hydracker] drained batch of ${result.batchSize}`);
      } else if (result.error) {
        console.warn(`[hydracker] drain error: ${result.error} (requeued ${result.requeued || 0})`);
      }
    } catch (e) {
      console.warn(`[hydracker] drain tick threw:`, e?.message || e);
    }
  }, DRAIN_INTERVAL_MS);
} else {
  console.log('[hydracker] HYDRACKER_BATCHING_ENABLED=false → drain timer skipped, decode runs synchronously');
}

// === Unified error handler ===
app.use((err, req, res, next) => {
  if (err.message !== "Not allowed by CORS") {
    console.error("Erreur globale:", err);
  }
  res.status(500).json({
    error: "Erreur serveur interne",
    message: err.message,
    path: req.path,
  });
});

module.exports = { app, appReady, getAppPool };
