import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Download, Calendar, Star, Loader, AlertCircle, Copy, ExternalLink, X, Crown, Unlock } from 'lucide-react';
import AdFreePlayerAds from '../components/AdFreePlayerAds';
import { toast } from 'sonner';
import { getTmdbLanguage } from '../i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

interface DownloadLink {
  id: string;
  // URL directe de téléchargement (1fichier, sendcm, …) renvoyée par
  // /api/v1/titles/{titleId}/content/liens. Null pour darkibox (où on
  // construit toujours l'URL d'embed côté serveur via /decode).
  lien?: string | null;
  id_user?: string;
  language?: string;
  quality?: string;
  sub?: string;
  provider: string;
  host_id: number;
  host_name: string;
  size?: number | string;
  upload_date?: string;
  episode_id?: string;
  episode_number?: number;
  host_icon?: string;
  view?: number;
  saison?: number;
  episode?: number;
  full_saison?: number;
  source?: 'movix' | 'darkiworld';
  url?: string;
  added_at?: string | null;
  added_by?: { username: string; avatar: string | null };
}

// Interfaces pour les données DarkiWorld
interface DarkiWorldSeason {
  id: number;
  poster: string;
  release_date: string;
  number: number;
  title_id: number;
  episodes_count: number;
  model_type: string;
  first_episode: {
    id: number;
    name: string;
    description: string;
    poster: string;
    release_date: string;
    title_id: number;
    season_id: number;
    season_number: number;
    episode_number: number;
    runtime: number;
    allow_update: boolean;
    have_link: number;
    have_streaming: number;
    created_at: string;
    updated_at: string;
    temp_id: string | null;
    popularity: number | null;
    downvotes: number;
    upvotes: number;
    model_type: string;
    rating: number;
    vote_count: number;
    status: string;
    year: number | null;
  };
}

interface DarkiWorldEpisode {
  id: number;
  name: string;
  description: string | null;
  poster: string;
  release_date: string;
  title_id: number;
  season_id: number;
  season_number: number;
  episode_number: number;
  runtime: number;
  allow_update: boolean;
  have_link: number;
  have_streaming: number;
  created_at: string;
  updated_at: string;
  temp_id: string | null;
  popularity: number | null;
  downvotes: number;
  upvotes: number;
  model_type: string;
  rating: number;
  vote_count: number;
  status: string;
  year: number | null;
  primary_video?: {
    id: number;
    lien: string;
    id_host: number;
    id_darkibox: number;
    o_darkibox: number;
    title_id: number;
    id_user: string;
    id_link: string | null;
    idallo: string | null;
    taille: number;
    id_partie: string;
    total_parts: number;
    numero: number;
    episode: number;
    episode_id: number;
    full_saison: number;
    reported: boolean;
    qualite: number;
    saison: number;
    active: number;
    view: number;
    streaming: boolean;
    revived: string | null;
    from_user: boolean;
    queue_check: string | null;
    last_dl: string;
    downvotes: number;
    upvotes: number;
    to_expire: number;
    checked_date: string;
    updated_at: string;
    created_at: string;
    deleted_at: string | null;
    model_type: string;
  };
}

interface PaginationInfo {
  current_page: number;
  data: any[];
  from: number;
  last_page?: number;
  next_page: number | null;
  per_page: string | number;
  prev_page: number | null;
  to: number;
  total?: number;
}

interface DecodedLink {
  success: boolean;
  id: string;
  provider: string;
  embed_url: string | {
    id: number;
    lien: string;
    id_host: number;
    id_darkibox: string | null;
    o_darkibox: number;
    title_id: number;
    id_user: string;
    id_link: string | null;
    idallo: string | null;
    taille: number;
    id_partie: string | null;
    total_parts: number;
    numero: string | null;
    episode: string | null;
    episode_id: string | null;
    full_saison: number;
    reported: boolean;
    qualite: number;
    saison: number;
    active: number;
    view: number;
    streaming: boolean;
    revived: string | null;
    from_user: boolean;
    queue_check: string | null;
    last_dl: string;
    downvotes: number;
    upvotes: number;
    to_expire: number;
    checked_date: string;
    updated_at: string;
    created_at: string;
    deleted_at: string | null;
    model_type: string;
  };
  metadata?: {
    language?: string;
    quality?: string;
    sub?: string;
    size?: string;
    upload_date?: string;
  };
}

interface Season {
  season_number: number;
  episode_count: number;
  name?: string;
  overview?: string;
  poster_path?: string;
}

interface Episode {
  episode_number: number;
  name: string;
  overview?: string;
  still_path?: string;
  air_date?: string;
  vote_average?: number;
}

interface TMDBDetails {
  id: number;
  name?: string;
  title?: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  vote_average: number;
  first_air_date?: string;
  release_date?: string;
  genres: { id: number; name: string }[];
  seasons?: Season[];
}

// Composant dropdown personnalisé pour les saisons
const SeasonDropdown: React.FC<{
  seasons: Season[];
  darkiWorldSeasons: DarkiWorldSeason[];
  selectedSeason: number;
  selectedDarkiWorldSeason: DarkiWorldSeason | null;
  onSeasonSelect: (seasonNumber: number) => void;
  onDarkiWorldSeasonSelect: (season: DarkiWorldSeason) => void;
  isOpen: boolean;
  onToggle: () => void;
  pagination: PaginationInfo | null;
  onPageChange: (page: number) => void;
  isLoadingMore?: boolean;
}> = ({ 
  seasons, 
  darkiWorldSeasons, 
  selectedSeason, 
  selectedDarkiWorldSeason,
  onSeasonSelect, 
  onDarkiWorldSeasonSelect,
  isOpen, 
  onToggle,
  pagination,
  onPageChange,
  isLoadingMore
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (isOpen) {
          onToggle();
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onToggle]);

  // Utiliser les données DarkiWorld si disponibles, sinon fallback vers TMDB
  const displaySeasons = darkiWorldSeasons.length > 0 ? darkiWorldSeasons : seasons;
  const isDarkiWorld = darkiWorldSeasons.length > 0;

  // Gestion du scroll infini pour les saisons DarkiWorld
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !isDarkiWorld || !pagination || !pagination.next_page) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      // Charger la page suivante quand on arrive à 80% du scroll
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        onPageChange(pagination.next_page!);
      }
    };

    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [isDarkiWorld, pagination, onPageChange]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between bg-white/5 border border-gray-700/50 rounded-xl p-3 text-white hover:bg-white/10 transition-colors"
      >
        <span>
          {isDarkiWorld && selectedDarkiWorldSeason
            ? t('download.seasonNumber', { number: selectedDarkiWorldSeason.number })
            : t('download.seasonNumber', { number: selectedSeason })
          }
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </motion.div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="absolute top-full left-0 right-0 mt-1 bg-gray-900/95 border border-gray-700 rounded-xl shadow-xl max-h-60 overflow-y-auto z-50"
            ref={scrollRef}
            data-lenis-prevent
          >
            {displaySeasons.map((season) => (
              <button
                key={isDarkiWorld ? (season as DarkiWorldSeason).id : (season as Season).season_number}
                onClick={() => {
                  if (isDarkiWorld) {
                    onDarkiWorldSeasonSelect(season as DarkiWorldSeason);
                  } else {
                    onSeasonSelect((season as Season).season_number);
                  }
                  onToggle();
                }}
                className={`w-full text-left px-4 py-3 text-sm transition-colors duration-150 ${
                  isDarkiWorld 
                    ? (selectedDarkiWorldSeason?.id === (season as DarkiWorldSeason).id ? 'bg-red-600/20 text-red-400' : 'text-gray-200 hover:bg-gray-700')
                    : (selectedSeason === (season as Season).season_number ? 'bg-red-600/20 text-red-400' : 'text-gray-200 hover:bg-gray-700')
                }`}
              >
                {isDarkiWorld
                  ? t('download.seasonNumber', { number: (season as DarkiWorldSeason).number })
                  : (season as Season).name ? t('download.seasonNumberWithName', { number: (season as Season).season_number, name: (season as Season).name }) : t('download.seasonNumber', { number: (season as Season).season_number })
                }
              </button>
            ))}
            
            {/* Indicateur de chargement pour le scroll infini */}
            {isDarkiWorld && pagination && pagination.next_page && (
              <div className="p-2 text-center">
                <div className="text-xs text-gray-500">
                  {pagination.from}-{pagination.to}{pagination.total ? ` ${t('download.onTotalSeasons', { total: pagination.total })}` : ` ${t('download.seasonsCount')}`}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {isLoadingMore ? t('download.loadingMore') : t('download.scrollToLoadMore')}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Composant dropdown personnalisé pour les épisodes
const EpisodeDropdown: React.FC<{
  episodes: Episode[];
  darkiWorldEpisodes: DarkiWorldEpisode[];
  selectedEpisode: number;
  selectedDarkiWorldEpisode: DarkiWorldEpisode | null;
  onEpisodeSelect: (episodeNumber: number) => void;
  onDarkiWorldEpisodeSelect: (episode: DarkiWorldEpisode) => void;
  isOpen: boolean;
  onToggle: () => void;
  pagination: PaginationInfo | null;
  onPageChange: (page: number) => void;
  isLoadingMore?: boolean;
}> = ({ 
  episodes, 
  darkiWorldEpisodes, 
  selectedEpisode, 
  selectedDarkiWorldEpisode,
  onEpisodeSelect, 
  onDarkiWorldEpisodeSelect,
  isOpen, 
  onToggle,
  pagination,
  onPageChange,
  isLoadingMore
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (isOpen) {
          onToggle();
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onToggle]);

  // Utiliser les données DarkiWorld si disponibles, sinon fallback vers TMDB
  const displayEpisodes = darkiWorldEpisodes.length > 0 ? darkiWorldEpisodes : episodes;
  const isDarkiWorld = darkiWorldEpisodes.length > 0;

  // Gestion du scroll infini pour les épisodes DarkiWorld
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !isDarkiWorld || !pagination || !pagination.next_page) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      // Charger la page suivante quand on arrive à 80% du scroll
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        onPageChange(pagination.next_page!);
      }
    };

    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [isDarkiWorld, pagination, onPageChange]);

  // Debug pagination
  if (isDarkiWorld && pagination) {
    console.log('EpisodeDropdown pagination:', pagination);
    console.log('next_page:', pagination.next_page, 'prev_page:', pagination.prev_page);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between bg-white/5 border border-gray-700/50 rounded-xl p-3 text-white hover:bg-white/10 transition-colors"
      >
        <span>
          {isDarkiWorld && selectedDarkiWorldEpisode
            ? t('download.episodeNumber', { number: selectedDarkiWorldEpisode.episode_number })
            : t('download.episodeNumber', { number: selectedEpisode })
          }
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </motion.div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="absolute top-full left-0 right-0 mt-1 bg-gray-900/95 border border-gray-700 rounded-xl shadow-xl max-h-60 overflow-y-auto z-50"
            ref={scrollRef}
            data-lenis-prevent
          >
            {displayEpisodes.map((episode) => (
              <button
                key={isDarkiWorld ? (episode as DarkiWorldEpisode).id : (episode as Episode).episode_number}
                onClick={() => {
                  if (isDarkiWorld) {
                    onDarkiWorldEpisodeSelect(episode as DarkiWorldEpisode);
                  } else {
                    onEpisodeSelect((episode as Episode).episode_number);
                  }
                  onToggle();
                }}
                className={`w-full text-left px-4 py-3 text-sm transition-colors duration-150 ${
                  isDarkiWorld 
                    ? (selectedDarkiWorldEpisode?.id === (episode as DarkiWorldEpisode).id ? 'bg-red-600/20 text-red-400' : 'text-gray-200 hover:bg-gray-700')
                    : (selectedEpisode === (episode as Episode).episode_number ? 'bg-red-600/20 text-red-400' : 'text-gray-200 hover:bg-gray-700')
                }`}
              >
                {isDarkiWorld
                  ? t('download.episodeNumberWithName', { number: (episode as DarkiWorldEpisode).episode_number, name: (episode as DarkiWorldEpisode).name })
                  : t('download.episodeNumberWithName', { number: (episode as Episode).episode_number, name: (episode as Episode).name })
                }
              </button>
            ))}
            
            {/* Indicateur de chargement pour le scroll infini */}
            {isDarkiWorld && pagination && pagination.next_page && (
              <div className="p-2 text-center">
                <div className="text-xs text-gray-500">
                  {pagination.from}-{pagination.to}{pagination.total ? ` ${t('download.onTotalEpisodes', { total: pagination.total })}` : ` ${t('download.episodesCount')}`}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {isLoadingMore ? t('download.loadingMore') : t('download.scrollToLoadMore')}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const RateLimitInfoButton: React.FC<{ error: string | null }> = ({ error }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const ratelimitedTemplate = t('download.rateLimited', { retryAt: '__X__' });
  const ratelimitedPrefix = ratelimitedTemplate.split('__X__')[0];
  const isRateLimited = !!error && error.startsWith(ratelimitedPrefix);

  if (!isRateLimited) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs sm:text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors mt-1"
      >
        {t('download.rateLimitedLearnMore')}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('download.rateLimitInfoTitle')}</DialogTitle>
            <DialogDescription className="text-sm sm:text-base text-gray-300 leading-relaxed pt-2">
              {t('download.rateLimitInfoBody')}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
};

// Popup de sélection de liens (similaire à AvatarSelector)
const LinkSelector: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  selectedLink: DownloadLink | null;
  isDecoding: boolean;
  decodedLink: DecodedLink | null;
  error: string | null;
  queueInfo?: { size: number } | null;
  // Métadonnées propagées au /debrid pour que le download in-app les retrouve.
  mediaKind: 'movie' | 'series' | 'animes';
  tmdbId: string | undefined;
  posterPath: string | null | undefined;
  currentSeason?: number;
  currentEpisode?: number;
  episodeTitle?: string;
}> = ({ isOpen, onClose, title, selectedLink, isDecoding, decodedLink, error, queueInfo, mediaKind, tmdbId, posterPath, currentSeason, currentEpisode, episodeTitle }) => {
  const { t, i18n } = useTranslation();
  const [isClosing, setIsClosing] = useState(false);
  const isVipUser = localStorage.getItem('is_vip') === 'true';
  const navigate = useNavigate();

  const is1FichierLink = (link: DecodedLink | null): boolean => {
    if (!link) return false;
    const url = typeof link.embed_url === 'string' ? link.embed_url : link.embed_url?.lien || '';
    return url.toLowerCase().includes('1fichier');
  };

  // Disable body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const copyToClipboard = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      toast.success(t('download.copied'));
    });
  };

  const openInNewTab = (url: string) => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const getEmbedUrl = (decodedLink: DecodedLink): string => {
    if (!decodedLink?.embed_url) {
      return '';
    }
    if (typeof decodedLink.embed_url === 'string') {
      return decodedLink.embed_url;
    } else {
      return decodedLink.embed_url?.lien || '';
    }
  };

  const getLinkSize = (decodedLink: DecodedLink): string => {
    if (typeof decodedLink?.embed_url === 'object' && decodedLink.embed_url?.taille) {
      const sizeInMB = decodedLink.embed_url.taille / (1024 * 1024);
      if (sizeInMB > 1024) {
        return `${(sizeInMB / 1024).toFixed(1)} GB`;
      } else {
        return `${sizeInMB.toFixed(1)} MB`;
      }
    }
    return t('download.unknownSize');
  };

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300); // Durée de l'animation de fermeture
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-2 sm:p-4 z-[100000]"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-gray-900/95 backdrop-blur-sm rounded-xl max-w-4xl w-full max-h-[95vh] sm:max-h-[90vh] overflow-hidden border border-gray-700/50"
          >
            <div className="flex items-center justify-between p-3 sm:p-6 border-b border-gray-700">
              <h2 className="text-lg sm:text-xl font-bold text-white truncate pr-2">{t('download.linksForTitle', { title })}</h2>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors flex-shrink-0"
              >
                <X className="w-5 h-5 sm:w-6 sm:h-6" />
              </motion.button>
            </div>

            <div className="p-3 sm:p-6 overflow-y-auto max-h-[calc(95vh-80px)] sm:max-h-[calc(90vh-120px)]">
              {/* Zone d'affichage du lien décodé */}
              {selectedLink && (
                 <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-gray-800/50 rounded-xl border border-gray-700/50">
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-3 sm:mb-4">
                    {t('download.decodedLinkTitle', { provider: selectedLink.provider })}
                  </h3>
                  
                  {isDecoding ? (
                    <div className="flex flex-col items-center justify-center py-6 sm:py-8 gap-2">
                      <div className="flex items-center">
                        <Loader className="w-6 h-6 sm:w-8 sm:h-8 animate-spin text-blue-500" />
                        <span className="ml-2 text-white text-sm sm:text-base">{t('download.decoding')}</span>
                      </div>
                      {queueInfo != null && (
                        <span className="text-gray-400 text-xs sm:text-sm">{t('download.queueWaiting', { size: queueInfo.size })}</span>
                      )}
                    </div>
                  ) : error ? (
                    <div className="flex flex-col text-red-400 text-sm sm:text-base">
                      <div className="flex items-center">
                        <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 mr-2 flex-shrink-0" />
                        <span className="break-words">{error}</span>
                      </div>
                      <RateLimitInfoButton error={error} />
                    </div>
                  ) : decodedLink ? (
                    <div className="space-y-3 sm:space-y-4">
                      
                       <div className="bg-gray-900/50 p-2 sm:p-3 rounded-xl border border-gray-700/50">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs sm:text-sm text-gray-400">{t('download.downloadLink')}</span>
                          <div className="flex items-center gap-1 sm:gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(getEmbedUrl(decodedLink)); }}
                              className="text-blue-400 hover:text-blue-300 transition-colors p-1"
                              title={t('download.copyBtn')}
                            >
                              <Copy className="w-3 h-3 sm:w-4 sm:h-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); openInNewTab(getEmbedUrl(decodedLink)); }}
                              className="text-blue-400 hover:text-blue-300 transition-colors p-1"
                              title={t('download.openNewTab')}
                            >
                              <ExternalLink className="w-3 h-3 sm:w-4 sm:h-4" />
                            </button>
                          </div>
                        </div>
                        <p className="text-white text-xs sm:text-sm break-all leading-relaxed">{getEmbedUrl(decodedLink)}</p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-xs sm:text-sm">
                        {typeof decodedLink.embed_url === 'object' && (
                          <>
                            {selectedLink?.quality && (
                              <div>
                                <span className="text-gray-400">{t('download.quality')}</span>
                                <span className="text-white ml-2">{selectedLink.quality}</span>
                              </div>
                            )}
                            <div>
                              <span className="text-gray-400">{t('download.sizeLabel')}</span>
                              <span className="text-white ml-2">{getLinkSize(decodedLink)}</span>
                            </div>
                            {decodedLink.embed_url.view && (
                              <div>
                                <span className="text-gray-400">{t('download.viewsLabel')}</span>
                                <span className="text-white ml-2">{decodedLink.embed_url.view}</span>
                              </div>
                            )}
                            {decodedLink.embed_url.created_at && (
                              <div>
                                <span className="text-gray-400">{t('download.uploadDateLabel')}</span>
                                <span className="text-white ml-2">{new Date(decodedLink.embed_url.created_at).toLocaleDateString(i18n.language)}</span>
                              </div>
                            )}
                            {decodedLink.embed_url.id_user && (
                              <div>
                                <span className="text-gray-400">{t('download.uploadedBy')}</span>
                                <span className="text-white ml-2">{decodedLink.embed_url.id_user}</span>
                              </div>
                            )}
                          </>
                        )}
                        {/* Langue / sous-titres : download-premium ne les retourne pas,
                            on retombe sur selectedLink (issu de /download/:type/:id). */}
                        {(decodedLink.metadata?.language || selectedLink?.language) && (
                          <div>
                            <span className="text-gray-400">{t('download.languageLabel')}</span>
                            <span className="text-white ml-2">{decodedLink.metadata?.language || selectedLink?.language}</span>
                          </div>
                        )}
                        {(decodedLink.metadata?.sub || selectedLink?.sub) && (
                          <div>
                            <span className="text-gray-400">{t('download.subtitlesLabel')}</span>
                            <span className="text-white ml-2">{decodedLink.metadata?.sub || selectedLink?.sub}</span>
                          </div>
                        )}
                      </div>

                      {/* Debrid section - VIP + 1fichier only */}
                      {isVipUser && is1FichierLink(decodedLink) && (
                        <div className="mt-3 p-3 sm:p-4 bg-gradient-to-r from-yellow-900/20 to-amber-900/20 rounded-xl border border-yellow-500/30">
                          <div className="flex items-center gap-2 mb-2">
                            <Crown className="w-4 h-4 text-yellow-400" />
                            <span className="text-sm font-medium text-yellow-300">{t('download.vipDebridTitle')}</span>
                          </div>
                          <button
                            onClick={() => {
                              const linkUrl = getEmbedUrl(decodedLink!);
                              if (!linkUrl) return;
                              const params = new URLSearchParams({ link: linkUrl });
                              params.set('kind', mediaKind);
                              if (tmdbId) params.set('tmdb', tmdbId);
                              if (title) params.set('title', title);
                              if (posterPath) params.set('poster', posterPath);
                              if (mediaKind !== 'movie') {
                                if (currentSeason != null) params.set('s', String(currentSeason));
                                if (currentEpisode != null) params.set('e', String(currentEpisode));
                                if (episodeTitle) params.set('etitle', episodeTitle);
                              }
                              const meta = decodedLink?.metadata || selectedLink || {};
                              const lang = (meta as { language?: string }).language;
                              const quality = (meta as { quality?: string }).quality;
                              if (lang) params.set('lang', lang);
                              if (quality) params.set('q', quality);
                              navigate(`/debrid?${params.toString()}`);
                            }}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-yellow-600 hover:bg-yellow-700 rounded-lg text-white text-sm font-medium transition-colors"
                          >
                            <Unlock className="w-4 h-4" />
                            {t('download.debridBtn')}
                          </button>
                        </div>
                      )}

                      {/* VIP promo for non-VIP users on 1fichier links */}
                      {!isVipUser && is1FichierLink(decodedLink) && (
                        <div className="mt-3 p-3 bg-yellow-900/10 rounded-xl border border-yellow-500/20">
                          <div className="flex items-center gap-2 text-sm">
                            <Crown className="w-4 h-4 text-yellow-500 opacity-60" />
                            <span className="text-yellow-300/60">{t('download.vipDebridPromo')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const DownloadPage: React.FC = () => {
  const { type, id } = useParams<{ type: 'movie' | 'tv'; id: string }>();
  const { t, i18n } = useTranslation();

  const formatFileSize = (sizeInBytes: number): string => {
    if (!sizeInBytes || sizeInBytes === 0) return t('download.unknownSize');
    
    const sizeInMB = sizeInBytes / (1024 * 1024);
    const sizeInGB = sizeInMB / 1024;
    
    if (sizeInGB >= 1) {
      return `${sizeInGB.toFixed(1)} GB`;
    } else {
      return `${sizeInMB.toFixed(1)} MB`;
    }
  };

  // Fonction pour trier les liens selon l'ordre de priorité (Movix en premier)
  const sortDownloadLinks = (links: DownloadLink[]): DownloadLink[] => {
    const movix = links.filter(l => l.source === 'movix');
    const rest = links.filter(l => l.source !== 'movix');

    const priorityOrder: Record<string, number> = {
      '1fichier': 1,
      'sendcm': 2,
      'darkibox': 3
    };

    const sortedRest = [...rest].sort((a, b) => {
      const priorityA = priorityOrder[(a.provider || '').toLowerCase()] || 999;
      const priorityB = priorityOrder[(b.provider || '').toLowerCase()] || 999;

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Si même priorité, trier par taille (plus grand en premier)
      const toBytes = (s: number | string | undefined) => typeof s === 'number' ? s : 0;
      const sizeA = toBytes(a.size);
      const sizeB = toBytes(b.size);
      return sizeB - sizeA;
    });

    return [...movix, ...sortedRest];
  };
  
  const [tmdbDetails, setTmdbDetails] = useState<TMDBDetails | null>(null);
  // mediaKind = catégorie utilisée par la page Downloads in-app pour grouper.
  // - 'movie' : déduit directement du param URL.
  // - 'series' / 'animes' : lit `title.type` retourné par /api/darkiworld/seasons.
  const [mediaKind, setMediaKind] = useState<'movie' | 'series' | 'animes'>(
    type === 'movie' ? 'movie' : 'series',
  );
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [selectedEpisode, setSelectedEpisode] = useState<number>(1);
  
  // États pour les données DarkiWorld
  const [darkiWorldSeasons, setDarkiWorldSeasons] = useState<DarkiWorldSeason[]>([]);
  const [darkiWorldEpisodes, setDarkiWorldEpisodes] = useState<DarkiWorldEpisode[]>([]);
  const [seasonsPagination, setSeasonsPagination] = useState<PaginationInfo | null>(null);
  const [episodesPagination, setEpisodesPagination] = useState<PaginationInfo | null>(null);
  const [selectedDarkiWorldSeason, setSelectedDarkiWorldSeason] = useState<DarkiWorldSeason | null>(null);
  const [selectedDarkiWorldEpisode, setSelectedDarkiWorldEpisode] = useState<DarkiWorldEpisode | null>(null);
  const [downloadLinks, setDownloadLinks] = useState<DownloadLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // États pour les dropdowns
  const [isSeasonDropdownOpen, setIsSeasonDropdownOpen] = useState(false);
  const [isEpisodeDropdownOpen, setIsEpisodeDropdownOpen] = useState(false);
  const [isLoadingMoreSeasons, setIsLoadingMoreSeasons] = useState(false);
  const [isLoadingMoreEpisodes, setIsLoadingMoreEpisodes] = useState(false);
  const [directEpisodeInput, setDirectEpisodeInput] = useState('');
  const [showLinkSelector, setShowLinkSelector] = useState(false);
  const [selectedLink, setSelectedLink] = useState<DownloadLink | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [decodedLink, setDecodedLink] = useState<DecodedLink | null>(null);
  const [queueInfo, setQueueInfo] = useState<{ size: number } | null>(null);
  const [showAdPopup, setShowAdPopup] = useState(false);
  const [pendingLinkToDecode, setPendingLinkToDecode] = useState<DownloadLink | null>(null);
  const [adUnlocked, setAdUnlocked] = useState(false);
  // ID DarkiWorld du titre courant — passé à /decode?title_id=X pour résoudre
  // les liens via le nouvel endpoint /api/v1/titles/{titleId}/content/liens.
  const [currentDarkiWorldTitleId, setCurrentDarkiWorldTitleId] = useState<string | null>(null);
  
  // Ref pour stocker l'AbortController de la requête de décodage
  const decodeAbortControllerRef = useRef<AbortController | null>(null);
  
  // Vérifier le statut VIP au chargement et écouter les changements
  useEffect(() => {
    const checkVipStatus = () => {
      const isVipUser = localStorage.getItem('is_vip') === 'true';
      if (isVipUser) {
        setAdUnlocked(true);
      }
    };

    // Vérifier au chargement
    checkVipStatus();

    // Écouter les changements dans le localStorage
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'is_vip') {
        checkVipStatus();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Nettoyage des requêtes en cours lors du démontage du composant
  useEffect(() => {
    return () => {
      // Annuler toute requête en cours lors du démontage
      if (decodeAbortControllerRef.current) {
        decodeAbortControllerRef.current.abort();
      }
    };
  }, []);

  // Récupérer les détails TMDB
  useEffect(() => {
    const fetchTMDBDetails = async () => {
      try {
        setLoading(true);
        const response = await axios.get(
          `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
        );
        setTmdbDetails(response.data);
        
        if (type === 'tv' && response.data.seasons) {
          setSeasons(response.data.seasons);
        }
      } catch (err) {
        setError(t('download.errorLoadingDetails'));
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchTMDBDetails();
    }
  }, [id, type]);

  // Récupérer les épisodes pour la saison sélectionnée
  useEffect(() => {
    const fetchEpisodes = async () => {
      if (type === 'tv' && id && selectedSeason !== undefined) {
        try {
          const response = await axios.get(
            `https://api.themoviedb.org/3/tv/${id}/season/${selectedSeason}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
          );
          setEpisodes(response.data.episodes);
          // Réinitialiser l'épisode sélectionné au premier épisode de la nouvelle saison
          if (response.data.episodes && response.data.episodes.length > 0) {
            setSelectedEpisode(1);
          }
        } catch (err) {
          console.error('Erreur lors du chargement des épisodes:', err);
          // En cas d'erreur, vider la liste des épisodes
          setEpisodes([]);
        }
      }
    };

    fetchEpisodes();
  }, [id, selectedSeason, type]);

  // Charger les saisons DarkiWorld quand on a l'ID DarkiWorld
  useEffect(() => {
    const loadDarkiWorldSeasons = async () => {
      if (type === 'tv' && id && tmdbDetails) {
        const darkiWorldId = await findDarkiWorldId();
        if (darkiWorldId) {
          await fetchDarkiWorldSeasons(darkiWorldId);
        }
      }
    };

    loadDarkiWorldSeasons();
  }, [id, tmdbDetails, type]);

  // Charger les épisodes DarkiWorld quand on change de saison
  useEffect(() => {
    const loadDarkiWorldEpisodes = async () => {
      if (type === 'tv' && selectedDarkiWorldSeason && tmdbDetails) {
        const darkiWorldId = await findDarkiWorldId();
        if (darkiWorldId) {
          await fetchDarkiWorldEpisodes(darkiWorldId, selectedDarkiWorldSeason.number);
        }
      }
    };

    loadDarkiWorldEpisodes();
  }, [selectedDarkiWorldSeason, tmdbDetails, type]);

  // Fonctions de gestion des changements de page
  const handleSeasonsPageChange = async (page: number) => {
    if (type === 'tv' && tmdbDetails && !isLoadingMoreSeasons) {
      setIsLoadingMoreSeasons(true);
      const darkiWorldId = await findDarkiWorldId();
      if (darkiWorldId) {
        await fetchDarkiWorldSeasons(darkiWorldId, page, true); // append = true pour le scroll infini
      }
      setIsLoadingMoreSeasons(false);
    }
  };

  const handleEpisodesPageChange = async (page: number) => {
    if (type === 'tv' && selectedDarkiWorldSeason && tmdbDetails && !isLoadingMoreEpisodes) {
      setIsLoadingMoreEpisodes(true);
      const darkiWorldId = await findDarkiWorldId();
      if (darkiWorldId) {
        await fetchDarkiWorldEpisodes(darkiWorldId, selectedDarkiWorldSeason.number, page, true); // append = true pour le scroll infini
      }
      setIsLoadingMoreEpisodes(false);
    }
  };

  // Fonctions de gestion des sélections
  const handleDarkiWorldSeasonSelect = (season: DarkiWorldSeason) => {
    setSelectedDarkiWorldSeason(season);
    setSelectedDarkiWorldEpisode(null); // Reset episode selection
    setIsSeasonDropdownOpen(false);
  };

  const handleDarkiWorldEpisodeSelect = (episode: DarkiWorldEpisode) => {
    setSelectedDarkiWorldEpisode(episode);
    setIsEpisodeDropdownOpen(false);
  };

  // Fonction pour sélectionner directement un épisode par numéro et récupérer les liens
  const handleDirectEpisodeSelect = async () => {
    const episodeNumber = parseInt(directEpisodeInput);
    if (isNaN(episodeNumber) || episodeNumber < 1) {
      setError(t('download.enterValidEpisode'));
      return;
    }

    setError(null);
    setLoadingLinks(true);

    try {
      // Récupérer l'ID DarkiWorld
      const darkiWorldId = await findDarkiWorldId();
      if (!darkiWorldId) {
        setError(t('download.notFoundOnSource'));
        return;
      }
      setCurrentDarkiWorldTitleId(darkiWorldId);

      // Déterminer la saison à utiliser
      let seasonNumber = 1;
      if (selectedDarkiWorldSeason) {
        seasonNumber = selectedDarkiWorldSeason.number;
      } else if (selectedSeason !== undefined) {
        seasonNumber = selectedSeason;
      }

      // Faire directement la requête des liens pour cet épisode
      const response = await axios.get(`${MAIN_API}/api/darkiworld/download/tv/${darkiWorldId}?season=${seasonNumber}&episode=${episodeNumber}&tmdbId=${id}`);

      console.log('Réponse directe épisode:', response.data);

      if (response.data.success && response.data.all && response.data.all.length > 0) {
        const sortedLinks = sortDownloadLinks(response.data.all);
        setDownloadLinks(sortedLinks);
        setError(null);
        
        // Mettre à jour l'épisode sélectionné
        if (selectedDarkiWorldSeason) {
          // Créer un objet épisode temporaire pour l'affichage
          const tempEpisode: DarkiWorldEpisode = {
            id: 0,
            name: t('download.episodeNumber', { number: episodeNumber }),
            description: null,
            poster: '',
            release_date: '',
            title_id: parseInt(darkiWorldId),
            season_id: 0,
            season_number: seasonNumber,
            episode_number: episodeNumber,
            runtime: 0,
            allow_update: false,
            have_link: 1,
            have_streaming: 0,
            created_at: '',
            updated_at: '',
            temp_id: null,
            popularity: null,
            downvotes: 0,
            upvotes: 0,
            model_type: 'episode',
            rating: 0,
            vote_count: 0,
            status: 'released',
            year: null
          };
          setSelectedDarkiWorldEpisode(tempEpisode);
        } else {
          setSelectedEpisode(episodeNumber);
        }
        
        setDirectEpisodeInput('');
      } else {
        setError(t('download.noLinksFound'));
        setDownloadLinks([]);
      }
    } catch (err: any) {
      console.error('Erreur lors de la récupération des liens:', err);
      setError(err.response?.data?.error || t('download.errorFetchingLinks'));
      setDownloadLinks([]);
    } finally {
      setLoadingLinks(false);
    }
  };

  // Récupérer les saisons depuis DarkiWorld
  const fetchDarkiWorldSeasons = async (titleId: string, page: number = 1, append: boolean = false) => {
    try {
      const response = await axios.get(`${MAIN_API}/api/darkiworld/seasons/${titleId}?page=${page}&perPage=8&mode=auto`);
      const titleType = response.data?.title?.type;
      if (titleType === 'animes' || titleType === 'series') {
        setMediaKind(titleType);
      }
      if (response.data.success && response.data.pagination) {
        console.log('Pagination seasons:', response.data.pagination);

        if (append && page > 1) {
          // Pour le scroll infini, ajouter les nouvelles saisons aux existantes
          setDarkiWorldSeasons(prev => [...prev, ...response.data.pagination.data]);
        } else {
          // Pour le chargement initial, remplacer les saisons
          setDarkiWorldSeasons(response.data.pagination.data);
          
          // Sélectionner la première saison par défaut
          if (response.data.pagination.data.length > 0) {
            setSelectedDarkiWorldSeason(response.data.pagination.data[0]);
          }
        }
        
        setSeasonsPagination(response.data.pagination);
      }
    } catch (err) {
      console.error('Erreur lors du chargement des saisons sur notre source de téléchargement:', err);
    }
  };

  // Récupérer les épisodes depuis DarkiWorld
  const fetchDarkiWorldEpisodes = async (titleId: string, seasonNumber: number, page: number = 1, append: boolean = false) => {
    try {
      const response = await axios.get(`${MAIN_API}/api/darkiworld/episodes/${titleId}/${seasonNumber}?page=${page}&perPage=30`);
      if (response.data.success && response.data.pagination) {
        console.log('Pagination episodes:', response.data.pagination);

        if (append && page > 1) {
          // Pour le scroll infini, ajouter les nouveaux épisodes aux existants
          setDarkiWorldEpisodes(prev => [...prev, ...response.data.pagination.data]);
        } else {
          // Pour le chargement initial, remplacer les épisodes
          setDarkiWorldEpisodes(response.data.pagination.data);
          
          // Sélectionner le premier épisode par défaut
          if (response.data.pagination.data.length > 0) {
            setSelectedDarkiWorldEpisode(response.data.pagination.data[0]);
          }
        }
        
        setEpisodesPagination(response.data.pagination);
      }
    } catch (err) {
      console.error('Erreur lors du chargement des épisodes sur notre source de téléchargement:', err);
    }
  };

  // Rechercher l'ID DarkiWorld du contenu
  const findDarkiWorldId = async (): Promise<string | null> => {
    if (!id || !tmdbDetails) return null;

    try {
      const searchResponse = await axios.get(`${MAIN_API}/api/search`, {
        params: {
          title: tmdbDetails.name || tmdbDetails.title
        }
      });

      if (!searchResponse.data.results) {
        return null;
      }

      const normalizeName = (s: string) => s.toLowerCase().trim();
      const targetName = normalizeName(tmdbDetails.name || tmdbDetails.title || '');

      if (type === 'movie') {
        // Pour les films, chercher par tmdb_id exact
        let matchingMovie = searchResponse.data.results.find((result: any) => {
          return (result.have_streaming === 1 || result.have_streaming === 0) &&
                 result.type !== 'series' &&
                 result.tmdb_id &&
                 String(result.tmdb_id) === String(id);
        });
        // Fallback: matcher par nom si aucun tmdb_id ne correspond
        if (!matchingMovie && targetName) {
          matchingMovie = searchResponse.data.results.find((result: any) => {
            return result.name && normalizeName(result.name) === targetName &&
                   result.type !== 'series' && result.type !== 'animes' && result.type !== 'doc';
          });
        }
        return matchingMovie ? matchingMovie.id : null;
      } else {
        // Pour les séries, chercher par tmdb_id exact
        let matchingShow = searchResponse.data.results.find((result: any) => {
          return (result.type === 'series' || result.type === 'animes' || result.type === 'doc') &&
                 result.tmdb_id &&
                 String(result.tmdb_id) === String(id);
        });
        // Fallback: matcher par nom si aucun tmdb_id ne correspond
        if (!matchingShow && targetName) {
          matchingShow = searchResponse.data.results.find((result: any) => {
            return result.name && normalizeName(result.name) === targetName &&
                   result.type !== 'movie';
          });
        }
        return matchingShow ? matchingShow.id : null;
      }
    } catch (err) {
      console.error('Erreur lors de la recherche sur notre source de téléchargement:', err);
      return null;
    }
  };

  // Récupérer les liens de téléchargement
  const fetchDownloadLinks = async () => {
    if (!id) return;

    try {
      setLoadingLinks(true);
      setError(null);
      
      // D'abord trouver l'ID DarkiWorld
      const darkiWorldId = await findDarkiWorldId();

      if (!darkiWorldId) {
        setError(t('download.contentNotFound'));
        return;
      }
      setCurrentDarkiWorldTitleId(darkiWorldId);

      // Pour les séries, charger les saisons DarkiWorld si pas encore fait
      if (type === 'tv' && darkiWorldSeasons.length === 0) {
        await fetchDarkiWorldSeasons(darkiWorldId);
      }
      
      // Utiliser l'ID DarkiWorld pour récupérer les liens
      let url: string;
      if (type === 'movie') {
        url = `${MAIN_API}/api/darkiworld/download/movie/${darkiWorldId}?tmdbId=${id}`;
      } else {
        // Pour les séries, utiliser les données DarkiWorld si disponibles
        if (selectedDarkiWorldSeason && selectedDarkiWorldEpisode) {
          url = `${MAIN_API}/api/darkiworld/download/tv/${darkiWorldId}?season=${selectedDarkiWorldSeason.number}&episode=${selectedDarkiWorldEpisode.episode_number}&tmdbId=${id}`;
        } else {
          // Fallback vers les données TMDB
          url = `${MAIN_API}/api/darkiworld/download/tv/${darkiWorldId}?season=${selectedSeason}&episode=${selectedEpisode}&tmdbId=${id}`;
        }
      }
      
      const response = await axios.get(url);
      const links = response.data.all || [];
      setDownloadLinks(sortDownloadLinks(links));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erreur lors du chargement des liens');
    } finally {
      setLoadingLinks(false);
    }
  };

  const handleGetLinks = () => {
    fetchDownloadLinks();
  };

  // Construit un DecodedLink synthétique à partir d'un DownloadLink
  // qui possède déjà son URL directe (cas 1fichier/sendcm/… via le nouvel
  // endpoint /api/v1/titles/{titleId}/content/liens). Évite un aller-retour
  // sur /decode dont l'API darkino renvoie désormais des embeds invalides.
  const buildSyntheticDecodedLink = (link: DownloadLink, lien: string): DecodedLink => ({
    success: true,
    id: link.id,
    provider: link.provider,
    embed_url: {
      id: parseInt(link.id, 10) || 0,
      lien,
      id_host: link.host_id || 0,
      id_darkibox: null,
      o_darkibox: 0,
      title_id: 0,
      id_user: link.id_user || '',
      id_link: null,
      idallo: null,
      taille: typeof link.size === 'number' ? link.size : 0,
      id_partie: null,
      total_parts: 0,
      numero: null,
      episode: link.episode != null ? String(link.episode) : null,
      episode_id: link.episode_id ?? null,
      full_saison: link.full_saison || 0,
      reported: false,
      qualite: 0,
      saison: link.saison || 0,
      active: 1,
      view: link.view || 0,
      streaming: false,
      revived: null,
      from_user: false,
      queue_check: null,
      last_dl: '',
      downvotes: 0,
      upvotes: 0,
      to_expire: 0,
      checked_date: '',
      updated_at: '',
      created_at: link.upload_date || '',
      deleted_at: null,
      model_type: 'lien',
    },
    metadata: {
      language: link.language,
      quality: link.quality,
      sub: link.sub,
      size: typeof link.size === 'number' ? String(link.size) : undefined,
      upload_date: link.upload_date,
    },
  });

  const proceedDecode = async (link: DownloadLink) => {
    // Annuler la requête précédente si elle existe
    if (decodeAbortControllerRef.current) {
      decodeAbortControllerRef.current.abort();
      decodeAbortControllerRef.current = null;
    }

    setSelectedLink(link);
    setError(null);
    setDecodedLink(null);
    setQueueInfo(null);
    setShowLinkSelector(true);

    // Les liens Movix sont déjà des URLs directes (1fichier, Mega, …) ajoutées
    // côté admin : pas de décodage Darkino nécessaire.
    if (link.source === 'movix' && link.url) {
      setIsDecoding(false);
      setDecodedLink({
        success: true,
        id: link.id,
        provider: link.provider || 'movix',
        embed_url: link.url,
        metadata: {
          language: link.language,
          quality: link.quality,
          sub: link.sub,
          size: typeof link.size === 'number' ? String(link.size) : link.size,
          upload_date: link.added_at || link.upload_date,
        },
      });
      return;
    }

    // Chemin rapide darkiworld : si le backend a déjà fourni l'URL directe
    // (cas non-darkibox via /api/v1/titles/{id}/content/liens), on évite
    // l'appel à /decode dont l'API darkino retourne des embeds invalides.
    if (link.lien) {
      setIsDecoding(false);
      setDecodedLink(buildSyntheticDecodedLink(link, link.lien));
      return;
    }

    setIsDecoding(true);

    // Créer un nouveau AbortController pour cette requête
    const abortController = new AbortController();
    decodeAbortControllerRef.current = abortController;

    try {
      // On passe `title_id` pour permettre au backend d'utiliser le nouvel
      // endpoint /api/v1/titles/{titleId}/content/liens en fallback.
      const params: Record<string, string> = {};
      if (currentDarkiWorldTitleId) params.title_id = currentDarkiWorldTitleId;

      const POLL_INTERVAL_MS = 5000;
      const MAX_POLL_ATTEMPTS = 60; // ~5 min max
      let attempts = 0;
      let response: any = null;

      while (attempts < MAX_POLL_ATTEMPTS) {
        if (abortController.signal.aborted) return;
        response = await axios.get(`${MAIN_API}/api/darkiworld/decode/${link.id}`, {
          params,
          signal: abortController.signal,
          validateStatus: () => true
        });

        if (response.status === 200) break;

        if (response.status === 202) {
          // Queued — show user the queue position
          setQueueInfo({ size: response.data?.queue_size ?? 0 });
          attempts += 1;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        if (response.status === 503 && response.data?.error === 'rate_limited') {
          setError(t('download.rateLimited', { retryAt: new Date(response.data.retry_at).toLocaleTimeString() }));
          return;
        }

        if (response.status === 503 && response.data?.error === 'queue_unavailable') {
          setError(response.data?.message || t('download.queueUnavailable'));
          return;
        }

        if (response.status === 404) {
          setError(response.data?.error || t('download.decodeFailed'));
          return;
        }

        // Unknown status
        setError(t('download.decodeFailed'));
        return;
      }

      if (!response || response.status !== 200) {
        setError(t('download.queueTimeout'));
        return;
      }

      // At this point, response.data is the decoded payload
      setDecodedLink(response.data);
    } catch (err: any) {
      // Ne pas afficher d'erreur si la requête a été annulée
      if (err.name !== 'CanceledError' && err.code !== 'ERR_CANCELED') {
        setError(err.response?.data?.error || t('download.errorDecodingLink'));
      }
    } finally {
      setIsDecoding(false);
      // Nettoyer la référence si c'est la requête actuelle
      if (decodeAbortControllerRef.current === abortController) {
        decodeAbortControllerRef.current = null;
      }
    }
  };

  const handleLinkSelect = async (link: DownloadLink) => {
    // Vérifier si l'utilisateur est VIP
    const isVipUser = localStorage.getItem('is_vip') === 'true';
    
    if (adUnlocked || isVipUser) {
      await proceedDecode(link);
      return;
    }
    setPendingLinkToDecode(link);
    setShowAdPopup(true);
  };

  const handleAdPopupClose = () => {
    setShowAdPopup(false);
    setPendingLinkToDecode(null);
  };

  // Fonction pour fermer la popup de sélection de liens et annuler la requête
  const handleLinkSelectorClose = () => {
    // Annuler la requête de décodage en cours
    if (decodeAbortControllerRef.current) {
      decodeAbortControllerRef.current.abort();
      decodeAbortControllerRef.current = null;
    }
    
    // Réinitialiser les états
    setShowLinkSelector(false);
    setIsDecoding(false);
    setDecodedLink(null);
    setError(null);
    setSelectedLink(null);
    setQueueInfo(null);
  };

  const handleAdPopupAccept = async () => {
    const link = pendingLinkToDecode;
    setShowAdPopup(false);
    if (link) {
      await proceedDecode(link);
      setPendingLinkToDecode(null);
    }
    setAdUnlocked(true);
  };

  

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center justify-center">
          <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-red-500 mb-4"></div>
          <p className="text-gray-400 text-center">{t('download.loadingDetails')}</p>
        </div>
      </div>
    );
  }

  

  if (error && !tmdbDetails) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="text-white text-lg">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white pt-20 pb-24">
      <div className="container mx-auto px-4 md:px-6 lg:px-10">

        {tmdbDetails && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 lg:gap-8">
            {/* Informations du contenu */}
            <div className="lg:col-span-1">
              <div className="bg-gray-800/50 rounded-xl p-4 sm:p-6 border border-gray-700/50">
                <img
                  src={`https://image.tmdb.org/t/p/w500${tmdbDetails.poster_path}`}
                  alt={tmdbDetails.name || tmdbDetails.title}
                  className="w-full rounded-lg mb-4"
                  loading="lazy"
                  decoding="async"
                />
                <h2 className="text-xl font-bold mb-2">
                  {tmdbDetails.name || tmdbDetails.title}
                </h2>
                <p className="text-gray-400 text-sm mb-4">
                  {tmdbDetails.overview}
                </p>
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1">
                    <Star className="w-4 h-4 text-yellow-500" />
                    <span>{tmdbDetails.vote_average.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="w-4 h-4 text-gray-400" />
                    <span>{tmdbDetails.first_air_date || tmdbDetails.release_date}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sélection et liens */}
            <div className="lg:col-span-2">
              <div className="bg-gray-800/50 rounded-xl p-4 sm:p-6 border border-gray-700/50">
                {type === 'tv' ? (
                  <div className="space-y-4 sm:space-y-6">
                    {/* Sélection de saison */}
                    <div>
                      <label className="block text-sm font-medium mb-2">{t('download.season')}</label>
                      <SeasonDropdown
                        seasons={seasons}
                        darkiWorldSeasons={darkiWorldSeasons}
                        selectedSeason={selectedSeason}
                        selectedDarkiWorldSeason={selectedDarkiWorldSeason}
                        onSeasonSelect={setSelectedSeason}
                        onDarkiWorldSeasonSelect={handleDarkiWorldSeasonSelect}
                        isOpen={isSeasonDropdownOpen}
                        onToggle={() => {
                          setIsSeasonDropdownOpen(!isSeasonDropdownOpen);
                          setIsEpisodeDropdownOpen(false); // Fermer l'autre dropdown
                        }}
                        pagination={seasonsPagination}
                        onPageChange={handleSeasonsPageChange}
                        isLoadingMore={isLoadingMoreSeasons}
                      />
                    </div>

                    {/* Sélection d'épisode */}
                    <div>
                      <label className="block text-sm font-medium mb-2">{t('download.episode')}</label>
                      <EpisodeDropdown
                        episodes={episodes}
                        darkiWorldEpisodes={darkiWorldEpisodes}
                        selectedEpisode={selectedEpisode}
                        selectedDarkiWorldEpisode={selectedDarkiWorldEpisode}
                        onEpisodeSelect={setSelectedEpisode}
                        onDarkiWorldEpisodeSelect={handleDarkiWorldEpisodeSelect}
                        isOpen={isEpisodeDropdownOpen}
                        onToggle={() => {
                          setIsEpisodeDropdownOpen(!isEpisodeDropdownOpen);
                          setIsSeasonDropdownOpen(false); // Fermer l'autre dropdown
                        }}
                        pagination={episodesPagination}
                        onPageChange={handleEpisodesPageChange}
                        isLoadingMore={isLoadingMoreEpisodes}
                      />
                    </div>

                    {/* Sélection directe d'épisode */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <input
                            type="number"
                            value={directEpisodeInput}
                            onChange={(e) => setDirectEpisodeInput(e.target.value)}
                            placeholder={t('download.episodePlaceholder')}
                            min="1"
                            className="w-32 px-3 py-2 pr-8 bg-white/5 border border-gray-700/50 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:border-red-500/50 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                handleDirectEpisodeSelect();
                              }
                            }}
                          />
                          {/* Boutons personnalisés + et - */}
                          <div className="absolute right-1 top-0 bottom-0 flex flex-col">
                            <button
                              type="button"
                              onClick={() => {
                                const currentValue = parseInt(directEpisodeInput) || 0;
                                setDirectEpisodeInput((currentValue + 1).toString());
                              }}
                              className="flex-1 w-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const currentValue = parseInt(directEpisodeInput) || 1;
                                if (currentValue > 1) {
                                  setDirectEpisodeInput((currentValue - 1).toString());
                                }
                              }}
                              className="flex-1 w-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <button
                          onClick={handleDirectEpisodeSelect}
                          disabled={loadingLinks}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-xl text-white text-sm transition-colors"
                        >
                          {loadingLinks ? t('download.loadingMore') : t('download.goBtn')}
                        </button>
                      </div>
                      <div className="text-xs text-gray-400">
                        {selectedDarkiWorldEpisode
                          ? t('download.episodeSelected', { number: selectedDarkiWorldEpisode.episode_number })
                          : selectedEpisode
                          ? t('download.episodeSelected', { number: selectedEpisode })
                          : t('download.noEpisodeSelected')
                        }
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Bouton pour récupérer les liens */}
                <div className="mt-4 sm:mt-6">
                  <button
                    onClick={handleGetLinks}
                    disabled={loadingLinks}
                    className="w-full flex items-center justify-center gap-2 px-4 sm:px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 rounded-xl transition-colors text-sm sm:text-base"
                  >
                    {loadingLinks ? (
                      <Loader className="w-5 h-5 animate-spin" />
                    ) : (
                      <Download className="w-5 h-5" />
                    )}
                    {loadingLinks
                      ? t('download.fetchingLinks')
                      : t('download.fetchDownloadLinks')
                    }
                  </button>
                </div>

                {/* Note de désengagement */}
                <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-yellow-900/20 border border-yellow-500/50 rounded-xl">
                  <div className="flex items-start gap-2 sm:gap-3">
                    <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs sm:text-sm text-yellow-200">
                      <p className="font-medium mb-1">{t('download.betaWarning')}</p>
                      <p className="leading-relaxed">
                        {t('download.betaWarningText')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Affichage des liens */}
                {downloadLinks.length > 0 && (
                  <div className="mt-4 sm:mt-6">
                    <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">
                      {t('download.availableLinks', { count: downloadLinks.length })}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      {sortDownloadLinks(downloadLinks).map((link) => (
                        <div
                          key={link.id}
                          className="p-3 sm:p-4 bg-gray-800/50 rounded-xl border border-gray-700/50 cursor-pointer hover:border-red-500/50 transition-colors duration-200"
                          onClick={() => handleLinkSelect(link)}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              {link.host_icon && (
                                <img 
                                  src={link.host_icon} 
                                  alt={link.provider}
                                  className="w-3 h-3 sm:w-4 sm:h-4 rounded flex-shrink-0"
                                  loading="lazy"
                                />
                              )}
                              <span className="font-medium text-sm sm:text-base truncate">{link.provider}</span>
                              {link.source === 'movix' && (
                                <span
                                  className="inline-block ml-2 px-2 py-0.5 text-xs font-semibold rounded bg-blue-500 text-white"
                                  title={
                                    link.added_by
                                      ? `Ajouté par ${link.added_by.username}${link.added_at ? ` le ${new Date(link.added_at).toLocaleDateString(i18n.language)}` : ''}`
                                      : 'Lien Movix'
                                  }
                                >
                                  Movix
                                </span>
                              )}
                              {link.full_saison === 1 && (
                                <span className="text-xs bg-green-600 text-white px-1.5 py-0.5 sm:px-2 sm:py-1 rounded flex-shrink-0">
                                  {t('download.fullSeason')}
                                </span>
                              )}
                            </div>
                            {link.quality && (
                              <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 sm:px-2 sm:py-1 rounded flex-shrink-0">
                                {link.quality}
                              </span>
                            )}
                          </div>
                          <div className="space-y-1">
                            {link.language && (
                              <p className="text-xs sm:text-sm text-gray-400 truncate">{t('download.languageLabel')} {link.language}</p>
                            )}
                            {link.sub && (
                              <p className="text-xs sm:text-sm text-gray-400 truncate">{t('download.subtitlesLabel')} {link.sub}</p>
                            )}
                            {link.size !== undefined && link.size !== null && (
                              <p className="text-xs sm:text-sm text-gray-400">{t('download.sizeLabel')} {typeof link.size === 'string' ? link.size : formatFileSize(link.size)}</p>
                            )}
                            {link.view && (
                              <p className="text-xs sm:text-sm text-gray-400">{t('download.viewsLabel')} {link.view}</p>
                            )}
                            {link.upload_date && (
                              <p className="text-xs sm:text-sm text-gray-400">
                                {t('download.uploadedDate')} {new Date(link.upload_date).toLocaleDateString(i18n.language)}
                              </p>
                            )}
                            {link.saison !== undefined && link.episode !== undefined && (
                              <p className="text-xs sm:text-sm text-gray-400">
                                {link.full_saison === 1
                                  ? t('download.fullSeasonNumber', { season: link.saison })
                                  : t('download.seasonEpisode', { season: link.saison, episode: link.episode })
                                }
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="mt-4 p-3 sm:p-4 bg-red-900/20 border border-red-500/50 rounded-xl backdrop-blur-sm">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-red-400 text-sm sm:text-base">
                        <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
                        <span className="break-words">{error}</span>
                      </div>
                      <RateLimitInfoButton error={error} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Popup de sélection de liens */}
        <LinkSelector
          isOpen={showLinkSelector}
          onClose={handleLinkSelectorClose}
          title={tmdbDetails?.name || tmdbDetails?.title || ''}
          selectedLink={selectedLink}
          isDecoding={isDecoding}
          decodedLink={decodedLink}
          error={error}
          queueInfo={queueInfo}
          mediaKind={mediaKind}
          tmdbId={id}
          posterPath={tmdbDetails?.poster_path}
          currentSeason={selectedDarkiWorldSeason?.number ?? selectedSeason}
          currentEpisode={selectedDarkiWorldEpisode?.episode_number ?? selectedEpisode}
          episodeTitle={selectedDarkiWorldEpisode?.name}
        />
        {showAdPopup && (
          <AdFreePlayerAds
            onClose={handleAdPopupClose}
            onAccept={handleAdPopupAccept}
            adType={'ad1'}
            variant={'download'}
          />
        )}
      </div>
    </div>
  );
};

export default DownloadPage;
