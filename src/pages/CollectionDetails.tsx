import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Film, Calendar, Star, ArrowLeft, Info, Grid, List, Eye, EyeOff, Building, MapPin, Languages, DollarSign, TrendingUp, Heart, Bookmark, Plus } from 'lucide-react';
import AddToListMenu from '../components/AddToListMenu';
import { encodeId } from '../utils/idEncoder';
import { getTmdbLanguage } from '../i18n';
import { motion } from 'framer-motion';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import BlurText from '../components/ui/blur-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

interface Movie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  budget?: number;
  revenue?: number;
  runtime?: number;
  production_companies?: { id: number; name: string; logo_path: string | null }[];
  production_countries?: { iso_3166_1: string; name: string }[];
  spoken_languages?: { iso_639_1: string; name: string }[];
  genres?: { id: number; name: string }[];
}

interface Collection {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  parts: Movie[];
}

interface SimilarCollection {
  id: number;
  name: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  parts: Movie[];
}

interface CollectionStats {
  totalBudget: number;
  totalRevenue: number;
  averageRating: number;
  totalRuntime: number;
  totalMovies: number;
  averageBudget: number;
  averageRevenue: number;
  profitMargin: number;
}

interface ProductionInfo {
  productionCompanies: { id: number; name: string; count: number }[];
  productionCountries: { code: string; name: string; count: number }[];
  spokenLanguages: { code: string; name: string; count: number }[];
  genres: { id: number; name: string; count: number }[];
}



const CollectionDetails: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [similarCollections, setSimilarCollections] = useState<SimilarCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const [error, setError] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showMoviesWithoutImages, setShowMoviesWithoutImages] = useState(false);
  
  // Nouveaux états pour les informations détaillées
  const [collectionStats, setCollectionStats] = useState<CollectionStats | null>(null);
  const [productionInfo, setProductionInfo] = useState<ProductionInfo | null>(null);

  const [, setDetailedMovies] = useState<Movie[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Nouveaux états pour les listes
  const [isInWatchlist, setIsInWatchlist] = useState(false);
  const [isInFavorites, setIsInFavorites] = useState(false);
  const [showAddToListMenu, setShowAddToListMenu] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<SimilarCollection | null>(null);
  
  // États pour les collections similaires
  const [similarCollectionsStatus, setSimilarCollectionsStatus] = useState<{
    [key: number]: { watchlist: boolean; favorites: boolean }
  }>({});

  const API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
  const BASE_URL = 'https://api.themoviedb.org/3';
  const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
  const { items: ageAllowedCollectionMovies, isFiltering: isFilteringCollectionMoviesByAge } = useAgeRestrictedContent(
    (collection?.parts || []).map((movie) => ({ ...movie, media_type: 'movie' as const })),
  );

  // Fonction pour optimiser les images selon le mode d'affichage
  const getOptimizedImageUrl = (path: string, size: 'small' | 'medium' | 'large' = 'medium') => {
    if (!path) return '';
    const sizes = {
      small: 'w200',
      medium: 'w500',
      large: 'w780'
    };
    return `https://image.tmdb.org/t/p/${sizes[size]}${path}`;
  };

  // Fonction pour récupérer les détails complets des films
  const fetchDetailedMovies = async (movies: Movie[]) => {
    setLoadingDetails(true);
    try {
      const detailedMoviesData: Movie[] = [];
      
      // Récupérer les détails de chaque film par lots pour éviter trop de requêtes
      const batchSize = 5;
      for (let i = 0; i < movies.length; i += batchSize) {
        const batch = movies.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (movie) => {
          try {
            const response = await fetch(
              `${BASE_URL}/movie/${movie.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}&append_to_response=credits`
            );
            
            if (response.ok) {
              const movieDetails = await response.json();
              detailedMoviesData.push({
                ...movie,
                budget: movieDetails.budget,
                revenue: movieDetails.revenue,
                runtime: movieDetails.runtime,
                production_companies: movieDetails.production_companies,
                production_countries: movieDetails.production_countries,
                spoken_languages: movieDetails.spoken_languages,
                genres: movieDetails.genres
              });
            } else {
              detailedMoviesData.push(movie);
            }
          } catch (error) {
            console.error(`Erreur lors de la récupération des détails du film ${movie.id}:`, error);
            detailedMoviesData.push(movie);
          }
        }));
      }
      
      setDetailedMovies(detailedMoviesData);
      
      // Calculer les statistiques
      calculateCollectionStats(detailedMoviesData);
      calculateProductionInfo(detailedMoviesData);
      
    } catch (error) {
      console.error('Erreur lors de la récupération des détails des films:', error);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Fonction pour calculer les statistiques de la collection
  const calculateCollectionStats = (movies: Movie[]) => {
    const moviesWithData = movies.filter(movie => movie.budget !== undefined || movie.revenue !== undefined);
    
    const totalBudget = moviesWithData.reduce((sum, movie) => sum + (movie.budget || 0), 0);
    const totalRevenue = moviesWithData.reduce((sum, movie) => sum + (movie.revenue || 0), 0);
    const totalRuntime = movies.reduce((sum, movie) => sum + (movie.runtime || 0), 0);
    const totalRating = movies.reduce((sum, movie) => sum + movie.vote_average, 0);
    
    const stats: CollectionStats = {
      totalBudget,
      totalRevenue,
      averageRating: totalRating / movies.length,
      totalRuntime,
      totalMovies: movies.length,
      averageBudget: totalBudget / moviesWithData.length,
      averageRevenue: totalRevenue / moviesWithData.length,
      profitMargin: totalBudget > 0 ? ((totalRevenue - totalBudget) / totalBudget) * 100 : 0
    };
    
    setCollectionStats(stats);
  };

  // Fonction pour calculer les informations de production
  const calculateProductionInfo = (movies: Movie[]) => {
    const companiesMap = new Map<number, { id: number; name: string; count: number }>();
    const countriesMap = new Map<string, { code: string; name: string; count: number }>();
    const languagesMap = new Map<string, { code: string; name: string; count: number }>();
    const genresMap = new Map<number, { id: number; name: string; count: number }>();
    
    movies.forEach(movie => {
      // Compter les sociétés de production
      movie.production_companies?.forEach(company => {
        const existing = companiesMap.get(company.id);
        if (existing) {
          existing.count++;
        } else {
          companiesMap.set(company.id, { id: company.id, name: company.name, count: 1 });
        }
      });
      
      // Compter les pays de production
      movie.production_countries?.forEach(country => {
        const existing = countriesMap.get(country.iso_3166_1);
        if (existing) {
          existing.count++;
        } else {
          countriesMap.set(country.iso_3166_1, { code: country.iso_3166_1, name: country.name, count: 1 });
        }
      });
      
      // Compter les langues
      movie.spoken_languages?.forEach(language => {
        const existing = languagesMap.get(language.iso_639_1);
        if (existing) {
          existing.count++;
        } else {
          languagesMap.set(language.iso_639_1, { code: language.iso_639_1, name: language.name, count: 1 });
        }
      });
      
      // Compter les genres
      movie.genres?.forEach(genre => {
        const existing = genresMap.get(genre.id);
        if (existing) {
          existing.count++;
        } else {
          genresMap.set(genre.id, { id: genre.id, name: genre.name, count: 1 });
        }
      });
    });
    
    const productionInfo: ProductionInfo = {
      productionCompanies: Array.from(companiesMap.values()).sort((a, b) => b.count - a.count).slice(0, 10),
      productionCountries: Array.from(countriesMap.values()).sort((a, b) => b.count - a.count),
      spokenLanguages: Array.from(languagesMap.values()).sort((a, b) => b.count - a.count),
      genres: Array.from(genresMap.values()).sort((a, b) => b.count - a.count).slice(0, 10)
    };
    
    setProductionInfo(productionInfo);
  };

  // Fonction pour récupérer les collections similaires
  const fetchSimilarCollections = async (movies: Movie[]) => {
    if (movies.length === 0) return;
    
    setLoadingSimilar(true);
    try {
      const similarCollectionsSet = new Set<number>();
      const similarCollectionsData: SimilarCollection[] = [];
      
      // Prendre les 3 premiers films de la collection pour chercher des films similaires
      const moviesToCheck = movies.slice(0, 3);
      
      for (const movie of moviesToCheck) {
        // Récupérer les films similaires
        const similarResponse = await fetch(
          `${BASE_URL}/movie/${movie.id}/similar?api_key=${API_KEY}&language=${getTmdbLanguage()}&page=1`
        );
        
        if (similarResponse.ok) {
          const similarData = await similarResponse.json();
          const similarMovies = similarData.results.slice(0, 5); // Prendre les 5 premiers
          
          // Pour chaque film similaire, vérifier s'il appartient à une collection
          for (const similarMovie of similarMovies) {
            const movieDetailsResponse = await fetch(
              `${BASE_URL}/movie/${similarMovie.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
            );
            
            if (movieDetailsResponse.ok) {
              const movieDetails = await movieDetailsResponse.json();
              
              // Si le film appartient à une collection et que ce n'est pas la collection actuelle
              if (movieDetails.belongs_to_collection && 
                  movieDetails.belongs_to_collection.id !== parseInt(id || '0') &&
                  !similarCollectionsSet.has(movieDetails.belongs_to_collection.id)) {
                
                similarCollectionsSet.add(movieDetails.belongs_to_collection.id);
                
                // Récupérer les détails de la collection
                const collectionResponse = await fetch(
                  `${BASE_URL}/collection/${movieDetails.belongs_to_collection.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
                );
                
                if (collectionResponse.ok) {
                  const collectionData = await collectionResponse.json();
                  similarCollectionsData.push(collectionData);
                }
              }
            }
          }
        }
      }
      
      // Limiter à 6 collections similaires maximum
      setSimilarCollections(similarCollectionsData.slice(0, 6));
      
      // Vérifier le statut des collections similaires après un délai
      setTimeout(() => {
        checkSimilarCollectionsStatus();
      }, 100);
    } catch (error) {
      console.error('Erreur lors de la récupération des collections similaires:', error);
    } finally {
      setLoadingSimilar(false);
    }
  };

  // Fonction pour vérifier si la collection est dans les listes
  const checkCollectionStatus = () => {
    if (!collection) return;

    // Vérifier watchlist
    const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
    setIsInWatchlist(watchlistCollections.some((item: any) => item.id === collection.id));

    // Vérifier favoris
    const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
    setIsInFavorites(favoriteCollections.some((item: any) => item.id === collection.id));
  };

  // Fonction pour vérifier le statut de toutes les collections similaires
  const checkSimilarCollectionsStatus = () => {
    const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
    const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
    
    const status: { [key: number]: { watchlist: boolean; favorites: boolean } } = {};
    
    similarCollections.forEach(similarCollection => {
      status[similarCollection.id] = {
        watchlist: watchlistCollections.some((item: any) => item.id === similarCollection.id),
        favorites: favoriteCollections.some((item: any) => item.id === similarCollection.id)
      };
    });
    
    setSimilarCollectionsStatus(status);
  };

  // Fonction pour ajouter/retirer de la watchlist
  const toggleWatchlist = () => {
    if (!collection) return;

    const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
    
    if (isInWatchlist) {
      // Retirer de la watchlist
      const updatedWatchlist = watchlistCollections.filter((item: any) => item.id !== collection.id);
      localStorage.setItem('watchlist_collections', JSON.stringify(updatedWatchlist));
      setIsInWatchlist(false);
    } else {
      // Ajouter à la watchlist
      const collectionItem = {
        id: collection.id,
        name: collection.name,
        poster_path: collection.poster_path,
        backdrop_path: collection.backdrop_path,
        overview: collection.overview,
        type: 'collection',
        addedAt: new Date().toISOString()
      };
      watchlistCollections.unshift(collectionItem);
      localStorage.setItem('watchlist_collections', JSON.stringify(watchlistCollections));
      setIsInWatchlist(true);
    }
  };

  // Fonction pour ajouter/retirer des favoris
  const toggleFavorites = () => {
    if (!collection) return;

    const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
    
    if (isInFavorites) {
      // Retirer des favoris
      const updatedFavorites = favoriteCollections.filter((item: any) => item.id !== collection.id);
      localStorage.setItem('favorite_collections', JSON.stringify(updatedFavorites));
      setIsInFavorites(false);
    } else {
      // Ajouter aux favoris
      const collectionItem = {
        id: collection.id,
        name: collection.name,
        poster_path: collection.poster_path,
        backdrop_path: collection.backdrop_path,
        overview: collection.overview,
        type: 'collection',
        addedAt: new Date().toISOString()
      };
      favoriteCollections.unshift(collectionItem);
      localStorage.setItem('favorite_collections', JSON.stringify(favoriteCollections));
      setIsInFavorites(true);
    }
  };

  // Fonction pour ouvrir le menu d'ajout à une liste
  const openAddToListMenu = () => {
    console.log('Opening AddToListMenu for collection:', collection?.id, collection?.name);
    setShowAddToListMenu(true);
  };

  // Fonction pour fermer le menu d'ajout à une liste
  const closeAddToListMenu = () => {
    setShowAddToListMenu(false);
    setSelectedCollection(null);
  };

  useEffect(() => {
    const fetchCollectionDetails = async () => {
      if (!id) return;

      try {
        setLoading(true);
        const response = await fetch(
          `${BASE_URL}/collection/${id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
        );
        
        if (!response.ok) {
          throw new Error('Collection non trouvée');
        }

        const data = await response.json();
        setCollection(data);
        
        // Récupérer les détails des films et les collections similaires
        if (data.parts && data.parts.length > 0) {
          fetchDetailedMovies(data.parts);
          fetchSimilarCollections(data.parts);
        }
      } catch (error) {
        console.error('Erreur lors de la récupération de la collection:', error);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchCollectionDetails();
  }, [id, API_KEY]);

  // Vérifier le statut de la collection quand elle change
  useEffect(() => {
    if (collection) {
      checkCollectionStatus();
    }
  }, [collection]);

  if (loading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white pt-32 pb-20">
        <div className="container mx-auto px-4 relative z-10">
          <div className="flex items-center justify-center h-64">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-red-500"></div>
            </motion.div>
          </div>
        </div>
      </SquareBackground>
    );
  }

  if (error || !collection) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white pt-32 pb-20">
        <div className="container mx-auto px-4 relative z-10">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center py-20">
            <Film size={64} className="mx-auto mb-4 text-gray-500" />
            <h1 className="text-2xl font-bold mb-4">{t('collections.notFound')}</h1>
            <p className="text-gray-400 mb-8">{t('collections.notAvailable')}</p>
            <Link
              to="/collections"
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 px-6 py-3 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
              {t('collections.backToCollections')}
            </Link>
          </motion.div>
        </div>
      </SquareBackground>
    );
  }

  if (collection.parts.length > 0 && isFilteringCollectionMoviesByAge) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white pt-32 pb-20">
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500" />
        </div>
      </SquareBackground>
    );
  }

  if (collection.parts.length > 0 && ageAllowedCollectionMovies.length === 0) return null;

  // Trier les films par date de sortie et filtrer selon les préférences
  const allMovies = [...ageAllowedCollectionMovies].sort((a, b) =>
    new Date(a.release_date || '1900-01-01').getTime() - new Date(b.release_date || '1900-01-01').getTime()
  );
  
  const moviesWithImages = allMovies.filter(movie => movie.poster_path);
  const moviesWithoutImages = allMovies.filter(movie => !movie.poster_path);
  
  const displayedMovies = showMoviesWithoutImages ? allMovies : moviesWithImages;

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.08 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white">
      {/* Hero Section */}
      <div className="relative min-h-screen">
        {/* Contenu */}
        <div className="relative z-10">
          {/* Header avec bouton retour */}
          <div className="container mx-auto px-4 pt-24 pb-8">
            <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="mb-8">
              <Link
                to="/collections"
                className="inline-flex items-center gap-2 text-white/50 hover:text-white transition-colors"
              >
                <ArrowLeft size={20} />
                {t('collections.backToCollections')}
              </Link>
            </motion.div>

            {/* Détails de la collection */}
            <div className="flex flex-col lg:flex-row gap-8 mb-12">
              {/* Poster */}
              {collection.poster_path && (
                <div className="flex-shrink-0">
                  <img
                    src={`${IMAGE_BASE_URL}${collection.poster_path}`}
                    alt={collection.name}
                    className="w-64 rounded-xl shadow-2xl"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              )}

              {/* Informations */}
              <div className="flex-1">
                <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-4xl lg:text-6xl font-black tracking-tight mb-4">
                  <ShinyText text={collection.name} speed={3} color="#ffffff" shineColor="#ef4444" className="leading-tight" />
                </motion.h1>
                
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="flex items-center gap-6 mb-6 text-gray-300">
                  <div className="flex items-center gap-2">
                    <Film size={20} />
                    <span>{t('collections.movieCount', { count: moviesWithImages.length })}</span>
                    {moviesWithoutImages.length > 0 && (
                      <span className="text-sm text-gray-500">
                        {t('collections.withoutImages', { count: moviesWithoutImages.length })}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar size={20} />
                    <span>
                      {allMovies[0]?.release_date ? new Date(allMovies[0].release_date).getFullYear() : 'N/A'} -
                      {allMovies[allMovies.length - 1]?.release_date ? new Date(allMovies[allMovies.length - 1].release_date).getFullYear() : 'N/A'}
                    </span>
                  </div>
                </motion.div>

                {collection.overview && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="text-lg lg:text-xl text-white/60 leading-relaxed max-w-3xl mb-6">
                    {collection.overview}
                  </motion.p>
                )}

                {/* Boutons d'action */}
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="flex flex-wrap items-center gap-4">
                  {/* Bouton Watchlist */}
                  <button
                    onClick={toggleWatchlist}
                    className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors duration-200 ${
                      isInWatchlist
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                    }`}
                  >
                    <Bookmark size={20} className={isInWatchlist ? 'fill-current' : ''} />
                    {isInWatchlist ? t('collections.inMyWatchlist') : t('collections.addToMyWatchlist')}
                  </button>

                  {/* Bouton Favoris */}
                  <button
                    onClick={toggleFavorites}
                    className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors duration-200 ${
                      isInFavorites
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                    }`}
                  >
                    <Heart size={20} className={isInFavorites ? 'fill-current' : ''} />
                    {isInFavorites ? t('collections.inMyFavorites') : t('collections.addToFavorites')}
                  </button>

                  {/* Bouton Ajouter à une liste */}
                  <button
                    onClick={() => {
                      console.log('Button clicked! Collection:', collection?.id, collection?.name);
                      openAddToListMenu();
                    }}
                    className="flex items-center gap-2 px-6 py-3 bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white rounded-lg font-medium transition-colors duration-200"
                  >
                    <Plus size={20} />
                    {t('collections.addToList')}
                  </button>
                </motion.div>
              </div>
            </div>
          </div>

          {/* Section Films de la collection - Superposée sur le background */}
          <div className="container mx-auto px-4 pb-12">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8 gap-4">
                <h2 className="text-2xl sm:text-3xl font-bold">
                  <ShinyText text={t('collections.movies')} speed={2} color="#ffffff" shineColor="#ef4444" />
                </h2>
                
                <div className="flex items-center gap-4">
                  {/* Toggle films sans images */}
                  {moviesWithoutImages.length > 0 && (
                    <button
                      onClick={() => setShowMoviesWithoutImages(!showMoviesWithoutImages)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                        showMoviesWithoutImages 
                          ? 'bg-red-600 text-white' 
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {showMoviesWithoutImages ? <EyeOff size={16} /> : <Eye size={16} />}
                      <span className="text-sm">
                        {showMoviesWithoutImages ? t('collections.hideWithoutImages') : t('collections.showWithoutImages')}
                      </span>
                    </button>
                  )}

                  {/* Mode d'affichage */}
                  <div className="flex bg-gray-700 rounded-lg p-1">
                    <button
                      onClick={() => setViewMode('grid')}
                      className={`p-2 rounded transition-colors ${
                        viewMode === 'grid' 
                          ? 'bg-red-600 text-white' 
                          : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      <Grid size={18} />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-2 rounded transition-colors ${
                        viewMode === 'list' 
                          ? 'bg-red-600 text-white' 
                          : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      <List size={18} />
                    </button>
                  </div>
                </div>
              </div>
              
              {/* Affichage en grille */}
              {viewMode === 'grid' && (
                <motion.div variants={containerVariants} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {displayedMovies.map((movie, index) => (
                    <motion.div key={movie.id} variants={itemVariants}>
                    <div
                      className="bg-white/[0.03] rounded-xl overflow-hidden border border-white/10 hover:border-red-500/30 transition-all duration-300 group cursor-pointer hover:bg-white/[0.06]"
                    >
                      <Link to={`/movie/${encodeId(movie.id)}`} className="block">
                        <div className="relative">
                          {movie.poster_path ? (
                            <img
                              src={`${IMAGE_BASE_URL}${movie.poster_path}`}
                              alt={movie.title}
                              className="w-full h-96 object-cover"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="w-full h-96 bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center">
                              <div className="text-center">
                                <Film size={48} className="text-gray-500 mx-auto mb-2" />
                                <p className="text-gray-500 text-sm px-4">{movie.title}</p>
                              </div>
                            </div>
                          )}
                          
                          {/* Overlay avec indicateur cliquable */}
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                            <div className="bg-red-600 hover:bg-red-700 rounded-full p-3 transition-colors">
                              <Info size={20} />
                            </div>
                          </div>

                          {/* Note */}
                          {movie.vote_average > 0 && (
                            <div className="absolute top-4 right-4 bg-black/70 rounded-full px-2 py-1 flex items-center gap-1">
                              <Star size={14} className="text-yellow-400 fill-yellow-400" />
                              <span className="text-sm font-medium">{movie.vote_average.toFixed(1)}</span>
                            </div>
                          )}

                          {/* Numéro du film dans la série */}
                          <div className="absolute top-4 left-4 bg-red-600 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">
                            {index + 1}
                          </div>
                        </div>

                        <div className="p-4">
                          <h3 className="text-lg font-semibold mb-2 line-clamp-2">{movie.title}</h3>
                          
                          <div className="flex items-center gap-2 text-sm text-gray-400 mb-3">
                            <Calendar size={14} />
                            <span>
                              {movie.release_date ? new Date(movie.release_date).getFullYear() : t('common.unknownDate')}
                            </span>
                          </div>

                          {movie.overview && (
                            <p className="text-gray-400 text-sm line-clamp-3">
                              {movie.overview}
                            </p>
                          )}
                        </div>
                      </Link>
                    </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}

              {/* Affichage en liste */}
              {viewMode === 'list' && (
                <motion.div variants={containerVariants} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }} className="space-y-4">
                  {displayedMovies.map((movie, index) => (
                    <motion.div key={movie.id} variants={itemVariants}>
                    <div
                      className="bg-white/[0.03] rounded-xl border border-white/10 hover:border-red-500/30 transition-all duration-300 group cursor-pointer hover:bg-white/[0.06]"
                    >
                      <Link to={`/movie/${encodeId(movie.id)}`} className="block">
                        <div className="flex gap-4 p-4">
                          {/* Numéro */}
                          <div className="flex-shrink-0 w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center text-sm font-bold">
                            {index + 1}
                          </div>

                          {/* Poster */}
                          <div className="flex-shrink-0 w-16 h-24 rounded overflow-hidden">
                            {movie.poster_path ? (
                              <img
                                src={`${IMAGE_BASE_URL}${movie.poster_path}`}
                                alt={movie.title}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                decoding="async"
                              />
                            ) : (
                              <div className="w-full h-full bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center">
                                <Film size={20} className="text-gray-500" />
                              </div>
                            )}
                          </div>

                          {/* Informations */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between">
                              <div className="flex-1 min-w-0">
                                <h3 className="text-lg font-semibold mb-1 truncate">{movie.title}</h3>
                                
                                <div className="flex items-center gap-4 text-sm text-gray-400 mb-2">
                                  <div className="flex items-center gap-1">
                                    <Calendar size={14} />
                                    <span>
                                      {movie.release_date ? new Date(movie.release_date).getFullYear() : t('common.unknownDate')}
                                    </span>
                                  </div>
                                  
                                  {movie.vote_average > 0 && (
                                    <div className="flex items-center gap-1">
                                      <Star size={14} className="text-yellow-400 fill-yellow-400" />
                                      <span>{movie.vote_average.toFixed(1)}</span>
                                    </div>
                                  )}
                                </div>

                                {movie.overview && (
                                  <p className="text-gray-400 text-sm line-clamp-2">
                                    {movie.overview}
                                  </p>
                                )}
                              </div>

                              {/* Indicateur cliquable */}
                              <div className="flex-shrink-0 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="bg-red-600 hover:bg-red-700 rounded-full p-2 transition-colors">
                                  <Info size={16} />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </Link>
                    </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Section Statistiques globales */}
      {collectionStats && (
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="container mx-auto px-4 py-8 relative z-10">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold mb-8 flex items-center gap-3">
              <TrendingUp className="text-red-500" />
              <ShinyText text={t('collections.globalStats')} speed={2} color="#ffffff" shineColor="#ef4444" />
            </h2>
            
            {loadingDetails ? (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-red-500"></div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Budget total */}
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <DollarSign className="text-green-400" size={24} />
                    <h3 className="text-lg font-semibold">{t('collections.totalBudget')}</h3>
                  </div>
                  <p className="text-2xl font-bold text-green-400">
                    {collectionStats.totalBudget > 0
                      ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(collectionStats.totalBudget)
                      : t('collections.notAvailableData')
                    }
                  </p>
                  <p className="text-sm text-gray-400 mt-1">
                    {t('collections.average')}: {collectionStats.averageBudget > 0
                      ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(collectionStats.averageBudget)
                      : t('collections.notAvailableData')
                    }
                  </p>
                </AnimatedBorderCard>

                {/* Revenus totaux */}
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <DollarSign className="text-blue-400" size={24} />
                    <h3 className="text-lg font-semibold">{t('collections.totalRevenue')}</h3>
                  </div>
                  <p className="text-2xl font-bold text-blue-400">
                    {collectionStats.totalRevenue > 0
                      ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(collectionStats.totalRevenue)
                      : t('collections.notAvailableData')
                    }
                  </p>
                  <p className="text-sm text-gray-400 mt-1">
                    {t('collections.average')}: {collectionStats.averageRevenue > 0
                      ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(collectionStats.averageRevenue)
                      : t('collections.notAvailableData')
                    }
                  </p>
                </AnimatedBorderCard>

                {/* Note moyenne */}
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Star className="text-yellow-400" size={24} />
                    <h3 className="text-lg font-semibold">{t('collections.averageRating')}</h3>
                  </div>
                  <p className="text-2xl font-bold text-yellow-400">
                    {collectionStats.averageRating.toFixed(1)}/10
                  </p>
                  <p className="text-sm text-gray-400 mt-1">
                    {t('collections.moviesRated', { count: collectionStats.totalMovies })}
                  </p>
                </AnimatedBorderCard>

                {/* Durée totale */}
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Film className="text-purple-400" size={24} />
                    <h3 className="text-lg font-semibold">{t('collections.totalDuration')}</h3>
                  </div>
                  <p className="text-2xl font-bold text-purple-400">
                    {Math.floor(collectionStats.totalRuntime / 60)}h {collectionStats.totalRuntime % 60}min
                  </p>
                  <p className="text-sm text-gray-400 mt-1">
                    {collectionStats.totalMovies} {t('collections.films')}
                  </p>
                </AnimatedBorderCard>

                {/* Bénéfice/Perte */}
                {collectionStats.totalBudget > 0 && collectionStats.totalRevenue > 0 && (
                  <div className="col-span-full">
                    <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                      <div className="flex items-center gap-3 mb-3">
                        <TrendingUp className={collectionStats.profitMargin > 0 ? "text-green-400" : "text-red-400"} size={24} />
                        <h3 className="text-lg font-semibold">{t('collections.profitLoss')}</h3>
                      </div>
                      <p className={`text-2xl font-bold ${collectionStats.profitMargin > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(collectionStats.totalRevenue - collectionStats.totalBudget)}
                        <span className="ml-2 text-lg">
                          ({collectionStats.profitMargin > 0 ? '+' : ''}{collectionStats.profitMargin.toFixed(1)}%)
                        </span>
                      </p>
                    </AnimatedBorderCard>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Section Informations de production */}
      {productionInfo && (
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="container mx-auto px-4 py-8 relative z-10">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold mb-8 flex items-center gap-3">
              <Building className="text-red-500" />
              <ShinyText text={t('collections.productionInfo')} speed={2} color="#ffffff" shineColor="#ef4444" />
            </h2>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Sociétés de production */}
              {productionInfo.productionCompanies.length > 0 && (
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <Building className="text-blue-400" size={24} />
                    <h3 className="text-xl font-semibold">{t('collections.productionCompanies')}</h3>
                  </div>
                  <div className="space-y-3">
                    {productionInfo.productionCompanies.map((company) => (
                      <div key={company.id} className="flex justify-between items-center">
                        <span className="text-gray-300">{company.name}</span>
                        <span className="text-gray-400 text-sm bg-gray-700 px-2 py-1 rounded">
                          {t('collections.filmCount', { count: company.count })}
                        </span>
                      </div>
                    ))}
                  </div>
                </AnimatedBorderCard>
              )}

              {/* Pays de production */}
              {productionInfo.productionCountries.length > 0 && (
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <MapPin className="text-green-400" size={24} />
                    <h3 className="text-xl font-semibold">{t('collections.productionCountries')}</h3>
                  </div>
                  <div className="space-y-3">
                    {productionInfo.productionCountries.map((country) => (
                      <div key={country.code} className="flex justify-between items-center">
                        <span className="text-gray-300">{country.name}</span>
                        <span className="text-gray-400 text-sm bg-gray-700 px-2 py-1 rounded">
                          {t('collections.filmCount', { count: country.count })}
                        </span>
                      </div>
                    ))}
                  </div>
                </AnimatedBorderCard>
              )}

              {/* Langues */}
              {productionInfo.spokenLanguages.length > 0 && (
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <Languages className="text-purple-400" size={24} />
                    <h3 className="text-xl font-semibold">{t('collections.languages')}</h3>
                  </div>
                  <div className="space-y-3">
                    {productionInfo.spokenLanguages.map((language) => (
                      <div key={language.code} className="flex justify-between items-center">
                        <span className="text-gray-300">{language.name}</span>
                        <span className="text-gray-400 text-sm bg-gray-700 px-2 py-1 rounded">
                          {t('collections.filmCount', { count: language.count })}
                        </span>
                      </div>
                    ))}
                  </div>
                </AnimatedBorderCard>
              )}

              {/* Genres */}
              {productionInfo.genres.length > 0 && (
                <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="12 12 12" className="p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <Film className="text-orange-400" size={24} />
                    <h3 className="text-xl font-semibold">{t('collections.mainGenres')}</h3>
                  </div>
                  <div className="space-y-3">
                    {productionInfo.genres.map((genre) => (
                      <div key={genre.id} className="flex justify-between items-center">
                        <span className="text-gray-300">{genre.name}</span>
                        <span className="text-gray-400 text-sm bg-gray-700 px-2 py-1 rounded">
                          {t('collections.filmCount', { count: genre.count })}
                        </span>
                      </div>
                    ))}
                  </div>
                </AnimatedBorderCard>
              )}
            </div>
          </div>
        </motion.div>
      )}


      {/* Section Collections similaires - En bas avec fond noir */}
      {similarCollections.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="py-12 relative z-10">
          <div className="container mx-auto px-4">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold mb-8">
                <ShinyText text={t('collections.similarCollections')} speed={2} color="#ffffff" shineColor="#ef4444" />
              </h2>
              
              {loadingSimilar ? (
                <div className="flex items-center justify-center h-32">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-red-500"></div>
                </div>
              ) : (
                <motion.div variants={containerVariants} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {similarCollections.map((similarCollection) => (
                    <motion.div key={similarCollection.id} variants={itemVariants}>
                    <div
                      className="bg-white/[0.03] rounded-xl overflow-hidden border border-white/10 hover:border-red-500/30 transition-all duration-300 group cursor-pointer hover:bg-white/[0.06]"
                    >
                      <Link to={`/collection/${similarCollection.id}`} className="block">
                        <div className="relative">
                          {similarCollection.backdrop_path ? (
                            <img
                              src={getOptimizedImageUrl(similarCollection.backdrop_path, 'medium')}
                              alt={similarCollection.name}
                              className="w-full h-48 object-cover"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="w-full h-48 bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center">
                              <Film size={48} className="text-gray-500" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                          <div className="absolute bottom-4 left-4 right-4">
                            <h3 className="text-xl font-bold text-white mb-2">{similarCollection.name}</h3>
                            <div className="flex items-center gap-2 text-sm text-gray-300">
                              <Film size={16} />
                              <span>{similarCollection.parts?.filter(movie => movie.poster_path).length || 0} {t('collections.films')}</span>
                            </div>
                          </div>
                        </div>
                        
                        <div className="p-4">
                          {/* Boutons d'action */}
                          <div className="flex items-center gap-2 mb-4">
                            {/* Bouton Watchlist */}
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                
                                const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
                                const currentStatus = similarCollectionsStatus[similarCollection.id]?.watchlist || false;
                                
                                if (currentStatus) {
                                  // Retirer de la watchlist
                                  const updatedWatchlist = watchlistCollections.filter((item: any) => item.id !== similarCollection.id);
                                  localStorage.setItem('watchlist_collections', JSON.stringify(updatedWatchlist));
                                } else {
                                  // Ajouter à la watchlist
                                  const collectionItem = {
                                    id: similarCollection.id,
                                    name: similarCollection.name,
                                    poster_path: similarCollection.poster_path,
                                    backdrop_path: similarCollection.backdrop_path,
                                    overview: similarCollection.overview,
                                    type: 'collection',
                                    addedAt: new Date().toISOString()
                                  };
                                  watchlistCollections.unshift(collectionItem);
                                  localStorage.setItem('watchlist_collections', JSON.stringify(watchlistCollections));
                                }
                                
                                // Mettre à jour l'état local
                                setSimilarCollectionsStatus(prev => ({
                                  ...prev,
                                  [similarCollection.id]: {
                                    ...prev[similarCollection.id],
                                    watchlist: !currentStatus
                                  }
                                }));
                              }}
                              className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs rounded-lg transition-colors ${
                                similarCollectionsStatus[similarCollection.id]?.watchlist
                                  ? 'bg-blue-700 hover:bg-blue-800'
                                  : 'bg-blue-600 hover:bg-blue-700'
                              }`}
                            >
                              <Bookmark size={14} className={similarCollectionsStatus[similarCollection.id]?.watchlist ? 'fill-current' : ''} />
                              {similarCollectionsStatus[similarCollection.id]?.watchlist ? t('collections.remove') : t('collections.watchlist')}
                            </button>

                            {/* Bouton Favoris */}
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                
                                const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
                                const currentStatus = similarCollectionsStatus[similarCollection.id]?.favorites || false;
                                
                                if (currentStatus) {
                                  // Retirer des favoris
                                  const updatedFavorites = favoriteCollections.filter((item: any) => item.id !== similarCollection.id);
                                  localStorage.setItem('favorite_collections', JSON.stringify(updatedFavorites));
                                } else {
                                  // Ajouter aux favoris
                                  const collectionItem = {
                                    id: similarCollection.id,
                                    name: similarCollection.name,
                                    poster_path: similarCollection.poster_path,
                                    backdrop_path: similarCollection.backdrop_path,
                                    overview: similarCollection.overview,
                                    type: 'collection',
                                    addedAt: new Date().toISOString()
                                  };
                                  favoriteCollections.unshift(collectionItem);
                                  localStorage.setItem('favorite_collections', JSON.stringify(favoriteCollections));
                                }
                                
                                // Mettre à jour l'état local
                                setSimilarCollectionsStatus(prev => ({
                                  ...prev,
                                  [similarCollection.id]: {
                                    ...prev[similarCollection.id],
                                    favorites: !currentStatus
                                  }
                                }));
                              }}
                              className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs rounded-lg transition-colors ${
                                similarCollectionsStatus[similarCollection.id]?.favorites
                                  ? 'bg-red-700 hover:bg-red-800'
                                  : 'bg-red-600 hover:bg-red-700'
                              }`}
                            >
                              <Heart size={14} className={similarCollectionsStatus[similarCollection.id]?.favorites ? 'fill-current' : ''} />
                              {similarCollectionsStatus[similarCollection.id]?.favorites ? t('collections.remove') : t('collections.favorites')}
                            </button>

                            {/* Bouton Ajouter à une liste */}
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                // Ouvrir le menu d'ajout à une liste pour cette collection
                                setSelectedCollection(similarCollection);
                                setShowAddToListMenu(true);
                              }}
                              className="flex items-center gap-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-xs rounded-lg transition-colors"
                            >
                              <Plus size={14} />
                              {t('collections.list')}
                            </button>
                          </div>

                          <p className="text-gray-300 text-sm mb-4 line-clamp-3">
                            {similarCollection.overview || t('collections.discoverCollection')}
                          </p>
                          
                          <div className="flex items-center justify-between">
                            <div className="flex gap-2">
                              {(() => {
                                const totalMovies = similarCollection.parts?.filter(movie => movie.poster_path).length || 0;
                                const maxDisplayed = 5; // Maximum 5 films affichés
                                const moviesToShow = Math.min(totalMovies, maxDisplayed);
                                
                                // Si on a 5 films ou moins, on les affiche tous
                                if (totalMovies <= 5) {
                                  return similarCollection.parts?.slice(0, moviesToShow).map((movie) => (
                                    <div
                                      key={movie.id}
                                      className="w-14 h-20 sm:w-12 sm:h-16 rounded overflow-hidden hover:scale-110 transition-transform border border-gray-600"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {movie.poster_path ? (
                                        <img
                                          src={getOptimizedImageUrl(movie.poster_path, 'small')}
                                          alt={movie.title}
                                          className="w-full h-full object-cover"
                                          loading="lazy"
                                          decoding="async"
                                        />
                                      ) : (
                                        <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                                          <Film size={16} className="text-gray-500" />
                                        </div>
                                      )}
                                    </div>
                                  ));
                                } else {
                                  // Si on a plus de 5 films, on affiche 4 images + 1 compteur
                                  return (
                                    <>
                                      {similarCollection.parts?.slice(0, 4).map((movie) => (
                                        <div
                                          key={movie.id}
                                          className="w-14 h-20 sm:w-12 sm:h-16 rounded overflow-hidden hover:scale-110 transition-transform border border-gray-600"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {movie.poster_path ? (
                                            <img
                                              src={getOptimizedImageUrl(movie.poster_path, 'small')}
                                              alt={movie.title}
                                              className="w-full h-full object-cover"
                                              loading="lazy"
                                              decoding="async"
                                            />
                                          ) : (
                                            <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                                              <Film size={16} className="text-gray-500" />
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                      <div className="w-14 h-20 sm:w-12 sm:h-16 bg-gray-700/50 rounded flex items-center justify-center text-xs text-gray-400 border border-gray-600">
                                        +{totalMovies - 4}
                                      </div>
                                    </>
                                  );
                                }
                              })()}
                            </div>
                          </div>
                        </div>
                      </Link>
                    </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Menu d'ajout à une liste */}
      {showAddToListMenu && (collection || selectedCollection) && (
        <>
          {console.log('Rendering AddToListMenu with:', { 
            showAddToListMenu, 
            collectionId: selectedCollection?.id || collection?.id, 
            collectionName: selectedCollection?.name || collection?.name 
          })}
          <AddToListMenu
            mediaId={selectedCollection?.id || collection?.id || 0}
            mediaType="collection"
            title={selectedCollection?.name || collection?.name || ''}
            posterPath={selectedCollection?.poster_path || collection?.poster_path || ''}
            movieCount={selectedCollection?.parts?.length || collection?.parts?.length || 0}
            onClose={closeAddToListMenu}
          />
        </>
      )}
    </SquareBackground>
  );
};

export default CollectionDetails;
