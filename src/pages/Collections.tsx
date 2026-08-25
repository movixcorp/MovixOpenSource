import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Search, Grid, List, Heart, Bookmark, Plus } from 'lucide-react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion, AnimatePresence } from 'framer-motion';
import AddToListMenu from '../components/AddToListMenu';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import { getTmdbLanguage } from '../i18n';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';


// Clés i18n pour les textes accrocheurs (collections.catchyText1 à catchyText5)
const CATCHY_TEXT_KEYS = [
  'collections.catchyText1',
  'collections.catchyText2',
  'collections.catchyText3',
  'collections.catchyText4',
  'collections.catchyText5',
];

// Mots à mettre en valeur (FR + EN)
const highlightWords = [
  'Harry Potter', 'MCU',
  // French
  'magie', 'mondes', 'légendes', 'marathon', 'univers', 'mythiques', 'favoris', 'collections', 'marquantes', 'cultes', 'héros',
  // English
  'magic', 'worlds', 'legends', 'universe', 'universes', 'iconic', 'favorites', 'favorite', 'unforgettable', 'heroes', 'mythical', 'cinema',
];

// Découpe un texte en mots individuels avec détection des mots en surbrillance
const splitTextIntoWords = (text: string): { text: string; highlight: boolean; isSpace: boolean }[] => {
  const pattern = highlightWords.map(w => `\\b${w}\\b`).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const segments = text.split(regex);
  const result: { text: string; highlight: boolean; isSpace: boolean }[] = [];

  segments.filter(Boolean).forEach(part => {
    const isHighlight = highlightWords.some(w => part.toLowerCase() === w.toLowerCase());
    if (isHighlight) {
      result.push({ text: part, highlight: true, isSpace: false });
    } else {
      // Découpe les segments normaux en mots + espaces pour un retour à la ligne naturel
      part.split(/(\s+)/).filter(Boolean).forEach(word => {
        result.push({
          text: word,
          highlight: false,
          isSpace: /^\s+$/.test(word),
        });
      });
    }
  });
  return result;
};

interface Collection {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  parts: Array<{
    id: number;
    title: string;
    release_date: string;
    poster_path: string | null;
    vote_average?: number;
  }>;
}

interface Movie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average?: number;
  belongs_to_collection?: {
    id: number;
    name: string;
  };
}

// ─── Module-scope card components ────────────────────────────────────────────
// Defined OUTSIDE Collections so React keeps a stable component type across
// parent re-renders. If declared inline, every parent state change creates a
// fresh function reference → React unmounts and remounts every card,
// neutralizing React.memo and triggering full poster re-decodes.

type CollectionsStatusMap = {
  [key: number]: { watchlist: boolean; favorites: boolean };
};

type SetCollectionsStatus = React.Dispatch<React.SetStateAction<CollectionsStatusMap>>;

type TFunction = (key: string, options?: Record<string, unknown>) => string;

interface CollectionCardProps {
  collection: Collection;
  index: number;
  isNew?: boolean;
  collectionsStatus: CollectionsStatusMap;
  setCollectionsStatus: SetCollectionsStatus;
  openAddToListMenu: (collection: Collection) => void;
  getOptimizedImageUrl: (path: string, size?: 'small' | 'medium' | 'large') => string;
  t: TFunction;
}

const CollectionCard: React.FC<CollectionCardProps> = React.memo(({
  collection,
  collectionsStatus,
  setCollectionsStatus,
  openAddToListMenu,
  getOptimizedImageUrl,
  t,
}) => {
  const { items: ageAllowedParts } = useAgeRestrictedContent(
    (collection.parts || []).map((movie) => ({ ...movie, media_type: 'movie' as const })),
  );

  if (collection.parts?.length > 0 && ageAllowedParts.length === 0) return null;

  return (
    <Link to={`/collection/${collection.id}`}>
      <div
        className="bg-white/[0.03] rounded-xl overflow-hidden border border-white/10 hover:border-red-500/30 transition-all duration-300 group cursor-pointer hover:bg-white/[0.06]"
      >
      <div className="relative">
        {collection.backdrop_path ? (
          <img
            src={getOptimizedImageUrl(collection.backdrop_path, 'medium')}
            alt={collection.name}
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
          <h3 className="text-xl font-bold text-white mb-2">{collection.name}</h3>
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <Film size={16} />
            <span>{ageAllowedParts.filter(movie => movie.poster_path).length || 0} {t('collections.films')}</span>
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
              const currentStatus = collectionsStatus[collection.id]?.watchlist || false;

              if (currentStatus) {
                // Retirer de la watchlist
                const updatedWatchlist = watchlistCollections.filter((item: any) => item.id !== collection.id);
                localStorage.setItem('watchlist_collections', JSON.stringify(updatedWatchlist));
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
              }

              // Mettre à jour l'état local
              setCollectionsStatus(prev => ({
                ...prev,
                [collection.id]: {
                  ...prev[collection.id],
                  watchlist: !currentStatus
                }
              }));
            }}
            className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs rounded-lg transition-colors ${
              collectionsStatus[collection.id]?.watchlist
                ? 'bg-blue-700 hover:bg-blue-800'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            <Bookmark size={14} className={collectionsStatus[collection.id]?.watchlist ? 'fill-current' : ''} />
            {collectionsStatus[collection.id]?.watchlist ? t('collections.remove') : t('collections.watchlist')}
          </button>

          {/* Bouton Favoris */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();

              const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
              const currentStatus = collectionsStatus[collection.id]?.favorites || false;

              if (currentStatus) {
                // Retirer des favoris
                const updatedFavorites = favoriteCollections.filter((item: any) => item.id !== collection.id);
                localStorage.setItem('favorite_collections', JSON.stringify(updatedFavorites));
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
              }

              // Mettre à jour l'état local
              setCollectionsStatus(prev => ({
                ...prev,
                [collection.id]: {
                  ...prev[collection.id],
                  favorites: !currentStatus
                }
              }));
            }}
            className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs rounded-lg transition-colors ${
              collectionsStatus[collection.id]?.favorites
                ? 'bg-red-700 hover:bg-red-800'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            <Heart size={14} className={collectionsStatus[collection.id]?.favorites ? 'fill-current' : ''} />
            {collectionsStatus[collection.id]?.favorites ? t('collections.remove') : t('collections.favorites')}
          </button>

          {/* Bouton Ajouter à une liste */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openAddToListMenu(collection);
            }}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-xs rounded-lg transition-colors"
          >
            <Plus size={14} />
            {t('collections.list')}
          </button>
        </div>

        <p className="text-gray-300 text-sm mb-4 line-clamp-3">
          {collection.overview || t('collections.discoverCollection')}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {(() => {
              const totalMovies = ageAllowedParts.filter(movie => movie.poster_path).length || 0;
              const maxDisplayed = 5; // Maximum 5 films affichés
              const moviesToShow = Math.min(totalMovies, maxDisplayed);

              // Si on a 5 films ou moins, on les affiche tous
              if (totalMovies <= 5) {
                return ageAllowedParts.slice(0, moviesToShow).map((movie) => (
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
                   {ageAllowedParts.slice(0, 4).map((movie) => (
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
    </div>
    </Link>
  );
}, (prevProps, nextProps) => {
  // Re-render only if the collection identity, isNew flag, or this collection's
  // status slice changes. Status comparison is per-id so toggling card #50's
  // favorite doesn't invalidate cards #1-49.
  if (prevProps.collection.id !== nextProps.collection.id) return false;
  if (prevProps.isNew !== nextProps.isNew) return false;
  const prevStatus = prevProps.collectionsStatus[prevProps.collection.id];
  const nextStatus = nextProps.collectionsStatus[nextProps.collection.id];
  if (prevStatus?.watchlist !== nextStatus?.watchlist) return false;
  if (prevStatus?.favorites !== nextStatus?.favorites) return false;
  return true;
});

interface CollectionListItemProps {
  collection: Collection;
  index: number;
  isNew?: boolean;
  collectionsStatus: CollectionsStatusMap;
  setCollectionsStatus: SetCollectionsStatus;
  openAddToListMenu: (collection: Collection) => void;
  getOptimizedImageUrl: (path: string, size?: 'small' | 'medium' | 'large') => string;
  t: TFunction;
}

const CollectionListItem: React.FC<CollectionListItemProps> = React.memo(({
  collection,
  collectionsStatus,
  setCollectionsStatus,
  openAddToListMenu,
  getOptimizedImageUrl,
  t,
}) => {
  // Calculer combien de films afficher
  const totalMovies = collection.parts?.filter(movie => movie.poster_path).length || 0;
  const maxDisplayed = 3; // Maximum 3 films affichés
  const moviesToShow = Math.min(totalMovies, maxDisplayed);
  const remainingMovies = totalMovies - moviesToShow;

  return (
    <Link to={`/collection/${collection.id}`}>
      <div
        className="bg-white/[0.03] rounded-xl p-6 border border-white/10 hover:border-red-500/30 transition-all duration-300 cursor-pointer group hover:bg-white/[0.06]"
      >
        <div className="flex items-center gap-6">
          {/* Poster */}
          <div className="flex-shrink-0">
            {collection.poster_path ? (
              <img
                src={getOptimizedImageUrl(collection.poster_path, 'small')}
                alt={collection.name}
                className="w-20 h-28 object-cover rounded-lg"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="w-20 h-28 bg-gray-700 rounded-lg flex items-center justify-center">
                <Film size={32} className="text-gray-500" />
              </div>
            )}
          </div>

          {/* Contenu */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-4 mb-2">
              <h3 className="text-xl font-bold text-white truncate">{collection.name}</h3>
              <div className="flex items-center gap-1 bg-red-500/20 px-2 py-1 rounded-full">
                <Film size={14} className="text-red-400" />
                <span className="text-sm text-red-400 font-medium">
                  {totalMovies}
                </span>
              </div>
            </div>

            {/* Boutons d'action */}
            <div className="flex items-center gap-2 mb-4">
              {/* Bouton Watchlist */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
                  const currentStatus = collectionsStatus[collection.id]?.watchlist || false;

                  if (currentStatus) {
                    // Retirer de la watchlist
                    const updatedWatchlist = watchlistCollections.filter((item: any) => item.id !== collection.id);
                    localStorage.setItem('watchlist_collections', JSON.stringify(updatedWatchlist));
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
                  }

                  // Mettre à jour l'état local
                  setCollectionsStatus(prev => ({
                    ...prev,
                    [collection.id]: {
                      ...prev[collection.id],
                      watchlist: !currentStatus
                    }
                  }));
                }}
                className={`flex items-center gap-1 px-2 py-1 text-white text-xs rounded transition-colors ${
                  collectionsStatus[collection.id]?.watchlist
                    ? 'bg-blue-700 hover:bg-blue-800'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <Bookmark size={12} className={collectionsStatus[collection.id]?.watchlist ? 'fill-current' : ''} />
                {collectionsStatus[collection.id]?.watchlist ? t('collections.remove') : t('collections.watchlist')}
              </button>

              {/* Bouton Favoris */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
                  const currentStatus = collectionsStatus[collection.id]?.favorites || false;

                  if (currentStatus) {
                    // Retirer des favoris
                    const updatedFavorites = favoriteCollections.filter((item: any) => item.id !== collection.id);
                    localStorage.setItem('favorite_collections', JSON.stringify(updatedFavorites));
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
                  }

                  // Mettre à jour l'état local
                  setCollectionsStatus(prev => ({
                    ...prev,
                    [collection.id]: {
                      ...prev[collection.id],
                      favorites: !currentStatus
                    }
                  }));
                }}
                className={`flex items-center gap-1 px-2 py-1 text-white text-xs rounded transition-colors ${
                  collectionsStatus[collection.id]?.favorites
                    ? 'bg-red-700 hover:bg-red-800'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                <Heart size={12} className={collectionsStatus[collection.id]?.favorites ? 'fill-current' : ''} />
                {collectionsStatus[collection.id]?.favorites ? t('collections.remove') : t('collections.favorites')}
              </button>

              {/* Bouton Ajouter à une liste */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openAddToListMenu(collection);
                }}
                className="flex items-center gap-1 px-2 py-1 bg-gray-600 hover:bg-gray-700 text-white text-xs rounded transition-colors"
              >
                <Plus size={12} />
                {t('collections.list')}
              </button>
            </div>

            <p className="text-gray-300 text-sm mb-4 line-clamp-2">
              {collection.overview || t('collections.discoverCollection')}
            </p>

            {/* Preview des films */}
            <div className="flex items-center gap-2">
              {collection.parts?.slice(0, moviesToShow).map((movie) => (
                <div
                  key={movie.id}
                  className="w-12 h-16 rounded overflow-hidden hover:scale-110 transition-transform border border-gray-600"
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
                      <Film size={12} className="text-gray-500" />
                    </div>
                  )}
                </div>
              ))}
              {remainingMovies > 0 && (
                <div className="w-12 h-16 bg-gray-700/50 rounded flex items-center justify-center text-xs text-gray-400 border border-gray-600">
                  +{remainingMovies}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}, (prevProps, nextProps) => {
  if (prevProps.collection.id !== nextProps.collection.id) return false;
  if (prevProps.isNew !== nextProps.isNew) return false;
  const prevStatus = prevProps.collectionsStatus[prevProps.collection.id];
  const nextStatus = nextProps.collectionsStatus[nextProps.collection.id];
  if (prevStatus?.watchlist !== nextStatus?.watchlist) return false;
  if (prevStatus?.favorites !== nextStatus?.favorites) return false;
  return true;
});

const Collections: React.FC = () => {
  const { t } = useTranslation();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [filteredCollections, setFilteredCollections] = useState<Collection[]>([]);
  const [popularMovies, setPopularMovies] = useState<Movie[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [randomText, setRandomText] = useState('');
  const [loadingProgress, setLoadingProgress] = useState('');
  const [hasMoreCollections, setHasMoreCollections] = useState(true);
  const [currentPage, setCurrentPage] = useState(3); // Commence à 4 car on a déjà chargé les pages 1-3
  const [newCollectionIds, setNewCollectionIds] = useState<Set<number>>(new Set()); // Pour tracker les nouvelles collections
  const [displayMode, setDisplayMode] = useState<'cards' | 'list'>('cards'); // Mode par défaut
  
  // Optimisation des performances avec debounce pour les changements de mode
  const [debouncedDisplayMode, setDebouncedDisplayMode] = useState(displayMode);
  
  // États pour le menu d'ajout à une liste
  const [showAddToListMenu, setShowAddToListMenu] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<Collection | null>(null);
  
  // États pour le statut des collections (watchlist et favoris)
  const [collectionsStatus, setCollectionsStatus] = useState<{
    [key: number]: { watchlist: boolean; favorites: boolean }
  }>({});
  
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedDisplayMode(displayMode);
    }, 100);
    
    return () => clearTimeout(timeoutId);
  }, [displayMode]);



  const API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
  const BASE_URL = 'https://api.themoviedb.org/3';
  const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
  
  // Clés de cache pour le sessionStorage
  const CACHE_KEYS = {
    collections: 'tmdb_collections_cache',
    cacheTime: 'tmdb_collections_cache_time',
    lastPage: 'tmdb_collections_last_page',
    loadMoreDebounce: 'lastLoadMoreCall'
  };
  
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

  // Sélectionner un texte accrocheur aléatoire au chargement
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * CATCHY_TEXT_KEYS.length);
    setRandomText(t(CATCHY_TEXT_KEYS[randomIndex]));
  }, [t]);

  // Récupérer les films/séries populaires et extraire les collections
  useEffect(() => {
    const fetchPopularContentAndCollections = async () => {
      try {
        setLoading(true);
        
        // Vérifier la dernière page découverte dans le cache
        const cachedLastPage = sessionStorage.getItem(CACHE_KEYS.lastPage);
        const lastPage = cachedLastPage ? parseInt(cachedLastPage) : 3;
        
        // Réinitialiser l'état d'infinity scroll
        setHasMoreCollections(true);
        setCurrentPage(lastPage);
        setNewCollectionIds(new Set());
        
        // Vérifier le cache de session
        const cacheExpiration = 24 * 60 * 60 * 1000; // 24 heures
        
        const cachedData = sessionStorage.getItem(CACHE_KEYS.collections);
        const cacheTime = sessionStorage.getItem(CACHE_KEYS.cacheTime);
        
        if (cachedData && cacheTime) {
          const timeDiff = Date.now() - parseInt(cacheTime);
          if (timeDiff < cacheExpiration) {
            console.log('Utilisation du cache pour les collections');
            const cachedCollections = JSON.parse(cachedData);
            setCollections(cachedCollections);
            setFilteredCollections(cachedCollections);
            // Réinitialiser l'infinity scroll même avec le cache
            setHasMoreCollections(true);
            setCurrentPage(lastPage);
            setNewCollectionIds(new Set());
            setLoading(false);
            return;
          }
        }
        
        console.log('Récupération des collections depuis l\'API...');
        setLoadingProgress(t('collections.loadingPopularMovies'));
        const collectionsMap = new Map<number, Collection>();
        
        // Fonction pour traiter les films d'une page
        const processMoviesFromPage = async (page: number) => {
          const moviesResponse = await fetch(
            `${BASE_URL}/discover/movie?api_key=${API_KEY}&sort_by=popularity.desc&page=${page}&include_adult=false&language=${getTmdbLanguage()}&vote_count.gte=1000&vote_average.gte=6.0&with_original_language=en`
          );
          const moviesData = await moviesResponse.json();
          
          // Traiter les films par lots pour éviter trop de requêtes simultanées
          const batchSize = 5;
          for (let i = 0; i < moviesData.results.length; i += batchSize) {
            const batch = moviesData.results.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (movie: any) => {
              try {
                const movieDetailResponse = await fetch(
                  `${BASE_URL}/movie/${movie.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
                );
                const movieDetail = await movieDetailResponse.json();
                
                if (movieDetail.belongs_to_collection && !collectionsMap.has(movieDetail.belongs_to_collection.id)) {
                  const collectionId = movieDetail.belongs_to_collection.id;
                  
                  try {
                    const collectionResponse = await fetch(
                      `${BASE_URL}/collection/${collectionId}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
                    );
                    const collectionData = await collectionResponse.json();
                    
                                         // Ne garder que les collections avec au moins 2 films, des images et pas de contenu adulte
                     const adultKeywords = ['365', 'fifty shades', 'nymphomaniac', 'love', 'erotic', 'sex', 'adult', 'xxx'];
                     const isAdultCollection = (collection: any) => {
                       const name = collection.name.toLowerCase();
                       const overview = (collection.overview || '').toLowerCase();
                       return adultKeywords.some(keyword => 
                         name.includes(keyword) || overview.includes(keyword)
                       ) || collection.parts?.some((movie: any) => movie.adult === true);
                     };

                     if (collectionData.parts && 
                         collectionData.parts.length >= 2 && 
                         (collectionData.backdrop_path || collectionData.poster_path) &&
                         !isAdultCollection(collectionData)) {
                       // Filtrer les films avec des images pour le comptage correct
                       const moviesWithImages = collectionData.parts.filter((movie: any) => movie.poster_path);
                       if (moviesWithImages.length >= 2) {
                         collectionsMap.set(collectionId, {
                           ...collectionData,
                           parts: collectionData.parts // Garder tous les films pour l'instant
                         });
                       }
                     }
                  } catch (error) {
                    console.error(`Erreur lors de la récupération de la collection ${collectionId}:`, error);
                  }
                }
              } catch (error) {
                console.error(`Erreur lors de la récupération des détails du film ${movie.id}:`, error);
              }
            }));
            
            // Petite pause entre les lots pour éviter de surcharger l'API
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        };

        // Récupérer plusieurs pages pour avoir plus de collections
        await Promise.all([
          processMoviesFromPage(1),
          processMoviesFromPage(2),
          processMoviesFromPage(3)
        ]);

        setLoadingProgress(t('collections.addingPopularCollections'));
        // Ajouter quelques collections populaires manuellement si on en a pas assez
        const popularCollectionIds = [
          10, // Star Wars Collection
          1241, // Harry Potter Collection
          531241, // Spider-Man (Avengers) Collection
          623, // X-Men Collection
          2344, // The Matrix Collection
          8091, // Alien Collection
          8250, // Fast & Furious Collection
          9485, // The Fast and the Furious Collection
          86311, // The Avengers Collection
          131295, // Iron Man Collection
          131296, // Thor Collection
          131292, // Captain America Collection
          748, // The Lord of the Rings Collection
          121938, // The Hobbit Collection
          1570, // Die Hard Collection
          528, // The Terminator Collection
          945, // Jurassic Park Collection
          295, // Pirates of the Caribbean Collection
          87359, // Mission: Impossible Collection
          8917 // Shrek Collection
        ];

        // Ajouter les collections populaires manquantes
        for (const collectionId of popularCollectionIds) {
          if (!collectionsMap.has(collectionId)) {
            try {
              const collectionResponse = await fetch(
                `${BASE_URL}/collection/${collectionId}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
              );
                                             if (collectionResponse.ok) {
                  const collectionData = await collectionResponse.json();
                  const adultKeywords = ['365', 'fifty shades', 'nymphomaniac', 'love', 'erotic', 'sex', 'adult', 'xxx'];
                  const isAdultCollection = (collection: any) => {
                    const name = collection.name.toLowerCase();
                    const overview = (collection.overview || '').toLowerCase();
                    return adultKeywords.some(keyword => 
                      name.includes(keyword) || overview.includes(keyword)
                    ) || collection.parts?.some((movie: any) => movie.adult === true);
                  };

                  if (collectionData.parts && 
                      collectionData.parts.length >= 2 && 
                      (collectionData.backdrop_path || collectionData.poster_path) &&
                      !isAdultCollection(collectionData)) {
                    const moviesWithImages = collectionData.parts.filter((movie: any) => movie.poster_path);
                    if (moviesWithImages.length >= 2) {
                      collectionsMap.set(collectionId, collectionData);
                    }
                  }
                }
            } catch (error) {
              console.error(`Erreur lors de la récupération de la collection populaire ${collectionId}:`, error);
            }
          }
        }

        setLoadingProgress(t('collections.finalizing'));
        // Trier les collections par popularité (nombre de films et note moyenne)
        const sortedCollections = Array.from(collectionsMap.values()).sort((a, b) => {
          const scoreA = a.parts.length * (a.parts.reduce((sum, movie) => sum + (movie.vote_average || 0), 0) / a.parts.length || 0);
          const scoreB = b.parts.length * (b.parts.reduce((sum, movie) => sum + (movie.vote_average || 0), 0) / b.parts.length || 0);
          return scoreB - scoreA;
        });

        setCollections(sortedCollections);
        setFilteredCollections(sortedCollections);
        console.log(`${sortedCollections.length} collections récupérées`);
        
        // Vérifier le statut des collections
        setTimeout(() => {
          checkCollectionsStatus();
        }, 100);
        
        // Sauvegarder dans le cache de session
        sessionStorage.setItem(CACHE_KEYS.collections, JSON.stringify(sortedCollections));
        sessionStorage.setItem(CACHE_KEYS.cacheTime, Date.now().toString());
        
      } catch (error) {
        console.error('Erreur lors de la récupération des données:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPopularContentAndCollections();
  }, [API_KEY]);

  // Fonction pour charger plus de collections
  const loadMoreCollections = async () => {
    if (loadingMore || !hasMoreCollections) {
      return;
    }
    
    // Débounce pour éviter les appels trop fréquents
    const now = Date.now();
    const lastCall = parseInt(sessionStorage.getItem(CACHE_KEYS.loadMoreDebounce) || '0');
    if (now - lastCall < 2000) { // Minimum 2 secondes entre les appels
      return;
    }
    sessionStorage.setItem(CACHE_KEYS.loadMoreDebounce, now.toString());

    setLoadingMore(true);
    try {
      const nextPage = currentPage + 1;
      const collectionsMap = new Map<number, Collection>();
      
      // Ajouter les collections existantes dans la map
      collections.forEach(collection => {
        collectionsMap.set(collection.id, collection);
      });

      // Liste des mots-clés pour filtrer le contenu adulte
      const adultKeywords = ['365', 'fifty shades', 'nymphomaniac', 'love', 'erotic', 'sex', 'adult', 'xxx'];
      
      // Fonction pour vérifier si une collection est pour adultes
      const isAdultCollection = (collection: any) => {
        const name = collection.name.toLowerCase();
        const overview = (collection.overview || '').toLowerCase();
        return adultKeywords.some(keyword => 
          name.includes(keyword) || overview.includes(keyword)
        ) || collection.parts?.some((movie: any) => 
          movie.adult === true || 
          (movie.genre_ids && movie.genre_ids.includes(18)) // Genre documentaire parfois utilisé pour contenu adulte
        );
      };

      // Fonction pour traiter les films d'une page
      const processMoviesFromPage = async (page: number) => {
        const moviesResponse = await fetch(
          `${BASE_URL}/discover/movie?api_key=${API_KEY}&sort_by=popularity.desc&page=${page}&include_adult=false&language=${getTmdbLanguage()}&vote_count.gte=1000&vote_average.gte=6.0&with_original_language=en`
        );
        const moviesData = await moviesResponse.json();
        
        if (!moviesData.results || moviesData.results.length === 0) {
          setHasMoreCollections(false);
          return;
        }
        
        // Traiter les films par lots pour éviter trop de requêtes simultanées
        const batchSize = 3; // Réduire la taille du lot pour aller plus vite
        for (let i = 0; i < moviesData.results.length; i += batchSize) {
          const batch = moviesData.results.slice(i, i + batchSize);
          
          await Promise.all(batch.map(async (movie: any) => {
            try {
              const movieDetailResponse = await fetch(
                `${BASE_URL}/movie/${movie.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
              );
              const movieDetail = await movieDetailResponse.json();
              
              if (movieDetail.belongs_to_collection && !collectionsMap.has(movieDetail.belongs_to_collection.id)) {
                const collectionId = movieDetail.belongs_to_collection.id;
                
                try {
                  const collectionResponse = await fetch(
                    `${BASE_URL}/collection/${collectionId}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
                  );
                  const collectionData = await collectionResponse.json();
                  
                  // Ne garder que les collections avec au moins 2 films, des images et pas de contenu adulte
                  if (collectionData.parts && 
                      collectionData.parts.length >= 2 && 
                      (collectionData.backdrop_path || collectionData.poster_path) &&
                      !isAdultCollection(collectionData)) {
                    // Filtrer les films avec des images pour le comptage correct
                    const moviesWithImages = collectionData.parts.filter((movie: any) => movie.poster_path);
                    if (moviesWithImages.length >= 2) {
                      collectionsMap.set(collectionId, collectionData);
                    }
                  }
                } catch (error) {
                  console.error(`Erreur lors de la récupération de la collection ${collectionId}:`, error);
                }
              }
            } catch (error) {
              console.error(`Erreur lors de la récupération des détails du film ${movie.id}:`, error);
            }
          }));
          
          // Petite pause entre les lots
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };

      // Charger 2 pages supplémentaires
      await Promise.all([
        processMoviesFromPage(nextPage),
        processMoviesFromPage(nextPage + 1)
      ]);

      // Conserver l'ordre existant et ajouter les nouveaux à la fin
      const existingCollectionIds = new Set(collections.map(c => c.id));
      const newCollections = Array.from(collectionsMap.values()).filter(c => !existingCollectionIds.has(c.id));
      
      // Trier seulement les nouvelles collections
      newCollections.sort((a, b) => {
        const scoreA = a.parts.length * (a.parts.reduce((sum, movie) => sum + (movie.vote_average || 0), 0) / a.parts.length || 0);
        const scoreB = b.parts.length * (b.parts.reduce((sum, movie) => sum + (movie.vote_average || 0), 0) / b.parts.length || 0);
        return scoreB - scoreA;
      });

      // Tracker les IDs des nouvelles collections pour les animations
      const newIds = new Set(newCollections.map(c => c.id));
      setNewCollectionIds(newIds);

      // Ajouter les nouvelles collections à la fin
      const allCollections = [...collections, ...newCollections];
      
      setCollections(allCollections);
      setFilteredCollections(allCollections);
      
      // Effacer les nouvelles IDs après un délai pour les futures animations
      setTimeout(() => {
        setNewCollectionIds(new Set());
      }, 2000);
      setCurrentPage(nextPage + 1);
      
                    // Mettre à jour le cache de session
      sessionStorage.setItem(CACHE_KEYS.collections, JSON.stringify(allCollections));
      sessionStorage.setItem(CACHE_KEYS.cacheTime, Date.now().toString());
      sessionStorage.setItem(CACHE_KEYS.lastPage, nextPage.toString());
      
              const newCollectionCount = allCollections.length - collections.length;
        console.log(`${allCollections.length} collections au total (${newCollectionCount} nouvelles)`);
        
        // Si on n'a trouvé aucune nouvelle collection sur plusieurs pages, on arrête
        if (newCollectionCount === 0) {
          setHasMoreCollections(false);
          console.log('Aucune nouvelle collection trouvée, arrêt du chargement');
        } else {
          // Continuer à chercher plus de collections
          setHasMoreCollections(true);
        }
      
    } catch (error) {
      console.error('Erreur lors du chargement de collections supplémentaires:', error);
    } finally {
      setLoadingMore(false);
    }
  };

  // Fonctions pour gérer l'ajout à une liste
  const openAddToListMenu = (collection: Collection) => {
    setSelectedCollection(collection);
    setShowAddToListMenu(true);
  };

  const closeAddToListMenu = () => {
    setShowAddToListMenu(false);
    setSelectedCollection(null);
  };

  // Fonction pour vérifier le statut de toutes les collections
  const checkCollectionsStatus = () => {
    const watchlistCollections = JSON.parse(localStorage.getItem('watchlist_collections') || '[]');
    const favoriteCollections = JSON.parse(localStorage.getItem('favorite_collections') || '[]');
    
    const status: { [key: number]: { watchlist: boolean; favorites: boolean } } = {};
    
    collections.forEach(collection => {
      status[collection.id] = {
        watchlist: watchlistCollections.some((item: any) => item.id === collection.id),
        favorites: favoriteCollections.some((item: any) => item.id === collection.id)
      };
    });
    
    setCollectionsStatus(status);
  };

  // Recherche de collections
  const handleSearch = async (query: string) => {
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await fetch(
        `${BASE_URL}/search/collection?api_key=${API_KEY}&query=${encodeURIComponent(query)}&language=${getTmdbLanguage()}`
      );
      const data = await response.json();
      
      // Récupérer les détails complets de chaque collection trouvée
      const detailedResults = await Promise.all(
        (data.results || []).map(async (collection: any) => {
          try {
            const detailResponse = await fetch(
              `${BASE_URL}/collection/${collection.id}?api_key=${API_KEY}&language=${getTmdbLanguage()}`
            );
            if (detailResponse.ok) {
              const detailData = await detailResponse.json();
              // Filtrer seulement si on a des images et au moins 2 films avec images
              if ((detailData.backdrop_path || detailData.poster_path) && 
                  detailData.parts && 
                  detailData.parts.filter((movie: any) => movie.poster_path).length >= 2) {
                return detailData;
              }
            }
            return null;
          } catch (error) {
            console.error(`Erreur lors de la récupération des détails de la collection ${collection.id}:`, error);
            return null;
          }
        })
      );
      
      // Filtrer les résultats null et trier
      const validResults = detailedResults.filter(result => result !== null);
      setSearchResults(validResults);
    } catch (error) {
      console.error('Erreur lors de la recherche de collections:', error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  // Debounce pour la recherche
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      handleSearch(searchQuery);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, API_KEY]);

  // Logique de filtrage des collections simplifiée
  useEffect(() => {
    // Afficher toutes les collections dans l'ordre de chargement
    setFilteredCollections(collections);
  }, [collections, searchQuery]);

  // Effet pour l'infinity scroll avec Intersection Observer
  useEffect(() => {
    if (searchQuery || loadingMore) return;

    // Utiliser l'Intersection Observer classique pour tous les modes
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !loadingMore && hasMoreCollections) {
          loadMoreCollections();
        }
      },
      {
        rootMargin: '300px',
        threshold: 0.1
      }
    );

    // Créer un élément déclencheur invisible
    const triggerElement = document.getElementById('infinity-scroll-trigger');
    if (triggerElement) {
      observer.observe(triggerElement);
    }

    return () => {
      if (triggerElement) {
        observer.unobserve(triggerElement);
      }
      observer.disconnect();
    };
     }, [searchQuery, loadingMore, hasMoreCollections, loadMoreCollections]);

  if (loading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white pt-32 pb-20">
        <div className="container mx-auto px-4 relative z-10">
          <div className="flex flex-col items-center justify-center h-64">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center">
              <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-red-500 mb-4 mx-auto"></div>
              <p className="text-gray-400 text-center">
                {loadingProgress || t('collections.loadingCollections')}
              </p>
              <p className="text-sm text-gray-500 mt-2 text-center max-w-md">
                {t('collections.firstVisitMessage')}
              </p>
            </motion.div>
          </div>
        </div>
      </SquareBackground>
    );
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="min-h-screen bg-black text-white pt-32 pb-24">
      <div className="container mx-auto px-4 md:px-6 lg:px-10 relative z-10">
        {/* Hero Section - Texte principal */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full flex flex-col items-center justify-center text-center mb-16"
        >
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="mb-6">
            <div className="inline-flex items-center justify-center p-3 bg-red-500/10 rounded-full mb-4 ring-1 ring-red-500/50">
              <Film className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-2xl lg:text-4xl font-bold leading-relaxed w-full xl:max-w-4xl text-center">
              {splitTextIntoWords(randomText).map((seg, i) =>
                seg.highlight ? (
                  <ShinyText key={i} text={seg.text} speed={3} color="#ef4444" shineColor="#ffffff" />
                ) : (
                  <span key={i} className="text-white">{seg.text}</span>
                )
              )}
            </h1>
          </motion.div>
        </motion.div>

        {/* Barre de recherche et contrôles */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="max-w-4xl mx-auto mb-16"
        >
          <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="10 10 10" className="p-4 backdrop-blur-sm">
            <div className="flex flex-col lg:flex-row gap-4 items-center">
            {/* Barre de recherche */}
            <div className="relative flex-1 max-w-2xl">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
              <input
                type="text"
                placeholder={t('collections.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-4 bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl text-white placeholder:text-white/30 focus:outline-none focus:border-red-500/50 transition-all"
              />
            </div>

            {/* Sélecteur de mode d'affichage */}
            <div className="flex items-center gap-2 bg-white/5 border border-gray-700/50 rounded-xl p-1">
              <button
                onClick={() => setDisplayMode('cards')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
                  displayMode === 'cards'
                    ? 'bg-red-500 text-white shadow-lg'
                    : 'text-gray-400 hover:text-white hover:bg-white/10'
                }`}
                title={t('search.gridView')}
              >
                <Grid size={18} />
                <span className="hidden sm:inline">{t('search.gridView')}</span>
              </button>
              <button
                onClick={() => setDisplayMode('list')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
                  displayMode === 'list'
                    ? 'bg-red-500 text-white shadow-lg'
                    : 'text-gray-400 hover:text-white hover:bg-white/10'
                }`}
                title={t('collections.modeList')}
              >
                <List size={18} />
                <span className="hidden sm:inline">{t('collections.list')}</span>
              </button>
            </div>
          </div>
          </AnimatedBorderCard>
        </motion.div>

        {/* Résultats de recherche */}
        {searchQuery && (
          <div className="mb-12">
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Search size={24} />
              {t('collections.searchResultsTitle')}
              {searchLoading && (
                <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-red-500 ml-2"></div>
              )}
            </h2>
                          {searchResults.length > 0 ? (
                <>
                  {debouncedDisplayMode === 'cards' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {searchResults.map((collection, index) => (
                      <CollectionCard
                        key={collection.id}
                        collection={collection}
                        index={index}
                        collectionsStatus={collectionsStatus}
                        setCollectionsStatus={setCollectionsStatus}
                        openAddToListMenu={openAddToListMenu}
                        getOptimizedImageUrl={getOptimizedImageUrl}
                        t={t}
                      />
                    ))}
                  </div>
                )}

                {debouncedDisplayMode === 'list' && (
                  <div className="space-y-10 max-w-6xl mx-auto">
                    {searchResults.map((collection, index) => (
                      <CollectionListItem
                        key={collection.id}
                        collection={collection}
                        index={index}
                        collectionsStatus={collectionsStatus}
                        setCollectionsStatus={setCollectionsStatus}
                        openAddToListMenu={openAddToListMenu}
                        getOptimizedImageUrl={getOptimizedImageUrl}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : !searchLoading && searchQuery.length >= 2 ? (
              <div className="text-center py-12">
                <div className="text-gray-400 mb-4">
                  <Search size={48} className="mx-auto mb-4 opacity-50" />
                  <p>{t('collections.noSearchResults', { query: searchQuery })}</p>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Collections populaires */}
        {!searchQuery && (
          <motion.div
            id="collections-grid"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <h2 className="text-2xl sm:text-3xl font-bold mb-8 text-center text-white">
              <ShinyText text={t('collections.popularCollections')} speed={2} color="#ffffff" shineColor="#ef4444" />
            </h2>
            {filteredCollections.length > 0 ? (
              <>
                {/* Mode d'affichage selon la sélection */}
                {debouncedDisplayMode === 'cards' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {filteredCollections.map((collection, index) => (
                      <motion.div
                        key={collection.id}
                        initial={newCollectionIds.has(collection.id) ? 'hidden' : false}
                        animate="visible"
                        variants={itemVariants}
                      >
                        <CollectionCard
                          collection={collection}
                          index={index}
                          isNew={newCollectionIds.has(collection.id)}
                          collectionsStatus={collectionsStatus}
                          setCollectionsStatus={setCollectionsStatus}
                          openAddToListMenu={openAddToListMenu}
                          getOptimizedImageUrl={getOptimizedImageUrl}
                          t={t}
                        />
                      </motion.div>
                    ))}
                  </div>
                )}

                {debouncedDisplayMode === 'list' && (
                  <div className="space-y-10 max-w-6xl mx-auto">
                    {filteredCollections.map((collection, index) => (
                      <motion.div
                        key={collection.id}
                        initial={newCollectionIds.has(collection.id) ? 'hidden' : false}
                        animate="visible"
                        variants={itemVariants}
                      >
                        <CollectionListItem
                          collection={collection}
                          index={index}
                          isNew={newCollectionIds.has(collection.id)}
                          collectionsStatus={collectionsStatus}
                          setCollectionsStatus={setCollectionsStatus}
                          openAddToListMenu={openAddToListMenu}
                          getOptimizedImageUrl={getOptimizedImageUrl}
                          t={t}
                        />
                      </motion.div>
                    ))}
                  </div>
                )}
                
                {/* Infinity Scroll - Zone de chargement optimisée */}
                {!searchQuery && (
                  <div className="mt-8">
                    {/* Compteur de collections - toujours visible */}
                    <div className="text-center py-4">
                      <p className="text-gray-400 text-sm">
                        {t('collections.collectionsDiscovered', { count: filteredCollections.length })}
                        {hasMoreCollections && !loadingMore && (
                          <span className="text-red-400 ml-2">{t('collections.moreToCome')}</span>
                        )}
                      </p>
                    </div>

                    {/* Indicateur de chargement compact */}
                    {loadingMore && hasMoreCollections && (
                      <div className="text-center py-4">
                        <div className="inline-flex items-center gap-3 bg-gray-800/50 rounded-full px-6 py-3 border border-gray-700/50">
                          <div className="relative">
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-600"></div>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-red-500 absolute top-0 left-0"></div>
                          </div>
                          <span className="text-sm text-gray-300">{t('collections.discovering')}</span>
                        </div>
                      </div>
                    )}
                    
                    {/* Élément déclencheur invisible pour l'Intersection Observer */}
                    <div id="infinity-scroll-trigger" className="h-4" />
                  </div>
                )}


               </>
            ) : collections.length > 0 ? (
              <div className="text-center py-12">
                <div className="text-gray-400 mb-4">
                  <Film size={48} className="mx-auto mb-4 opacity-50" />
                  <p>{t('collections.noCollectionsAvailable')}</p>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="text-gray-400 mb-4">
                  <Film size={48} className="mx-auto mb-4 opacity-50" />
                  <p>{t('collections.noCollectionsAvailable')}</p>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* Menu d'ajout à une liste */}
      {showAddToListMenu && selectedCollection && (
        <AddToListMenu
          mediaId={selectedCollection.id}
          mediaType="collection"
          title={selectedCollection.name}
          posterPath={selectedCollection.poster_path || ''}
          movieCount={selectedCollection.parts?.length || 0}
          onClose={closeAddToListMenu}
        />
      )}
    </SquareBackground>
  );
};

export default Collections;
