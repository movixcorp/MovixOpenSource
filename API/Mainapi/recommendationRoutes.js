/**
 * Movix Personalized Recommendations
 * Builds user taste profiles from viewing history and generates
 * scored recommendations via TMDB discovery + similarity APIs.
 * Includes collaborative filtering: compares user profiles to find
 * content loved by users with similar tastes.
 *
 * Exports: { router, initRecommendationRoutes }
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { fetchTmdbDetails } = require('./utils/tmdbCache');
const { LruMap } = require('./utils/lruMap');

// ─── Configuration ──────────────────────────────────────────────────────────

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const JWT_SECRET = process.env.JWT_SECRET;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Redis TTLs (seconds)
const PROFILE_CACHE_TTL = 6 * 60 * 60;   // 6 hours
const RECO_CACHE_TTL    = 60 * 60;        // 1 hour
const COLLAB_CACHE_TTL  = 3 * 60 * 60;   // 3 hours

// In-memory cache for TMDB endpoints NOT covered by tmdbCache.js
// (recommendations, similar, discover, trending, genre lists, keywords, credits)
// Capped to avoid unbounded growth — each entry holds a full TMDB JSON payload.
const TMDB_MEM_MAX_ENTRIES = 500;
const tmdbMemCache = new LruMap({ max: TMDB_MEM_MAX_ENTRIES });
const TMDB_MEM_TTL = 15 * 60 * 1000; // 15 minutes in ms

// Set by initRecommendationRoutes()
let pool  = null;
let redis = null;

/**
 * Initialize the router with MySQL pool and Redis client.
 */
function initRecommendationRoutes(mysqlPool, redisClient) {
    pool  = mysqlPool;
    redis = redisClient || null;
}

// ─── Redis helpers ──────────────────────────────────────────────────────────

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

// ─── JWT middleware ─────────────────────────────────────────────────────────

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        req.user = {
            userId: decoded.sub || decoded.userId,
            userType: decoded.userType,
            sessionId: decoded.sessionId
        };
        next();
    } catch (error) {
        return res.status(403).json({ success: false, error: 'Invalid token.' });
    }
};

// ─── TMDB helpers ──────────────────────────────────────────────────────────

/**
 * Fetch TMDB details using the shared Redis cache (tmdbCache.js).
 * This reuses the same Redis keys as all other routes.
 */
async function fetchDetails(id, type, language) {
    return fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, id, type, language);
}

/**
 * Fetch TMDB endpoints not covered by tmdbCache.js (recommendations, similar,
 * discover, trending, genre lists, keywords, credits).
 * Uses in-memory cache (15min) to avoid hammering TMDB.
 */
async function tmdbFetch(path, params = {}) {
    const cacheKey = `${path}?${Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&')}`;

    // In-memory cache
    const mem = tmdbMemCache.get(cacheKey);
    if (mem && Date.now() - mem.ts < TMDB_MEM_TTL) {
        return mem.data;
    }

    try {
        const response = await axios.get(`${TMDB_API_URL}${path}`, {
            params: { api_key: TMDB_API_KEY, ...params },
            timeout: 10000
        });
        const data = response.data || null;
        if (data) {
            tmdbMemCache.set(cacheKey, { data, ts: Date.now() });
        }
        return data;
    } catch {
        return null;
    }
}

// Periodically prune stale in-memory entries (every 5 min)
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of tmdbMemCache) {
        if (now - val.ts > TMDB_MEM_TTL) tmdbMemCache.delete(key);
    }
}, 5 * 60 * 1000).unref();

// ─── Profile Builder ────────────────────────────────────────────────────────

/**
 * Build a user taste profile from their viewing history.
 */
async function buildUserProfile(userId, profileId, language) {
    // Check Redis cache first
    const rKey = `profile:${userId}:${profileId}`;
    const cached = await redisGet(rKey);
    if (cached) {
        try { return JSON.parse(cached); } catch { /* rebuild */ }
    }

    // Top 30 content by total watch duration
    const [rows] = await pool.execute(
        `SELECT content_id, content_type, content_title,
                SUM(watch_duration) AS total_duration
         FROM wrapped_viewing_data
         WHERE user_id = ? AND profile_id = ?
         GROUP BY content_id, content_type, content_title
         ORDER BY total_duration DESC
         LIMIT 30`,
        [userId, profileId]
    );

    if (!rows || rows.length === 0) {
        return null;
    }

    const maxDuration = Number(rows[0].total_duration) || 1;

    // Fetch TMDB details via shared Redis cache + keywords/credits via tmdbFetch
    const enriched = await Promise.all(rows.map(async (row) => {
        const type = (row.content_type === 'anime') ? 'tv' : row.content_type;
        if (type !== 'movie' && type !== 'tv') return null;

        const id = row.content_id;
        const [details, keywords, credits] = await Promise.all([
            fetchDetails(id, type, language),        // uses shared Redis cache
            tmdbFetch(`/${type}/${id}/keywords`),     // in-memory cache
            tmdbFetch(`/${type}/${id}/credits`)        // in-memory cache
        ]);

        if (!details) return null;

        return {
            id,
            type,
            title: row.content_title || details.title || details.name,
            poster_path: details.poster_path,
            totalDuration: Number(row.total_duration),
            details,
            keywords,
            credits,
            originalType: row.content_type
        };
    }));

    // Build weighted preference maps
    const genres    = {};
    const keywords  = {};
    const people    = {};
    const decades   = {};
    const formats   = { movie: 0, tv: 0 };

    for (const item of enriched) {
        if (!item) continue;

        const normDuration = item.totalDuration / maxDuration;

        // Completion weight
        const runtimeMin = item.details.runtime
            || (item.details.episode_run_time && item.details.episode_run_time[0])
            || 90;
        const runtimeSec = runtimeMin * 60;
        const completionRatio = Math.min(item.totalDuration / runtimeSec, 1);
        let completionWeight;
        if (completionRatio >= 0.9)       completionWeight = 3;
        else if (completionRatio >= 0.5)  completionWeight = 1.5;
        else if (completionRatio >= 0.2)  completionWeight = 1;
        else                              completionWeight = 0.3;

        const weight = normDuration * completionWeight;

        // Genres
        if (item.details.genres) {
            for (const g of item.details.genres) {
                genres[g.id] = (genres[g.id] || 0) + weight;
            }
        }

        // Keywords
        const kwList = item.keywords?.keywords || item.keywords?.results || [];
        for (const kw of kwList) {
            keywords[kw.id] = (keywords[kw.id] || 0) + weight;
        }

        // People: top 5 cast + director
        if (item.credits) {
            const topCast = (item.credits.cast || []).slice(0, 5);
            for (const actor of topCast) {
                if (!people[actor.id]) people[actor.id] = { name: actor.name, score: 0 };
                people[actor.id].score += weight;
            }
            const directors = (item.credits.crew || []).filter(c => c.job === 'Director');
            for (const dir of directors) {
                if (!people[dir.id]) people[dir.id] = { name: dir.name, score: 0 };
                people[dir.id].score += weight * 1.5;
            }
        }

        // Decade
        const dateStr = item.details.release_date || item.details.first_air_date;
        if (dateStr) {
            const year = parseInt(dateStr.substring(0, 4));
            if (!isNaN(year)) {
                const decade = `${Math.floor(year / 10) * 10}s`;
                decades[decade] = (decades[decade] || 0) + weight;
            }
        }

        // Format
        const fmt = (item.originalType === 'movie') ? 'movie' : 'tv';
        formats[fmt] += weight;
    }

    const profile = {
        genres,
        keywords,
        people,
        decades,
        formats,
        topContent: enriched.filter(Boolean).slice(0, 10).map(c => ({
            id: c.id, type: c.type, title: c.title, poster_path: c.poster_path
        })),
        builtAt: Date.now()
    };

    // Cache in Redis
    await redisSet(rKey, JSON.stringify(profile), PROFILE_CACHE_TTL);

    return profile;
}

// ─── Collaborative Filtering ───────────────────────────────────────────────

/**
 * Find content loved by users with similar taste profiles.
 * Compares genre vectors between the current user and all other users
 * who have viewing data, then recommends content those similar users
 * watched but the current user hasn't.
 */
async function getCollaborativeRecommendations(userId, profileId, profile, language) {
    const cacheKey = `collab:${userId}:${profileId}`;
    const cached = await redisGet(cacheKey);
    if (cached) {
        try { return JSON.parse(cached); } catch { /* rebuild */ }
    }

    // Get all other users with enough viewing data
    const [otherUsers] = await pool.execute(
        `SELECT user_id, profile_id,
                COUNT(DISTINCT content_id) as content_count
         FROM wrapped_viewing_data
         WHERE NOT (user_id = ? AND profile_id = ?)
         GROUP BY user_id, profile_id
         HAVING content_count >= 5
         LIMIT 100`,
        [userId, profileId]
    );

    if (otherUsers.length === 0) {
        await redisSet(cacheKey, JSON.stringify([]), COLLAB_CACHE_TTL);
        return [];
    }

    // Get current user's watched content
    const [watchedRows] = await pool.execute(
        `SELECT DISTINCT content_id, content_type FROM wrapped_viewing_data
         WHERE user_id = ? AND profile_id = ?`,
        [userId, profileId]
    );
    const myWatchedIds = new Set(watchedRows.map(r => String(r.content_id)));

    // Build a simple genre vector for the current user (normalized)
    const myGenreVec = normalizeVector(profile.genres);

    // For each other user, compute similarity and collect their top content
    const similarUsers = [];

    for (const other of otherUsers) {
        // Get that user's top content with genres
        const [otherContent] = await pool.execute(
            `SELECT content_id, content_type, content_title,
                    SUM(watch_duration) AS total_duration
             FROM wrapped_viewing_data
             WHERE user_id = ? AND profile_id = ?
             GROUP BY content_id, content_type, content_title
             ORDER BY total_duration DESC
             LIMIT 15`,
            [other.user_id, other.profile_id]
        );

        if (otherContent.length === 0) continue;

        // Build that user's genre vector from TMDB details
        const otherGenres = {};
        for (const item of otherContent) {
            const type = item.content_type === 'anime' ? 'tv' : item.content_type;
            if (type !== 'movie' && type !== 'tv') continue;
            const details = await fetchDetails(item.content_id, type, language);
            if (details?.genres) {
                for (const g of details.genres) {
                    otherGenres[g.id] = (otherGenres[g.id] || 0) + Number(item.total_duration);
                }
            }
        }

        const otherGenreVec = normalizeVector(otherGenres);
        const similarity = cosineSimilarity(myGenreVec, otherGenreVec);

        if (similarity > 0.3) { // Only consider users with >30% genre overlap
            similarUsers.push({
                similarity,
                content: otherContent.filter(c => !myWatchedIds.has(String(c.content_id)))
            });
        }
    }

    // Sort by similarity, take top 10 similar users
    similarUsers.sort((a, b) => b.similarity - a.similarity);
    const topSimilar = similarUsers.slice(0, 10);

    // Collect content from similar users, weighted by similarity and watch duration
    const collabCandidates = new Map(); // contentId -> { score, item }

    for (const user of topSimilar) {
        for (const item of user.content) {
            const key = String(item.content_id);
            if (myWatchedIds.has(key)) continue;

            const existing = collabCandidates.get(key);
            const score = user.similarity * Math.log10(Number(item.total_duration) + 1);

            if (!existing || existing.score < score) {
                collabCandidates.set(key, {
                    score,
                    contentId: item.content_id,
                    contentType: item.content_type,
                    contentTitle: item.content_title
                });
            }
        }
    }

    // Get top candidates and enrich with TMDB data
    const sorted = [...collabCandidates.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);

    const enriched = await Promise.all(sorted.map(async (item) => {
        const type = item.contentType === 'anime' ? 'tv' : item.contentType;
        if (type !== 'movie' && type !== 'tv') return null;
        const details = await fetchDetails(item.contentId, type, language);
        if (!details || !details.poster_path) return null;
        return {
            id: Number(item.contentId),
            title: details.title || details.name,
            originalTitle: details.original_title || details.original_name,
            mediaType: type,
            posterPath: details.poster_path,
            backdropPath: details.backdrop_path,
            overview: details.overview,
            voteAverage: details.vote_average,
            releaseDate: details.release_date || details.first_air_date,
            genreIds: (details.genres || []).map(g => g.id),
            popularity: details.popularity,
            score: Math.round(item.score * 1000) / 1000
        };
    }));

    const result = enriched.filter(Boolean);
    await redisSet(cacheKey, JSON.stringify(result), COLLAB_CACHE_TTL);
    return result;
}

/**
 * Normalize an object { key: value } into a unit vector.
 */
function normalizeVector(obj) {
    const values = Object.values(obj);
    const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
        result[k] = v / magnitude;
    }
    return result;
}

/**
 * Cosine similarity between two sparse vectors (objects).
 */
function cosineSimilarity(a, b) {
    let dotProduct = 0;
    for (const key of Object.keys(a)) {
        if (b[key]) dotProduct += a[key] * b[key];
    }
    return dotProduct; // already normalized
}

// ─── Candidate Scoring ──────────────────────────────────────────────────────

function scoreCandidate(candidate, profile) {
    // Genre affinity
    let genreScore = 0;
    const maxGenre = Math.max(...Object.values(profile.genres), 1);
    if (candidate.genre_ids) {
        for (const gid of candidate.genre_ids) {
            genreScore += (profile.genres[gid] || 0) / maxGenre;
        }
        genreScore = candidate.genre_ids.length > 0
            ? Math.min(genreScore / candidate.genre_ids.length, 1)
            : 0;
    }

    // Keyword affinity
    let keywordScore = 0;
    if (candidate._keywords && candidate._keywords.length > 0) {
        const maxKw = Math.max(...Object.values(profile.keywords), 1);
        for (const kw of candidate._keywords) {
            keywordScore += (profile.keywords[kw.id] || 0) / maxKw;
        }
        keywordScore = Math.min(keywordScore / candidate._keywords.length, 1);
    }

    // People affinity
    let peopleScore = 0;
    if (candidate._credits) {
        const maxPeople = Math.max(...Object.values(profile.people).map(p => p.score), 1);
        const relevantPeople = [
            ...(candidate._credits.cast || []).slice(0, 5),
            ...(candidate._credits.crew || []).filter(c => c.job === 'Director')
        ];
        for (const person of relevantPeople) {
            if (profile.people[person.id]) {
                peopleScore += profile.people[person.id].score / maxPeople;
            }
        }
        peopleScore = relevantPeople.length > 0
            ? Math.min(peopleScore / Math.min(relevantPeople.length, 3), 1)
            : 0;
    }

    // Popularity normalized
    const popularityNorm = candidate.popularity
        ? Math.min(Math.log10(candidate.popularity + 1) / 3, 1)
        : 0;

    // Recency score
    const dateStr = candidate.release_date || candidate.first_air_date;
    let recencyScore = 0.5;
    if (dateStr) {
        const year = parseInt(dateStr.substring(0, 4));
        const currentYear = new Date().getFullYear();
        recencyScore = Math.max(1 - ((currentYear - year) / 30), 0);
    }

    // Format match
    const candidateFormat = candidate.media_type || (candidate.title ? 'movie' : 'tv');
    const totalFormat = profile.formats.movie + profile.formats.tv || 1;
    const formatMatch = (profile.formats[candidateFormat] || 0) / totalFormat;

    return (genreScore   * 0.35) +
           (keywordScore * 0.25) +
           (peopleScore  * 0.15) +
           (popularityNorm * 0.10) +
           (recencyScore * 0.10) +
           (formatMatch  * 0.05);
}

// ─── Recommendation Generator ───────────────────────────────────────────────

async function generateRecommendations(userId, profileId, language) {
    const profile = await buildUserProfile(userId, profileId, language);

    if (!profile) {
        return {
            becauseYouWatched: [],
            topGenres: [],
            trendingForYou: [],
            usersAlsoWatched: [],
            profileSummary: null
        };
    }

    // Set of already watched content IDs
    const [watchedRows] = await pool.execute(
        `SELECT DISTINCT content_id FROM wrapped_viewing_data
         WHERE user_id = ? AND profile_id = ?`,
        [userId, profileId]
    );
    const watchedIds = new Set(watchedRows.map(r => String(r.content_id)));

    // ─── Fetch candidates in parallel ───────────────────────────────────

    const topContent = profile.topContent.slice(0, 5);

    // 1. "Because you watched" — TMDB recommendations + similar
    const becauseYouWatchedRaw = await Promise.all(
        topContent.map(async (item) => {
            const [recs, similar] = await Promise.all([
                tmdbFetch(`/${item.type}/${item.id}/recommendations`, { language, page: 1 }),
                tmdbFetch(`/${item.type}/${item.id}/similar`, { language, page: 1 })
            ]);
            const candidates = [
                ...((recs?.results) || []),
                ...((similar?.results) || [])
            ].map(c => ({ ...c, media_type: c.media_type || item.type }));
            return { source: item, candidates };
        })
    );

    // 2. Top genres — TMDB discover
    const sortedGenres = Object.entries(profile.genres)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    const topGenresRaw = await Promise.all(
        sortedGenres.map(async ([genreId]) => {
            const [movieDiscover, tvDiscover] = await Promise.all([
                tmdbFetch('/discover/movie', { language, with_genres: genreId, sort_by: 'popularity.desc', page: 1 }),
                tmdbFetch('/discover/tv', { language, with_genres: genreId, sort_by: 'popularity.desc', page: 1 })
            ]);
            const candidates = [
                ...((movieDiscover?.results) || []).map(c => ({ ...c, media_type: 'movie' })),
                ...((tvDiscover?.results) || []).map(c => ({ ...c, media_type: 'tv' }))
            ];
            return { genreId, candidates };
        })
    );

    // 3. Trending
    const trendingData = await tmdbFetch('/trending/all/week', { language });
    const trendingCandidates = (trendingData?.results || []).map(c => ({
        ...c, media_type: c.media_type || 'movie'
    }));

    // 4. Collaborative filtering (in parallel with the above processing)
    const collabPromise = getCollaborativeRecommendations(userId, profileId, profile, language);

    // ─── Score, deduplicate, exclude watched ────────────────────────────

    const seen = new Set();

    function processCandidate(c) {
        const cid = `${c.media_type || 'movie'}-${c.id}`;
        if (seen.has(cid) || watchedIds.has(String(c.id))) return null;
        seen.add(cid);
        const score = scoreCandidate(c, profile);
        return { ...c, _score: score };
    }

    // "becauseYouWatched" groups
    const becauseYouWatched = [];
    for (const group of becauseYouWatchedRaw) {
        const scored = group.candidates
            .map(processCandidate)
            .filter(Boolean)
            .sort((a, b) => b._score - a._score)
            .slice(0, 12);

        if (scored.length >= 3) {
            becauseYouWatched.push({
                title: group.source.title,
                sourceId: group.source.id,
                sourceType: group.source.type,
                poster_path: group.source.poster_path,
                items: scored.map(formatResult)
            });
        }
        if (becauseYouWatched.length >= 3) break;
    }

    // "topGenres" groups
    const topGenres = [];
    for (const group of topGenresRaw) {
        const scored = group.candidates
            .map(processCandidate)
            .filter(Boolean)
            .sort((a, b) => b._score - a._score)
            .slice(0, 12);

        if (scored.length >= 3) {
            topGenres.push({
                genreId: parseInt(group.genreId),
                items: scored.map(formatResult)
            });
        }
        if (topGenres.length >= 3) break;
    }

    // Resolve genre names
    if (topGenres.length > 0) {
        const [movieGenres, tvGenres] = await Promise.all([
            tmdbFetch('/genre/movie/list', { language }),
            tmdbFetch('/genre/tv/list', { language })
        ]);
        const genreMap = {};
        for (const g of (movieGenres?.genres || [])) genreMap[g.id] = g.name;
        for (const g of (tvGenres?.genres || []))    genreMap[g.id] = g.name;
        for (const group of topGenres) {
            group.genreName = genreMap[group.genreId] || `Genre ${group.genreId}`;
        }
    }

    // "trendingForYou"
    const trendingForYou = trendingCandidates
        .filter(c => c.media_type === 'movie' || c.media_type === 'tv')
        .map(processCandidate)
        .filter(Boolean)
        .sort((a, b) => b._score - a._score)
        .slice(0, 15)
        .map(formatResult);

    // "usersAlsoWatched" — collaborative filtering results
    const usersAlsoWatched = await collabPromise;

    // Profile summary
    const profileSummary = {
        topGenreIds: sortedGenres.map(([id]) => parseInt(id)),
        preferredFormat: profile.formats.movie >= profile.formats.tv ? 'movie' : 'tv',
        topDecade: Object.entries(profile.decades).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        contentAnalyzed: profile.topContent.length,
        builtAt: profile.builtAt
    };

    return { becauseYouWatched, topGenres, trendingForYou, usersAlsoWatched, profileSummary };
}

/**
 * Format a scored candidate into the API response shape.
 */
function formatResult(item) {
    return {
        id: item.id,
        title: item.title || item.name,
        originalTitle: item.original_title || item.original_name,
        mediaType: item.media_type || 'movie',
        posterPath: item.poster_path,
        backdropPath: item.backdrop_path,
        overview: item.overview,
        voteAverage: item.vote_average,
        releaseDate: item.release_date || item.first_air_date,
        genreIds: item.genre_ids,
        popularity: item.popularity,
        score: Math.round((item._score || 0) * 1000) / 1000
    };
}

// ─── Route ──────────────────────────────────────────────────────────────────

router.get('/personalized', verifyToken, async (req, res) => {
    try {
        const userId    = req.user.userId;
        const profileId = req.query.profileId;
        const language  = req.query.language || 'fr-FR';

        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required.' });
        }

        // Check Redis cache
        const cacheKey = `reco:${userId}:${profileId}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
            try {
                return res.json({ success: true, ...JSON.parse(cached) });
            } catch { /* rebuild */ }
        }

        const result = await generateRecommendations(userId, profileId, language);

        await redisSet(cacheKey, JSON.stringify(result), RECO_CACHE_TTL);

        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Recommendations] Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { router, initRecommendationRoutes };
