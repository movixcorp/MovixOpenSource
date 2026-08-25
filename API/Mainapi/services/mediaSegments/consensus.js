/**
 * Confrontation des propositions des differents fournisseurs.
 *
 * L'idee : un horodatage confirme par deux bases independantes vaut bien mieux
 * qu'un horodatage tres « confiant » vu une seule fois. Pour chaque type de
 * segment on regroupe les propositions qui disent a peu pres la meme chose, on
 * garde le groupe le plus large, et on renvoie sa mediane. Le client recoit
 * aussi le detail des propositions pour pouvoir refaire ce calcul avec sa
 * propre selection de fournisseurs, sans qu'on ait a fragmenter le cache par
 * utilisateur.
 */

const {
  CLUSTER_START_TOLERANCE_SEC,
  CLUSTER_END_TOLERANCE_SEC,
  OVERLAP_MERGE_RATIO,
  PROVIDER_RANK,
  SEGMENT_TYPES,
} = require('./constants');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function rankOf(candidate) {
  const base = PROVIDER_RANK[candidate.source] ?? 0;
  // Une proposition SkipDB confirmee a la seconde pres sur cette duree precise
  // vaut mieux qu'une proposition SkipDB simplement recalee.
  if (candidate.match === 'exact') return base + 0.5;
  if (candidate.match === 'shifted') return base + 0.25;
  return base;
}

function agrees(a, b) {
  return (
    Math.abs(a.start - b.start) <= CLUSTER_START_TOLERANCE_SEC &&
    Math.abs(a.end - b.end) <= CLUSTER_END_TOLERANCE_SEC
  );
}

/**
 * Regroupe les propositions d'un meme type en grappes d'accord.
 *
 * Regroupement glouton et non transitif volontairement : on part de la
 * proposition la mieux classee et on lui agrege celles qui s'accordent AVEC
 * ELLE, pas de proche en proche. Une chaine A~B~C ou A et C sont a 6 s d'ecart
 * ne doit pas produire une grappe unique dont la mediane ne correspond a rien.
 */
function clusterCandidates(candidates) {
  const remaining = [...candidates].sort((a, b) => rankOf(b) - rankOf(a) || b.confidence - a.confidence);
  const clusters = [];

  while (remaining.length > 0) {
    const seed = remaining.shift();
    const cluster = [seed];
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (agrees(seed, remaining[index])) {
        cluster.unshift(remaining.splice(index, 1)[0]);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Reduit une grappe a un segment unique.
 *
 * Les bornes sont les medianes de la grappe : une valeur aberrante isolee ne
 * peut pas tirer le segment a elle, contrairement a une moyenne.
 */
function summarizeCluster(cluster, totalCandidates) {
  const sources = [...new Set(cluster.map((candidate) => candidate.source))];
  const leader = cluster.reduce((best, candidate) =>
    rankOf(candidate) > rankOf(best) ? candidate : best,
  );

  const start = median(cluster.map((candidate) => candidate.start));
  const end = median(cluster.map((candidate) => candidate.end));

  // Accord = part des propositions de ce type qui atterrissent dans la grappe.
  const agreement = totalCandidates > 0 ? sources.length / totalCandidates : 0;
  const bestConfidence = Math.max(...cluster.map((candidate) => candidate.confidence));

  return {
    type: leader.type,
    start,
    end,
    // Deux sources qui se confirment valent mieux qu'une seule tres sure : la
    // confiance monte avec l'accord, sans jamais depasser 1.
    confidence: Math.min(1, bestConfidence + 0.15 * (sources.length - 1)),
    agreement,
    sourceCount: sources.length,
    sources,
    source: leader.source,
    match: leader.match ?? null,
  };
}

/**
 * `outro` et `credits` designent la meme chose chez plusieurs fournisseurs.
 * Quand deux segments de types differents se recouvrent largement, on ne garde
 * que le mieux classe : sinon l'utilisateur verrait deux boutons consecutifs
 * pour sauter la meme sequence.
 */
function dropOverlappingDuplicates(segments) {
  const kept = [];
  for (const segment of [...segments].sort((a, b) => b.confidence - a.confidence)) {
    const duplicate = kept.some((other) => {
      const overlap = Math.min(segment.end, other.end) - Math.max(segment.start, other.start);
      if (overlap <= 0) return false;
      const shortest = Math.min(segment.end - segment.start, other.end - other.start);
      return shortest > 0 && overlap / shortest >= OVERLAP_MERGE_RATIO;
    });
    if (!duplicate) kept.push(segment);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * @param {Array} candidates propositions normalisees, tous fournisseurs confondus
 * @returns {Array} un segment par type, chacun portant le detail des propositions
 */
function buildConsensus(candidates) {
  const segments = [];

  for (const type of SEGMENT_TYPES) {
    const ofType = candidates.filter((candidate) => candidate.type === type);
    if (ofType.length === 0) continue;

    const distinctSources = new Set(ofType.map((candidate) => candidate.source)).size;
    const clusters = clusterCandidates(ofType);

    // Grappe gagnante : la plus large, puis la mieux classee a egalite.
    const winner = clusters.reduce((best, cluster) => {
      if (cluster.length !== best.length) return cluster.length > best.length ? cluster : best;
      return rankOf(cluster[0]) > rankOf(best[0]) ? cluster : best;
    });

    segments.push({
      ...summarizeCluster(winner, distinctSources),
      // Toutes les propositions du type, y compris celles ecartees : le client
      // en a besoin pour recalculer le consensus s'il desactive un fournisseur.
      candidates: ofType.map((candidate) => ({
        source: candidate.source,
        start: candidate.start,
        end: candidate.end,
        confidence: candidate.confidence,
        match: candidate.match ?? null,
      })),
    });
  }

  return dropOverlappingDuplicates(segments);
}

module.exports = { buildConsensus, clusterCandidates, agrees, rankOf };
