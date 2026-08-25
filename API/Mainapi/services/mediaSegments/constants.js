/**
 * Vocabulaire commun des segments Movix.
 *
 * Chaque fournisseur a son propre vocabulaire ; tout est ramene ici a cinq
 * types canoniques. `outro` et `credits` sont volontairement distincts : sur un
 * anime, l'`ed` est un generique de fin chante que beaucoup de gens veulent
 * garder, alors que les credits defilants qui suivent ne servent a rien. Les
 * fournisseurs qui ne font pas la difference (SkipDB, IntroDB) rangent leur
 * unique type de fin dans `outro`.
 */
const SEGMENT_TYPES = Object.freeze(['intro', 'recap', 'outro', 'credits', 'preview']);

/** Ordre de preference quand deux fournisseurs proposent le meme type. */
const PROVIDER_RANK = Object.freeze({
  // La communaute Movix passe devant tout le monde : ses releves sont faits a
  // la milliseconde depuis le lecteur, sur les durees exactes que Movix sert,
  // et il faut trois avis concordants pour qu'un releve soit adopte.
  movix: 5,
  // Communaute dediee aux animes, generiques releves a l'image pres.
  aniskip: 4,
  // Recale lui-meme sur la duree du flux et expose un score de consensus.
  skipdb: 3,
  theintrodb: 2,
  introdb: 1,
});

/** Tolerance de regroupement de deux propositions du meme type, en secondes. */
const CLUSTER_START_TOLERANCE_SEC = 3;
const CLUSTER_END_TOLERANCE_SEC = 6;

/** Ecart tolere entre la duree de reference d'un fournisseur et la duree reelle. */
const DURATION_TOLERANCE_SEC = 5;

/** Deux segments de types differents qui se recouvrent a ce point font doublon. */
const OVERLAP_MERGE_RATIO = 0.6;

const UPSTREAM_TIMEOUT_MS = 6000;
const USER_AGENT = 'Movix/1.0 (+https://movix.tax)';

module.exports = {
  SEGMENT_TYPES,
  PROVIDER_RANK,
  CLUSTER_START_TOLERANCE_SEC,
  CLUSTER_END_TOLERANCE_SEC,
  DURATION_TOLERANCE_SEC,
  OVERLAP_MERGE_RATIO,
  UPSTREAM_TIMEOUT_MS,
  USER_AGENT,
};
