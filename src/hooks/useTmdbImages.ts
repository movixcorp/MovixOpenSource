import { useEffect, useState } from 'react';
import axios from 'axios';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
// v6 : retrait du champ `posterUrls: string[]` (cycling Top 10 supprimé).
// Bumper invalide les anciennes entrées v5 qui contenaient ce champ —
// pas strictement nécessaire pour la correctness (les champs en trop sont
// ignorés), mais évite de transporter du payload mort en sessionStorage.
const CACHE_KEY = 'movix_tmdb_images_cache_v7';
const CACHE_TIMESTAMP_KEY = 'movix_tmdb_images_cache_v7_timestamp';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

type ImageEntry = {
  logoUrl: string | null;
  posterUrl: string | null;
};

// Normalise une entrée cache (potentiellement persistée par une version
// antérieure du schéma) → toujours retourner une ImageEntry complète. Évite
// les `undefined.x` côté consumer si on bump le format sans bumper la
// cache key, ou si une entrée corrompue traîne en sessionStorage.
function normalizeEntry(raw: unknown): ImageEntry {
  if (!raw || typeof raw !== 'object') {
    return { logoUrl: null, posterUrl: null };
  }
  const e = raw as Partial<ImageEntry>;
  return {
    logoUrl: typeof e.logoUrl === 'string' ? e.logoUrl : null,
    posterUrl: typeof e.posterUrl === 'string' ? e.posterUrl : null,
  };
}

// Copie mémoire du cache sessionStorage, tenue au niveau module (même pattern
// que le `inflight` Map ci-dessous). getCache() est appelé plusieurs dizaines
// de fois par row révélée au scroll (2× par mount de CarouselCard + 2× dans
// fetchAndCache) — sans ça, chaque appel refaisait un sessionStorage.getItem
// + JSON.parse du blob COMPLET. Hydratée depuis sessionStorage seulement au
// premier appel ou après expiration TTL ; setCache met à jour la copie
// mémoire ET sessionStorage. Best-effort multi-onglets : une divergence
// temporaire entre onglets (un autre onglet écrit pendant que le TTL courant
// est encore valide ici) est acceptable.
let memoryCache: Record<string, ImageEntry> | null = null;
let memoryCacheTimestamp = 0;

// Helper functions for sessionStorage cache
function getCache(): Record<string, ImageEntry> {
  const now = Date.now();
  if (memoryCache && (now - memoryCacheTimestamp) < CACHE_DURATION_MS) {
    return memoryCache;
  }

  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    const timestamp = sessionStorage.getItem(CACHE_TIMESTAMP_KEY);

    if (cached && timestamp) {
      const parsedTimestamp = parseInt(timestamp);
      const isValid = (now - parsedTimestamp) < CACHE_DURATION_MS;
      if (isValid) {
        const parsed = JSON.parse(cached) as Record<string, unknown>;
        const normalized: Record<string, ImageEntry> = {};
        for (const k of Object.keys(parsed)) {
          normalized[k] = normalizeEntry(parsed[k]);
        }
        memoryCache = normalized;
        memoryCacheTimestamp = parsedTimestamp;
        return memoryCache;
      }
    }
  } catch {
    // Ignore parse errors
  }

  memoryCache = {};
  memoryCacheTimestamp = now;
  return memoryCache;
}

function setCache(cache: Record<string, ImageEntry>) {
  memoryCache = cache;
  memoryCacheTimestamp = Date.now();
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    sessionStorage.setItem(CACHE_TIMESTAMP_KEY, memoryCacheTimestamp.toString());
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

// Pick the best image asset by language priority: FR > EN > any tagged > any.
// IMPORTANT : sans le param API `include_image_language`, TMDB ne renvoie que
// `iso_639_1: 'en'` et `null` (untagged). On force `fr,en,null` pour avoir le
// jeu complet — sinon le find('fr') ne match JAMAIS.
type TmdbImage = { file_path: string; iso_639_1: string | null };

type TmdbImageLanguage = 'fr' | 'en';

const getImageLanguage = (): TmdbImageLanguage =>
  getTmdbLanguage().startsWith('fr') ? 'fr' : 'en';

const getCacheEntryKey = (mediaType: 'movie' | 'tv', id: number, language: TmdbImageLanguage) =>
  `${mediaType}_${id}_${language}`;

function pickBestImage(images: TmdbImage[], preferredLanguage: TmdbImageLanguage): TmdbImage | null {
  if (!Array.isArray(images) || images.length === 0) return null;

  const fallbackLanguages: Array<string | null> = preferredLanguage === 'fr'
    ? ['fr', 'en', null]
    : ['en', null];

  return (
    fallbackLanguages
      .map((language) => images.find((image) => image.iso_639_1 === language))
      .find(Boolean) ||
    images[0] ||
    null
  );
}

// Promesses en vol partagées au scope module. Si plusieurs cards (même
// carousel ou carousels différents) demandent la même paire (mediaType, id)
// au même moment, elles JOIGNENT la même Promise au lieu de fire 30 requêtes
// redondantes pour le même item. Le prefetch idle au mount d'EmblaCarousel
// utilise aussi ce map → 0 fetch dupliqué entre prefetch et hook subscribe.
const inflight = new Map<string, Promise<ImageEntry>>();

async function fetchAndCache(
  mediaType: 'movie' | 'tv',
  id: number,
  language: TmdbImageLanguage,
): Promise<ImageEntry> {
  const key = getCacheEntryKey(mediaType, id, language);
  const cache = getCache();
  if (key in cache) return cache[key];
  if (inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    try {
      // include_image_language=fr,en,null = FR + EN + untagged (sinon TMDB
      // n'expose que en+null par défaut, on perd toutes les FR-versions).
      const includeImageLanguage = language === 'fr' ? 'fr,en,null' : 'en,null';
      const res = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${id}/images`, {
        params: {
          api_key: TMDB_API_KEY,
          include_image_language: includeImageLanguage,
        },
      });

      const logo = pickBestImage(res.data.logos || [], language);
      const poster = pickBestImage(res.data.posters || [], language);

      const result: ImageEntry = {
        logoUrl: logo ? `https://image.tmdb.org/t/p/w300${logo.file_path}` : null,
        posterUrl: poster ? `https://image.tmdb.org/t/p/w342${poster.file_path}` : null,
      };

      const updated = getCache();
      updated[key] = result;
      setCache(updated);
      return result;
    } catch {
      // Cache empty result to avoid repeated failed requests
      const result: ImageEntry = { logoUrl: null, posterUrl: null };
      const updated = getCache();
      updated[key] = result;
      setCache(updated);
      return result;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Prefetch & cache (logo + poster) sans souscrire à un état React.
 *
 * Usage : EmblaCarousel idle prewarm pour remplir la cache avant que les
 * cards ne soient hover/visibles. Joint l'inflight map si une requête est
 * déjà en vol pour la même paire (mediaType, id) → 0 doublon avec les
 * hooks `useTmdbImages` mountés sur les cards qui partagent le même item.
 */
export async function prefetchTmdbImages(mediaType: 'movie' | 'tv', id: number): Promise<void> {
  await fetchAndCache(mediaType, id, getImageLanguage());
}

/**
 * Fetches the best logo + poster (language-prioritized) for a movie or TV show.
 * Single TMDB API call → both URLs returned. Uses sessionStorage cache (24h
 * TTL) keyed by `${mediaType}_${id}`.
 *
 * Sizes :
 *  - logo  → w300 (~30-80 KB) — largement assez pour le display ~28-40px
 *  - poster → w342 (~50-80 KB) — match la taille des cards 192px CSS
 *
 * @param mediaType 'movie' | 'tv'
 * @param id TMDB ID
 * @param refreshKey Optional refresh key
 * @returns { logoUrl, posterUrl } — null si non disponible
 */
export function useTmdbImages(
  mediaType: 'movie' | 'tv' | undefined,
  id: number | undefined,
  refreshKey?: number,
): ImageEntry {
  const imageLanguage = getImageLanguage();

  // Init synchronously from cache : si l'entrée a déjà été fetchée par le
  // prefetch idle d'EmblaCarousel ou par un autre hook au mount précédent,
  // on retourne la valeur dès le premier render — 0 flicker.
  const [, setEntry] = useState<ImageEntry>(() => {
    if (!mediaType || !id) return { logoUrl: null, posterUrl: null };
    const cache = getCache();
    return cache[getCacheEntryKey(mediaType, id, imageLanguage)] ?? { logoUrl: null, posterUrl: null };
  });

  useEffect(() => {
    if (!mediaType || !id) {
      setEntry({ logoUrl: null, posterUrl: null });
      return;
    }

    const key = getCacheEntryKey(mediaType, id, imageLanguage);
    const cache = getCache();

    if (key in cache) {
      setEntry(cache[key]);
      return;
    }

    let cancelled = false;
    fetchAndCache(mediaType, id, imageLanguage).then((result) => {
      if (!cancelled) setEntry(result);
    });
    return () => { cancelled = true; };
  }, [mediaType, id, refreshKey, imageLanguage]);

  if (!mediaType || !id) return { logoUrl: null, posterUrl: null };

  const cache = getCache();
  return cache[getCacheEntryKey(mediaType, id, imageLanguage)] ?? { logoUrl: null, posterUrl: null };
}

/**
 * Backwards-compat wrapper : `useTmdbLogo` returns just the logoUrl.
 * @deprecated Préférer `useTmdbImages` qui renvoie aussi le poster localisé.
 */
export function useTmdbLogo(
  mediaType: 'movie' | 'tv' | undefined,
  id: number | undefined,
  refreshKey?: number,
): string | null {
  return useTmdbImages(mediaType, id, refreshKey).logoUrl;
}
