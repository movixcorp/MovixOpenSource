/**
 * Séries découpées en segments par TMDB, et comment les recoller.
 *
 * TMDB applique aux cartoons jeunesse une règle éditoriale stricte : un segment
 * de 11 minutes est une entrée d'épisode. Nos fichiers, eux, suivent la
 * diffusion (22 minutes = 1 épisode). Ce fichier est la seule liste des séries
 * concernées — la logique de fusion, elle, est générique et vit dans
 * `mergeSegmentedSeason.ts`.
 *
 * Ajouter une série = ajouter une entrée ici. Rien d'autre à toucher.
 */

export interface SegmentedShowConfig {
  /** Nom lisible, pour les logs et le script de vérification. */
  label: string;
  /** Durée (minutes) au-delà de laquelle une entrée sans code est un épisode entier. */
  segmentMaxRuntime: number;
  /** Durée nominale d'un épisode diffusé (minutes) : sert à repérer les entrées double. */
  slotRuntime?: number;
  /**
   * Saisons dont on ne garde que les N premiers épisodes fusionnés : diffusion
   * ou doublage encore en cours, on n'a pas les fichiers au-delà. La limite
   * s'applique APRÈS la fusion.
   */
  seasonLimits?: Record<number, number>;
  /**
   * Codes de production que TMDB a laissés vides, relevés sur Wikipédia
   * (« List of The Loud House episodes »). Sans eux, ces entrées retombent sur
   * la fusion par adjacence, qui se trompe dès que TMDB a rangé les deux
   * moitiés d'un épisode loin l'une de l'autre.
   *
   * Structure : saison → numéro d'épisode TMDB → code de production.
   */
  productionCodeFixes?: Record<number, Record<number, string>>;
}

export const SEGMENTED_SHOWS: Record<number, SegmentedShowConfig> = {
  // Bienvenue chez les Loud (The Loud House)
  68073: {
    label: 'Bienvenue chez les Loud',
    segmentMaxRuntime: 12,
    slotRuntime: 22,
    // S9 et S10 : doublage FR en cours, on n'a que le début.
    seasonLimits: { 9: 13, 10: 7 },
    productionCodeFixes: {
      // Onze segments de la saison 2 n'ont aucun code côté TMDB. Sans eux,
      // « Fool's Paradise » (216A) se collerait à son voisin de liste au lieu
      // de « Job Insecurity » (216B), qui est deux entrées plus loin.
      2: {
        27: '216A', // Fool's Paradise
        32: '216B', // Job Insecurity
        35: '219B', // Lynn-er Takes All
        36: '219A', // Future Tense
        37: '220A', // Yes Man
        38: '220B', // Friend or Faux?
        39: '221A', // No Laughing Matter
        40: '224',  // Tricked! (épisode entier)
        41: '221B', // No Spoilers
        44: '222A', // Legends
        45: '222B', // Mall of Duty
      },
      // Saison 9 : « Clyde Can't Decide » et « Shred of Evidence » (entrées 35
      // et 36) n'ont de code ni sur TMDB ni sur Wikipédia. Rien à corriger — le
      // repli par adjacence les recolle correctement puisqu'elles se suivent,
      // et l'avertissement le signale.
    },
  },
};

/** Configuration de fusion d'une série, ou `null` si elle n'est pas concernée. */
export const getSegmentedShowConfig = (
  showId: number | string | null | undefined
): SegmentedShowConfig | null => {
  const id = Number(showId);
  if (!Number.isFinite(id)) return null;
  return SEGMENTED_SHOWS[id] ?? null;
};

/**
 * La saison 0 (spéciaux, hors-séries, pilotes) n'obéit à aucune logique de
 * segments : on la laisse strictement intacte.
 */
export const isMergeableSeason = (seasonNumber: number | string | null | undefined): boolean => {
  const season = Number(seasonNumber);
  return Number.isFinite(season) && season > 0;
};

/** Nombre d'épisodes à conserver pour une saison, ou `null` si aucune limite. */
export const getSeasonLimit = (
  config: SegmentedShowConfig | null,
  seasonNumber: number | string | null | undefined
): number | null => {
  const season = Number(seasonNumber);
  if (!config?.seasonLimits || !Number.isFinite(season)) return null;
  const limit = config.seasonLimits[season];
  return Number.isFinite(limit) ? limit : null;
};

/** Codes de production à injecter pour une saison, ou `null`. */
export const getProductionCodeFixes = (
  config: SegmentedShowConfig | null,
  seasonNumber: number | string | null | undefined
): Record<number, string> | null => {
  const season = Number(seasonNumber);
  if (!config?.productionCodeFixes || !Number.isFinite(season)) return null;
  return config.productionCodeFixes[season] ?? null;
};
