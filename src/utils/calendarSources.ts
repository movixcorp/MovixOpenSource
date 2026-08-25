/**
 * Lecture des listes locales qui alimentent le calendrier.
 *
 * Isolé du service pour une raison précise : ces listes n'ont pas toutes la
 * même forme, et une lecture naïve échoue en silence — le calendrier se
 * contente d'afficher moins de choses, sans erreur nulle part. C'était
 * exactement le cas de « Reprendre la lecture », stocké en objet
 * `{ movies: [], tv: [] }` et lu comme un tableau. Ces fonctions sont pures et
 * couvertes par `tests/calendarSources.test.mjs`.
 */

export interface CalendarWatchlistItem {
  id: number;
  title?: string;
  poster_path?: string | null;
}

const parse = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const asItems = (value: unknown): CalendarWatchlistItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'number' ? item.id : Number.NaN,
      title: typeof item.title === 'string' ? item.title : undefined,
      poster_path: typeof item.poster_path === 'string' ? item.poster_path : null,
    }))
    .filter((item) => Number.isFinite(item.id));
};

/** Watchlist films ou séries : un simple tableau d'objets. */
export const readWatchlist = (mediaType: 'movie' | 'tv'): CalendarWatchlistItem[] =>
  asItems(parse(`watchlist_${mediaType}`));

/**
 * Séries de « Reprendre la lecture ».
 *
 * Deux formats coexistent, et il faut lire les deux : le format courant est un
 * objet `{ movies: [...], tv: [...] }`, et d'anciennes installations gardent un
 * tableau plat où chaque entrée porte son `media_type`. `Home` migre le second
 * vers le premier au chargement, mais rien ne garantit que l'utilisateur soit
 * passé par l'accueil avant d'ouvrir le calendrier.
 */
export const readContinueWatchingShows = (): CalendarWatchlistItem[] => {
  const value = parse('continueWatching');

  if (Array.isArray(value)) {
    return asItems(value.filter((item) =>
      Boolean(item) && typeof item === 'object'
      && (item as { media_type?: unknown }).media_type === 'tv'));
  }

  if (value && typeof value === 'object') {
    return asItems((value as { tv?: unknown }).tv);
  }

  return [];
};
