import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, SlidersHorizontal, LayoutGrid, List, Loader2 } from 'lucide-react';
import SEO from '../components/SEO';
import { motion, AnimatePresence } from 'framer-motion';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import CustomDropdown from '../components/CustomDropdown';
import { SearchGridCard, SearchListCard } from '../components/SearchCard';
import { getTmdbLanguage } from '../i18n';
import { resolveTmdbKeywordId } from '../utils/tmdbKeywords';

// Genre IDs from TMDB
const GENRES: Record<number, string> = {
  28: 'Action',
  12: 'Aventure',
  16: 'Animation',
  35: 'Comédie',
  80: 'Crime',
  99: 'Documentaire',
  18: 'Drame',
  10751: 'Famille',
  14: 'Fantastique',
  36: 'Histoire',
  27: 'Horreur',
  10402: 'Musique',
  9648: 'Mystère',
  10749: 'Romance',
  878: 'Science-Fiction',
  10770: 'Téléfilm',
  53: 'Thriller',
  10752: 'Guerre',
  37: 'Western',
  // TV specific genres
  10759: 'Action & Aventure',
  10762: 'Enfants',
  10763: 'Actualités',
  10764: 'Téléréalité',
  10765: 'Science-Fiction & Fantastique',
  10766: 'Feuilleton',
  10767: 'Talk-show',
  10768: 'Guerre & Politique'
};

const GENRE_TRANSLATION_KEYS: Record<number, string> = {
  28: 'genres.id_28',
  12: 'genres.id_12',
  16: 'genres.id_16',
  35: 'genres.id_35',
  80: 'genres.id_80',
  99: 'genres.id_99',
  18: 'genres.id_18',
  10751: 'genres.id_10751',
  14: 'genres.id_14',
  36: 'genres.id_36',
  27: 'genres.id_27',
  10402: 'genres.id_10402',
  9648: 'genres.id_9648',
  10749: 'genres.id_10749',
  878: 'genres.id_878',
  10770: 'genres.id_10770',
  53: 'genres.id_53',
  10752: 'genres.id_10752',
  37: 'genres.id_37',
  10759: 'genres.id_10759',
  10762: 'genres.id_10762',
  10763: 'genres.id_10763',
  10764: 'genres.id_10764',
  10765: 'genres.id_10765',
  10766: 'genres.id_10766',
  10767: 'genres.id_10767',
  10768: 'genres.id_10768'
};

type ViewType = 'grid' | 'list';

interface ContentItem {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  backdrop_path?: string;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
}

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// ─── Pagination (same style as Search.tsx) ─────────────────────────────────
const PaginationBar = ({ currentPage, maxPages, onSelect }: { currentPage: number; maxPages: number; onSelect: (n: number) => void }) => {
  return (
    <div className="flex justify-center items-center gap-1.5 flex-wrap my-8">
      <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(1)} disabled={currentPage <= 1}
        className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${currentPage === 1 ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
        1
      </motion.button>
      {currentPage > 4 && <span className="text-white/20 px-1">...</span>}
      {Array.from({ length: 5 }, (_, i) => {
        const p = Math.max(2, currentPage - 2) + i;
        return p > 1 && p < maxPages ? (
          <motion.button key={p} whileTap={{ scale: 0.92 }} onClick={() => onSelect(p)}
            className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${p === currentPage ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'}`}>
            {p}
          </motion.button>
        ) : null;
      })}
      {currentPage < maxPages - 3 && <span className="text-white/20 px-1">...</span>}
      {maxPages > 1 && (
        <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(maxPages)} disabled={currentPage >= maxPages}
          className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${currentPage === maxPages ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
          {maxPages}
        </motion.button>
      )}
    </div>
  );
};

const GenrePage: React.FC = () => {
  const { t } = useTranslation();
  const { mediaType, genreId } = useParams<{ mediaType: string; genreId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [content, setContent] = useState<ContentItem[]>([]);
  const [initialLoad, setInitialLoad] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pageFromUrl = parseInt(searchParams.get('page') || '1', 10);
  const [currentPage, setCurrentPage] = useState(pageFromUrl);
  const [totalPages, setTotalPages] = useState(1);
  const [sortBy, setSortBy] = useState('popularity.desc');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [viewType, setViewType] = useState<ViewType>('grid');

  // Responsive grid
  const [resultsPerRow, setResultsPerRow] = useState(6);
  const [screenCols, setScreenCols] = useState(6);

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      if (w < 640) setScreenCols(2);
      else if (w < 768) setScreenCols(3);
      else if (w < 1024) setScreenCols(4);
      else if (w < 1280) setScreenCols(6);
      else setScreenCols(10);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const effectivePerRow = Math.min(resultsPerRow, screenCols);

  const allGridOptions = [2, 3, 4, 6, 8, 10];
  const gridOptions = allGridOptions
    .filter(n => n <= screenCols)
    .map(n => ({ value: String(n), label: `${n} ${t('search.perRow')}` }));

  const getGridClasses = () => {
    switch (effectivePerRow) {
      case 2: return 'grid-cols-2';
      case 3: return 'grid-cols-2 sm:grid-cols-3';
      case 4: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4';
      case 8: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8';
      case 10: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10';
      case 6:
      default: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6';
    }
  };

  const parsedGenreId = genreId ? parseInt(genreId, 10) : NaN;
  const isMovie = mediaType === 'movie';
  const isAnime = mediaType === 'anime';
  const resolvedMediaType = isAnime ? 'tv' : mediaType;
  const genreTranslationKey = Number.isFinite(parsedGenreId) ? GENRE_TRANSLATION_KEYS[parsedGenreId] : '';
  const genreName = genreTranslationKey
    ? t(genreTranslationKey)
    : genreId
      ? GENRES[parsedGenreId] || t('filter.genre')
      : t('filter.genre');
  const contentTypeLabel = isMovie
    ? t('filter.movies')
    : isAnime
      ? t('filter.anime')
      : t('filter.series');

  // Sort options for dropdown — memoized so CustomDropdown sees stable refs.
  const sortOptions = useMemo(() => [
    { value: 'popularity.desc', label: t('genres.popularityDesc') },
    { value: 'popularity.asc', label: t('genres.popularityAsc') },
    { value: 'vote_average.desc', label: t('genres.ratingDesc') },
    { value: 'vote_average.asc', label: t('genres.ratingAsc') },
    { value: 'release_date.desc', label: t('genres.releaseDateDesc') },
    { value: 'release_date.asc', label: t('genres.releaseDateAsc') },
  ], [t]);

  // Sync page with URL
  useEffect(() => {
    const p = parseInt(searchParams.get('page') || '1', 10);
    if (p !== currentPage) setCurrentPage(p);
  }, [searchParams]);

  // Reset on genre/media change — replace to avoid polluting history.
  //
  // Sauté au montage : le routeur remonte déjà la page quand le genre ou le
  // type change (`RouteLazyContent` pose `key={pathname}`), l'état repart donc
  // de zéro tout seul. Le faire quand même à l'arrivée écrasait un lien profond
  // `?page=5` — et déclenchait deux requêtes, une pour la page de l'URL puis
  // une pour la page 1 réécrite dans la foulée.
  const isFirstRunRef = useRef(true);
  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    setCurrentPage(1);
    setSearchParams({ page: '1' }, { replace: true });
    setLoading(true);
    setInitialLoad(true);
  }, [genreId, mediaType]);

  // Fetch content
  useEffect(() => {
    const fetchContent = async () => {
      if (!genreId || !mediaType) return;
      setLoading(true);
      try {
        const withGenres = isAnime && genreId !== '16' ? `16,${genreId}` : genreId;
        const animeKeywordId = isAnime ? await resolveTmdbKeywordId('anime', getTmdbLanguage()) : null;

        const response = await axios.get(`https://api.themoviedb.org/3/discover/${resolvedMediaType}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage(),
            with_genres: withGenres,
            page: currentPage,
            sort_by: sortBy,
            include_adult: false,
            'vote_count.gte': 5,
            include_video: false,
            ...(isAnime && animeKeywordId ? { with_keywords: String(animeKeywordId) } : {})
          }
        });
        const filtered = response.data.results.filter(
          (item: ContentItem) => item.overview && item.overview.trim() !== ''
        );
        setContent(filtered);
        setTotalPages(Math.min(response.data.total_pages, 500));
      } catch {
        setError(t('genres.errorLoading'));
      } finally {
        setLoading(false);
        setInitialLoad(false);
      }
    };
    fetchContent();
  }, [genreId, mediaType, currentPage, sortBy, isAnime, resolvedMediaType, t]);

  const handlePageChange = useCallback((newPage: number) => {
    if (newPage > 0 && newPage <= totalPages) {
      setSearchParams({ page: newPage.toString() });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [totalPages, setSearchParams]);

  const handleSortChange = (val: string) => {
    setSortBy(val);
    setSearchParams({ page: '1' }, { replace: true });
  };

  // Adapt ContentItem to SearchResult shape for card reuse.
  // Memoized so the per-item objects keep stable identity between renders —
  // SearchGridCard / SearchListCard are React.memo'd and shallow-equal `item`,
  // and the previous inline `toSearchResult(item)` allocation in the .map
  // returned a fresh object every render, defeating the memo. — perf
  const searchResults = useMemo(
    () => content.map((item: ContentItem) => ({
      id: item.id,
      title: item.title,
      name: item.name,
      media_type: resolvedMediaType as 'movie' | 'tv',
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      release_date: item.release_date,
      first_air_date: item.first_air_date,
      vote_average: item.vote_average,
      overview: item.overview,
    })),
    [content, resolvedMediaType]
  );

  // Initial loading
  if (initialLoad) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
        <div className="min-h-screen flex flex-col justify-center items-center">
          <Loader2 className="w-12 h-12 text-red-500 animate-spin mb-4" />
          <p className="text-white/60 animate-pulse">{t('genres.loadingGenre', { genre: genreName })}</p>
        </div>
      </SquareBackground>
    );
  }

  if (error) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
        <div className="min-h-screen flex justify-center items-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-red-500">{t('common.error')}</h1>
            <p className="mt-2 text-white/60">{error}</p>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => window.location.reload()}
              className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full text-white font-medium transition-colors"
            >
              {t('common.retry')}
            </motion.button>
          </div>
        </div>
      </SquareBackground>
    );
  }

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
      <motion.div
        className="min-h-screen pt-24 pb-16 px-4 md:px-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <SEO
          title={t('genres.seoTitle', { genre: genreName, type: contentTypeLabel })}
          description={t('genres.seoDescription', { genre: genreName, type: contentTypeLabel.toLowerCase() })}
        />

        <div className="max-w-screen-xl mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 flex flex-col md:flex-row md:justify-between md:items-center gap-4"
          >
            <div className="flex items-center gap-3">
              <motion.button
                whileHover={{ x: -3 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => navigate(-1)}
                className="p-2 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all"
              >
          <ArrowLeft className="w-5 h-5 text-white opacity-70" />
              </motion.button>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl md:text-3xl font-bold">
                  <ShinyText text={genreName} speed={4} />
                </h1>
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-sm text-white/60">
                  {contentTypeLabel}
                </span>
              </div>
            </div>

            <motion.button
              className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl transition-all ${isFilterOpen
                ? 'bg-red-600 border border-red-500 hover:bg-red-500'
                : 'bg-white/5 backdrop-blur-md border border-white/10 hover:border-red-500/40 hover:bg-red-500/10'
                }`}
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <SlidersHorizontal className="w-4 h-4" />
              <span className="text-sm font-medium">{t('filter.title')}</span>
            </motion.button>
          </motion.div>

          {/* Filter Panel */}
          <AnimatePresence>
            {isFilterOpen && (
              <motion.div
                className="mb-8 p-5 rounded-2xl bg-white/5 backdrop-blur-md border border-white/10"
                initial={{ opacity: 0, y: -20, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -20, height: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
                  {/* Sort */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="flex-1">
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('genres.sort')}</label>
                    <CustomDropdown
                      options={sortOptions}
                      value={sortBy}
                      onChange={handleSortChange}
                      searchable={false}
                    />
                  </motion.div>

                  {/* Items per row */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="flex-1">
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('genres.itemsPerRow')}</label>
                    <CustomDropdown
                      options={gridOptions}
                      value={String(resultsPerRow)}
                      onChange={(val) => setResultsPerRow(Number(val))}
                      searchable={false}
                    />
                  </motion.div>

                  {/* View toggle */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="flex gap-2">
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setViewType('grid')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'grid'
                        ? 'bg-red-600 text-white'
                        : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'
                        }`}
                    >
                      <LayoutGrid className="w-4 h-4" />
                      <span className="text-sm hidden sm:inline">{t('genres.grid')}</span>
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setViewType('list')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'list'
                        ? 'bg-red-600 text-white'
                        : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'
                        }`}
                    >
                      <List className="w-4 h-4" />
                      <span className="text-sm hidden sm:inline">{t('genres.listView')}</span>
                    </motion.button>
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Content
              La grille reste affichée pendant le chargement de la page
              suivante, simplement estompée. La remplacer par un spinner
              démontait les 20 cartes, vidait les images et faisait sauter la
              mise en page à chaque changement de page. */}
          {loading && content.length === 0 ? (
            <div className="flex justify-center py-20">
              <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
            </div>
          ) : content.length === 0 ? (
            <motion.div
              className="text-center py-20"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <p className="text-lg text-white/60">{t('genres.noContent')}</p>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full text-white font-medium transition-colors"
                onClick={() => navigate(-1)}
              >
                {t('common.back')}
              </motion.button>
            </motion.div>
          ) : (
            <div className={`transition-opacity duration-200 ${loading ? 'opacity-40 pointer-events-none' : ''}`}>
              {/* Grid View */}
              {viewType === 'grid' && (
                <div className={`grid ${getGridClasses()} gap-3`}>
                  {searchResults.map((item, index) => (
                    <SearchGridCard
                      key={item.id}
                      item={item}
                      index={index}
                      movieLabel={t('filter.movies')}
                      serieLabel={contentTypeLabel}
                    />
                  ))}
                </div>
              )}

              {/* List View */}
              {viewType === 'list' && (
                <div className="flex flex-col gap-3">
                  {searchResults.map((item, index) => (
                    <SearchListCard
                      key={item.id}
                      item={item}
                      index={index}
                      movieLabel={t('filter.movies')}
                      serieLabel={contentTypeLabel}
                      watchlistLabel={t('profile.addToWatchlist')}
                      removeLabel={t('genres.remove')}
                      noDescLabel={t('genres.noContent')}
                    />
                  ))}
                </div>
              )}

              {/* Pagination */}
              {totalPages > 1 && (
                <PaginationBar
                  currentPage={currentPage}
                  maxPages={Math.min(totalPages, 500)}
                  onSelect={handlePageChange}
                />
              )}
            </div>
          )}
        </div>
      </motion.div>
    </SquareBackground>
  );
};

export default GenrePage;
