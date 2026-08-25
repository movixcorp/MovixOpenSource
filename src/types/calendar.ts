/**
 * Types du calendrier des sorties.
 *
 * Deux familles d'événements cohabitent :
 *
 *  - les sorties du moment, tirées de TMDB sans rien connaître de
 *    l'utilisateur — c'est ce que voit quelqu'un qui arrive sur la page les
 *    mains vides ;
 *  - ceux que le site déduit de ce que l'utilisateur suit (épisodes à venir,
 *    sorties de films, alertes posées) — reconstruits à chaque visite, jamais
 *    stockés ;
 *  - ceux que l'utilisateur saisit lui-même, qui appartiennent à son compte et
 *    doivent lui survivre d'un appareil à l'autre.
 *
 * Les dates sont manipulées en `YYYY-MM-DD`, jamais en `Date` sérialisée. Un
 * `new Date('2026-03-15')` est interprété comme minuit **UTC** : à l'ouest de
 * Greenwich, la date affichée reculait d'un jour. Tout le calcul de dates passe
 * donc par `parseDateKey` / `toDateKey`, qui restent en heure locale.
 */

/** Origine d'un événement, et filtre correspondant dans l'interface. */
export type CalendarSource =
  | 'newReleases'
  | 'airingEpisodes'
  | 'watchlistEpisodes'
  | 'watchlistMovies'
  | 'alerts'
  | 'continueWatching'
  | 'custom';

/**
 * Catégorie d'une entrée : elle donne sa couleur à la pastille et sa place dans
 * les filtres. `other` accepte un libellé libre (`customCategory`), pour tout ce
 * qui n'entre dans aucune case — un concert, un anniversaire, une échéance.
 */
export type CalendarCategory = 'movie' | 'tv' | 'anime' | 'documentary' | 'other';

/** Rythme de répétition d'une entrée personnelle. */
export type CalendarRecurrence = 'none' | 'weekly' | 'monthly' | 'yearly';

/** Rattachement optionnel d'une entrée personnelle à une fiche du site. */
export interface CalendarMediaLink {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  posterPath?: string | null;
}

/** Entrée saisie par l'utilisateur. Persistée et synchronisée avec le compte. */
export interface UserCalendarEntry {
  id: string;
  title: string;
  /** `YYYY-MM-DD` — première occurrence. */
  date: string;
  /** `HH:MM` en heure locale. Absent = journée entière. */
  time?: string;
  category: CalendarCategory;
  /** Libellé saisi quand `category === 'other'`. Ignoré sinon. */
  customCategory?: string;
  note?: string;
  recurrence: CalendarRecurrence;
  /** `YYYY-MM-DD` — dernière date où la répétition s'applique. Absent = sans fin. */
  recurrenceUntil?: string;
  link?: CalendarMediaLink;
  createdAt: string;
}

/**
 * Un événement tel qu'affiché : une date précise, résolue. Une entrée
 * personnelle qui se répète produit plusieurs occurrences, une par date.
 */
export interface CalendarOccurrence {
  /** Unique pour une date donnée — l'id de l'entrée seul ne suffit pas si elle se répète. */
  key: string;
  source: CalendarSource;
  category: CalendarCategory;
  /** Libellé libre repris de l'entrée, quand la catégorie est `other`. */
  customCategory?: string;
  /** `YYYY-MM-DD` local. */
  date: string;
  /** `HH:MM` local, si connue. */
  time?: string;
  title: string;
  /** « S2E4 », « Sortie cinéma »… */
  subtitle?: string;
  note?: string;
  posterPath?: string | null;
  /** Route interne vers la fiche, si l'événement en a une. */
  href?: string;
  /**
   * Popularité TMDB, quand la source la connaît. Sert d'ordre d'affichage au
   * sein d'un même jour : une case de grille ne montre que trois lignes, et
   * sans ce tri l'épisode que tout le monde attend se retrouvait derrière
   * « +9 autres », caché par des sorties confidentielles arrivées plus tôt
   * dans l'assemblage.
   */
  popularity?: number;
  /** Renseigné pour les occurrences issues d'une entrée personnelle. */
  entryId?: string;
}

/** Réglages du calendrier, propres à l'appareil. */
export interface CalendarPreferences {
  view: 'month' | 'agenda';
  /** Sources cochées. Une source absente n'est pas affichée. */
  sources: CalendarSource[];
  /** Catégories cochées, pour les entrées personnelles. */
  categories: CalendarCategory[];
}
