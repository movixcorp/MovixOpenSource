'use strict';
const express = require('express');
const { isAdmin } = require('../middleware/auth');
const { getPool } = require('../mysqlPool');
const { redis } = require('../config/redis');
const { scanUserStore } = require('../utils/userStatsScan');
const { zeroFillSeries } = require('../utils/statsAggregate');

const router = express.Router();
router.use(isAdmin);

const ALLOWED_RANGES = new Set([7, 30, 90]);
const DAY_MS = 86400000;

const USERS_CACHE_KEY = 'admin:stats:users:v1';
const USERS_LOCK_KEY = 'lock:admin:stats:users:v1';
const USERS_CACHE_TTL = 600; // 10 min — heavy disk scan
const SQL_CACHE_TTL = 120;   // 2 min — cheap queries

const sum = (rows) => rows.reduce((acc, r) => acc + r.count, 0);

// Cluster-safe: serve Redis cache; only ONE worker scans disk at a time (single-flight lock).
async function getUsersAggregate() {
  try {
    const cached = await redis.get(USERS_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch { /* ignore cache read errors */ }

  let locked = false;
  try {
    locked = (await redis.set(USERS_LOCK_KEY, '1', 'PX', 30000, 'NX')) === 'OK';
  } catch { /* ignore */ }

  if (!locked) {
    // Another worker is scanning — wait briefly, then serve whatever landed in cache.
    await new Promise((r) => setTimeout(r, 300));
    try {
      const cached = await redis.get(USERS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch { /* ignore */ }
  }

  try {
    const agg = await scanUserStore();
    try { await redis.set(USERS_CACHE_KEY, JSON.stringify(agg), 'EX', USERS_CACHE_TTL); } catch { /* ignore */ }
    return agg;
  } finally {
    if (locked) { try { await redis.del(USERS_LOCK_KEY); } catch { /* ignore */ } }
  }
}

async function getSqlAggregate(range, sinceMs) {
  const key = `admin:stats:sql:v1:${range}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch { /* ignore */ }

  const pool = getPool();
  const sinceDate = new Date(sinceMs); // for TIMESTAMP columns

  // user_sessions: TIMESTAMP. comments/shared_lists: BIGINT ms. vip_invoices: TIMESTAMP.
  const [sessions] = await pool.execute(
    "SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date, COUNT(*) AS count " +
    "FROM user_sessions WHERE created_at >= ? GROUP BY date ORDER BY date",
    [sinceDate]);
  const [dau] = await pool.execute(
    "SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date, COUNT(DISTINCT user_id) AS count " +
    "FROM user_sessions WHERE created_at >= ? GROUP BY date ORDER BY date",
    [sinceDate]);
  const [comments] = await pool.execute(
    "SELECT DATE_FORMAT(FROM_UNIXTIME(created_at/1000),'%Y-%m-%d') AS date, COUNT(*) AS count " +
    "FROM comments WHERE created_at >= ? GROUP BY date ORDER BY date",
    [sinceMs]);
  const [sharedLists] = await pool.execute(
    "SELECT DATE_FORMAT(FROM_UNIXTIME(created_at/1000),'%Y-%m-%d') AS date, COUNT(*) AS count " +
    "FROM shared_lists WHERE created_at >= ? GROUP BY date ORDER BY date",
    [sinceMs]);

  // vip_invoices: count delivered donations. Wrapped in try/catch so a schema/status mismatch
  // degrades to an empty series instead of failing the whole dashboard.
  let vip = [];
  try {
    [vip] = await pool.execute(
      "SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date, COUNT(*) AS count " +
      "FROM vip_invoices WHERE status='delivered' AND created_at >= ? GROUP BY date ORDER BY date",
      [sinceDate]);
  } catch (e) {
    console.warn('[adminStats] vip_invoices query skipped:', e?.message || e);
    vip = [];
  }

  const result = { sessions, dau, comments, sharedLists, vip };
  try { await redis.set(key, JSON.stringify(result), 'EX', SQL_CACHE_TTL); } catch { /* ignore */ }
  return result;
}

router.get('/overview', async (req, res) => {
  try {
    const requested = parseInt(req.query.range, 10);
    const range = ALLOWED_RANGES.has(requested) ? requested : 30;
    const nowMs = Date.now();
    const sinceMs = nowMs - range * DAY_MS;

    const [users, sql] = await Promise.all([getUsersAggregate(), getSqlAggregate(range, sinceMs)]);

    const registrationsPerDay = zeroFillSeries(users.registrationsByDate, range, nowMs);
    const sessionsPerDay = zeroFillSeries(sql.sessions, range, nowMs);
    const dauPerDay = zeroFillSeries(sql.dau, range, nowMs);
    const commentsPerDay = zeroFillSeries(sql.comments, range, nowMs);
    const sharedListsPerDay = zeroFillSeries(sql.sharedLists, range, nowMs);
    const vipPerDay = zeroFillSeries(sql.vip, range, nowMs);

    res.json({
      range,
      generatedAt: nowMs,
      totals: {
        users: users.total,
        byProvider: users.byProvider,
        registrationsInRange: sum(registrationsPerDay),
        sessionsInRange: sum(sessionsPerDay),
        avgDau: dauPerDay.length ? Math.round(sum(dauPerDay) / dauPerDay.length) : 0,
        commentsInRange: sum(commentsPerDay),
        vipInRange: sum(vipPerDay),
      },
      registrationsPerDay,
      sessionsPerDay,
      dauPerDay,
      commentsPerDay,
      sharedListsPerDay,
      vipPerDay,
    });
  } catch (err) {
    console.error('[adminStats] overview error:', err?.message || err);
    res.status(500).json({ success: false, error: 'Erreur stats' });
  }
});

module.exports = router;
