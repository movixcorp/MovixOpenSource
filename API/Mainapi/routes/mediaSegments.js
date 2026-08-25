/**
 * Media segments routes — intro / recap / outro / credits / preview.
 *
 * Mount point: app.use('/api', router)
 *   GET /api/segments/providers
 *   GET /api/segments/tv/:tmdbId?season=1&episode=3&duration=1440
 *   GET /api/segments/movie/:tmdbId?duration=7200
 *
 * Quatre fournisseurs communautaires interroges en parallele et confrontes :
 * AniSkip (animes, via MyAnimeList), SkipDB et IntroDB (via IMDb), TheIntroDB
 * (via TMDB). Voir `services/mediaSegments/` pour le detail.
 *
 * Pourquoi passer par le backend plutot que d'appeler ces APIs depuis le
 * navigateur : cache Redis partage entre tous les utilisateurs (ce sont des
 * services communautaires, on evite de les marteler), aucune dependance au CORS
 * d'un tiers, et un seul aller-retour client au lieu de six en cascade.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const { getAuthIfValid } = require('../middleware/auth');
const { listProviders, resolveSegments } = require('../services/mediaSegments');
const { getPool } = require('../mysqlPool');
const {
  ADOPTION_SCORE,
  STAFF_VOTE_WEIGHT,
  CommunityError,
  deleteSubmission,
  listSubmissions,
  submitSegment,
  voteSegment,
} = require('../services/mediaSegments/communityStore');

const router = express.Router();

const segmentsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:segments:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requetes de segments. Reessayez dans une minute.' },
  keyGenerator: (req) =>
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false },
});

/**
 * Ecrire coute plus cher que lire : une limite separee, plus stricte, protege
 * la base des envois en rafale sans genner la consultation.
 */
const communityWriteRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:segments-write:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de contributions en peu de temps. Reessayez dans une minute.' },
  keyGenerator: (req) =>
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false },
});

/** Entier canonique >= `min`, ou null si la valeur n'est pas exploitable. */
function parseIntParam(value, min) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  const pattern = min === 0 ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(str)) return null;
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < min) return null;
  return parsed;
}

/**
 * Duree en secondes, arrondie a l'entier.
 *
 * L'arrondi est ce qui rend le cache utile : deux lectures de la meme source
 * rapportent 1440.02 et 1440.11 s, qui doivent taper la meme entree. Les
 * encodages reellement differents (pub en tete, recap absent) restent separes.
 */
function parseDurationParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24 * 3600) return null;
  return Math.round(parsed);
}

async function handleSegments(req, res, mediaType) {
  const tmdbId = parseIntParam(req.params.tmdbId, 1);
  const duration = parseDurationParam(req.query.duration);
  const season = mediaType === 'tv' ? parseIntParam(req.query.season, 0) : null;
  const episode = mediaType === 'tv' ? parseIntParam(req.query.episode, 1) : null;

  if (tmdbId === null || (mediaType === 'tv' && (season === null || episode === null))) {
    return res.status(400).json({ found: false, segments: [], error: 'Parametres invalides' });
  }

  try {
    const viewer = await getContributor(req);
    const viewerIsStaff = await isStaffContributor(viewer);

    // Un echec de lecture des propositions ne doit pas emporter le consensus,
    // mais il ne doit pas non plus passer pour « aucune proposition » : le
    // lecteur afficherait une liste vide, indiscernable d'un episode que
    // personne n'a encore releve. Le motif remonte dans la reponse.
    let communityStatus = 'ok';

    // Le consensus et les propositions partent ensemble : le lecteur a besoin
    // des deux au meme instant, et un aller-retour de plus retarderait
    // l'affichage des propositions a voter.
    const [result, community] = await Promise.all([
      resolveSegments({ mediaType, tmdbId, season, episode, duration }),
      listSubmissions({
        mediaType, tmdbId, season, episode,
        durationMs: duration !== null ? duration * 1000 : null,
        viewer,
      }).catch((error) => {
        communityStatus = error?.code || 'error';
        console.warn(
          '[segments] propositions indisponibles:',
          error?.code || '',
          error?.message || error,
        );
        return [];
      }),
    ]);

    res.set('X-Movix-Segments-Cache', result.cache);
    const { cache, ...payload } = result;
    return res.json({
      ...payload,
      community,
      /** `ok`, ou le motif pour lequel la liste revient vide. */
      communityStatus,
      adoptionScore: ADOPTION_SCORE,
      canContribute: Boolean(viewer),
      /** Poids de la voix du lecteur : 3 pour l'equipe, 1 sinon. */
      voteWeight: viewerIsStaff ? STAFF_VOTE_WEIGHT : 1,
    });
  } catch (error) {
    console.error('[segments] Echec resolution:', error?.message || error);
    // Un echec global n'est pas mis en cache : le prochain appel doit reessayer.
    return res.status(200).json({
      found: false,
      segments: [],
      providerStatus: {},
      imdbId: null,
      malId: null,
      duration,
      community: [],
      communityStatus: 'error',
      adoptionScore: ADOPTION_SCORE,
      canContribute: false,
      voteWeight: 1,
      degraded: true,
    });
  }
}

/** Traduit une `CommunityError` en reponse HTTP, le reste en 500. */
function sendCommunityError(res, error, context) {
  if (error instanceof CommunityError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  console.error(`[segments] ${context}:`, error?.message || error);
  return res.status(500).json({ error: 'internal_error' });
}

/** Auteur ou votant courant, ou `null` si la session n'est pas exploitable. */
async function getContributor(req) {
  const auth = await getAuthIfValid(req).catch(() => null);
  if (!auth?.userId || !auth?.userType) return null;
  return { userType: auth.userType, userId: String(auth.userId) };
}

/**
 * Le contributeur fait-il partie de l'equipe ?
 *
 * Administrateurs ET uploaders comptent : ce sont les gens qui connaissent le
 * catalogue. `isAdminRequest` du middleware exclut les uploaders, d'ou cette
 * lecture directe. Attention au mapping de `auth_type` : la table stocke
 * `bip-39` la ou le JWT dit `bip39`.
 */
async function isStaffContributor(contributor) {
  if (!contributor) return false;
  try {
    const pool = getPool();
    if (!pool) return false;
    const [rows] = await pool.execute(
      'SELECT 1 FROM admins WHERE user_id = ? AND auth_type = ? LIMIT 1',
      [contributor.userId, contributor.userType === 'bip39' ? 'bip-39' : contributor.userType],
    );
    return rows.length > 0;
  } catch (error) {
    // Une panne de lecture ne doit pas bloquer le vote : on retombe sur une
    // voix ordinaire plutot que de refuser.
    console.warn('[segments] role staff indisponible:', error?.message || error);
    return false;
  }
}

// Inventaire des fournisseurs, pour l'ecran de reglages du lecteur.
router.get('/segments/providers', segmentsRateLimit, (_req, res) => {
  res.json({ providers: listProviders() });
});

// Toujours 200 quand la requete est valide : "aucun segment connu" est une
// reponse normale, pas une erreur, et le client ne doit pas la traiter comme un
// echec reseau (sinon `blockDetection` compte une network error de plus).
router.get('/segments/tv/:tmdbId', segmentsRateLimit, (req, res) => handleSegments(req, res, 'tv'));
router.get('/segments/movie/:tmdbId', segmentsRateLimit, (req, res) => handleSegments(req, res, 'movie'));

// === Contributions de la communaute =========================================

/**
 * Depose ou met a jour une proposition.
 *
 * Toutes les bornes sont en millisecondes : c'est la resolution du studio du
 * lecteur, et arrondir ici jetterait le travail de reperage.
 */
router.post('/segments/community', communityWriteRateLimit, async (req, res) => {
  try {
    const author = await getContributor(req);
    if (!author) return res.status(401).json({ error: 'unauthorized' });

    const body = req.body || {};
    const submission = await submitSegment({
      mediaType: body.mediaType,
      tmdbId: Number(body.tmdbId),
      season: body.season === undefined || body.season === null ? undefined : Number(body.season),
      episode: body.episode === undefined || body.episode === null ? undefined : Number(body.episode),
      segmentType: body.segmentType,
      startMs: Math.round(Number(body.startMs)),
      endMs: Math.round(Number(body.endMs)),
      durationMs: Math.round(Number(body.durationMs)),
      author,
      // `authorLabel` n'est volontairement pas repris du corps de requete :
      // il est affiche aux autres utilisateurs et permettrait de se faire
      // passer pour l'equipe. Voir `submitSegment`.
    });
    return res.status(201).json({ submission, adoptionScore: ADOPTION_SCORE });
  } catch (error) {
    return sendCommunityError(res, error, 'submitSegment');
  }
});

/**
 * Vote sur une proposition : 1, -1, ou 0 pour retirer son vote.
 *
 * Pas de captcha, comme demande : le garde-fou est le compte, l'unicite du vote
 * en base et l'interdiction de voter pour soi-meme.
 */
router.post('/segments/community/:id/vote', communityWriteRateLimit, async (req, res) => {
  try {
    const voter = await getContributor(req);
    if (!voter) return res.status(401).json({ error: 'unauthorized' });

    const submissionId = parseIntParam(req.params.id, 1);
    if (submissionId === null) return res.status(400).json({ error: 'invalid_id' });

    const weight = (await isStaffContributor(voter)) ? STAFF_VOTE_WEIGHT : 1;
    const result = await voteSegment({
      submissionId,
      value: Math.sign(Number(req.body?.value)) || 0,
      voter,
      weight,
    });
    return res.json({ ...result, adoptionScore: ADOPTION_SCORE, weight });
  } catch (error) {
    return sendCommunityError(res, error, 'voteSegment');
  }
});

/** Retrait de sa propre proposition. */
router.delete('/segments/community/:id', communityWriteRateLimit, async (req, res) => {
  try {
    const author = await getContributor(req);
    if (!author) return res.status(401).json({ error: 'unauthorized' });

    const submissionId = parseIntParam(req.params.id, 1);
    if (submissionId === null) return res.status(400).json({ error: 'invalid_id' });

    return res.json(await deleteSubmission({ submissionId, author }));
  } catch (error) {
    return sendCommunityError(res, error, 'deleteSubmission');
  }
});

module.exports = router;
