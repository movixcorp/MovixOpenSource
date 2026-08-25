'use strict';

/** UTC YYYY-MM-DD from epoch ms. */
function dayKeyUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Ordered UTC day keys for the last `range` days (inclusive of today), oldest first. */
function rangeDayKeys(range, nowMs) {
  const today = new Date(nowMs);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const keys = [];
  for (let i = range - 1; i >= 0; i--) {
    keys.push(dayKeyUTC(base - i * 86400000));
  }
  return keys;
}

/** Merge [{date,count}] rows onto a zero-filled range. Dates outside the range are dropped. */
function zeroFillSeries(rows, range, nowMs) {
  const counts = new Map();
  for (const r of rows || []) {
    if (r && r.date != null) counts.set(String(r.date), Number(r.count) || 0);
  }
  return rangeDayKeys(range, nowMs).map((date) => ({ date, count: counts.get(date) || 0 }));
}

/** Bucket ISO date strings into [{date,count}] by UTC day; invalid strings ignored. */
function bucketIsoByDay(isoStrings) {
  const counts = new Map();
  for (const iso of isoStrings || []) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    const key = dayKeyUTC(ms);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts, ([date, count]) => ({ date, count }));
}

module.exports = { dayKeyUTC, rangeDayKeys, zeroFillSeries, bucketIsoByDay };
