import { useEffect, useMemo, useRef, useState } from 'react';

import {
  searchAll,
  type ProviderError,
  type SubtitleQuery,
  type SubtitleTrack,
} from '../services/subtitles/index.ts';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

export interface UseExternalSubtitlesResult {
  tracks: SubtitleTrack[];
  loading: boolean;
  providerErrors: ProviderError[];
}

const EMPTY_TRACKS: SubtitleTrack[] = [];
const EMPTY_ERRORS: ProviderError[] = [];

function queryKey(query: SubtitleQuery): string {
  return `${query.type}:${query.tmdbId ?? ''}:${query.season ?? ''}:${query.episode ?? ''}`;
}

/**
 * Le provider OpenSubtitles legacy s'indexe par IMDB id, pas par TMDB id.
 * La resolution est mise en cache par le hook pour ne pas retaper TMDB a
 * chaque changement d'episode d'une meme serie.
 */
async function resolveImdbId(
  query: SubtitleQuery,
  cache: Map<string, string | null>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!query.tmdbId || !TMDB_API_KEY) return undefined;

  const cacheKey = `${query.type}:${query.tmdbId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined;

  try {
    const endpoint = query.type === 'tv' ? 'tv' : 'movie';
    const response = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(query.tmdbId)}`
      + `/external_ids?api_key=${TMDB_API_KEY}`,
      { signal },
    );
    if (!response.ok) throw new Error(`tmdb responded ${response.status}`);

    const data = await response.json();
    const imdb: unknown = data?.imdb_id ?? data?.external_ids?.imdb_id;
    const normalized = typeof imdb === 'string' && imdb
      ? imdb.replace(/^tt/, '')
      : null;
    cache.set(cacheKey, normalized);
    return normalized ?? undefined;
  } catch (err) {
    // Une annulation (changement d'episode ou demontage pendant que le
    // fetch TMDB est encore en vol) rejette elle aussi avec une AbortError
    // ici, via le `controller.abort()` du cleanup de l'effet appelant. Il
    // ne faut surtout pas la traiter comme un echec TMDB reel : `cacheKey`
    // est une cle PAR SERIE (`type:tmdbId`), pas par episode. Y ecrire
    // `null` sur une simple annulation empoisonnerait le cache pour tous
    // les episodes suivants de cette serie, qui obtiendraient alors un
    // cache-hit silencieux sur `null` et desactiveraient le provider
    // OpenSubtitles legacy pour le reste de la session, sans qu'aucune
    // trace n'apparaisse dans providerErrors. On repropage donc
    // l'AbortError telle quelle : l'effet appelant sait deja l'ignorer via
    // son flag `cancelled` avant de toucher l'etat React (voir le
    // `.catch()` de l'IIFE plus bas), donc rien n'est ecrit apres coup.
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw err;
    }
    // Un echec TMDB reel (500, JSON invalide, etc.), lui, ne doit pas
    // empecher le hook de repondre : on renvoie undefined et le provider
    // legacy se desactive de lui-meme, cette fois a bon droit.
    cache.set(cacheKey, null);
    return undefined;
  }
}

export function useExternalSubtitles(
  query: SubtitleQuery | null,
  preferredLang: string,
): UseExternalSubtitlesResult {
  const [result, setResult] = useState<{ tracks: SubtitleTrack[]; errors: ProviderError[] }>(
    { tracks: EMPTY_TRACKS, errors: EMPTY_ERRORS },
  );
  const [loading, setLoading] = useState(false);

  const resultCacheRef = useRef(new Map<string, { tracks: SubtitleTrack[]; errors: ProviderError[] }>());
  const imdbCacheRef = useRef(new Map<string, string | null>());

  const key = query ? queryKey(query) : '';
  // `query` est souvent recree a chaque rendu par l'appelant : on ne depend
  // que de sa cle serialisee, sinon l'effet se relancerait en boucle.
  const stableQuery = useMemo(() => query, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // `preferredLang` ne change pas l'identite de la requete (stableQuery ne
  // doit pas etre recalcule pour autant), mais il change reellement le
  // resultat : `sortTracks` (dans searchAll) remonte en tete les pistes qui
  // matchent la langue. Le cache de RESULTATS doit donc etre partitionne
  // par langue, sinon un changement de langue sur un episode deja en cache
  // renverrait l'ancien tableau, trie selon l'ancienne langue.
  const resultCacheKey = key ? `${key}:${preferredLang}` : '';

  useEffect(() => {
    if (!stableQuery || !stableQuery.tmdbId) {
      setResult({ tracks: EMPTY_TRACKS, errors: EMPTY_ERRORS });
      setLoading(false);
      return;
    }

    const cached = resultCacheRef.current.get(resultCacheKey);
    if (cached) {
      setResult(cached);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    // Pas de cache-hit : on vide immediatement le resultat precedent pour
    // qu'un consommateur qui n'attendrait pas strictement `loading === false`
    // n'affiche jamais les pistes d'un episode ou d'un titre different
    // pendant que la nouvelle recherche est en cours. On reutilise les
    // constantes EMPTY_TRACKS/EMPTY_ERRORS pour ne pas creer de nouvelles
    // references a chaque rendu.
    setResult({ tracks: EMPTY_TRACKS, errors: EMPTY_ERRORS });
    setLoading(true);

    (async () => {
      const imdbId = await resolveImdbId(stableQuery, imdbCacheRef.current, controller.signal);
      if (cancelled) return;

      const search = await searchAll(
        { ...stableQuery, ...(imdbId ? { imdbId } : {}) },
        controller.signal,
        { preferredLang },
      );
      if (cancelled) return;

      const next = { tracks: search.tracks, errors: search.errors };
      resultCacheRef.current.set(resultCacheKey, next);
      setResult(next);
      setLoading(false);
    })().catch(() => {
      if (cancelled) return;
      setResult({ tracks: EMPTY_TRACKS, errors: EMPTY_ERRORS });
      setLoading(false);
    });

    return () => {
      // Annule au changement d'episode : sans cela une reponse en retard
      // ecraserait les resultats de l'episode suivant.
      cancelled = true;
      controller.abort();
    };
  }, [key, stableQuery, preferredLang, resultCacheKey]);

  return { tracks: result.tracks, loading, providerErrors: result.errors };
}
