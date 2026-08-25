/**
 * Construction du calendrier à partir de ce que l'utilisateur suit déjà.
 *
 * Aucune de ces données n'est stockée : le calendrier est reconstruit à chaque
 * visite depuis la watchlist, l'historique et les alertes. Ce qui rend la chose
 * viable, c'est le cache, à deux étages : le cache HTTP (`utils/httpCache.ts`)
 * ressert les fiches TMDB sans réseau et mutualise les requêtes simultanées
 * vers une même URL ; le cache de fenêtres (`utils/calendarCache.ts`) garde le
 * résultat déjà assemblé, de sorte qu'un mois déjà consulté se réaffiche sans
 * rien recalculer. Un aller-retour sur la page ne redéclenche donc rien.
 *
 * Chaque source est isolée : une série supprimée de TMDB, une réponse en
 * erreur ou une watchlist corrompue ne fait pas échouer le calendrier entier,
 * elle retire seulement ses propres événements.
 *
 * ## Ce que « toutes les sorties » veut dire ici
 *
 * TMDB n'a pas d'endpoint « calendrier ». Il faut donc l'assembler, et le faire
 * naïvement laisse d'immenses trous — c'était le cas :
 *
 *  - `/discover` rend vingt résultats par page, et une seule page était
 *    demandée : le mois s'arrêtait à vingt films et vingt séries, sans que rien
 *    ne signale la coupe. Toutes les requêtes sont maintenant paginées ;
 *  - seules les sorties **en salle** étaient demandées. Les sorties numériques
 *    — celles qui comptent sur un site de streaming — n'apparaissaient nulle
 *    part. Elles font l'objet d'une requête à part, et d'un libellé à part ;
 *  - un film sans date de sortie française était invisible, quelle que soit sa
 *    notoriété. Une troisième requête, sans région, les rattrape ;
 *  - côté séries, `first_air_date` ne connaît que les **nouvelles** séries :
 *    l'épisode du mardi soir d'une série installée n'existait nulle part, sauf
 *    à l'avoir en watchlist. C'est l'objet de `airingEpisodes` ;
 *  - les anime se faisaient sortir du classement par popularité ; ils ont leur
 *    propre requête ;
 *  - enfin, le calendrier ne savait regarder que **devant** lui : tout partait
 *    de `next_episode_to_air`, si bien qu'un épisode déjà diffusé — ou un mois
 *    passé — n'avait rien à montrer. Les épisodes se cherchent désormais par
 *    fenêtre, pas par « prochain ».
 */
import axios from 'axios';
import { AlertService } from './alertService';
import { getTmdbLanguage } from '../i18n';
import { parseDateKey, toDateKey, todayKey } from '../utils/calendarEntries';
import { readContinueWatchingShows, readWatchlist } from '../utils/calendarSources';
import { calendarCacheKey, readCalendarWindow, writeCalendarWindow } from '../utils/calendarCache';
import { encodeId } from '../utils/idEncoder';
import i18n from '../i18n';
import type { CalendarCategory, CalendarOccurrence, CalendarSource } from '../types/calendar';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

/**
 * Nombre de fiches interrogées en parallèle. Une watchlist fournie peut
 * représenter des dizaines de séries ; les lancer toutes d'un coup saturerait
 * la file du navigateur et retarderait le reste de la page. Six plutôt que
 * quatre : depuis que le calendrier interroge aussi les saisons des séries en
 * cours de diffusion, le nombre de fiches à résoudre a doublé, et le navigateur
 * autorise six connexions par hôte de toute façon.
 */
const CONCURRENCY = 6;

/**
 * Plafond de titres examinés par source. Les watchlist de plusieurs centaines
 * d'entrées existent, et tout interroger coûterait plus cher que ça ne
 * rapporte — mais quarante était trop bas : une watchlist de cinquante séries
 * en perdait dix, sans que rien ne le dise.
 */
const MAX_ITEMS_PER_SOURCE = 100;

interface TmdbEpisode {
  air_date?: string | null;
  episode_number?: number;
  season_number?: number;
  name?: string;
}

/** Une saison telle que `/tv/{id}` la décrit. `air_date` = date du premier épisode. */
interface TmdbSeason {
  air_date?: string | null;
  season_number?: number;
  name?: string;
  episode_count?: number;
  poster_path?: string | null;
}

interface TmdbShow {
  id: number;
  name?: string;
  poster_path?: string | null;
  next_episode_to_air?: TmdbEpisode | null;
  last_episode_to_air?: TmdbEpisode | null;
  status?: string;
  seasons?: TmdbSeason[];
  genres?: { id: number }[];
  origin_country?: string[];
  popularity?: number;
}

interface TmdbMovie {
  id: number;
  title?: string;
  poster_path?: string | null;
  release_date?: string | null;
  popularity?: number;
}

/** Résultat de `/discover/movie` ou `/discover/tv` — les deux formes réunies. */
interface TmdbDiscoverResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  genre_ids?: number[];
  origin_country?: string[];
  popularity?: number;
}

/** Identifiants de genres TMDB dont on tire la catégorie d'une sortie. */
const GENRE_ANIMATION = 16;
const GENRE_DOCUMENTARY = 99;
/** Talk-shows et journaux télévisés : du bruit dans un calendrier de sorties. */
const TV_GENRES_EXCLUDED = '10763,10767';

/**
 * Pages de `/discover` parcourues par requête, à vingt résultats la page.
 *
 * Une seule page — l'ancien comportement — plafonnait le mois à vingt films et
 * vingt séries, tous confondus. C'est ce qui donnait un calendrier visiblement
 * incomplet : un mois de sortie normal compte plusieurs centaines de titres, et
 * la coupe tombait avant même les sorties de la deuxième semaine. Quatre pages
 * couvrent largement un mois sans descendre dans des titres que personne ne
 * cherche, la liste étant triée par popularité.
 */
const DISCOVER_PAGES = 4;

/**
 * Pages parcourues pour les requêtes d'appoint (anime, séries en diffusion).
 * Elles complètent la liste principale plutôt qu'elles ne la remplacent.
 */
const DISCOVER_PAGES_SECONDARY = 2;

/**
 * Séries en cours de diffusion dont on va chercher les épisodes. Chacune coûte
 * deux requêtes — la fiche, puis la saison ; au-delà, le mois met trop
 * longtemps à s'afficher pour ce que ça rapporte. Quarante, soit les deux pages
 * de `/discover` : la liste est triée par popularité, et personne ne suit la
 * trois-centième série du moment sans l'avoir mise en watchlist — auquel cas
 * l'autre source la couvre.
 */
const MAX_AIRING_SHOWS = 40;

/**
 * Saisons interrogées par série pour une même fenêtre. Deux suffisent : une
 * fenêtre de six semaines ne chevauche jamais plus d'une fin et d'un début.
 */
const MAX_SEASONS_PER_SHOW = 2;

/**
 * Épisodes retenus par série et par fenêtre. Sans borne, un feuilleton
 * quotidien placerait quarante lignes dans le mois et noierait tout le reste.
 */
const MAX_EPISODES_PER_SHOW = 12;

/**
 * Genres écartés de la diffusion du moment : journaux (10763), talk-shows
 * (10767), téléréalité (10764) et feuilletons quotidiens (10766). Tous
 * diffusent chaque jour ouvré ; les laisser passer reviendrait à remplir le
 * calendrier de bruit. Une série de ces genres suivie en watchlist reste
 * affichée, elle, par sa propre source.
 */
const TV_GENRES_EXCLUDED_AIRING = '10763,10767,10764,10766';

/** Exécute `task` sur chaque élément, `CONCURRENCY` à la fois. */
const mapLimited = async <T, R>(
  items: T[],
  task: (item: T) => Promise<R | null>,
): Promise<R[]> => {
  const results: R[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const result = await task(items[index]);
        if (result !== null && result !== undefined) results.push(result);
      } catch {
        /* un titre en erreur ne retire que lui-même du calendrier */
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
};

/**
 * Requêtes TMDB tombées en erreur depuis le chargement de la page. Sert à
 * distinguer un mois réellement vide d'un mois vidé par une panne : le premier
 * mérite d'être mis en cache, le second surtout pas.
 */
let networkFailures = 0;

/**
 * Volontairement sans `AbortSignal`. Le cache HTTP mutualise les requêtes
 * simultanées vers une même URL : annuler celle d'un mois qu'on vient de
 * quitter ferait échouer celle du mois qu'on vient d'ouvrir si les deux
 * portent sur la même série. Laisser la requête finir remplit le cache, et
 * la page ignore de toute façon le résultat d'une construction périmée.
 */
const tmdbGet = async <T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T | null> => {
  if (!TMDB_API_KEY) return null;
  try {
    const response = await axios.get<T>(`${TMDB_BASE}${path}`, {
      params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), ...params },
    });
    return response.data;
  } catch {
    networkFailures += 1;
    return null;
  }
};

/**
 * Pays des sorties, déduit de la langue TMDB (`fr-FR` → `FR`). Une date de
 * sortie n'a de sens que rapportée à un pays : « Dune 3 » ne sort pas le même
 * jour à Paris et à Los Angeles.
 */
const tmdbRegion = (): string => getTmdbLanguage().split('-')[1] || 'FR';

interface TmdbPage {
  results?: TmdbDiscoverResult[];
  total_pages?: number;
}

/**
 * Une requête `/discover` et ses pages suivantes, rassemblées.
 *
 * La première page est demandée seule : c'est elle qui dit combien il y en a.
 * Les suivantes partent ensuite ensemble, plafonnées par `maxPages` — TMDB
 * annonce volontiers deux cents pages là où le mois n'en vaut que quelques
 * unes. Une page en erreur ne retire que ses propres résultats.
 */
const discoverAll = async (
  path: string,
  params: Record<string, string | number>,
  maxPages: number = DISCOVER_PAGES,
): Promise<TmdbDiscoverResult[]> => {
  const first = await tmdbGet<TmdbPage>(path, { ...params, page: 1 });
  if (!first) return [];

  const pages = Math.min(first.total_pages ?? 1, maxPages);
  if (pages <= 1) return first.results ?? [];

  const rest = await mapLimited(
    Array.from({ length: pages - 1 }, (_, index) => index + 2),
    (page) => tmdbGet<TmdbPage>(path, { ...params, page }),
  );

  return [...(first.results ?? []), ...rest.flatMap((page) => page.results ?? [])];
};

const episodeLabel = (season: number, episode: number): string =>
  `S${season}E${String(episode).padStart(2, '0')}`;

/**
 * Fiches de séries déjà récupérées pendant cette construction. La watchlist et
 * l'historique se recoupent largement : sans ça, une série présente dans les
 * deux serait interrogée deux fois.
 */
type ShowCache = Map<number, Promise<TmdbShow | null>>;

const getShow = (cache: ShowCache, id: number): Promise<TmdbShow | null> => {
  const existing = cache.get(id);
  if (existing) return existing;
  const request = tmdbGet<TmdbShow>(`/tv/${id}`);
  cache.set(id, request);
  return request;
};

/** Une date `YYYY-MM-DD` décalée de `days` jours, toujours en heure locale. */
const shiftDateKey = (key: string, days: number): string => {
  const date = parseDateKey(key);
  if (!date) return key;
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
};

/**
 * Les saisons d'une série susceptibles de diffuser dans la fenêtre.
 *
 * C'était le point aveugle du calendrier : on ne regardait que
 * `next_episode_to_air`, c'est-à-dire le prochain épisode **à partir
 * d'aujourd'hui**. Une série dont la saison est terminée n'avait donc plus rien
 * à afficher, et remonter d'un mois ne montrait jamais les épisodes déjà
 * diffusés — le calendrier ne savait regarder que devant lui.
 *
 * La fiche donne `air_date` et `episode_count` pour chaque saison ; une saison
 * hebdomadaire s'étale sur `episode_count` semaines. L'estimation est
 * volontairement large : se tromper par excès ne coûte qu'une requête, se
 * tromper par défaut fait disparaître des épisodes.
 */
const seasonsInWindow = (show: TmdbShow, fromKey: string, toKey: string): number[] => {
  const numbers = new Set<number>();

  for (const season of show.seasons ?? []) {
    const number = season.season_number;
    // La saison 0 rassemble les hors-série et les making-of. Ils ont des dates
    // erratiques et n'ont rien à faire dans un calendrier de diffusion.
    if (typeof number !== 'number' || number < 1 || !season.air_date) continue;
    const end = shiftDateKey(season.air_date, Math.max(1, season.episode_count ?? 1) * 7);
    if (season.air_date <= toKey && end >= fromKey) numbers.add(number);
  }

  // Filet de sécurité : TMDB laisse parfois la saison en cours sans `air_date`
  // alors que ses épisodes, eux, sont datés.
  for (const episode of [show.last_episode_to_air, show.next_episode_to_air]) {
    if (typeof episode?.season_number !== 'number' || !episode.air_date) continue;
    if (episode.air_date >= shiftDateKey(fromKey, -60) && episode.air_date <= toKey) {
      numbers.add(episode.season_number);
    }
  }

  // Les plus récentes d'abord : quand une série chevauche deux saisons dans la
  // même fenêtre, c'est celle qui commence qui intéresse.
  return [...numbers].sort((a, b) => b - a).slice(0, MAX_SEASONS_PER_SHOW);
};

/**
 * Les épisodes d'une série diffusés dans la fenêtre, saison par saison.
 *
 * Une requête par saison retenue — au plus deux — et rien du tout si aucune
 * saison ne recoupe la fenêtre : une watchlist fournie économise ainsi
 * l'essentiel de ses requêtes.
 */
const episodesOf = async (
  show: TmdbShow,
  fromKey: string,
  toKey: string,
  source: CalendarSource,
  category: CalendarCategory = 'tv',
): Promise<CalendarOccurrence[]> => {
  const seasons = seasonsInWindow(show, fromKey, toKey);
  if (seasons.length === 0) return [];

  const showName = show.name ?? '';
  if (!showName) return [];

  interface WindowEpisode {
    date: string;
    season: number;
    episode: number;
    name?: string;
  }

  const lists = await mapLimited(seasons, async (number) => {
    const season = await tmdbGet<{ episodes?: TmdbEpisode[] }>(`/tv/${show.id}/season/${number}`);
    if (!Array.isArray(season?.episodes)) return null;
    return season.episodes
      .filter((episode): episode is TmdbEpisode & { air_date: string; episode_number: number } =>
        !!episode.air_date && typeof episode.episode_number === 'number'
        && episode.air_date >= fromKey && episode.air_date <= toKey)
      .map((episode): WindowEpisode => ({
        date: episode.air_date,
        season: episode.season_number ?? number,
        episode: episode.episode_number,
        name: episode.name,
      }))
      // Une quotidienne — feuilleton, jeu — remplirait le mois à elle seule.
      // La borne ne gêne aucune série hebdomadaire, qui compte au plus sept
      // épisodes sur une fenêtre de six semaines.
      .slice(0, MAX_EPISODES_PER_SHOW);
  });

  /**
   * Une seule ligne par jour et par saison. Les plateformes lâchent volontiers
   * les premiers épisodes d'un coup — Reacher ouvre sa saison avec trois — et
   * trois lignes identiques au même jour n'apprennent rien de plus qu'une :
   * la ligne fusionnée annonce « S4E01–E03 » et le nombre d'épisodes.
   */
  const byDay = new Map<string, WindowEpisode[]>();
  for (const episode of lists.flat()) {
    const key = `${episode.date}:${episode.season}`;
    const group = byDay.get(key);
    if (group) group.push(episode); else byDay.set(key, [episode]);
  }

  return [...byDay.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.episode - b.episode);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const label = first === last
      ? episodeLabel(first.season, first.episode)
      : `${episodeLabel(first.season, first.episode)}–E${String(last.episode).padStart(2, '0')}`;
    const detail = first === last
      ? first.name
      : i18n.t('calendar.episodeBatch', { count: sorted.length });

    return {
      key: `${source}:tv:${show.id}:${first.season}:${first.episode}-${last.episode}`,
      source,
      category,
      date: first.date,
      title: showName,
      subtitle: detail ? `${label} · ${detail}` : label,
      posterPath: show.poster_path ?? undefined,
      href: `/tv/${encodeId(show.id)}`,
      popularity: show.popularity,
    } satisfies CalendarOccurrence;
  });
};

/**
 * Le seul prochain épisode d'une série, sans requête supplémentaire. Utilisé
 * pour « Reprendre la lecture », où l'on veut seulement savoir quand reprendre :
 * la saison entière relève de la watchlist.
 */
const nextEpisodeOf = (
  show: TmdbShow,
  fromKey: string,
  toKey: string,
  source: CalendarSource,
): CalendarOccurrence[] => {
  const next = show.next_episode_to_air;
  if (!next?.air_date || typeof next.season_number !== 'number') return [];
  if (typeof next.episode_number !== 'number') return [];
  if (next.air_date < fromKey || next.air_date > toKey) return [];

  const label = episodeLabel(next.season_number, next.episode_number);
  return [{
    key: `${source}:tv:${show.id}:${next.season_number}:${next.episode_number}`,
    source,
    category: 'tv',
    date: next.air_date,
    title: show.name ?? '',
    subtitle: next.name ? `${label} · ${next.name}` : label,
    posterPath: show.poster_path ?? undefined,
    href: `/tv/${encodeId(show.id)}`,
    popularity: show.popularity,
  }];
};

/**
 * Catégorie d'une sortie, déduite de ses genres. Sans ça tout tomberait dans
 * « Film » ou « Série », et le filtre par catégorie n'aurait rien à filtrer.
 */
const releaseCategory = (item: TmdbDiscoverResult, media: 'movie' | 'tv'): CalendarCategory => {
  const genres = item.genre_ids ?? [];
  if (genres.includes(GENRE_DOCUMENTARY)) return 'documentary';
  // L'animation seule ne suffit pas : un Pixar n'est pas un anime. C'est le
  // pays d'origine qui tranche.
  if (genres.includes(GENRE_ANIMATION) && (item.origin_country ?? []).includes('JP')) return 'anime';
  return media;
};

/**
 * Vrai si le titre est lisible pour le public du site — écriture latine
 * dominante. TMDB, interrogé en `fr-FR`, retombe sur le titre original quand
 * aucune traduction française n'existe : les sorties régionales sans
 * traduction arrivaient donc en sinogrammes, en thaï ou en coréen. Un titre
 * qu'on ne peut pas lire n'annonce rien — ces entrées sont écartées des
 * sources publiques. Celles que l'utilisateur suit lui-même (watchlist,
 * alertes) ne passent pas par ce filtre : c'est son choix, pas le nôtre.
 *
 * Le seuil à la moitié laisse passer les titres mixtes (« Baki Hanma 2 »)
 * et un titre sans lettres (« 1917 ») est réputé lisible.
 */
const hasLatinTitle = (title: string): boolean => {
  const letters = title.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return true;
  const latin = title.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin * 2 >= letters.length;
};

/** Même déduction, sur une fiche complète : `/tv/{id}` rend des objets, pas des identifiants. */
const showCategory = (show: TmdbShow): CalendarCategory => {
  const genres = (show.genres ?? []).map((genre) => genre.id);
  if (genres.includes(GENRE_DOCUMENTARY)) return 'documentary';
  if (genres.includes(GENRE_ANIMATION) && (show.origin_country ?? []).includes('JP')) return 'anime';
  return 'tv';
};

/**
 * Nature d'une sortie de film. TMDB ne range pas au même endroit la date de
 * salle et la date de plateforme, et les deux comptent : sur un site de
 * streaming, la seconde est même souvent celle qu'on attend.
 *
 * Les valeurs de `with_release_type` : 1 avant-première, 2 salle limitée,
 * 3 salle, 4 numérique, 5 physique, 6 télévision. L'ordre des valeurs compte —
 * TMDB retient la date du **premier** type listé qu'il trouve.
 */
type MovieReleaseKind = 'movie' | 'movieDigital';

/**
 * Les sorties de la fenêtre, telles que TMDB les connaît.
 *
 * C'est la seule source qui ne doit rien à l'utilisateur : elle remplit le
 * calendrier de quelqu'un qui n'a ni watchlist, ni alerte, ni historique — soit
 * tout le monde à la première visite.
 *
 * Cinq requêtes de départ, paginées, plutôt que deux pages uniques :
 *
 *  - les sorties en salle de la région (`release_type=3|2`) ;
 *  - les sorties numériques et physiques de la région (`4|5`) — invisibles
 *    jusqu'ici alors que ce sont celles qui intéressent un site de streaming ;
 *  - les sorties mondiales sans filtre de type, qui rattrapent tout ce qui n'a
 *    aucune date française : films de plateforme, productions étrangères ;
 *  - les nouvelles séries ;
 *  - les nouveaux anime, demandés à part parce qu'ils se font sinon sortir de
 *    la liste par les séries occidentales, mieux notées en popularité.
 */
const newReleasesOf = async (fromKey: string, toKey: string): Promise<CalendarOccurrence[]> => {
  const region = tmdbRegion();
  const common = { sort_by: 'popularity.desc', include_adult: 'false' } as const;

  const [theatrical, digital, worldwide, series, animeSeries] = await Promise.all([
    discoverAll('/discover/movie', {
      'release_date.gte': fromKey,
      'release_date.lte': toKey,
      with_release_type: '3|2',
      region,
      ...common,
    }),
    discoverAll('/discover/movie', {
      'release_date.gte': fromKey,
      'release_date.lte': toKey,
      with_release_type: '4|5',
      region,
      ...common,
    }),
    // Sans `region` ni type : `primary_release_date` est alors la date d'origine
    // du film, la seule connue pour tout ce qui ne sort pas chez nous.
    discoverAll('/discover/movie', {
      'primary_release_date.gte': fromKey,
      'primary_release_date.lte': toKey,
      ...common,
    }),
    discoverAll('/discover/tv', {
      'first_air_date.gte': fromKey,
      'first_air_date.lte': toKey,
      without_genres: TV_GENRES_EXCLUDED,
      ...common,
    }),
    discoverAll('/discover/tv', {
      'first_air_date.gte': fromKey,
      'first_air_date.lte': toKey,
      with_genres: String(GENRE_ANIMATION),
      with_origin_country: 'JP',
      ...common,
    }, DISCOVER_PAGES_SECONDARY),
  ]);

  const buildMovie = (kind: MovieReleaseKind) => (item: TmdbDiscoverResult): CalendarOccurrence | null => {
    const date = item.release_date || '';
    const title = item.title || '';
    // TMDB range parfois une sortie hors de la fenêtre demandée (dates
    // régionales) : on revérifie plutôt que d'afficher un jour qui ne colle pas.
    if (!date || !title || date < fromKey || date > toKey) return null;
    if (!hasLatinTitle(title)) return null;
    return {
      key: `newReleases:movie:${item.id}`,
      source: 'newReleases',
      category: releaseCategory(item, 'movie'),
      date,
      title,
      subtitle: i18n.t(`calendar.newRelease.${kind}`),
      posterPath: item.poster_path ?? undefined,
      href: `/movie/${encodeId(item.id)}`,
      popularity: item.popularity,
    } satisfies CalendarOccurrence;
  };

  const buildShow = (item: TmdbDiscoverResult): CalendarOccurrence | null => {
    const date = item.first_air_date || '';
    const title = item.name || '';
    if (!date || !title || date < fromKey || date > toKey) return null;
    if (!hasLatinTitle(title)) return null;
    return {
      key: `newReleases:tv:${item.id}`,
      source: 'newReleases',
      category: releaseCategory(item, 'tv'),
      date,
      title,
      subtitle: i18n.t('calendar.newRelease.tv'),
      posterPath: item.poster_path ?? undefined,
      href: `/tv/${encodeId(item.id)}`,
      popularity: item.popularity,
    } satisfies CalendarOccurrence;
  };

  /**
   * Un titre ne compte qu'une fois par fenêtre, quelle que soit la requête qui
   * l'a ramené. L'ordre des listes fait la priorité : la salle passe avant le
   * numérique, qui passe avant la date mondiale — un film sorti en salle en
   * mars ne doit pas s'afficher « sortie numérique » parce que la requête
   * suivante connaissait aussi une date ce mois-là.
   */
  const occurrences: CalendarOccurrence[] = [];
  const takenMovies = new Set<number>();
  const takenShows = new Set<number>();

  const collect = (
    items: TmdbDiscoverResult[],
    taken: Set<number>,
    build: (item: TmdbDiscoverResult) => CalendarOccurrence | null,
  ): void => {
    for (const item of items) {
      if (taken.has(item.id)) continue;
      const occurrence = build(item);
      // L'identifiant n'est retenu que si le titre a produit un événement :
      // une date hors fenêtre dans une liste ne doit pas empêcher la suivante
      // de le placer correctement.
      if (!occurrence) continue;
      taken.add(item.id);
      occurrences.push(occurrence);
    }
  };

  collect(theatrical, takenMovies, buildMovie('movie'));
  collect(digital, takenMovies, buildMovie('movieDigital'));
  collect(worldwide, takenMovies, buildMovie('movie'));
  collect(series, takenShows, buildShow);
  collect(animeSeries, takenShows, buildShow);

  return occurrences;
};

/**
 * Les épisodes diffusés dans la fenêtre, séries populaires comprises — même
 * celles que l'utilisateur ne suit pas.
 *
 * C'est le grand absent du calendrier jusqu'ici. `/discover/tv` filtré sur
 * `first_air_date` ne connaît que les séries **nouvelles** : un épisode de
 * milieu de saison — un « Reacher S04E09 » un mardi soir — n'apparaissait nulle
 * part, sauf à avoir la série en watchlist. Un calendrier des sorties qui
 * n'annonce pas l'épisode du soir n'annonce pas grand-chose.
 *
 * TMDB n'expose pas de recherche d'épisodes. Le détour tient en trois temps :
 * `air_date` sur `/discover/tv` donne les séries qui diffusent quelque chose
 * dans la fenêtre, la fiche de chacune donne ses saisons, et la saison donne
 * ses épisodes datés. Les fiches sont mutualisées avec les autres sources
 * (`showCache`) et mises en cache par le cache HTTP : une série déjà vue par la
 * watchlist ne coûte rien de plus ici.
 */
const airingEpisodesOf = async (
  cache: ShowCache,
  fromKey: string,
  toKey: string,
): Promise<CalendarOccurrence[]> => {
  // `/tv/airing_today` et `/tv/on_the_air` couvrent le jour même et la semaine,
  // sans filtre de date à interpréter. Ils servent de garde-fou : le filtre
  // `air_date` de `/discover` est réputé capricieux sur les plages longues, et
  // c'est précisément le jour affiché qu'il ne faut pas rater. Ils ne sont
  // demandés que si la fenêtre contient aujourd'hui — ailleurs, ils
  // rapporteraient des séries hors sujet.
  const now = todayKey();
  const coversToday = now >= fromKey && now <= toKey;

  const [today, week, airing] = await Promise.all([
    coversToday
      ? discoverAll('/tv/airing_today', { region: tmdbRegion() }, 1)
      : Promise.resolve([]),
    coversToday
      ? discoverAll('/tv/on_the_air', { region: tmdbRegion() }, 1)
      : Promise.resolve([]),
    discoverAll('/discover/tv', {
      'air_date.gte': fromKey,
      'air_date.lte': toKey,
      without_genres: TV_GENRES_EXCLUDED_AIRING,
      sort_by: 'popularity.desc',
      include_adult: 'false',
    }, DISCOVER_PAGES_SECONDARY),
  ]);

  // `/tv/airing_today` et `/tv/on_the_air` n'acceptent pas `without_genres` :
  // le tri par genre se fait ici, sur ce que la réponse porte déjà.
  const excluded = new Set(TV_GENRES_EXCLUDED_AIRING.split(',').map(Number));
  const keep = (item: TmdbDiscoverResult): boolean =>
    !(item.genre_ids ?? []).some((genre) => excluded.has(genre));

  /**
   * Les trois listes fusionnées, puis **retriées par popularité** avant d'être
   * coupées. L'ordre d'arrivée ne vaut rien ici : `/tv/airing_today` remonte
   * surtout des quotidiennes internationales, qui épuisaient le plafond avant
   * que la série que tout le monde attend ce soir ait sa chance d'y entrer.
   */
  const candidates = new Map<number, number>();
  for (const item of [...today.filter(keep), ...week.filter(keep), ...airing]) {
    const best = Math.max(candidates.get(item.id) ?? 0, item.popularity ?? 0);
    candidates.set(item.id, best);
  }

  const ids = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_AIRING_SHOWS)
    .map(([id]) => id);

  const perShow = await mapLimited(ids, async (id) => {
    const show = await getShow(cache, id);
    if (!show) return null;
    // Même règle que pour les sorties : une série sans titre lisible n'a rien
    // à faire dans une source que l'utilisateur n'a pas choisie.
    if (!hasLatinTitle(show.name ?? '')) return null;
    return episodesOf(show, fromKey, toKey, 'airingEpisodes', showCategory(show));
  });

  return perShow.flat();
};

export interface BuildCalendarOptions {
  /** `YYYY-MM-DD` inclus. */
  fromKey: string;
  /** `YYYY-MM-DD` inclus. */
  toKey: string;
  /** Sources à interroger. Les autres ne déclenchent aucune requête. */
  sources: CalendarSource[];
}

/** Clé de cache de la fenêtre, langue comprise : les titres en dépendent. */
const windowKey = ({ fromKey, toKey, sources }: BuildCalendarOptions): string =>
  calendarCacheKey(fromKey, toKey, sources, getTmdbLanguage());

/**
 * Fenêtre déjà calculée, lisible sans attendre. La page s'en sert pour afficher
 * un mois déjà vu immédiatement, pendant que la reconstruction éventuelle
 * tourne derrière. `null` si rien n'est en cache — l'écran de chargement n'est
 * montré que dans ce cas.
 */
export const readCachedCalendarOccurrences = (
  options: BuildCalendarOptions,
): CalendarOccurrence[] | null => readCalendarWindow(windowKey(options))?.occurrences ?? null;

/**
 * Rassemble les événements automatiques de la fenêtre demandée. Les entrées
 * personnelles ne passent pas par ici : elles sont développées côté page, sans
 * réseau (voir `utils/calendarEntries.ts`).
 *
 * Une fenêtre encore fraîche est rendue telle quelle, sans la moindre requête.
 */
export const buildCalendarOccurrences = async (
  options: BuildCalendarOptions,
): Promise<CalendarOccurrence[]> => {
  const { fromKey, toKey, sources } = options;
  const cacheKey = windowKey(options);
  const cached = readCalendarWindow(cacheKey);
  if (cached?.fresh) return cached.occurrences;

  const failuresBefore = networkFailures;
  const wanted = new Set(sources);
  const showCache: ShowCache = new Map();
  const collected: CalendarOccurrence[] = [];

  // ── Alertes posées ────────────────────────────────────────────────────────
  // La date de diffusion est déjà en local ; seule l'affiche manque, et sans
  // elle ces lignes étaient les seules de l'agenda à rester grises. La fiche
  // est mutualisée avec les autres sources (`showCache`), donc une série déjà
  // vue ailleurs ne coûte rien.
  if (wanted.has('alerts')) {
    const alerts = Object.values(AlertService.getAllAlerts()).filter((alert) => {
      const date = (alert.airDate || '').slice(0, 10);
      return date && date >= fromKey && date <= toKey;
    });

    const built = await mapLimited(alerts, async (alert) => {
      const show = await getShow(showCache, alert.showId);
      return {
        key: `alerts:${alert.id}`,
        source: 'alerts' as const,
        category: 'tv' as const,
        date: (alert.airDate || '').slice(0, 10),
        title: alert.showName,
        subtitle: alert.episodeName
          ? `${episodeLabel(alert.season, alert.episode)} · ${alert.episodeName}`
          : episodeLabel(alert.season, alert.episode),
        posterPath: show?.poster_path ?? undefined,
        href: `/tv/${encodeId(alert.showId)}`,
        popularity: show?.popularity,
      } satisfies CalendarOccurrence;
    });
    collected.push(...built);
  }

  // ── Séries de la watchlist : tous les épisodes à venir ─────────────────────
  if (wanted.has('watchlistEpisodes')) {
    const shows = readWatchlist('tv').slice(0, MAX_ITEMS_PER_SOURCE);
    const perShow = await mapLimited(shows, async (item) => {
      const show = await getShow(showCache, item.id);
      if (!show) return null;
      return episodesOf(show, fromKey, toKey, 'watchlistEpisodes');
    });
    for (const list of perShow) collected.push(...list);
  }

  // ── Séries en cours : uniquement le prochain épisode ───────────────────────
  // La saison entière relève de la watchlist ; ici on veut juste savoir quand
  // reprendre.
  if (wanted.has('continueWatching')) {
    const history = readContinueWatchingShows().slice(0, MAX_ITEMS_PER_SOURCE);
    const perShow = await mapLimited(history, async (item) => {
      const show = await getShow(showCache, item.id);
      if (!show) return null;
      return nextEpisodeOf(show, fromKey, toKey, 'continueWatching');
    });
    for (const list of perShow) collected.push(...list);
  }

  // ── Films de la watchlist : dates de sortie ────────────────────────────────
  if (wanted.has('watchlistMovies')) {
    const movies = readWatchlist('movie').slice(0, MAX_ITEMS_PER_SOURCE);
    const perMovie = await mapLimited(movies, async (item) => {
      const movie = await tmdbGet<TmdbMovie>(`/movie/${item.id}`);
      const date = movie?.release_date;
      if (!movie || !date || date < fromKey || date > toKey) return null;
      return {
        key: `watchlistMovies:movie:${movie.id}`,
        source: 'watchlistMovies' as const,
        category: 'movie' as const,
        date,
        title: movie.title ?? item.title ?? '',
        posterPath: movie.poster_path ?? item.poster_path ?? undefined,
        href: `/movie/${encodeId(movie.id)}`,
        popularity: movie.popularity,
      } satisfies CalendarOccurrence;
    });
    collected.push(...perMovie);
  }

  // ── Sorties du moment et séries en diffusion ──────────────────────────────
  // En dernier volontairement : le dédoublonnage ci-dessous garde la première
  // occurrence, donc un film déjà présent par la watchlist conserve sa source,
  // et le filtre « ma watchlist » continue de le montrer.
  //
  // Les deux partent ensemble : elles ne partagent que le cache de fiches, et
  // les enchaîner doublerait l'attente du premier affichage.
  const publicSources = await Promise.all([
    wanted.has('newReleases') ? newReleasesOf(fromKey, toKey) : Promise.resolve([]),
    wanted.has('airingEpisodes')
      ? airingEpisodesOf(showCache, fromKey, toKey)
      : Promise.resolve([]),
  ]);
  for (const list of publicSources) collected.push(...list);

  // Un même épisode arrive maintenant par plusieurs chemins — la watchlist, une
  // alerte, et la diffusion du moment qui ignore, elle, ce que suit
  // l'utilisateur. L'identité porte donc sur ce qui s'affiche (jour, série,
  // épisode) et non sur la source : c'est la première rencontrée qui reste, et
  // l'ordre ci-dessus fait foi, pour que le filtre « ma watchlist » continue de
  // montrer ce qui lui appartient.
  //
  // Deuxième règle : une ligne `newReleases` s'efface devant toute autre ligne
  // du même titre le même jour, même quand les sous-titres diffèrent. Sans
  // elle, la première d'une série s'affichait en double — « Nouvelle série »
  // par `/discover`, « S1E01 · Pilote » par la diffusion du moment — et un film
  // suivi en watchlist doublait avec sa ligne « Sortie cinéma ». L'autre ligne
  // dit toujours plus : elle porte l'épisode, ou l'appartenance à la watchlist.
  const claimedDays = new Set<string>();
  for (const occurrence of collected) {
    if (occurrence.source !== 'newReleases') {
      claimedDays.add(`${occurrence.date}|${occurrence.title}`);
    }
  }

  const seen = new Set<string>();
  const occurrences = collected.filter((occurrence) => {
    const day = `${occurrence.date}|${occurrence.title}`;
    if (occurrence.source === 'newReleases' && claimedDays.has(day)) return false;

    const identity = `${day}|${occurrence.subtitle ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  // Seule une construction complète est figée. Sans clé TMDB, ou dès qu'une
  // requête a échoué, le résultat est lacunaire : le garder une demi-heure
  // afficherait un mois troué alors que le réseau est revenu.
  if (TMDB_API_KEY && networkFailures === failuresBefore) {
    writeCalendarWindow(cacheKey, occurrences);
  }
  return occurrences;
};

/** Fenêtre couvrant le mois affiché, débords compris, pour la grille. */
export const monthWindow = (year: number, month: number): { fromKey: string; toKey: string } => ({
  fromKey: toDateKey(new Date(year, month, 1 - 7)),
  toKey: toDateKey(new Date(year, month + 1, 7)),
});
