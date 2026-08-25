/**
 * 1jour1film (1J1F) source — Dooplay/WordPress scraper.
 * Mount point: app.use('/api/j1f', require('./routes/j1f'))
 *
 * Endpoints (TMDB id in, players out — same contract as fstream/wiflix):
 *   GET /movie/:id
 *   GET /tv/:id/season/:season   (optional ?episode=N)
 *
 * Flow
 * ----
 * 0. Domain rotates. Resolve the live base from the stable /go/ entry
 *    (TARGET_URL = "..."), cached + env-overridable (J1F_BASE_URL).
 * 1. Search via the nonce-free WP listing {base}/?s={query} -> /films/ +
 *    /tvshows/ links (slug carries the year). Matched against TMDB title+year.
 * 2. The real source list is NOT in the plain HTML — it ships base64-encoded
 *    inside <script defer src="data:text/javascript;base64,...">. Decode those:
 *      - Movies: `var J1F_SRV = [{label,url,type,source}, ...]`
 *      - Series: `var j1fEpsData = [{num,label,servers:[{label,url,type}], ...}]`
 *    (the season's /saisons/{slug}/ page; pick the link whose slug carries the
 *    season number).
 * 3. Each source has a `source` tag:
 *      - "manual"  -> 1J1F's own players (totocoutouno, bysezoxexe, ...) — UNIQUE.
 *      - "frembed"/"vidsrc"/"videasy" -> generic TMDB-id aggregators that Movix
 *        already exposes as their own sources. We DROP these (J1F_DROP_SOURCES)
 *        so 1J1F doesn't just duplicate frembed; only the unique players remain.
 *    Kept players are split VF/VOSTFR by label.
 *
 * When a title yields no unique (manual) player, we still cache the negative
 * result (sentinel) so the frontend marks 1J1F "checked, nothing extra" and we
 * don't re-scrape on every hit.
 *
 * All fetches go through make1j1fRequest (CycleTLS JA3-Chrome + ProxyScrape
 * rotation) which clears the Cloudflare shield. Works from datacenter IPs —
 * verified: the J1F_SRV/j1fEpsData blobs are in the page for any client, just
 * base64-wrapped.
 */

const express = require('express');
const router = express.Router();
const cheerio = require('cheerio');

const { fetchTmdbDetails } = require('../utils/tmdbCache');
const { make1j1fRequest } = require('../utils/proxyManager');
const {
  CACHE_DIR,
  generateCacheKey,
  getFromCacheNoExpiration,
  saveToCache,
} = require('../utils/cacheManager');
const { calculateTitleSimilarity } = require('./coflix'); // pure fn, no configure() needed
const { respondWithResolvedSources } = require('../utils/embedExtraction');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// --- Env-overridable knobs (domain rotates; markup may drift) ---
const GO_URL = process.env.J1F_GO_URL || 'https://1jour1film2026.site/go/';
const BASE_OVERRIDE = (process.env.J1F_BASE_URL || '').trim().replace(/\/+$/, '');
// Source tags to DROP — generic aggregators Movix already has as separate
// sources. Anything not listed (e.g. "manual") is kept as a unique 1J1F player.
const DROP_SOURCES = new Set(
  (process.env.J1F_DROP_SOURCES || 'frembed,vidsrc,videasy')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
// Dropped by host at SCRAPE time (never cached): generic aggregators with no
// `source` tag (vsembed=vidsrc, videasy, frembed).
const DROP_HOST_RE = new RegExp(process.env.J1F_DROP_HOSTS || 'vsembed|videasy|frembed|vidsrc', 'i');
// Hidden AFTER cache: these stay IN the cache but are stripped from the response.
// Flip J1F_HIDE_HOSTS to un-hide instantly — no re-scrape. ezplayer (doremifasol)
// + uns.bio (dismoiceline) + bysezoxexe.com, per request.
const HIDE_HOST_RE = new RegExp(
  process.env.J1F_HIDE_HOSTS || 'ezplayer|uns\\.bio|bysezoxexe\\.com',
  'i',
);
// 1J1F's own player host (onregardeou.site/video/{slug}) is a WRAPPER page, not
// an embed — unwrap it into its real nested servers. Host rotates → env-override.
const WRAP_HOST_RE = new RegExp(process.env.J1F_WRAP_HOSTS || 'onregardeou', 'i');
const SRV_VAR = process.env.J1F_SRV_VAR || 'J1F_SRV'; // movie source array
const EPS_VAR = process.env.J1F_EPS_VAR || 'j1fEpsData'; // series episodes array
const SIMILARITY_THRESHOLD = parseFloat(process.env.J1F_SIMILARITY || '0.7');
// REST search page size. The listing is dominated by /episodes/ hits, which we
// discard — 20 leaves room for the /films/ + /tvshows/ entries to survive.
const SEARCH_PER_PAGE = parseInt(process.env.J1F_SEARCH_PER_PAGE || '20', 10);
const BASE_TTL_MS = 6 * 60 * 60 * 1000; // re-resolve domain every 6h
const REFRESH_MS = 40 * 60 * 1000; // serve cache fresh within this window

const hostOf = (u) => {
  const m = (u || '').match(/^https?:\/\/(?:www\.)?([^/]+)/);
  return m ? m[1] : u || 'embed';
};
const toBody = (r) => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
// J1F now base64-wraps the `url` field inside J1F_SRV / servers. Decode it back
// to the real embed URL; leave already-plain http(s) URLs untouched (backward-compat).
const decodeUrl = (u) => {
  if (typeof u !== 'string' || /^https?:\/\//i.test(u)) return u;
  try {
    const dec = Buffer.from(u, 'base64').toString('utf-8');
    return /^https?:\/\//i.test(dec) ? dec : u;
  } catch {
    return u;
  }
};
// VOSTFR only when the label is VOSTFR-only; "VF + VOSTFR" (dual) stays VF.
const langOf = (label) =>
  /vostfr/i.test(label || '') && !/\bvf\b/i.test(label || '') ? 'VOSTFR' : 'VF';
const yearFromSlug = (slug) => {
  const m = slug.match(/-(\d{4})(?:[-/]|$)/);
  return m ? parseInt(m[1], 10) : null;
};

// === Domain resolution (cached) ===
let cachedBase = null;
let cachedBaseAt = 0;
async function resolveBase() {
  if (BASE_OVERRIDE) return BASE_OVERRIDE;
  if (cachedBase && Date.now() - cachedBaseAt < BASE_TTL_MS) return cachedBase;
  const res = await make1j1fRequest(GO_URL, { timeout: 20 });
  const body = toBody(res);
  const m = body.match(/TARGET_URL\s*=\s*"([^"]+)"/);
  if (!m) {
    // make1j1fRequest never throws on a bad status: a proxy error page, a CF
    // challenge served as 200, or an empty/truncated body all land here looking
    // like a success. Log what actually came back so the cause is identifiable
    // (proxy junk vs. real markup drift on /go/).
    console.warn(
      `[1J1F GO] ${GO_URL} -> status=${res.status} via=${res.via || '?'} len=${body.length} body="${body
        .slice(0, 300)
        .replace(/\s+/g, ' ')}"`,
    );
    if (cachedBase) return cachedBase; // keep last good on a bad /go/ fetch
    throw new Error('[1J1F] TARGET_URL introuvable sur /go/');
  }
  cachedBase = m[1].replace(/\\\//g, '/').replace(/\/+$/, '');
  cachedBaseAt = Date.now();
  // Rare (6h TTL) and the single most useful line when debugging egress: it
  // names the transport that currently gets through to 1J1F.
  console.log(`[1J1F GO] base=${cachedBase} via=${res.via || '?'}`);
  return cachedBase;
}

// In-flight scrapes keyed by cache key, so concurrent cold requests for the same
// title kick off only ONE background scrape.
const inFlight = new Map();

// Non-blocking cache — never make the user wait on the slow CycleTLS+proxy scrape:
//  - fresh cache      -> return it
//  - stale cache      -> return stale now, refresh in background (stale-while-revalidate)
//  - cold (no cache)  -> return { pending:true } immediately, scrape in background
// The background job caches the real result; the client gets it on a subsequent
// request (the frontend retries shortly after a `pending` response). Negative
// results are cached too (sentinel) so frembed-only titles don't re-scrape.
function startBackgroundScrape(key, fetcher, cached) {
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const fresh = await fetcher();
      // A failure must never clobber a good entry. Two rules:
      //  - `_transient` (Cloudflare challenge, timeout, markup drift) says
      //    nothing about the title -> never persisted, the next request retries.
      //  - any other success:false is refused while a success:true is cached;
      //    the known-good players keep being served until a real scrape wins.
      if (fresh._transient) {
        console.warn(`[1J1F CACHE] ${key}: ${fresh.error} -> non mis en cache (echec transitoire)`);
        return fresh;
      }
      if (fresh.success === false && cached && cached.success) {
        console.warn(`[1J1F CACHE] ${key}: ${fresh.error} -> cache existant (success) conserve`);
        return fresh;
      }
      fresh._ts = Date.now();
      await saveToCache(CACHE_DIR.J1F, key, fresh);
      return fresh;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  job.catch(() => {}); // next request retries; avoid unhandled rejection
  return job;
}

async function withCache(key, fetcher) {
  const cached = await getFromCacheNoExpiration(CACHE_DIR.J1F, key);
  if (cached && cached._ts && Date.now() - cached._ts < REFRESH_MS) return cached;

  // Stale or cold: trigger a background refresh/scrape (deduped), don't await it.
  startBackgroundScrape(key, fetcher, cached);

  if (cached) return cached; // stale-while-revalidate: serve stale immediately
  return { success: false, pending: true, tmdb_id: undefined }; // cold: tell client to retry shortly
}

// Decode every <script ... src="data:text/javascript;base64,...">. The real
// player data (J1F_SRV / j1fEpsData) lives base64-wrapped in these.
function decodeDataScripts(html) {
  const out = [];
  const re = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(Buffer.from(m[1], 'base64').toString('utf-8'));
    } catch {
      /* skip undecodable */
    }
  }
  return out;
}

// Pull `var <name> = [ ... ];` (a JSON array) out of the decoded data: scripts.
function extractJsArray(html, varName) {
  const re = new RegExp(`(?:var|let|const)\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`);
  for (const js of decodeDataScripts(html)) {
    const m = js.match(re);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* malformed — try the next script */
      }
    }
  }
  return null;
}

// Keep only unique (non-generic) servers, split VF/VOSTFR by label.
function splitUniqueServers(servers) {
  const vf = [];
  const vostfr = [];
  for (const s of servers || []) {
    if (!s || !s.url) continue;
    if (DROP_SOURCES.has(String(s.source || '').toLowerCase())) continue; // drop by `source` tag (movies)
    const url = decodeUrl(s.url);
    if (DROP_HOST_RE.test(url)) continue; // drop by host (series servers have no `source` tag)
    const entry = {
      name: hostOf(url),
      url,
      type: s.type === 'mp4' ? 'mp4' : 'iframe',
      label: s.label || '',
      source: s.source || 'manual',
    };
    (langOf(s.label) === 'VOSTFR' ? vostfr : vf).push(entry);
  }
  return { vf, vostfr };
}

// onregardeou wrapper HTML ships its real embed list inline as
// `const videoData = { ..., "servers":[{name,url,type}, ...] }`. Pull that array.
function parseWrapperServers(html) {
  const m = html.match(/"servers"\s*:\s*(\[[\s\S]*?\])/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]); // JSON.parse un-escapes the \/ in the urls
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// Replace any wrapper entry (onregardeou.site) with its nested servers. The bare
// wrapper URL 301s, so the trailing slash is required. Nested servers inherit the
// wrapper's VF/VOSTFR label. On fetch/parse failure the wrapper is kept as-is
// (still playable as an iframe). Order-preserving; wrapper fetches run in parallel.
async function expandWrappers(servers) {
  const out = [];
  await Promise.all(
    (servers || []).map(async (s, i) => {
      const url = decodeUrl(s && s.url);
      if (!s || !url || !WRAP_HOST_RE.test(url)) {
        out[i] = s ? [s] : [];
        return;
      }
      const wrapUrl = `${url.split('#')[0].split('?')[0].replace(/\/+$/, '')}/`;
      try {
        const res = await make1j1fRequest(wrapUrl, { timeout: 15 });
        const nested = parseWrapperServers(toBody(res));
        if (nested && nested.length) {
          out[i] = nested.map((n) => ({
            label: s.label || '', // keep wrapper's VF/VOSTFR lang
            url: n.url,
            type: /\.(mp4|m3u8|webm)(\?|$)/i.test(n.url || '') ? 'mp4' : 'iframe',
            source: s.source || 'manual',
          }));
          return;
        }
      } catch (e) {
        console.log(`[1J1F WRAP] ${wrapUrl}: ${e.message}`);
      }
      out[i] = [s]; // fetch/parse failed -> keep wrapper iframe
    }),
  );
  return out.flat();
}

// WP hands back titles with HTML entities (&rsquo;, &amp;, &#8217;) — decode them
// so the TMDB similarity match compares real characters.
const decodeEntities = (s) => (s ? cheerio.load(`<x>${s}</x>`)('x').text() : '');

// === Search -> [{url, slug, type, year, title}] ===
// Uses the WordPress REST API, NOT the {base}/?s= listing: that endpoint is now
// behind a Cloudflare managed challenge for every client (verified 403 from a
// clean residential IP, not just from proxies/relays). /wp-json is still open and
// is a better source anyway — it returns the real post title instead of one
// reconstructed from the slug, so the match against TMDB is far more reliable.
// `subtype` is not usable as a query param (the WAF 403s it); results are typed
// from their URL path instead, which also drops the /episodes/ noise.
async function searchJ1F(base, query) {
  const url = `${base}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=${SEARCH_PER_PAGE}`;
  const res = await make1j1fRequest(url, { timeout: 15 });
  const body = toBody(res);
  let items;
  try {
    items = JSON.parse(body);
  } catch {
    // Not JSON = a challenge page / WAF error, i.e. we never reached 1J1F.
    // THROWING is what separates that from a genuine empty result: the REST API
    // answers `[]` for an unknown title, which is a definitive "not here" and
    // must stay cacheable. The message carries the egress (`via`) and the head
    // of the body — a relay 1020 vs a proxy challenge vs a direct block.
    throw new Error(
      `reponse non-JSON status=${res.status} via=${res.via || '?'} len=${body.length} body="${body
        .slice(0, 200)
        .replace(/\s+/g, ' ')}"`,
    );
  }
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const out = [];
  for (const it of items) {
    const href = (it && it.url) || '';
    const m = href.match(/\/(films|tvshows)\/([^/"?#]+)\/?/);
    if (!m) continue; // /episodes/ and anything that isn't a film/show page
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      url: href.split('#')[0],
      slug,
      type: m[1] === 'films' ? 'movie' : 'tv',
      year: yearFromSlug(slug),
      title: decodeEntities(it.title),
    });
  }
  return out;
}

// Best search hit for a TMDB title/year. Scored against the REST post title when
// there is one, and against the slug-reconstructed title as a fallback (best of
// the two wins) — slugs carry noise the regex below only partly strips.
function pickBest(results, mediaType, titles, year) {
  let best = null;
  let bestScore = 0;
  for (const r of results.filter((x) => x.type === mediaType)) {
    const slugTitle = r.slug
      .replace(/-(streaming|vf|vostfr|hd|fhd|complete?|netflix|serie|saison|film|episode|\d{4}|[a-z]\d+)\b/gi, ' ')
      .replace(/-/g, ' ')
      .trim();
    const candidates = [r.title, slugTitle].filter(Boolean);
    let score = 0;
    for (const t of titles) {
      for (const c of candidates) score = Math.max(score, calculateTitleSimilarity(t, c));
    }
    if (year && r.year === year) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= SIMILARITY_THRESHOLD ? best : null;
}

// A failure that says nothing about the title itself (Cloudflare challenge,
// timeout, markup drift). Flagged so startBackgroundScrape refuses to persist
// it — a blocked scrape must never turn into a cached "not found".
const transient = (error, tmdbId, extra = {}) => ({
  success: false,
  error,
  tmdb_id: tmdbId,
  _transient: true,
  ...extra,
});

// Returns { hit, reachable }. `reachable` is false only when EVERY search attempt
// threw, i.e. nothing came back as JSON. An empty `[]` still counts as reached —
// that is the REST API telling us the title genuinely isn't on 1J1F, which is a
// cacheable negative, unlike a block that must never be cached as "not found".
async function findOnJ1F(base, mediaType, tmdb) {
  const titles = [
    mediaType === 'movie' ? tmdb.title : tmdb.name,
    mediaType === 'movie' ? tmdb.original_title : tmdb.original_name,
  ].filter((t, i, a) => t && a.indexOf(t) === i);
  const dateStr = mediaType === 'movie' ? tmdb.release_date : tmdb.first_air_date;
  const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

  let reachable = false;
  for (const t of titles) {
    let results = [];
    try {
      results = await searchJ1F(base, t);
    } catch (e) {
      console.log(`[1J1F SEARCH] "${t}": ${e.message}`);
      continue;
    }
    reachable = true; // searchJ1F returned parsed JSON -> 1J1F answered us
    const hit = pickBest(results, mediaType, titles, year);
    if (hit) return { hit, reachable: true };
  }
  return { hit: null, reachable };
}

// === Movie ===
async function fetchMovie(base, tmdbId) {
  const tmdb = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, 'movie', 'fr-FR');
  if (!tmdb) return transient('Film non trouve sur TMDB', tmdbId);

  const { hit, reachable } = await findOnJ1F(base, 'movie', tmdb);
  if (!hit) {
    return reachable
      ? { success: false, error: 'Film non trouve sur 1jour1film', tmdb_id: tmdbId }
      : transient('Recherche 1jour1film injoignable', tmdbId);
  }

  const res = await make1j1fRequest(hit.url, { timeout: 15 });
  const srv = extractJsArray(toBody(res), SRV_VAR);
  if (!srv) {
    console.warn(`[1J1F MOVIE] ${tmdbId}: ${SRV_VAR} introuvable sur ${hit.url}`);
    return transient('Sources introuvables', tmdbId, { j1f_url: hit.url });
  }

  const expanded = await expandWrappers(srv); // unwrap onregardeou -> real embeds
  const { vf, vostfr } = splitUniqueServers(expanded);
  if (vf.length === 0 && vostfr.length === 0) {
    // Only generic aggregators (frembed/vidsrc/videasy) — nothing 1J1F adds.
    return { success: false, error: 'Aucune source unique (generiques uniquement)', tmdb_id: tmdbId, j1f_url: hit.url };
  }
  return {
    success: true,
    tmdb_id: tmdbId,
    title: tmdb.title,
    original_title: tmdb.original_title,
    source: '1jour1film',
    j1f_url: hit.url,
    players: { vf, vostfr },
    cache_timestamp: new Date().toISOString(),
  };
}

// === Series ===
async function fetchSeason(base, tmdbId, seasonNum, episodeNum) {
  const tmdb = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, 'tv', 'fr-FR');
  if (!tmdb) return transient('Serie non trouvee sur TMDB', tmdbId);

  const { hit, reachable } = await findOnJ1F(base, 'tv', tmdb);
  if (!hit) {
    return reachable
      ? { success: false, error: 'Serie non trouvee sur 1jour1film', tmdb_id: tmdbId }
      : transient('Recherche 1jour1film injoignable', tmdbId);
  }

  // tvshow page -> the /saisons/ link whose slug carries this season number.
  const showRes = await make1j1fRequest(hit.url, { timeout: 15 });
  const $show = cheerio.load(toBody(showRes));
  const seasonLinks = $show('a[href*="/saisons/"]');
  let seasonUrl = null;
  seasonLinks.each((_, a) => {
    const href = $show(a).attr('href') || '';
    const m = href.match(/saison-(\d+)/i);
    if (m && parseInt(m[1], 10) === Number(seasonNum)) seasonUrl = href.split('#')[0];
  });
  if (!seasonUrl) {
    // Zero season links at all = the show page never rendered (challenge/error),
    // not a show that lacks this season.
    return seasonLinks.length > 0
      ? { success: false, error: `Saison ${seasonNum} introuvable`, tmdb_id: tmdbId, j1f_url: hit.url }
      : transient('Page serie injoignable', tmdbId, { j1f_url: hit.url });
  }

  const seasonRes = await make1j1fRequest(seasonUrl, { timeout: 15 });
  const eps = extractJsArray(toBody(seasonRes), EPS_VAR);
  if (!eps || !Array.isArray(eps)) {
    console.warn(`[1J1F TV] ${tmdbId} S${seasonNum}: ${EPS_VAR} introuvable sur ${seasonUrl}`);
    return transient('Episodes introuvables', tmdbId, { j1f_url: seasonUrl });
  }

  // Shape matches wiflix's TV response: `episodes` keyed by episode number,
  // each { vf:[{name,url,...}], vostfr:[...] } — the whole season is returned
  // and the frontend slices the current episode. `?episode=` still narrows it.
  const wanted = episodeNum ? eps.filter((e) => Number(e.num) === Number(episodeNum)) : eps;
  const episodes = {};
  await Promise.all(
    wanted.map(async (e) => {
      const expanded = await expandWrappers(e.servers); // unwrap onregardeou -> real embeds
      const { vf, vostfr } = splitUniqueServers(expanded);
      if (!vf.length && !vostfr.length) return; // drop generic-only episodes
      episodes[String(e.num)] = { vf, vostfr, label: e.label || '' };
    }),
  );

  if (Object.keys(episodes).length === 0) {
    return { success: false, error: 'Aucune source unique (generiques uniquement)', tmdb_id: tmdbId, j1f_url: seasonUrl };
  }
  return {
    success: true,
    tmdb_id: tmdbId,
    title: tmdb.name,
    source: '1jour1film',
    j1f_url: seasonUrl,
    season: Number(seasonNum),
    episodes,
    cache_timestamp: new Date().toISOString(),
  };
}

// Strip HIDE_HOST_RE players from a (cached) response on the way out — the cache
// keeps them, the client never sees them. Non-mutating; handles movie/series/
// pending/error shapes.
const keepVisible = (arr) =>
  Array.isArray(arr) ? arr.filter((p) => !HIDE_HOST_RE.test((p && p.url) || '')) : arr;
function hideHosts(data) {
  if (!data || !data.success) return data;
  if (data.players) {
    return {
      ...data,
      players: { vf: keepVisible(data.players.vf), vostfr: keepVisible(data.players.vostfr) },
    };
  }
  if (data.episodes) {
    const episodes = {};
    for (const [num, ep] of Object.entries(data.episodes)) {
      episodes[num] = { ...ep, vf: keepVisible(ep.vf), vostfr: keepVisible(ep.vostfr) };
    }
    return { ...data, episodes };
  }
  return data;
}

// === Routes ===
// 1jour1film range la map de langues à même l'épisode (`{ vf, vostfr, label }`),
// sans enveloppe `languages` — d'où `languageKey: null`.
const respondWithEpisodeSources = (req, res, payload) =>
  respondWithResolvedSources(req, res, payload, { languageKey: null, label: '1J1F TV' });

const respondWithMovieSources = (req, res, payload) =>
  respondWithResolvedSources(req, res, payload, { movieMapKey: 'players', label: '1J1F MOVIE' });

router.get('/movie/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const base = await resolveBase();
    const data = await withCache(generateCacheKey({ src: 'j1f', t: 'movie', id }), () =>
      fetchMovie(base, id),
    );
    await respondWithMovieSources(req, res, hideHosts(data));
  } catch (err) {
    console.error(`[1J1F MOVIE] ${id}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur 1jour1film', tmdb_id: id });
  }
});

router.get('/tv/:id/season/:season', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  try {
    const base = await resolveBase();
    const key = generateCacheKey({ src: 'j1f', t: 'tv', id, season, episode: episode || '' });
    const data = await withCache(key, () => fetchSeason(base, id, season, episode));
    await respondWithEpisodeSources(req, res, hideHosts(data));
  } catch (err) {
    console.error(`[1J1F TV] ${id} S${season}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur 1jour1film', tmdb_id: id });
  }
});

module.exports = router;
