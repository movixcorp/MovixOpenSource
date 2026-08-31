/**
 * Movix Wrapped 2026 - Data Collection Routes
 * Collects viewing data and page visits for the annual Wrapped summary
 *
 * Performance notes:
 *  - Redis is used for generated-wrapped cache AND TMDB detail cache
 *  - All independent SQL queries run in Promise.all (parallel)
 *  - TMDB enrichment uses Redis-backed batch lookup
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { fetchTmdbDetails } = require('./utils/tmdbCache');

// Lazy import pour éviter les dépendances circulaires au démarrage
let _syncModule = null;
function getSyncModule() {
    if (!_syncModule) _syncModule = require('./routes/sync');
    return _syncModule;
}

// TMDB API Configuration
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// Redis key prefixes & TTLs
const WRAPPED_CACHE_PREFIX = 'wrapped:gen:';        // generated wrapped result
const PERCENTILE_CACHE_PREFIX = 'wrapped:pctile:';  // percentile ranking (global, heavy query)
const WRAPPED_CACHE_TTL    = 10 * 60;               // 10 min (seconds)
const PERCENTILE_CACHE_TTL = 30 * 60;               // 30 min (seconds) - global data, doesn't change fast

// Same secret as server.js
const JWT_SECRET = process.env.JWT_SECRET;

// Set by server.js via initWrappedRoutes()
let pool  = null;
let redis = null;

/**
 * Initialize the router with MySQL pool and Redis client
 * @param {object} mysqlPool - MySQL connection pool
 * @param {object} redisClient - ioredis instance (optional but recommended)
 */
function initWrappedRoutes(mysqlPool, redisClient) {
    pool  = mysqlPool;
    redis = redisClient || null;
}

// ─── Helpers: Redis-safe get / set ───────────────────────────────────────────
function redisReady() {
    return redis && redis.status === 'ready';
}

async function redisGet(key) {
    if (!redisReady()) return null;
    try { return await redis.get(key); } catch { return null; }
}

async function redisSet(key, value, ttlSeconds) {
    if (!redisReady()) return;
    try { await redis.set(key, value, 'EX', ttlSeconds); } catch { /* ignore */ }
}

// ─── Rate limiting par profil (Redis-backed) ────────────────────────────────
const RATE_LIMIT_PREFIX = 'wrapped:rl:';

/**
 * Crée un middleware de rate limiting par profileId (fallback userId).
 * @param {string} endpoint - Nom de l'endpoint (pour la clé Redis)
 * @param {number} maxRequests - Nombre max de requêtes dans la fenêtre
 * @param {number} windowSeconds - Durée de la fenêtre en secondes
 * @param {function} extractId - Fonction (req) => identifiant pour le rate limit
 */
function rateLimitPerProfile(endpoint, maxRequests, windowSeconds, extractId) {
    return async (req, res, next) => {
        if (!redisReady()) return next(); // pas de Redis = pas de rate limit

        const id = extractId(req);
        if (!id) return next(); // pas d'identifiant = skip

        const key = `${RATE_LIMIT_PREFIX}${endpoint}:${id}`;
        try {
            const current = await redis.incr(key);
            if (current === 1) {
                await redis.expire(key, windowSeconds);
            }
            // Headers informatifs
            res.set('X-RateLimit-Limit', String(maxRequests));
            res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current)));

            if (current > maxRequests) {
                const ttl = await redis.ttl(key);
                res.set('Retry-After', String(ttl > 0 ? ttl : windowSeconds));
                return res.status(429).json({
                    success: false,
                    error: 'Trop de requêtes. Réessaie dans quelques instants.'
                });
            }
            next();
        } catch {
            next(); // en cas d'erreur Redis, on laisse passer
        }
    };
}

// /track : le frontend envoie ~2 req/30s en usage normal, avec les changements
// de visibilité/contenu/épisode ça peut monter. 30 req/min est très confortable.
const trackRateLimit = rateLimitPerProfile('track', 30, 60, (req) => {
    return req.body?.profileId || req.user?.sub;
});

// /generate : requête lourde (SQL + TMDB). 6 req/min suffit largement
// (un refresh + quelques changements d'année).
const generateRateLimit = rateLimitPerProfile('generate', 6, 60, (req) => {
    return req.headers['x-profile-id'] || req.query.profileId || req.user?.sub;
});

const WRAPPED_UNLOCK_REQUIREMENTS = Object.freeze({
    minutes: 120,
    uniqueTitles: 3,
    sessions: 5,
    activeDays: 2
});

function buildWrappedProgress({ totalMinutes, uniqueTitles, totalSessions, totalActiveDays }) {
    const current = {
        minutes: Math.max(0, totalMinutes || 0),
        uniqueTitles: Math.max(0, uniqueTitles || 0),
        sessions: Math.max(0, totalSessions || 0),
        activeDays: Math.max(0, totalActiveDays || 0)
    };

    const missing = {
        minutes: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.minutes - current.minutes),
        uniqueTitles: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.uniqueTitles - current.uniqueTitles),
        sessions: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.sessions - current.sessions),
        activeDays: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.activeDays - current.activeDays)
    };

    const progressRatios = [
        Math.min(current.minutes / WRAPPED_UNLOCK_REQUIREMENTS.minutes, 1),
        Math.min(current.uniqueTitles / WRAPPED_UNLOCK_REQUIREMENTS.uniqueTitles, 1),
        Math.min(current.sessions / WRAPPED_UNLOCK_REQUIREMENTS.sessions, 1),
        Math.min(current.activeDays / WRAPPED_UNLOCK_REQUIREMENTS.activeDays, 1)
    ];

    return {
        isEligible: Object.values(missing).every((value) => value === 0),
        completionPercent: Math.round((progressRatios.reduce((sum, value) => sum + value, 0) / progressRatios.length) * 100),
        missingCriteriaCount: Object.values(missing).filter((value) => value > 0).length,
        requirements: { ...WRAPPED_UNLOCK_REQUIREMENTS },
        current,
        missing
    };
}

// ─── TMDB helpers (via tmdbCache centralisé) ────────────────────────────────

/**
 * Extrait les champs nécessaires à Wrapped depuis une réponse TMDB complète.
 */
function extractWrappedFields(data) {
    if (!data) return null;
    const releaseDate = data.release_date || data.first_air_date || null;
    return {
        title: data.title || data.name,
        poster_path: data.poster_path,
        backdrop_path: data.backdrop_path || null,
        genres: (data.genres || []).map(g => typeof g === 'string' ? g : g.name),
        vote_average: data.vote_average || null,
        runtime: data.runtime || data.episode_run_time?.[0] || null,
        release_year: releaseDate ? parseInt(String(releaseDate).slice(0, 4)) || null : null
    };
}

/**
 * Fetch details from TMDB (via tmdbCache Redis centralisé)
 */
async function fetchTMDBDetails(contentId, contentType) {
    // Skip live-tv as it's not from TMDB
    if (contentType === 'live-tv') {
        return { title: `Live TV #${contentId}`, poster_path: null, genres: [] };
    }

    const mediaType = contentType === 'anime' ? 'tv' : contentType;
    const data = await fetchTmdbDetails(TMDB_API_URL, process.env.TMDB_API_KEY, contentId, mediaType, 'fr-FR');
    return extractWrappedFields(data);
}

/**
 * Enrich content array with TMDB data (parallel, Redis-cached)
 */
async function enrichWithTMDBData(contents) {
    return Promise.all(contents.map(async (content) => {
        if (content.content_title && content.poster_path) {
            return content; // Already has data
        }
        const details = await fetchTMDBDetails(content.content_id, content.content_type);
        return {
            ...content,
            content_title: details?.title || content.content_title || `${content.content_type} #${content.content_id}`,
            poster_path: details?.poster_path || content.poster_path || null,
            genres: details?.genres || [],
            vote_average: details?.vote_average || null
        };
    }));
}

/**
 * Middleware to verify JWT token
 */
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // If no token, check if we can proceed without it (e.g. for simple tracking?)
        // But user asked for verification "like other routes", so we enforce it.
        // However, wrapped tracker might not have header set if useWrappedTracker uses standard fetch without setting headers.
        // Let's check useWrappedTracker.ts... It uses fetch without custom headers?
        // Wait, I need to check useWrappedTracker.ts. 
        // If useWrappedTracker doesn't send Authorization header, this will break tracking.
        return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, error: 'Invalid token.' });
    }
};

/**
 * Create required tables if they don't exist
 */
async function initTables() {
    if (!pool) {
        console.error('[Wrapped] Cannot init tables - no database pool');
        return;
    }

    try {
        // Create wrapped_viewing_data table
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS wrapped_viewing_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255),
        content_type ENUM('movie', 'tv', 'anime', 'live-tv') NOT NULL,
        content_id VARCHAR(255) NOT NULL,
        content_title VARCHAR(255),
        season_number INT DEFAULT NULL,
        episode_number INT DEFAULT NULL,
        watch_duration INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        hour_of_day TINYINT DEFAULT NULL,
        month INT NOT NULL,
        year INT NOT NULL,
        INDEX idx_user_year (user_id, year),
        INDEX idx_content (content_type, content_id),
        INDEX idx_hour (user_id, year, hour_of_day)
      )
    `);

        // Create wrapped_pages_data table
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS wrapped_pages_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255),
        page_name VARCHAR(100) NOT NULL,
        duration INT DEFAULT 0,
        meta_data JSON,
        month INT NOT NULL,
        year INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_page_stats (user_id, page_name, year)
      )
    `);

        // Migration: add hour_of_day column if it doesn't exist (for tables created before this column was added)
        try {
            await pool.execute(`
                ALTER TABLE wrapped_viewing_data ADD COLUMN hour_of_day TINYINT DEFAULT NULL AFTER created_at
            `);
            console.log('[Wrapped] Migration: added hour_of_day column');
        } catch (alterErr) {
            // ER_DUP_FIELDNAME (1060) means column already exists — that's fine
            if (alterErr.errno !== 1060) {
                console.warn('[Wrapped] Migration warning (hour_of_day):', alterErr.message);
            }
        }

        // Migration: add idx_hour index if it doesn't exist
        try {
            await pool.execute(`
                CREATE INDEX idx_hour ON wrapped_viewing_data (user_id, year, hour_of_day)
            `);
            console.log('[Wrapped] Migration: added idx_hour index');
        } catch (indexErr) {
            // ER_DUP_KEYNAME (1061) means index already exists — that's fine
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_hour):', indexErr.message);
            }
        }

        // Migration: add composite index for the track upsert SELECT (covers all lookup columns)
        try {
            await pool.execute(`
                CREATE INDEX idx_viewing_lookup ON wrapped_viewing_data 
                (user_id, profile_id, content_type, content_id, month, year, hour_of_day)
            `);
            console.log('[Wrapped] Migration: added idx_viewing_lookup index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_viewing_lookup):', indexErr.message);
            }
        }

        // Migration: add composite index for page data upsert SELECT
        try {
            await pool.execute(`
                CREATE INDEX idx_page_lookup ON wrapped_pages_data 
                (user_id, profile_id, page_name, month, year)
            `);
            console.log('[Wrapped] Migration: added idx_page_lookup index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_page_lookup):', indexErr.message);
            }
        }

        // Migration: covering index for generate queries (user_id, year, watch_duration, content_id, content_type)
        try {
            await pool.execute(`
                CREATE INDEX idx_generate_cover ON wrapped_viewing_data 
                (user_id, year, profile_id, content_type, content_id, watch_duration)
            `);
            console.log('[Wrapped] Migration: added idx_generate_cover index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_generate_cover):', indexErr.message);
            }
        }

        // Migration: index for first/last watch ORDER BY created_at
        try {
            await pool.execute(`
                CREATE INDEX idx_user_year_created ON wrapped_viewing_data (user_id, year, created_at)
            `);
            console.log('[Wrapped] Migration: added idx_user_year_created index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_user_year_created):', indexErr.message);
            }
        }

        // Migration: index for pages generate (user_id, year, page_name, duration)
        try {
            await pool.execute(`
                CREATE INDEX idx_page_generate ON wrapped_pages_data (user_id, year, profile_id, page_name, duration)
            `);
            console.log('[Wrapped] Migration: added idx_page_generate index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_page_generate):', indexErr.message);
            }
        }

        // Migration: covering index for the global percentile GROUP BY query
        // Allows MySQL to compute SUM(watch_duration) GROUP BY user_id entirely from the index
        try {
            await pool.execute(`
                CREATE INDEX idx_percentile_cover ON wrapped_viewing_data (year, user_id, watch_duration)
            `);
            console.log('[Wrapped] Migration: added idx_percentile_cover index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_percentile_cover):', indexErr.message);
            }
        }

        console.log('[Wrapped] Tables initialized successfully');
    } catch (error) {
        console.error('[Wrapped] Error initializing tables:', error);
    }
}

/**
 * POST /api/wrapped/track
 * Batch endpoint to receive viewing/page data
 */
router.post('/track', verifyToken, trackRateLimit, async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        const {
            userId,
            profileId,
            type,
            month,
            year,
            duration,
            // Viewing-specific fields
            contentType,
            contentId,
            contentTitle,
            seasonNumber,
            episodeNumber,
            hourOfDay,
            // Page-specific fields
            pageName,
            meta,
        } = req.body;

        // Security: userId du body doit correspondre au JWT
        if (!req.user || !req.user.sub) {
            return res.status(401).json({ success: false, error: 'Token invalide' });
        }
        if (userId !== req.user.sub) {
            console.warn(`[Wrapped] User ID mismatch blocked: Body ${userId} vs Token ${req.user.sub}`);
            return res.status(403).json({ success: false, error: 'User ID mismatch' });
        }

        // Security: vérifier que le profileId appartient bien à cet utilisateur
        if (profileId) {
            try {
                const userType = req.user.userType || 'oauth';
                const { readUserData } = getSyncModule();
                const userData = await readUserData(userType, req.user.sub);
                const profiles = userData?.profiles || [];
                if (!profiles.some(p => p.id === profileId)) {
                    console.warn(`[Wrapped] Profile ownership denied: ${profileId} not owned by ${req.user.sub}`);
                    return res.status(403).json({ success: false, error: 'Profile does not belong to this user' });
                }
            } catch (err) {
                console.error(`[Wrapped] Error checking profile ownership:`, err.message);
                return res.status(500).json({ success: false, error: 'Could not verify profile ownership' });
            }
        }

        // Validate required fields
        if (!userId || !type || !month || !year || duration === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, type, month, year, duration'
            });
        }

        // Validate numeric ranges to prevent data pollution
        const parsedMonth = parseInt(month);
        const parsedYear = parseInt(year);
        const parsedDuration = parseInt(duration);
        const currentYear = new Date().getFullYear();

        if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
            return res.status(400).json({ success: false, error: 'Invalid month (1-12)' });
        }
        if (isNaN(parsedYear) || parsedYear < 2024 || parsedYear > currentYear) {
            return res.status(400).json({ success: false, error: `Invalid year (2024-${currentYear})` });
        }
        if (isNaN(parsedDuration) || parsedDuration < 0 || parsedDuration > 60) {
            return res.status(400).json({ success: false, error: 'Invalid duration (0-60 seconds)' });
        }
        if (!['viewing', 'page'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid type. Must be "viewing" or "page"' });
        }

        if (type === 'viewing') {
            // Validate viewing-specific fields
            if (!contentType || !contentId) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields for viewing: contentType, contentId'
                });
            }

            // Resolve hour: prefer client-sent hourOfDay, fallback to server hour
            const resolvedHour = hourOfDay !== undefined && hourOfDay !== null ? parseInt(hourOfDay) : new Date().getHours();

            // Try to update existing record for the same content in the same month AND same hour
            // Splitting by hour ensures accurate listening clock data
            const [existingRows] = await pool.execute(
                `SELECT id, watch_duration FROM wrapped_viewing_data 
         WHERE user_id = ? AND profile_id <=> ? AND content_type = ? AND content_id = ? 
         AND month = ? AND year = ? AND hour_of_day <=> ?
         AND season_number <=> ? AND episode_number <=> ?
         LIMIT 1`,
                [userId, profileId || null, contentType, contentId, month, year,
                    resolvedHour, seasonNumber || null, episodeNumber || null]
            );

            if (existingRows.length > 0) {
                // Update existing record
                const newDuration = existingRows[0].watch_duration + Math.floor(duration);
                await pool.execute(
                    `UPDATE wrapped_viewing_data SET watch_duration = ? WHERE id = ?`,
                    [newDuration, existingRows[0].id]
                );
            } else {
                // Insert new record
                await pool.execute(
                    `INSERT INTO wrapped_viewing_data 
           (user_id, profile_id, content_type, content_id, content_title, season_number, episode_number, watch_duration, hour_of_day, month, year)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [userId, profileId || null, contentType, contentId, contentTitle || null,
                        seasonNumber || null, episodeNumber || null, Math.floor(duration), 
                        resolvedHour, month, year]
                );
            }
        } else if (type === 'page') {
            // Validate page-specific fields
            if (!pageName) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required field for page: pageName'
                });
            }

            // Try to update existing record for the same page in the same month
            const [existingRows] = await pool.execute(
                `SELECT id, duration FROM wrapped_pages_data 
         WHERE user_id = ? AND profile_id <=> ? AND page_name = ? AND month = ? AND year = ?
         LIMIT 1`,
                [userId, profileId || null, pageName, month, year]
            );

            if (existingRows.length > 0) {
                // Update existing record
                const newDuration = existingRows[0].duration + Math.floor(duration);
                await pool.execute(
                    `UPDATE wrapped_pages_data SET duration = ? WHERE id = ?`,
                    [newDuration, existingRows[0].id]
                );
            } else {
                // Insert new record
                await pool.execute(
                    `INSERT INTO wrapped_pages_data 
           (user_id, profile_id, page_name, duration, meta_data, month, year)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [userId, profileId || null, pageName, Math.floor(duration),
                        meta ? JSON.stringify(meta) : null, month, year]
                );
            }
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Must be "viewing" or "page"'
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Wrapped] Error tracking data:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Generate Wrapped summary using templates (like Spotify - no AI)
 * Header 'x-profile-id': Optional profile ID to filter stats
 *
 * PERFORMANCE: All independent SQL queries run in Promise.all,
 *   TMDB results are cached in Redis (24 h), generated wrapped in Redis (10 min).
 */
router.get('/generate/:year', verifyToken, generateRateLimit, async (req, res) => {
    const _t = { start: Date.now() };
    const { year } = req.params;
    const userId = req.user.sub;
    const profileId = req.headers['x-profile-id'] || req.query.profileId;

    console.log(`[Wrapped][PERF] ── Generate ${year} for user=${userId} profile=${profileId || 'all'} ──`);

    // Validate year parameter
    const parsedYear = parseInt(year);
    if (isNaN(parsedYear) || parsedYear < 2024 || parsedYear > new Date().getFullYear()) {
        return res.status(400).json({ success: false, error: 'Invalid year' });
    }

    if (!pool) {
        return res.status(500).json({ success: false, error: 'Database not initialized' });
    }

    // ── 0. Redis cache check (skip if ?fresh=1) ────────────────────────────────
    const cacheKey = `${WRAPPED_CACHE_PREFIX}${userId}-${profileId || 'all'}-${year}`;
    if (!req.query.fresh) {
        const cached = await redisGet(cacheKey);
        if (cached) {
            try {
                console.log(`[Wrapped][PERF] ⚡ Redis cache HIT — total ${Date.now() - _t.start}ms`);
                return res.json(JSON.parse(cached));
            } catch { /* regenerate */ }
        }
        console.log(`[Wrapped][PERF] Redis cache MISS (${Date.now() - _t.start}ms)`);
    } else {
        console.log(`[Wrapped][PERF] Cache skipped (?fresh=1)`);
    }

    try {
        // Base query conditions
        let whereClause = 'WHERE user_id = ? AND year = ?';
        let queryParams = [userId, year];
        if (profileId) {
            whereClause += ' AND profile_id = ?';
            queryParams.push(profileId);
        }

        // ── Helper: timed query ────────────────────────────────────────────────
        const _sqlTimings = {};
        async function timedQuery(label, queryFn) {
            const t0 = Date.now();
            const result = await queryFn();
            _sqlTimings[label] = Date.now() - t0;
            return result;
        }

        // ── Helper: fetch percentile (Redis cache or SQL fallback) ──────────────
        async function fetchPercentile() {
            const pctCacheKey = `${PERCENTILE_CACHE_PREFIX}${year}`;
            const cachedPct = await redisGet(pctCacheKey);
            if (cachedPct) {
                try {
                    const rankings = JSON.parse(cachedPct);
                    const totalUsers = rankings.length;
                    const userRank = rankings.findIndex(u => u.user_id === userId) + 1;
                    const pct = totalUsers > 1 ? Math.round(((totalUsers - userRank) / totalUsers) * 100) : 99;
                    _sqlTimings['percentile'] = 0;
                    console.log(`[Wrapped][PERF] 📊 Percentile: Redis HIT — rank ${userRank}/${totalUsers} = top ${100 - pct}%`);
                    return pct;
                } catch { /* fallback to SQL */ }
            }
            // Cache froid : ne JAMAIS bloquer la réponse. On renvoie null et on
            // réchauffe le cache en arrière-plan pour les prochains appels.
            _sqlTimings['percentile'] = 0;
            setImmediate(async () => {
                try {
                    // Single-flight cluster-wide : un seul worker lance le scan
                    if (redisReady()) {
                        const lock = await redis.set(`${PERCENTILE_CACHE_PREFIX}${year}:lock`, '1', 'EX', 300, 'NX');
                        if (!lock) return;
                    }
                    const t0 = Date.now();
                    const [allUsersStats] = await pool.execute(`
                        SELECT user_id, ROUND(SUM(watch_duration) / 60) as total
                        FROM wrapped_viewing_data WHERE year = ?
                        GROUP BY user_id ORDER BY total DESC
                    `, [year]);
                    redisSet(pctCacheKey, JSON.stringify(allUsersStats), PERCENTILE_CACHE_TTL);
                    console.log(`[Wrapped][PERF] 📊 Percentile warmup (background): ${Date.now() - t0}ms (${allUsersStats.length} users)`);
                } catch (e) {
                    console.warn('[Wrapped] Percentile warmup failed:', e.message);
                }
            });
            return null;
        }

        // ── 1. Fire ALL queries in parallel (user-scoped + percentile) ──────────
        _t.sqlStart = Date.now();
        const [
            [viewingStats],
            [typeStats],
            [topContentAll],
            [monthlyStats],
            [topPages],
            [hourlyStats],
            [dailyActivity],
            [firstWatch],
            [lastWatch],
            [recordDayRows],
            [weekdayRows],
            [rewatchRows],
            percentile
        ] = await Promise.all([
            // 1. Viewing Stats
            timedQuery('viewingStats', () => pool.execute(`
                SELECT 
                    ROUND(SUM(watch_duration) / 60) as total_duration,
                    COUNT(DISTINCT content_id) as unique_titles,
                    COUNT(*) as total_sessions
                FROM wrapped_viewing_data ${whereClause}
            `, queryParams)),

            // 2. Distribution by Type
            timedQuery('typeStats', () => pool.execute(`
                SELECT content_type, ROUND(SUM(watch_duration) / 60) as duration, COUNT(DISTINCT content_id) as count
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY content_type ORDER BY duration DESC
            `, queryParams)),

            // 3. Top Content (Top 10 — replaces old top5 + top10-genres queries)
            timedQuery('topContent', () => pool.execute(`
                SELECT
                    COALESCE(MAX(NULLIF(content_title, '')), MAX(content_title)) as content_title,
                    content_id,
                    content_type,
                    ROUND(SUM(watch_duration) / 60) as duration
                FROM wrapped_viewing_data ${whereClause}
                AND content_type != 'live-tv'
                GROUP BY content_id, content_type
                ORDER BY duration DESC LIMIT 10
            `, queryParams)),

            // 4. Monthly breakdown
            timedQuery('monthlyStats', () => pool.execute(`
                SELECT month, ROUND(SUM(watch_duration) / 60) as duration
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY month ORDER BY duration DESC
            `, queryParams)),

            // 5. Top Pages
            timedQuery('topPages', () => pool.execute(`
                SELECT page_name, ROUND(SUM(duration) / 60) as duration
                FROM wrapped_pages_data ${whereClause}
                GROUP BY page_name ORDER BY duration DESC LIMIT 5
            `, queryParams)),

            // 6. Time-of-day distribution
            timedQuery('hourlyStats', () => pool.execute(`
                SELECT hour_of_day, ROUND(SUM(watch_duration) / 60) as duration, COUNT(*) as sessions
                FROM wrapped_viewing_data ${whereClause}
                AND hour_of_day IS NOT NULL
                GROUP BY hour_of_day ORDER BY hour_of_day
            `, queryParams)),

            // 7. Watching streaks (consecutive days)
            timedQuery('dailyActivity', () => pool.execute(`
                SELECT DISTINCT DATE(created_at) as watch_date
                FROM wrapped_viewing_data ${whereClause}
                ORDER BY watch_date
            `, queryParams)),

            // 8a. First watch of the year
            timedQuery('firstWatch', () => pool.execute(`
                SELECT content_title, content_type, content_id, created_at
                FROM wrapped_viewing_data ${whereClause}
                AND content_type != 'live-tv'
                ORDER BY created_at ASC LIMIT 1
            `, queryParams)),

            // 8b. Last watch of the year
            timedQuery('lastWatch', () => pool.execute(`
                SELECT content_title, content_type, content_id, created_at
                FROM wrapped_viewing_data ${whereClause}
                AND content_type != 'live-tv'
                ORDER BY created_at DESC LIMIT 1
            `, queryParams)),

            // 9a. Jour record (journée avec le plus de visionnage)
            timedQuery('recordDay', () => pool.execute(`
                SELECT DATE(created_at) as day, ROUND(SUM(watch_duration) / 60) as minutes
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY DATE(created_at) ORDER BY minutes DESC LIMIT 1
            `, queryParams)),

            // 9b. Répartition par jour de semaine (DAYOFWEEK MySQL : 1=dimanche … 7=samedi)
            timedQuery('weekdayStats', () => pool.execute(`
                SELECT DAYOFWEEK(created_at) as dow, ROUND(SUM(watch_duration) / 60) as minutes
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY dow
            `, queryParams)),

            // 9c. Rewatch champion : film revu sur ≥3 jours distincts, ou même épisode revu sur ≥2 jours
            timedQuery('rewatch', () => pool.execute(`
                SELECT content_id, content_type, content_title, distinct_days FROM (
                    SELECT content_id, content_type,
                        COALESCE(MAX(NULLIF(content_title, '')), MAX(content_title)) as content_title,
                        COUNT(DISTINCT DATE(created_at)) as distinct_days
                    FROM wrapped_viewing_data ${whereClause} AND content_type = 'movie'
                    GROUP BY content_id, content_type
                    HAVING distinct_days >= 3
                    UNION ALL
                    SELECT content_id, content_type,
                        COALESCE(MAX(NULLIF(content_title, '')), MAX(content_title)) as content_title,
                        COUNT(DISTINCT DATE(created_at)) as distinct_days
                    FROM wrapped_viewing_data ${whereClause}
                    AND content_type IN ('tv', 'anime') AND season_number IS NOT NULL AND episode_number IS NOT NULL
                    GROUP BY content_id, content_type, season_number, episode_number
                    HAVING distinct_days >= 2
                ) rw ORDER BY distinct_days DESC LIMIT 1
            `, [...queryParams, ...queryParams])),

            // 10. Percentile (Redis-cached 30min, SQL fallback)
            fetchPercentile()
        ]);

        // Derive top5 and top10-for-genres from the single top10 result
        const topContent = topContentAll.slice(0, 5);
        const topContentForGenres = topContentAll; // all 10

        _t.sqlEnd = Date.now();
        const timingsStr = Object.entries(_sqlTimings).map(([k, v]) => `${k}=${v}ms`).join(' | ');
        console.log(`[Wrapped][PERF] 🗄️  SQL+Percentile (10 parallel): ${_t.sqlEnd - _t.sqlStart}ms — ${timingsStr}`);

        const totalMinutes = parseInt(viewingStats[0].total_duration) || 0;
        const uniqueTitles = parseInt(viewingStats[0].unique_titles) || 0;
        const totalSessions = parseInt(viewingStats[0].total_sessions) || 0;
        const totalActiveDays = dailyActivity.length;
        const progress = buildWrappedProgress({ totalMinutes, uniqueTitles, totalSessions, totalActiveDays });

        if (!progress.isEligible) {
            console.log(`[Wrapped][PERF] Not enough data yet — total ${Date.now() - _t.start}ms`);
            return res.json({
                success: true,
                wrapped: null,
                progress,
                message: "Pas encore assez de données pour débloquer ce Wrapped."
            });
        }

        // ── 2. TMDB enrichment (parallel, Redis-cached) ────────────────────────
        _t.tmdbStart = Date.now();

        // Deduplicate: merge top5 + top10-genres + first/last into a single unique set
        const allContentToEnrich = new Map(); // key: "type:id" -> content row
        [...topContent, ...topContentForGenres].forEach(c => {
            const k = `${c.content_type}:${c.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, c);
        });
        const firstWatchData = firstWatch[0] || null;
        const lastWatchData  = lastWatch[0] || null;
        if (firstWatchData && !firstWatchData.content_title) {
            const k = `${firstWatchData.content_type}:${firstWatchData.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, firstWatchData);
        }
        if (lastWatchData && !lastWatchData.content_title) {
            const k = `${lastWatchData.content_type}:${lastWatchData.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, lastWatchData);
        }

        console.log(`[Wrapped][PERF] 🎯 TMDB: ${allContentToEnrich.size} unique items to enrich (deduped from ${topContent.length + topContentForGenres.length + (firstWatchData ? 1 : 0) + (lastWatchData ? 1 : 0)})`);

        // ── Batch TMDB: single MGET for all Redis cache keys, then API-fetch misses ──
        const tmdbCache = new Map(); // key -> details
        const itemsNeedingFetch = []; // [{key, content}] — items not already complete

        // Separate already-complete items from those needing TMDB lookup
        for (const [key, content] of allContentToEnrich) {
            if (content.content_title && content.poster_path) {
                tmdbCache.set(key, { title: content.content_title, poster_path: content.poster_path, genres: content.genres || [], vote_average: content.vote_average || null });
            } else {
                itemsNeedingFetch.push({ key, content });
            }
        }

        if (itemsNeedingFetch.length > 0 && redisReady()) {
            // Build Redis keys for MGET (même pattern que tmdbCache.js)
            const redisKeys = itemsNeedingFetch.map(({ content }) => {
                const mediaType = content.content_type === 'anime' ? 'tv' : content.content_type;
                return `tmdb:details:${mediaType}:${content.content_id}:fr-FR`;
            });

            try {
                const tMget = Date.now();
                const mgetResults = await redis.mget(...redisKeys);
                console.log(`[Wrapped][TMDB] ⚡ MGET ${redisKeys.length} keys in ${Date.now() - tMget}ms`);

                const apiMisses = []; // items not found in Redis
                for (let i = 0; i < itemsNeedingFetch.length; i++) {
                    const { key, content } = itemsNeedingFetch[i];
                    if (mgetResults[i]) {
                        try {
                            tmdbCache.set(key, extractWrappedFields(JSON.parse(mgetResults[i])));
                            continue;
                        } catch { /* treat as miss */ }
                    }
                    apiMisses.push({ key, content });
                }

                // Fetch remaining misses from TMDB API in parallel
                if (apiMisses.length > 0) {
                    console.log(`[Wrapped][TMDB] 🌐 Fetching ${apiMisses.length} items from API (${apiMisses.length} Redis misses)`);
                    await Promise.all(apiMisses.map(async ({ key, content }) => {
                        const details = await fetchTMDBDetails(content.content_id, content.content_type);
                        if (details) tmdbCache.set(key, details);
                    }));
                }
            } catch (mgetErr) {
                // Fallback: parallel individual fetches
                console.warn('[Wrapped][TMDB] MGET failed, falling back to individual fetches:', mgetErr.message);
                await Promise.all(itemsNeedingFetch.map(async ({ key, content }) => {
                    const details = await fetchTMDBDetails(content.content_id, content.content_type);
                    if (details) tmdbCache.set(key, details);
                }));
            }
        } else if (itemsNeedingFetch.length > 0) {
            // No Redis: parallel individual fetches
            await Promise.all(itemsNeedingFetch.map(async ({ key, content }) => {
                const details = await fetchTMDBDetails(content.content_id, content.content_type);
                if (details) tmdbCache.set(key, details);
            }));
        }

        _t.tmdbEnd = Date.now();
        console.log(`[Wrapped][PERF] 🎬 TMDB enrichment: ${_t.tmdbEnd - _t.tmdbStart}ms (${tmdbCache.size} resolved)`);

        // Apply TMDB data back to arrays using the cache
        function applyTMDB(arr) {
            return arr.map(c => {
                const k = `${c.content_type}:${c.content_id}`;
                const d = tmdbCache.get(k);
                if (!d) return { ...c, content_title: c.content_title || `${c.content_type} #${c.content_id}`, poster_path: c.poster_path || null, backdrop_path: null, genres: [], vote_average: null, release_year: null };
                return { ...c, content_title: d.title || c.content_title, poster_path: d.poster_path || c.poster_path || null, backdrop_path: d.backdrop_path || null, genres: d.genres || [], vote_average: d.vote_average || null, release_year: d.release_year || null };
            });
        }
        const enrichedTopContent = applyTMDB(topContent);
        const enrichedForGenres  = applyTMDB(topContentForGenres);

        // Apply to first/last watch
        if (firstWatchData && !firstWatchData.content_title) {
            const d = tmdbCache.get(`${firstWatchData.content_type}:${firstWatchData.content_id}`);
            if (d) firstWatchData.content_title = d.title;
        }
        if (lastWatchData && !lastWatchData.content_title) {
            const d = tmdbCache.get(`${lastWatchData.content_type}:${lastWatchData.content_id}`);
            if (d) lastWatchData.content_title = d.title;
        }

        // ── 3. Compute derived stats (pure JS, no I/O) ─────────────────────────
        _t.computeStart = Date.now();

        // Listening clock: peak hour
        const hourlyMap = new Array(24).fill(0);
        hourlyStats.forEach(h => { hourlyMap[h.hour_of_day] = parseInt(h.duration); });
        const peakHour = hourlyMap.indexOf(Math.max(...hourlyMap));
        const nightOwlMinutes = hourlyMap.slice(22, 24).reduce((a, b) => a + b, 0) + hourlyMap.slice(0, 5).reduce((a, b) => a + b, 0);
        const earlyBirdMinutes = hourlyMap.slice(5, 10).reduce((a, b) => a + b, 0);
        const isNightOwl = nightOwlMinutes > totalMinutes * 0.3;
        const isEarlyBird = earlyBirdMinutes > totalMinutes * 0.3;

        // Watching streaks
        let longestStreak = 0, currentStreak = 0;
        for (let i = 0; i < dailyActivity.length; i++) {
            if (i === 0) { currentStreak = 1; }
            else {
                const prev = new Date(dailyActivity[i - 1].watch_date);
                const curr = new Date(dailyActivity[i].watch_date);
                const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
                currentStreak = diffDays === 1 ? currentStreak + 1 : 1;
            }
            longestStreak = Math.max(longestStreak, currentStreak);
        }

        // Genre analysis
        const genreMinutes = {};
        enrichedForGenres.forEach(item => {
            const mins = parseInt(item.duration);
            (item.genres || []).forEach(genre => {
                genreMinutes[genre] = (genreMinutes[genre] || 0) + mins;
            });
        });
        const topGenres = Object.entries(genreMinutes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, minutes]) => ({ name, minutes, percent: Math.round((minutes / totalMinutes) * 100) }));

        // Monthly graph (all 12 months)
        const monthMap = {};
        monthlyStats.forEach(m => { monthMap[m.month] = parseInt(m.duration); });
        const monthlyGraph = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, minutes: monthMap[i + 1] || 0 }));

        // Session stats
        const avgSessionMinutes = Math.round(totalMinutes / Math.max(totalSessions, 1));

        // Base stats
        const totalHours = Math.round(totalMinutes / 60);
        const totalDays = parseFloat((totalMinutes / 60 / 24).toFixed(1));
        const totalDurationLabel = formatDuration(totalMinutes);

        // Dominant type
        const dominantType = typeStats[0] || { content_type: 'movie', duration: 0, count: 0 };
        const dominantPercent = totalMinutes > 0 ? Math.round((parseInt(dominantType.duration) / totalMinutes) * 100) : 0;

        // Top content
        const topShow = enrichedTopContent[0] || null;
        const topShowMinutes = topShow ? parseInt(topShow.duration) : 0;
        const topShowHours = Math.round(topShowMinutes / 60);
        const topShowDurationLabel = formatDuration(topShowMinutes);
        const topShowTitle = topShow ? topShow.content_title : null;
        const topShowType = topShow ? topShow.content_type : null;

        // Peak / lowest month
        const peakMonth = monthlyStats[0] || { month: 1, duration: 0 };
        const lowestMonth = monthlyStats[monthlyStats.length - 1] || peakMonth;
        const monthNames = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

        // Diversity / loyalty / binge
        const diversityScore = totalHours > 0 ? (uniqueTitles / totalHours) : 0;
        const isExplorer = diversityScore > 0.5;
        const isLoyal = diversityScore < 0.1 && uniqueTitles < 20;
        const isBinger = topShowHours > totalHours * 0.3;

        // Type percents
        const animeStats = typeStats.find(t => t.content_type === 'anime');
        const movieStats = typeStats.find(t => t.content_type === 'movie');
        const tvStats    = typeStats.find(t => t.content_type === 'tv');

        const animePercent = animeStats ? Math.round((parseInt(animeStats.duration) / totalMinutes) * 100) : 0;
        const moviePercent = movieStats ? Math.round((parseInt(movieStats.duration) / totalMinutes) * 100) : 0;
        const tvPercent    = tvStats    ? Math.round((parseInt(tvStats.duration)    / totalMinutes) * 100) : 0;

        // Jour record / weekday / rewatch
        const recordDayRow = recordDayRows[0] || null;
        const recordDay = recordDayRow
            ? { date: recordDayRow.day, minutes: parseInt(recordDayRow.minutes) }
            : null;

        const weekdayMap = new Array(7).fill(0); // index 0 = dimanche … 6 = samedi
        weekdayRows.forEach(r => { weekdayMap[r.dow - 1] = parseInt(r.minutes); });
        const weekday = weekdayMap.map((minutes, i) => ({ dow: i + 1, minutes }));

        const rewatchRow = rewatchRows[0] || null;

        // Âge ciné : année médiane de sortie, pondérée par le temps de visionnage (top 10)
        const datedItems = enrichedForGenres.filter(c => c.release_year);
        let watchAgeYear = null;
        if (datedItems.length >= 5) {
            const sortedByYear = [...datedItems].sort((a, b) => a.release_year - b.release_year);
            const totalWeight = sortedByYear.reduce((s, c) => s + parseInt(c.duration), 0);
            let acc = 0;
            for (const c of sortedByYear) {
                acc += parseInt(c.duration);
                if (acc >= totalWeight / 2) { watchAgeYear = c.release_year; break; }
            }
        }

        let rewatchData = null;
        if (rewatchRow) {
            let rwTitle = rewatchRow.content_title;
            if (!rwTitle) {
                const cached = tmdbCache.get(`${rewatchRow.content_type}:${rewatchRow.content_id}`);
                if (cached) rwTitle = cached.title;
                else {
                    try {
                        const d = await fetchTMDBDetails(rewatchRow.content_id, rewatchRow.content_type);
                        rwTitle = d?.title || null;
                    } catch { /* slide skippée si pas de titre */ }
                }
            }
            if (rwTitle) rewatchData = { title: rwTitle, type: rewatchRow.content_type, count: parseInt(rewatchRow.distinct_days) };
        }

        _t.computeEnd = Date.now();
        console.log(`[Wrapped][PERF] 🧮 Compute stats: ${_t.computeEnd - _t.computeStart}ms`);

        // ── 4. Persona + slides (pure CPU) ──────────────────────────────────────

        const persona = determinePersona({
            totalHours, uniqueTitles, dominantPercent, dominantType,
            animePercent, moviePercent, tvPercent, isExplorer, isLoyal, isBinger,
            topShowType, topShowHours, isNightOwl, isEarlyBird,
            topGenres, avgSessionMinutes, longestStreak, totalSessions, percentile
        });

        const slides = generateSlides({
            totalMinutes, totalHours, totalDays, totalDurationLabel, uniqueTitles,
            topShowTitle, topShowHours, topShowMinutes, topShowDurationLabel, topShowType,
            dominantType, dominantPercent,
            peakMonth, lowestMonth, monthNames,
            animePercent, moviePercent, tvPercent,
            isExplorer, isLoyal, isBinger,
            enrichedTopContent, typeStats, persona,
            year, userId,
            percentile, peakHour, isNightOwl, isEarlyBird,
            longestStreak, totalActiveDays,
            firstWatchData, lastWatchData,
            topGenres, avgSessionMinutes, totalSessions,
            recordDay, rewatchData, watchAgeYear, topPages, weekday
        });

        _t.slidesEnd = Date.now();
        console.log(`[Wrapped][PERF] 🎨 Persona + slides: ${_t.slidesEnd - _t.computeEnd}ms`);

        // ── 5. Build response ───────────────────────────────────────────────────

        const wrapped = {
            year: parseInt(year),
            persona,
            slides,
            stats: {
                totalMinutes, totalHours, totalDays, uniqueTitles,
                totalSessions,
                avgSessionMinutes, totalActiveDays, longestStreak, percentile
            },
            topContent: enrichedTopContent.map((c, i) => {
                const mins = parseInt(c.duration);
                return {
                    rank: i + 1,
                    title: c.content_title,
                    type: c.content_type,
                    minutes: mins,
                    hours: Math.round(mins / 60),
                    durationLabel: formatDurationShort(mins),
                    tmdbId: c.content_type !== 'live-tv' ? parseInt(c.content_id) : null,
                    poster_path: c.poster_path,
                    backdrop_path: c.backdrop_path || null,
                    year: c.release_year || null,
                    vote_average: c.vote_average || null,
                    genres: c.genres || []
                };
            }),
            byType: typeStats.map(t => ({
                type: t.content_type,
                minutes: parseInt(t.duration),
                count: parseInt(t.count),
                percent: Math.round((parseInt(t.duration) / totalMinutes) * 100)
            })),
            topGenres,
            peakMonth: { month: peakMonth.month, name: monthNames[peakMonth.month], minutes: parseInt(peakMonth.duration) },
            monthlyGraph,
            listeningClock: hourlyMap.map((minutes, hour) => ({ hour, minutes })),
            peakHour,
            firstWatch: firstWatchData ? {
                title: firstWatchData.content_title, type: firstWatchData.content_type,
                date: firstWatchData.created_at,
                tmdbId: firstWatchData.content_type !== 'live-tv' ? parseInt(firstWatchData.content_id) : null
            } : null,
            lastWatch: lastWatchData ? {
                title: lastWatchData.content_title, type: lastWatchData.content_type,
                date: lastWatchData.created_at,
                tmdbId: lastWatchData.content_type !== 'live-tv' ? parseInt(lastWatchData.content_id) : null
            } : null,
            topPages: topPages.map(p => ({ page: p.page_name, minutes: parseInt(p.duration) })),
            recordDay,
            weekday,
            rewatch: rewatchData,
            watchAgeYear
        };

        // ── 6. Store in Redis cache (fire-and-forget) ───────────────────────────
        const responsePayload = { success: true, wrapped, progress };
        redisSet(cacheKey, JSON.stringify(responsePayload), WRAPPED_CACHE_TTL);

        const totalTime = Date.now() - _t.start;
        console.log(`[Wrapped][PERF] ── DONE in ${totalTime}ms ── Breakdown: SQL+Pctile(parallel)=${_t.sqlEnd - _t.sqlStart}ms | TMDB=${_t.tmdbEnd - _t.tmdbStart}ms | Compute=${_t.computeEnd - _t.computeStart}ms | Slides=${_t.slidesEnd - _t.computeEnd}ms | Build+Send=${Date.now() - _t.slidesEnd}ms`);

        res.json(responsePayload);

    } catch (error) {
        console.error('[Wrapped] Error generating wrapped:', error);
        res.status(500).json({ success: false, error: 'Generation failed' });
    }
});

// ============================================
// === FONCTIONS DE GÉNÉRATION TEMPLATES ===
// ============================================

// ─── Sélection déterministe (hash FNV-1a) ───────────────────────────────────
// Même Wrapped à chaque ouverture pour un même user/année (screenshots stables).
function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function seededShuffle(array, seedStr) {
    const arr = [...array];
    let seed = fnv1aHash(seedStr);
    for (let i = arr.length - 1; i > 0; i--) {
        seed = Math.imul(seed ^ (seed >>> 15), 0x01000193) >>> 0;
        const j = seed % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ─── Personas par genre dominant (genre #1 ≥ 30% du temps) ──────────────────
const GENRE_PERSONAS = [
    { keys: ['horreur', 'horror', 'épouvante'], persona: { id: 'horror', title: 'L\'Accro aux Frissons', emoji: '👻', subtitle: 'Tu dors la lumière allumée, et alors ?', description: 'L\'horreur, c\'est ton terrain de jeu.', color: '#B71C1C' } },
    { keys: ['thriller', 'crime', 'mystère', 'mystery', 'policier'], persona: { id: 'thriller', title: 'Le Profiler', emoji: '🕵️', subtitle: 'Tu résous l\'enquête avant le générique', description: 'Le suspense, tu carbures à ça.', color: '#37474F' } },
    { keys: ['romance'], persona: { id: 'romance', title: 'Le Grand Romantique', emoji: '💘', subtitle: 'Tu crois encore au grand amour', description: 'Une belle histoire et tu fonds.', color: '#EC407A' } },
    { keys: ['comédie', 'comedy'], persona: { id: 'comedy', title: 'Le Roi du Rire', emoji: '😎', subtitle: 'La vie est trop courte pour le drame', description: 'Tu choisis toujours l\'option qui fait marrer.', color: '#FBC02D' } },
    { keys: ['science-fiction', 'science fiction', 'sci-fi', 'fantastique', 'fantasy'], persona: { id: 'scifi', title: 'Le Voyageur', emoji: '🚀', subtitle: 'Tu vis mieux dans d\'autres mondes', description: 'Plus à l\'aise dans le futur qu\'au présent.', color: '#7E57C2' } },
    { keys: ['documentaire', 'documentary'], persona: { id: 'documentary', title: 'L\'Éternel Curieux', emoji: '🔬', subtitle: 'Tu apprends un truc par épisode', description: 'Le réel te passionne plus que la fiction.', color: '#00897B' } },
    { keys: ['action', 'aventure', 'adventure'], persona: { id: 'action', title: 'L\'Accro à l\'Adrénaline', emoji: '💥', subtitle: 'Plus ça explose, plus t\'es content', description: 'Tu carbures aux poursuites et aux gros boums.', color: '#F4511E' } },
    { keys: ['drame', 'drama'], persona: { id: 'drama', title: 'L\'Âme Sensible', emoji: '🎭', subtitle: 'Tu chiales et t\'assumes', description: 'Les belles histoires, ça te remue.', color: '#5C6BC0' } },
    { keys: ['animation', 'familial', 'family'], persona: { id: 'animation', title: 'Le Grand Enfant', emoji: '🎨', subtitle: 'L\'animation, c\'est pas que pour les petits', description: 'Ton âme d\'enfant se porte très bien.', color: '#26A69A' } },
];

function matchGenrePersona(topGenres) {
    const top = Array.isArray(topGenres) && topGenres[0];
    if (!top || top.percent < 30 || !top.name) return null;
    const name = top.name.toLowerCase();
    for (const g of GENRE_PERSONAS) {
        if (g.keys.some(k => name.includes(k))) return g.persona;
    }
    return null;
}

/**
 * Détermine la personnalité de visionnage de l'utilisateur
 * Basé sur des règles de classification (comme le ML de Spotify)
 */
function determinePersona(data) {
    const {
        totalHours, uniqueTitles, dominantPercent, dominantType,
        animePercent, moviePercent, tvPercent, isExplorer, isLoyal, isBinger,
        topShowType, topShowHours, isNightOwl, isEarlyBird,
        topGenres, avgSessionMinutes, longestStreak, totalSessions, percentile
    } = data;

    const personas = [
        // --- Intensité ---
        { condition: totalHours > 1000, persona: { id: 'legend', title: 'La Légende Vivante', emoji: '👑', subtitle: 'T\'as carrément habité sur Movix', description: 'Plus de 1000h. On devrait te salarier.', color: '#FFD700' } },
        { condition: totalHours > 500, persona: { id: 'marathon', title: 'Le Marathonien Ultime', emoji: '🏃', subtitle: 'Ton canapé a pris ta forme', description: 'T\'as fait du binge un sport olympique.', color: '#FF6B35' } },
        { condition: percentile != null && percentile >= 99 && totalHours > 200, persona: { id: 'elite-1pct', title: 'Le Top 1%', emoji: '💎', subtitle: 'Dans le club très fermé', description: 'Tu regardes plus que 99% des gens ici. Respect.', color: '#00E5FF' } },
        // --- Rythme ---
        { condition: isNightOwl && totalHours > 100, persona: { id: 'night-owl', title: 'L\'Oiseau de Nuit', emoji: '🦉', subtitle: 'La nuit, ton écran est le seul allumé', description: 'Tes meilleures sessions ? Entre minuit et 5h.', color: '#1A237E' } },
        { condition: isEarlyBird && totalHours > 100, persona: { id: 'early-bird', title: 'Le Lève-tôt', emoji: '🌅', subtitle: 'Un épisode avant le café', description: 'Tu lances Movix quand les autres dorment encore.', color: '#FF8A65' } },
        // --- Type dominant ---
        { condition: animePercent > 80, persona: { id: 'weeb-supreme', title: 'Weeb Suprême', emoji: '⛩️', subtitle: 'Tu penses en sous-titres', description: '+80% d\'anime. T\'es plus à Tokyo qu\'à Paris.', color: '#E91E63' } },
        { condition: animePercent > 50, persona: { id: 'otaku', title: 'L\'Otaku Assumé', emoji: '🍜', subtitle: 'Ton cœur bat au rythme des openings', description: 'L\'anime, c\'est pas une phase, c\'est un mode de vie.', color: '#9C27B0' } },
        { condition: moviePercent > 70 && uniqueTitles > 50, persona: { id: 'critic', title: 'Le Critique', emoji: '🎬', subtitle: 'Un avis sur tout, et souvent le bon', description: 'Tu pourrais noter des films pour de vrai.', color: '#2196F3' } },
        { condition: moviePercent > 70, persona: { id: 'cinephile', title: 'Le Cinéphile', emoji: '🎥', subtitle: 'Le 7e art coule dans tes veines', description: 'Les films, c\'est ta religion.', color: '#3F51B5' } },
        { condition: tvPercent > 70 && isBinger, persona: { id: 'binger', title: 'Le Binge-Watcher Pro', emoji: '📺', subtitle: '"Encore un épisode" = ton mantra', description: 'Tu regardes pas les séries, tu les dévores.', color: '#4CAF50' } },
        { condition: tvPercent > 50, persona: { id: 'series-addict', title: 'L\'Accro aux Séries', emoji: '📡', subtitle: 'Plus de persos fictifs que d\'amis (gentiment)', description: 'Les séries, c\'est ta deuxième famille.', color: '#009688' } },
    ];

    for (const p of personas) {
        if (p.condition === true) return p.persona;
    }

    // --- Genre dominant (si ≥30% du temps) ---
    const genrePersona = matchGenrePersona(topGenres);
    if (genrePersona) return genrePersona;

    // --- Comportement ---
    const behaviorPersonas = [
        { condition: isExplorer && uniqueTitles > 100, persona: { id: 'explorer-elite', title: 'L\'Explorateur d\'Élite', emoji: '🧭', subtitle: 'Tu connais des trucs que personne connaît', description: '+100 titres. La curiosité incarnée.', color: '#FF9800' } },
        { condition: isExplorer, persona: { id: 'explorer', title: 'L\'Explorateur', emoji: '🔍', subtitle: 'Toujours en chasse de la prochaine pépite', description: 'Tu préfères découvrir que revoir.', color: '#FFC107' } },
        { condition: totalSessions > 50 && avgSessionMinutes < 25, persona: { id: 'snacker', title: 'Le Grignoteur', emoji: '🍿', subtitle: 'Tu mates par petites bouchées', description: 'Sessions courtes mais souvent. Le snacking version streaming.', color: '#FF7043' } },
        { condition: longestStreak >= 14, persona: { id: 'streak-machine', title: 'La Machine', emoji: '⚙️', subtitle: 'Aucun jour off', description: 'T\'enchaînes les jours sans jamais lâcher.', color: '#607D8B' } },
        { condition: isLoyal && topShowHours > 50, persona: { id: 'superfan', title: 'Le Superfan', emoji: '💜', subtitle: 'T\'as trouvé TON truc, tu lâches plus', description: 'La loyauté, c\'est ta signature.', color: '#673AB7' } },
        { condition: isLoyal, persona: { id: 'comfort-watcher', title: 'L\'Amateur de Confort', emoji: '🛋️', subtitle: 'Pourquoi changer une équipe qui gagne ?', description: 'Tu remates tes classiques, et c\'est très bien.', color: '#795548' } },
        { condition: dominantPercent < 45, persona: { id: 'omnivore', title: 'Le Touche-à-tout', emoji: '🎲', subtitle: 'Films, séries, anime : tu prends tout', description: 'Aucune case te résume. L\'équilibre parfait.', color: '#26C6DA' } },
    ];

    for (const p of behaviorPersonas) {
        if (p.condition === true) return p.persona;
    }

    // --- Défauts par type dominant ---
    const defaultPersonas = {
        'anime': { id: 'anime-fan', title: 'L\'Anime Fan', emoji: '✨', subtitle: 'L\'animation japonaise te parle', description: 'Un bel équilibre d\'anime dans ta vie.', color: '#E91E63' },
        'movie': { id: 'movie-lover', title: 'L\'Amoureux du Cinéma', emoji: '🍿', subtitle: 'Rien ne vaut un bon film', description: 'Tu sais apprécier une bonne histoire.', color: '#2196F3' },
        'tv': { id: 'tv-enthusiast', title: 'L\'Enthousiaste des Séries', emoji: '📺', subtitle: 'Les séries rythment ta routine', description: 'Un épisode par jour éloigne le médecin.', color: '#4CAF50' },
        'live-tv': { id: 'live-watcher', title: 'Le Téléspectateur', emoji: '📡', subtitle: 'Toujours branché sur le direct', description: 'La TV en direct, c\'est ton truc.', color: '#607D8B' }
    };

    return defaultPersonas[dominantType.content_type] || defaultPersonas['movie'];
}

/**
 * Formate une durée en minutes : affiche les heures si >= 60 min, sinon les minutes
 * @param {number} minutes
 * @returns {string} e.g. "12 heures" ou "45 minutes"
 */
function formatDuration(minutes) {
    if (minutes >= 60) {
        const h = Math.round(minutes / 60);
        return `${h} heure${h > 1 ? 's' : ''}`;
    }
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

/**
 * Version courte : "12h" ou "45min"
 */
function formatDurationShort(minutes) {
    if (minutes >= 60) {
        return `${Math.round(minutes / 60)}h`;
    }
    return `${minutes}min`;
}

/**
 * Génère les slides du Wrapped v2
 */
function generateSlides(data) {
    const {
        totalMinutes, totalHours, totalDays, totalDurationLabel, uniqueTitles,
        topShowTitle, topShowHours, topShowMinutes, topShowDurationLabel,
        dominantType, dominantPercent,
        peakMonth, lowestMonth, monthNames,
        enrichedTopContent, persona,
        year, userId,
        percentile, peakHour, isNightOwl, isEarlyBird,
        longestStreak, totalActiveDays,
        firstWatchData,
        topGenres, avgSessionMinutes,
        isExplorer, isBinger,
        recordDay, rewatchData, watchAgeYear, topPages, weekday
    } = data;

    const slides = [];
    const seed = `${userId}:${year}`;
    const shortLabel = formatDurationShort(totalMinutes);
    // Variante seedée par user+slide : chaque utilisateur tombe sur une formulation
    // différente, mais stable d'une ouverture à l'autre (screenshots reproductibles).
    const pick = (key, variants) => variants[fnv1aHash(`${seed}:${key}`) % variants.length];

    // === 1. INTRO ===
    const introTemplates = [
        {
            condition: totalHours > 500,
            title: pick('intro-t', [`${year}, hors catégorie.`, `${year}, niveau final.`]),
            subtitle: 'On a recompté trois fois, c\'est réel.',
            texts: [
                `${totalDurationLabel} de visionnage, soit ${totalDays} jours complets devant un écran. T'es plus un utilisateur, t'es un pilier de Movix.`,
                `${totalDurationLabel} cette année. Des séries entières sont nées et mortes pendant que toi, t'étais là.`,
                `${totalDurationLabel} au compteur. Ton canapé devrait être classé monument historique.`
            ],
            highlight: `${totalDays} jours`
        },
        {
            condition: totalHours > 300,
            title: pick('intro-t', [`${year}, du très lourd.`, `${year}, régime intensif.`]),
            subtitle: 'Et c\'est peu de le dire.',
            texts: [
                `${totalDurationLabel} sur Movix, soit ${totalDays} jours non-stop. Le canapé a officiellement pris ta forme.`,
                `${totalDurationLabel} de visionnage. Certains font des marathons. Toi, t'as couru toute l'année.`,
                `${totalDurationLabel} cette année. Quelque part entre la passion et le record du monde.`
            ],
            highlight: `${totalDays} jours`
        },
        {
            condition: totalHours > 200,
            title: `${year}, t'as tout donné.`,
            subtitle: 'Et on a tout vu.',
            texts: [
                `${totalDurationLabel} sur Movix cette année. Soit ${totalDays} jours non-stop. À ce stade, c'est plus un hobby, c'est un mode de vie.`,
                `${totalDurationLabel} de visionnage, ${totalDays} jours pleins. T'as pas regardé une année, t'en as vécu deux.`,
                `${totalDurationLabel} au total. Si regarder était un sport, t'aurais une fédération à ton nom.`
            ],
            highlight: `${totalDays} jours`
        },
        {
            condition: totalHours > 100,
            title: pick('intro-t', [`${year}, bien rempli.`, `${year}, sacré rythme.`]),
            subtitle: 'Et ton historique le prouve.',
            texts: [
                `${totalDurationLabel} de visionnage. Genre, plus que certains mi-temps de boulot. Validé.`,
                `${totalDurationLabel} cette année. T'as trouvé ton rythme de croisière, et il est soutenu.`,
                `${totalDurationLabel} sur Movix. Une vraie deuxième vie, bien remplie.`
            ],
            highlight: shortLabel
        },
        {
            condition: totalHours > 50,
            title: `Solide, ${year}.`,
            subtitle: 'Vraiment solide.',
            texts: [
                `${totalDurationLabel} sur Movix. Tu sais ce que t'aimes, et tu fonces.`,
                `${totalDurationLabel} de visionnage. Pas d'excès, pas de manque : l'équilibre du connaisseur.`,
                `${totalDurationLabel} cette année. Régulier, précis, efficace.`
            ],
            highlight: shortLabel
        },
        {
            condition: totalHours > 20,
            title: pick('intro-t', [`${year}, tranquille.`, `${year}, en finesse.`]),
            subtitle: 'Mais efficace.',
            texts: [
                `${totalDurationLabel} bien choisies. Toi, tu regardes pas beaucoup — tu regardes bien.`,
                `${totalDurationLabel} au compteur. La qualité avant la quantité, toujours.`,
                `${totalDurationLabel} cette année. Chaque session compte, rien au hasard.`
            ],
            highlight: shortLabel
        },
        {
            condition: true,
            title: `${year}, avec toi.`,
            subtitle: 'Et c\'est déjà pas mal.',
            texts: [
                `${totalDurationLabel} ensemble cette année. Le début d'une belle histoire.`,
                `${totalDurationLabel} passées ici. On espère que c'était que du bon.`
            ],
            highlight: shortLabel
        }
    ];
    const introTpl = introTemplates.find(t => t.condition);
    slides.push({ type: 'intro', title: introTpl.title, subtitle: introTpl.subtitle, text: pick('intro', introTpl.texts), highlight: introTpl.highlight });

    // === 2. TIMELINE (remplace peak-month) ===
    const peakMonthMinutes = parseInt(peakMonth.duration);
    const peakMonthLabel = formatDuration(peakMonthMinutes);
    const peakName = monthNames[peakMonth.month];
    const lowestName = monthNames[lowestMonth.month];
    const avgMonthlyMinutes = totalMinutes / 12;
    const peakRatio = avgMonthlyMinutes > 0 ? peakMonthMinutes / avgMonthlyMinutes : 1;
    let timelineText;
    if (peakMonth.month === lowestMonth.month) {
        timelineText = `${peakName}, ton pic absolu : ${peakMonthLabel} en un seul mois.`;
    } else if (peakRatio >= 3) {
        timelineText = pick('timeline', [
            `${peakName} a tout écrasé : ${peakMonthLabel} à lui seul. Il s'est passé un truc en ${peakName.toLowerCase()}, avoue.`,
            `${peakMonthLabel} rien qu'en ${peakName.toLowerCase()}. Le reste de l'année regardait de loin.`,
            `${peakName} en mode rouleau compresseur (${peakMonthLabel}), pendant que ${lowestName.toLowerCase()} comptait les jours.`
        ]);
    } else {
        timelineText = pick('timeline', [
            `${peakName} en feu (${peakMonthLabel}), ${lowestName.toLowerCase()} fantôme. Chacun son rythme.`,
            `${peakName} au sommet avec ${peakMonthLabel}, ${lowestName.toLowerCase()} en mode avion. L'année a eu ses saisons.`,
            `Gros pic en ${peakName.toLowerCase()} (${peakMonthLabel}), calme plat en ${lowestName.toLowerCase()}. Une année avec du relief.`
        ]);
    }
    slides.push({
        type: 'timeline',
        title: 'Ton année en courbe',
        subtitle: `${peakName}, ton mois fort`,
        text: timelineText,
        highlight: '📈',
        subtext: peakMonthMinutes > 3000 ? pick('timeline-s', ['On constate, on ne juge pas.', 'Aucun jugement. Beaucoup de respect.']) : ''
    });

    // === 3. TOP GENRES ===
    if (topGenres && topGenres.length >= 2) {
        const topGenreNames = topGenres.slice(0, 3).map(g => g.name).join(', ');
        slides.push({
            type: 'top-genres',
            title: pick('genres-t', ['Tes genres de prédilection', 'Ton ADN de spectateur', 'Ta palette de l\'année']),
            subtitle: topGenreNames,
            text: topGenres.length >= 3
                ? pick('genres', [
                    `${topGenres[0].name} mène la danse avec ${topGenres[0].percent}% de ton temps. Juste derrière : ${topGenres[1].name} et ${topGenres[2].name}.`,
                    `${topGenres[0].name} en tête (${topGenres[0].percent}% de ton temps), talonné par ${topGenres[1].name} et ${topGenres[2].name}. Le trio gagnant.`,
                    `Ton podium des genres : ${topGenres[0].name} (${topGenres[0].percent}%), puis ${topGenres[1].name} et ${topGenres[2].name}. Une signature bien à toi.`
                ])
                : `${topGenres[0].name} mène la danse avec ${topGenres[0].percent}% de ton temps.`,
            highlight: '🎭',
            subtext: ''
        });
    }

    // === 4. TOP 1 (le quiz client s'insère juste avant côté frontend) ===
    if (topShowTitle) {
        const top1Templates = [
            {
                condition: topShowHours > 200,
                subtitle: 'Ton année lui appartient',
                texts: [
                    `${topShowDurationLabel} dessus. C'est plus du visionnage, c'est une colocation.`,
                    `${topShowDurationLabel} passées ensemble. Vous devriez officialiser, là.`,
                    `${topShowDurationLabel} sur ce titre. Tu pourrais doubler les personnages de mémoire.`
                ],
                subtext: 'Iconique. Légèrement inquiétant. Surtout iconique.'
            },
            {
                condition: topShowHours > 100,
                subtitle: 'Ton obsession de l\'année',
                texts: [
                    `${topShowDurationLabel} dessus. Tu pourrais en écrire la suite les yeux fermés.`,
                    `${topShowDurationLabel} passées dessus. Les acteurs eux-mêmes l'ont moins vu que toi.`,
                    `${topShowDurationLabel} sur ce titre. À ce niveau, c'est plus un programme, c'est un membre de la famille.`
                ],
                subtext: 'Un peu gênant. Beaucoup iconique.'
            },
            {
                condition: topShowHours > 50,
                subtitle: 'Ton grand gagnant',
                texts: [
                    `${topShowDurationLabel} ensemble. Vous êtes officiellement en couple.`,
                    `${topShowDurationLabel} dessus. Le genre de fidélité qui se fait rare.`,
                    `${topShowDurationLabel} passées dessus. Coup de cœur confirmé, et largement assumé.`
                ],
                subtext: 'Fan n°1 ? C\'est toi.'
            },
            {
                condition: topShowHours > 20,
                subtitle: 'Ta grande histoire de l\'année',
                texts: [
                    `${topShowDurationLabel} dessus. Plus que certaines vraies relations.`,
                    `${topShowDurationLabel} ensemble. Une belle histoire, sans drama (enfin, sauf à l'écran).`,
                    `${topShowDurationLabel} passées dessus. Vous deux, c'était évident.`
                ],
                subtext: 'On ne juge pas.'
            },
            {
                condition: true,
                subtitle: 'Ton préféré de l\'année',
                texts: [
                    `${topShowDurationLabel} passées dessus. Un classique gravé dans ton cœur.`,
                    `${topShowDurationLabel} dessus. Le titre qui a gagné ton année, tout simplement.`
                ],
                subtext: ''
            }
        ];
        const tpl = top1Templates.find(t => t.condition);
        slides.push({ type: 'top1', title: `"${topShowTitle}"`, subtitle: tpl.subtitle, text: pick('top1', tpl.texts), highlight: '#1', subtext: tpl.subtext });
    }

    // === 5. TOP 5 ===
    if (enrichedTopContent.length >= 3) {
        const top5Text = enrichedTopContent.slice(0, 5).map((c, i) => `${i + 1}. ${c.content_title}`).join('\n');
        slides.push({
            type: 'top5',
            title: 'Ton Top 5',
            subtitle: pick('top5-s', ['Le casting de ton année', 'Tes têtes d\'affiche', 'Le grand palmarès']),
            text: top5Text,
            highlight: `${uniqueTitles} titres en tout`,
            subtext: uniqueTitles > 200
                ? pick('top5-x', ['Encyclopédie vivante.', 'Une vidéothèque entière à toi tout seul.'])
                : uniqueTitles > 50 ? 'Incollable.' : ''
        });
    }

    // === 6. REWATCH (conditionnelle) ===
    if (rewatchData) {
        const rwTexts = rewatchData.count >= 5
            ? [
                `${rewatchData.count} fois sur "${rewatchData.title}" cette année. Tu connais les répliques avant les acteurs.`,
                `T'es revenu ${rewatchData.count} fois sur "${rewatchData.title}". C'est plus un rewatch, c'est un pèlerinage.`
            ]
            : rewatchData.count >= 3
                ? [
                    `T'es revenu ${rewatchData.count} fois sur "${rewatchData.title}". Le confort a un nom.`,
                    `${rewatchData.count} visites à "${rewatchData.title}" cette année. Quand on aime, on recompte pas.`
                ]
                : [
                    `Deux fois sur "${rewatchData.title}" cette année. Quand c'est bon, c'est bon.`,
                    `"${rewatchData.title}", vu et revu. Certaines histoires méritent une deuxième séance.`
                ];
        slides.push({
            type: 'rewatch',
            title: 'Ton revenant',
            subtitle: rewatchData.type === 'movie' ? 'Le film qui te lâche pas' : 'L\'épisode que tu relances en boucle',
            text: pick('rewatch', rwTexts),
            highlight: `×${rewatchData.count}`,
            subtext: pick('rewatch-s', ['Les classiques, ça se respecte.', 'La valeur sûre, c\'est sacré.'])
        });
    }

    // === 7. RECORD DAY (conditionnelle, > 3h) ===
    if (recordDay && recordDay.minutes > 180) {
        const recordDate = new Date(recordDay.date);
        const recordDateLabel = recordDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
        const recordLabel = formatDuration(recordDay.minutes);
        const recordTpl = recordDay.minutes > 480
            ? {
                title: 'Ta journée hors norme',
                texts: [
                    `${recordLabel} en une seule journée. Une performance. La médaille arrive par la poste.`,
                    `${recordLabel} d'affilée ce jour-là. Le soleil s'est levé et couché sans toi.`,
                    `${recordLabel} en 24h. On appelle plus ça une journée, on appelle ça un festival.`
                ],
                subtext: 'Journée rentrée dans la légende.'
            }
            : recordDay.minutes > 300
                ? {
                    title: 'Ta journée légendaire',
                    texts: [
                        `${recordLabel} en une seule journée. On sait pas ce qui s'est passé, mais c'était du sérieux.`,
                        `${recordLabel} ce jour-là. Pluie dehors ou grosse flemme : dans tous les cas, bien joué.`,
                        `${recordLabel} en un jour. La définition même du jour parfait.`
                    ],
                    subtext: 'Journée certifiée canapé.'
                }
                : {
                    title: 'Ta plus grosse journée',
                    texts: [
                        `${recordLabel} en une journée. Ton record perso de l'année.`,
                        `${recordLabel} ce jour-là. Une après-midi bien investie.`
                    ],
                    subtext: ''
                };
        slides.push({
            type: 'record-day',
            title: recordTpl.title,
            subtitle: `Le ${recordDateLabel}`,
            text: pick('record', recordTpl.texts),
            highlight: formatDurationShort(recordDay.minutes),
            subtext: recordTpl.subtext
        });
    }

    // === 8. LISTENING CLOCK (+ weekday rendu côté front) ===
    const hourLabel = (h) => `${h}h`;
    const clockTemplates = [
        {
            condition: isNightOwl,
            title: 'Team nuit',
            subtitle: `Ton pic : ${hourLabel(peakHour)}`,
            texts: [
                `Pendant que le monde dort, toi tu lances un épisode. Les cernes, c'est le prix de la passion.`,
                `Tes meilleures sessions commencent quand les autres éteignent. La nuit te réussit.`,
                `Minuit passé, un épisode de plus. Le club des noctambules te salue.`
            ],
            highlight: '🌙',
            subtext: 'Les meilleures sessions, c\'est la nuit.'
        },
        {
            condition: isEarlyBird,
            title: 'Team matin',
            subtitle: `Ton pic : ${hourLabel(peakHour)}`,
            texts: [
                `Un épisode avant même le café. Respect total.`,
                `Toi, tu commences la journée par un générique. Et franchement, c'est une bonne routine.`
            ],
            highlight: '🌅',
            subtext: ''
        },
        {
            condition: peakHour >= 18 && peakHour <= 23,
            title: 'Team prime time',
            subtitle: `Ton pic : ${hourLabel(peakHour)}`,
            texts: [
                `${hourLabel(peakHour)}, le canapé t'appelle, et tu réponds toujours présent. La grande tradition de la soirée écran.`,
                `Le soir venu, c'est ton moment. ${hourLabel(peakHour)} pétantes, et c'est parti.`,
                `Ta journée se termine toujours pareil : ${hourLabel(peakHour)}, plaid, lecture. La routine parfaite.`
            ],
            highlight: '🛋️',
            subtext: ''
        },
        {
            condition: peakHour >= 12 && peakHour < 18,
            title: 'Team après-midi',
            subtitle: `Ton pic : ${hourLabel(peakHour)}`,
            texts: [
                `C'est en pleine après-midi que tu lances le plus souvent Movix. La pause de ${hourLabel(peakHour)}, c'est sacré.`,
                `${hourLabel(peakHour)} : l'heure où ta journée fait une pause et où Movix prend le relais.`
            ],
            highlight: '☀️',
            subtext: ''
        },
        {
            condition: true,
            title: `${hourLabel(peakHour)}, ton heure de pointe`,
            subtitle: 'Ton horloge Movix',
            texts: [
                `C'est vers ${hourLabel(peakHour)} que tu lances Movix le plus souvent. On connaît tes habitudes maintenant.`,
                `${hourLabel(peakHour)}, ton rendez-vous quotidien. La ponctualité, c'est une qualité.`
            ],
            highlight: '⏰',
            subtext: ''
        }
    ];
    const clockTpl = clockTemplates.find(t => t.condition);
    slides.push({ type: 'listening-clock', title: clockTpl.title, subtitle: clockTpl.subtitle, text: pick('clock', clockTpl.texts), highlight: clockTpl.highlight, subtext: clockTpl.subtext });

    // === 9. STREAK (durées réelles : mois/semaines calculés, pas d'à-peu-près) ===
    if (longestStreak >= 3) {
        const streakMonths = Math.floor(longestStreak / 30);
        const streakWeeks = Math.floor(longestStreak / 7);
        const streakTemplates = [
            {
                condition: longestStreak >= 90,
                title: `${longestStreak} jours d'affilée`,
                subtitle: `${streakMonths} mois sans lâcher`,
                texts: [
                    `${longestStreak} jours consécutifs, soit ${streakMonths} mois pleins sans en rater un seul. C'est plus de la constance, c'est un serment.`,
                    `${longestStreak} jours d'affilée. Des saisons entières ont commencé et fini pendant ta série.`
                ],
                highlight: '🏆',
                subtext: `Sur ${totalActiveDays} jours actifs cette année.`
            },
            {
                condition: longestStreak >= 60,
                title: `${longestStreak} jours d'affilée`,
                subtitle: `${streakMonths} mois complets, jour après jour`,
                texts: [
                    `${longestStreak} jours consécutifs, soit ${streakMonths} mois entiers sans interruption. C'est plus une habitude, c'est un mode de vie.`,
                    `${longestStreak} jours d'affilée. Le soleil a eu plus de jours off que toi.`,
                    `${longestStreak} jours sans en manquer un. ${streakMonths} mois de fidélité absolue, ça se signe quelque part ?`
                ],
                highlight: '🔥',
                subtext: `Sur ${totalActiveDays} jours actifs cette année.`
            },
            {
                condition: longestStreak >= 30,
                title: `${longestStreak} jours d'affilée`,
                subtitle: 'Un mois entier non-stop',
                texts: [
                    `Ta plus longue série : ${longestStreak} jours consécutifs. On appelle ça une légende.`,
                    `${longestStreak} jours sans interruption. Un mois complet de rendez-vous quotidien.`
                ],
                highlight: '🔥',
                subtext: `Sur ${totalActiveDays} jours actifs cette année.`
            },
            {
                condition: longestStreak >= 14,
                title: `${longestStreak} jours non-stop`,
                subtitle: `${streakWeeks} semaines sans lâcher`,
                texts: [
                    `${streakWeeks} semaines sans lâcher Movix. Discipline de fer (pour le streaming au moins).`,
                    `${longestStreak} jours d'affilée. La régularité d'une montre suisse, le plaisir en plus.`
                ],
                highlight: '⚡',
                subtext: `${totalActiveDays} jours actifs au total.`
            },
            {
                condition: longestStreak >= 7,
                title: `${longestStreak} jours non-stop`,
                subtitle: 'Une semaine de dévotion',
                texts: [
                    `${longestStreak} jours sans interruption. Ça, c'est de la constance.`,
                    `Une semaine entière sans rater un jour. Le rituel était bien rodé.`
                ],
                highlight: '💪',
                subtext: ''
            },
            {
                condition: true,
                title: `${longestStreak} jours de streak`,
                subtitle: 'Ta meilleure série',
                texts: [
                    `${longestStreak} jours consécutifs. Pas mal du tout.`,
                    `${longestStreak} jours d'affilée. Une jolie petite série.`
                ],
                highlight: '🎯',
                subtext: ''
            }
        ];
        const streakTpl = streakTemplates.find(t => t.condition);
        slides.push({ type: 'streak', title: streakTpl.title, subtitle: streakTpl.subtitle, text: pick('streak', streakTpl.texts), highlight: streakTpl.highlight, subtext: streakTpl.subtext });
    }

    // === 10. PAGES TIME (conditionnelle, ≥ 60 min hors live-tv) ===
    const pageLabels = {
        'home': 'la page d\'accueil', 'movies': 'les films', 'tv-shows': 'les séries',
        'movie-details': 'les fiches films', 'tv-details': 'les fiches séries',
        'wishboard': 'le wishboard', 'watchparty': 'les watchparties', 'anime': 'les animes'
    };
    const browsePages = (topPages || []).filter(p => p.page_name !== 'live-tv' && pageLabels[p.page_name]);
    const browseTotal = browsePages.reduce((s, p) => s + parseInt(p.duration), 0);
    if (browsePages.length > 0 && browseTotal >= 60) {
        const topPage = browsePages[0];
        const browseLabel = formatDuration(browseTotal);
        const pageTexts = {
            'home': [
                `${browseLabel} à scroller la page d'accueil. Hésiter, re-scroller, hésiter encore : un art de vivre.`,
                `${browseLabel} sur la home avant de te décider. Le choix, c'est toute une aventure.`
            ],
            'movie-details': [
                `${browseLabel} à éplucher les fiches films. Toi, tu lances jamais rien sans avoir lu le dossier complet.`,
                `${browseLabel} sur les fiches. Synopsis, note, casting : rien ne t'échappe avant le premier clic.`
            ],
            'tv-details': [
                `${browseLabel} à éplucher les fiches séries. Toi, tu lances jamais rien sans avoir lu le dossier complet.`,
                `${browseLabel} sur les fiches. Synopsis, note, saisons : rien ne t'échappe avant le premier clic.`
            ],
            'wishboard': [
                `${browseLabel} sur ton wishboard. Collectionner les envies, c'est déjà la moitié du plaisir.`,
                `${browseLabel} à organiser ta liste. Ta pile « à voir » est une œuvre en soi.`
            ],
            'watchparty': [
                `${browseLabel} en watchparty. Regarder seul ? Très peu pour toi.`,
                `${browseLabel} passées à mater à plusieurs. Le cinéma, c'est mieux accompagné.`
            ]
        };
        const genericTexts = [
            `${browseLabel} à naviguer sur Movix, surtout sur ${pageLabels[topPage.page_name]}. L'art de choisir, c'est tout un sport.`,
            `${browseLabel} de balade dans le catalogue, ${pageLabels[topPage.page_name]} en tête. Flâner, c'est déjà regarder un peu.`
        ];
        slides.push({
            type: 'pages-time',
            title: 'Là où tu traînes',
            subtitle: 'Avant même de lancer un titre',
            text: pick('pages', pageTexts[topPage.page_name] || genericTexts),
            highlight: formatDurationShort(browseTotal),
            subtext: pick('pages-s', ['L\'indécision, on connaît.', 'Le lèche-vitrine version streaming.'])
        });
    }

    // === 11. WATCH AGE (conditionnelle, paliers d'époque) ===
    if (watchAgeYear) {
        const ageTpl = watchAgeYear >= year - 2
            ? {
                title: 'Toujours sur la hype',
                texts: [
                    `La moitié de ton temps sur des titres tout frais. T'es la hype incarnée.`,
                    `Tu regardes ce qui vient de sortir, point. Toujours au courant avant tout le monde.`
                ]
            }
            : watchAgeYear < 2000
                ? {
                    title: `Ton cœur vit en ${watchAgeYear}`,
                    texts: [
                        `La moitié de ton temps sur des titres d'avant ${watchAgeYear}. Le grain de l'ancien, le charme du classique : du patrimoine à l'état pur.`,
                        `Ton année médiane : ${watchAgeYear}. Pendant que tout le monde court après les nouveautés, toi tu sirotes les classiques.`
                    ]
                }
                : watchAgeYear < 2015
                    ? {
                        title: `Ton cœur vit en ${watchAgeYear}`,
                        texts: [
                            `La moitié de ton temps sur des titres d'avant ${watchAgeYear}. La nostalgie te va bien.`,
                            `${watchAgeYear}, ton point d'équilibre. Cette époque-là avait quelque chose, pas vrai ?`
                        ]
                    }
                    : {
                        title: `Ton cœur vit en ${watchAgeYear}`,
                        texts: [
                            `Entre deux époques : la moitié de ton visionnage date d'avant ${watchAgeYear}. Le meilleur des deux mondes.`,
                            `${watchAgeYear} en année médiane. Ni tout neuf, ni vintage : juste ce qui te plaît.`
                        ]
                    };
        slides.push({
            type: 'watch-age',
            title: ageTpl.title,
            subtitle: 'Ton âge ciné',
            text: pick('age', ageTpl.texts),
            highlight: String(watchAgeYear),
            subtext: ''
        });
    }

    // === 12. FUN FACTS (pool élargi, sélection seedée — 1, +1 si > 50h) ===
    const funFacts = [];
    if (totalHours > 24) {
        const equivalent = Math.floor(totalHours / 2);
        funFacts.push({
            title: 'En vrai...', subtitle: '',
            text: pick('ff-eq', [
                `T'aurais pu enchaîner ${equivalent} films. Ou dormir ${totalDays} jours. T'as fait un choix.`,
                `${totalDurationLabel}, c'est ${equivalent} films bout à bout. Ou ${Math.max(2, Math.floor(totalHours / 12))} vols Paris-Tokyo. T'as choisi le canapé, et on comprend.`
            ]),
            highlight: '🤔', subtext: 'Le bon.'
        });
    } else if (totalMinutes > 30) {
        funFacts.push({ title: 'En vrai...', subtitle: '', text: `${totalDurationLabel} de streaming. Joli début pour cette année.`, highlight: '🤔', subtext: 'Et c\'est que le début.' });
    }
    if (isExplorer && uniqueTitles > 30) {
        funFacts.push({
            title: 'L\'algo t\'adore', subtitle: '',
            text: pick('ff-explo', [
                `${uniqueTitles} titres différents. Tu rends nos recommandations folles (dans le bon sens).`,
                `${uniqueTitles} titres explorés cette année. Notre catalogue te dit merci pour la visite guidée.`
            ]),
            highlight: '🧠', subtext: ''
        });
    }
    if (isBinger && topShowTitle) {
        const percentOfTotal = totalMinutes > 0 ? Math.round((topShowMinutes / totalMinutes) * 100) : 0;
        funFacts.push({
            title: 'Petite confession', subtitle: '',
            text: pick('ff-binge', [
                `"${topShowTitle}" = ${percentOfTotal}% de ton temps total. Ça, c'est de l'engagement.`,
                `${percentOfTotal}% de ton année entière sur "${topShowTitle}". Un placement assumé.`
            ]),
            highlight: '💍', subtext: 'Ou de l\'obsession. On compte pas.'
        });
    }
    if (percentile != null && percentile >= 90) {
        funFacts.push({ title: `Top ${100 - percentile}% des viewers`, subtitle: 'Carrément l\'élite', text: `Tu regardes plus que ${percentile}% des gens sur Movix. Médaille méritée.`, highlight: '🏆', subtext: '' });
    }
    if (avgSessionMinutes > 90) {
        funFacts.push({
            title: 'Sessions marathon', subtitle: '',
            text: pick('ff-sess', [
                `Tes sessions durent ${formatDuration(avgSessionMinutes)} en moyenne. Tu fais pas les choses à moitié.`,
                `${formatDuration(avgSessionMinutes)} par session en moyenne. Quand tu t'installes, c'est pas pour cinq minutes.`
            ]),
            highlight: '🍿', subtext: 'Le confort avant tout.'
        });
    }
    if (Array.isArray(weekday) && weekday.length > 0) {
        const topDow = weekday.reduce((a, b) => (b.minutes > a.minutes ? b : a), weekday[0]);
        if (topDow && topDow.minutes >= 120) {
            const dayNames = ['', 'dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
            const dayName = dayNames[topDow.dow];
            funFacts.push({
                title: `Le ${dayName}, c'est sacré`, subtitle: '',
                text: pick('ff-dow', [
                    `Ton jour le plus chargé de l'année : le ${dayName}. ${formatDuration(topDow.minutes)} rien que sur ce créneau hebdo.`,
                    `S'il fallait te chercher un jour précis, ce serait le ${dayName} : ${formatDuration(topDow.minutes)} cumulées dessus cette année.`
                ]),
                highlight: '📅', subtext: ''
            });
        }
    }
    if (totalActiveDays > 100) {
        const activePct = Math.min(100, Math.round((totalActiveDays / 365) * 100));
        funFacts.push({
            title: `${totalActiveDays} jours actifs`, subtitle: '',
            text: pick('ff-days', [
                `T'as lancé Movix ${totalActiveDays} jours cette année — ${activePct}% de tes journées. La fidélité, la vraie.`,
                `${totalActiveDays} jours avec au moins une session. Presque ${activePct}% de l'année passée ensemble.`
            ]),
            highlight: '📆', subtext: ''
        });
    }
    if (firstWatchData) {
        const firstDate = new Date(firstWatchData.created_at);
        const dayOfYear = Math.ceil((firstDate - new Date(firstDate.getFullYear(), 0, 1)) / (1000 * 60 * 60 * 24));
        if (dayOfYear <= 3) {
            funFacts.push({ title: 'Aucune minute à perdre', subtitle: '', text: `Ton premier visionnage de ${year} ? "${firstWatchData.content_title}", dès le ${dayOfYear === 1 ? '1er' : dayOfYear + 'e'} janvier. T'as pas traîné.`, highlight: '🎆', subtext: '' });
        }
    }
    if (funFacts.length > 0) {
        const picked = seededShuffle(funFacts, seed);
        slides.push({ type: 'fun-fact', ...picked[0] });
        if (picked.length > 1 && totalHours > 50) {
            slides.push({ type: 'fun-fact', ...picked[1] });
        }
    }

    // === 13. PERSONA — révélation climax (avant-dernier acte) ===
    const typeLabel = { 'anime': 'les animes', 'movie': 'les films', 'tv': 'les séries', 'live-tv': 'la TV en direct' };
    const vibeTemplates = [
        {
            condition: dominantPercent > 80,
            texts: [
                `${dominantPercent}% de ton temps sur ${typeLabel[dominantType.content_type]}. Tu sais ce que t'aimes, et tu assumes à fond.`,
                `${typeLabel[dominantType.content_type]} à ${dominantPercent}% de ton temps : un choix clair, net et totalement assumé.`
            ]
        },
        {
            condition: dominantPercent > 50,
            texts: [
                `Ta vibe ? Surtout ${typeLabel[dominantType.content_type]}, avec ce qu'il faut de variété.`,
                `${typeLabel[dominantType.content_type]} en majorité, le reste en exploration. Le bon dosage.`
            ]
        },
        {
            condition: true,
            texts: [
                `Toi, c'est un peu de tout. L'équilibre, le vrai.`,
                `Films, séries, animes : tu refuses de choisir, et t'as bien raison.`
            ]
        }
    ];
    slides.push({
        type: 'persona',
        title: persona.title,
        subtitle: persona.subtitle,
        text: pick('persona', vibeTemplates.find(t => t.condition).texts),
        highlight: persona.emoji,
        subtext: persona.description
    });

    // === 14. DETAILED STATS ===
    slides.push({ type: 'detailed-stats', title: 'Tes stats', subtitle: 'En détail', text: 'Le récap complet de ton année.', highlight: '📊', subtext: '' });

    // === 15. CLOSING (rendu générique de fin côté front) ===
    slides.push({
        type: 'closing',
        title: pick('closing-t', [`On remet ça en ${year + 1} ?`, `${year}, c'est dans la boîte.`]),
        subtitle: pick('closing-st', ['Nous, on est partants.', 'Clap de fin.']),
        text: pick('closing', [
            `${totalDurationLabel}. ${uniqueTitles} titres. 1 seul toi. Merci d'avoir passé l'année sur Movix.`,
            `${totalDurationLabel} de visionnage, ${uniqueTitles} titres traversés, et une année qui te ressemble. Merci d'avoir été là.`
        ]),
        highlight: '💜',
        subtext: pick('closing-s', ['Cette année était validée.', 'On garde ta place au chaud.', 'Même heure, même canapé ?'])
    });

    return slides;
}


module.exports = { router, initWrappedRoutes, initTables };
