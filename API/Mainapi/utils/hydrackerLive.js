// API/Mainapi/utils/hydrackerLive.js
//
// Live raw-URL resolution path used by darkiworldSqlite.decodeLink when both
// the disk cache and the two sqlite snapshots miss.
//
// Hydracker's /api/v1/content/liens/:id returns the raw hoster URL directly in
// `lien.lien`, so resolution is a single direct GET — no debrid roundtrip, no
// concurrency queue, no single-flight lock. The disk cache + a short Redis
// cache + a cluster-wide 5xx cooldown are the only protection layers kept.

'use strict';

async function fetchHydrackerLien(lienId, deps) {
  const { axios, cookies, xsrf, timeoutMs } = deps;
  try {
    const resp = await axios.get(
      `https://hydracker.com/api/v1/content/liens/${lienId}`,
      {
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          cookie: cookies || '',
          'x-xsrf-token': xsrf || '',
          'user-agent': 'Mozilla/5.0 (Movix HydrackerLive)',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );
    const body = resp.data || {};
    const lienObj = body.lien || {};
    const lienUrl = typeof lienObj.lien === 'string' && lienObj.lien ? lienObj.lien : null;
    const directDL = body.directDL;
    if (!lienUrl && (!directDL || typeof directDL !== 'string')) {
      return { ok: false, code: 'live_no_directdl' };
    }
    return {
      ok: true,
      directDL: directDL || lienUrl,
      lienUrl,
      id_host: lienObj.id_host ?? null,
      rawUrl: typeof body.raw_url === 'string' && body.raw_url ? body.raw_url : null,
      taille: lienObj.taille ?? null,
      created_at: lienObj.created_at ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'live_hydracker_error',
      status: e?.response?.status || 0,
    };
  }
}

async function fetchHydrackerTitleLiens(titleId, deps) {
  const { axios, cookies, xsrf, timeoutMs } = deps;
  try {
    const resp = await axios.get(
      `https://hydracker.com/api/v1/titles/${titleId}/content/liens`,
      {
        params: {
          perPage: 100,
          loader: 'linksdl',
          filters: '',
          paginate: 'preferLengthAware',
        },
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          cookie: cookies || '',
          'x-xsrf-token': xsrf || '',
          'user-agent': 'Mozilla/5.0 (Movix HydrackerLive)',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );
    const rows = Array.isArray(resp.data?.pagination?.data) ? resp.data.pagination.data : [];
    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      code: 'live_hydracker_list_error',
      status: e?.response?.status || 0,
    };
  }
}

function normalizeHydrackerLien(row) {
  if (!row || typeof row.id !== 'number') return null;
  const langs = Array.isArray(row.langues_compact)
    ? row.langues_compact.map((l) => l.name).filter(Boolean).join('/')
    : '';
  const subs = Array.isArray(row.subs_compact)
    ? row.subs_compact.map((s) => s.name).filter(Boolean).join('/')
    : '';
  const hostName = row.host?.name || undefined;
  return {
    id: row.id,
    language: langs || undefined,
    quality: row.qual?.qual || undefined,
    sub: subs || undefined,
    // Frontend uses `provider` as the visible host label, so surface the
    // real host name (1Fichier, Send, ...) instead of a generic tag.
    provider: hostName || 'darkiworld',
    host_id: row.id_host != null ? row.id_host : undefined,
    host_name: hostName,
    host_icon: row.host?.icon || undefined,
    size: row.taille || undefined,
    upload_date: row.created_at || undefined,
    saison: row.saison != null ? row.saison : undefined,
    episode: row.episode != null ? row.episode : undefined,
    full_saison: row.full_saison ? 1 : undefined,
    source: 'hydracker-live',
  };
}

function buildFailedMarker(lienId, code, status) {
  return {
    failed: true,
    failedAt: Date.now(),
    id: String(lienId),
    error: 'Lien indisponible',
    debug: code,
    status: status ?? null,
  };
}

function buildSuccessPayload(lienId, hyd) {
  const url = hyd.lienUrl || hyd.directDL || hyd.rawUrl;
  return {
    success: true,
    id: String(lienId),
    provider: 'hydracker-live',
    embed_url: {
      lien: url,
      taille: hyd.taille ?? 0,
      created_at: hyd.created_at ?? null,
      id_host: hyd.id_host ?? null,
    },
    metadata: {
      language: undefined,
      quality: undefined,
      sub: undefined,
      size: hyd.taille ?? undefined,
      upload_date: hyd.created_at ?? undefined,
      host_id: hyd.id_host ?? undefined,
    },
    source: 'live',
  };
}

function createHydrackerLive(deps) {
  const {
    redis, axios, cookies, xsrf,
    timeoutMs = 20000,
    cacheGet, cacheSet, cacheKeyFor, cacheDir,
    hydrackerLienCacheTtl = 60,
    titleListCacheTtl = 300,
    upstreamCooldownMs = 5 * 60 * 1000,
  } = deps;

  // Cluster-wide hydracker upstream cooldown — stored in Redis so a 5xx
  // observed by any worker stops ALL workers from hammering a sick server.
  // Key carries a TTL = upstreamCooldownMs, so it self-expires.
  // Fail-open on Redis errors: a Redis outage must not block live fetches.
  const HYDRACKER_COOLDOWN_KEY = 'hydracker:cooldown:5xx';
  const cooldownTtlSec = Math.max(1, Math.ceil(upstreamCooldownMs / 1000));
  async function isHydrackerInCooldown() {
    try {
      const exists = await redis.exists(HYDRACKER_COOLDOWN_KEY);
      return exists === 1;
    } catch (_) {
      return false;
    }
  }
  async function armHydrackerCooldownIfServerError(status) {
    if (typeof status !== 'number' || status < 500 || status >= 600) {
      return false;
    }
    try {
      // NX so concurrent 5xx responses don't keep resetting the TTL window —
      // first writer wins, the rest are no-ops.
      const armed = await redis.set(
        HYDRACKER_COOLDOWN_KEY,
        String(Date.now()),
        'EX',
        cooldownTtlSec,
        'NX',
      );
      if (armed === 'OK') {
        console.warn(
          `[hydrackerLive] upstream ${status} — cooldown ${Math.round(upstreamCooldownMs / 60000)}min (cluster-wide)`,
        );
      }
    } catch (_) {
      // Redis down — cooldown not armed, but per-worker retry pressure stays
      // low because hydracker itself is still returning 5xx quickly.
    }
    return true;
  }

  async function getCachedHydracker(lienId) {
    try {
      const raw = await redis.get(`hydracker:lien:${lienId}`);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* swallow */ }
    return null;
  }

  async function cacheHydracker(lienId, hyd) {
    try {
      await redis.set(
        `hydracker:lien:${lienId}`,
        JSON.stringify(hyd),
        'EX',
        hydrackerLienCacheTtl,
      );
    } catch (_) { /* swallow */ }
  }

  async function resolveLien(lienId) {
    const key = cacheKeyFor(lienId);

    // Disk cache: only short-circuit on success payloads. Failed markers
    // (especially the legacy `sqlite_miss` one) are precisely why the caller's
    // decodeLink self-heal decided to invoke us; honouring them would loop the
    // retry back into the same marker and the live fetch would never run.
    const pre = await cacheGet(cacheDir, key);
    if (pre && pre.success === true) return { payload: pre };

    // Reuse a recent hydracker response (Redis, hydrackerLienCacheTtl) to save
    // rate-limit budget on bursts before the disk success payload is written.
    let hyd = await getCachedHydracker(lienId);
    if (!hyd) {
      if (await isHydrackerInCooldown()) {
        // Don't persist marker — cooldown is transient; retry cheap after the
        // window ends instead of locking a 2h disk marker.
        return { failed: buildFailedMarker(lienId, 'live_hydracker_cooldown', 0) };
      }
      hyd = await fetchHydrackerLien(lienId, { axios, cookies, xsrf, timeoutMs });
      if (hyd.ok) {
        await cacheHydracker(lienId, hyd);
      } else {
        await armHydrackerCooldownIfServerError(hyd.status);
      }
    }
    if (!hyd.ok) {
      const marker = buildFailedMarker(lienId, hyd.code, hyd.status);
      try { await cacheSet(cacheDir, key, marker); } catch (_) {}
      return { failed: marker };
    }

    const payload = buildSuccessPayload(lienId, hyd);
    try { await cacheSet(cacheDir, key, payload); } catch (_) {}
    return { payload };
  }

  async function listLiensForTitle(titleId, opts = {}) {
    const { type, season, episode } = opts;
    const titleNum = Number(titleId);
    if (!Number.isFinite(titleNum) || !Number.isInteger(titleNum) || titleNum <= 0) {
      return [];
    }
    const cacheKey = `hydracker:title:${titleNum}`;

    let rows = null;
    try {
      const raw = await redis.get(cacheKey);
      if (raw) {
        try { rows = JSON.parse(raw); } catch (_) { rows = null; }
      }
    } catch (_) { /* redis down — refetch */ }

    if (!rows) {
      if (await isHydrackerInCooldown()) {
        console.warn(`[hydrackerLive] title list skipped (cooldown active) title=${titleNum}`);
        return [];
      }
      const res = await fetchHydrackerTitleLiens(titleNum, { axios, cookies, xsrf, timeoutMs });
      if (!res.ok) {
        await armHydrackerCooldownIfServerError(res.status);
        console.warn(`[hydrackerLive] title list fetch failed title=${titleNum} code=${res.code} status=${res.status ?? '-'}`);
        return [];
      }
      rows = res.rows;
      try {
        await redis.set(cacheKey, JSON.stringify(rows), 'EX', titleListCacheTtl);
      } catch (_) { /* swallow */ }
    }

    let filtered = rows;
    if (type === 'tv') {
      const sNum = Number(season);
      const eNum = Number(episode);
      if (Number.isFinite(sNum) && Number.isFinite(eNum)) {
        filtered = rows.filter((r) =>
          Number(r.saison) === sNum && (Number(r.episode) === eNum || r.full_saison === 1 || r.full_saison === true),
        );
      }
    }
    // For 'movie' (or unspecified) return everything — hydracker stores movies
    // as saison=0/episode=null and the caller already implies that by passing
    // type='movie'.

    return filtered.map(normalizeHydrackerLien).filter(Boolean);
  }

  return { resolveLien, listLiensForTitle };
}

module.exports = {
  createHydrackerLive,
  _fetchHydrackerLien: fetchHydrackerLien,
  _fetchHydrackerTitleLiens: fetchHydrackerTitleLiens,
  _normalizeHydrackerLien: normalizeHydrackerLien,
  _buildSuccessPayload: buildSuccessPayload,
  _buildFailedMarker: buildFailedMarker,
};
