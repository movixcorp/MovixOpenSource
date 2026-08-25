import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Loader, ChevronRight, Film, Tv } from 'lucide-react';

import HeroSlider from '../components/HeroSlider';
import CarouselTitle from '../components/CarouselTitle';
import EmblaCarousel from '../components/EmblaCarousel';
import ContentRowSkeleton from '../components/skeletons/ContentRowSkeleton';
import LazySection from '../components/LazySection';
import { getTmdbLanguage } from '../i18n';
import { getMinimumCarouselCategoryItems, makeExclusiveCategories } from '../utils/exclusiveCategories';
import AgeRestrictedMedia from '../components/AgeRestrictedMedia';

// Nombre de sections à charger immédiatement
const IMMEDIATE_LOAD_COUNT = 2;

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// CSS pour l'animation du slider
const sliderStyles = `
@keyframes fadeInOut {
  0% { opacity: 0; transform: scale(1.05) translateX(-10%); }
  10% { opacity: 1; transform: scale(1) translateX(-5%); }
  90% { opacity: 1; transform: scale(1) translateX(5%); }
  100% { opacity: 0; transform: scale(1.05) translateX(10%); }
}

@keyframes slideInFromRight {
  0% { transform: translateX(50px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

@keyframes slideInFromLeft {
  0% { transform: translateX(-50px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

.slide-in-right {
  animation: slideInFromRight 0.7s ease-out forwards;
}

.slide-in-left {
  animation: slideInFromLeft 0.7s ease-out forwards;
}

.hero-slide-enter {
  z-index: 1;
}

.hero-slide-exit {
  z-index: 0;
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
  animation: fadeInTitle 0.8s ease-out forwards;
  transition: all 0.3s ease;
}

.section-title:hover {
  background: linear-gradient(90deg, #ff3333, #ff9999);
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(-2px);
  text-shadow: 0px 4px 8px rgba(255, 51, 51, 0.4);
}

@keyframes fadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
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
  animation: expandWidth 0.6s ease-out forwards 0.3s;
  transform-origin: left;
  transition: all 0.3s ease;
}

.section-title:hover::after {
  width: 100%;
  background: linear-gradient(90deg, #ff3333, #ff9999);
}

@keyframes expandWidth {
  0% { width: 0; }
  100% { width: 40px; }
}

.content-row-container {
  padding-top: 5px;
  padding-bottom: 40px;
  margin-top: -30px;
  overflow: visible !important;
  position: relative;
  z-index: 1;
}

.poster-row {
  display: flex;
  gap: 10px;
  transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  padding: 5rem 0.5rem;
  margin: -5rem -0.5rem;
  overflow-x: auto !important;
  overflow-y: visible !important;
  scrollbar-width: none;
  -ms-overflow-style: none;
  position: relative;
  z-index: 5;
}

.poster-row::-webkit-scrollbar {
  display: none;
}

.poster-row.no-scroll {
  overflow: hidden !important;
}

.poster-container {
  position: relative;
  transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  margin: 0;
  flex-shrink: 0;
  z-index: 10;
  overflow: visible;
  padding: 0;
}

.poster-container:hover {
  z-index: 50;
  overflow: visible;
  transform: translateZ(0);
}

.poster-container:hover ~ .poster-container {
  transform: translateX(0);
}

.poster-card {
  position: relative;
  transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  transform-origin: 0% 0%;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  overflow: visible;
  cursor: pointer;
  z-index: 10;
  margin-bottom: 3rem;
  margin-top: 1rem;
}

.poster-card:hover {
  transform: scale(1.5);
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  z-index: 100;
  overflow: visible;
  transform-style: preserve-3d;
  position: relative;
}

.poster-container:has(.poster-card:hover) ~ .poster-container {
  transform: translateX(100px);
}

.poster-container:hover ~ .poster-container {
  transition-delay: 0.12s;
  transform: translateX(100px);
}

.poster-card .hover-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #141414;
  opacity: 0;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  transition: opacity 0.3s ease;
  overflow: hidden;
}

.poster-card:hover .hover-content {
  opacity: 1;
}

.poster-card:hover img.poster {
  opacity: 0;
}

.card-buttons {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  align-items: center;
}

.card-buttons a {
  transition: transform 0.2s ease;
}

.card-buttons a:hover {
  transform: scale(1.2);
}

.top-content-row {
  margin-top: 10px;
  margin-bottom: 10px;
  padding-left: 64px;
  padding-right: 64px;
  gap: 15px;
}

/* Provider navigation tabs */
.provider-nav {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 3rem;
  margin-top: 0.5rem;
  margin-bottom: 1.5rem;
  position: relative;
  z-index: 100;
  background: linear-gradient(180deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 70%, transparent 100%);
}

.provider-tab {
  position: relative;
  padding: 0.6rem 1.2rem;
  font-weight: 600;
  font-size: 0.95rem;
  transition: all 0.3s ease;
  border-radius: 8px;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.provider-tab.active {
  background: linear-gradient(135deg, #e50914, #b20710);
  color: white;
  box-shadow: 0 4px 15px rgba(229, 9, 20, 0.4);
}

.provider-tab:not(.active) {
  color: #aaa;
  background: rgba(255, 255, 255, 0.08);
}

.provider-tab:not(.active):hover {
  color: white;
  background: rgba(255, 255, 255, 0.15);
}

/* See all button */
.see-all-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: #999;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  transition: all 0.2s ease;
  margin-left: 1rem;
}

.see-all-btn:hover {
  color: #fff;
  background: rgba(229, 9, 20, 0.3);
}

.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 1rem;
}
`;

// Provider names mapping for display
const PROVIDER_NAMES: Record<number, string> = {
  8: 'Netflix',
  119: 'Prime Video',
  531: 'Paramount+',
  337: 'Disney+',
  338: 'Marvel Studios',
  350: 'Apple TV+',
  355: 'Warner Bros',
  356: 'DC Comics',
  384: 'HBO MAX',
  357: 'OCS'
};

interface StudioContent {
  id: number;
  name: string;
  tmdbId: number;
}

const STUDIOS: Record<number, StudioContent> = {
  338: {
    id: 338,
    name: 'Marvel Studios',
    tmdbId: 420
  },
  356: {
    id: 356,
    name: 'DC Comics',
    tmdbId: 9993
  },
  355: {
    id: 355,
    name: 'Warner Bros',
    tmdbId: 174
  },
  357: {
    id: 357,
    name: 'OCS',
    tmdbId: 792
  }
};

interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  media_type: 'movie' | 'tv';
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  genre_ids?: number[];
  production_companies?: Array<{ id: number; name: string }>;
}

interface Category {
  id: string;
  title: string;
  items: Media[];
}

interface ProviderVideo {
  id: number;
  video: string;
}

const PROVIDER_VIDEOS: Record<number, ProviderVideo> = {
  8: {
    id: 8,
    video: "https://media.tenor.com/hd7jyV_dMS8AAAPo/netflix-media-services-provider.mp4"
  },
  119: {
    id: 119,
    video: "https://media.tenor.com/T7L_NCdPIvAAAAPo/prime-video.mp4"
  },
  531: {
    id: 531,
    video: "https://media4.giphy.com/media/qCEXQzkScYOBIRusVA/giphy.mp4"
  },
  337: {
    id: 337,
    video: "https://media.tenor.com/h6-0yzk8pbAAAAPo/disney-disney-plus.mp4"
  },
  338: {
    id: 338,
    video: "https://i.giphy.com/media/vBjLa5DQwwxbi/giphy.mp4"
  },
  350: {
    id: 350,
    video: "https://media.tenor.com/Oxl9xEn7kTEAAAPo/applo-tv.mp4"
  },
  353: {
    id: 353,
    video: "https://media.tenor.com/WnlyKBjZPuYAAAPo/roar-national-geographic.mp4"
  },
  355: {
    id: 355,
    video: "https://i.giphy.com/media/3o7TKt3pMpzozdUsus/giphy.mp4"
  },
  356: {
    id: 356,
    video: "https://media.tenor.com/ag74wyAzYkMAAAPo/dc-comics-dceu.mp4"
  }
};

// Genre IDs from TMDB - names come from translation keys providerCatalog.genres.*
const GENRE_IDS = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37, 10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768];

const inferMediaType = (item: any): 'tv' | 'movie' =>
  item.media_type || (item.first_air_date ? 'tv' : 'movie');

const normalizeProviderItem = (item: any) => ({
  ...item,
  media_type: inferMediaType(item),
  poster_path: item.poster_path || '',
  backdrop_path: item.backdrop_path || '',
  overview: item.overview || '',
});

const normalizeProviderCategory = (category: Category): Category => ({
  ...category,
  items: category.items
    .filter((item: any) => !!item.poster_path)
    .map(normalizeProviderItem) as any,
});

interface ProviderCategoryRowProps {
  category: Category;
  catIndex: number;
  providerId: string;
  immediateLoadCount: number;
}

const ProviderCategoryRow: React.FC<ProviderCategoryRowProps> = React.memo(({
  category,
  catIndex,
  providerId,
  immediateLoadCount,
}) => {
  const { t } = useTranslation();
  const categoryMediaType = category.items[0]?.media_type ||
    ((category.items[0] as any)?.first_air_date ? 'tv' : 'movie');
  const typeSlug = categoryMediaType === 'tv' ? 'tv' : 'movies';
  const genreIdForLink = !isNaN(Number(category.id)) ? category.id : null;

  const isRecentMovies = category.id === 'recent-movies';
  const isRecentTV = category.id === 'recent-tv';
  const isTopRated = category.id === 'top-rated';
  const showSeeAll = !!(genreIdForLink || isRecentMovies || isRecentTV || isTopRated);

  let seeAllLink = '';
  if (genreIdForLink) {
    seeAllLink = `/provider/${providerId}/${typeSlug}/${genreIdForLink}`;
  } else if (isRecentMovies) {
    seeAllLink = `/provider/${providerId}/movies`;
  } else if (isRecentTV) {
    seeAllLink = `/provider/${providerId}/tv`;
  } else if (isTopRated) {
    seeAllLink = `/provider/${providerId}/${typeSlug}`;
  }

  const categoryHeader = useMemo(
    () => (
      <div className="category-header">
        <span>{category.title}</span>
        {showSeeAll && (
          <Link
            to={seeAllLink}
            className="see-all-btn"
          >
            {t('providerCatalog.seeAll')}
            <ChevronRight size={14} />
          </Link>
        )}
      </div>
    ),
    [category.title, showSeeAll, seeAllLink, t]
  );

  return (
    <LazySection key={`lazy-${category.id}`} index={1 + catIndex} immediateLoadCount={immediateLoadCount}>
      <EmblaCarousel
        key={category.id}
        title={categoryHeader}
        items={category.items}
        mediaType={category.id}
      />
    </LazySection>
  );
});
ProviderCategoryRow.displayName = 'ProviderCategoryRow';

const ProviderContent: React.FC = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const { t } = useTranslation();
  const getGenreName = (id: number): string => t(`providerCatalog.genres.${id}`, { defaultValue: String(id) });
  const [content, setContent] = useState<Media[]>([]);
  const [verifiedContent, setVerifiedContent] = useState<Media[]>([]);
  const [topContent, setTopContent] = useState<Media[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [featuredContent, setFeaturedContent] = useState<Media | null>(null);
  const [heroItems, setHeroItems] = useState<Media[]>([]);
  const [currentHeroIndex, setCurrentHeroIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Media[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const sliderIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [hoveredTopContentIndex, setHoveredTopContentIndex] = useState<number | null>(null);
  const [hoveredCategoryItemsMap, setHoveredCategoryItemsMap] = useState<Record<string, boolean>>({});
  const top10RowRef = useRef<HTMLDivElement>(null);
  const categoryRowRefs = useRef<Record<string, HTMLDivElement>>({});


  const searchTMDB = async (query: string) => {
    try {
      const [moviesResponse, tvResponse] = await Promise.all([
        axios.get('https://api.themoviedb.org/3/search/movie', {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage(),
            query: query,
            page: 1
          }
        }),
        axios.get('https://api.themoviedb.org/3/search/tv', {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage(),
            query: query,
            page: 1
          }
        })
      ]);

      const movies = moviesResponse.data.results.map((item: any) => ({
        ...item,
        media_type: 'movie'
      }));

      const tvShows = tvResponse.data.results.map((item: any) => ({
        ...item,
        media_type: 'tv'
      }));

      const results = [...movies, ...tvShows];

      // Filtrer les résultats sans overview
      return results.filter(item => item.overview);
    } catch (error) {
      console.error('Erreur lors de la recherche TMDB:', error);
      return [];
    }
  };

  // Fonction pour récupérer le contenu des fournisseurs avec chargement parallèle des pages
  // Cette fonction permet de charger plusieurs pages TMDB simultanément pour améliorer les performances
  const fetchProviderContent = async (providerId: string, startPage: number = 1, pageCount: number = 1) => {
    try {
      const studio = STUDIOS[Number(providerId)];
      const today = new Date().toISOString().split('T')[0];

      // Fonction interne pour récupérer les contenus du fournisseur avec plus de pages pour plus de diversité
      const fetchProviderSpecificContent = async () => {
        try {
          // Pour un studio spécifique (comme Marvel ou DC)
          if (studio) {
            // Récupérer plusieurs pages pour les studios
            const moviePromises = Array.from({ length: 3 }, (_, i) =>
              axios.get('https://api.themoviedb.org/3/discover/movie', {
                params: {
                  api_key: TMDB_API_KEY,
                  language: getTmdbLanguage(),
                  with_companies: studio.tmdbId,
                  sort_by: 'popularity.desc',
                  'primary_release_date.lte': today,
                  page: i + 1
                }
              })
            );

            const responses = await Promise.all(moviePromises);

            const allStudioMovies = responses.flatMap(response =>
              response.data.results
                .filter((item: any) => item.poster_path && item.overview)
                .map((item: any) => ({
                  ...item,
                  media_type: 'movie'
                }))
            );

            return {
              trending: allStudioMovies.slice(0, 10),
              movies: allStudioMovies,
              tvShows: []  // Les studios n'ont souvent que des films
            };
          }

          // Pour un service de streaming (comme Netflix)
          // Récupérer plusieurs pages de films
          const moviePromises = Array.from({ length: 3 }, (_, i) =>
            axios.get('https://api.themoviedb.org/3/discover/movie', {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_watch_providers: providerId,
                watch_region: 'FR',
                'primary_release_date.lte': today,
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          );

          // Récupérer plusieurs pages de séries
          const tvPromises = Array.from({ length: 3 }, (_, i) =>
            axios.get('https://api.themoviedb.org/3/discover/tv', {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_watch_providers: providerId,
                watch_region: 'FR',
                'first_air_date.lte': today,
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          );

          // Attendre toutes les requêtes
          const [movieResponses, tvResponses] = await Promise.all([
            Promise.all(moviePromises),
            Promise.all(tvPromises)
          ]);

          // Traiter tous les films
          const allMovies = movieResponses.flatMap(response =>
            response.data.results
              .filter((item: any) => item.poster_path && item.overview)
              .map((item: any) => ({
                ...item,
                media_type: 'movie'
              }))
          );

          // Traiter toutes les séries
          const allTvShows = tvResponses.flatMap(response =>
            response.data.results
              .filter((item: any) => item.poster_path && item.overview)
              .map((item: any) => ({
                ...item,
                media_type: 'tv'
              }))
          );

          // Combiner les films et séries les plus populaires pour les tendances
          const combined = [...allMovies, ...allTvShows]
            .sort((a, b) => b.popularity - a.popularity);

          // Filtrer les contenus avec des caractères chinois
          const filteredContent = combined.filter(item => {
            const title = item.title || item.name || '';
            const hasChineseChars = /[\u4e00-\u9fff]/.test(title);
            return !hasChineseChars;
          });

          return {
            trending: filteredContent.slice(0, 10),
            movies: allMovies,
            tvShows: allTvShows,
            all: filteredContent
          };
        } catch (error) {
          console.error('Error fetching provider content:', error);
          return {
            trending: [],
            movies: [],
            tvShows: [],
            all: []
          };
        }
      };

      // Récupérer les contenus spécifiques au fournisseur
      const providerContent = await fetchProviderSpecificContent();

      // Définir directement les tendances
      if (providerContent.trending && providerContent.trending.length > 0) {
        setTopContent((providerContent.trending || []).filter((i: any) => !!i.poster_path).map(normalizeProviderItem) as any);
      }

      // Organiser les catégories de contenus spécifiques au fournisseur
      if (providerContent.all && providerContent.all.length > 0) {
        organizeContentByCategories(providerContent.all);

        // Stocker tous les contenus vérifiés
        setVerifiedContent(providerContent.all);

        // On a obtenu tous les contenus nécessaires, pas besoin de continuer avec les autres requêtes
        setLoading(false);
        return providerContent.all;
      }

      // Si aucun contenu spécifique au fournisseur n'a été trouvé, continuer avec l'ancienne méthode
      const fetchSinglePage = async (page: number) => {
        if (studio) {
          const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              with_companies: studio.tmdbId,
              sort_by: 'primary_release_date.desc',
              'primary_release_date.lte': today,
              page
            }
          });

          return response.data.results
            .filter((item: any) => item.overview)
            .map((item: any) => ({
              ...item,
              media_type: 'movie'
            }));
        } else {
          const [moviesResponse, tvResponse] = await Promise.all([
            axios.get('https://api.themoviedb.org/3/discover/movie', {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_watch_providers: providerId,
                'primary_release_date.lte': today,
                sort_by: 'popularity.desc',
                page
              }
            }),
            axios.get('https://api.themoviedb.org/3/discover/tv', {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_watch_providers: providerId,
                'first_air_date.lte': today,
                sort_by: 'popularity.desc',
                page
              }
            })
          ]);

          const movies = moviesResponse.data.results.filter((item: any) => item.overview);
          const tvShows = tvResponse.data.results.filter((item: any) => item.overview);

          const moviesWithType = movies.map((item: any) => ({
            ...item,
            media_type: 'movie'
          }));

          const tvShowsWithType = tvShows.map((item: any) => ({
            ...item,
            media_type: 'tv'
          }));

          return [...moviesWithType, ...tvShowsWithType].sort(() => Math.random() - 0.5);
        }
      };

      // Création d'un tableau des pages à charger (de startPage à startPage+pageCount-1)
      const pagesToFetch = Array.from({ length: pageCount }, (_, i) => startPage + i);

      // Chargement parallèle de toutes les pages demandées avec Promise.all
      const results = await Promise.all(pagesToFetch.map(page => fetchSinglePage(page)));

      // Combinaison de tous les résultats
      const allResults = results.flat();

      return allResults;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  };

  const verifyContentAvailability = async (items: Media[]) => {
    // Filtrer les éléments sans overview et retourner le reste
    return items.filter(item => item.overview);
  };

  const filterByProvider = async (results: Media[]) => {
    if (STUDIOS[Number(providerId)]) {
      return results.filter(item => {
        const productionCompanies = item.production_companies || [];
        return productionCompanies.some((company: { id: number }) =>
          company.id === STUDIOS[Number(providerId)].tmdbId
        );
      });
    }

    const providerResults = await Promise.all(
      results.map(async (item) => {
        try {
          const response = await axios.get(
            `https://api.themoviedb.org/3/${item.media_type}/${item.id}/watch/providers`,
            { params: { api_key: TMDB_API_KEY } }
          );

          const providers = response.data.results?.FR?.flatrate || [];
          return providers.some((provider: { provider_id: number }) => provider.provider_id === Number(providerId)) ? item : null;
        } catch {
          return null;
        }
      })
    );

    return providerResults.filter((item): item is Media => item !== null);
  };

  const handleSearch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      // 1. Recherche sur TMDB
      const tmdbResults = await searchTMDB(searchQuery);

      // 2. Filtre par provider
      const providerResults = await filterByProvider(tmdbResults);

      // 3. Vérifie la disponibilité sur Frembed
      const verifiedResults = await verifyContentAvailability(providerResults);

      setSearchResults(verifiedResults);
    } catch (error) {
      console.error('Search error:', error);
      setError(t('providerCatalog.searchError'));
    } finally {
      setIsSearching(false);
    }
  };

  const organizeContentByCategories = (items: Media[]) => {
    // Filtrer les éléments sans overview ou poster_path
    const filteredContent = items.filter(item => item.overview && item.poster_path);

    if (filteredContent.length === 0) {
      console.warn("Aucun contenu filtré disponible pour organiser les catégories");
      return;
    }

    // Create a copy to sort differently for each category
    const allContent = [...filteredContent];

    // Extract items with backdrop for the hero section
    const heroItemsList = allContent
      .filter(item => item.backdrop_path)
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 5);

    setHeroItems(heroItemsList);

    if (heroItemsList.length > 0) {
      setFeaturedContent(heroItemsList[0]);
    }

    // Note: Nous ne définissons plus topContent ici, il est déjà défini dans fetchProviderContent

    // Create genre-based categories
    const genreMap: Record<number, Media[]> = {};

    allContent.forEach(item => {
      if (item.genre_ids && item.genre_ids.length > 0) {
        item.genre_ids.forEach(genreId => {
          if (!genreMap[genreId]) {
            genreMap[genreId] = [];
          }
          // Only add if not already in the array
          if (!genreMap[genreId].some(media => media.id === item.id)) {
            genreMap[genreId].push(item);
          }
        });
      }
    });

    // Assurer que les genres ont au moins 4 éléments
    const minItemsPerCategory = 4;

    // Convert the genre map to categories array
    const genreCategories: Category[] = Object.entries(genreMap)
      .map(([genreId, items]) => ({
        id: genreId,
        title: getGenreName(Number(genreId)) || `Category ${genreId}`,
        items: items.slice(0, 15) // Réduit de 20 à 15 pour de meilleures performances
      }))
      .filter(category => category.items.length >= minItemsPerCategory) // Au moins 4 éléments par catégorie
      .sort((a, b) => b.items.length - a.items.length) // Sort by number of items
      .slice(0, 8); // Limit to 8 categories

    // Additional dynamic categories
    const recentMovies = allContent
      .filter(item => item.media_type === 'movie' && item.release_date)
      .sort((a, b) => {
        const dateA = a.release_date ? new Date(a.release_date).getTime() : 0;
        const dateB = b.release_date ? new Date(b.release_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    const recentTVShows = allContent
      .filter(item => item.media_type === 'tv' && item.first_air_date)
      .sort((a, b) => {
        const dateA = a.first_air_date ? new Date(a.first_air_date).getTime() : 0;
        const dateB = b.first_air_date ? new Date(b.first_air_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    // N'ajouter ces catégories que si elles contiennent suffisamment d'éléments
    const orderedCategories: Category[] = [];

    if (recentTVShows.length >= minItemsPerCategory) {
      orderedCategories.push({
        id: 'recent-tv',
        title: t('providerCatalog.recentSeries'),
        items: recentTVShows
      });
    }

    if (recentMovies.length >= minItemsPerCategory) {
      orderedCategories.push({
        id: 'recent-movies',
        title: t('providerCatalog.recentFilms'),
        items: recentMovies
      });
    }

    orderedCategories.push(...genreCategories);

    // Ajouter une catégorie pour les films les mieux notés
    const topRatedContent = [...allContent]
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    if (topRatedContent.length >= minItemsPerCategory) {
      orderedCategories.push({
        id: 'top-rated',
        title: t('providerCatalog.bestRated'),
        items: topRatedContent
      });
    }

    setCategories((makeExclusiveCategories(orderedCategories, {
      minItems: Math.max(minItemsPerCategory, getMinimumCarouselCategoryItems()),
      limit: 10,
      perCategoryLimit: 15
    })).map(normalizeProviderCategory));
  };

  useEffect(() => {
    const loadContent = async () => {
      if (!providerId) return;

      try {
        // Charger 3 pages de contenu lors du chargement initial
        const pagesToLoad = 50;

        // Chargement parallèle des pages avec la fonction optimisée
        const newContent = await fetchProviderContent(providerId, 1, pagesToLoad);
        const availableContent = await verifyContentAvailability(newContent);

        setVerifiedContent(availableContent);
        // Set top content based on the first 10 items of available content, sorted by vote_average
        const sortedContent = [...availableContent].sort((a, b) => b.vote_average - a.vote_average);
        setTopContent(sortedContent.slice(0, 10).filter((i: any) => !!i.poster_path).map(normalizeProviderItem) as any);

        organizeContentByCategories(availableContent);
      } catch (error) {
        console.error('Error:', error);
        setError(t('providerCatalog.loadingError'));
      } finally {
        setLoading(false);
      }
    };

    setLoading(true);
    loadContent();
  }, [providerId]);

  // Set simple title
  useEffect(() => {
    document.title = t('providerCatalog.contentTitle');
  }, []);

  useEffect(() => {
    if (heroItems.length > 0) {
      // Clear any existing interval
      if (sliderIntervalRef.current) {
        clearInterval(sliderIntervalRef.current);
      }

      // Set new interval
      sliderIntervalRef.current = setInterval(() => {
        setCurrentHeroIndex(prevIndex =>
          prevIndex === heroItems.length - 1 ? 0 : prevIndex + 1
        );
      }, 6000);

      // Cleanup on unmount
      return () => {
        if (sliderIntervalRef.current) {
          clearInterval(sliderIntervalRef.current);
        }
      };
    }
  }, [heroItems, currentHeroIndex]);

  useEffect(() => {
    if (heroItems.length > 0 && currentHeroIndex < heroItems.length) {
      setFeaturedContent(heroItems[currentHeroIndex]);
    }
  }, [currentHeroIndex, heroItems]);



  const toggleSearch = () => {
    setShowSearch(!showSearch);
    if (!showSearch) {
      setSearchQuery('');
      setSearchResults([]);
    }
  };

  // Function to handle manual navigation
  const handleManualNavigation = (index: number) => {
    // Reset timer when manually changing slide
    if (sliderIntervalRef.current) {
      clearInterval(sliderIntervalRef.current);
    }

    setCurrentHeroIndex(index);

    // Set new interval
    sliderIntervalRef.current = setInterval(() => {
      setCurrentHeroIndex(prevIndex =>
        prevIndex === heroItems.length - 1 ? 0 : prevIndex + 1
      );
    }, 6000);
  };

  // Ajouter un useEffect pour empêcher le défilement du Top 10 pendant le hover
  useEffect(() => {
    const container = top10RowRef.current;
    if (!container) return;
    if (hoveredTopContentIndex === null) return;

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    // Prevent keyboard scroll
    const preventKey = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
      if (keys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    container.addEventListener('wheel', preventScroll, { passive: false });
    container.addEventListener('keydown', preventKey, { passive: false });
    return () => {
      container.removeEventListener('wheel', preventScroll);
      container.removeEventListener('keydown', preventKey);
    };
  }, [hoveredTopContentIndex]);

  // Ajouter un useEffect pour empêcher le défilement des catégories pendant le hover
  useEffect(() => {
    // Si aucune catégorie n'a d'élément survolé, ne rien faire
    const hoveredCategory = Object.keys(hoveredCategoryItemsMap).find(key => hoveredCategoryItemsMap[key]);
    if (!hoveredCategory) return;

    const container = categoryRowRefs.current[hoveredCategory];
    if (!container) return;

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    // Prevent keyboard scroll
    const preventKey = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
      if (keys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    container.addEventListener('wheel', preventScroll, { passive: false });
    container.addEventListener('keydown', preventKey, { passive: false });
    return () => {
      container.removeEventListener('wheel', preventScroll);
      container.removeEventListener('keydown', preventKey);
    };
  }, [hoveredCategoryItemsMap]);

  const trendingTitle = useMemo(
    () => <CarouselTitle icon="🔥" iconClass="text-red-600" label={t('providerCatalog.todayTrends')} />,
    [t]
  );

  return (
    <div className="min-h-screen bg-black">
      <style dangerouslySetInnerHTML={{ __html: sliderStyles }} />
      <div className="relative bg-black">

        {loading ? (
          <div className="flex justify-center items-center h-screen">
            <Loader className="animate-spin text-red-600" size={48} />
          </div>
        ) : error ? (
          <div className="text-center text-red-500 mt-24 pt-16">{error}</div>
        ) : (
          <div className="pb-12 -mt-8">
            {/* Featured Content/Hero Banner */}
            {!showSearch && heroItems.length > 0 && (
              <div className="relative w-full pt-24 md:pt-28 lg:pt-32">
                <HeroSlider
                  items={heroItems
                    .filter(i => !!i.poster_path)
                    .map((i) => ({
                      ...i,
                      media_type: (i as any).media_type || (i.first_air_date ? 'tv' : 'movie'),
                      poster_path: i.poster_path || '',
                      backdrop_path: i.backdrop_path || '',
                      overview: i.overview || ''
                    }))}
                />
              </div>
            )}

            {/* Main Content */}
            {/* Search Results */}
            {showSearch && searchQuery && (
              <div className="container mx-auto px-4 mt-6">
                <div className="mt-24 pt-4">
                  <h2 className="text-xl font-bold mb-4">{t('providerCatalog.searchResultsFor', { query: searchQuery })}</h2>
                  {isSearching ? (
                    <div className="flex justify-center py-8">
                      <Loader className="animate-spin" />
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                      {searchResults.map(item => (
                        <AgeRestrictedMedia key={`${item.id}-${item.media_type}`} item={item}>
                        <Link
                          key={`${item.id}-${item.media_type}`}
                          to={`/${item.media_type}/${item.id}`}
                          className="group block relative"
                        >
                          {item.poster_path ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                              alt={item.title || item.name}
                              className="w-full h-auto rounded-md transition-transform duration-300 group-hover:scale-105"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.onerror = null;
                                target.src = 'data:image/svg+xml;utf8,<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="50" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>';
                              }}
                            />
                          ) : (
                            <div className="w-full aspect-[2/3] bg-gray-800 rounded-md flex items-center justify-center">
                              <span className="text-gray-400">{item.title || item.name || 'No image'}</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 rounded-md">
                            <div>
                              <h3 className="text-lg font-bold">{item.title || item.name}</h3>
                              <div className="mt-2 text-sm">
                                {t('providerCatalog.rating')}: {item.vote_average?.toFixed(1)}/10
                              </div>
                              <div className="mt-1 text-sm text-gray-300">
                                {item.media_type === 'movie' ? t('providerCatalog.filmLabel') : t('providerCatalog.seriesLabel')}
                              </div>
                            </div>
                          </div>
                        </Link>
                        </AgeRestrictedMedia>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-400">
                      {t('providerCatalog.noResultsFor', { query: searchQuery })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Categories */}
            {!showSearch && (
              <>
                {/* Provider Navigation Tabs */}
                <div className="provider-nav mt-4 mb-6">
                  <span className="text-white font-semibold text-lg mr-4">{PROVIDER_NAMES[Number(providerId)] || 'Provider'}</span>
                  <Link
                    to={`/provider/${providerId}/movies`}
                    className="provider-tab"
                  >
                    <Film size={18} />
                    {t('providerCatalog.films')}
                    <ChevronRight size={16} />
                  </Link>
                  <Link
                    to={`/provider/${providerId}/tv`}
                    className="provider-tab"
                  >
                    <Tv size={18} />
                    {t('providerCatalog.series')}
                    <ChevronRight size={16} />
                  </Link>
                </div>

                {/* Top 10 Section - Section prioritaire (index 0) */}
                {topContent.length > 0 && (
                  <div className="content-row-container px-4 md:px-8 mb-2" style={{ marginTop: '0', paddingTop: '20px' }}>
                    <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                      <EmblaCarousel
                        title={trendingTitle}
                        items={topContent}
                        mediaType="top10"
                        showRanking={true}
                      />
                    </LazySection>
                  </div>
                )}

                {/* Category Rows - Lazy loaded (index 1+) */}
                <div className="relative pb-16 px-4 md:px-8">
                  {categories.length > 0 && categories.map((category, catIndex) => (
                    <ProviderCategoryRow
                      key={`row-${category.id}`}
                      category={category}
                      catIndex={catIndex}
                      providerId={providerId || ''}
                      immediateLoadCount={IMMEDIATE_LOAD_COUNT}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div >
  );
};

export default ProviderContent; 
