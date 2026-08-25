// src/utils/segmentConsensus.ts
//
// Recalcul du consensus cote client, en fonction des fournisseurs que
// l'utilisateur a autorises et de son ordre de priorite.
//
// Pourquoi ici et pas uniquement cote serveur : le backend met en cache un
// payload UNIQUE par (contenu, duree), calcule sur tous les fournisseurs et
// accompagne du detail de chaque proposition. Refaire le calcul cote serveur
// avec les reglages de chaque utilisateur fragmenterait le cache Redis par
// combinaison de reglages — pour un calcul qui tient en quelques dizaines de
// lignes et s'execute en microsecondes ici.

import type {
  CommunitySubmission,
  MediaSegment,
  SegmentCandidate,
} from '../services/mediaSegmentsService';
import type { ProviderId, SkipSegmentSettings } from './skipSegmentPrefs';

/** Memes tolerances que `services/mediaSegments/constants.js` cote backend. */
const CLUSTER_START_TOLERANCE_SEC = 3;
const CLUSTER_END_TOLERANCE_SEC = 6;
const OVERLAP_MERGE_RATIO = 0.6;

/**
 * Identifiant de la source communautaire Movix.
 *
 * Il ne figure volontairement pas dans `ProviderId` : ce n'est pas une source
 * externe que l'utilisateur active ou reordonne, c'est notre propre base. Le
 * transtypage est confine ici.
 */
const COMMUNITY_SOURCE = 'movix' as ProviderId;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function agrees(a: SegmentCandidate, b: SegmentCandidate): boolean {
  return (
    Math.abs(a.start - b.start) <= CLUSTER_START_TOLERANCE_SEC &&
    Math.abs(a.end - b.end) <= CLUSTER_END_TOLERANCE_SEC
  );
}

/** Intervalle nu, en secondes. Sert au rognage et aux gardes du studio. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Ce qui reste de `[start, end]` une fois retirees les plages `taken`.
 *
 * `taken` est suppose sans chevauchement interne : c'est le cas de la liste
 * deja retenue par `resolveOverlaps`, qui est justement l'invariant qu'elle
 * maintient.
 */
function subtractRanges(start: number, end: number, taken: TimeRange[]): TimeRange[] {
  const blocking = taken
    .filter((range) => range.end > start && range.start < end)
    .sort((a, b) => a.start - b.start);

  const free: TimeRange[] = [];
  let cursor = start;
  for (const range of blocking) {
    if (range.start > cursor) free.push({ start: cursor, end: Math.min(range.start, end) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free.filter((range) => range.end > range.start);
}

/** Recouvrement entre deux plages, en secondes. 0 si elles sont disjointes. */
export function overlapSeconds(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * En dessous, le reste d'une sequence rognee ne merite plus ni bouton ni
 * marqueur : sauter trois secondes ne vaut pas un clic.
 */
const MIN_KEPT_SEGMENT_SEC = 3;

/**
 * Rend la liste strictement non chevauchante.
 *
 * Deux raisons a cette garantie, et elles se rejoignent :
 *
 *  1. `outro` et `credits` designent la meme sequence chez plusieurs
 *     fournisseurs. Deux segments qui se recouvrent largement produiraient deux
 *     boutons consecutifs pour sauter la meme chose : on ne garde que le plus
 *     sur (regle du doublon, seuil `OVERLAP_MERGE_RATIO`).
 *
 *  2. Un recouvrement partiel — une intro qui deborde sur un resume, un
 *     generique propose par la communaute qui mord sur l'outro du consensus —
 *     rendait DEUX sequences actives au meme instant. Le lecteur n'en prend
 *     qu'une (`segments.find`), mais les marqueurs, le prefetch et la carte de
 *     vote, eux, voyaient les deux. On rogne donc la moins sure sur ce qui
 *     reste libre, et on la jette si le reste est trop court pour valoir un
 *     saut.
 *
 * Consequence tenue par construction : a tout instant de la lecture, au plus un
 * segment couvre la position courante.
 */
function resolveOverlaps(segments: MediaSegment[]): MediaSegment[] {
  // Ordre de priorite : confiance, puis nombre de sources d'accord, puis
  // position — deterministe, pour que deux rendus successifs ne permutent pas
  // deux segments a egalite.
  const ranked = [...segments].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return a.start - b.start;
  });

  const kept: MediaSegment[] = [];

  for (const segment of ranked) {
    const length = segment.end - segment.start;
    if (!(length > 0)) continue;

    // `kept` est sans chevauchement interne : la somme ne compte donc jamais
    // deux fois la meme seconde.
    const overlapping = kept.filter((other) => overlapSeconds(segment, other) > 0);
    if (overlapping.length === 0) {
      kept.push(segment);
      continue;
    }

    const covered = overlapping.reduce((total, other) => total + overlapSeconds(segment, other), 0);
    const shortest = Math.min(length, ...overlapping.map((other) => other.end - other.start));
    // Doublon : la meme sequence, sous deux noms. Celle deja retenue est la
    // plus sure, on s'arrete la.
    if (shortest > 0 && covered / shortest >= OVERLAP_MERGE_RATIO) continue;

    // Recouvrement partiel : on garde le plus grand morceau encore libre.
    const free = subtractRanges(segment.start, segment.end, kept);
    const widest = free.reduce<TimeRange | null>(
      (best, range) => (best === null || range.end - range.start > best.end - best.start ? range : best),
      null,
    );
    if (!widest || widest.end - widest.start < MIN_KEPT_SEGMENT_SEC) continue;

    kept.push({ ...segment, start: widest.start, end: widest.end });
  }

  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Applique les reglages de l'utilisateur aux segments renvoyes par le backend.
 *
 * @param segments segments consensuels du backend, avec leurs `candidates`
 * @param settings reglages courants (fournisseurs, seuils, decalage de fin)
 * @param duration duree reelle du flux, pour borner le resultat
 */
export function applyProviderPreferences(
  segments: MediaSegment[],
  settings: SkipSegmentSettings,
  duration: number,
): MediaSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const allowed = new Set<ProviderId>(settings.enabledProviders);
  const priority = new Map<ProviderId, number>(
    settings.providerOrder.map((id, index) => [id, index]),
  );
  // La communauté Movix passe devant tout le monde, comme côté serveur
  // (`PROVIDER_RANK.movix`) : ses relevés sont faits à la milliseconde depuis
  // le lecteur, sur les durées exactes que Movix sert. Absente de
  // `providerOrder`, elle tomberait sinon en dernier.
  const rankOf = (candidate: SegmentCandidate) =>
    candidate.source === COMMUNITY_SOURCE ? -1 : (priority.get(candidate.source) ?? Number.MAX_SAFE_INTEGER);

  const rebuilt: MediaSegment[] = [];

  for (const segment of segments) {
    // `movix` n'est pas dans la liste des fournisseurs reglables : c'est notre
    // propre base, et ses releves sont deja filtres par le vote d'adoption.
    // Le soumettre aux cases a cocher des sources externes revenait a le jeter
    // systematiquement, puisque aucune preference enregistree ne le contient.
    const pool = (segment.candidates ?? []).filter(
      (candidate) => candidate.source === COMMUNITY_SOURCE || allowed.has(candidate.source),
    );
    if (pool.length === 0) continue;

    // Chef de file : le fournisseur le plus haut dans l'ordre de l'utilisateur,
    // puis la meilleure confiance a egalite.
    const leader = pool.reduce((best, candidate) => {
      const delta = rankOf(candidate) - rankOf(best);
      if (delta !== 0) return delta < 0 ? candidate : best;
      return candidate.confidence > best.confidence ? candidate : best;
    });

    // Groupe d'accord : compare a CHACUN au chef de file, pas de proche en
    // proche — une chaine A~B~C dont les extremes divergent de 6 s ne doit pas
    // fusionner en une mediane qui ne correspond a rien.
    const group = pool.filter((candidate) => agrees(leader, candidate));
    const sources = [...new Set(group.map((candidate) => candidate.source))];

    if (sources.length < settings.minSources) continue;

    const bestConfidence = Math.max(...group.map((candidate) => candidate.confidence));
    const confidence = Math.min(1, bestConfidence + 0.15 * (sources.length - 1));
    if (confidence < settings.minConfidence) continue;

    const start = median(group.map((candidate) => candidate.start));
    const rawEnd = median(group.map((candidate) => candidate.end));

    // Decalage de fin : borne pour ne jamais inverser le segment ni deborder.
    const maxEnd = Number.isFinite(duration) && duration > 0 ? duration : rawEnd;
    const end = Math.min(maxEnd, Math.max(start + 1, rawEnd + settings.endOffset));

    rebuilt.push({
      ...segment,
      start,
      end,
      confidence,
      agreement: pool.length > 0 ? sources.length / new Set(pool.map((c) => c.source)).size : 0,
      sourceCount: sources.length,
      sources,
      source: leader.source,
      match: leader.match ?? null,
    });
  }

  return resolveOverlaps(rebuilt);
}

/**
 * Promeut les propositions en attente au rang de vraies séquences.
 *
 * N'est appelé que si `trustPendingProposals` est activé. Ni `minSources` ni
 * `minConfidence` ne s'appliquent : ces deux seuils mesurent l'accord entre
 * sources, et une proposition n'en a qu'une par construction — les soumettre
 * reviendrait à réintroduire le seuil que ce réglage sert justement à lever.
 *
 * Le consensus garde la priorité en cas de recouvrement : les propositions
 * entrent avec une confiance plafonnée sous celle d'une vraie séquence, et
 * `resolveOverlaps` trie par confiance décroissante.
 */
export function mergeTrustedProposals(
  segments: MediaSegment[],
  submissions: CommunitySubmission[],
  settings: SkipSegmentSettings,
  duration: number,
): MediaSegment[] {
  const pending = (submissions ?? []).filter((submission) => !submission.adopted);
  if (pending.length === 0) return segments;

  const maxEnd = Number.isFinite(duration) && duration > 0 ? duration : Infinity;

  const promoted: MediaSegment[] = pending.map((submission) => {
    const start = submission.startMs / 1000;
    const rawEnd = submission.endMs / 1000;
    const end = Math.min(maxEnd, Math.max(start + 1, rawEnd + settings.endOffset));
    // Plafonnée sous `minConfidence` par défaut (0,4) : en cas de recouvrement
    // avec une vraie séquence, c'est elle qui gagne. Les voix déjà reçues ne
    // servent qu'à départager deux propositions entre elles.
    const confidence = Math.min(0.3, 0.15 + 0.03 * Math.max(0, submission.score));

    return {
      type: submission.type,
      start,
      end,
      confidence,
      agreement: 1,
      sourceCount: 1,
      sources: [COMMUNITY_SOURCE],
      source: COMMUNITY_SOURCE,
      match: 'exact',
      candidates: [{
        source: COMMUNITY_SOURCE,
        start,
        end,
        confidence,
        match: 'exact',
      }],
    };
  });

  return resolveOverlaps([...segments, ...promoted]);
}
