/**
 * Branchement de la fusion « segments → épisode diffusé » sur les requêtes TMDB.
 *
 * ## Pourquoi ici, et pas dans les pages
 *
 * Le catalogue interroge TMDB depuis une douzaine d'endroits — fiche série,
 * lecteur, panneau « à suivre », téléchargement, signalement, modale de
 * changement de média, calendrier… Corriger chacun d'eux voudrait dire répéter
 * la même logique douze fois et en oublier une. Toutes ces requêtes partent en
 * revanche de la même instance Axios : un intercepteur de réponse suffit à
 * servir partout des saisons recollées, sans qu'aucune page n'ait à le savoir.
 *
 * On agit en **réponse** plutôt qu'en requête pour rester indépendant de l'ordre
 * d'installation vis-à-vis de `httpCache.ts`, qui remplace l'`adapter` : le
 * cache continue de stocker la réponse TMDB brute, et la fusion s'applique à
 * chaque lecture. Aucune entrée de cache à invalider, donc — la clé n'a pas
 * changé de sens, seul l'objet rendu est recollé après coup.
 *
 * ## Ce qui est réécrit
 *
 * - `/tv/{id}/season/{n}` → la liste `episodes` fusionnée, renumérotée 1..N.
 * - `/tv/{id}/season/{n}/episode/{e}` → l'épisode fusionné n° `e`. TMDB répond
 *   ici sur la numérotation des segments : sa réponse est jetée au profit de
 *   celle de la saison, sans quoi « épisode 5 » ne désignerait pas la même chose
 *   selon l'écran.
 * - `/tv/{id}` → `seasons[].episode_count` et `number_of_episodes`, sans quoi le
 *   sélecteur de saison annoncerait 49 épisodes pour une saison qui en affiche
 *   26, et « épisode précédent » depuis la saison suivante viserait dans le vide.
 *
 * La saison 0 (spéciaux) n'est jamais touchée, et une série absente de
 * `SEGMENTED_SHOWS` ne paie strictement rien : une regex sur l'URL, et on rend
 * la réponse telle quelle.
 */
import type { AxiosInstance, AxiosResponse } from 'axios';
import {
  mergeSegmentedSeason,
  type MergedEpisode,
  type SegmentedEpisode,
} from './mergeSegmentedSeason';
import {
  getProductionCodeFixes,
  getSeasonLimit,
  getSegmentedShowConfig,
  isMergeableSeason,
  type SegmentedShowConfig,
} from './segmentedShows';

/** Langue de repli quand un titre ou un synopsis manque dans la langue demandée. */
const FALLBACK_LANGUAGE = 'en-US';

/**
 * Marque une requête interne (repli en-US) : sa réponse ne doit pas être
 * fusionnée, sinon la table de repli serait elle-même recollée et les titres ne
 * correspondraient plus aux numéros d'épisodes TMDB.
 */
interface SegmentedRequestConfig {
  __movixSegmentedRaw?: boolean;
}

/**
 * `/3/tv/{id}`, `/3/tv/{id}/season/{n}` ou `/3/tv/{id}/season/{n}/episode/{e}`,
 * et rien d'autre : `/videos`, `/images`, `/credits` doivent passer intacts.
 */
const TMDB_TV_RE =
  /^https?:\/\/api\.themoviedb\.org\/3\/tv\/(\d+)(?:\/season\/(\d+)(?:\/episode\/(\d+))?)?(?:\?.*)?$/;

interface TmdbTarget {
  showId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** Base de l'URL sans le chemin, pour reconstruire les requêtes internes. */
  query: URLSearchParams;
}

const parseTarget = (url: string): TmdbTarget | null => {
  const match = TMDB_TV_RE.exec(url);
  if (!match) return null;
  const queryIndex = url.indexOf('?');
  return {
    showId: Number(match[1]),
    seasonNumber: match[2] === undefined ? null : Number(match[2]),
    episodeNumber: match[3] === undefined ? null : Number(match[3]),
    query: new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1)),
  };
};

const seasonUrl = (showId: number, seasonNumber: number, query: URLSearchParams): string => {
  const params = new URLSearchParams(query);
  return `https://api.themoviedb.org/3/tv/${showId}/season/${seasonNumber}?${params.toString()}`;
};

const isMissingTranslation = (episodes: SegmentedEpisode[]): boolean =>
  episodes.some(
    (episode) =>
      typeof episode?.overview !== 'string' ||
      episode.overview.trim().length === 0 ||
      typeof episode?.name !== 'string' ||
      episode.name.trim().length === 0
  );

/** Fusionne une saison TMDB brute. Ne renvoie `null` que si rien n'est à faire. */
const mergeSeasonPayload = (
  payload: unknown,
  config: SegmentedShowConfig,
  seasonNumber: number,
  fallbackEpisodes: SegmentedEpisode[] | null
): (Record<string, unknown> & { episodes: MergedEpisode[] }) | null => {
  const season = payload as Record<string, unknown> | null;
  if (!season || !Array.isArray(season.episodes)) return null;

  const result = mergeSegmentedSeason(season.episodes as SegmentedEpisode[], {
    segmentMaxRuntime: config.segmentMaxRuntime,
    slotRuntime: config.slotRuntime,
    limit: getSeasonLimit(config, seasonNumber),
    productionCodes: getProductionCodeFixes(config, seasonNumber),
    fallbackEpisodes,
  });

  for (const warning of result.warnings) {
    console.warn(`[segments] ${config.label} S${seasonNumber} · ${warning.code} · ${warning.message}`);
  }

  return { ...season, episodes: result.episodes, movix_segments_merged: true };
};

/**
 * Branche la fusion sur une instance Axios.
 *
 * À installer sur chaque instance qui parle à TMDB : celles créées via
 * `axios.create()` n'héritent pas des intercepteurs de l'export global.
 */
export const installSegmentedSeasons = (instance: AxiosInstance): void => {
  /** Saison brute, hors intercepteur, pour le repli en-US. */
  const fetchRawSeason = async (
    showId: number,
    seasonNumber: number,
    query: URLSearchParams,
    language: string
  ): Promise<SegmentedEpisode[] | null> => {
    const params = new URLSearchParams(query);
    params.set('language', language);
    try {
      const { data } = await instance.get(seasonUrl(showId, seasonNumber, params), {
        __movixSegmentedRaw: true,
      } as SegmentedRequestConfig);
      return Array.isArray(data?.episodes) ? (data.episodes as SegmentedEpisode[]) : null;
    } catch {
      return null;
    }
  };

  /** Saison fusionnée, en passant par l'instance (donc par le cache HTTP). */
  const fetchMergedSeason = async (
    showId: number,
    seasonNumber: number,
    query: URLSearchParams
  ): Promise<MergedEpisode[] | null> => {
    try {
      const { data } = await instance.get(seasonUrl(showId, seasonNumber, query));
      return Array.isArray(data?.episodes) ? (data.episodes as MergedEpisode[]) : null;
    } catch {
      return null;
    }
  };

  instance.interceptors.response.use(async (response: AxiosResponse) => {
    if ((response.config as SegmentedRequestConfig)?.__movixSegmentedRaw) return response;
    if ((response.config?.method ?? 'get').toLowerCase() !== 'get') return response;

    let url: string;
    try {
      url = instance.getUri(response.config);
    } catch {
      return response;
    }

    const target = parseTarget(url);
    if (!target) return response;

    const config = getSegmentedShowConfig(target.showId);
    if (!config) return response;

    // --- Fiche série : recalculer les compteurs d'épisodes.
    if (target.seasonNumber === null) {
      const show = response.data as Record<string, unknown> | null;
      if (!show || !Array.isArray(show.seasons)) return response;

      const seasons = show.seasons as Array<Record<string, unknown>>;
      const counts = await Promise.all(
        seasons.map(async (season) => {
          const number = Number(season?.season_number);
          if (!isMergeableSeason(number)) return null;
          const merged = await fetchMergedSeason(target.showId, number, target.query);
          return merged ? merged.length : null;
        })
      );

      const patched = seasons.map((season, index) =>
        counts[index] === null ? season : { ...season, episode_count: counts[index] }
      );
      const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);

      return {
        ...response,
        data: {
          ...show,
          seasons: patched,
          number_of_episodes: total > 0 ? total : show.number_of_episodes,
          movix_segments_merged: true,
        },
      };
    }

    if (!isMergeableSeason(target.seasonNumber)) return response;

    // --- Épisode isolé : TMDB répond sur la numérotation des segments, on lui
    //     substitue l'épisode fusionné de même rang.
    if (target.episodeNumber !== null) {
      const merged = await fetchMergedSeason(target.showId, target.seasonNumber, target.query);
      const episode = merged?.[target.episodeNumber - 1];
      if (!episode) return response;
      return { ...response, data: { ...response.data, ...episode } };
    }

    // --- Saison complète.
    const season = response.data as Record<string, unknown> | null;
    if (!season || !Array.isArray(season.episodes)) return response;

    const language = target.query.get('language') ?? '';
    const episodes = season.episodes as SegmentedEpisode[];
    const fallback =
      language && !language.startsWith('en') && isMissingTranslation(episodes)
        ? await fetchRawSeason(target.showId, target.seasonNumber, target.query, FALLBACK_LANGUAGE)
        : null;

    const merged = mergeSeasonPayload(season, config, target.seasonNumber, fallback);
    return merged ? { ...response, data: merged } : response;
  });
};

/** Réexport pratique pour les appelants qui veulent tester une série. */
export { getSegmentedShowConfig } from './segmentedShows';

export default installSegmentedSeasons;
