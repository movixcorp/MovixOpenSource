/**
 * SwiftFlow source — partner JSON API keyed by TMDB id (no scraping).
 * Mount point: app.use('/api/swiftflow', require('./routes/swiftflow'))
 *
 * Endpoints (TMDB id in, players out — same contract as fstream/wiflix/j1f):
 *   GET /movie/:id
 *   GET /tv/:id/season/:season   (optional ?episode=N)
 *
 * Upstream (base + key env-overridable):
 *   ?route=movies/{id}  -> { success, data:{ title, year, sources:[{language,quality,size,...}] } }
 *   ?route=series/{id}  -> { success, data:{ seasons:[{ season:"S01", episodes:[...] }] } }
 *   not found           -> HTTP 404 { success:false }
 * Player iframe handed to the frontend:
 *   movies: ?route=movies/{id}/player&api_key=...
 *   series: ?route=series/{id}/player&api_key=...&season={s}&episode={e}
 * (vérifié: season/episode sont bien honorés par le player série)
 *
 * Cache — la limite upstream est 1000 req/min, donc on ne touche SwiftFlow
 * qu'une fois par titre par fenêtre TTL :
 *   - stale-while-revalidate sur le cache disque+mémoire partagé (stamp _ts) :
 *     frais -> servi ; périmé -> stale servi tout de suite + refresh en fond ;
 *     froid -> fetch inline (API JSON rapide). Tout est dédupliqué in-flight.
 *   - les négatifs (404) sont cachés aussi — la plupart des ids TMDB ne sont
 *     PAS sur SwiftFlow, c'est le gros du volume.
 *   - TTL : 1h pour tout (films, séries, négatifs) — un ajout ou un nouvel
 *     épisode devient visible en <= 1h.
 *   - une erreur upstream (timeout/5xx) n'est JAMAIS cachée : le stale reste
 *     servi et la requête suivante retente le refresh.
 *   - garde-fou: max ~900 appels upstream/min, au-delà on échoue vite (non
 *     caché) au lieu de brûler la limite.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

const {
  CACHE_DIR,
  getFromCacheNoExpiration,
  saveToCache,
} = require('../utils/cacheManager');
const { redis } = require('../config/redis');
const { respondWithResolvedSources } = require('../utils/embedExtraction');

const API_BASE = (process.env.SWIFTFLOW_BASE_URL || '').replace(/\/+$/, '');
// Clé non secrète (SwiftFlow l'embarque dans l'URL du player côté client), mais
// pas de fallback hardcodé — doit venir de l'env comme la base.
const API_KEY = process.env.SWIFTFLOW_API_KEY || '';

// Sans base+clé, apiUrl() produit une URL relative -> axios throw "Invalid URL"
// à chaque requête. On désactive proprement la source et on prévient une fois.
const CONFIGURED = Boolean(API_BASE && API_KEY);
if (!CONFIGURED) {
  console.warn('[SwiftFlow] SWIFTFLOW_BASE_URL / SWIFTFLOW_API_KEY manquants — source désactivée');
}

const MOVIE_TTL_MS = 60 * 60 * 1000;
const TV_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10000;
const UPSTREAM_MAX_PER_MIN = 900; // marge sous la limite SwiftFlow (1000/min)

const apiUrl = (route) => `${API_BASE}/api/v1/index.php?route=${route}&api_key=${API_KEY}`;
const moviePlayerUrl = (id) => apiUrl(`movies/${id}/player`);
const episodePlayerUrl = (id, season, episode) =>
  `${apiUrl(`series/${id}/player`)}&season=${season}&episode=${episode}`;

// === Garde-fou rate limit upstream (fenêtre fixe 60s, partagée cluster) ===
// Un compteur en mémoire serait PAR WORKER: en cluster à N workers ça
// autoriserait N×MAX appels/min et exploserait la limite SwiftFlow (1000/min).
// On passe donc par Redis INCR sur une clé bucketée à la minute, partagée entre
// tous les workers. Redis down -> fail-open (le cache SWR limite déjà la
// pression upstream; cohérent avec memoryCache qui dégrade en cache-miss).
// ponytail: fenêtre fixe suffit; sliding window si les bursts à la frontière de
// minute posent problème un jour.
async function takeUpstreamSlot() {
  const bucketKey = `swiftflow:rl:${Math.floor(Date.now() / 60000)}`;
  try {
    const count = await redis.incr(bucketKey);
    if (count === 1) await redis.expire(bucketKey, 120); // TTL > fenêtre, cleanup best-effort
    return count <= UPSTREAM_MAX_PER_MIN;
  } catch {
    return true; // Redis injoignable: ne bloque pas le trafic
  }
}

// GET upstream. 404 = négatif définitif (cachable). Tout autre échec = throw,
// jamais caché — le stale existant continue d'être servi.
async function fetchUpstream(route) {
  if (!(await takeUpstreamSlot())) throw new Error('budget upstream épuisé (>900 req/min)');
  const res = await axios.get(apiUrl(route), {
    timeout: UPSTREAM_TIMEOUT_MS,
    validateStatus: (s) => s === 200 || s === 404,
  });
  if (res.status === 404 || !res.data || res.data.success !== true) return null;
  return res.data.data;
}

// Enveloppe cachée sur disque: { kind, notFound, data, _ts }
const envelope = (kind, data) => ({ kind, notFound: !data, data: data || null, _ts: Date.now() });

const fetchMovie = (id) =>
  fetchUpstream(`movies/${id}`).then((d) =>
    envelope('movie', d && Array.isArray(d.sources) && d.sources.length ? d : null),
  );
// La série entière est cachée sous UNE clé: 1 appel upstream couvre toutes les
// saisons/épisodes, le découpage par saison se fait depuis le cache.
const fetchSeries = (id) =>
  fetchUpstream(`series/${id}`).then((d) =>
    envelope('tv', d && Array.isArray(d.seasons) && d.seasons.length ? d : null),
  );

// In-flight dédup: les requêtes concurrentes pour la même clé partagent le
// même appel upstream (refresh de fond comme fetch froid).
const inFlight = new Map();
function fetchAndCache(key, fetcher) {
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const fresh = await fetcher();
      await saveToCache(CACHE_DIR.SWIFTFLOW, key, fresh);
      return fresh;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  job.catch(() => {}); // refresh de fond raté: le prochain hit retentera
  return job;
}

// Retourne l'enveloppe cache à servir, ou null si froid (aucune entrée) — dans
// ce cas la route répond { pending:true } et le fetch tourne en fond.
async function withCache(key, fetcher) {
  const cached = await getFromCacheNoExpiration(CACHE_DIR.SWIFTFLOW, key);
  if (cached && cached._ts) {
    const ttl = cached.notFound
      ? NEGATIVE_TTL_MS
      : cached.kind === 'movie'
        ? MOVIE_TTL_MS
        : TV_TTL_MS;
    if (Date.now() - cached._ts >= ttl) fetchAndCache(key, fetcher); // stale: refresh en fond
    return cached; // frais OU stale: servi tout de suite
  }
  // Froid: fetch en fond (dédupliqué) et on répond "en cours" sans bloquer. Comme
  // j1f — évite qu'un SwiftFlow froid/lent (timeout 10s) ne gate le Promise.all
  // de chargement des sources côté front. Le client récupère les données au hit
  // suivant (cache chaud).
  fetchAndCache(key, fetcher);
  return null;
}

const isVostfr = (lang) => /vostfr/i.test(lang || '');
const buildLabel = (item) =>
  [item && item.quality, item && item.size].filter((v) => v && v !== 'Unknown').join(' · ');

// ---------------------------------------------------------------------------
//  SwiftFlux — le versant MP4 direct de la même réponse
// ---------------------------------------------------------------------------
// L'appel amont rend déjà l'URL du fichier progressif à côté de quoi construire
// l'iframe : les deux modes sortent donc de la même requête et du même cache.
// Ce qu'on n'expose pas ici, c'est l'URL elle-même — cette réponse part au
// chargement de chaque fiche, elle serait un robinet à liens directs sur le
// catalogue du partenaire. Le client reçoit de quoi étiqueter l'entrée dans son
// menu ; l'adresse s'obtient ensuite par `POST /mp4/resolve`, contre un jeton
// Turnstile.

/** Métadonnées publiables d'une entrée MP4 : tout sauf son URL. */
const mp4Meta = (item, index) => ({
  index,
  label: buildLabel(item) || 'MP4',
  quality: item && item.quality && item.quality !== 'Unknown' ? item.quality : null,
  size: (item && item.size) || null,
  language: (item && item.language) || 'VF',
});

/** Entrées MP4 d'un film, dans l'ordre rendu par l'API. */
function movieMp4Items(env) {
  if (!env || env.notFound || !env.data) return [];
  return (env.data.sources || []).filter((s) => s && s.url);
}

/** Entrées MP4 d'un épisode précis. Une seule en pratique, mais rien ne l'impose. */
function episodeMp4Items(env, seasonNum, episodeNum) {
  if (!env || env.notFound || !env.data || !episodeNum) return [];
  const season = (env.data.seasons || []).find(
    (s) => parseInt(String(s.season).replace(/\D/g, ''), 10) === Number(seasonNum),
  );
  if (!season) return [];
  return (season.episodes || []).filter(
    (ep) => ep && ep.url && Number(ep.episode_number) === Number(episodeNum),
  );
}

/** Bloc `mp4` joint aux réponses catalogue. Jamais d'URL, voir plus haut. */
const mp4Block = (items) => ({
  available: items.length > 0,
  entries: items.map(mp4Meta),
});

function buildMovieResponse(id, env) {
  if (!env || env.notFound || !env.data) {
    return { success: false, error: 'Film non disponible sur SwiftFlow', tmdb_id: id };
  }
  const sources = env.data.sources || [];
  // Un seul player par film; VOSTFR seulement si aucune source VF.
  const vostfrOnly = sources.length > 0 && sources.every((s) => isVostfr(s.language));
  const player = {
    name: 'SwiftFlow',
    url: moviePlayerUrl(id),
    type: 'iframe',
    label: buildLabel(sources[0]),
  };
  return {
    success: true,
    tmdb_id: Number(id),
    title: env.data.title,
    year: env.data.year,
    source: 'swiftflow',
    players: { vf: vostfrOnly ? [] : [player], vostfr: vostfrOnly ? [player] : [] },
    mp4: mp4Block(movieMp4Items(env)),
    cache_timestamp: new Date(env._ts).toISOString(),
  };
}

// Shape alignée sur wiflix/j1f TV: `episodes` keyed par numéro d'épisode,
// chacun { vf:[{name,url,type,label}], vostfr:[...] }.
function buildSeasonResponse(id, env, seasonNum, episodeNum) {
  if (!env || env.notFound || !env.data) {
    return { success: false, error: 'Série non disponible sur SwiftFlow', tmdb_id: id };
  }
  const season = (env.data.seasons || []).find(
    (s) => parseInt(String(s.season).replace(/\D/g, ''), 10) === Number(seasonNum),
  );
  if (!season) {
    return { success: false, error: `Saison ${seasonNum} non disponible`, tmdb_id: id };
  }

  const episodes = {};
  for (const ep of season.episodes || []) {
    if (!ep || ep.episode_number == null) continue;
    if (episodeNum && Number(ep.episode_number) !== Number(episodeNum)) continue;
    const entry = {
      name: 'SwiftFlow',
      url: episodePlayerUrl(id, Number(seasonNum), ep.episode_number),
      type: 'iframe',
      label: buildLabel(ep),
    };
    episodes[String(ep.episode_number)] = isVostfr(ep.language)
      ? { vf: [], vostfr: [entry] }
      : { vf: [entry], vostfr: [] };
  }
  if (Object.keys(episodes).length === 0) {
    return { success: false, error: 'Aucun épisode disponible', tmdb_id: id };
  }
  return {
    success: true,
    tmdb_id: Number(id),
    title: env.data.series_name || env.data.title,
    source: 'swiftflow',
    season: Number(seasonNum),
    episodes,
    // Portée à l'épisode demandé : sans `?episode=`, la réponse couvre toute
    // la saison et il n'y a pas de fichier unique à annoncer.
    mp4: mp4Block(episodeMp4Items(env, seasonNum, episodeNum)),
    cache_timestamp: new Date(env._ts).toISOString(),
  };
}

// === Routes ===
router.get('/movie/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, error: 'TMDB id invalide' });
  }
  if (!CONFIGURED) return res.json({ success: false, error: 'SwiftFlow non configuré', tmdb_id: id });
  try {
    const env = await withCache(`movie-${id}`, () => fetchMovie(id));
    if (!env) return res.json({ success: false, pending: true, tmdb_id: Number(id) });
    await respondWithResolvedSources(req, res, buildMovieResponse(id, env), {
      movieMapKey: 'players',
      label: 'SWIFTFLOW MOVIE',
    });
  } catch (err) {
    console.error(`[SwiftFlow MOVIE] ${id}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur SwiftFlow', tmdb_id: id });
  }
});

router.get('/tv/:id/season/:season', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(season)) {
    return res.status(400).json({ success: false, error: 'Paramètres invalides' });
  }
  if (!CONFIGURED) return res.json({ success: false, error: 'SwiftFlow non configuré', tmdb_id: id });
  try {
    const env = await withCache(`tv-${id}`, () => fetchSeries(id));
    if (!env) return res.json({ success: false, pending: true, tmdb_id: Number(id) });
    // SwiftFlow range la map de langues à même l'épisode, sans enveloppe.
    await respondWithResolvedSources(req, res, buildSeasonResponse(id, env, season, episode), {
      languageKey: null,
      label: 'SWIFTFLOW TV',
    });
  } catch (err) {
    console.error(`[SwiftFlow TV] ${id} S${season}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur SwiftFlow', tmdb_id: id });
  }
});

// =====================================================================
//  SwiftFlux — mode MP4 direct
// =====================================================================
// La disponibilité voyage dans le bloc `mp4` des réponses catalogue ci-dessus :
// l'appel amont rend l'URL du fichier en même temps que de quoi construire
// l'iframe, une seule requête suffit donc pour les deux modes. Ne reste ici que
// la seconde moitié de la porte d'entrée : rendre l'URL, contre un jeton
// Turnstile, une fois que l'utilisateur a vu la pub côté client.
//
// L'URL est servie telle quelle, sans relais : le CDN du partenaire autorise
// les domaines Movix par `Referer` et le navigateur envoie le bon de lui-même.
// La faire transiter par un proxy la casserait (mauvais Referer) autant que ça
// coûterait — ces fichiers pèsent plusieurs gigaoctets.

const { verifyTurnstile } = require('../utils/turnstile');
const { verifyAccessKey } = require('../checkVip');

// Domaine de sortie du CDN, quand il ne doit pas être celui que l'API annonce.
// Le partenaire fait tourner ses domaines de distribution comme n'importe quel
// agrégateur, et tous ne sont pas également joignables ni également autorisés
// pour nos domaines : cette variable permet de basculer sans redéployer, en
// n'attendant pas que l'amont mette sa réponse à jour.
//
// Accepte une origine (`https://cdn.exemple.tld`) ou une origine + préfixe de
// chemin (`https://cdn.exemple.tld/mirror`), auquel cas le préfixe est ajouté
// devant le chemin du fichier. Absente, l'URL de l'API est rendue telle quelle.
const CDN_OVERRIDE = (process.env.SWIFTFLOW_CDN_BASE_URL || '').trim();

/**
 * Réécrit l'origine d'une URL de fichier vers `SWIFTFLOW_CDN_BASE_URL`.
 *
 * Une valeur illisible ou une URL amont invalide laisse l'URL intacte : un
 * mauvais réglage doit dégrader vers le comportement d'origine, pas casser la
 * lecture pour tout le monde.
 */
function applyCdnOverride(fileUrl) {
  if (!CDN_OVERRIDE || !fileUrl) return fileUrl;
  try {
    const base = new URL(CDN_OVERRIDE);
    const target = new URL(fileUrl);
    target.protocol = base.protocol;
    target.host = base.host;
    const prefix = base.pathname.replace(/\/+$/, '');
    if (prefix) target.pathname = `${prefix}${target.pathname}`;
    return target.toString();
  } catch (err) {
    console.warn(`[SwiftFlux] SWIFTFLOW_CDN_BASE_URL ignoré (${err.message})`);
    return fileUrl;
  }
}

/**
 * Rend l'URL de lecture contre un jeton Turnstile.
 *
 * Le statut VIP n'entre pas ici : il dispense de la pub, côté client, pas de
 * la vérification. Les admins non plus : on passe par `verifyTurnstile`, sans
 * la dispense de `verifyTurnstileFromRequest`, pour que l'équipe voie
 * exactement le parcours qu'elle fait vivre aux autres.
 */
router.post('/mp4/resolve', async (req, res) => {
  const { kind, tmdbId, season, episode, index, turnstileToken } = req.body || {};

  if (kind !== 'movie' && kind !== 'tv') {
    return res.status(400).json({ success: false, error: 'Type invalide' });
  }
  if (!/^\d+$/.test(String(tmdbId || ''))) {
    return res.status(400).json({ success: false, error: 'TMDB id invalide' });
  }
  if (kind === 'tv' && (!/^\d+$/.test(String(season || '')) || !/^\d+$/.test(String(episode || '')))) {
    return res.status(400).json({ success: false, error: 'Saison/épisode invalides' });
  }
  if (!CONFIGURED) {
    return res.status(503).json({ success: false, error: 'SwiftFlux non configuré' });
  }

  if (process.env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return res.status(400).json({ success: false, error: 'Vérification de sécurité requise' });
    }
    const ip = req.headers['cf-connecting-ip']
      || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.ip;
    if (!(await verifyTurnstile(turnstileToken, ip))) {
      return res.status(403).json({ success: false, error: 'Vérification de sécurité échouée. Réessayez.' });
    }
  }

  try {
    const env = kind === 'movie'
      ? await withCache(`movie-${tmdbId}`, () => fetchMovie(tmdbId))
      : await withCache(`tv-${tmdbId}`, () => fetchSeries(tmdbId));
    if (!env) {
      return res.status(503).json({ success: false, error: 'Catalogue en cours de chargement, réessayez' });
    }

    const items = kind === 'movie'
      ? movieMp4Items(env)
      : episodeMp4Items(env, season, episode);
    const wanted = Number.isInteger(index) && index >= 0 && index < items.length ? index : 0;
    const item = items[wanted];
    if (!item) {
      return res.status(404).json({ success: false, error: 'Aucun fichier disponible' });
    }

    const vipStatus = await verifyAccessKey(req.headers['x-access-key'] || null);
    res.json({
      success: true,
      url: applyCdnOverride(item.url),
      ...mp4Meta(item, wanted),
      is_vip: Boolean(vipStatus && vipStatus.vip),
    });
  } catch (err) {
    console.error(`[SwiftFlux MP4 RESOLVE] ${kind}/${tmdbId}: ${err.message}`);
    res.status(502).json({ success: false, error: 'Erreur SwiftFlux' });
  }
});

module.exports = router;
