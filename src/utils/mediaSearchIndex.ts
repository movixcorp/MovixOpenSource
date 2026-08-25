/**
 * Catalogue local des œuvres déjà consultées, cherchable par ce que TMDB
 * n'indexe pas.
 *
 * ## Ce que ça règle
 *
 * `search/multi` ne cherche que dans les titres. Chercher « société secrète »,
 * « Faito Kurabu » ou « Maomao » ne rend donc rien, alors que la fiche
 * concernée porte exactement ces mots — en mot-clé, en titre japonais, en nom
 * de personnage. Ces données, les fiches les récupèrent déjà pour s'afficher ;
 * elles étaient simplement jetées à la fermeture de l'onglet.
 *
 * On les garde. Chaque fiche ouverte dépose ici ses titres alternatifs, ses
 * mots-clés, ses thèmes et ses personnages, et la recherche vient compléter
 * les résultats TMDB avec ce que ce catalogue reconnaît.
 *
 * ## Sa portée, et sa limite
 *
 * Le catalogue ne connaît que les œuvres dont une fiche a été ouverte sur cet
 * appareil. C'est une mémoire, pas un moteur : il ne remplace pas TMDB, il le
 * prolonge là où TMDB est aveugle. Plus on se sert du site, plus il répond.
 *
 * ## Sa taille
 *
 * `localStorage` est petit et partagé. Le catalogue est donc plafonné et
 * s'allège des entrées les plus anciennes, les mêmes qui ont le moins de
 * chances d'être recherchées. Un quota atteint n'est jamais fatal : on jette
 * la moitié la plus vieille et on réessaie une fois, faute de quoi on renonce
 * en silence — perdre le catalogue est sans conséquence, casser la fiche non.
 */

const STORAGE_KEY = 'movix:mediaSearchIndex.v1';
/** Environ 400 fiches, soit quelques centaines de kilo-octets. */
const MAX_ENTRIES = 400;
/** Au-delà, une seule fiche mangerait la place de dix autres. */
const MAX_TERMS_PER_ENTRY = 80;
const MAX_TERM_LENGTH = 60;

export interface IndexedMedia {
  mediaType: 'movie' | 'tv';
  id: number;
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  /** Date de sortie ou de première diffusion, `YYYY-MM-DD`. */
  date?: string;
  voteAverage?: number;
  genreIds?: number[];
  overview?: string;
  /** Ce par quoi on peut retrouver l'œuvre, en plus de son titre. */
  terms: string[];
  /** Dernière visite, qui décide de ce qu'on garde quand la place manque. */
  seenAt: number;
}

export type IndexedMediaDraft = Omit<IndexedMedia, 'seenAt'>;

/** Sans accents ni casse : « Société Secrète » doit répondre à « societe secrete ». */
const fold = (value: string): string =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const keyOf = (mediaType: string, id: number): string => `${mediaType}:${id}`;

const readAll = (): Map<string, IndexedMedia> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as IndexedMedia[];
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed
      .filter((entry) => entry?.id && entry?.mediaType && Array.isArray(entry.terms))
      .map((entry) => [keyOf(entry.mediaType, entry.id), entry]));
  } catch {
    return new Map();
  }
};

/** Écrit le catalogue, en l'allégeant si le stockage refuse. */
const writeAll = (entries: Map<string, IndexedMedia>): void => {
  const ordered = [...entries.values()].sort((a, b) => b.seenAt - a.seenAt);
  const kept = ordered.slice(0, MAX_ENTRIES);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept.slice(0, Math.floor(kept.length / 2))));
    } catch {
      /* stockage plein ou indisponible : le catalogue n'est pas indispensable */
    }
  }
};

/** Nettoie, dédoublonne et plafonne les termes d'une entrée. */
const cleanTerms = (terms: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const raw of terms) {
    const term = String(raw ?? '').trim().slice(0, MAX_TERM_LENGTH);
    // Un terme d'une seule lettre répond à tout : il ne distingue rien.
    if (term.length < 2) continue;
    const key = fold(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(term);
    if (kept.length >= MAX_TERMS_PER_ENTRY) break;
  }

  return kept;
};

/**
 * Dépose — ou rafraîchit — une œuvre dans le catalogue. Les termes déjà connus
 * sont conservés : une fiche rouverte alors qu'AniList est injoignable ne doit
 * pas perdre ses personnages.
 */
export const rememberMedia = (draft: IndexedMediaDraft): void => {
  if (!draft?.id || !draft.mediaType || !draft.title) return;

  try {
    const entries = readAll();
    const key = keyOf(draft.mediaType, draft.id);
    const previous = entries.get(key);

    entries.set(key, {
      ...draft,
      terms: cleanTerms([...draft.terms, ...(previous?.terms ?? [])]),
      seenAt: Date.now(),
    });

    writeAll(entries);
  } catch {
    /* jamais au prix de la page */
  }
};

/**
 * Les œuvres du catalogue qui répondent à la recherche.
 *
 * Tous les mots de la requête doivent se retrouver dans l'entrée — c'est ce qui
 * permet à « société secrète » de répondre comme à « secrete societe », sans
 * pour autant rendre toute œuvre contenant l'un des deux. Le titre pèse plus
 * lourd qu'un mot-clé, et un terme retrouvé tel quel plus lourd qu'un fragment.
 */
export const searchIndexedMedia = (query: string, limit = 20): IndexedMedia[] => {
  const needle = fold(query);
  if (needle.length < 2) return [];

  const words = needle.split(' ').filter(Boolean);

  const scored = [...readAll().values()].flatMap((entry) => {
    const title = fold(entry.title);
    const terms = entry.terms.map(fold);
    const haystack = [title, ...terms].join(' | ');

    if (!words.every((word) => haystack.includes(word))) return [];

    let score = 0;
    if (title === needle) score += 100;
    else if (title.includes(needle)) score += 60;
    if (terms.some((term) => term === needle)) score += 40;
    else if (terms.some((term) => term.includes(needle))) score += 20;
    // Requête éclatée sur plusieurs termes : ça reste une réponse, en retrait.
    if (score === 0) score = 5;

    return [{ entry, score }];
  });

  return scored
    .sort((a, b) => (b.score - a.score) || (b.entry.seenAt - a.entry.seenAt))
    .slice(0, limit)
    .map((item) => item.entry);
};

/** Vide le catalogue. */
export const clearMediaSearchIndex = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* rien à faire */
  }
};

/** Nombre d'œuvres connues, pour l'afficher dans les réglages. */
export const countIndexedMedia = (): number => readAll().size;
