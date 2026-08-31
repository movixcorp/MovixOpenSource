/**
 * Fusion « segments → épisode diffusé » pour les séries découpées par TMDB.
 *
 * ## Le problème
 *
 * La règle éditoriale de TMDB pour les cartoons jeunesse veut qu'un segment de
 * 11 minutes soit une entrée d'épisode à part entière. « Bienvenue chez les
 * Loud » (id 68073) affiche donc 52 épisodes en saison 1 là où la diffusion —
 * et nos fichiers vidéo — en comptent 26 : un épisode = 22 minutes = deux
 * segments. La demande de correction a déjà été refusée côté TMDB : c'est leur
 * règle, pas une erreur de saisie. Il faut donc recoller les segments chez
 * nous, à l'affichage.
 *
 * ## Pourquoi le code de production, et pas la simple adjacence
 *
 * L'approche évidente — « je colle chaque segment au suivant » — donne le bon
 * compte en saison 1 et se trompe partout ailleurs, parce que **TMDB range les
 * segments par date de première diffusion américaine**, pas par épisode. Sur la
 * saison 3, Nickelodeon a diffusé les segments un par un en semaine : les deux
 * moitiés de l'épisode 309 se retrouvent aux positions 15 et 33 de la liste
 * TMDB. Coller les voisins produirait « Le Petit Scientifique / Marché conclu »,
 * deux segments qui n'ont jamais formé un épisode, et décalerait toute la fin de
 * saison.
 *
 * Le signal fiable est le **code de production** (`production_code`) : `309A` et
 * `309B` sont les deux moitiés de l'épisode 309, où qu'elles soient dans la
 * liste. C'est vérifié segment par segment contre « List of The Loud House
 * episodes » sur Wikipédia, et ça rend le compte exact sur les dix saisons.
 *
 * Trois cas particuliers tombent naturellement du même mécanisme :
 * - un code sans suffixe de lettre (`301`, `505`) est un épisode pleine durée
 *   qui occupe une case à lui seul ;
 * - une entrée dont le code couvre deux cases (`501 502`) ou dont la durée vaut
 *   deux épisodes (`811`, 44 min) compte pour **deux** épisodes — elle est
 *   scindée en « (1/2) » et « (2/2) », ce qui correspond aux fichiers ;
 * - un code répété au-delà de deux moitiés (doublon TMDB en saison 10) ouvre une
 *   nouvelle case au lieu d'empiler quatre titres dans un seul épisode.
 *
 * Quand le code de production manque — TMDB en oublie onze en saison 2, deux en
 * saison 9 — on retombe sur la fusion par adjacence décrite plus haut, appliquée
 * aux seules entrées sans code, avec un avertissement. Les trous connus se
 * comblent par configuration (`productionCodeFixes`), sans toucher à la logique.
 *
 * ## Pourquoi ce module ne fait QUE ça
 *
 * Aucun import, aucun accès réseau, aucune notion d'Axios : c'est une
 * transformation de tableau, vérifiable par `tests/mergeSegmentedSeason.test.mjs`
 * et par `scripts/check-segmented-show.mjs`, qui rejoue la fusion sur les vraies
 * données TMDB. Le branchement sur les requêtes réelles vit dans
 * `segmentedSeasons.ts`.
 */

/** Épisode TMDB tel qu'il arrive de `/tv/{id}/season/{n}`. */
export interface SegmentedEpisode {
  id?: number;
  episode_number?: number;
  name?: string | null;
  overview?: string | null;
  runtime?: number | null;
  air_date?: string | null;
  still_path?: string | null;
  vote_average?: number | null;
  production_code?: string | null;
  [key: string]: unknown;
}

/** Épisode produit par la fusion. Superset de l'entrée TMDB. */
export interface MergedEpisode extends SegmentedEpisode {
  episode_number: number;
  /** Numéros TMDB d'origine — 2 pour une paire, 1 pour un épisode pleine durée. */
  source_episode_numbers: number[];
  /** Ids TMDB d'origine, dans le même ordre. */
  source_episode_ids: number[];
  /** Case de production d'où vient l'épisode (`309`), quand elle est connue. */
  production_slot: string | null;
  /** `true` dès que l'épisode rendu n'est pas une entrée TMDB telle quelle. */
  is_merged: boolean;
  /** Position dans une entrée scindée (44 min → 2 épisodes), sinon `null`. */
  part: { index: number; total: number } | null;
}

export type SegmentedWarningCode =
  /** `runtime` absent : l'entrée est traitée comme un segment, faute de mieux. */
  | 'missing-runtime'
  /** Aucun code de production : repli sur la fusion par adjacence. */
  | 'missing-production-code'
  /** Segment sans successeur fusionnable (fin de saison, ou épisode entier juste après). */
  | 'orphan-segment'
  /** Code de production déjà complet : une nouvelle case est ouverte. */
  | 'duplicate-production-code';

export interface SegmentedWarning {
  code: SegmentedWarningCode;
  /** Numéro d'épisode TMDB concerné. */
  episodeNumber: number;
  message: string;
}

export interface MergeSegmentedSeasonOptions {
  /** Durée (minutes) au-delà de laquelle une entrée sans code est un épisode entier. Défaut : 12. */
  segmentMaxRuntime?: number;
  /** Durée nominale d'un épisode diffusé (minutes). Sert à détecter les entrées double. Défaut : 22. */
  slotRuntime?: number;
  /**
   * Nombre d'épisodes fusionnés à conserver. Appliqué APRÈS la fusion, pour les
   * saisons dont la diffusion ou le doublage est encore en cours.
   */
  limit?: number | null;
  /**
   * Codes de production absents de TMDB, par numéro d'épisode TMDB. Relevés sur
   * Wikipédia ; ils évitent le repli par adjacence là où il se tromperait.
   */
  productionCodes?: Record<number, string> | null;
  /**
   * Épisodes de la même saison dans une autre langue (en-US), utilisés pour
   * combler un titre ou un synopsis manquant côté fr-FR. Indexés par
   * `episode_number`.
   */
  fallbackEpisodes?: SegmentedEpisode[] | null;
  /** Appelé pour chaque anomalie rencontrée. */
  onWarning?: (warning: SegmentedWarning) => void;
}

export interface MergeSegmentedSeasonResult {
  episodes: MergedEpisode[];
  warnings: SegmentedWarning[];
  stats: {
    /** Entrées TMDB reçues. */
    sourceCount: number;
    /** Entrées rattachées à une case de production. */
    codedCount: number;
    /** Entrées sans code, passées à la fusion par adjacence. */
    uncodedCount: number;
    /** Cases de production reconstituées (entrées sans code comprises). */
    slotCount: number;
    /** Cases faites de deux entrées recollées. */
    pairCount: number;
    /** Cases occupées par une seule entrée pleine durée. */
    standaloneCount: number;
    /** Entrées restées seules alors qu'elles auraient dû être appariées. */
    orphanCount: number;
    /** Épisodes supplémentaires nés d'une entrée double (44 min → 2). */
    splitCount: number;
    /** Épisodes produits avant application de `limit`. */
    mergedCount: number;
    /** Épisodes finalement rendus. */
    finalCount: number;
  };
}

const DEFAULT_SEGMENT_MAX_RUNTIME = 12;
const DEFAULT_SLOT_RUNTIME = 22;

/**
 * TMDB ne laisse pas un titre vide quand la traduction manque : il renvoie un
 * gabarit (« Épisode 12 »). Le repli en-US doit se déclencher là aussi, sinon la
 * moitié d'une saison s'appelle « Épisode 12 / Épisode 13 ».
 */
const PLACEHOLDER_NAME_RE = /^(?:épisode|episode|folge|episodio)\s*\d+$/i;

const isBlank = (value: unknown): boolean =>
  typeof value !== 'string' || value.trim().length === 0;

const isUsableName = (value: unknown): value is string =>
  !isBlank(value) && !PLACEHOLDER_NAME_RE.test((value as string).trim());

const isUsableText = (value: unknown): value is string => !isBlank(value);

const numberOf = (episode: SegmentedEpisode, index: number): number =>
  Number.isFinite(episode?.episode_number) ? Number(episode.episode_number) : index + 1;

const finiteOr = (value: unknown, fallback: number): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * Cases de production occupées par une entrée, ou `null` si elle n'a pas de
 * code exploitable.
 *
 * `309A` → `['309']` (une moitié) · `301` → `['301']` (épisode entier) ·
 * `501 502` → `['501', '502']` · `811` en 44 min → deux cases.
 */
const resolveSlots = (
  code: unknown,
  runtime: unknown,
  slotRuntime: number
): { slots: string[]; half: boolean } | null => {
  const raw = typeof code === 'string' ? code.trim() : '';
  if (!raw) return null;

  const tokens = raw.split(/[\s,/+]+/).filter(Boolean);
  if (tokens.length > 1) {
    return { slots: tokens.map((token) => token.replace(/[A-Za-z]+$/, '')), half: false };
  }

  const base = tokens[0].replace(/[A-Za-z]+$/, '');
  if (!base) return null;

  // Un suffixe de lettre marque une moitié d'épisode : jamais plus d'une case,
  // et ce signal prime sur la durée. TMDB annonce 22 minutes pour `414A`
  // (« Good Sports »), qui est bien un segment de 11 — sans cette priorité,
  // son jumeau `414B` resterait orphelin et la saison 4 gagnerait un épisode.
  if (/[A-Za-z]$/.test(tokens[0])) return { slots: [base], half: true };

  const minutes = Number(runtime);
  const spans =
    Number.isFinite(minutes) && minutes >= 1.5 * slotRuntime
      ? Math.max(1, Math.round(minutes / slotRuntime))
      : 1;
  // Les cases supplémentaires d'une entrée double reçoivent une clé dérivée :
  // rien d'autre ne doit venir s'y greffer.
  return {
    slots: Array.from({ length: spans }, (_, offset) => (offset === 0 ? base : `${base}+${offset}`)),
    half: false,
  };
};

interface Slot {
  key: string;
  /** Nombre d'épisodes que cette case produit (2 pour une entrée double). */
  spans: number;
  entries: Array<{ episode: SegmentedEpisode; index: number }>;
  /** `true` quand la case vient du repli par adjacence. */
  fromFallback: boolean;
  /** `true` quand la case n'a reçu qu'une moitié d'épisode. */
  orphan: boolean;
}

/**
 * Fusionne les segments d'une saison TMDB en épisodes diffusés.
 *
 * Les cases de production sont rendues dans l'ordre où elles apparaissent pour
 * la première fois dans la liste TMDB : l'ordre d'affichage du site ne bouge
 * donc pas, seul le regroupement change.
 */
export function mergeSegmentedSeason(
  episodes: SegmentedEpisode[] | null | undefined,
  options: MergeSegmentedSeasonOptions = {}
): MergeSegmentedSeasonResult {
  const segmentMaxRuntime = options.segmentMaxRuntime ?? DEFAULT_SEGMENT_MAX_RUNTIME;
  const slotRuntime = options.slotRuntime ?? DEFAULT_SLOT_RUNTIME;
  const warnings: SegmentedWarning[] = [];

  const warn = (code: SegmentedWarningCode, episodeNumber: number, message: string): void => {
    const warning: SegmentedWarning = { code, episodeNumber, message };
    warnings.push(warning);
    options.onWarning?.(warning);
  };

  const source = Array.isArray(episodes) ? [...episodes] : [];
  // L'appelant est censé fournir un tableau trié ; on ne lui fait pas confiance,
  // l'ordre décide de l'ordre d'affichage.
  source.sort((a, b) => numberOf(a, 0) - numberOf(b, 0));

  const fallbackByNumber = new Map<number, SegmentedEpisode>();
  for (const [index, episode] of (options.fallbackEpisodes ?? []).entries()) {
    fallbackByNumber.set(numberOf(episode, index), episode);
  }

  /** Titre exploitable : fr-FR d'abord, en-US ensuite. */
  const nameOf = (episode: SegmentedEpisode, index: number): string => {
    if (isUsableName(episode.name)) return episode.name.trim();
    const fallback = fallbackByNumber.get(numberOf(episode, index));
    if (fallback && isUsableName(fallback.name)) return fallback.name.trim();
    return isUsableText(episode.name) ? episode.name.trim() : '';
  };

  /** Synopsis exploitable : fr-FR d'abord, en-US ensuite. */
  const overviewOf = (episode: SegmentedEpisode, index: number): string => {
    if (isUsableText(episode.overview)) return episode.overview.trim();
    const fallback = fallbackByNumber.get(numberOf(episode, index));
    if (fallback && isUsableText(fallback.overview)) return fallback.overview.trim();
    return '';
  };

  const stillOf = (episode: SegmentedEpisode, index: number): string | null => {
    if (!isBlank(episode.still_path)) return episode.still_path as string;
    const fallback = fallbackByNumber.get(numberOf(episode, index));
    return isBlank(fallback?.still_path) ? null : (fallback!.still_path as string);
  };

  // -------------------------------------------------------------------------
  // 1. Classement des entrées : case de production, ou repli par adjacence
  // -------------------------------------------------------------------------
  const isSegment = (episode: SegmentedEpisode, index: number): boolean => {
    const runtime = episode?.runtime;
    if (runtime === null || runtime === undefined || !Number.isFinite(Number(runtime))) {
      warn(
        'missing-runtime',
        numberOf(episode, index),
        `durée absente pour l'épisode ${numberOf(episode, index)} : traité comme un segment`
      );
      return true;
    }
    return Number(runtime) <= segmentMaxRuntime;
  };

  /** Cases de production de chaque entrée (`null` = code absent). */
  const slotsPerEntry = source.map((episode, index) => {
    const number = numberOf(episode, index);
    const override = options.productionCodes?.[number];
    const code = isBlank(override) ? episode.production_code : override;
    const resolved = resolveSlots(code, episode.runtime, slotRuntime);
    if (!resolved) {
      warn(
        'missing-production-code',
        number,
        `code de production absent pour l'épisode ${number} : repli sur la fusion par adjacence`
      );
    }
    return resolved;
  });

  // `isSegment` avertit : une seule évaluation par entrée.
  const shortRuntime = source.map((episode, index) => isSegment(episode, index));

  /**
   * `true` quand l'entrée n'est qu'une moitié d'épisode. Le suffixe du code de
   * production tranche en premier ; à défaut, la durée.
   */
  const halves = source.map((episode, index) => {
    const resolved = slotsPerEntry[index];
    if (!resolved) return shortRuntime[index];
    if (resolved.half) return true;
    return resolved.slots.length === 1 && shortRuntime[index];
  });

  // -------------------------------------------------------------------------
  // 2. Balayage unique, dans l'ordre d'apparition TMDB
  // -------------------------------------------------------------------------
  const resolvedSlots: Slot[] = [];
  const consumed = new Array<boolean>(source.length).fill(false);
  const usedKeys = new Map<string, number>();

  /** Clé unique pour une case : un code répété (doublon TMDB) en ouvre une nouvelle. */
  const uniqueKey = (key: string, episodeNumber: number): string => {
    const occurrences = (usedKeys.get(key) ?? 0) + 1;
    usedKeys.set(key, occurrences);
    if (occurrences === 1) return key;
    if (!key.startsWith('~')) {
      warn(
        'duplicate-production-code',
        episodeNumber,
        `le code ${key} est déjà complet : l'épisode ${episodeNumber} ouvre une nouvelle case`
      );
    }
    return `${key}#${occurrences}`;
  };

  for (let index = 0; index < source.length; index += 1) {
    if (consumed[index]) continue;
    consumed[index] = true;

    const episode = source[index];
    const number = numberOf(episode, index);
    const slots = slotsPerEntry[index];
    const entry = { episode, index };

    // --- Entrée sans code : on recolle au voisin immédiat, lui aussi sans code.
    if (!slots) {
      const nextIndex = index + 1;
      const fusable =
        halves[index] &&
        nextIndex < source.length &&
        !consumed[nextIndex] &&
        slotsPerEntry[nextIndex] === null &&
        halves[nextIndex];

      if (!fusable) {
        if (halves[index]) {
          warn(
            'orphan-segment',
            number,
            nextIndex < source.length
              ? `segment ${number} sans moitié adjacente fusionnable : laissé seul`
              : `segment ${number} en fin de saison sans successeur : laissé seul`
          );
        }
        resolvedSlots.push({
          key: uniqueKey(`~${number}`, number),
          spans: 1,
          entries: [entry],
          fromFallback: true,
          orphan: halves[index],
        });
        continue;
      }

      consumed[nextIndex] = true;
      resolvedSlots.push({
        key: uniqueKey(`~${number}`, number),
        spans: 1,
        entries: [entry, { episode: source[nextIndex], index: nextIndex }],
        fromFallback: true,
        orphan: false,
      });
      continue;
    }

    // --- Entrée pleine durée, ou entrée qui couvre plusieurs cases : elle est
    //     seule dans sa case, il n'y a pas de seconde moitié à chercher.
    if (slots.slots.length > 1 || !halves[index]) {
      resolvedSlots.push({
        key: uniqueKey(slots.slots[0], number),
        spans: slots.slots.length,
        entries: [entry],
        fromFallback: false,
        orphan: false,
      });
      continue;
    }

    // --- Moitié d'épisode : on cherche l'autre moitié du même code, où qu'elle
    //     soit dans la liste — c'est tout l'intérêt du code de production.
    const key = slots.slots[0];
    let partnerIndex = -1;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (consumed[cursor]) continue;
      const other = slotsPerEntry[cursor];
      if (other && other.slots.length === 1 && other.slots[0] === key && halves[cursor]) {
        partnerIndex = cursor;
        break;
      }
    }

    if (partnerIndex === -1) {
      warn(
        'orphan-segment',
        number,
        `segment ${number} (code ${key}) sans seconde moitié dans la saison : laissé seul`
      );
      resolvedSlots.push({
        key: uniqueKey(key, number),
        spans: 1,
        entries: [entry],
        fromFallback: false,
        orphan: true,
      });
      continue;
    }

    consumed[partnerIndex] = true;
    resolvedSlots.push({
      key: uniqueKey(key, number),
      spans: 1,
      entries: [entry, { episode: source[partnerIndex], index: partnerIndex }],
      fromFallback: false,
      orphan: false,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Construction des épisodes
  // -------------------------------------------------------------------------
  const merged: MergedEpisode[] = [];
  let pairCount = 0;
  let standaloneCount = 0;
  let orphanCount = 0;
  let splitCount = 0;

  for (const slot of resolvedSlots) {
    if (!slot.entries.length) continue;

    const first = slot.entries[0];
    const names = slot.entries.map(({ episode, index }) => nameOf(episode, index)).filter(Boolean);
    const overviews = slot.entries
      .map(({ episode, index }) => overviewOf(episode, index))
      .filter(Boolean);
    const runtimeTotal = slot.entries.reduce(
      (total, { episode }) => total + finiteOr(episode.runtime, 0),
      0
    );
    const votes = slot.entries
      .map(({ episode }) => Number(episode.vote_average))
      .filter((value) => Number.isFinite(value) && value > 0);
    const airDate =
      slot.entries.map(({ episode }) => episode.air_date).find((date) => !isBlank(date)) ?? null;
    const still =
      slot.entries.map(({ episode, index }) => stillOf(episode, index)).find(Boolean) ?? null;
    const productionSlot = slot.fromFallback ? null : slot.key.split('#')[0];

    if (slot.entries.length > 1) pairCount += 1;
    else if (slot.orphan) orphanCount += 1;
    else standaloneCount += 1;

    const spans = Math.max(1, slot.spans);
    if (spans > 1) splitCount += spans - 1;

    for (let part = 1; part <= spans; part += 1) {
      const suffix = spans > 1 ? ` (${part}/${spans})` : '';
      merged.push({
        ...first.episode,
        episode_number: merged.length + 1,
        name: names.join(' / ') + suffix,
        overview: overviews.join('\n\n'),
        // Durée totale : 0 plutôt que `null`, qui reclasserait l'épisode en
        // segment si la fusion repassait dessus.
        runtime: spans > 1 ? Math.round(runtimeTotal / spans) : runtimeTotal,
        air_date: airDate,
        still_path: still,
        vote_average: votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0,
        production_slot: productionSlot,
        source_episode_numbers: slot.entries.map(({ episode, index }) => numberOf(episode, index)),
        source_episode_ids: slot.entries
          .map(({ episode }) => episode.id)
          .filter((id) => Number.isFinite(id))
          .map(Number),
        is_merged: slot.entries.length > 1 || spans > 1,
        part: spans > 1 ? { index: part, total: spans } : null,
      });
    }
  }

  const mergedCount = merged.length;
  const limit = options.limit;
  const limited =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? merged.slice(0, limit) : merged;

  return {
    episodes: limited,
    warnings,
    stats: {
      sourceCount: source.length,
      codedCount: slotsPerEntry.filter(Boolean).length,
      uncodedCount: slotsPerEntry.filter((slots) => slots === null).length,
      slotCount: resolvedSlots.filter((slot) => slot.entries.length).length,
      pairCount,
      standaloneCount,
      orphanCount,
      splitCount,
      mergedCount,
      finalCount: limited.length,
    },
  };
}

export default mergeSegmentedSeason;
