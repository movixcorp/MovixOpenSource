/**
 * Mise à plat des blocs `keywords` et `alternative_titles` de TMDB.
 *
 * Les deux existent pour les films comme pour les séries, mais sous deux noms
 * différents : `keywords.keywords` d'un côté, `keywords.results` de l'autre,
 * et pareil pour les titres. Plutôt que de traîner ce détail dans chaque fiche,
 * on le règle ici une fois.
 */

export interface AlternateTitle {
  title: string;
  /** Code pays ISO 3166-1 (`FR`, `JP`…), quand TMDB le donne. */
  region?: string;
  /** Précision libre de TMDB : « working title », « short title »… */
  kind?: string;
}

interface RawAlternateTitle {
  title?: string | null;
  iso_3166_1?: string | null;
  type?: string | null;
}

interface RawKeyword {
  name?: string | null;
}

/** Les deux formes de TMDB, films et séries confondus. */
interface RawList<T> {
  titles?: T[] | null;
  results?: T[] | null;
  keywords?: T[] | null;
}

const listOf = <T,>(payload: RawList<T> | null | undefined): T[] =>
  payload?.titles ?? payload?.results ?? payload?.keywords ?? [];

/** Compare sans tenir compte de la casse ni des accents. */
const fold = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Tous les titres alternatifs, dédoublonnés à la casse et aux accents près, et
 * privés de ceux qui répètent le titre déjà affiché en haut de la fiche.
 */
export const normalizeAlternateTitles = (
  payload: RawList<RawAlternateTitle> | null | undefined,
  known: Array<string | null | undefined> = [],
): AlternateTitle[] => {
  const seen = new Set(known.filter(Boolean).map((title) => fold(String(title))));

  return listOf<RawAlternateTitle>(payload).flatMap((entry) => {
    const title = String(entry?.title || '').trim();
    if (!title) return [];

    const key = fold(title);
    if (seen.has(key)) return [];
    seen.add(key);

    return [{
      title,
      region: entry?.iso_3166_1 ? String(entry.iso_3166_1).toUpperCase() : undefined,
      kind: entry?.type ? String(entry.type).trim() || undefined : undefined,
    }];
  });
};

/** Tous les mots-clés, dédoublonnés et triés pour rester lisibles en nombre. */
export const normalizeKeywords = (
  payload: RawList<RawKeyword> | null | undefined,
  locale = 'fr',
): string[] => {
  const seen = new Set<string>();

  return listOf<RawKeyword>(payload)
    .flatMap((entry) => {
      const name = String(entry?.name || '').trim();
      if (!name) return [];
      const key = fold(name);
      if (seen.has(key)) return [];
      seen.add(key);
      return [name];
    })
    .sort((a, b) => a.localeCompare(b, locale));
};

/**
 * Nom lisible d'un pays. `Intl.DisplayNames` manque sur les moteurs anciens et
 * jette sur un code inconnu : dans les deux cas le code brut fait l'affaire,
 * il reste plus parlant que rien.
 */
export const regionLabel = (region: string, locale: string): string => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(region) || region;
  } catch {
    return region;
  }
};
