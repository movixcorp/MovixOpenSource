/**
 * Personnages et thèmes d'un anime, via l'API GraphQL publique d'AniList.
 *
 * ## Pourquoi AniList et pas TMDB
 *
 * TMDB rend une distribution — des comédiens, avec le nom du rôle en
 * sous-titre. Pour de l'animation, c'est l'inverse de ce qu'on veut regarder :
 * le personnage a un visage, le seiyū n'en a pas dans la fiche. AniList rend
 * les personnages eux-mêmes, avec leur illustration, leur rôle (principal ou
 * secondaire) et leur voix japonaise. C'est aussi la seule des deux à ranger
 * les œuvres par *tags* — ce que la fiche appelle des thèmes, à côté des
 * genres.
 *
 * ## Le rattachement
 *
 * AniList ne connaît pas les identifiants TMDB. On la cherche donc par titre,
 * en essayant les titres dans l'ordre où ils ont le plus de chances d'aboutir :
 * le titre original japonais d'abord, puis l'anglais, puis le titre affiché.
 * Deux tentatives au maximum — au-delà, on cherche un anime qui n'existe pas
 * chez eux, et chaque essai coûte une requête sur un quota partagé.
 *
 * ## Le quota
 *
 * L'API est ouverte mais limitée (de l'ordre de 90 requêtes par minute et par
 * adresse, dégradée à 30 par moments). Ouvrir trois fiches ne doit pas coûter
 * trois requêtes par fiche : le résultat est retenu en mémoire pour la session
 * et dans `sessionStorage` pour survivre à une navigation. Les échecs sont
 * retenus aussi, brièvement : sans ça, un anime absent d'AniList relancerait
 * une recherche à chaque passage sur sa fiche.
 */

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const CACHE_PREFIX = 'anilist:media:';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Un échec se réessaie plus vite qu'un succès ne se périme. */
const MISS_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Au-delà, on s'acharne sur une œuvre qu'AniList ne connaît pas. */
const MAX_TITLE_ATTEMPTS = 2;

export type AnilistCharacterRole = 'MAIN' | 'SUPPORTING' | 'BACKGROUND';

export interface AnilistCharacter {
  id: number;
  name: string;
  nativeName?: string;
  imageUrl?: string;
  role: AnilistCharacterRole;
  /** Voix japonaise, quand AniList la connaît. */
  voiceActor?: string;
}

export interface AnilistTheme {
  name: string;
  /** Pertinence votée par les utilisateurs d'AniList, de 0 à 100. */
  rank: number;
}

export interface AnilistMedia {
  id: number;
  titles: string[];
  characters: AnilistCharacter[];
  themes: AnilistTheme[];
}

/**
 * Deux pages de personnages en une requête, par alias. La connexion `characters`
 * plafonne à 25 par page ; une distribution d'anime en compte couramment plus,
 * et une seconde requête doublerait le coût pour la moitié des fiches.
 *
 * `sort: [ROLE, RELEVANCE, ID]` met les principaux devant, ce qui donne
 * directement l'ordre d'affichage. `ID` en dernier fige l'ordre : sans lui, deux
 * personnages de même rôle et même pertinence peuvent s'échanger d'un appel à
 * l'autre.
 */
const MEDIA_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
    id
    title { romaji english native }
    synonyms
    tags { name rank isGeneralSpoiler isMediaSpoiler }
    page1: characters(sort: [ROLE, RELEVANCE, ID], page: 1, perPage: 25) {
      edges {
        role
        node { id name { full native } image { large medium } }
        voiceActors(language: JAPANESE, sort: [RELEVANCE]) { name { full } }
      }
    }
    page2: characters(sort: [ROLE, RELEVANCE, ID], page: 2, perPage: 25) {
      edges {
        role
        node { id name { full native } image { large medium } }
        voiceActors(language: JAPANESE, sort: [RELEVANCE]) { name { full } }
      }
    }
  }
}`;

interface RawEdge {
  role?: string | null;
  node?: {
    id?: number;
    name?: { full?: string | null; native?: string | null } | null;
    image?: { large?: string | null; medium?: string | null } | null;
  } | null;
  voiceActors?: Array<{ name?: { full?: string | null } | null }> | null;
}

interface RawMedia {
  id?: number;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: Array<string | null> | null;
  tags?: Array<{
    name?: string | null;
    rank?: number | null;
    isGeneralSpoiler?: boolean | null;
    isMediaSpoiler?: boolean | null;
  }> | null;
  page1?: { edges?: RawEdge[] | null } | null;
  page2?: { edges?: RawEdge[] | null } | null;
}

/** Résultats déjà obtenus pendant cette session, succès comme échecs. */
const memory = new Map<string, { media: AnilistMedia | null; expiresAt: number }>();
/** Recherches en vol, pour que deux composants d'une même fiche n'en fassent qu'une. */
const inFlight = new Map<string, Promise<AnilistMedia | null>>();

const cacheKey = (title: string): string => `${CACHE_PREFIX}${title.trim().toLowerCase()}`;

const readCache = (key: string): { media: AnilistMedia | null } | null => {
  const live = memory.get(key);
  if (live && live.expiresAt > Date.now()) return { media: live.media };

  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { media: AnilistMedia | null; expiresAt: number };
    if (!parsed || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return { media: parsed.media };
  } catch {
    return null;
  }
};

const writeCache = (key: string, media: AnilistMedia | null): void => {
  const entry = { media, expiresAt: Date.now() + (media ? CACHE_TTL_MS : MISS_TTL_MS) };
  memory.set(key, entry);
  try {
    sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* quota ou navigation privée : le cache mémoire suffit pour la session */
  }
};

const normalizeRole = (role?: string | null): AnilistCharacterRole => {
  const value = String(role || '').toUpperCase();
  return value === 'MAIN' || value === 'BACKGROUND' ? value : 'SUPPORTING';
};

const toCharacters = (media: RawMedia): AnilistCharacter[] => {
  const edges = [...(media.page1?.edges ?? []), ...(media.page2?.edges ?? [])];
  const seen = new Set<number>();

  return edges.flatMap((edge) => {
    const node = edge?.node;
    const id = node?.id;
    const name = node?.name?.full || node?.name?.native || '';
    // Un personnage sans nom n'a rien à afficher ; un doublon viendrait d'un
    // chevauchement entre les deux pages demandées.
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);

    return [{
      id,
      name,
      nativeName: node?.name?.native || undefined,
      imageUrl: node?.image?.large || node?.image?.medium || undefined,
      role: normalizeRole(edge?.role),
      voiceActor: edge?.voiceActors?.[0]?.name?.full || undefined,
    }];
  });
};

const toThemes = (media: RawMedia): AnilistTheme[] => (media.tags ?? [])
  // Un tag spoiler dit ce qui arrive à la fin. Il n'a rien à faire sur une
  // fiche qu'on consulte avant de regarder.
  .filter((tag) => tag?.name && !tag.isGeneralSpoiler && !tag.isMediaSpoiler)
  .map((tag) => ({ name: String(tag!.name), rank: Number(tag!.rank ?? 0) }))
  .sort((a, b) => b.rank - a.rank);

const toMedia = (raw: RawMedia): AnilistMedia => ({
  id: Number(raw.id),
  titles: [raw.title?.romaji, raw.title?.english, raw.title?.native, ...(raw.synonyms ?? [])]
    .filter((title): title is string => Boolean(title && title.trim())),
  characters: toCharacters(raw),
  themes: toThemes(raw),
});

/** Une recherche, sans réessai : l'appelant décide s'il tente un autre titre. */
const searchOnce = async (title: string): Promise<AnilistMedia | null> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: MEDIA_QUERY, variables: { search: title } }),
      signal: controller.signal,
    });

    // 404 quand rien ne correspond, 429 quand le quota est atteint : ni l'un ni
    // l'autre ne mérite de casser la fiche, la section disparaît simplement.
    if (!response.ok) return null;

    const payload = await response.json() as { data?: { Media?: RawMedia | null } };
    const raw = payload?.data?.Media;
    return raw?.id ? toMedia(raw) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
};

/**
 * Le média AniList correspondant, cherché sur les titres fournis dans l'ordre.
 * `null` si aucun ne donne rien — cas parfaitement normal pour une œuvre qui
 * n'est pas un anime, et que l'appelant traite comme « pas de section ».
 */
export const findAnilistMedia = async (titles: string[]): Promise<AnilistMedia | null> => {
  const candidates = titles
    .map((title) => String(title || '').trim())
    .filter((title, index, list) => title.length > 1 && list.indexOf(title) === index)
    .slice(0, MAX_TITLE_ATTEMPTS);

  if (candidates.length === 0) return null;

  // Un titre déjà cherché tranche pour tous les autres : c'est la même œuvre.
  for (const candidate of candidates) {
    const cached = readCache(cacheKey(candidate));
    if (cached?.media) return cached.media;
  }

  for (const candidate of candidates) {
    const key = cacheKey(candidate);
    if (readCache(key)) continue; // échec déjà connu et encore frais

    const pending = inFlight.get(key) ?? searchOnce(candidate).then((media) => {
      writeCache(key, media);
      inFlight.delete(key);
      return media;
    });
    inFlight.set(key, pending);

    const media = await pending;
    if (media) return media;
  }

  return null;
};
