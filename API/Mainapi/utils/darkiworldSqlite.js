// API/Mainapi/utils/darkiworldSqlite.js
//
// Single source of truth for darkiworld link data under the hydracker freeze.
// Reads from three readonly sqlite snapshots:
//   - links_small.sqlite (extra coverage by link_id; converted from MySQL dump)
//   - mirror.sqlite      (filtered final_urls, no darkibox)
//   - darkino.sqlite     (raw link_details, includes darkibox; we filter)
//
// Lookup-by-lien priority: links_small > mirror > darkino.
//
// Default path: Mainapi/darkino-backups/. Override via DARKIWORLD_SQLITE_DIR.

const path = require("path");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (e) {
  console.warn("[darkiworldSqlite] better-sqlite3 unavailable:", e?.message);
}

const DEFAULT_DIR = path.join(__dirname, "..", "darkino-backups");

let mirrorDb = null;
let darkinoDb = null;
let linksSmallDb = null;
let stmts = null;
let openAttempted = false;

function dbDir() {
  return process.env.DARKIWORLD_SQLITE_DIR || DEFAULT_DIR;
}

function openAll() {
  if (openAttempted) return;
  openAttempted = true;
  if (!Database) return;

  const mirrorPath = path.join(dbDir(), "mirror.sqlite");
  const darkinoPath = path.join(dbDir(), "darkino.sqlite");
  const linksSmallPath = path.join(dbDir(), "links_small.sqlite");

  try {
    mirrorDb = new Database(mirrorPath, {
      readonly: true,
      fileMustExist: true,
    });
    // journal_mode is a writer-side concern; readonly handles cannot change it.
  } catch (e) {
    console.warn(
      `[darkiworldSqlite] mirror open failed (${mirrorPath}): ${e?.message}`,
    );
    mirrorDb = null;
  }

  try {
    darkinoDb = new Database(darkinoPath, {
      readonly: true,
      fileMustExist: true,
    });
    // journal_mode is a writer-side concern; readonly handles cannot change it.
  } catch (e) {
    console.warn(
      `[darkiworldSqlite] darkino open failed (${darkinoPath}): ${e?.message}`,
    );
    darkinoDb = null;
  }

  try {
    linksSmallDb = new Database(linksSmallPath, {
      readonly: true,
      fileMustExist: true,
    });
  } catch (e) {
    // Optional snapshot — missing file is not an error, just disables this source.
    console.warn(
      `[darkiworldSqlite] links_small open failed (${linksSmallPath}): ${e?.message}`,
    );
    linksSmallDb = null;
  }

  prepareStatements();
}

function prepareStatements() {
  stmts = {};
  if (mirrorDb) {
    stmts.mirrorByLien = mirrorDb.prepare(
      "SELECT id, hydracker_lien_id, quality_id, quality_name, size_bytes, " +
        "season_number, episode_label, langs, final_url, created_at, updated_at " +
        "FROM links WHERE hydracker_lien_id = ?",
    );
    stmts.mirrorByTitleMovie = mirrorDb.prepare(
      "SELECT id, hydracker_lien_id, quality_id, quality_name, size_bytes, " +
        "season_number, episode_label, langs, final_url, created_at, updated_at " +
        "FROM links WHERE title_hydracker_id = ? AND season_number IS NULL",
    );
    // Mirror tv: match exact episode_label, OR a rare IS NULL row (defensive),
    // OR mirror's "Saison Complète" sentinel that marks a full-season pack.
    stmts.mirrorByTitleTv = mirrorDb.prepare(
      "SELECT id, hydracker_lien_id, quality_id, quality_name, size_bytes, " +
        "season_number, episode_label, langs, final_url, created_at, updated_at " +
        "FROM links WHERE title_hydracker_id = ? AND season_number = ? " +
        "  AND (episode_label = ? OR episode_label IS NULL OR episode_label = 'Saison Complète')",
    );
  }
  if (linksSmallDb) {
    stmts.linksSmallByLien = linksSmallDb.prepare(
      "SELECT link_id, link_url, host_name, tmdb_id, season_number, " +
        "episode_number, episode_name, is_full_season, quality_name, " +
        "size_bytes, audio_langs, created_at " +
        "FROM links_small WHERE link_id = ? LIMIT 1",
    );
  }
  if (darkinoDb) {
    stmts.darkinoByLien = darkinoDb.prepare(
      "SELECT link_id, lien, id_host, title_id, taille, qualite, saison, " +
        "episode, full_saison, created_at, updated_at " +
        "FROM link_details WHERE link_id = ? " +
        "AND active = 1 AND deleted_at IS NULL AND (to_expire = 0 OR to_expire IS NULL)",
    );
    stmts.darkinoByTitleMovie = darkinoDb.prepare(
      "SELECT link_id, lien, id_host, title_id, taille, qualite, saison, " +
        "episode, full_saison, created_at, updated_at " +
        "FROM link_details " +
        "WHERE title_id = ? AND active = 1 AND deleted_at IS NULL AND (to_expire = 0 OR to_expire IS NULL)",
    );
    stmts.darkinoByTitleTv = darkinoDb.prepare(
      "SELECT link_id, lien, id_host, title_id, taille, qualite, saison, " +
        "episode, full_saison, created_at, updated_at " +
        "FROM link_details " +
        "WHERE title_id = ? " +
        "  AND saison = ? " +
        "  AND (episode = ? OR full_saison = 1) " +
        "  AND active = 1 AND deleted_at IS NULL AND (to_expire = 0 OR to_expire IS NULL)",
    );
  }
}

function isDarkiboxUrl(url) {
  return typeof url === "string" && /darkibox\.com/i.test(url);
}

function normalizeMirrorRow(row) {
  if (!row || typeof row.final_url !== "string" || !row.final_url) return null;
  if (isDarkiboxUrl(row.final_url)) return null;
  return {
    source: "mirror",
    lien_id: row.hydracker_lien_id,
    lien: row.final_url,
    taille: row.size_bytes || 0,
    quality: row.quality_name || null,
    quality_id: row.quality_id != null ? row.quality_id : null,
    host_id: null,
    langs: row.langs || null,
    season_number: row.season_number != null ? row.season_number : null,
    episode_label: row.episode_label || null,
    full_saison: row.episode_label === "Saison Complète" ? 1 : 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeLinksSmallRow(row) {
  if (!row || typeof row.link_url !== "string" || !row.link_url) return null;
  if (isDarkiboxUrl(row.link_url)) return null;
  return {
    source: "links_small",
    lien_id: row.link_id,
    lien: row.link_url,
    taille: row.size_bytes || 0,
    quality: row.quality_name || null,
    quality_id: null,
    host_id: null,
    host_name: row.host_name || null,
    langs: row.audio_langs || null,
    season_number: row.season_number != null ? row.season_number : null,
    episode_label:
      row.episode_number != null ? String(row.episode_number) : null,
    full_saison: row.is_full_season ? 1 : 0,
    created_at: row.created_at || null,
    updated_at: null,
  };
}

function normalizeDarkinoRow(row) {
  if (!row || typeof row.lien !== "string" || !row.lien) return null;
  if (isDarkiboxUrl(row.lien)) return null;
  return {
    source: "darkino",
    lien_id: row.link_id,
    lien: row.lien,
    taille: row.taille || 0,
    quality: null,
    quality_id: row.qualite != null ? row.qualite : null,
    host_id: row.id_host != null ? row.id_host : null,
    langs: null,
    season_number: row.saison != null ? row.saison : null,
    episode_label: row.episode != null ? String(row.episode) : null,
    full_saison: row.full_saison ? 1 : 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function lookupByLienId(lienId) {
  openAll();
  if (lienId == null) return null;
  const idNum = Number(lienId);
  if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0)
    return null;

  if (stmts?.linksSmallByLien) {
    try {
      const l = normalizeLinksSmallRow(stmts.linksSmallByLien.get(idNum));
      if (l) return l;
    } catch (e) {
      console.warn(
        `[darkiworldSqlite] linksSmallByLien failed for ${idNum}: ${e?.message}`,
      );
    }
  }
  if (stmts?.mirrorByLien) {
    try {
      const m = normalizeMirrorRow(stmts.mirrorByLien.get(idNum));
      if (m) return m;
    } catch (e) {
      console.warn(
        `[darkiworldSqlite] mirrorByLien failed for ${idNum}: ${e?.message}`,
      );
    }
  }
  if (stmts?.darkinoByLien) {
    try {
      const d = normalizeDarkinoRow(stmts.darkinoByLien.get(idNum));
      if (d) return d;
    } catch (e) {
      console.warn(
        `[darkiworldSqlite] darkinoByLien failed for ${idNum}: ${e?.message}`,
      );
    }
  }
  return null;
}

function toNormalizedEntry(row) {
  return {
    id: row.lien_id,
    language: row.langs || undefined,
    quality: row.quality || undefined,
    sub: undefined,
    provider: "darkiworld",
    host_id: row.host_id || undefined,
    host_name: row.host_name || undefined,
    size: row.taille || undefined,
    upload_date: row.created_at || undefined,
    host_icon: undefined,
    saison: row.season_number != null ? row.season_number : undefined,
    episode:
      row.episode_label != null && row.episode_label !== ""
        ? Number.isFinite(Number(row.episode_label))
          ? Number(row.episode_label)
          : undefined
        : undefined,
    full_saison: row.full_saison ? 1 : undefined,
    source: row.source,
  };
}

function listByTitle({ type, titleId, season, episode } = {}) {
  openAll();
  if (titleId == null) return [];
  const idNum = Number(titleId);
  if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0)
    return [];

  if (type === "tv") {
    if (season == null || episode == null) return [];
  }
  const seasonNum = season != null ? Number(season) : null;
  const episodeNum = episode != null ? Number(episode) : null;

  const merged = new Map();

  // Mirror
  try {
    if (type === "movie" && stmts?.mirrorByTitleMovie) {
      for (const r of stmts.mirrorByTitleMovie.all(idNum)) {
        const n = normalizeMirrorRow(r);
        if (n) merged.set(n.lien_id, n);
      }
    } else if (
      type === "tv" &&
      stmts?.mirrorByTitleTv &&
      Number.isFinite(seasonNum) &&
      Number.isFinite(episodeNum)
    ) {
      for (const r of stmts.mirrorByTitleTv.all(
        idNum,
        seasonNum,
        String(episodeNum),
      )) {
        const n = normalizeMirrorRow(r);
        if (n) merged.set(n.lien_id, n);
      }
    }
  } catch (e) {
    console.warn(
      `[darkiworldSqlite] mirror title fetch failed for ${idNum}: ${e?.message}`,
    );
  }

  // Darkino
  try {
    if (type === "movie" && stmts?.darkinoByTitleMovie) {
      for (const r of stmts.darkinoByTitleMovie.all(idNum)) {
        if (merged.has(r.link_id)) continue;
        const n = normalizeDarkinoRow(r);
        if (n) merged.set(n.lien_id, n);
      }
    } else if (
      type === "tv" &&
      stmts?.darkinoByTitleTv &&
      Number.isFinite(seasonNum) &&
      Number.isFinite(episodeNum)
    ) {
      for (const r of stmts.darkinoByTitleTv.all(
        idNum,
        seasonNum,
        episodeNum,
      )) {
        if (merged.has(r.link_id)) continue;
        const n = normalizeDarkinoRow(r);
        if (n) merged.set(n.lien_id, n);
      }
    }
  } catch (e) {
    console.warn(
      `[darkiworldSqlite] darkino title fetch failed for ${idNum}: ${e?.message}`,
    );
  }

  return Array.from(merged.values()).map(toNormalizedEntry);
}

const FAILED_MARKER_TTL_DEFAULT_MS = 2 * 60 * 60 * 1000; // 2h
const FAILED_MARKER_TTL_BY_CODE = {
  sqlite_miss: 0,                        // 0 — always recheck sqlite (covers post-deploy snapshot additions like links_small)
  live_no_directdl: 2 * 60 * 60 * 1000,  // 2h — hydracker returned no usable URL, persistent
  live_hydracker_error: 5 * 60 * 1000,   // 5min — transient upstream blip
};
// Keep the legacy export name for backwards compatibility with consumers
// that read it as a single-value cap; equals the longest TTL in the map.
const FAILED_MARKER_TTL_MS = FAILED_MARKER_TTL_DEFAULT_MS;

function isFailedMarkerActive(payload) {
  if (!payload || payload.failed !== true || typeof payload.failedAt !== "number") {
    return false;
  }
  const ttl = FAILED_MARKER_TTL_BY_CODE[payload.debug] ?? FAILED_MARKER_TTL_DEFAULT_MS;
  return Date.now() - payload.failedAt < ttl;
}

function isCachedDarkiboxPayload(payload) {
  if (!payload || payload.success !== true) return false;
  const url =
    typeof payload.embed_url === "string"
      ? payload.embed_url
      : payload.embed_url?.lien || "";
  return isDarkiboxUrl(url);
}

function buildPayloadFromSqliteRow(lienId, row) {
  return {
    success: true,
    id: String(lienId),
    provider: "direct",
    embed_url: {
      lien: row.lien,
      taille: row.taille,
      created_at: row.created_at,
    },
    metadata: {
      language: row.langs || undefined,
      quality: row.quality || undefined,
      sub: undefined,
      size: row.taille || undefined,
      upload_date: row.created_at || undefined,
    },
    source: row.source,
  };
}

function buildFailedMarker(lienId, errorMsg, debugMsg) {
  return {
    failed: true,
    failedAt: Date.now(),
    id: String(lienId),
    error: errorMsg || "Lien non trouvé ou inaccessible",
    debug: debugMsg || "",
  };
}

async function decodeLink(lienId, deps) {
  const {
    cacheDir, generateCacheKey, getFromCacheNoExpiration, saveToCache,
    hydrackerLive, // optional — when present, used on sqlite miss before writing sqlite_miss marker
  } = deps;
  const cacheKey = generateCacheKey(`darkiworld_decode_v2_${lienId}`);

  const tryLive = async () => {
    if (!hydrackerLive || typeof hydrackerLive.resolveLien !== "function") {
      console.log(`[decodeLink] tryLive skipped id=${lienId} reason=no_dep`);
      return null;
    }
    console.log(`[decodeLink] tryLive enter id=${lienId}`);
    const t0 = Date.now();
    try {
      const live = await hydrackerLive.resolveLien(lienId);
      const dt = Date.now() - t0;
      if (live?.payload) {
        console.log(`[decodeLink] tryLive ok id=${lienId} dt=${dt}ms`);
        return { payload: live.payload };
      }
      if (live?.failed) {
        console.log(`[decodeLink] tryLive failed id=${lienId} debug=${live.failed.debug} dt=${dt}ms`);
        return { failed: live.failed };
      }
      console.log(`[decodeLink] tryLive empty id=${lienId} dt=${dt}ms result=${JSON.stringify(live)}`);
    } catch (e) {
      console.warn(`[darkiworldSqlite] hydrackerLive.resolveLien threw for ${lienId}: ${e?.message} stack=${e?.stack?.split('\n')[1]?.trim() || '-'}`);
    }
    return null;
  };

  let cached = null;
  try {
    cached = await getFromCacheNoExpiration(cacheDir, cacheKey);
  } catch (_) {
    cached = null;
  }

  if (cached) {
    console.log(`[decodeLink] cache_hit id=${lienId} kind=${cached.failed ? 'failed:'+cached.debug : (cached.success ? 'payload' : 'other')}`);
    if (isFailedMarkerActive(cached)) {
      if (cached.debug === "sqlite_miss") {
        const row = lookupByLienId(lienId);
        if (row) {
          console.log(`[decodeLink] sqlite_miss self-heal via sqlite id=${lienId}`);
          const payload = buildPayloadFromSqliteRow(lienId, row);
          try { await saveToCache(cacheDir, cacheKey, payload); } catch (_) {}
          return { payload };
        }
        // sqlite still misses — try live before honouring the stale marker.
        console.log(`[decodeLink] sqlite_miss self-heal via live attempt id=${lienId}`);
        const live = await tryLive();
        if (live) return live;
        console.log(`[decodeLink] sqlite_miss self-heal exhausted — returning stale marker id=${lienId}`);
      }
      return { failed: cached };
    }
    if (cached.success === true && !isCachedDarkiboxPayload(cached)) {
      return { payload: cached };
    }
    // Fall through: legacy darkibox payload or malformed cache.
  } else {
    console.log(`[decodeLink] cache_miss id=${lienId}`);
  }

  const row = lookupByLienId(lienId);
  if (row) {
    const payload = buildPayloadFromSqliteRow(lienId, row);
    try { await saveToCache(cacheDir, cacheKey, payload); } catch (_) {}
    return { payload };
  }

  // Sqlite miss — try the live path if wired in. The live module owns its own
  // disk-cache write under the same key, so on success/failure we just return.
  const live = await tryLive();
  if (live) return live;

  const marker = buildFailedMarker(lienId, "Lien indisponible", "sqlite_miss");
  try { await saveToCache(cacheDir, cacheKey, marker); } catch (_) {}
  return { failed: marker };
}

module.exports = {
  isDarkiboxUrl,
  lookupByLienId,
  listByTitle,
  decodeLink,
  isFailedMarkerActive,
  isCachedDarkiboxPayload,
  buildFailedMarker,
  buildPayloadFromSqliteRow,
  FAILED_MARKER_TTL_MS,
  // exported for tests
  _openAll: openAll,
  _resetForTests: () => {
    if (mirrorDb) {
      try {
        mirrorDb.close();
      } catch (_) {}
    }
    if (darkinoDb) {
      try {
        darkinoDb.close();
      } catch (_) {}
    }
    if (linksSmallDb) {
      try {
        linksSmallDb.close();
      } catch (_) {}
    }
    mirrorDb = null;
    darkinoDb = null;
    linksSmallDb = null;
    stmts = null;
    openAttempted = false;
  },
};
