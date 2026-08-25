import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { useParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { ArrowLeft, List, Film, Tv, Library, Share2, Copy, ExternalLink, Loader2, Flag } from 'lucide-react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { toast } from 'sonner';
import { SquareBackground } from '../components/ui/square-background';
import BlurText from '../components/ui/blur-text';
import ShinyText from '../components/ui/shiny-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import { Button } from '../components/ui/button';
import { encodeId } from '../utils/idEncoder';
import { getTmdbLanguage } from '../i18n';
import LikeDislikeButton from '../components/LikeDislikeButton';
import { FavoriteStarIconButton, FavoriteStarPillButton } from '../components/FavoriteStarButton';
import AgeRestrictedMedia from '../components/AgeRestrictedMedia';
import {
  SHARED_LIST_FAVORITES_STORAGE_KEY,
  readSharedListFavorites,
  writeSharedListFavorites,
  type SharedListFavorite,
} from '../utils/sharedListFavorites';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

const API_URL = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

interface SharedListItem {
  id: number;
  type: 'movie' | 'tv' | 'collection';
  title: string;
  name?: string;
  poster_path: string;
  addedAt?: string;
  backdrop_path?: string | null;
  overview?: string;
}

interface SharedListData {
  shareCode: string;
  username: string;
  avatar: string;
  isVip?: boolean;
  listName: string;
  items: SharedListItem[];
  itemCount: number;
  cachedAt: number;
}

interface StoredMediaFavorite {
  id: number;
  type: 'movie' | 'tv';
  title: string;
  poster_path: string;
  addedAt: string;
}

const WATCHLIST_MOVIE_STORAGE_KEY = 'watchlist_movie';
const WATCHLIST_TV_STORAGE_KEY = 'watchlist_tv';

const readStoredMediaWatchlist = (storageKey: string): StoredMediaFavorite[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const SharedListPage: React.FC = () => {
  const { t } = useTranslation();
  const { shareCode } = useParams<{ shareCode: string }>();
  const [listData, setListData] = useState<SharedListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enrichedItems, setEnrichedItems] = useState<any[]>([]);
  const [loadingEnrich, setLoadingEnrich] = useState(false);

  // Report states
  const [reportModal, setReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reported, setReported] = useState(false);
  const [favoriteLists, setFavoriteLists] = useState<SharedListFavorite[]>(() => readSharedListFavorites());
  const [watchlistMovieItems, setWatchlistMovieItems] = useState<StoredMediaFavorite[]>(() => readStoredMediaWatchlist(WATCHLIST_MOVIE_STORAGE_KEY));
  const [watchlistTvItems, setWatchlistTvItems] = useState<StoredMediaFavorite[]>(() => readStoredMediaWatchlist(WATCHLIST_TV_STORAGE_KEY));

  const isAuthenticated = !!localStorage.getItem('auth_token');
  const profileId = localStorage.getItem('selected_profile_id');
  const isFavoriteList = useMemo(
    () => favoriteLists.some((favorite) => favorite.shareCode === shareCode),
    [favoriteLists, shareCode]
  );
  const watchlistMovieIds = useMemo(() => new Set(watchlistMovieItems.map((item) => item.id)), [watchlistMovieItems]);
  const watchlistTvIds = useMemo(() => new Set(watchlistTvItems.map((item) => item.id)), [watchlistTvItems]);

  const REPORT_REASONS = [
    { value: 'spam', label: t('comments.reportReasons.spam', 'Spam') },
    { value: 'harassment', label: t('comments.reportReasons.harassment', 'Insultes / Harcèlement') },
    { value: 'sexual_content', label: t('comments.reportReasons.sexualContent', 'Contenu sexuel') },
    { value: 'impersonation', label: t('comments.reportReasons.impersonation', "Usurpation d'identité") },
    { value: 'other', label: t('comments.reportReasons.other', 'Autre') },
  ];

  const handleReport = async () => {
    if (!reportReason || !shareCode) return;
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    setReportSubmitting(true);
    try {
      await axios.post(
        `${API_URL}/api/comments/report`,
        {
          targetType: 'shared_list',
          targetId: shareCode,
          reason: reportReason,
          details: reportDetails || undefined,
          profileId
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setReported(true);
      setReportModal(false);
      setReportReason('');
      setReportDetails('');
    } catch (error: any) {
      if (error.response?.status === 409) {
        setReported(true);
        setReportModal(false);
      }
    } finally {
      setReportSubmitting(false);
    }
  };

  // Masquer le footer
  useEffect(() => undefined, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SHARED_LIST_FAVORITES_STORAGE_KEY) {
        setFavoriteLists(readSharedListFavorites());
      }
      if (event.key === WATCHLIST_MOVIE_STORAGE_KEY) {
        setWatchlistMovieItems(readStoredMediaWatchlist(WATCHLIST_MOVIE_STORAGE_KEY));
      }
      if (event.key === WATCHLIST_TV_STORAGE_KEY) {
        setWatchlistTvItems(readStoredMediaWatchlist(WATCHLIST_TV_STORAGE_KEY));
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const persistFavoriteLists = useCallback((nextFavorites: SharedListFavorite[]) => {
    setFavoriteLists(nextFavorites);
    writeSharedListFavorites(nextFavorites);
  }, []);

  const persistWatchlistMovieItems = useCallback((nextWatchlist: StoredMediaFavorite[]) => {
    setWatchlistMovieItems(nextWatchlist);
    try {
      localStorage.setItem(WATCHLIST_MOVIE_STORAGE_KEY, JSON.stringify(nextWatchlist));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const persistWatchlistTvItems = useCallback((nextWatchlist: StoredMediaFavorite[]) => {
    setWatchlistTvItems(nextWatchlist);
    try {
      localStorage.setItem(WATCHLIST_TV_STORAGE_KEY, JSON.stringify(nextWatchlist));
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Charger les données de la liste partagée
  useEffect(() => {
    const fetchSharedList = async () => {
      if (!shareCode) {
        setError(t('lists.shareCodeMissing'));
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/api/shared-lists/list/${shareCode}`);
        if (!response.ok) {
          if (response.status === 404) {
            setError(t('lists.sharedListNotExistOrDeleted'));
          } else {
            setError(t('lists.loadError'));
          }
          setLoading(false);
          return;
        }

        const data = await response.json();
        setListData(data);
        setLoading(false);
      } catch (err) {
        console.error('Erreur fetch shared list:', err);
        setError(t('lists.connectionError'));
        setLoading(false);
      }
    };

    fetchSharedList();
  }, [shareCode]);

  // Enrichir les items avec TMDB (poster_path de meilleure qualité, etc.)
  useEffect(() => {
    if (!listData || !listData.items || listData.items.length === 0) return;

    let cancelled = false;

    const enrichItems = async () => {
      setLoadingEnrich(true);

      const enrichOne = async (item: SharedListItem) => {
        try {
          const mediaType = item.type === 'collection' ? 'collection' : item.type;
          const response = await fetch(
            `https://api.themoviedb.org/3/${mediaType}/${item.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
          );

          if (response.ok) {
            const tmdbData = await response.json();
            return {
              ...item,
              title: tmdbData.title || tmdbData.name || item.title || item.name,
              poster_path: tmdbData.poster_path || item.poster_path,
              backdrop_path: tmdbData.backdrop_path,
              overview: tmdbData.overview,
              vote_average: tmdbData.vote_average,
              release_date: tmdbData.release_date || tmdbData.first_air_date,
              genres: tmdbData.genres?.map((g: any) => g.name) || [],
              parts: tmdbData.parts,
            };
          }
          return { ...item, title: item.title || item.name || '' };
        } catch {
          return { ...item, title: item.title || item.name || '' };
        }
      };

      // Enrichir par lots de 6 en parallèle
      const results: any[] = [];
      const batchSize = 6;
      for (let i = 0; i < listData.items.length; i += batchSize) {
        if (cancelled) return;
        const batch = listData.items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(enrichOne));
        results.push(...batchResults);
      }

      if (!cancelled) {
        setEnrichedItems(results);
        setLoadingEnrich(false);
      }
    };

    enrichItems();
    return () => { cancelled = true; };
  }, [listData]);

  const handleCopyLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      toast.success(t('common.linkCopied'));
    });
  };

  const handleToggleFavorite = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!shareCode || !listData) return;

    if (isFavoriteList) {
      const nextFavorites = favoriteLists.filter((favorite) => favorite.shareCode !== shareCode);
      persistFavoriteLists(nextFavorites);
      toast.success(`${listData.listName} ${t('lists.removedFromFavoritesToast')}`, { duration: 2000 });
      return;
    }

    const nextFavorites = [
      ...favoriteLists,
      {
        shareCode,
        listName: listData.listName,
        username: listData.username,
        avatar: listData.avatar,
        isVip: listData.isVip,
        itemCount: listData.itemCount,
        addedAt: new Date().toISOString(),
      }
    ];

    persistFavoriteLists(nextFavorites);
    toast.success(`${listData.listName} ${t('lists.addedToFavoritesToast')}`, { duration: 2000 });
  }, [favoriteLists, isFavoriteList, listData, persistFavoriteLists, shareCode, t]);

  const isWatchlistMediaItem = useCallback((item: Pick<SharedListItem, 'id' | 'type'>) => {
    const mediaId = Number(item.id);
    if (item.type === 'movie') return watchlistMovieIds.has(mediaId);
    if (item.type === 'tv') return watchlistTvIds.has(mediaId);
    return false;
  }, [watchlistMovieIds, watchlistTvIds]);

  const handleToggleMediaWatchlist = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    item: Pick<SharedListItem, 'id' | 'type' | 'title' | 'name' | 'poster_path'>
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const mediaId = Number(item.id);
    if (Number.isNaN(mediaId)) return;

    const itemToSave: StoredMediaFavorite = {
      id: mediaId,
      type: item.type === 'tv' ? 'tv' : 'movie',
      title: item.title || item.name || '',
      poster_path: item.poster_path || '',
      addedAt: new Date().toISOString(),
    };

    if (item.type === 'movie') {
      if (watchlistMovieIds.has(mediaId)) {
        persistWatchlistMovieItems(watchlistMovieItems.filter((watchlist) => watchlist.id !== mediaId));
        toast.success(t('search.removedFromWatchlist'), { duration: 2000 });
        return;
      }

      persistWatchlistMovieItems([
        itemToSave,
        ...watchlistMovieItems.filter((watchlist) => watchlist.id !== mediaId),
      ]);
      toast.success(t('search.addedToWatchlist'), { duration: 2000 });
      return;
    }

    if (item.type === 'tv') {
      if (watchlistTvIds.has(mediaId)) {
        persistWatchlistTvItems(watchlistTvItems.filter((watchlist) => watchlist.id !== mediaId));
        toast.success(t('search.removedFromWatchlist'), { duration: 2000 });
        return;
      }

      persistWatchlistTvItems([
        itemToSave,
        ...watchlistTvItems.filter((watchlist) => watchlist.id !== mediaId),
      ]);
      toast.success(t('search.addedToWatchlist'), { duration: 2000 });
    }
  }, [persistWatchlistMovieItems, persistWatchlistTvItems, t, watchlistMovieIds, watchlistMovieItems, watchlistTvIds, watchlistTvItems]);

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.06 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  const getItemLink = (item: SharedListItem) => {
    if (item.type === 'collection') return `/collection/${item.id}`;
    if (item.type === 'tv') return `/tv/${encodeId(item.id)}`;
    return `/movie/${encodeId(item.id)}`;
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'movie': return { label: t('common.film'), color: 'bg-blue-600' };
      case 'tv': return { label: t('common.tvSeries'), color: 'bg-green-600' };
      case 'collection': return { label: t('common.collection'), color: 'bg-purple-600' };
      default: return { label: type, color: 'bg-gray-600' };
    }
  };

  // État chargement
  if (loading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(168, 85, 247, 0.12)" className="min-h-screen bg-black text-white">
        <div className="flex items-center justify-center min-h-screen">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4"
          >
            <Loader2 className="w-10 h-10 text-purple-500 animate-spin" />
            <p className="text-white/50 text-sm">{t('lists.loadingList')}</p>
          </motion.div>
        </div>
      </SquareBackground>
    );
  }

  // État erreur
  if (error || !listData) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(168, 85, 247, 0.12)" className="min-h-screen bg-black text-white">
        <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10">
          <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
            <ArrowLeft className="w-5 h-5 mr-2" />
            {t('common.backToHome')}
          </Link>
          <div className="max-w-2xl mx-auto text-center mt-20">
            <AnimatedBorderCard
              highlightColor="168 85 247"
              backgroundColor="10 10 10"
              className="p-8 backdrop-blur-sm"
            >
              <List className="w-14 h-14 text-purple-500 opacity-50 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-white mb-3">{t('lists.listNotFound')}</h2>
              <p className="text-white/50 mb-6">{error || t('lists.sharedListNotExist')}</p>
              <Link to="/">
                <Button className="bg-purple-600 hover:bg-purple-700 text-white px-6 h-11 gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  {t('common.backToHome')}
                </Button>
              </Link>
            </AnimatedBorderCard>
          </div>
        </div>
      </SquareBackground>
    );
  }

  const items = listData.items || [];
  const displayItems = enrichedItems.length > 0 ? enrichedItems : items;
  const stats = {
    movies: items.filter(i => i.type === 'movie').length,
    tv: items.filter(i => i.type === 'tv').length,
    collections: items.filter(i => i.type === 'collection').length,
  };

  return (
    <>
    <SquareBackground squareSize={48} borderColor="rgba(168, 85, 247, 0.12)" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10">
        {/* Back Button */}
        <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('common.backToHome')}
        </Link>

        {/* Hero Section */}
        <div className="max-w-4xl mx-auto text-center mb-12">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6 relative"
          >
            {/* Avatar & Username */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="flex items-center justify-center gap-3 mb-6"
            >
              <div className="relative">
                <div className="w-12 h-12 rounded-full overflow-hidden ring-2 ring-purple-500/40 ring-offset-2 ring-offset-black">
                  <img
                    src={listData.avatar}
                    alt={listData.username}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = '/avatars/disney/disney_avatar_1.png';
                    }}
                  />
                </div>
                <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center ring-2 ring-black">
                  <Share2 className="w-3 h-3 text-white" />
                </div>
              </div>
              <div className="text-left">
                <p className="text-white/40 text-xs font-medium uppercase tracking-wider">{t('lists.sharedListBy')}</p>
                <div className="flex items-center gap-2">
                  <p className="text-white font-semibold">{listData.username}</p>
                  {listData.isVip && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">{t('lists.vipBadge')}</span>
                  )}
                </div>
              </div>
            </motion.div>

            <h1 className="text-3xl md:text-5xl font-black tracking-tight mb-4 pb-2">
              <ShinyText text={listData.listName} speed={3} color="#ffffff" shineColor="#a855f7" className="block py-2 leading-tight" />
            </h1>

            <BlurText
              text={t('lists.itemsInList', { count: listData.itemCount })}
              delay={150}
              className="text-lg text-white/60 max-w-2xl mx-auto justify-center"
            />
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex items-center justify-center gap-4 flex-wrap mt-4"
          >
            {stats.movies > 0 && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-blue-500/30 bg-blue-500/10">
                <Film className="w-4 h-4 text-blue-400" />
                <span className="text-blue-300 text-sm font-medium">{t('lists.movieCount', { count: stats.movies })}</span>
              </div>
            )}
            {stats.tv > 0 && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-green-500/30 bg-green-500/10">
                <Tv className="w-4 h-4 text-green-400" />
                <span className="text-green-300 text-sm font-medium">{t('lists.seriesCount', { count: stats.tv })}</span>
              </div>
            )}
            {stats.collections > 0 && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-purple-500/30 bg-purple-500/10">
                <Library className="w-4 h-4 text-purple-400" />
                <span className="text-purple-300 text-sm font-medium">{t('lists.collectionCount', { count: stats.collections })}</span>
              </div>
            )}
          </motion.div>

          {/* Copy link button & Like/Dislike */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-6 flex items-center justify-center gap-3 flex-wrap"
          >
            {shareCode && listData && (
              <FavoriteStarPillButton
                active={isFavoriteList}
                activeLabel={t('lists.removeFromFavorites')}
                inactiveLabel={t('lists.addToFavorites')}
                activeText={t('common.favorites')}
                inactiveText={t('lists.addToFavorites')}
                onToggle={handleToggleFavorite}
              />
            )}
            <button
              onClick={handleCopyLink}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-purple-500/40 hover:bg-purple-500/10 transition-all text-sm text-white/60 hover:text-white"
            >
              <Copy className="w-4 h-4" />
              <span>{t('common.copyLink')}</span>
            </button>
            {shareCode && (
              <LikeDislikeButton contentType="shared-list" contentId={shareCode} />
            )}

            {isAuthenticated && !reported && (
              <button
                onClick={() => setReportModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-orange-500/40 hover:bg-orange-500/10 transition-all text-sm text-white/60 hover:text-orange-400"
              >
                <Flag className="w-4 h-4" />
                <span>{t('comments.report', 'Signaler')}</span>
              </button>
            )}
            {reported && (
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-sm text-orange-400/70">
                <Flag className="w-4 h-4" />
                <span>{t('comments.reported', 'Signalé')}</span>
              </span>
            )}
          </motion.div>
        </div>

        {/* Liste des items */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="max-w-6xl mx-auto mb-20"
        >
          {loadingEnrich && enrichedItems.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-purple-500"></div>
                <p className="text-white/40 text-sm">{t('common.loadingDetails')}</p>
              </div>
            </div>
          ) : displayItems.length === 0 ? (
            <motion.div variants={itemVariants}>
              <AnimatedBorderCard
                highlightColor="168 85 247"
                backgroundColor="12 12 12"
                className="p-12 text-center"
              >
                <List className="w-14 h-14 text-purple-500 opacity-30 mx-auto mb-4" />
                <h3 className="text-xl font-bold text-white mb-2">{t('lists.emptyList')}</h3>
                <p className="text-white/40">{t('lists.emptyListDesc')}</p>
              </AnimatedBorderCard>
            </motion.div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {displayItems.map((item, index) => {
                const badge = getTypeBadge(item.type);
                const canWatchlistMedia = item.type === 'movie' || item.type === 'tv';
                const isWatchlistMedia = canWatchlistMedia ? isWatchlistMediaItem(item) : false;
                return (
                  <AgeRestrictedMedia key={`${item.type}-${item.id}`} item={item}>
                  <motion.div
                    key={`${item.type}-${item.id}`}
                    variants={itemVariants}
                    whileHover={{ scale: 1.05, transition: { duration: 0.2 } }}
                    className="relative group"
                  >
                    <Link to={getItemLink(item)}>
                      <div className="relative rounded-xl overflow-hidden bg-white/5 border border-white/10 group-hover:border-purple-500/30 transition-colors shadow-lg group-hover:shadow-purple-500/10">
                        {canWatchlistMedia && (
                          <FavoriteStarIconButton
                            active={isWatchlistMedia}
                            activeLabel={t('common.removeFromWatchlist')}
                            inactiveLabel={t('common.addToWatchlist')}
                            onToggle={(event) => handleToggleMediaWatchlist(event, item)}
                            className="absolute top-2 right-2 z-20 h-9 w-9 backdrop-blur-sm opacity-100 md:opacity-0 md:group-hover:opacity-100"
                          />
                        )}
                        <div className="aspect-[2/3] relative overflow-hidden">
                          {item.poster_path ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                              alt={item.title}
                              className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gray-900">
                              <Film className="w-10 h-10 text-white opacity-20" />
                            </div>
                          )}

                          {/* Gradient overlay au hover */}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                            <div className="absolute bottom-0 left-0 right-0 p-3 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                              <h3 className="text-white font-bold text-sm mb-1 line-clamp-2">{item.title || item.name}</h3>
                              {(item as any).release_date && (
                                <p className="text-white/50 text-xs">
                                  {new Date((item as any).release_date).getFullYear()}
                                </p>
                              )}
                              {(item as any).vote_average > 0 && (
                                <div className="flex items-center gap-1 mt-1">
                                  <span className="text-yellow-400 text-xs">★</span>
                                  <span className="text-white/60 text-xs">{(item as any).vote_average.toFixed(1)}</span>
                                </div>
                              )}
                              {(item as any).genres && (item as any).genres.length > 0 && (
                                <p className="text-purple-300/70 text-[10px] mt-1 line-clamp-1">
                                  {(item as any).genres.slice(0, 2).join(' · ')}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Badge de type */}
                        <div className="absolute top-2 left-2 z-10">
                          <span className={`text-[10px] py-0.5 px-2 rounded font-medium text-white ${badge.color}`}>
                            {badge.label}
                          </span>
                        </div>

                        {/* Numéro */}
                        <div className={`absolute top-2 z-10 ${canWatchlistMedia ? 'right-12' : 'right-2'}`}>
                          <span className="text-[10px] py-0.5 px-1.5 rounded font-mono font-medium bg-black/60 text-white/70 border border-white/10">
                            #{index + 1}
                          </span>
                        </div>

                        {/* Lien externe icon au hover */}
                        <div className="absolute bottom-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="p-1.5 rounded-full bg-purple-600/80 backdrop-blur-sm">
                            <ExternalLink className="w-3 h-3 text-white" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                  </AgeRestrictedMedia>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto text-center pb-12"
        >
          <AnimatedBorderCard
            highlightColor="168 85 247"
            backgroundColor="10 10 10"
            className="p-8 backdrop-blur-sm"
          >
            <Share2 className="w-10 h-10 text-purple-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-white mb-2">{t('lists.wantToCreateList')}</h3>
            <p className="text-white/50 text-sm mb-6 max-w-md mx-auto">
              {t('lists.createAccountPrompt')}
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link to="/profile?tab=custom-lists">
                <Button className="bg-purple-600 hover:bg-purple-700 text-white px-6 h-11 gap-2">
                  <List className="w-4 h-4" />
                  {t('lists.createMyList')}
                </Button>
              </Link>
              <Link to="/">
                <Button variant="ghost" className="border border-white/20 hover:border-white/40 text-white h-11 px-5 gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  {t('common.backToHome')}
                </Button>
              </Link>
            </div>
          </AnimatedBorderCard>
        </motion.div>
      </div>
    </SquareBackground>

    {/* Modal de signalement */}
    {createPortal(
      <AnimatePresence mode="wait">
        {reportModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
            onClick={(e) => { if (e.target === e.currentTarget) { setReportModal(false); setReportReason(''); setReportDetails(''); } }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-700/50 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-full bg-orange-500/10 flex items-center justify-center">
                  <Flag className="w-5 h-5 text-orange-500" />
                </div>
                <h3 className="text-lg font-bold text-white">
                  {t('comments.reportTitle', 'Signaler cette liste')}
                </h3>
              </div>

              <div className="space-y-3 mb-5">
                {REPORT_REASONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setReportReason(r.value)}
                    className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      reportReason === r.value
                        ? 'bg-orange-600/20 text-orange-400 border border-orange-500/50'
                        : 'bg-gray-800 text-gray-300 border border-gray-700/50 hover:bg-gray-700'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              <textarea
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value.slice(0, 500))}
                placeholder={t('comments.reportDetailsPlaceholder', 'Détails supplémentaires (optionnel)...')}
                className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 border border-gray-700/50 focus:border-orange-500/50 focus:outline-none resize-none mb-5"
                rows={3}
              />

              <div className="flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => { setReportModal(false); setReportReason(''); setReportDetails(''); }}
                  className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition-colors text-sm"
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleReport}
                  disabled={!reportReason || reportSubmitting}
                  className="flex-1 px-4 py-2.5 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl font-medium transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <Flag className="w-4 h-4" />
                  {reportSubmitting ? t('common.loading') : t('comments.reportSubmit', 'Signaler')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      getOverlayPortalRoot()
    )}
    </>
  );
};

export default SharedListPage;
