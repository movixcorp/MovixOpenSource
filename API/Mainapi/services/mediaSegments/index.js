/**
 * Orchestration : interroge les fournisseurs, confronte leurs reponses, met en
 * cache ce qui peut l'etre.
 *
 * Deux regimes coexistent :
 *
 *   - les sources externes (AniSkip, SkipDB, IntroDB, TheIntroDB) sont lentes,
 *     communes a tous les utilisateurs et quasi immuables : leurs propositions
 *     BRUTES sont mises en cache Redis par (contenu, duree).
 *   - la source Movix lit notre propre base et change a chaque vote : elle est
 *     interrogee a chaque requete, puis fusionnee avec le cache.
 *
 * C'est pour cela que le cache contient des candidats bruts et non le consensus
 * final : le consensus doit etre recalcule des qu'une proposition communautaire
 * est adoptee ou retiree, sans invalider quinze jours de travail des sources
 * externes.
 *
 * Le payload renvoye reste independant des reglages de l'utilisateur (consensus
 * global + detail de chaque proposition) : c'est `utils/segmentConsensus.ts`
 * cote client qui le retaille selon les sources choisies, ce qui evite de
 * fragmenter le cache par combinaison de reglages.
 */

const { memoryCache } = require('../../config/redis');
const { buildConsensus } = require('./consensus');
const { DURATION_TOLERANCE_SEC } = require('./constants');
const { PROVIDERS } = require('./providers');
const { resolveImdbId, resolveMalId } = require('./identifiers');

const CACHE_VERSION = 'v4';
const TTL_FOUND = 14 * 24 * 3600;   // 14 j — horodatages confirmes
const TTL_EMPTY = 6 * 3600;         // 6 h — laisse une chance a une contribution recente

/** Budget global : au-dela, on sert ce qui est arrive et on oublie le reste. */
const TOTAL_BUDGET_MS = 7000;

/**
 * Nombre d'encodages distincts pour lesquels on accepte d'interroger les
 * sources externes, par contenu.
 *
 * La duree vient du client et entre dans la cle de cache : sans plafond,
 * incrementer `duration` de seconde en seconde suffit a provoquer un defaut de
 * cache a chaque appel, donc jusqu'a quatre requetes sortantes vers des
 * services communautaires gratuits — et l'IP de Movix bannie de ses propres
 * sources. Huit encodages couvrent largement les differences entre hebergeurs.
 */
const MAX_KNOWN_DURATIONS = 8;
const KNOWN_DURATIONS_TTL = 30 * 24 * 3600;

/**
 * Ramene une duree demandee a un encodage deja connu, ou l'enregistre.
 *
 * Renvoie `{ duration, throttled }` : `throttled` signifie que le budget du
 * contenu est epuise et qu'aucune source externe ne doit etre interrogee. On
 * prefere ne rien proposer plutot que de servir des horodatages releves sur un
 * encodage trop different — c'est exactement ce que la tolerance de duree est
 * censee empecher.
 */
async function reconcileDuration({ mediaType, tmdbId, season, episode, duration }) {
  if (duration === null || duration === undefined) return { duration: null, throttled: false };

  const key = [
    'segments', CACHE_VERSION, 'durations', mediaType, tmdbId, season ?? '-', episode ?? '-',
  ].join(':');

  const known = (await memoryCache.get(key)) ?? [];
  if (!Array.isArray(known)) return { duration, throttled: false };

  const near = known.find((value) => Math.abs(value - duration) <= DURATION_TOLERANCE_SEC);
  // Deja vu a la tolerance pres : on retombe sur la meme entree de cache, ce
  // qui evite l'appel sortant ET ameliore le taux de reussite du cache pour
  // les lecteurs qui rapportent une duree legerement differente.
  if (near !== undefined) return { duration: near, throttled: false };

  if (known.length >= MAX_KNOWN_DURATIONS) return { duration, throttled: true };

  await memoryCache.set(key, [...known, duration], KNOWN_DURATIONS_TTL);
  return { duration, throttled: false };
}

/**
 * Course entre une promesse et un delai. Le fournisseur en retard n'est pas
 * annule (axios a deja son propre timeout) : on cesse simplement de l'attendre,
 * pour qu'un service lent ne retienne pas la reponse des autres.
 */
function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Un fournisseur peut-il repondre pour ce contenu ? */
function isEligible(provider, context) {
  if (!provider.isConfigured()) return 'unconfigured';
  if (context.mediaType === 'movie' && !provider.supportsMovies) return 'unsupported';
  if (provider.requires === 'imdbId' && !context.imdbId) return 'no-id';
  if (provider.requires === 'malId' && !context.malId) return 'no-id';
  return null;
}

/** Interroge une liste de fournisseurs et agrege statuts et details. */
async function runProviders(providers, context) {
  const providerStatus = {};
  const providerDetail = {};
  const started = [];

  for (const provider of providers) {
    const skipReason = isEligible(provider, context);
    if (skipReason) {
      providerStatus[provider.id] = skipReason;
      continue;
    }
    started.push(
      withDeadline(
        provider
          .fetch(context)
          .then((candidates) => {
            providerStatus[provider.id] = candidates.length > 0 ? 'ok' : 'empty';
            return candidates;
          })
          .catch((error) => {
            providerStatus[provider.id] = error?.providerStatus || 'error';
            providerDetail[provider.id] = error?.providerDetail || error?.message || String(error);
            console.warn(`[segments] ${provider.id}: ${providerDetail[provider.id]}`);
            return [];
          }),
        TOTAL_BUDGET_MS,
        [],
      ).then((candidates) => {
        if (!providerStatus[provider.id]) providerStatus[provider.id] = 'timeout';
        return candidates;
      }),
    );
  }

  const candidates = (await Promise.all(started)).flat();
  return { candidates, providerStatus, providerDetail };
}

async function resolveSegments({ mediaType, tmdbId, season, episode, duration }) {
  // Les deux traductions d'identifiants en parallele : elles sont
  // independantes et presque toujours servies par le cache.
  const [imdbId, malId] = await Promise.all([
    resolveImdbId(mediaType, tmdbId).catch(() => null),
    mediaType === 'tv' ? resolveMalId(tmdbId, season).catch(() => null) : Promise.resolve(null),
  ]);

  const reconciled = await reconcileDuration({ mediaType, tmdbId, season, episode, duration })
    .catch(() => ({ duration, throttled: false }));
  const effectiveDuration = reconciled.duration;

  const context = {
    mediaType, tmdbId, season, episode, duration: effectiveDuration, imdbId, malId,
  };

  const cacheKey = [
    'segments', CACHE_VERSION, mediaType, tmdbId,
    season ?? '-', episode ?? '-', effectiveDuration ?? '-',
  ].join(':');

  let externalResult = reconciled.throttled ? undefined : await memoryCache.get(cacheKey);
  let cacheState = reconciled.throttled ? 'THROTTLED' : 'HIT';

  if (reconciled.throttled) {
    // Budget d'encodages epuise pour ce contenu : les sources externes ne sont
    // pas interrogees et rien n'est mis en cache. La source Movix, elle, reste
    // servie : elle lit notre propre base et ne coute rien a personne.
    externalResult = {
      candidates: [],
      providerStatus: Object.fromEntries(
        PROVIDERS.filter((provider) => provider.cacheable !== false).map((p) => [p.id, 'throttled']),
      ),
      providerDetail: {},
    };
  } else if (externalResult === undefined) {
    cacheState = 'MISS';
    externalResult = await runProviders(
      PROVIDERS.filter((provider) => provider.cacheable !== false),
      context,
    );
    await memoryCache.set(
      cacheKey,
      externalResult,
      externalResult.candidates.length > 0 ? TTL_FOUND : TTL_EMPTY,
    );
  }

  // Sources vivantes (la communaute Movix) : jamais mises en cache, sans quoi
  // une proposition tout juste adoptee resterait invisible quinze jours.
  const liveResult = await runProviders(
    PROVIDERS.filter((provider) => provider.cacheable === false),
    context,
  );

  const segments = buildConsensus([...externalResult.candidates, ...liveResult.candidates]);

  return {
    found: segments.length > 0,
    segments,
    providerStatus: { ...externalResult.providerStatus, ...liveResult.providerStatus },
    providerDetail: { ...externalResult.providerDetail, ...liveResult.providerDetail },
    imdbId,
    malId,
    duration: effectiveDuration,
    cache: cacheState,
  };
}

/** Inventaire des fournisseurs, pour l'interface de reglages. */
function listProviders() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    supportsMovies: provider.supportsMovies,
    configured: provider.isConfigured(),
    /** `true` pour la source interne, dont les releves viennent du lecteur. */
    community: provider.cacheable === false,
  }));
}

module.exports = { resolveSegments, listProviders };
