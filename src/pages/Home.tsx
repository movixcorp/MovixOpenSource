import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios, { CancelTokenSource } from 'axios';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Info, Star, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import HeroSkeleton from '../components/skeletons/HeroSkeleton';
import ContentRowSkeleton from '../components/skeletons/ContentRowSkeleton';

import TelegramPromotion from '../components/TelegramPromotion';
import HeroSlider from '../components/HeroSlider';
import EmblaCarousel from '../components/EmblaCarousel';
import EmblaCarouselPlatforms from '../components/EmblaCarouselPlatforms';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import LazySection from '../components/LazySection';
import { SquareBackground } from '../components/ui/square-background';
import { SITE_URL } from '../config/runtime';
import { getTmdbLanguage } from '../i18n';
import { encodeId } from '../utils/idEncoder';
import { getPersonalizedRecommendations, isRecommendationsEnabled, PersonalizedRecommendations } from '../services/recommendationService';
import CarouselTitle from '../components/CarouselTitle';
import ConfirmDialog from '../components/ui/confirm-dialog';

// Nombre de sections à charger immédiatement (les premières sont prioritaires)
const IMMEDIATE_LOAD_COUNT = 3;

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// Cache mémoire pour les détails TMDB (movie/tv par id) — persiste entre les navigations SPA,
// hydraté depuis sessionStorage pour survivre aux rechargements (F5) — perf
const tmdbDetailsCache = new Map<string, { data: any; ts: number }>();
const TMDB_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const TMDB_DETAILS_STORAGE_KEY = 'movix_tmdb_details_cache_v1';
const TMDB_DETAILS_MAX_ENTRIES = 300;
let tmdbCacheHydrated = false;
let tmdbCachePersistTimer: ReturnType<typeof setTimeout> | null = null;

const getHomeCacheKeys = (language: string) => {
  const suffix = language.toLowerCase();
  return {
    data: `movix_home_data_${suffix}`,
    timestamp: `movix_home_data_${suffix}_timestamp`,
  };
};

const hydrateTmdbDetailsCache = () => {
  if (tmdbCacheHydrated) return;
  tmdbCacheHydrated = true;
  try {
    const raw = sessionStorage.getItem(TMDB_DETAILS_STORAGE_KEY);
    if (!raw) return;
    const entries: [string, { data: unknown; ts: number }][] = JSON.parse(raw);
    const now = Date.now();
    entries.forEach(([key, value]) => {
      if (value && now - value.ts < TMDB_CACHE_TTL) {
        tmdbDetailsCache.set(key, value);
      }
    });
  } catch {
    // Cache best-effort : une entrée corrompue ne doit pas casser la Home
  }
};

// Persistance débouncée pour éviter un JSON.stringify complet à chaque entrée ajoutée
const scheduleTmdbCachePersist = () => {
  if (tmdbCachePersistTimer) clearTimeout(tmdbCachePersistTimer);
  tmdbCachePersistTimer = setTimeout(() => {
    tmdbCachePersistTimer = null;
    try {
      const entries = Array.from(tmdbDetailsCache.entries()).slice(-TMDB_DETAILS_MAX_ENTRIES);
      sessionStorage.setItem(TMDB_DETAILS_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Quota plein : cache best-effort
    }
  }, 500);
};

const fetchTMDBDetails = async (
  mediaType: string,
  id: number,
  params?: any,
  language = getTmdbLanguage(),
): Promise<any> => {
  hydrateTmdbDetailsCache();
  const key = `${language}_${mediaType}_${id}`;
  const cached = tmdbDetailsCache.get(key);
  if (cached && Date.now() - cached.ts < TMDB_CACHE_TTL) {
    return cached.data;
  }
  const endpoint = `https://api.themoviedb.org/3/${mediaType}/${id}`;
  const response = await axios.get(endpoint, {
    params: { api_key: TMDB_API_KEY, language, ...params }
  });
  tmdbDetailsCache.set(key, { data: response.data, ts: Date.now() });
  scheduleTmdbCachePersist();
  return response.data;
};

// Styles nécessaires aux EmblaCarousel rendus dans Home
const homeStyles = `
/* ── Rythme vertical des rangées ────────────────────────────────────────────
   Un seul écart, défini une seule fois.

   Avant, chaque section empilait ses propres \`mt-16\` / \`mb-16\` par-dessus
   les marges de \`.content-row-container\` — comptées deux fois, la rangée
   interne d'EmblaCarousel portant la même classe que son conteneur — le tout
   rattrapé par une marge négative de -30px. Selon la section, l'écart réel
   allait de quelques pixels à plus de deux cents, d'où les séparations tantôt
   inexistantes tantôt énormes. Désormais \`.content-row-container\` n'a plus
   aucun espacement vertical : tout passe par \`.home-section\`.            */
.home-section {
  /* L'écart réel entre deux rangées vaut cette marge PLUS le \`mb-4\` (16px) de
     la rangée d'EmblaCarousel, soit 64px : les deux ne fusionnent pas, parce
     que LazySection pose \`contain: layout\` et coupe donc la fusion des marges
     entre la rangée et son conteneur. Les écarts allaient de 54 à 152px avant,
     64 reste dans cette fourchette sans rien resserrer brutalement. */
  margin-top: 3rem;
}

/* Un écart lu sur un écran de bureau et sur un téléphone n'a pas le même
   poids : 48px valent 4 % de la hauteur d'une fenêtre de 1080px, mais 7 % des
   ~670px utiles d'un mobile une fois les barres du navigateur déduites. Sur
   une page qui n'est qu'une pile de rangées, l'écart se paie donc en contenu
   visible. L'échelle descend par paliers plutôt que de garder la valeur du
   bureau.

   Rien que des \`@media (max-width)\` sur \`margin\` : ni \`clamp()\`, ni requêtes
   de conteneur, ni \`dvh\` — les anciens WebKit d'iOS et les WebView Android
   d'origine les interprètent tous. Un moteur qui ignorerait ces blocs
   retomberait simplement sur les 3rem du bureau, jamais sur une page cassée. */
@media (max-width: 900px) {
  .home-section {
    margin-top: 2.25rem;
  }
}

@media (max-width: 640px) {
  .home-section {
    margin-top: 1rem;
  }

  /* La rangée d'EmblaCarousel porte \`mb-4\` (16px) qui s'ajoute à la marge
     ci-dessus — \`contain: layout\` sur LazySection empêche les deux de
     fusionner. Les resserrer ensemble donne 24px d'écart réel au lieu de 48,
     soit la moitié, sans toucher au \`mb-4\` d'origine : la règle est portée
     par \`.home-section\`, donc Films, Animés et les pages fournisseur, qui
     réutilisent le même carrousel, gardent leur espacement.

     24px reste au-dessus des 16px qui séparent deux cartes voisines dans une
     rangée : en descendant plus bas, l'écart entre deux rangées deviendrait
     plus petit que l'écart à l'intérieur d'une rangée, et la page se lirait
     comme une grille continue plutôt que comme des sections. */
  .home-section .content-row-container {
    margin-bottom: 0.5rem;
  }
}

/* Ne reste ici que le rôle structurel : laisser les cartes déborder (ombres,
   agrandissement au survol) sans que le conteneur les rogne. */
.content-row-container {
  overflow: visible !important;
  position: relative;
  z-index: 1;
}

.section-title {
  font-size: 1.5rem;
  font-weight: 700;
  position: relative;
  background: linear-gradient(90deg, #ffffff, #e2e2e2);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0px 2px 4px rgba(0, 0, 0, 0.3);
  letter-spacing: 0.5px;
  padding-bottom: 0.5rem;
  text-transform: uppercase;
  display: inline-block;
  animation: homeFadeInTitle 0.8s ease-out forwards;
  /* Ciblé plutôt que \`all\` : le dégradé de fond n'a rien à faire dans une
     transition — il est découpé sur le texte et son interpolation coûte un
     repaint à chaque frame. */
  transition: transform 0.3s ease, text-shadow 0.3s ease;
}

.section-title:hover {
  background: linear-gradient(90deg, #ff3333, #ff9999);
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(-2px);
  text-shadow: 0px 4px 8px rgba(255, 51, 51, 0.4);
}

.section-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 40px;
  height: 3px;
  background: linear-gradient(90deg, #f11 0%, #f66 100%);
  border-radius: 3px;
  transform-origin: left;
  /* \`backwards\` et non \`forwards\`. Une valeur figée par une animation
     l'emporte sur toute règle normale, survol compris : le trait restait
     bloqué à 40px une fois l'animation finie, mais s'étirait si on passait la
     souris pendant le délai de 0.3s. D'où un comportement qui dépendait du
     moment. \`backwards\` ne tient que l'état de départ pendant le délai,
     puis rend la main aux règles CSS.                                      */
  animation: homeExpandWidth 0.6s ease-out 0.3s backwards;
  transition: width 0.3s ease, background 0.3s ease;
}

.section-title:hover::after {
  /* Borné. \`width: 100%\` se rapportait à la largeur du titre : sur
     « PARCE QUE VOUS AVEZ REGARDÉ … » en capitales, le trait devenait une
     barre rouge démesurée. */
  width: 72px;
  background: linear-gradient(90deg, #ff3333, #ff9999);
}

@keyframes homeFadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes homeExpandWidth {
  0% { width: 0; }
  100% { width: 40px; }
}
`;


interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  media_type: 'movie' | 'tv';
  genre_ids?: number[];
}

const SCHEDULED_HOME_MOVIE_ID = 1744462;
// Visible jusqu'au 28 août 2026 inclus, heure de Paris.
const SCHEDULED_HOME_MOVIE_END_AT = Date.parse('2026-08-29T00:00:00+02:00');

const getHomeHeroItems = (items: Media[], announcement: string): Media[] => {
  const regularItems = items.filter(
    item => !(item.id === SCHEDULED_HOME_MOVIE_ID && item.media_type === 'movie')
  );

  if (Date.now() >= SCHEDULED_HOME_MOVIE_END_AT) {
    return regularItems.slice(0, 5);
  }

  const scheduledMovie: Media = {
    id: SCHEDULED_HOME_MOVIE_ID,
    title: 'Grand Theft Auto VI: An Extended Look',
    poster_path: '/nNYOsrgnIuoZcxXprHJRh5l7y5g.jpg',
    backdrop_path: '/oDp9Yvvi2mRHXxPh6E2wi9ybhtK.jpg',
    overview: announcement,
    vote_average: 0,
    release_date: '2026-08-27',
    media_type: 'movie',
  };

  return [scheduledMovie, ...regularItems].slice(0, 5);
};

interface Category {
  id: string;
  title: string;
  items: Media[];
}






interface ContinueWatching {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  media_type: 'movie' | 'tv';
  progress?: number;
  lastAccessed: string; // Changed from lastWatched to lastAccessed
  overview?: string;
  backdrop_path?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  currentEpisode?: {
    season: number;
    episode: number;
  };
}

type ContinueWatchingRemoval =
  | { type: 'item'; itemId: number; mediaType: 'movie' | 'tv' }
  | { type: 'all' };

const inferHomeMediaType = (item: any): 'tv' | 'movie' =>
  item.media_type || item.mediaType || (item.first_air_date ? 'tv' : 'movie');

const normalizeHomeItem = (item: any) => ({
  ...item,
  media_type: inferHomeMediaType(item),
  poster_path: item.poster_path || item.posterPath || '',
  backdrop_path: item.backdrop_path || item.backdropPath || '',
  overview: item.overview || '',
  title: item.title || item.name || '',
});

const normalizeHomeCategory = (category: Category): Category => ({
  ...category,
  items: category.items.map(normalizeHomeItem) as any,
});

const normalizePersonalizedReco = (reco: PersonalizedRecommendations | null): PersonalizedRecommendations | null => {
  if (!reco) return reco;
  return {
    ...reco,
    becauseYouWatched: (reco.becauseYouWatched || []).map((g: any) => ({
      ...g,
      items: (g.items || []).map(normalizeHomeItem),
    })),
    topGenres: (reco.topGenres || []).map((g: any) => ({
      ...g,
      items: (g.items || []).map(normalizeHomeItem),
    })),
    usersAlsoWatched: (reco.usersAlsoWatched || []).map(normalizeHomeItem),
    trendingForYou: (reco.trendingForYou || []).map(normalizeHomeItem),
  } as any;
};

const Home: React.FC = () => {
  const { t } = useTranslation();
  const tmdbLanguage = getTmdbLanguage();
  const [loading, setLoading] = useState(true);
  const [heroItems, setHeroItems] = useState<Media[]>([]);
  const [trending, setTrending] = useState<Media[]>([]);
  const [popularMovies, setPopularMovies] = useState<Media[]>([]);
  const [topContent, setTopContent] = useState<Media[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [sagaCollections, setSagaCollections] = useState<any[]>([]);
  const [featuredSeries, setFeaturedSeries] = useState<any>(null);
  const [streamingPlatformsHidden, setStreamingPlatformsHidden] = useState(() => {
    return localStorage.getItem('settings_hide_streaming_platforms') === 'true';
  });

  const [continueWatching, setContinueWatching] = useState<ContinueWatching[]>([]);
  const [continueWatchingRemoval, setContinueWatchingRemoval] = useState<ContinueWatchingRemoval | null>(null);
  const [recommendations, setRecommendations] = useState<Media[]>([]);
  const [personalizedReco, setPersonalizedReco] = useState<PersonalizedRecommendations | null>(null);
  const cancelTokenSourceRef = useRef<CancelTokenSource | null>(null);

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'home' },
  });

  useEffect(() => {
    const syncStreamingPlatformsVisibility = () => {
      setStreamingPlatformsHidden(localStorage.getItem('settings_hide_streaming_platforms') === 'true');
    };
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'settings_hide_streaming_platforms') {
        syncStreamingPlatformsVisibility();
      }
    };

    window.addEventListener('streaming_platforms_visibility_changed', syncStreamingPlatformsVisibility);
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('streaming_platforms_visibility_changed', syncStreamingPlatformsVisibility);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);





  const fetchRecommendations = async (watchHistory: ContinueWatching[]) => {
    if (!isRecommendationsEnabled()) {
      setRecommendations([]);
      setPersonalizedReco(null);
      return;
    }

    const token = localStorage.getItem('auth_token');
    const profileData = localStorage.getItem('auth');
    let profileId: string | null = null;
    if (profileData) {
      try {
        const parsed = JSON.parse(profileData);
        profileId = parsed?.selectedProfileId || parsed?.userProfile?.id || null;
      } catch {}
    }

    if (token && profileId) {
      const lang = getTmdbLanguage();
      const reco = await getPersonalizedRecommendations(profileId, lang);
      const normalizedReco = normalizePersonalizedReco(reco);
      setPersonalizedReco(normalizedReco);
      setRecommendations((normalizedReco?.trendingForYou || []) as any[]);
    } else {
      setRecommendations([]);
      setPersonalizedReco(null);
    }
  };

  const fetchData = async () => {
    if (cancelTokenSourceRef.current) {
      cancelTokenSourceRef.current.cancel("Operation canceled due to new request.");
    }
    cancelTokenSourceRef.current = axios.CancelToken.source();
    const cancelToken = cancelTokenSourceRef.current.token;

    try {
      setLoading(true);

      // Check for cached data first — localStorage pour survivre aux F5/nouveaux onglets (perf)
      const homeCacheKeys = getHomeCacheKeys(tmdbLanguage);
      const cachedData = localStorage.getItem(homeCacheKeys.data);
      const cacheTimestamp = localStorage.getItem(homeCacheKeys.timestamp);

      // Use cache if it exists and is less than 15 minutes old
      if (cachedData && cacheTimestamp) {
        const isRecent = (Date.now() - parseInt(cacheTimestamp)) < 15 * 60 * 1000; // 15 minutes

        if (isRecent) {
          const parsedData = JSON.parse(cachedData);
          setHeroItems(getHomeHeroItems(
            parsedData.heroItems || [],
            t('home.hero.specialEventAnnouncement'),
          ));
          setTrending(parsedData.trending || []);
          setPopularMovies(parsedData.popularMovies || []);

          // Set topContent from cache or use trending as fallback
          const cachedTopContent = parsedData.topContent || [];
          const topContentFromCache = cachedTopContent.length > 0
            ? cachedTopContent
            : (parsedData.trending || []).filter((item: Media) => item.poster_path && item.overview).slice(0, 10);
          setTopContent((topContentFromCache || []).map(normalizeHomeItem) as any);

          organizeContentByCategories(parsedData.allItems || []);
          setLoading(false);

          // Recommendations are fetched by loadContinueWatching
          return;
        }
      }

      // Split API requests into batches to prevent overwhelming the browser
      const batch1 = [
        { url: 'https://api.themoviedb.org/3/trending/all/day', params: { api_key: TMDB_API_KEY, language: tmdbLanguage } },
        { url: 'https://api.themoviedb.org/3/movie/popular', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, page: 1 } },
        { url: 'https://api.themoviedb.org/3/tv/popular', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, page: 1 } },
      ];

      const batch2 = [
        { url: 'https://api.themoviedb.org/3/movie/upcoming', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, page: 1 } },
        { url: 'https://api.themoviedb.org/3/movie/top_rated', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, page: 1 } },
        { url: 'https://api.themoviedb.org/3/tv/top_rated', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, page: 1 } },
      ];

      const batch3 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '28', page: 1 } }, // Action Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '10759', page: 1 } }, // Action & Adventure TV
      ];

      const batch4 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '16', page: 1 } }, // Animation Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '16', page: 1 } }, // Animation TV
      ];

      const batch5 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '35', page: 1 } }, // Comedy Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: tmdbLanguage, with_genres: '35', page: 1 } }, // Comedy TV
      ];

      // Helper function to process batch
      const processBatch = async (batch: { url: string; params: any }[]) => {
        try {
          if (cancelTokenSourceRef.current === null) return []; // If cancelled during processing

          const responses = await Promise.all(
            batch.map(req =>
              axios.get(req.url, { params: req.params, cancelToken })
                .catch(error => {
                  if (axios.isCancel(error)) {
                    console.log('Request canceled:', error.message);
                  } else {
                    console.error(`Error fetching ${req.url}:`, error);
                  }
                  return null;
                })
            )
          );

          return responses.filter(res => res !== null);
        } catch (error) {
          console.error('Error processing batch:', error);
          return [];
        }
      };

      // Tous les batches partent en parallèle (perf : supprime le waterfall batch1 → batch2-5) ;
      // batch1 est traité dès qu'il arrive pour la mise à jour progressive du hero/trending.
      const batch1Promise = processBatch(batch1);
      const remainingBatchesPromise = Promise.all([
        processBatch(batch2),
        processBatch(batch3),
        processBatch(batch4),
        processBatch(batch5)
      ]);

      const batch1Responses = await batch1Promise;
      if (batch1Responses.length === 0) {
        setLoading(false);
        return;
      }

      // Set initial data from first batch to improve perceived performance
      const processTMDBResponses = (responses: any[], mediaType: 'movie' | 'tv' | 'all') => {
        return responses.flatMap(response =>
          response.data.results
            .filter((item: any) =>
              item.poster_path &&
              item.overview &&
              item.overview.trim() !== ''
            )
            .map((item: any) => ({
              ...item,
              media_type: mediaType === 'all' ? item.media_type || (item.first_air_date ? 'tv' : 'movie') : mediaType
            }))
        );
      };

      const trendingItems = processTMDBResponses(batch1Responses[0] ? [batch1Responses[0]] : [], 'all');
      const popularMovies = processTMDBResponses(batch1Responses[1] ? [batch1Responses[1]] : [], 'movie');
      const popularTV = processTMDBResponses(batch1Responses[2] ? [batch1Responses[2]] : [], 'tv');

      // Update UI with initial data
      setTrending(trendingItems);
      setPopularMovies(popularMovies);
      setHeroItems(getHomeHeroItems(
        trendingItems,
        t('home.hero.specialEventAnnouncement'),
      ));

      // Les batches restants ont été lancés en même temps que batch1
      const [batch2Responses, batch3Responses, batch4Responses, batch5Responses] = await remainingBatchesPromise;

      // Process all responses
      const upcomingMovies = batch2Responses[0] ? processTMDBResponses([batch2Responses[0]], 'movie') : [];
      const topRatedMovies = batch2Responses[1] ? processTMDBResponses([batch2Responses[1]], 'movie') : [];
      const topRatedTV = batch2Responses[2] ? processTMDBResponses([batch2Responses[2]], 'tv') : [];

      const actionMovies = batch3Responses[0] ? processTMDBResponses([batch3Responses[0]], 'movie') : [];
      const actionTV = batch3Responses[1] ? processTMDBResponses([batch3Responses[1]], 'tv') : [];

      const animationMovies = batch4Responses[0] ? processTMDBResponses([batch4Responses[0]], 'movie') : [];
      const animationTV = batch4Responses[1] ? processTMDBResponses([batch4Responses[1]], 'tv') : [];

      const comedyMovies = batch5Responses[0] ? processTMDBResponses([batch5Responses[0]], 'movie') : [];
      const comedyTV = batch5Responses[1] ? processTMDBResponses([batch5Responses[1]], 'tv') : [];

      // Combine and deduplicate all items
      const allItems = [
        ...trendingItems,
        ...popularMovies,
        ...popularTV,
        ...upcomingMovies,
        ...topRatedMovies,
        ...topRatedTV,
        ...actionMovies,
        ...actionTV,
        ...animationMovies,
        ...animationTV,
        ...comedyMovies,
        ...comedyTV
      ];

      // Déduplication en O(n) via Map (l'ancien reduce + find était O(n²)) — perf
      const uniqueItemsMap = new Map<string, Media>();
      for (const current of allItems) {
        const key = `${current.media_type}_${current.id}`;
        if (!uniqueItemsMap.has(key)) {
          uniqueItemsMap.set(key, current);
        }
      }
      const uniqueItems = Array.from(uniqueItemsMap.values());

      // Filter items with overview and poster_path for categories
      const filteredItems = uniqueItems.filter((item: Media) => item.overview && item.poster_path);

      // Update state with all data
      const homeHeroItems = getHomeHeroItems(
        filteredItems,
        t('home.hero.specialEventAnnouncement'),
      );
      setHeroItems(homeHeroItems);
      setTrending(filteredItems.slice(5));
      setPopularMovies(popularMovies);

      // Set topContent - use upcomingMovies if available, otherwise use trending as fallback
      const topContentData = upcomingMovies.length > 0
        ? upcomingMovies.slice(0, 10)
        : trendingItems.filter((item: Media) => item.poster_path && item.overview).slice(0, 10);
      setTopContent((topContentData || []).map(normalizeHomeItem) as any);
      console.log('Top content loaded:', topContentData.length, 'items');

      // Cache the data
      const cacheData = {
        heroItems: filteredItems.slice(0, 5),
        trending: filteredItems.slice(5),
        popularMovies,
        topRatedMovies,
        topRatedTVShows: topRatedTV,
        popularTVShows: popularTV,
        topContent: upcomingMovies.length > 0
          ? upcomingMovies.slice(0, 10)
          : trendingItems.filter((item: Media) => item.poster_path && item.overview).slice(0, 10),
        allItems: filteredItems
      };

      // Écriture du cache différée à l'idle : le JSON.stringify d'un gros corpus est synchrone
      // et n'a pas besoin de bloquer l'affichage du contenu (perf)
      const persistHomeCache = () => {
        try {
          localStorage.setItem(homeCacheKeys.data, JSON.stringify(cacheData));
          localStorage.setItem(homeCacheKeys.timestamp, Date.now().toString());
        } catch {
          // Quota plein : cache best-effort, la page fonctionne sans
        }
      };
      if ('requestIdleCallback' in window) {
        (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(persistHomeCache);
      } else {
        setTimeout(persistHomeCache, 200);
      }

      // Organize content into categories
      organizeContentByCategories(filteredItems);

      // Recommendations are fetched by loadContinueWatching

    } catch (error) {
      if (axios.isCancel(error)) {
        console.log('Data fetching canceled:', error.message);
      } else {
        console.error('Error fetching data:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  // Fetch curated TMDB collections for the "Les sagas incontournables" section
  // Déclenché par le LazySection de la section (onLoad) et non plus au mount de Home :
  // ça retire 20 requêtes TMDB du chargement initial (perf)
  const fetchSagaCollections = useCallback(async () => {
    try {
      const cacheKey = `movix_sagas_data_${tmdbLanguage.toLowerCase()}`;
      const cacheTsKey = `movix_sagas_data_${tmdbLanguage.toLowerCase()}_ts`;
      const cached = localStorage.getItem(cacheKey);
      const cachedTs = localStorage.getItem(cacheTsKey);
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (cached && cachedTs && (Date.now() - parseInt(cachedTs)) < oneDayMs) {
        setSagaCollections(JSON.parse(cached));
        return;
      }

      const popularCollectionIds = [
        10,      // Star Wars
        1241,    // Harry Potter
        531241,  // Spider-Man (Avengers)
        623,     // X-Men
        2344,    // The Matrix
        8091,    // Alien
        8250,    // Fast & Furious
        9485,    // The Fast and the Furious
        86311,   // The Avengers
        131295,  // Iron Man
        131296,  // Thor
        131292,  // Captain America
        748,     // The Lord of the Rings
        121938,  // The Hobbit
        1570,    // Die Hard
        528,     // The Terminator
        945,     // Jurassic Park
        295,     // Pirates of the Caribbean
        87359,   // Mission: Impossible
        8917     // Shrek
      ];

      const responses = await Promise.all(
        popularCollectionIds.map(id =>
          axios.get(`https://api.themoviedb.org/3/collection/${id}`, {
            params: { api_key: TMDB_API_KEY, language: tmdbLanguage }
          }).then(r => r.data).catch(() => null)
        )
      );

      const mapped = responses
        .filter(Boolean)
        .map((c: any) => {
          const poster = c.poster_path || (c.parts?.find((p: any) => p.poster_path)?.poster_path) || null;
          if (!poster) return null;
          const avg = c.parts && c.parts.length > 0
            ? Number((c.parts.reduce((s: number, m: any) => s + (m.vote_average || 0), 0) / c.parts.length).toFixed(1))
            : undefined;
          return {
            id: c.id,
            title: c.name,
            name: c.name,
            poster_path: poster,
            backdrop_path: c.backdrop_path || (c.parts?.[0]?.backdrop_path || null),
            overview: c.overview || '',
            vote_average: avg,
            media_type: 'collection'
          };
        })
        .filter(Boolean)
        .slice(0, 20);

      setSagaCollections(mapped as any[]);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(mapped));
        localStorage.setItem(cacheTsKey, Date.now().toString());
      } catch {
        // Quota plein : cache best-effort
      }
    } catch (e) {
      // Fail silently; the rest of the home page still works
    }
  }, [tmdbLanguage]);

  useEffect(() => {
    fetchData();

    // Cleanup function to cancel request on component unmount
    return () => {
      if (cancelTokenSourceRef.current) {
        cancelTokenSourceRef.current.cancel("Operation canceled due to component unmount.");
        cancelTokenSourceRef.current = null;
      }
    };
  }, [tmdbLanguage]);

  useEffect(() => {
    const remainingTime = SCHEDULED_HOME_MOVIE_END_AT - Date.now();
    if (remainingTime <= 0) return;

    const expirationTimer = window.setTimeout(() => {
      setHeroItems(currentItems => getHomeHeroItems(
        currentItems,
        t('home.hero.specialEventAnnouncement'),
      ));
    }, remainingTime);

    return () => window.clearTimeout(expirationTimer);
  }, [t]);

  // Fetch featured series (team selection) — différé via le LazySection de la section (perf)
  const fetchFeaturedSeries = useCallback(async () => {
    try {
      const data = await fetchTMDBDetails(
        'tv',
        215160,
        { append_to_response: 'content_ratings' },
        tmdbLanguage,
      );
      setFeaturedSeries(data);
    } catch (error) {
      console.error('Error fetching featured series:', error);
    }
  }, [tmdbLanguage]);

  useEffect(() => {
    const loadContinueWatching = async () => {
      try {
        const savedItems = localStorage.getItem('continueWatching');
        if (savedItems) {
          // Check if we need to migrate from old format to new format
          let migratedData: { movies: any[], tv: any[] };

          try {
            const parsedData = JSON.parse(savedItems);

            // Check if old format (array) vs new format (object with movies/tv properties)
            if (Array.isArray(parsedData)) {
              migratedData = { movies: [], tv: [] };
              parsedData.forEach((item: any) => {
                if (item.media_type === 'movie') {
                  migratedData.movies.push({ id: item.id, lastAccessed: new Date().toISOString() });
                } else if (item.media_type === 'tv') {
                  migratedData.tv.push({ id: item.id, currentEpisode: item.currentEpisode, lastAccessed: new Date().toISOString() });
                }
              });
              localStorage.setItem('continueWatching', JSON.stringify(migratedData));
            } else {
              migratedData = parsedData;

              // Migrate old format movies to new format
              if (migratedData.movies && Array.isArray(migratedData.movies)) {
                let needsUpdate = false;
                const updatedMovies = migratedData.movies.map((movieItem: any, index: number) => {
                  if (typeof movieItem === 'number') {
                    needsUpdate = true;
                    const now = new Date();
                    const olderTime = new Date(now.getTime() - (index * 60000));
                    return { id: movieItem, lastAccessed: olderTime.toISOString() };
                  }
                  return movieItem;
                });

                if (needsUpdate) {
                  migratedData.movies = updatedMovies;
                  localStorage.setItem('continueWatching', JSON.stringify(migratedData));
                }
              }
            }
          } catch (error) {
            console.error('Error parsing continueWatching data:', error);
            migratedData = { movies: [], tv: [] };
            localStorage.setItem('continueWatching', JSON.stringify(migratedData));
          }

          // Process with the new data structure
          const data = migratedData;
          const allItems: any[] = [];

          if (data.movies && Array.isArray(data.movies)) {
            for (const movieItem of data.movies) {
              allItems.push({ id: movieItem.id, media_type: 'movie', lastAccessed: movieItem.lastAccessed });
            }
          }

          if (data.tv && Array.isArray(data.tv)) {
            for (const tvShow of data.tv) {
              const lastAccessed = tvShow.lastAccessed || '1970-01-01T00:00:00.000Z';
              allItems.push({ id: tvShow.id, media_type: 'tv', currentEpisode: tvShow.currentEpisode, lastAccessed });
            }
          }

          // Sort by lastAccessed timestamp (most recent first)
          const ts = (d: any) => {
            const t = Date.parse(d || '');
            return Number.isFinite(t) ? t : 0;
          };
          allItems.sort((a, b) => ts(b.lastAccessed) - ts(a.lastAccessed));

          // Fetch TMDB data for each item (uses in-memory cache)
          const enrichedItems = await Promise.all(
            allItems.map(async (item: any) => {
              try {
                const tmdbData = await fetchTMDBDetails(item.media_type, item.id);

                const enrichedItem: ContinueWatching = {
                  id: item.id,
                  media_type: item.media_type,
                  title: tmdbData.title || tmdbData.name || undefined,
                  name: tmdbData.name || undefined,
                  poster_path: tmdbData.poster_path || '',
                  backdrop_path: tmdbData.backdrop_path || undefined,
                  overview: tmdbData.overview || undefined,
                  vote_average: tmdbData.vote_average || undefined,
                  release_date: tmdbData.release_date || undefined,
                  first_air_date: tmdbData.first_air_date || undefined,
                  currentEpisode: item.currentEpisode,
                  lastAccessed: item.lastAccessed
                };
                return enrichedItem;
              } catch (error) {
                console.error(`Error fetching TMDB data for ${item.media_type} ${item.id}:`, error);
                return null;
              }
            })
          );

          // Filter out failed items and items without poster_path
          const validItems = enrichedItems
            .filter((item): item is ContinueWatching => item !== null)
            .filter((item) => item.poster_path && typeof item.poster_path === 'string' && item.poster_path.trim() !== '');
          setContinueWatching((validItems || []).map(normalizeHomeItem) as any);

          if (validItems.length > 0) {
            await fetchRecommendations(validItems);
          }
        } else {
          setContinueWatching([]);
        }
      } catch (error) {
        console.error('Error loading continue watching items:', error);
        setContinueWatching([]);
      }
    };

    loadContinueWatching();
    // Home n'est monté que sur "/" : un changement de route le démonte de toute façon,
    // donc dépendre de location.pathname ne faisait que risquer des relances inutiles (perf)
  }, [tmdbLanguage]);

  // NOTE perf : l'ancien setInterval de rotation du hero a été supprimé — il pilotait un state
  // (currentHeroIndex) utilisé nulle part et re-rendait tout Home toutes les 6s.
  // HeroSlider gère déjà son propre autoplay en interne.



  // Organize content by genres
  const organizeContentByCategories = (items: Media[]) => {
    const categoriesMap: { [key: string]: Media[] } = {};
    // Set d'ids par genre pour une déduplication en O(1) (l'ancien .some() était O(n²)) — perf
    const seenIdsByGenre: { [key: string]: Set<number> } = {};

    // 1. Group by genre
    items.forEach(item => {
      if (item.genre_ids && item.genre_ids.length > 0) {
        item.genre_ids.forEach(genreId => {
          if (!categoriesMap[genreId]) {
            categoriesMap[genreId] = [];
            seenIdsByGenre[genreId] = new Set();
          }
          // Only add if not already in the array
          if (!seenIdsByGenre[genreId].has(item.id)) {
            seenIdsByGenre[genreId].add(item.id);
            categoriesMap[genreId].push(item);
          }
        });
      }
    });

    // 2. Convert map to Category array, filter, sort, and limit
    const newCategories: Category[] = Object.entries(categoriesMap)
      .map(([genreId, items]) => ({
        id: genreId,
        title: t(`genres.id_${genreId}`, { defaultValue: `Category ${genreId}` }),
        items: items.slice(0, 15) // Réduit de 20 à 15 items par catégorie pour de meilleures performances
      }))
      .filter(category => category.items.length >= 5) // Only keep categories with at least 5 items
      .sort((a, b) => b.items.length - a.items.length) // Sort by number of items
      .slice(0, 8); // Réduit de 10 à 8 catégories pour de meilleures performances

    // 3. Add dynamic categories (e.g., recently added, top rated)
    const recentMovies = items
      .filter(item => item.media_type === 'movie' && item.release_date)
      .sort((a, b) => {
        const dateA = a.release_date ? new Date(a.release_date).getTime() : 0;
        const dateB = b.release_date ? new Date(b.release_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    const recentTVShows = items
      .filter(item => item.media_type === 'tv' && item.first_air_date)
      .sort((a, b) => {
        const dateA = a.first_air_date ? new Date(a.first_air_date).getTime() : 0;
        const dateB = b.first_air_date ? new Date(b.first_air_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    if (recentMovies.length >= 5) {
      newCategories.unshift({
        id: 'recent-movies',
        title: t('home.recentMovies'),
        items: recentMovies
      });
    }

    if (recentTVShows.length >= 5) {
      newCategories.unshift({
        id: 'recent-tv',
        title: t('home.recentShows'),
        items: recentTVShows
      });
    }

    const topRated = [...items]
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    if (topRated.length >= 5) {
      newCategories.push({ id: 'top-rated', title: t('home.bestRated'), items: topRated });
    }

    // Limit total categories
    setCategories(newCategories.slice(0, 10).map(normalizeHomeCategory)); // Réduit de 12 à 10 catégories max
  };

  const deleteContinueWatchingItem = useCallback((itemId: number, mediaType: 'movie' | 'tv') => {
    const storedContinueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}');

    // Ensure structure exists
    if (!storedContinueWatching.movies) storedContinueWatching.movies = [];
    if (!storedContinueWatching.tv) storedContinueWatching.tv = [];

    if (mediaType === 'movie') {
      // Handle both old format (number) and new format (object)
      storedContinueWatching.movies = storedContinueWatching.movies.filter((item: any) => {
        const movieId = typeof item === 'number' ? item : item.id;
        return movieId !== itemId;
      });
    } else {
      storedContinueWatching.tv = storedContinueWatching.tv.filter((tvShow: any) => tvShow.id !== itemId);
    }

    localStorage.setItem('continueWatching', JSON.stringify(storedContinueWatching));
    setContinueWatching(prev => prev.filter(item => !(item.id === itemId && item.media_type === mediaType)));
  }, []);

  const removeFromContinueWatching = useCallback((itemId: number, mediaType: string) => {
    if (mediaType !== 'movie' && mediaType !== 'tv') return;
    setContinueWatchingRemoval({ type: 'item', itemId, mediaType });
  }, []);

  const removeAllContinueWatching = useCallback(() => {
    setContinueWatchingRemoval({ type: 'all' });
  }, []);

  const confirmContinueWatchingRemoval = useCallback(() => {
    if (!continueWatchingRemoval) return;

    if (continueWatchingRemoval.type === 'all') {
      localStorage.setItem('continueWatching', JSON.stringify({ movies: [], tv: [] }));
      setContinueWatching([]);
    } else {
      deleteContinueWatchingItem(continueWatchingRemoval.itemId, continueWatchingRemoval.mediaType);
    }

    setContinueWatchingRemoval(null);
  }, [continueWatchingRemoval, deleteContinueWatchingItem]);

  useEffect(() => {
    // Simple title for homepage
    document.title = `${t('nav.home')} - Movix`;

    // Add or update structured data for a WebSite
    const structuredData = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Movix",
      "url": SITE_URL,
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${SITE_URL}/search?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      },
      "description": "Movix - Plateforme de streaming gratuite proposant des films et séries en français. Regardez en ligne sans inscription."
    };

    // Add structured data to head
    let scriptElement = document.querySelector('#home-structured-data');
    if (!scriptElement) {
      scriptElement = document.createElement('script');
      scriptElement.id = 'home-structured-data';
      (scriptElement as HTMLScriptElement).type = 'application/ld+json';
      document.head.appendChild(scriptElement);
    }
    scriptElement.textContent = JSON.stringify(structuredData);

    // Cleanup function
    return () => {
      const scriptElement = document.querySelector('#home-structured-data');
      if (scriptElement) {
        scriptElement.remove();
      }
    };
  }, []);

  // Removed the visibility change handler that was causing unnecessary logo refreshes

  // Memoized carousel titles — must be before any early return (Rules of Hooks)
  const yourHistoryTitle = useMemo(
    () => <CarouselTitle icon="⏯️" iconClass="text-blue-500" label={t('home.yourHistory')} />,
    [t]
  );

  const trendingTodayTitle = useMemo(
    () => <CarouselTitle icon="🔥" iconClass="text-red-600" label={t('home.trendingToday')} />,
    [t]
  );

  const usersAlsoWatchedTitle = useMemo(
    () => <CarouselTitle icon="👥" iconClass="text-green-500" label={t('home.usersAlsoWatched')} />,
    [t]
  );

  const becauseYouWatchedTitles = useMemo(
    () => (personalizedReco?.becauseYouWatched || []).map((group) =>
      <CarouselTitle icon="✨" iconClass="text-purple-500" label={t('home.becauseYouWatched', { title: group.title })} />
    ),
    [personalizedReco?.becauseYouWatched, t]
  );

  const topGenresTitles = useMemo(
    () => (personalizedReco?.topGenres || []).map((group) =>
      <CarouselTitle icon="🎯" iconClass="text-yellow-500" label={t('home.popularInGenre', { genre: group.genreName })} />
    ),
    [personalizedReco?.topGenres, t]
  );

  const trendingCustomTitle = useMemo(
    () => <span className="text-white relative z-20">{t('home.trending')}</span>,
    [t]
  );

  const platformsTitle = useMemo(
    () => <CarouselTitle icon="🎬" iconClass="text-white" label={t('home.streamingPlatforms')} />,
    [t]
  );

  const platformsItems = useMemo(() => [
    { id: 8, src: "https://u.cubeupload.com/mystic/8df6ce62504c1ab31aab.png", video: "https://media.tenor.com/hd7jyV_dMS8AAAPo/netflix-media-services-provider.mp4", alt: "Netflix", route: "/provider/8", label: t('home.filmsAndSeries', { count: 2817 }) },
    { id: 119, src: "https://u.cubeupload.com/mystic/b222691607d658c2fa52.png", video: "https://media.tenor.com/T7L_NCdPIvAAAAPo/prime-video.mp4", alt: "Prime Video", route: "/provider/119", label: t('home.filmsAndSeries', { count: 2799 }) },
    { id: 531, src: "https://u.cubeupload.com/mystic/35734306149c1a6eb0a9.png", video: "https://media4.giphy.com/media/qCEXQzkScYOBIRusVA/giphy.mp4", alt: "Paramount+", route: "/provider/531", label: t('home.filmsAndSeries', { count: 502 }) },
    { id: 337, src: "https://u.cubeupload.com/mystic/c40fe782c450e170eea6.png", video: "https://media.tenor.com/h6-0yzk8pbAAAAPo/disney-disney-plus.mp4", alt: "Disney+", route: "/provider/337", label: t('home.filmsAndSeries', { count: 1152 }) },
    { id: 338, src: "https://u.cubeupload.com/mystic/hUzeosd33nzE5MCNsZxC.png", video: "https://i.giphy.com/media/vBjLa5DQwwxbi/giphy.mp4", alt: "Marvel Studios", route: "/provider/338", label: t('home.filmsAndSeries', { count: 65 }) },
    { id: 350, src: "https://u.cubeupload.com/mystic/b2fb6956993e2ee5b4e3.png", video: "https://media.tenor.com/Oxl9xEn7kTEAAAPo/applo-tv.mp4", alt: "Apple TV+", route: "/provider/350", label: t('home.filmsAndSeries', { count: 138 }) },
    { id: 355, src: "https://u.cubeupload.com/mystic/ky0xOc5OrhzkZ1N6KyUx.png", video: "https://i.giphy.com/media/3o7TKt3pMpzozdUsus/giphy.mp4", alt: "Warner Bros", route: "/provider/355", label: t('home.filmsAndSeries', { count: 645 }) },
    { id: 356, src: "https://u.cubeupload.com/mystic/2Tc1P3Ac8M479naPp1kY.png", video: "https://media.tenor.com/ag74wyAzYkMAAAPo/dc-comics-dceu.mp4", alt: "DC Comics", route: "/provider/356", label: t('home.filmsAndSeries', { count: 98 }) },
  ], [t]);

  if (loading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="w-full min-h-screen bg-black text-white">
        <HeroSkeleton />
        <div className="container mx-auto px-4 py-8 space-y-8">
          <ContentRowSkeleton />
          <ContentRowSkeleton />
          <ContentRowSkeleton />
        </div>
      </SquareBackground>
    );
  }

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="w-full min-h-screen bg-black text-white">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full overflow-hidden content-wrapper relative z-10"
      >
        <style dangerouslySetInnerHTML={{ __html: homeStyles }} />
        {loading ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center min-h-screen"
          >
            <Loader2 className="w-12 h-12 text-red-600 animate-spin" />
          </motion.div>
        ) : (
          <>
            {heroItems.length > 0 && (
              <div className="relative w-full pt-16 md:pt-20 lg:pt-24">
                <HeroSlider items={heroItems} />
              </div>
            )}

            {!streamingPlatformsHidden && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="home-section w-full relative z-0 px-4 md:px-8"
              >
                <div className="w-full overflow-hidden">
                  <EmblaCarouselPlatforms
                    title={platformsTitle}
                    items={platformsItems}
                  />
                </div>
              </motion.div>
            )}

            <div>
              {/* Section "Reprendre votre lecture" - Section prioritaire (index 0) */}
              {continueWatching.length > 0 && (
                <div className="home-section content-row-container px-4 md:px-8">
                  <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                    <EmblaCarousel
                      title={yourHistoryTitle}
                      items={continueWatching as any[]}
                      mediaType="history"
                      isHistory={true}
                      onRemoveItem={removeFromContinueWatching}
                      onRemoveAll={removeAllContinueWatching}
                    />
                  </LazySection>
                </div>
              )}

              {/* Personalized: "Because you watched X" */}
              {personalizedReco?.becauseYouWatched?.map((group, idx) => (
                <div key={`byw-${group.sourceId}`} className="home-section content-row-container px-4 md:px-8">
                  <LazySection index={idx + 2} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                    <EmblaCarousel
                      title={becauseYouWatchedTitles[idx]}
                      items={group.items}
                      mediaType="mixed"
                    />
                  </LazySection>
                </div>
              ))}

              {/* Personalized: "Popular in [genre]" */}
              {personalizedReco?.topGenres?.map((group, idx) => (
                <div key={`genre-${group.genreId}`} className="home-section content-row-container px-4 md:px-8">
                  <LazySection index={idx + 5} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                    <EmblaCarousel
                      title={topGenresTitles[idx]}
                      items={group.items}
                      mediaType="mixed"
                    />
                  </LazySection>
                </div>
              ))}

              {/* Personalized: "Users also watched" (collaborative filtering) */}
              {personalizedReco?.usersAlsoWatched && personalizedReco.usersAlsoWatched.length > 0 && (
                <div className="home-section content-row-container px-4 md:px-8">
                  <LazySection index={8} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                    <EmblaCarousel
                      title={usersAlsoWatchedTitle}
                      items={personalizedReco.usersAlsoWatched}
                      mediaType="mixed"
                    />
                  </LazySection>
                </div>
              )}

              {/* Section "Tendances du jour" - Section prioritaire (index 1) */}
              {topContent.length > 0 && (
                <div className="home-section content-row-container px-4 md:px-8">
                  <LazySection index={1} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                    <EmblaCarousel
                      title={trendingTodayTitle}
                      items={topContent}
                      mediaType="top10"
                      showRanking={true}
                    />
                  </LazySection>
                </div>
              )}
            </div>

            {/* Recommandations - Section prioritaire (index 2).
                `px-4 md:px-8` comme les autres rangées : c'était la seule
                sans retrait horizontal, donc décalée de 2rem. */}
            {!personalizedReco && recommendations.length > 0 && (
              <div className="home-section px-4 md:px-8">
                <LazySection index={2} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={t('home.recommendationsForYou')}
                    items={recommendations}
                    mediaType="recommendations"
                  />
                </LazySection>
              </div>
            )}

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="relative pb-16"
            >
              {!loading && (
                <div>
                  <div className="home-section">
                    <TelegramPromotion />
                  </div>

                  {/* Tendances - Lazy loaded (index 3) */}
                  <div className="home-section px-4 md:px-8">
                    <LazySection index={3} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                      <EmblaCarousel
                        title={trendingCustomTitle}
                        items={trending}
                        mediaType="trending"
                      />
                    </LazySection>
                  </div>

                  {/* Sagas - Lazy loaded (index 4) — le fetch des 20 collections TMDB est
                      déclenché par onLoad à l'approche du viewport, plus au mount de Home (perf) */}
                  <div className="home-section px-4 md:px-8">
                    <LazySection
                      key={`sagas-${tmdbLanguage}`}
                      index={4}
                      immediateLoadCount={IMMEDIATE_LOAD_COUNT}
                      onLoad={fetchSagaCollections}
                      showLoadingDuringFetch={true}
                    >
                      {sagaCollections.length > 0 && (
                        <EmblaCarousel
                          title={t('home.legendaryCollections')}
                          items={sagaCollections as any}
                          mediaType="collections"
                        />
                      )}
                    </LazySection>
                  </div>

                  {/* Featured Series - Team Selection — fetch + image différés via LazySection,
                      image en w1280 au lieu de original (perf) */}
                  <LazySection
                    key={`featured-${tmdbLanguage}`}
                    index={5}
                    immediateLoadCount={IMMEDIATE_LOAD_COUNT}
                    onLoad={fetchFeaturedSeries}
                    showLoadingDuringFetch={true}
                  >
                  {featuredSeries && (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.6 }}
                      className="home-section w-full relative px-4 md:px-6"
                      style={{ zIndex: 11 }}
                    >
                      <div
                        className="w-full min-h-[400px] h-[65svh] max-h-[700px] bg-cover bg-no-repeat relative rounded-3xl overflow-hidden border border-white/10 shadow-2xl"
                        style={{
                          backgroundImage: 'url("/apothecary_backdrop.jpg")',
                          backgroundPosition: 'center 30%'
                        }}
                      >
                        <div className="absolute inset-0 pointer-events-none z-10 bg-gradient-to-b from-black/60 via-transparent to-black/90"></div>
                        <div
                          className="absolute inset-0 z-[2] pointer-events-none"
                          style={{
                            backgroundImage: `linear-gradient(
                              to right,
                              rgba(15, 23, 42, 0.92) 0%,
                              rgba(15, 23, 42, 0.58) 28%,
                              rgba(15, 23, 42, 0.10) 56%,
                              rgba(15, 23, 42, 0.40) 78%,
                              rgba(15, 23, 42, 0.84) 100%
                            )`,
                          }}
                        ></div>
                        <div className="flex items-start justify-center flex-col h-full z-20 relative gap-5 px-6 md:px-12 py-10">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-600/90 border border-red-500/40 text-white text-xs font-semibold uppercase tracking-wider">
                            🔥 {t('home.teamSelection')}
                          </span>
                          <span className="text-white text-4xl sm:text-5xl font-bold leading-tight">
                            {t('home.featuredSpotlightTitle')}
                          </span>
                          <div className="flex flex-row gap-2 items-center flex-wrap">
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/10 border border-white/20 text-white/90 text-xs font-medium">
                              12+
                            </span>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-yellow-500/15 border border-yellow-500/30 text-yellow-300 text-xs font-semibold">
                              <Star className="w-3 h-3 fill-current" />
                              {t('nav.collections') === 'Collections' ? '8.6' : '8,6'}/10
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/10 border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreAnimation')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/10 border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreComedy')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/10 border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreDrama')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/10 border border-white/10 text-white/80 text-xs font-medium">
                              24 min / {t('home.perEpisode')}
                            </span>
                          </div>
                          <p className="text-white/80 my-0 w-full lg:w-2/3 xl:w-1/2 line-clamp-4 leading-relaxed">
                            {t('home.featuredSpotlightDescription')}
                          </p>
                          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                            <Link
                              to="/tv/fFFB6OvEJ1NFH93LdfdR0Svt2TsSUhSZBmdU2a"
                              className="inline-flex items-center gap-2 bg-white hover:bg-white/90 text-black px-6 md:px-7 py-3 rounded-2xl font-semibold transition-colors shadow-lg"
                            >
                              <Info className="w-5 h-5" />
                              {t('home.viewDetails')}
                            </Link>
                          </motion.div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                  </LazySection>

                  {/* Films Populaires - Lazy loaded (index 5) */}
                  <div className="home-section px-4 md:px-8">
                    <LazySection index={5} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                      <EmblaCarousel
                        title={t('home.popularMovies')}
                        items={popularMovies}
                        mediaType="popularMovies"
                      />
                    </LazySection>
                  </div>

                  {/* Category Genre Rows - Lazy loaded (index 6+) */}
                  {categories.map((category, catIndex) => (
                    <div key={category.id} className="home-section px-4 md:px-8">
                      <LazySection index={6 + catIndex} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                        <EmblaCarousel
                          title={category.title}
                          items={category.items}
                          mediaType={category.id}
                        />
                      </LazySection>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </>
        )}
      </motion.div>
      <ConfirmDialog
        isOpen={continueWatchingRemoval !== null}
        title={t('common.delete')}
        message={t(
          continueWatchingRemoval?.type === 'all'
            ? 'home.confirmRemoveAll'
            : 'home.confirmRemoveItem'
        )}
        confirmLabel={t('common.delete')}
        variant="destructive"
        onConfirm={confirmContinueWatchingRemoval}
        onCancel={() => setContinueWatchingRemoval(null)}
      />
    </SquareBackground>
  );
};

export default Home;
