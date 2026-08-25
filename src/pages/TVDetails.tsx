import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import axios from 'axios';
import { Loader, Video, Star, Calendar, List, Check, FolderPlus, ChevronRight, AlertTriangle, Play, X, MapPin, Languages, Building, ArrowLeft, Image, Download, Shield, EyeOff, MessageSquare, Archive, CheckCircle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import AddToListMenu from '../components/AddToListMenu';
import DetailsSkeleton from '../components/skeletons/DetailsSkeleton';

import CustomDropdown from '../components/CustomDropdown';
import ShareButtons from '../components/ShareButtons';
import { useAdFreePopup } from '../context/AdFreePopupContext';
import AlertButton from '../components/AlertButton';
import {
  searchWithFallback,
  getSearchNameForId,
  getAnimeMatcherForId,
  shouldHideAnimeModeForId,
  shouldDefaultAnimeModeToOff,
} from '../utils/searchUtils';
import { isLikelyAnime, type TmdbKeywordsResponse } from '../utils/animeSignals';
import CharactersSection from '../components/CharactersSection';
import DetailExtraMetadata from '../components/DetailExtraMetadata';
import { loadDetailCharacters, type DetailCharacters } from '../services/detailCharacters';
import { normalizeAlternateTitles, normalizeKeywords } from '../utils/tmdbMetadata';
import { rememberMedia } from '../utils/mediaSearchIndex';
import {
  pickBestAnimeMatch,
  collectTmdbNames,
  type AnimeSamaCandidate,
} from '../utils/animeMatcher';
import EmblaCarousel from '../components/EmblaCarousel';
import { encodeId, getTmdbId } from '../utils/idEncoder';
import AntiSpoilerSettingsModal from '../components/AntiSpoilerSettings';
import { useAntiSpoilerSettings } from '../hooks/useAntiSpoilerSettings';
import { buildSiteUrl } from '../config/runtime';
import CommentsSection from '../components/CommentsSection';
import LikeDislikeButton, { calculateLikeDislikeRating, type LikeDislikeStats } from '../components/LikeDislikeButton';
import MovixRatingInfoModal from '../components/MovixRatingInfoModal';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import LazySection from '../components/LazySection';
import SEO from '../components/SEO';
import { getTmdbLanguage } from '../i18n';
import i18n from '../i18n';
import { useProfile } from '../context/ProfileContext';
import { getClassificationLabel as getClassificationLabelUtil, isContentAllowed } from '../utils/certificationUtils';

const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

interface TVShow {
  id?: string | number;
  name: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  first_air_date: string;
  vote_average: number;
  genres: { id: number; name: string }[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  seasons?: Array<{
    season_number: number;
    name: string;
    poster_path: string | null;
    air_date: string | null;
    episode_count: number;
  }>;
  status?: string;
  type?: string;
  episode_run_time?: number[];
  networks?: { id: number; name: string; logo_path: string | null }[];
  popularity?: number;
  in_production?: boolean;
  last_air_date?: string;
  last_episode_to_air?: {
    air_date: string;
    episode_number: number;
    season_number: number;
    name: string;
  };
  next_episode_to_air?: {
    air_date: string;
    episode_number: number;
    season_number: number;
    name: string;
  } | null;
  onIgnore?: () => void;
  tvShow?: {
    name: string;
    backdrop_path: string;
  } | null;
  nextEpisode?: {
    seasonNumber: number;
    episodeNumber: number;
    name?: string;
    overview?: string;
  } | null;
  onNextEpisode?: (seasonNumber: number, episodeNumber: number) => void;
  movieId?: string;  // ID TMDB du film
  tvShowId?: string; // ID TMDB de la série
  seasonNumber?: number;
  episodeNumber?: number;
}

interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
}

interface GroupedCrewMember {
  id: number;
  name: string;
  jobs: string[];
  profile_path: string | null;
}

interface WatchStatus {
  watchlist: boolean;
  favorite: boolean;
  watched: boolean;
  episodeWatchlist: { [key: string]: boolean };
  episodeWatched: { [key: string]: boolean };
}

interface CrewMember {
  id: number;
  name: string;
  job: string;
  profile_path: string | null;
}

interface Episode {
  sa: string | number;
  epi: string | number;
  link?: string;
}

const DEFAULT_IMAGE = 'https://www.shutterstock.com/image-vector/default-image-icon-vector-missing-600nw-2079504220.jpg';

// Constante pour activer/désactiver la vérification VIP pour le bouton download
const ENABLE_VIP_DOWNLOAD_CHECK = false;

interface TMDBImage {
  aspect_ratio: number;
  file_path: string;
  height: number;
  iso_639_1: string | null;
  vote_average: number;
  vote_count: number;
  width: number;
}

interface TVImages {
  backdrops: TMDBImage[];
  logos: TMDBImage[];
  posters: TMDBImage[];
}

// Use shared certification utility
const getClassificationLabel = getClassificationLabelUtil;

const getAnimeLanguageLabel = (language: string, t: TFunction): string =>
  t(`details.languages.${language.toLowerCase()}`, { defaultValue: language.toUpperCase() });

// Fonction utilitaire pour renommer les saisons de séries spécifiques (ex: 71446)
const getSeasonDisplayName = (
  seasonNumber: number,
  showId: string | null | undefined,
  t: TFunction,
  originalName?: string
) => {
  if (String(showId) === '71446') {
    if (seasonNumber === 0) return t('details.part1And2');
    if (seasonNumber === 2) return t('details.part3And4');
    if (seasonNumber === 3) return t('details.part5');
  }
  return originalName || `${t('details.season')} ${seasonNumber}`;
};

// 1. Update DEFAULT_IMAGE to a custom SVG string for fallback
const getSeasonFallbackSvg = (label: string) =>
  `data:image/svg+xml;utf8,<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23222"/><g><rect x="80" y="180" width="340" height="260" rx="32" fill="%23333" stroke="%23555" stroke-width="8"/><rect x="120" y="220" width="260" height="180" rx="16" fill="%23444"/><rect x="180" y="420" width="140" height="20" rx="8" fill="%23555"/></g><text x="50%" y="70%" fill="%23777" font-size="48" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">${encodeURIComponent(label)}</text></svg>`;

// Composant pour une image avec lazy loading
const LazyTVImage = ({ src, alt, className, onLoad }: {
  src: string;
  alt: string;
  className: string;
  onLoad?: () => void;
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '50px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const handleLoad = () => {
    setIsLoaded(true);
    onLoad?.();
  };

  return (
    <div ref={imgRef} className={className}>
      {!isInView ? (
        <div className="w-full h-full bg-gray-800 animate-pulse flex items-center justify-center">
          <Image className="w-8 h-8 text-gray-600" />
        </div>
      ) : (
        <>
          {!isLoaded && (
            <div className="absolute inset-0 bg-gray-800 animate-pulse flex items-center justify-center">
              <Image className="w-8 h-8 text-gray-600" />
            </div>
          )}
          <img
            src={src}
            alt={alt}
            className={`w-full h-auto object-cover transition-opacity duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            onLoad={handleLoad}
            loading="lazy"
          />
        </>
      )}
    </div>
  );
};

// Composant pour la section Images des séries TV
const TVImagesSection = ({ tvId }: { tvId: string }) => {
  const { t } = useTranslation();
  const [images, setImages] = useState<TVImages | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<'backdrops' | 'posters' | 'logos'>('backdrops');
  const [showImages, setShowImages] = useState(true);
  const [, setLoadedImagesCount] = useState(0);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('all');
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);

  // États pour le téléchargement ZIP
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [zipStatus, setZipStatus] = useState<'idle' | 'downloading' | 'zipping' | 'complete' | 'error'>('idle');
  const [downloadedCount, setDownloadedCount] = useState(0);

  const fetchImages = async () => {
    if (images) return; // Ne pas refetch si déjà chargé

    setLoading(true);
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${tvId}/images`, {
        params: { api_key: TMDB_API_KEY },
      });
      setImages(response.data);
    } catch (error) {
      console.error('Error fetching TV images:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleImages = () => {
    if (!showImages && !images) {
      fetchImages();
    }
    setShowImages(!showImages);
  };

  const downloadImage = async (imagePath: string, filename: string) => {
    try {
      const imageUrl = `https://image.tmdb.org/t/p/original${imagePath}`;
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading image:', error);
    }
  };

  // Télécharger toutes les images de la catégorie en ZIP
  const downloadAllAsZip = async () => {
    const imagesToDownload = getImagesByCategory();
    if (imagesToDownload.length === 0) return;

    setIsDownloadingZip(true);
    setZipProgress(0);
    setZipStatus('downloading');
    setDownloadedCount(0);

    try {
      // Lazy-load jszip + file-saver only when the user triggers the bulk download.
      const [jszipMod, fileSaverMod] = await Promise.all([
        import('jszip'),
        import('file-saver'),
      ]);
      const JSZip = jszipMod.default;
      const { saveAs } = fileSaverMod;
      const zip = new JSZip();
      const folder = zip.folder(`tv-${tvId}-${selectedCategory}`);

      // Télécharger chaque image
      for (let i = 0; i < imagesToDownload.length; i++) {
        const image = imagesToDownload[i];
        const imageUrl = `https://image.tmdb.org/t/p/original${image.file_path}`;

        try {
          const response = await fetch(imageUrl);
          const blob = await response.blob();
          const extension = image.file_path.split('.').pop() || 'jpg';
          const langSuffix = image.iso_639_1 ? `_${image.iso_639_1}` : '';
          const filename = `${selectedCategory}_${i + 1}${langSuffix}_${image.width}x${image.height}.${extension}`;

          folder?.file(filename, blob);
          setDownloadedCount(i + 1);
          setZipProgress(Math.round(((i + 1) / imagesToDownload.length) * 80)); // 80% for downloading
        } catch (err) {
          console.error(`Error downloading image ${i + 1}:`, err);
        }
      }

      setZipStatus('zipping');
      setZipProgress(90);

      // Générer le ZIP
      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      }, (metadata) => {
        setZipProgress(90 + Math.round(metadata.percent * 0.1)); // 10% for zipping
      });

      // Télécharger le fichier
      const categoryName = selectedCategory === 'backdrops' ? 'arriere-plans' :
        selectedCategory === 'posters' ? 'affiches' : 'logos';
      saveAs(content, `tv-${tvId}-${categoryName}.zip`);

      setZipProgress(100);
      setZipStatus('complete');

      // Reset après 3 secondes
      setTimeout(() => {
        setIsDownloadingZip(false);
        setZipProgress(0);
        setZipStatus('idle');
        setDownloadedCount(0);
      }, 3000);

    } catch (error) {
      console.error('Error creating ZIP:', error);
      setZipStatus('error');
      setTimeout(() => {
        setIsDownloadingZip(false);
        setZipProgress(0);
        setZipStatus('idle');
      }, 3000);
    }
  };

  const getImagesByCategory = () => {
    if (!images) return [];
    const categoryImages = images[selectedCategory] || [];

    if (selectedLanguage === 'all') {
      return categoryImages;
    }

    return categoryImages.filter(image => {
      if (selectedLanguage === 'no-text') {
        return image.iso_639_1 === null;
      }
      return image.iso_639_1 === selectedLanguage;
    });
  };

  const getCategoryCount = (category: 'backdrops' | 'posters' | 'logos') => {
    if (!images) return 0;
    return images[category]?.length || 0;
  };

  const getAvailableLanguages = () => {
    if (!images) return [];
    const categoryImages = images[selectedCategory] || [];
    const languages = new Set<string>();

    categoryImages.forEach(image => {
      if (image.iso_639_1 === null) {
        languages.add('no-text');
      } else {
        languages.add(image.iso_639_1);
      }
    });

    return Array.from(languages).sort();
  };

  const getLanguageDisplayName = (langCode: string) => {
    const languageNames: { [key: string]: string } = {
      'en': t('details.langEnglish'),
      'fr': t('details.langFrench'),
      'es': t('details.langSpanish'),
      'de': t('details.langGerman'),
      'it': t('details.langItalian'),
      'pt': t('details.langPortuguese'),
      'ja': t('details.langJapanese'),
      'ko': t('details.langKorean'),
      'zh': t('details.langChinese'),
      'ru': t('details.langRussian'),
      'ar': t('details.langArabic'),
      'hi': t('details.langHindi'),
      'no-text': t('details.langNoText')
    };

    return languageNames[langCode] || langCode.toUpperCase();
  };

  const handleImageLoad = () => {
    setLoadedImagesCount(prev => prev + 1);
  };

  // Reset loaded images count and language when category changes
  useEffect(() => {
    setLoadedImagesCount(0);
    setSelectedLanguage('all');
    setShowLanguageDropdown(false);
  }, [selectedCategory]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (showLanguageDropdown && !target.closest('.language-dropdown')) {
        setShowLanguageDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showLanguageDropdown]);

  // Fetch TV images automatically on mount or when tvId changes
  useEffect(() => {
    if (!images) fetchImages();
    setShowImages(true);
  }, [tvId]);

  return (
    <div className="mb-8">
      <motion.button
        onClick={handleToggleImages}
        className="flex items-center gap-3 text-xl font-bold text-white hover:text-blue-400 transition-colors"
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        <Image className="w-6 h-6" />
        {t('details.imagesTab')}
        <motion.div
          animate={{ rotate: showImages ? 180 : 0 }}
          transition={{ duration: 0.3 }}
        >
          <ChevronRight className="w-5 h-5" />
        </motion.div>
      </motion.button>

      <AnimatePresence>
        {showImages && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="mt-6"
            style={{ overflow: 'visible' }}
          >
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader className="w-8 h-8 animate-spin text-blue-400" />
              </div>
            ) : images ? (
              <div>
                {/* Tabs catégories — pattern shadcn (pastille rouge animée via layoutId).
                    Même structure que SourcePriorityPanel / sidebar Settings. */}
                <div role="tablist" className="flex items-center gap-1 mb-6 p-1 rounded-xl bg-white/5 overflow-x-auto">
                  {(['backdrops', 'posters', 'logos'] as const).map((category) => {
                    const isActive = selectedCategory === category;
                    const labelKey = category === 'backdrops' ? 'details.backgrounds' : `details.${category}`;
                    return (
                      <button
                        key={category}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setSelectedCategory(category)}
                        className={`relative flex-1 min-w-0 flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60 ${
                          isActive ? 'text-white' : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="tv-images-tabs-indicator"
                            className="absolute inset-0 bg-red-600 rounded-lg shadow-sm shadow-red-600/30"
                            transition={{ type: 'spring', bounce: 0.15, duration: 0.45 }}
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          {category === 'backdrops' && (
                            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                            </svg>
                          )}
                          {category === 'posters' && (
                            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                            </svg>
                          )}
                          {category === 'logos' && (
                            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                            </svg>
                          )}
                          <span>{t(labelKey)}</span>
                          <span className={`text-[11px] leading-none px-1.5 py-0.5 rounded-full font-semibold ${
                            isActive ? 'bg-white/25 text-white' : 'bg-gray-800/70 text-gray-400'
                          }`}>
                            {getCategoryCount(category)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Menu déroulant pour les langues */}
                {getAvailableLanguages().length > 1 && (
                  <div className="relative mb-6 language-dropdown">
                    <motion.button
                      onClick={() => setShowLanguageDropdown(!showLanguageDropdown)}
                      className="flex items-center justify-between w-full md:w-64 px-4 py-3 bg-gray-800/70 hover:bg-gray-700/70 rounded-xl border border-gray-600/50 text-white transition-all duration-200 backdrop-blur-sm"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="flex items-center gap-3">
                        <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M7 2a1 1 0 011 1v1h3a1 1 0 110 2H9.578a18.87 18.87 0 01-1.724 4.78c.29.354.596.696.914 1.026a1 1 0 11-1.44 1.389c-.188-.196-.373-.396-.554-.6a19.098 19.098 0 01-3.107 3.567 1 1 0 01-1.334-1.49 17.087 17.087 0 003.13-3.733 18.992 18.992 0 01-1.487-2.494 1 1 0 111.79-.89c.234.47.489.928.764 1.372.417-.934.752-1.913.997-2.927H3a1 1 0 110-2h3V3a1 1 0 011-1zm6 6a1 1 0 01.894.553l2.991 5.982a.869.869 0 01.02.037l.99 1.98a1 1 0 11-1.79.895L15.383 16h-4.764l-.724 1.447a1 1 0 11-1.788-.894l.99-1.98.019-.038 2.99-5.982A1 1 0 0113 8zm-1.382 6h2.764L13 11.236 11.618 14z" clipRule="evenodd" />
                        </svg>
                        <span className="font-medium">
                          {selectedLanguage === 'all'
                            ? `${t('details.allLanguages')} (${images?.[selectedCategory]?.length || 0})`
                            : `${getLanguageDisplayName(selectedLanguage)} (${images?.[selectedCategory]?.filter(img =>
                              selectedLanguage === 'no-text' ? img.iso_639_1 === null : img.iso_639_1 === selectedLanguage
                            ).length || 0})`
                          }
                        </span>
                      </div>
                      <motion.svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        animate={{ rotate: showLanguageDropdown ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </motion.svg>
                    </motion.button>

                    <AnimatePresence>
                      {showLanguageDropdown && (
                        <motion.div
                          initial={{ opacity: 0, y: -10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -10, scale: 0.95 }}
                          transition={{ duration: 0.2 }}
                          className="absolute left-0 md:left-0 w-full md:w-64 mt-2 bg-gray-800/95 backdrop-blur-md rounded-xl border border-gray-600/50 shadow-2xl z-[9999] overflow-hidden max-h-64 overflow-y-auto"
                        >
                          <div className="py-2">
                            <motion.button
                              onClick={() => {
                                setSelectedLanguage('all');
                                setShowLanguageDropdown(false);
                              }}
                              className={`w-full px-4 py-3 text-left hover:bg-gray-700/50 transition-colors flex items-center justify-between ${selectedLanguage === 'all' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300'
                                }`}
                              whileHover={{ x: 4 }}
                            >
                              <span>{t('details.allLanguages')}</span>
                              <span className="text-xs bg-gray-600/50 px-2 py-1 rounded-full">
                                {images?.[selectedCategory]?.length || 0}
                              </span>
                            </motion.button>
                            {getAvailableLanguages().map((langCode) => (
                              <motion.button
                                key={langCode}
                                onClick={() => {
                                  setSelectedLanguage(langCode);
                                  setShowLanguageDropdown(false);
                                }}
                                className={`w-full px-4 py-3 text-left hover:bg-gray-700/50 transition-colors flex items-center justify-between ${selectedLanguage === langCode ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300'
                                  }`}
                                whileHover={{ x: 4 }}
                              >
                                <span>{getLanguageDisplayName(langCode)}</span>
                                <span className="text-xs bg-gray-600/50 px-2 py-1 rounded-full">
                                  {images?.[selectedCategory]?.filter(img =>
                                    langCode === 'no-text' ? img.iso_639_1 === null : img.iso_639_1 === langCode
                                  ).length || 0}
                                </span>
                              </motion.button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Bouton Télécharger tout en ZIP */}
                {getImagesByCategory().length > 0 && (
                  <div className="mb-6">
                    <motion.button
                      onClick={downloadAllAsZip}
                      disabled={isDownloadingZip}
                      className={`relative overflow-hidden flex items-center gap-3 px-5 py-3 rounded-xl font-semibold transition-all duration-300 ${isDownloadingZip
                        ? 'bg-gray-700 cursor-not-allowed'
                        : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg hover:shadow-emerald-500/25'
                        }`}
                      whileHover={!isDownloadingZip ? { scale: 1.02, y: -2 } : {}}
                      whileTap={!isDownloadingZip ? { scale: 0.98 } : {}}
                    >
                      {/* Barre de progression en arrière-plan */}
                      {isDownloadingZip && (
                        <motion.div
                          className="absolute inset-0 bg-gradient-to-r from-emerald-600 to-teal-600"
                          initial={{ width: '0%' }}
                          animate={{ width: `${zipProgress}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      )}

                      <span className="relative z-10 flex items-center gap-3">
                        {zipStatus === 'idle' && (
                          <>
                            <Archive className="w-5 h-5" />
                            <span>{t('details.downloadZip')}</span>
                            <span className="text-xs bg-white/20 px-2 py-1 rounded-full">
                              {t('details.imagesCount', { count: getImagesByCategory().length })}
                            </span>
                          </>
                        )}
                        {zipStatus === 'downloading' && (
                          <>
                            <Loader className="w-5 h-5 animate-spin" />
                            <span>{t('details.downloading')} {downloadedCount}/{getImagesByCategory().length}</span>
                            <span className="text-xs bg-white/20 px-2 py-1 rounded-full">
                              {zipProgress}%
                            </span>
                          </>
                        )}
                        {zipStatus === 'zipping' && (
                          <>
                            <Loader className="w-5 h-5 animate-spin" />
                            <span>{t('details.compressing')}</span>
                          </>
                        )}
                        {zipStatus === 'complete' && (
                          <>
                            <CheckCircle className="w-5 h-5 text-green-300" />
                            <span>{t('details.downloadComplete')}</span>
                          </>
                        )}
                        {zipStatus === 'error' && (
                          <>
                            <AlertTriangle className="w-5 h-5 text-red-300" />
                            <span>{t('details.downloadError')}</span>
                          </>
                        )}
                      </span>
                    </motion.button>

                    {/* Barre de progression visible */}
                    {isDownloadingZip && zipStatus !== 'complete' && (
                      <div className="mt-3 bg-gray-800 rounded-full h-2 overflow-hidden">
                        <motion.div
                          className="h-full bg-gradient-to-r from-emerald-500 to-teal-400"
                          initial={{ width: '0%' }}
                          animate={{ width: `${zipProgress}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Mobile: Ligne défilante d'images (horizontal scroll) */}
                <motion.div
                  key={selectedCategory + '-mobile'}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex gap-4 overflow-x-auto py-4 snap-x snap-mandatory md:hidden"
                >
                  {getImagesByCategory().map((image, index) => (
                    <motion.div
                      key={`mobile-${selectedCategory}-${index}`}
                      className="relative group rounded-lg overflow-hidden flex-shrink-0 w-64 sm:w-72 snap-center"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.02, duration: 0.25 }}
                      whileHover={{ scale: 1.03 }}
                    >
                      <div className={`w-full h-auto ${selectedCategory === 'logos' ? 'p-6 bg-white/5 flex items-center justify-center' : ''}`}>
                        <LazyTVImage
                          src={`https://image.tmdb.org/t/p/w500${image.file_path}`}
                          alt={`${selectedCategory} ${index + 1}`}
                          className="w-full h-auto object-contain"
                          onLoad={handleImageLoad}
                        />
                      </div>

                      <motion.button
                        onClick={() => downloadImage(
                          image.file_path,
                          `tv-${tvId}-${selectedCategory}-${index + 1}.jpg`
                        )}
                        className="absolute top-2 right-2 bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-full transition-colors shadow-lg md:hidden"
                        whileTap={{ scale: 0.9 }}
                      >
                        <Download className="w-4 h-4" />
                      </motion.button>

                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black to-transparent p-2">
                        <p className="text-white text-xs">
                          {image.width} × {image.height}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </motion.div>

                {/* Desktop: grille d'images (grid) */}
                <motion.div
                  key={selectedCategory + '-desktop'}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="hidden md:grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
                >
                  {getImagesByCategory().map((image, index) => (
                    <motion.div
                      key={`desktop-${selectedCategory}-${index}`}
                      className="relative group rounded-lg overflow-hidden"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.04, duration: 0.3 }}
                      whileHover={{ scale: 1.02 }}
                    >
                      <div className={`w-full h-auto ${selectedCategory === 'logos' ? 'p-8 bg-white/5' : ''}`}>
                        <LazyTVImage
                          src={`https://image.tmdb.org/t/p/w500${image.file_path}`}
                          alt={`${selectedCategory} ${index + 1}`}
                          className="w-full h-auto object-contain"
                          onLoad={handleImageLoad}
                        />
                      </div>

                      <motion.div
                        className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hidden md:flex"
                        initial={{ opacity: 0 }}
                        whileHover={{ opacity: 1 }}
                      >
                        <motion.button
                          onClick={() => downloadImage(
                            image.file_path,
                            `tv-${tvId}-${selectedCategory}-${index + 1}.jpg`
                          )}
                          className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full transition-colors shadow-lg"
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                        >
                          <Download className="w-5 h-5" />
                        </motion.button>
                      </motion.div>

                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black to-transparent p-2">
                        <p className="text-white text-xs">
                          {image.width} × {image.height}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </motion.div>

                {getImagesByCategory().length === 0 && (
                  <div className="text-center py-8 text-gray-400">
                    {t('details.noImageInCategory')}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                {t('details.imageLoadError')}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Episode progress functionality removed

const groupCrewMembers = (crew: CrewMember[]): GroupedCrewMember[] => {
  const groupedMap = crew.reduce((acc, member) => {
    if (!acc.has(member.id)) {
      acc.set(member.id, {
        id: member.id,
        name: member.name,
        jobs: [member.job],
        profile_path: member.profile_path
      });
    } else {
      const existing = acc.get(member.id)!;
      if (!existing.jobs.includes(member.job)) {
        existing.jobs.push(member.job);
      }
    }
    return acc;
  }, new Map<number, GroupedCrewMember>());

  return Array.from(groupedMap.values());
};

// Sur certains réseaux (proxy FAI / cache CloudFront), la réponse fr-FR d'une
// saison arrive corrompue : le corps n'est ni du JSON ni du gzip valide, donc
// `episodes` est absent (symptôme : "Pas d'épisodes" sur PC, OK sur mobile).
// On bascule alors sur l'objet en-US — clé de cache CDN différente, donc
// généralement saine. Numéros d'épisode et dates sont indépendants de la langue.
const fetchSeasonDetails = async (
  showId: string | number | null | undefined,
  season: number
): Promise<any | null> => {
  const base = `https://api.themoviedb.org/3/tv/${showId}/season/${season}?api_key=${TMDB_API_KEY}`;
  const langs = [...new Set([getTmdbLanguage(), 'en-US'])];
  for (const lang of langs) {
    try {
      const { data } = await axios.get(`${base}&language=${lang}`);
      if (data && Array.isArray(data.episodes)) return data;
    } catch {
      // erreur réseau / décodage : on tente la langue suivante
    }
  }
  return null;
};

const TVDetails: React.FC = () => {
  const { t } = useTranslation();
  const [show, setShow] = useState<any>(null);
  const [, setIsLoading] = useState(true);
  const { id: encodedId } = useParams<{ id: string }>();
  const id = encodedId ? getTmdbId(encodedId) : null;
  const navigate = useNavigate();
  const { currentProfile } = useProfile();

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: id ? { pageName: 'tv-details', contentId: id } : undefined,
  });
  const [searchParams] = useSearchParams();
  const [tvShow, setTVShow] = useState<TVShow | null>(null);
  const [movixVoteStats, setMovixVoteStats] = useState<LikeDislikeStats>({ likes: 0, dislikes: 0 });
  const [showMovixRatingInfo, setShowMovixRatingInfo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backdropImage, setBackdropImage] = useState<string | null>(null);
  const [showTrailerPopup, setShowTrailerPopup] = useState(false);
  const [trailerVideo, setTrailerVideo] = useState<any>(null);
  const [isClosingTrailer, setIsClosingTrailer] = useState(false);

  useEffect(() => {
    setMovixVoteStats({ likes: 0, dislikes: 0 });
  }, [id]);

  const movixRating = calculateLikeDislikeRating(movixVoteStats);
  const [availableEpisodes, setAvailableEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);
  // const [_trailerVideoId, _setTrailerVideoId] = useState<string | null>(null);

  // Refs replacing document.getElementById/querySelector lookups for season/episode UI
  const seasonsSectionRef = useRef<HTMLDivElement | null>(null);
  const episodesSectionRef = useRef<HTMLDivElement | null>(null);
  const dropdownToggleButtonRef = useRef<HTMLButtonElement | null>(null);

  const handleCloseTrailer = () => {
    setIsClosingTrailer(true);
    setTimeout(() => {
      setShowTrailerPopup(false);
      setIsClosingTrailer(false);
    }, 300);
  };

  const handleCloseVideo = () => {
    setIsClosingVideo(true);
    setTimeout(() => {
      setShowVideoPopup(false);
      setIsClosingVideo(false);
    }, 300);
  };
  const [cast, setCast] = useState<CastMember[]>([]);
  const [crew, setCrew] = useState<GroupedCrewMember[]>([]);
  const [, setShowCast] = useState(false);
  const [, setShowCrew] = useState(false);
  const [watchStatus, setWatchStatus] = useState<WatchStatus>({
    watchlist: false,
    favorite: false,
    watched: false,
    episodeWatchlist: {},
    episodeWatched: {}
  });

  const cinemaMode = true;

  // Anti-spoiler settings
  const {
    settings: antiSpoilerSettings,
    updateSettings: updateAntiSpoilerSettings,
    shouldHide,
    getMaskedContent,
    hasActiveSpoilerProtection: _hasActiveSpoilerProtection
  } = useAntiSpoilerSettings();
  const [showAntiSpoilerModal, setShowAntiSpoilerModal] = useState(false);
  // Add this effect to initialize watchlist state from localStorage
  useEffect(() => {
    // Check if the current TV show ID is in the watchlist_tv localStorage
    if (id) {
      try {
        const storageKey = 'watchlist_tv';
        const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const exists = typeWatchlist.some((media: any) => media.id === Number(id));

        if (exists) {
          // Update watchStatus if the show is in the watchlist
          setWatchStatus(prev => ({
            ...prev,
            watchlist: true
          }));
        }
      } catch (error) {
        console.error('Error checking watchlist status:', error);
      }
    }
  }, [id]);

  const [showAddToList, setShowAddToList] = useState(false);
  const [, setIsAvailable] = useState<boolean>(true);
  const [recommendations, setRecommendations] = useState<(TVShow & { isAvailable?: boolean })[]>([]);
  const [, setShowSimilarModal] = useState(false);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const [recommendationsLoaded, setRecommendationsLoaded] = useState<boolean>(false);
  const [animeMode, setAnimeMode] = useState<boolean>(false);
  const [animeData, setAnimeData] = useState<any>(null);
  const [loadingAnimeData, setLoadingAnimeData] = useState<boolean>(false);
  const [tmdbKeywords, setTmdbKeywords] = useState<TmdbKeywordsResponse | null>(null);
  const [characters, setCharacters] = useState<DetailCharacters | null>(null);
  const [charactersLoading, setCharactersLoading] = useState(false);
  const [fullCast, setFullCast] = useState<Array<{ id: number; name: string; character?: string; profile_path?: string | null }>>([]);
  const [tmdbEnglishName, setTmdbEnglishName] = useState<string | null>(null);
  const [tmdbAlternativeTitles, setTmdbAlternativeTitles] = useState<
    Array<{ iso_3166_1?: string; title?: string }>
  >([]);
  const [selectedAnimeEpisode, setSelectedAnimeEpisode] = useState<any>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  // Ajout de l'état pour stocker les détails complets des saisons et épisodes
  const [seasonsDetails, setSeasonsDetails] = useState<Record<number, any>>({});
  // Ajoute ce state dans le composant principal, avant le return :
  // const [_collapsed, _setCollapsed] = useState(true);
  // Ajoute un état pour la gestion du popup "à venir"
  const [showUpcomingModal, setShowUpcomingModal] = useState(false);
  const [pendingEpisode, setPendingEpisode] = useState<number | null>(null);
  const [forceShowUpcoming, setForceShowUpcoming] = useState(false);
  // Ajoute les états pour les tabs et le scroll des tabs comme dans MovieDetails
  const [activeTab, setActiveTab] = useState<'overview' | 'details' | 'videos' | 'images' | 'cast' | 'characters' | 'crew'>('overview');
  const [isTabsScrollable, setIsTabsScrollable] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  // Dans les états, ajoute un état pour le chargement des vidéos
  const [videos, setVideos] = useState<any[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<any | null>(null);
  const [showVideoPopup, setShowVideoPopup] = useState<boolean>(false);
  const [isClosingVideo, setIsClosingVideo] = useState(false);

  // États pour les vidéos multi-langues
  const [multiLangVideos, setMultiLangVideos] = useState<any[]>([]);
  const [loadingMultiLangVideos, setLoadingMultiLangVideos] = useState(false);
  const [showMultiLangView, setShowMultiLangView] = useState(false);

  // États pour les vidéos multi-langues par saison
  const [seasonMultiLangVideos, setSeasonMultiLangVideos] = useState<{ [key: number]: any[] }>({});
  const [loadingSeasonMultiLangVideos, setLoadingSeasonMultiLangVideos] = useState<{ [key: number]: boolean }>({});
  const [showSeasonMultiLangView, setShowSeasonMultiLangView] = useState<{ [key: number]: boolean }>({});
  const [, setSeasonAutoMultiLang] = useState<{ [key: number]: boolean }>({});
  const [, setShowAnimeNotFoundMessage] = useState(false);
  // Ajoute ce state en haut du composant TVDetails, avec les autres useState :
  const [dropdownMode, setDropdownMode] = useState<boolean | null>(null); // null = utiliser le mode par défaut basé sur le nombre d'épisodes
  const [certifications, setCertifications] = useState<{ [key: string]: string }>({});
  // Ajout d'un état pour les vidéos par saison
  const [seasonVideos, setSeasonVideos] = useState<Record<number, any[]>>({});
  // Nouvel état pour suivre les images échouées
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  // Ajout de l'état pour le mode des statistiques financières
  const [financialStatsMode, setFinancialStatsMode] = useState<'simple' | 'advanced'>('simple');
  // Ajout de l'état pour gérer le survol des cartes de séries similaires
  const [isSimilarCardHovered] = useState(false);
  // Ajout d'une référence pour stocker le timeout d'unhover
  const hoverTimeoutRef = useRef<number | null>(null);
  // Ajout d'une référence pour le conteneur de cartes similaires
  const similarRowRef = useRef<HTMLDivElement>(null);
  // Référence pour la section commentaires
  const commentsRef = useRef<HTMLDivElement>(null);
  // État pour tracker quelle carte est survolée
  // const [_hoveredSimilarIndex, _setHoveredSimilarIndex] = useState<number | null>(null);
  // Ajout du state pour les cartes d'épisode élargies
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  // Mode cinéma toujours activé

  // Add resetVipStatus hook for the main component
  const { resetVipStatus } = useAdFreePopup();

  // Reset VIP status when the TV show ID changes
  useEffect(() => {
    resetVipStatus();
  }, [id, resetVipStatus]);

  // Fonction pour basculer l'état d'expansion d'une carte
  const toggleCardExpansion = (episodeKey: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedCards(prev => ({
      ...prev,
      [episodeKey]: !prev[episodeKey]
    }));
  };

  // Fonction pour annuler le timeout existant si nécessaire
  const _clearHoverTimeout = () => {
    if (hoverTimeoutRef.current !== null) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };
  void _clearHoverTimeout;

  // Ajout du useEffect pour empêcher le scroll quand une carte est survolée
  useEffect(() => {
    const container = similarRowRef.current;
    if (!container) return;
    if (!isSimilarCardHovered) return; // Only applies when hovered

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: Event) => {
      if (e instanceof WheelEvent && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Prevent default only if the wheel event is predominantly horizontal
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // If predominantly vertical or not a WheelEvent, allow default behavior (page scroll)
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
  }, [isSimilarCardHovered]); // Re-run when hover state changes

  useEffect(() => {
    const savedSeason = searchParams.get('season');
    const savedEpisode = searchParams.get('episode');

    if (savedSeason && savedEpisode) {
      setSelectedSeason(Number(savedSeason));
      setSelectedEpisode(Number(savedEpisode));
    }
  }, [searchParams]);

  // Watch status localStorage functionality removed

  useEffect(() => {
    const checkIfScrollable = () => {
      if (tabsContainerRef.current) {
        const { scrollWidth, clientWidth } = tabsContainerRef.current;
        setIsTabsScrollable(scrollWidth > clientWidth);
      }
    };
    checkIfScrollable();
    window.addEventListener('resize', checkIfScrollable);
    return () => window.removeEventListener('resize', checkIfScrollable);
  }, [tvShow]);

  const fetchTVShowDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    setVideos([]); // Reset general videos
    setSeasonVideos({}); // Reset season videos
    setLoadingVideos(true); // Start loading videos
    try {
      const tmdbResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: getTmdbLanguage(),
          append_to_response: 'credits,keywords,alternative_titles,external_ids'
          // Fetch videos separately now
        }
      });

      setTVShow(tmdbResponse.data);
      // Générique complet, pour la galerie de personnages.
      setFullCast(tmdbResponse.data?.credits?.cast ?? []);

      // Signaux pour la détection anime (keywords + alternative_titles viennent de append_to_response)
      setTmdbKeywords(tmdbResponse.data?.keywords ?? null);
      setTmdbAlternativeTitles(tmdbResponse.data?.alternative_titles?.results || []);

      // Nom anglais pour nourrir le matching anime (original_name est souvent en japonais/kanji)
      if (getTmdbLanguage() !== 'en-US') {
        axios
          .get(`https://api.themoviedb.org/3/tv/${id}`, {
            params: { api_key: TMDB_API_KEY, language: 'en-US' },
          })
          .then((r) => setTmdbEnglishName(r.data?.name ?? null))
          .catch(() => setTmdbEnglishName(null));
      } else {
        setTmdbEnglishName(tmdbResponse.data?.name ?? null);
      }

      // Récupérer les content ratings pour la classification
      try {
        const contentRatingsResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/content_ratings?api_key=${TMDB_API_KEY}`);
        const contentRatingsData = contentRatingsResponse.data.results;
        const newCertifications: { [key: string]: string } = {};

        // Chercher d'abord la classification française
        const frRating = contentRatingsData.find((r: any) => r.iso_3166_1 === 'FR');
        if (frRating && frRating.rating) {
          newCertifications['FR'] = frRating.rating;
        }

        // Si pas de classification française, chercher la classification américaine
        if (!newCertifications['FR']) {
          const usRating = contentRatingsData.find((r: any) => r.iso_3166_1 === 'US');
          if (usRating && usRating.rating) {
            newCertifications['US'] = usRating.rating;
          }
        }

        setCertifications(newCertifications);
      } catch (error) {
        console.error('Error fetching content ratings:', error);
        setCertifications({});
      }

      const numberOfSeasons = tmdbResponse.data.number_of_seasons;
      const allEpisodes: Episode[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const newSeasonsDetails: Record<number, any> = {};
      const newSeasonVideos: Record<number, any[]> = {}; // Temporary storage for season videos

      // Fetch general videos
      try {
        const generalVideosResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/videos`, {
          params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
        });
        let results = generalVideosResponse.data.results || [];
        if (results.length === 0) {
          const generalVideosResponseEN = await axios.get(`https://api.themoviedb.org/3/tv/${id}/videos`, {
            params: { api_key: TMDB_API_KEY, language: 'en-US' }
          });
          results = generalVideosResponseEN.data.results || [];
        }
        setVideos(results);
      } catch (error) {
        console.error('Error fetching general videos:', error);
        setVideos([]);
      }

      // Fetch season details and videos
      const seasonPromises = [];
      for (let season = 0; season <= numberOfSeasons; season++) {
        // EXCLUSION: Retirer la saison 1 pour la série 71446
        if (String(id) === '71446' && season === 1) {
          continue;
        }

        seasonPromises.push(
          (async () => {
            try {
              // Fetch season details (bascule sur en-US si la réponse fr-FR est corrompue)
              const seasonData = await fetchSeasonDetails(id, season);
              if (seasonData) {
                newSeasonsDetails[season] = seasonData;
                for (const episodeData of seasonData.episodes) {
                  const airDate = episodeData.air_date ? new Date(episodeData.air_date) : null;
                  if (airDate) airDate.setHours(0, 0, 0, 0);
                  if (!airDate || airDate <= today) {
                    allEpisodes.push({
                      sa: season,
                      epi: episodeData.episode_number
                    });
                  }
                }
              }

              // Fetch season videos
              try {
                // First try French only
                const seasonVideosResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${season}/videos`, {
                  params: {
                    api_key: TMDB_API_KEY,
                    language: getTmdbLanguage()
                  }
                });

                const frenchResults = seasonVideosResponse.data.results || [];

                // If no French videos, get all languages
                if (frenchResults.length === 0) {
                  const seasonVideosResponseAll = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${season}/videos`, {
                    params: {
                      api_key: TMDB_API_KEY
                      // No language parameter = all languages
                    }
                  });
                  const allResults = seasonVideosResponseAll.data.results || [];
                  newSeasonVideos[season] = allResults;

                  // Mark this season as auto multi-lang if it has videos
                  if (allResults.length > 0) {
                    setSeasonAutoMultiLang(prev => ({ ...prev, [season]: true }));
                    setShowSeasonMultiLangView(prev => ({ ...prev, [season]: true }));
                    // Also store the multi-lang videos for immediate display
                    setSeasonMultiLangVideos(prev => ({ ...prev, [season]: allResults }));
                  }
                } else {
                  // Use French videos
                  newSeasonVideos[season] = frenchResults;
                  setSeasonAutoMultiLang(prev => ({ ...prev, [season]: false }));
                }
              } catch (videoError) {
                console.error(`Error fetching videos for season ${season}:`, videoError);
                newSeasonVideos[season] = []; // Default to empty array on error
              }

            } catch (error) {
              console.error(`Error fetching season ${season} details:`, error);
            }
          })()
        );
      }
      await Promise.all(seasonPromises); // Wait for all season fetches

      allEpisodes.sort((a, b) => {
        if (Number(a.sa) !== Number(b.sa)) return Number(a.sa) - Number(b.sa);
        return Number(a.epi) - Number(b.epi);
      });

      setAvailableEpisodes(allEpisodes);
      setSeasonsDetails(newSeasonsDetails);
      setSeasonVideos(newSeasonVideos); // Update season videos state
      setIsAvailable(true);

    } catch (error) {
      console.error('Error fetching TV show details:', error);
      setError(t('details.loadError'));
      setIsAvailable(true); // Assume available on error? Or false?
    } finally {
      setLoading(false);
      setLoadingVideos(false); // Finish loading videos
    }
  }, [id]);

  const checkAvailability = useCallback(async () => {
    if (!id) return;

    try {
      // Ne pas vérifier chaque épisode au chargement de la page pour des raisons de performance
      // La vérification se fera quand l'utilisateur sélectionne un épisode spécifique
      setIsAvailable(true);
    } catch (error) {
      console.error('Error checking series availability:', error);
      setIsAvailable(false);
    }
  }, [id]);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      // Reset state when ID changes
      setSelectedSeason(null);
      setSelectedEpisode(null);
      setAnimeMode(false);
      setAnimeData(null);
      setSelectedAnimeEpisode(null);
      setSelectedLanguage(null);
      setSelectedPlayer(null);
      setRecommendationsLoaded(false);
      setRecommendations([]);
      setShowCast(false);
      setShowCrew(false);
      setError(null);

      // BUG 2 & 3 FIX: Load initial watch status from localStorage
      if (id) { // id is the showId from params
        const initialWatchStatus: WatchStatus = {
          watchlist: false,
          favorite: false,
          watched: false,
          episodeWatchlist: {},
          episodeWatched: {}
        };

        try {
          const watchlistTv = JSON.parse(localStorage.getItem('watchlist_tv') || '[]');
          const favoritesTv = JSON.parse(localStorage.getItem('favorites_tv') || '[]');
          const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');

          initialWatchStatus.watchlist = watchlistTv.some((item: any) => item.id === Number(id));
          initialWatchStatus.favorite = favoritesTv.some((item: any) => item.id === Number(id));
          initialWatchStatus.watched = watchedTv.some((item: any) => item.id === Number(id));

          const episodeWatchlistKey = `watchlist_episodes_tv_${id}`;
          const episodeWatchedKey = `watched_episodes_tv_${id}`;

          // Récupérer les données d'épisodes depuis localStorage
          const watchlistEpisodes = JSON.parse(localStorage.getItem(episodeWatchlistKey) || '{}');
          const watchedEpisodes = JSON.parse(localStorage.getItem(episodeWatchedKey) || '{}');

          // Convertir les clés de format "S1E1" vers "s1e1"
          const convertKeys = (episodeObj: Record<string, boolean>) => {
            const result: Record<string, boolean> = {};
            Object.keys(episodeObj).forEach(key => {
              // Convertir de "S1E1" vers "s1e1"
              const lowerCaseKey = key.toLowerCase();
              result[lowerCaseKey] = episodeObj[key];
            });
            return result;
          };

          initialWatchStatus.episodeWatchlist = convertKeys(watchlistEpisodes);
          initialWatchStatus.episodeWatched = convertKeys(watchedEpisodes);

          console.log("Chargement des statuts d'épisodes:", {
            original: { watchlist: watchlistEpisodes, watched: watchedEpisodes },
            converted: {
              watchlist: initialWatchStatus.episodeWatchlist,
              watched: initialWatchStatus.episodeWatched
            }
          });

        } catch (e) {
          console.error("Error loading watch status from localStorage:", e);
        }
        setWatchStatus(initialWatchStatus);
      }
      // End of BUG 2 & 3 FIX

      try {
        await Promise.all([
          fetchTVShowDetails(),
          checkAvailability()
        ]);
      } catch (error) {
        console.error('Error fetching data on ID change:', error);
        setError(t('details.loadError'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();

    return () => {
    };
  }, [id, fetchTVShowDetails, checkAvailability]);

  const availableSeasons = useMemo(() => {
    return [...new Set(availableEpisodes.map((ep) => Number(ep.sa)))].sort((a, b) => a - b);
  }, [availableEpisodes]);

  // Saison de départ par défaut : préférer la saison 1 si elle existe (pour éviter de commencer par les spéciaux / saison 0)
  // Si la saison 1 n'est pas disponible (ex: série 71446 où elle est exclue), on prend la première disponible
  const defaultStartSeason = useMemo(() => {
    if (availableSeasons.length === 0) return 1;
    if (availableSeasons.includes(1)) return 1;
    return availableSeasons[0];
  }, [availableSeasons]);
  const _episodesForSeason = availableEpisodes
    .filter((ep) => Number(ep.sa) === selectedSeason)
    .sort((a, b) => Number(a.epi) - Number(b.epi));
  void _episodesForSeason;

  const handleSeasonChange = (season: number) => {
    setSelectedSeason(season);
    // Ne plus sélectionner automatiquement d'épisode en mode anime
    setSelectedEpisode(null);
    // Réinitialiser le mode dropdown pour utiliser le mode par défaut basé sur le nombre d'épisodes
    setDropdownMode(null);

    // Scroll vers le bouton de menu déroulant pour qu'il soit au centre de l'écran
    setTimeout(() => {
      // Chercher d'abord le bouton de toggle du menu déroulant
      const toggleButton = dropdownToggleButtonRef.current;
      if (toggleButton) {
        toggleButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        // Fallback vers la section des épisodes si le bouton n'est pas trouvé
        const episodesSection = episodesSectionRef.current;
        if (episodesSection) {
          episodesSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }, 100);
  };

  const handleEpisodeChange = (episodeNumber: number | string) => {
    const epNumber = Number(episodeNumber);
    const ep = seasonsDetails[selectedSeason!]?.episodes?.find((e: any) => e.episode_number === epNumber);
    const today = new Date();
    const airDate = ep?.air_date ? new Date(ep.air_date) : null;
    if (airDate && airDate > today && !forceShowUpcoming) {
      setPendingEpisode(epNumber);
      setShowUpcomingModal(true);
      return;
    }
    navigate(`/watch/tv/${encodeId(id || '')}/s/${selectedSeason}/e/${epNumber}`);
  };
  const _scrollLeft = (elementId: string) => {
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollBy({ left: -200, behavior: 'smooth' });
    }
  };
  void _scrollLeft;

  const _scrollRight = (elementId: string) => {
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollBy({ left: 200, behavior: 'smooth' });
    }
  };
  void _scrollRight;

  const updateWatchStatus = (type: keyof WatchStatus, value: boolean, episodeKey?: string) => {
    setWatchStatus(prev => {
      let newStatus;
      const showId = id; // Assuming 'id' is the tvShowId from params

      if (episodeKey && showId) { // episodeKey is like "s1e1"
        const episodeField = type === 'episodeWatchlist' ? 'episodeWatchlist' : 'episodeWatched';
        newStatus = {
          ...prev,
          [episodeField]: {
            ...prev[episodeField],
            [episodeKey]: value
          }
        };

        // Convertir episodeKey de "s1e1" vers "S1E1" pour localStorage
        // Extraire les numéros de saison et d'épisode
        const [s, e] = episodeKey.replace('s', '').split('e');
        const seasonNum = parseInt(s, 10);
        const episodeNum = parseInt(e, 10);

        // Clé au format attendu par localStorage: "S1E1"
        const storageEpisodeKey = `S${seasonNum}E${episodeNum}`;

        // Update localStorage for individual episodes
        const itemType = type === 'episodeWatchlist' ? 'watchlist' : 'watched';
        const storageKey = `${itemType}_episodes_tv_${showId}`;
        try {
          const episodeData = JSON.parse(localStorage.getItem(storageKey) || '{}');
          if (value) {
            episodeData[storageEpisodeKey] = true;

            // On vérifie si la série elle-même est déjà dans la liste principale
            // Si non, on n'ajoute pas la série entière automatiquement, uniquement
            // l'épisode individuel. L'objectif est d'avoir une distinction claire
            // entre "série entière marquée" et "quelques épisodes marqués"
            const seriesListKey = `${itemType}_tv`;
            let seriesList = JSON.parse(localStorage.getItem(seriesListKey) || '[]');

            // On s'assure que seriesList est bien un array
            if (!Array.isArray(seriesList)) seriesList = [];

            // Vérifie si cette série est déjà présente dans la liste principale
            seriesList.some((media: any) => media.id === Number(showId));

            // On ne l'ajoute PAS automatiquement à la liste principale
            // car l'utilisateur veut marquer les épisodes individuellement

            // Si on voulait l'ajouter automatiquement après un certain seuil,
            // on pourrait implémenter cette logique ici
          } else {
            delete episodeData[storageEpisodeKey];
            // Optional: Check if this was the last episode and remove series from main list if so
            // This might be complex if series can be in list for other reasons (e.g. manually added)
          }
          localStorage.setItem(storageKey, JSON.stringify(episodeData));
        } catch (error) {
          console.error(`Error updating ${itemType} episodes in localStorage:`, error);
        }

      } else if (tvShow && showId) { // For series-level status
        newStatus = { ...prev, [type]: value };

        // Update localStorage for series watchlist, favorites, watched
        // For watchlist, favorite, watched
        let storageKey = '';
        if (type === 'watchlist') storageKey = 'watchlist_tv';
        else if (type === 'favorite') storageKey = 'favorites_tv';
        else if (type === 'watched') storageKey = 'watched_tv';

        if (storageKey) {
          try {
            let currentList = JSON.parse(localStorage.getItem(storageKey) || '[]');
            // Ensure currentList is an array
            if (!Array.isArray(currentList)) {
              currentList = [];
            }

            if (value) {
              // Add to list if not already there
              if (!currentList.some((media: any) => media.id === Number(showId))) {
                currentList.push({
                  id: Number(showId),
                  type: 'tv',
                  title: tvShow.name,
                  poster_path: tvShow.poster_path,
                  addedAt: new Date().toISOString()
                  // We might want to store last watched episode or progress here later
                });
                localStorage.setItem(storageKey, JSON.stringify(currentList));
              }
            } else {
              // Remove from list
              const updatedList = currentList.filter((media: any) => media.id !== Number(showId));
              localStorage.setItem(storageKey, JSON.stringify(updatedList));
            }
          } catch (error) {
            console.error(`Error updating ${type} in localStorage:`, error);
          }
        }
      } else {
        // Fallback or if tvShow or showId is not available yet
        newStatus = { ...prev };
        if (!episodeKey) { // if it's a series-level action but tvShow is not loaded
          // Ensure 'type' is one of the boolean properties of WatchStatus
          if (type === 'watchlist' || type === 'favorite' || type === 'watched') {
            newStatus = {
              ...prev,
              [type]: value
            };
          } else {
            // This case should ideally not be reached if !episodeKey
            // but as a safe-guard, we don't modify the status for episodeWatchlist/episodeWatched types here
            // without an episodeKey.
            console.warn('Attempted to update episode status without episodeKey in fallback');
          }
        } else {
          // If episodeKey exists but tvShow/showId doesn't, we can't update localStorage,
          // but we can update the local state for episode specific status
          const episodeField = type === 'episodeWatchlist' ? 'episodeWatchlist' : 'episodeWatched';
          newStatus = {
            ...prev,
            [episodeField]: {
              ...prev[episodeField],
              [episodeKey]: value
            }
          };
        }
      }
      return newStatus as WatchStatus;
    });
  };

  // Continue watching data functionality removed

  // Format time from seconds to MM:SS or HH:MM:SS
  const formatTime = (timeInSeconds: number) => {
    if (!timeInSeconds || isNaN(timeInSeconds)) return "00:00";
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Check the continue watching data
  const [continueWatchingData, setContinueWatchingData] = useState<{
    seasonNumber: number,
    episodeNumber: number,
    position: number,
    duration: number,
    hasProgress: boolean
  }>({
    seasonNumber: 1,
    episodeNumber: 1,
    position: 0,
    duration: 0,
    hasProgress: false
  });

  type ContinueWatchingTvEntry = {
    id: number;
    currentEpisode?: {
      season: number;
      episode: number;
    };
    lastAccessed?: string;
  };

  useEffect(() => {
    // Load any existing watch progress
    if (id) {
      try {
        let latestTimestamp = -1;
        let latestSeason = 1;
        let latestEpisode = 1;
        let latestPosition = 0;
        let latestDuration = 0;

        const considerCandidate = (
          seasonNumber: number,
          episodeNumber: number,
          timestampMs: number,
          position = 0,
          duration = 0
        ) => {
          if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) return;
          if (seasonNumber <= 0 || episodeNumber <= 0) return;
          if (!Number.isFinite(timestampMs)) return;

          if (timestampMs > latestTimestamp) {
            latestTimestamp = timestampMs;
            latestSeason = seasonNumber;
            latestEpisode = episodeNumber;
            latestPosition = Number(position) || 0;
            latestDuration = Number(duration) || 0;
          }
        };

        // First, check the continueWatching localStorage data
        const continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}') as {
          tv?: ContinueWatchingTvEntry[];
        };

        if (continueWatching.tv && Array.isArray(continueWatching.tv)) {
          const showIdInt = parseInt(id);
          const tvShow = continueWatching.tv.find((show) => show.id === showIdInt);

          if (tvShow && tvShow.currentEpisode) {
            const seasonFromContinue = Number(tvShow.currentEpisode.season);
            const episodeFromContinue = Number(tvShow.currentEpisode.episode);
            const continueTs = tvShow.lastAccessed ? Date.parse(tvShow.lastAccessed) : NaN;

            // Try to get detailed progress data for this specific episode
            const progressKey = `progress_tv_${id}_s${seasonFromContinue}_e${episodeFromContinue}`;
            const progressValue = Number.isFinite(seasonFromContinue) && Number.isFinite(episodeFromContinue)
              ? localStorage.getItem(progressKey)
              : null;
            let position = 0;
            let duration = 0;
            let progressTs = NaN;

            if (progressValue) {
              try {
                const progressData = JSON.parse(progressValue);
                position = Number(progressData.position) || 0;
                duration = Number(progressData.duration) || 0;
                progressTs = progressData.timestamp ? Date.parse(progressData.timestamp) : NaN;
              } catch (error) {
                console.error('Error parsing progress data:', error);
              }
            }

            const effectiveTimestamp = Number.isFinite(progressTs)
              ? progressTs
              : Number.isFinite(continueTs)
                ? continueTs
                : NaN;

            considerCandidate(seasonFromContinue, episodeFromContinue, effectiveTimestamp, position, duration);
          }
        }

        // Also check all progress_tv_* keys and keep the most recent by timestamp
        const keyPrefix = `progress_tv_${id}_s`;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith(keyPrefix)) continue;
          // Expected pattern: progress_tv_<id>_s<season>_e<episode>
          const match = key.match(/^progress_tv_\d+_s(\d+)_e(\d+)$/);
          if (!match) continue;
          const season = Number(match[1]);
          const episode = Number(match[2]);
          const value = localStorage.getItem(key);
          if (!value) continue;
          try {
            const progressData = JSON.parse(value);
            const ts = progressData.timestamp ? Date.parse(progressData.timestamp) : NaN;
            if (!Number.isFinite(ts)) continue;
            considerCandidate(
              season,
              episode,
              ts,
              Number(progressData.position) || 0,
              Number(progressData.duration) || 0
            );
          } catch (_) {
            // ignore malformed entries
          }
        }

        if (latestTimestamp !== -1) {
          // Validation de la disponibilité de la saison (si exclue, par exemple)
          let effectiveSeason = latestSeason;
          let effectiveEpisode = latestEpisode;

          if (!animeMode && availableSeasons.length > 0 && !availableSeasons.includes(effectiveSeason)) {
            effectiveSeason = defaultStartSeason;
            effectiveEpisode = 1;
          }

          setContinueWatchingData({
            seasonNumber: effectiveSeason,
            episodeNumber: effectiveEpisode,
            position: latestPosition,
            duration: latestDuration,
            hasProgress: true
          });
          return;
        }

        // No valid progress found, reset to default
        setContinueWatchingData({
          seasonNumber: defaultStartSeason,
          episodeNumber: 1,
          position: 0,
          duration: 0,
          hasProgress: false
        });
      } catch (error) {
        console.error('Error parsing continue watching data:', error);
      }
    }
  }, [id, animeMode, availableSeasons, defaultStartSeason]);
  // Fonction pour continuer le visionnage
  const handleContinueWatching = () => {
    // Use the progress data if available, otherwise start from the first episode
    let seasonToWatch = continueWatchingData.hasProgress ? continueWatchingData.seasonNumber : defaultStartSeason;
    let episodeToWatch = continueWatchingData.hasProgress ? continueWatchingData.episodeNumber : 1;

    // Validation: si la saison demandée n'est pas disponible, prendre la première disponible
    // Cela gère le cas où la saison 1 est exclue (ex: série 71446).
    // En mode anime on valide contre animeData.seasons (numérotation anime) car
    // availableSeasons ne reflète que les saisons TMDB — ce qui renverrait à tort
    // S1E1 lorsqu'un anime a des saisons/cours additionnels non présents dans TMDB.
    const animeSeasonNumbers = animeMode && animeData?.seasons
      ? (animeData.seasons as any[]).map((s, idx) => Number(s?.number ?? (idx + 1)))
      : null;

    if (animeSeasonNumbers && animeSeasonNumbers.length > 0) {
      if (!animeSeasonNumbers.includes(seasonToWatch)) {
        seasonToWatch = animeSeasonNumbers[0];
        episodeToWatch = 1;
      }
    } else if (availableSeasons.length > 0 && !availableSeasons.includes(seasonToWatch)) {
      seasonToWatch = defaultStartSeason;
      episodeToWatch = 1;
    }

    setSelectedSeason(seasonToWatch);
    setSelectedEpisode(episodeToWatch);

    // Check if Cinema Mode is active
    if (cinemaMode && id) {
      // Check if it's Anime Mode
      if (animeMode) {
        navigate(`/watch/anime/${encodeId(id)}/season/${seasonToWatch}/episode/${episodeToWatch}`);
      } else {
        // Navigate to the dedicated TV watch page
        navigate(`/watch/tv/${encodeId(id)}/s/${seasonToWatch}/e/${episodeToWatch}`);
      }
      return;
    }

  };
  const WatchButtons = () => {
    return (
      <div className="flex flex-col gap-4 mt-4">
        {/* Première ligne avec Regarder et Bande-annonce */}
        <div className="flex flex-wrap gap-3 w-full min-w-0">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={handleContinueWatching}
            className="flex flex-col items-center gap-2 px-4 sm:px-6 py-4 sm:py-5 bg-red-600 hover:bg-red-700 rounded-lg flex-1 min-w-0 justify-center text-xs sm:text-sm"
          >
            <Play className="w-5 h-5 sm:w-6 sm:h-6 flex-shrink-0" />
            <div className="text-center">
              {continueWatchingData.hasProgress ? (
                <div className="flex flex-col items-center text-center w-full">
                      <span>{t('details.resumeEpisode', { episode: continueWatchingData.episodeNumber, season: getSeasonDisplayName(continueWatchingData.seasonNumber, id, t) })}</span>
                  <span className="text-xs bg-red-800/80 text-white px-1.5 py-0.5 rounded font-medium mt-1">
                    {formatTime(continueWatchingData.position)}/{formatTime(continueWatchingData.duration)}
                  </span>
                </div>
              ) : (availableSeasons.length > 0 && continueWatchingData.seasonNumber !== defaultStartSeason) || continueWatchingData.episodeNumber !== 1 ? (
                      <span>{t('details.continueEpisode', { episode: continueWatchingData.episodeNumber, season: getSeasonDisplayName(continueWatchingData.seasonNumber, id, t) })}</span>
              ) : (
                <>
                    {t('details.startEpisode', { season: getSeasonDisplayName(defaultStartSeason, id, t) })}
                </>
              )}
            </div>
          </motion.button>

          {(!ENABLE_VIP_DOWNLOAD_CHECK || localStorage.getItem('is_vip') === 'true') && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
              onClick={() => navigate(`/download/tv/${tvShow?.id}`)}
              className="flex flex-col items-center gap-2 px-4 sm:px-6 py-4 sm:py-5 bg-green-600 hover:bg-green-700 rounded-lg flex-1 min-w-0 justify-center text-xs sm:text-sm"
            >
              <Download className="w-5 h-5 sm:w-6 sm:h-6 flex-shrink-0" />
              <span className="text-center">{t('details.downloadBtn')}</span>
            </motion.button>
          )}
        </div>

        {/* Deuxième ligne avec les autres boutons */}
        <div className="flex flex-wrap gap-3">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={() => setShowTrailerPopup(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"
            disabled={!trailerVideo}
          >
            <Video className="w-4 h-4" />
            {t('details.bandeAnnonce')}
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => updateWatchStatus('watchlist', !watchStatus.watchlist)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.watchlist
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <List className="w-4 h-4" />
            {t('details.watchlistBtn')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => updateWatchStatus('favorite', !watchStatus.favorite)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.favorite
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <Star className="w-4 h-4" />
            {t('details.favoritesBtn')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => updateWatchStatus('watched', !watchStatus.watched)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.watched
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <Check className="w-4 h-4" />
            {t('details.watchedBtn')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowAddToList(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg"
          >
            <FolderPlus className="w-4 h-4" />
            {t('details.addToAList')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowAntiSpoilerModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-800 hover:bg-purple-700 rounded-lg"
            title={t('details.antiSpoilConfig')}
          >
            <Shield className="w-4 h-4" />
            {t('details.antiSpoil')}
          </motion.button>

          {showAddToList && (
            <AddToListMenu
              mediaId={Number(id)}
              mediaType="tv"
              title={tvShow?.name || ''}
              posterPath={tvShow?.poster_path || ''}
              onClose={() => setShowAddToList(false)}
            />
          )}

          {showAntiSpoilerModal && (
            <AntiSpoilerSettingsModal
              isOpen={showAntiSpoilerModal}
              onClose={() => setShowAntiSpoilerModal(false)}
              onSettingsChange={updateAntiSpoilerSettings}
              currentSettings={antiSpoilerSettings}
            />
          )}

          <ShareButtons
            title={tvShow?.name || ''}
            description={tvShow?.overview || ''}
            imageUrl={tvShow?.poster_path ? `https://image.tmdb.org/t/p/original${tvShow.poster_path}` : undefined}
            url={buildSiteUrl(`/tv/${encodedId || id}`)}
          />
        </div>
      </div>
    );
  };

  useEffect(() => {
    const fetchShow = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get(
          `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,videos,content_ratings,networks,external_ids&language=${getTmdbLanguage()}`
        );
        setShow(response.data);
        // Set cast state
        if (response.data.credits && response.data.credits.cast) {
          setCast(response.data.credits.cast);
        }
        // Set crew state (using the grouping function)
        if (response.data.credits && response.data.credits.crew) {
          setCrew(groupCrewMembers(response.data.credits.crew));
        }
      } catch (error) {
        console.error('Error fetching TV show:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchShow();
  }, [id]);

  const checkFrembedAvailability = async () => {
    setLoadingSimilar(true);
    try {
      // Simplement définir tous les shows comme disponibles
      const availableShows = recommendations.map(show => ({ ...show, isAvailable: true }));
      setRecommendations(availableShows);
    } catch (error) {
      console.error('Error checking availability:', error);
    } finally {
      setLoadingSimilar(false);
    }
  };

  const fetchRecommendations = async () => {
    if (recommendationsLoaded) return; // Éviter de refaire la requête si déjà chargé

    setLoadingSimilar(true);
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${id}/recommendations?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );

      const results = response.data.results || [];
      setRecommendations(results.slice(0, 20));
      setRecommendationsLoaded(true); // Marquer comme chargé même si vide
    } catch (error) {
      console.error('Error fetching recommendations:', error);
      setRecommendationsLoaded(true); // Marquer comme chargé même en cas d'erreur
    } finally {
      setLoadingSimilar(false);
    }
  };

  const _handleShowSimilar = async () => {
    // Charge les recommandations mais n'ouvre plus la modale
    if (!recommendationsLoaded) {
      await fetchRecommendations();
      await checkFrembedAvailability();
    }
  };
  void _handleShowSimilar;

  // Charger automatiquement les séries similaires lors du chargement de la page
  useEffect(() => {
    if (id && tvShow && !recommendationsLoaded) {
      fetchRecommendations();
    }
  }, [id, tvShow, recommendationsLoaded]);

  const handleEpisodeSelect = async (seasonNumber: number, episodeNumber: number) => {
    setSelectedSeason(seasonNumber);
    setSelectedEpisode(episodeNumber);

    // Watch history functionality removed
  };

  useEffect(() => {
    if (tvShow) {
      // Simple TV show title
      document.title = `${tvShow.name} - Movix`;
    } else {
      document.title = t('details.tvShowDefaultTitle');
    }
  }, [tvShow, id]);

  const isAnime = useCallback(() => {
    if (!tvShow) return false;
    // Exclure spécifiquement certaines séries du mode anime
    if (shouldHideAnimeModeForId(id || '')) return false;
    // Scoring multi-signaux TMDB: origin_country, original_language, studio japonais,
    // keywords "anime"/"manga" (avec garde JP/ja), genre Animation. Seuil 40.
    return isLikelyAnime(tvShow as unknown as Parameters<typeof isLikelyAnime>[0], tmdbKeywords);
  }, [tvShow, id, tmdbKeywords]);

  /**
   * Les personnages de la fiche. AniList quand la série a le profil d'un anime
   * — elle rend les personnages eux-mêmes, là où TMDB ne rend que des
   * comédiens — et le générique TMDB sinon, ou si AniList ne connaît pas
   * l'œuvre. Les titres sont proposés du plus prometteur au moins : l'original
   * japonais, puis l'anglais, tous deux mieux indexés chez eux que le titre
   * traduit affiché.
   */
  useEffect(() => {
    if (!tvShow) return;
    let stale = false;
    setCharactersLoading(true);

    void loadDetailCharacters({
      looksLikeAnime: isAnime(),
      anilistTitles: [tvShow.original_name, tmdbEnglishName, tvShow.name]
        .filter((title): title is string => Boolean(title)),
      cast: fullCast,
    })
      .then((result) => { if (!stale) setCharacters(result); })
      .catch(() => { if (!stale) setCharacters(null); })
      .finally(() => { if (!stale) setCharactersLoading(false); });

    return () => { stale = true; };
  }, [tvShow, tmdbEnglishName, fullCast, isAnime]);

  /** Mots-clés et titres alternatifs, mis à plat pour l'affichage. */
  const extraKeywords = useMemo(
    () => normalizeKeywords(tmdbKeywords, getTmdbLanguage()),
    [tmdbKeywords],
  );
  const extraAlternateTitles = useMemo(
    () => normalizeAlternateTitles(
      { results: tmdbAlternativeTitles },
      [tvShow?.name, tvShow?.original_name, tmdbEnglishName],
    ),
    [tmdbAlternativeTitles, tvShow?.name, tvShow?.original_name, tmdbEnglishName],
  );

  /**
   * Ce que la fiche vient de récupérer alimente le catalogue local de
   * recherche. Titres alternatifs, mots-clés, thèmes et noms de personnages
   * sont exactement ce que `search/multi` ne sait pas trouver : les garder
   * rend la fiche retrouvable par ces mots-là (voir `utils/mediaSearchIndex`).
   */
  useEffect(() => {
    if (!tvShow || !id) return;
    rememberMedia({
      mediaType: 'tv',
      id: Number(id),
      title: tvShow.name,
      posterPath: tvShow.poster_path,
      backdropPath: tvShow.backdrop_path,
      date: tvShow.first_air_date,
      voteAverage: tvShow.vote_average,
      genreIds: tvShow.genres?.map((genre) => genre.id),
      overview: tvShow.overview,
      terms: [
        tvShow.original_name,
        tmdbEnglishName,
        ...extraAlternateTitles.map((entry) => entry.title),
        ...extraKeywords,
        ...(characters?.themes ?? []),
        ...(characters?.groups.flatMap((group) => group.characters.map((item) => item.name)) ?? []),
      ].filter((term): term is string => Boolean(term)),
    });
  }, [tvShow, id, tmdbEnglishName, extraAlternateTitles, extraKeywords, characters]);

  /** L'onglet n'a de raison d'être que s'il a quelque chose dedans. */
  /**
   * L'onglet n'existe que pour ce qu'AniList apporte. Sur une œuvre qu'elle ne
   * connaît pas — un film, une série qui n'est pas un anime — les personnages
   * ne viennent que du générique TMDB, et l'onglet Distribution dit déjà la
   * même chose dans l'autre sens. Les cartes restent construites : elles
   * nourrissent le catalogue de recherche, qui lui gagne à connaître les noms
   * de rôles (voir `utils/mediaSearchIndex.ts`).
   */
  const hasCharactersTab = characters?.source === 'anilist' && characters.total > 0;

  const loadAnimeData = useCallback(async () => {
    if (!tvShow?.name) return;

    setLoadingAnimeData(true);
    try {
      // Use the new utility function for search name logic
      const searchName = getSearchNameForId(tvShow.id || '', tvShow.name);

      // Utiliser la nouvelle logique de recherche avec fallback
      const searchFunction = async (term: string) => {
        const response = await axios.get(`${MAIN_API}/anime/search/${encodeURIComponent(term)}?includeSeasons=true&includeEpisodes=true`);
        return response.data || [];
      };

      const results = await searchWithFallback(searchFunction, searchName, 'TVDetails');

      if (results.length > 0) {
        // --- PATCH SPECIAL ANIMES (cas fixés par TMDB id) ---
        const specialMatcher = getAnimeMatcherForId(tvShow.id || '');
        let bestMatch: AnimeSamaCandidate | null = null;
        if (specialMatcher) {
          bestMatch = (results as AnimeSamaCandidate[]).find((anime) =>
            specialMatcher({ name: anime.name || '', seasons: anime.seasons })
          ) || null;
        } else {
          // Scoring unifié : on compare CHAQUE candidat contre tous les noms TMDB
          // (titre localisé, titre anglais, original_name, alternative_titles FR/US/GB/JP).
          const tmdbNames = collectTmdbNames(
            { name: tvShow.name, original_name: (tvShow as { original_name?: string }).original_name },
            tmdbEnglishName ? { name: tmdbEnglishName } : null,
            tmdbAlternativeTitles,
          );
          // Toujours inclure le searchName (cas spécial override)
          if (searchName && !tmdbNames.includes(searchName)) tmdbNames.push(searchName);

          const { match, score, reason } = pickBestAnimeMatch(
            results as AnimeSamaCandidate[],
            tmdbNames,
          );
          if (match) {
            console.log(`[anime-match] ${reason} score=${score.toFixed(3)} -> ${match.name}`);
            bestMatch = match;
          } else {
            console.log(`[anime-match] ${reason}`);
          }
        }

        if (bestMatch && Array.isArray(bestMatch.seasons) && bestMatch.seasons.length > 0) {
          setAnimeData(bestMatch);
          return bestMatch;
        } else {
          setAnimeData(null);
          setShowAnimeNotFoundMessage(true);
          setTimeout(() => {
            setShowAnimeNotFoundMessage(false);
          }, 5000);
          return null;
        }
      } else {
        console.log("Aucun résultat trouvé dans la source anime, passage en mode normal");
        setAnimeData(null);

        // Afficher un message temporaire
        setShowAnimeNotFoundMessage(true);
        setTimeout(() => {
          setShowAnimeNotFoundMessage(false);
        }, 5000);
        return null;
      }
    } catch (error) {
      console.error('Error loading anime data:', error);
      setAnimeData(null);
      return null;
    } finally {
      setLoadingAnimeData(false);
    }
  }, [tvShow?.id, tvShow?.name, tvShow, tmdbEnglishName, tmdbAlternativeTitles, MAIN_API]);

  const syncSelectedAnimeEpisode = useCallback((nextAnimeData: any) => {
    if (selectedSeason === null || !selectedEpisode || !nextAnimeData?.seasons) {
      setSelectedAnimeEpisode(null);
      setSelectedLanguage(null);
      setSelectedPlayer(null);
      return;
    }

    const currentSeason = nextAnimeData.seasons.find(
      (season: any, index: number) => (season.number || (index + 1)) === selectedSeason
    );
    const currentEpisode = currentSeason?.episodes?.find((episode: any) => episode.index === selectedEpisode);

    if (!currentEpisode) {
      setSelectedAnimeEpisode(null);
      setSelectedLanguage(null);
      setSelectedPlayer(null);
      return;
    }

    setSelectedAnimeEpisode(currentEpisode);

    const hasVf = currentEpisode.streaming_links?.some((link: any) => link.language === 'vf');
    const hasVostfr = currentEpisode.streaming_links?.some((link: any) => link.language === 'vostfr');

    if (hasVf) {
      setSelectedLanguage('vf');
    } else if (hasVostfr) {
      setSelectedLanguage('vostfr');
    } else {
      setSelectedLanguage(currentEpisode.streaming_links?.[0]?.language || null);
    }

    setSelectedPlayer('0');
  }, [selectedEpisode, selectedSeason]);

  const handleAnimeModeToggle = useCallback(async () => {
    if (animeMode) {
      setAnimeMode(false);
      setSelectedAnimeEpisode(null);
      setSelectedLanguage(null);
      setSelectedPlayer(null);
      // Si la saison sélectionnée en mode anime n'existe pas côté TMDB,
      // revenir sur une saison/épisode valide pour éviter le message
      // "Pas d'épisodes disponibles pour cette saison".
      if (availableSeasons.length > 0 && (selectedSeason === null || !availableSeasons.includes(selectedSeason))) {
        setSelectedSeason(defaultStartSeason);
        const firstEpisode = availableEpisodes
          .filter((ep) => Number(ep.sa) === defaultStartSeason)
          .sort((a, b) => Number(a.epi) - Number(b.epi))[0];
        setSelectedEpisode(firstEpisode ? Number(firstEpisode.epi) : 1);
      }
      return;
    }

    const resolvedAnimeData = animeData || await loadAnimeData();
    if (!resolvedAnimeData?.seasons?.length) {
      return;
    }

    syncSelectedAnimeEpisode(resolvedAnimeData);
    setAnimeMode(true);
  }, [animeData, animeMode, loadAnimeData, syncSelectedAnimeEpisode, availableSeasons, selectedSeason, defaultStartSeason, availableEpisodes]);

  useEffect(() => {
    let isCancelled = false;

    const checkAndLoadAnime = async () => {
      if (isAnime()) {
        const resolvedAnimeData = await loadAnimeData();
        if (isCancelled) {
          return;
        }

        const defaultToStandardMode = shouldDefaultAnimeModeToOff(id || '');
        setAnimeMode(Boolean(resolvedAnimeData?.seasons?.length) && !defaultToStandardMode);
      }
    };

    checkAndLoadAnime();

    return () => {
      isCancelled = true;
    };
  }, [id, isAnime, loadAnimeData]);

  useEffect(() => {
    if (animeMode && animeData) {
      // Filter out seasons without episodes
      const filteredSeasons = animeData.seasons.filter((season: any) =>
        season && season.episodes && season.episodes.length > 0
      );

      // Check if we need to update animeData with filtered seasons
      if (filteredSeasons.length !== animeData.seasons.length) {
        setAnimeData({
          ...animeData,
          seasons: filteredSeasons
        });
      }
    }
  }, [animeMode, animeData]);

  const _scrollToSeasons = () => {
    const seasonsSection = seasonsSectionRef.current;
    if (seasonsSection) {
      seasonsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
  void _scrollToSeasons;

  const fetchBackdropAndTrailer = async () => {
    try {
      console.log('Fetching backdrop and trailer for TV show:', id);

      // Récupérer les images
      const imagesResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/images`, {
        params: { api_key: TMDB_API_KEY }
      });

      // Trouver la meilleure image de fond
      const backdrops = imagesResponse.data.backdrops;
      if (backdrops && backdrops.length > 0) {
        const bestBackdrop = backdrops.sort((a: any, b: any) => b.width - a.width)[0];
        setBackdropImage(`https://image.tmdb.org/t/p/w1280${bestBackdrop.file_path}`);
      }

      // Récupérer la bande-annonce
      const videosResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/videos`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
      });

      console.log('French videos response:', videosResponse.data.results);
      let trailer = videosResponse.data.results.find((video: any) => video.type === 'Trailer');

      // Si pas de bande-annonce en français, essayer en anglais
      if (!trailer) {
        console.log('No French trailer found, trying English...');
        const enVideosResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/videos`, {
          params: { api_key: TMDB_API_KEY, language: 'en-US' }
        });
        console.log('English videos response:', enVideosResponse.data.results);
        trailer = enVideosResponse.data.results.find((video: any) => video.type === 'Trailer');
      }

      if (trailer) {
        console.log('Trailer found:', trailer);
        setTrailerVideo(trailer);
      } else {
        console.log('No trailer found for this TV show');
        setTrailerVideo(null);
      }
    } catch (error) {
      console.error('Error fetching backdrop and trailer:', error);
      setTrailerVideo(null);
    }
  };

  // Function to fetch multi-language videos for TV shows
  const fetchMultiLangVideos = useCallback(async () => {
    if (!id) return;
    try {
      setLoadingMultiLangVideos(true);
      // Fetch videos without language parameter to get all languages
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${id}/videos`,
        {
          params: {
            api_key: TMDB_API_KEY
          }
        }
      );

      setMultiLangVideos(response.data.results || []);
    } catch (error) {
      console.error('Error fetching multi-language videos:', error);
      setMultiLangVideos([]);
    } finally {
      setLoadingMultiLangVideos(false);
    }
  }, [id]);

  // Function to fetch multi-language videos for a specific season
  const fetchSeasonMultiLangVideos = useCallback(async (seasonNumber: number) => {
    if (!id) return;
    try {
      setLoadingSeasonMultiLangVideos(prev => ({ ...prev, [seasonNumber]: true }));
      // Always fetch videos without language parameter to get all languages for multi-lang view
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}/videos`,
        {
          params: {
            api_key: TMDB_API_KEY
            // No language parameter = all languages
          }
        }
      );

      setSeasonMultiLangVideos(prev => ({ ...prev, [seasonNumber]: response.data.results || [] }));
    } catch (error) {
      console.error(`Error fetching multi-language videos for season ${seasonNumber}:`, error);
      setSeasonMultiLangVideos(prev => ({ ...prev, [seasonNumber]: [] }));
    } finally {
      setLoadingSeasonMultiLangVideos(prev => ({ ...prev, [seasonNumber]: false }));
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      fetchBackdropAndTrailer();
    }
  }, [id]);

  if (loading) {
    return <DetailsSkeleton />;
  }

  if (error) return <div className="text-center text-red-500">{error}</div>;
  if (!tvShow) return <div className="text-center">{t('details.tvNotFound')}</div>;

  // Age restriction check
  const contentCert = certifications['FR'] || certifications['US'] || '';
  const profileAgeRestriction = currentProfile?.ageRestriction ?? 0;
  if (contentCert && profileAgeRestriction > 0 && !isContentAllowed(contentCert, profileAgeRestriction)) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-red-600/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">{t('details.contentBlocked')}</h2>
          <p className="text-gray-400 mb-6">
            {t('details.contentBlockedDesc', { rating: getClassificationLabel(contentCert, t), age: profileAgeRestriction })}
          </p>
          <button
            onClick={() => navigate(-1)}
            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
          >
            {t('details.goBack')}
          </button>
        </div>
      </div>
    );
  }

  // Helper function to determine default dropdown mode based on episode count
  const getDefaultDropdownMode = (episodeCount: number) => {
    return episodeCount > 15;
  };
  // Function to render episodes (either dropdown or grid)
  const renderEpisodes = (episodes: any[], type: 'anime' | 'standard') => {
    // Filter out empty episodes first to avoid issues
    const nonEmptyEpisodes = episodes.filter(ep => {
      if (type === 'anime') {
        return ep && ep.streaming_links && ep.streaming_links.length > 0;
      }
      return true;
    });

    if (nonEmptyEpisodes.length === 0) {
      return (
        <div className="text-center p-4 bg-gray-800/50 border border-gray-700 rounded-lg">
          <p>{t('details.noEpisodesForSeason')}</p>
        </div>
      );
    }

    const showToggle = true; // Toujours afficher le bouton de menu déroulant
    const isAnime = type === 'anime';

    // Déterminer le mode par défaut basé sur le nombre d'épisodes
    const defaultDropdownMode = nonEmptyEpisodes.length > 15;

    const selectableEpisodes = nonEmptyEpisodes.filter((ep: any) => {
      if (type === 'anime') return true;
      const today = new Date();
      const airDate = ep.air_date ? new Date(ep.air_date) : null;
      const isFuture = airDate && airDate > today;
      return !isFuture;
    });

    const dropdownOptions = selectableEpisodes.map((ep: any) => {
      if (type === 'anime') {
        const allLanguages = ep.streaming_links.map((link: any) => {
          return getAnimeLanguageLabel(link.language, t);
        }).join(', ');
        return {
          value: ep.index.toString(),
          label: `${ep.index}. ${ep.name} ${allLanguages ? `(${allLanguages})` : ''}`,
        };
      } else {
        return {
          value: ep.episode_number.toString(),
          label: shouldHide('episodeNames') 
            ? getMaskedContent(ep.name, 'episodeNames', undefined, ep.episode_number) 
            : `${ep.episode_number}. ${ep.name}`,
        };
      }
    });

    const handleDropdownChange = (valueStr: string) => {
      if (type === 'anime') {
        const episode = nonEmptyEpisodes.find((ep: any) => ep.index === Number(valueStr));
        if (episode) {
          setSelectedEpisode(episode.index);
          setSelectedAnimeEpisode(episode);

          const hasVf = episode.streaming_links.some((link: any) => link.language === 'vf');
          const hasVostfr = episode.streaming_links.some((link: any) => link.language === 'vostfr');

          if (hasVf) {
            setSelectedLanguage('vf');
          } else if (hasVostfr) {
            setSelectedLanguage('vostfr');
          }
          setSelectedPlayer('0');

          if (cinemaMode && id && selectedSeason) {
            navigate(`/watch/anime/${encodeId(id)}/season/${selectedSeason}/episode/${episode.index}`);
            return;
          }

        }
      } else {
        handleEpisodeChange(Number(valueStr));
      }
    };

    const handleAnimeGridClick = (episode: any) => {
      setSelectedEpisode(episode.index);
      setSelectedAnimeEpisode(episode);

      const hasVf = episode.streaming_links.some((link: any) => link.language === 'vf');
      const hasVostfr = episode.streaming_links.some((link: any) => link.language === 'vostfr');

      if (hasVf) {
        setSelectedLanguage('vf');
      } else if (hasVostfr) {
        setSelectedLanguage('vostfr');
      }
      setSelectedPlayer('0');

      if (cinemaMode && id && selectedSeason) {
        // Rediriger vers la page de visionnage anime en mode cinéma
        navigate(`/watch/anime/${encodeId(id)}/season/${selectedSeason}/episode/${episode.index}`);
        return;
      }

    };

    return (
      <AnimatePresence mode="wait">
        {showToggle && (dropdownMode !== null ? dropdownMode : defaultDropdownMode) ? (
          // Dropdown mode (si > 15 épisodes par défaut, ou si activé manuellement)
          <motion.div
            key="dropdown"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex justify-start mb-6">  {/* Alignement à gauche */}
              <div className="w-full max-w-md">
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  {t('details.selectEpisode')}
                </label>
                <CustomDropdown
                  options={dropdownOptions}
                  value={selectedEpisode ? selectedEpisode.toString() : ""}
                  onChange={handleDropdownChange}
                  placeholder={t('details.chooseEpisode')}
                  searchable={true}
                  className="w-full"
                />
              </div>
            </div>
          </motion.div>
        ) : (
          // Grid mode (mode par défaut ou si toggle activé)
          <motion.div
            key="grid"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className={`grid grid-cols-1 ${isAnime ? 'md:grid-cols-3' : 'md:grid-cols-3 lg:grid-cols-4'} gap-4 mb-6`}>
              {nonEmptyEpisodes.map((ep: any, index: number) => {
                // ... grid item rendering ...
                if (isAnime) {
                  const isSelected = selectedEpisode === ep.index;

                  // Récupérer toutes les langues disponibles pour cet épisode
                  const availableLanguages = ep.streaming_links.map((link: any) => link.language);

                  return (
                    <motion.div
                      key={`anime-${selectedSeason}-${ep.index}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1, transition: { delay: index * 0.05, duration: 0.3 } }}
                      className={`group relative rounded-xl overflow-hidden border border-white/10 hover:border-red-500 transition-all duration-300 bg-gray-800 flex flex-col ${isSelected ? 'ring-2 ring-red-500' : ''}`}
                      whileHover={{ y: -5, transition: { duration: 0.2 } }}
                    >
                      <button
                        className="block w-full text-left p-4"
                        onClick={() => handleAnimeGridClick(ep)}
                      >
                        <div className="flex flex-col">
                          <h4 className="text-lg font-medium group-hover:text-red-500 transition-colors mb-2">
                            {ep.index}. {ep.name}
                          </h4>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {availableLanguages.map((language: string, i: number) => (
                              <span
                                key={`lang-badge-${language}-${i}`}
                                className={`text-white text-xs px-2 py-1 rounded ${language === 'vostfr' ? 'bg-blue-600/70' :
                                  language === 'vf' ? 'bg-green-600/70' :
                                    'bg-purple-600/70'
                                  }`}
                              >
                                {getAnimeLanguageLabel(language, t)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    </motion.div>
                  );
                } else {
                  const episodeKey = `s${selectedSeason}e${ep.episode_number}`;
                  const isSelected = selectedEpisode === ep.episode_number;

                  // Compute per-episode progress from localStorage if present
                  let progressPercentage = 0;
                  let hasProgress = false;
                  try {
                    if (typeof window !== 'undefined' && id) {
                      const progressKey = `progress_tv_${id}_s${selectedSeason}_e${ep.episode_number}`;
                      const saved = localStorage.getItem(progressKey);
                      if (saved) {
                        const parsed = JSON.parse(saved);
                        if (parsed && parsed.position && parsed.duration && parsed.duration > 0) {
                          progressPercentage = Math.round((parsed.position / parsed.duration) * 100);
                          // consider progress only if at least 1% watched
                          hasProgress = parsed.position > 0 && progressPercentage > 0;
                        }
                      }
                    }
                  } catch (err) {
                    // ignore localStorage/parsing errors
                  }
                  // If the episode is explicitly marked as watched in state, prefer that
                  const isEpisodeWatched = watchStatus?.episodeWatched?.[episodeKey];
                  // If watched, show a full green bar; otherwise show actual progress
                  const displayProgress = isEpisodeWatched ? 100 : progressPercentage;

                  return (
                    <motion.div
                      key={`${selectedSeason}-${ep.episode_number}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{
                        opacity: 1,
                        scale: 1,
                        transition: { delay: index * 0.05, duration: 0.3 }
                      }}
                      className={`group relative rounded-xl overflow-hidden border border-white/10 hover:border-red-500 transition-all duration-300 bg-white/10 flex flex-col ${isSelected ? 'ring-2 ring-red-500' : ''}`}
                      whileHover={{ y: -5, transition: { duration: 0.2 } }}
                      layout={false}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className="block w-full text-left cursor-pointer"
                        onClick={() => handleEpisodeChange(ep.episode_number)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            handleEpisodeChange(ep.episode_number);
                          }
                        }}
                      >
                        {/* ... Grid item content for standard episodes ... */}
                        <div className="flex flex-col">
                          <div className="relative aspect-video w-full">
                            {ep.still_path && !shouldHide('episodeImages') ? (
                              (() => {
                                const imageUrl = `https://image.tmdb.org/t/p/original${ep.still_path}`;
                                const imageKey = `episode-s${selectedSeason || 'unknown'}-e${ep.episode_number}-still`;
                                const hasFailed = failedImages[imageKey];
                                const retryUrl = hasFailed ? `${imageUrl}?retry=${Date.now()}` : imageUrl;
                                return (
                                  <img
                                    src={hasFailed ? getSeasonFallbackSvg(t('details.season').toUpperCase()) : retryUrl}
                                    alt={ep.name || `Épisode ${ep.episode_number}`}
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      if (!hasFailed) {
                                        setFailedImages(prev => ({ ...prev, [imageKey]: true }));
                                      } else {
                                        e.currentTarget.src = getSeasonFallbackSvg(t('details.season').toUpperCase());
                                      }
                                    }}
                                    key={retryUrl}
                                  />
                                );
                              })()
                            ) : (
                              <div className="w-full h-full bg-white/5 flex items-center justify-center min-h-[150px]">
                                {shouldHide('episodeImages') ? (
                                  <div className="flex flex-col items-center gap-2 text-gray-400">
                                    <EyeOff className="w-8 h-8" />
                                    <span className="text-sm">{t('details.imageMasked')}</span>
                                  </div>
                                ) : (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-tv h-8 w-8 text-white opacity-20"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>
                                )}
                              </div>
                            )}
                            {(() => {
                              const today = new Date();
                              const airDate = ep.air_date ? new Date(ep.air_date) : null;
                              if (airDate && airDate > today) {
                                return <div className="absolute top-2 left-2 bg-yellow-600 text-white text-xs px-2 py-1 rounded-full">{t('details.upcomingBadge')}</div>;
                              } else if (airDate) {
                                return <div className="absolute top-2 left-2 bg-green-600 text-white text-xs px-2 py-1 rounded-full">{t('details.releasedBadge')}</div>;
                              }
                              return null;
                            })()}

                            {/* Progress badges */}
                            {((isEpisodeWatched) || (hasProgress && displayProgress >= 95)) ? (
                              <span className="px-3 py-1.5 absolute top-2 right-2 rounded-lg whitespace-nowrap text-xs font-medium flex gap-1 items-center bg-green-500 text-green-900">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" aria-hidden="true" className="w-3.5 h-3.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                                </svg>
                                {t('details.alreadyWatched')}
                              </span>
                            ) : (hasProgress && displayProgress > 0 && displayProgress < 95 && (
                              <span className="px-3 py-1.5 absolute top-2 right-2 rounded-lg whitespace-nowrap text-xs font-medium flex gap-1 items-center bg-yellow-500 text-yellow-900">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" aria-hidden="true" className="w-3.5 h-3.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                                </svg>
                                {t('details.currentlyWatching')}
                              </span>
                            ))}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                              <div className="absolute inset-0 flex items-center justify-center">
                                <div className="bg-red-600/90 rounded-full p-3 transform scale-0 group-hover:scale-100 transition-transform duration-300">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-play h-6 w-6 text-white"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
                                </div>
                              </div>
                            </div>

                            {/* Add progress bar */}
                            {displayProgress > 0 && (
                              <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-700">
                                <div
                                  className={`h-full ${displayProgress >= 95 ? 'bg-green-500' : 'bg-red-600'} transition-all`}
                                  style={{ width: `${displayProgress}%` }}
                                />
                              </div>
                            )}

                          </div>
                          <div className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h4 className="text-lg font-medium group-hover:text-red-500 transition-colors">
                                  {shouldHide('episodeNames') ? getMaskedContent(ep.name, 'episodeNames', undefined, ep.episode_number) : `${ep.episode_number}. ${ep.name}`}
                                </h4>
                                <div className="flex items-center gap-3 mt-1 text-sm text-white/60">
                                  <div className="flex items-center gap-1.5">
                                    <Calendar className="h-3.5 w-3.5 text-red-400 opacity-70" />
                                    <span>{ep.air_date ? new Date(ep.air_date).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }) : t('details.dateUnknown')}</span>
                                  </div>
                                  {ep.runtime && (
                                    <div className="flex items-center gap-1.5">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-clock h-3.5 w-3.5 text-red-400 opacity-70"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                      <span>{Math.floor(ep.runtime / 60)}h {ep.runtime % 60}m</span>
                                    </div>
                                  )}
                                </div>
                                {ep.overview && (
                                  <div className="mt-2 relative">
                                    <motion.div
                                      layout
                                      initial={{ height: "2.5rem" }}
                                      animate={{
                                        height: expandedCards[`s${selectedSeason}e${ep.episode_number}`] ? "auto" : "2.5rem"
                                      }}
                                      transition={{
                                        type: "spring",
                                        stiffness: 300,
                                        damping: 30
                                      }}
                                      className="overflow-hidden"
                                    >
                                      <p className={`text-sm text-white/70`}>
                                        {shouldHide('episodeOverviews') ? getMaskedContent(ep.overview, 'episodeOverviews') : ep.overview}
                                      </p>
                                    </motion.div>
                                    <AnimatePresence mode="wait">
                                      <motion.button
                                        key={expandedCards[`s${selectedSeason}e${ep.episode_number}`] ? "moins" : "plus"}
                                        initial={{ opacity: 0.8 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        onClick={toggleCardExpansion(`s${selectedSeason}e${ep.episode_number}`)}
                                        className="text-xs text-red-400 hover:text-red-300 mt-1 flex items-center"
                                      >
                                        {expandedCards[`s${selectedSeason}e${ep.episode_number}`] ? (
                                          <>
                                            {t('details.seeLess')}
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 h-3 w-3"><polyline points="18 15 12 9 6 15"></polyline></svg>
                                          </>
                                        ) : (
                                          <>
                                            {t('details.seeMore')}
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 h-3 w-3"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                          </>
                                        )}
                                      </motion.button>
                                    </AnimatePresence>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-2 mt-3 justify-end">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (watchStatus && watchStatus.episodeWatchlist) {
                                    updateWatchStatus('episodeWatchlist', !watchStatus.episodeWatchlist[episodeKey], episodeKey);
                                  }
                                }}
                                className={`p-2 rounded ${watchStatus?.episodeWatchlist?.[episodeKey] ? 'text-red-600' : 'text-gray-400'} hover:bg-gray-800`}
                                title={t('details.addToWatchlistTitle')}
                              >
                                <List className="w-4 h-4" />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (watchStatus && watchStatus.episodeWatched) {
                                    updateWatchStatus('episodeWatched', !watchStatus.episodeWatched[episodeKey], episodeKey);
                                  }
                                }}
                                className={`p-2 rounded ${watchStatus?.episodeWatched?.[episodeKey] ? 'text-red-600' : 'text-gray-400'} hover:bg-gray-800`}
                                title={t('details.markAsWatched')}
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              {(() => {
                                const today = new Date();
                                const airDate = ep.air_date ? new Date(ep.air_date) : null;
                                // Only show AlertButton for upcoming episodes
                                if (airDate && airDate > today && id && tvShow?.name) {
                                  return (
                                    <AlertButton
                                      showId={id}
                                      showName={tvShow.name}
                                      season={selectedSeason!}
                                      episode={ep.episode_number}
                                      episodeName={ep.name}
                                      airDate={ep.air_date}
                                    />
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                }
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  };
  const tvYear = tvShow.first_air_date && !isNaN(new Date(tvShow.first_air_date).getTime())
    ? new Date(tvShow.first_air_date).getFullYear()
    : null;
  const tvTitle = tvYear ? `${tvShow.name} (${tvYear}) - Movix` : `${tvShow.name} - Movix`;
  const tvCanonicalUrl = buildSiteUrl(`/tv/${encodedId || id}`);
  const tvSocialImage = tvShow.backdrop_path || tvShow.poster_path
    ? `https://image.tmdb.org/t/p/original${tvShow.backdrop_path || tvShow.poster_path}`
    : undefined;
  const tvDescription = tvShow.overview?.trim() || `Découvrez ${tvShow.name} sur Movix.`;

  return (
    <MotionConfig reducedMotion="user">
      <SEO
        title={tvTitle}
        description={tvDescription}
        ogType="video.tv_show"
        ogUrl={tvCanonicalUrl}
        ogImage={tvSocialImage}
        canonical={tvCanonicalUrl}
      />
      {/* Page backdrop — own compositing layer (position:fixed) instead of
          backgroundAttachment:fixed, which forces full-page re-rasterization
          on every scroll frame and tanks FPS on heavy details pages. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-0 pointer-events-none bg-black"
        style={backdropImage ? {
          backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.9)), url(${backdropImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          willChange: 'transform',
          transform: 'translateZ(0)',
        } : undefined}
      />
      <div className="relative z-10 min-h-screen">
        <style>{`
        /* Netflix-style poster hover effects - COPIED FROM MovieDetails.tsx */
        .content-row-container {
          padding: 5px 0px 40px 0px;
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
          margin: 0 -0.5rem -5rem -0.5rem;
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
        @keyframes fadeInTitle {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes expandWidth {
          0% { width: 0; }
          100% { width: 40px; }
        }
        
        /* Styles pour no-scroll (copié de MovieDetails) */
        .no-scroll {
          overflow: hidden !important; /* Cache TOUT overflow, pas seulement horizontal */
          pointer-events: none !important; /* Désactive TOUS les événements de souris sur le conteneur */
          touch-action: none !important; /* Désactive les événements tactiles */
          user-select: none !important; /* Empêche la sélection de texte */
          isolation: isolate; /* Crée un nouveau contexte d'empilement */
        }
        /* Réactiver uniquement pour les enfants directs (les poster-container) */
        .no-scroll > * {
          pointer-events: auto !important;
        }
        
      `}</style>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="text-white px-4 md:px-8 lg:px-16 py-6"
      >
        {/* Header avec titre et année */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mb-8"
        >
          <h1 className="section-title text-4xl md:text-5xl font-bold">
            {tvShow.name} {tvShow.first_air_date && !isNaN(new Date(tvShow.first_air_date).getTime()) ? (
              <>({new Date(tvShow.first_air_date).getFullYear()}){' '}
                {new Date(tvShow.first_air_date) > new Date() ? (
                  <span className="ml-2 text-sm font-medium bg-yellow-600 text-white px-2 py-1 rounded-md">{t('details.upcomingBadge')}</span>
                ) : (
                  <span className="ml-2 text-sm font-medium bg-green-600 text-white px-2 py-1 rounded-md">{t('details.releasedBadge')}</span>
                )}
              </>
            ) : (
              <span className="ml-2 text-sm font-medium bg-yellow-600 text-white px-2 py-1 rounded-md">{t('details.notReleasedBadge')}</span>
            )}
          </h1>
        </motion.div>
        {/* Contenu principal - poster à gauche, infos à droite */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Colonne gauche - Poster */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
          >
            <motion.img
              whileHover={{ scale: 1.03 }}
              transition={{ type: "spring", stiffness: 300, damping: 10 }}
              src={tvShow.poster_path ? `https://image.tmdb.org/t/p/original${tvShow.poster_path}` : DEFAULT_IMAGE}
              alt={tvShow.name}
              className="w-full rounded-lg shadow-lg"
            />
            {/* Boutons d'action en-dessous du poster */}
            <div className="mt-6">
              <WatchButtons />
              {/* Bouton pour basculer le mode anime + Note */}
              {isAnime() && (
                <div className="mt-4"> {/* Ajout d'un div pour grouper */}
                  <button
                    onClick={handleAnimeModeToggle}
                    disabled={loadingAnimeData}
                    className={`w-full px-3 py-2 text-sm font-medium rounded-md transition-all flex items-center justify-center ${animeMode
                      ? 'bg-purple-700 hover:bg-purple-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                      } ${loadingAnimeData ? 'cursor-wait opacity-70' : ''}`}
                  >
                    {animeMode ? (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>
                        {t('details.standardMode')}
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5"><path d="M22 8.5c0-.28-.22-.5-.5-.5h-3.8l-1.65-3.29a.5.5 0 0 0-.9 0L13.5 8h-3a.5.5 0 0 0-.4.8l2.1 2.8-1 4.17a.5.5 0 0 0 .76.53L16 13.96l4.04 2.33a.5.5 0 0 0 .76-.53l-1-4.17 2.1-2.8a.5.5 0 0 0 .1-.3z" /></svg>
                        {t('details.animeModeLabel')}
                      </>
                    )}
                  </button>
                  {animeMode && ( // Afficher la note seulement quand on est en mode ANIME
                    <p className="text-sm text-yellow-300 bg-yellow-900/40 p-3 rounded-md mt-3 text-center flex items-center justify-center gap-2 border border-yellow-700/50">
                      <AlertTriangle className="w-4 h-4 inline-block flex-shrink-0" />
                      <span>{t('details.standardModeAvailable')}</span>
                    </p>
                  )}
                </div>
              )}

            </div>
          </motion.div>
          {/* Colonne droite - Informations */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.4 }}
            className="md:col-span-2"
          >
            {/* Tabs */}
            <div className="relative">
              <div
                ref={tabsContainerRef}
                className="flex overflow-x-auto scrollbar-hide touch-pan-x border-b border-gray-700 mb-6"
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                  WebkitOverflowScrolling: 'touch'
                }}
                id="tabs-container"
              >
                <motion.button
                  onClick={() => setActiveTab('overview')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'overview' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.overviewTab')}
                  {activeTab === 'overview' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>
                <motion.button
                  onClick={() => setActiveTab('details')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'details' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.detailsTab')}
                  {activeTab === 'details' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>
                <motion.button
                  onClick={() => setActiveTab('videos')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'videos' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.videosTab')}
                  {activeTab === 'videos' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>

                <motion.button
                  onClick={() => setActiveTab('images')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'images' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.imagesTab')}
                  {activeTab === 'images' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>

                <motion.button
                  onClick={() => setActiveTab('cast')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'cast' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.castTab')}
                  {activeTab === 'cast' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>

                <motion.button
                  onClick={() => setActiveTab('crew')}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'crew' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {t('details.crewTab')}
                  {activeTab === 'crew' && (
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                      layoutId="activeTab"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.button>

                {/* Réservé à ce qu'AniList apporte : sur du live-action,
                    l'onglet Équipe et celui de Distribution disent déjà tout,
                    et un onglet de plus ne ferait que répéter. */}
                {hasCharactersTab && (
                  <motion.button
                    onClick={() => setActiveTab('characters')}
                    className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'characters' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                    whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                    whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                  >
                    {t('details.charactersTab')}
                    {activeTab === 'characters' && (
                      <motion.div
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600"
                        layoutId="activeTab"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                  </motion.button>
                )}

                {/* Bouton Commentaires (scroll vers la section) */}
                <motion.button
                  onClick={() => {
                    // Scroll vers les commentaires
                    commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="px-6 py-3 font-medium text-sm flex-shrink-0 text-gray-400 hover:text-white"
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                  whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    {t('details.commentsTab')}
                  </div>
                </motion.button>
              </div>
              {isTabsScrollable && (
                <div className="absolute right-0 top-0 h-full w-12 bg-gradient-to-l from-black to-transparent pointer-events-none flex items-center justify-end pr-2">
                  <motion.div
                    animate={{ opacity: [0.7, 1, 0.7] }}
                    transition={{ repeat: Infinity, duration: 1.5, repeatType: "reverse" }}
                  >
                    <ChevronRight className="w-5 h-5 text-gray-300 opacity-70" />
                  </motion.div>
                </div>
              )}
            </div>
            {/* Contenu des tabs */}
            <AnimatePresence>
              {activeTab === 'overview' ? (
                <motion.div
                  key="overview"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  {/* Synopsis */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                  >
                    <div className="mb-4">
                      <LikeDislikeButton
                        contentType="tv"
                        contentId={id || ''}
                        onStatsChange={setMovixVoteStats}
                      />
                    </div>

                    {/* TMDB Info Box */}
                    <div className="mb-6 p-4 border border-red-500/50 bg-red-500/10 rounded-lg flex gap-3 items-start">
                      <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div className="text-sm text-gray-300">
                        <p>
                          {t('details.tmdbInfoNote')}{' '}
                          <a
                            href={`https://www.themoviedb.org/tv/${id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-red-400 hover:text-red-300 underline"
                          >
                            TMDB
                          </a>
                          . {t('details.tmdbInfoDiffNote')}
                        </p>
                      </div>
                    </div>

                    <h2 className="text-xl font-bold mb-2">{t('details.synopsisTitle')}</h2>
                    <p className="text-gray-300">
                      {shouldHide('episodeOverviews')
                        ? getMaskedContent(tvShow.overview || t('details.noSynopsis'), 'episodeOverviews')
                        : (tvShow.overview || t('details.noSynopsis'))
                      }
                    </p>
                  </motion.div>
                  {/* Infos basiques */}
                  <motion.div
                    className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    {/* Nombre de saisons */}
                    <div>
                      <h3 className="text-lg font-semibold mb-2">{t('details.seasonsLabel')}</h3>
                      <p className="text-gray-300">{tvShow.number_of_seasons || 0}</p>
                    </div>
                    {/* Nombre d'épisodes */}
                    <div>
                      <h3 className="text-lg font-semibold mb-2">{t('details.episodesLabel')}</h3>
                      <p className="text-gray-300">{tvShow.number_of_episodes || 0}</p>
                    </div>
                    {/* Notes */}
                    <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <h3 className="text-lg font-semibold mb-2">{t('details.ratingLabel')}</h3>
                        <div className="flex items-center gap-2">
                          <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                          <p className="text-gray-300 text-lg font-bold">{tvShow.vote_average?.toFixed(1) || 'N/A'}<span className="text-sm font-normal text-gray-400">/10</span></p>
                        </div>
                      </div>

                      {movixRating != null && (
                        <div>
                          <h3 className="mb-2 flex items-center gap-2 text-lg font-semibold">
                            {t('details.movixRatingLabel')}
                            <button
                              type="button"
                              onClick={() => setShowMovixRatingInfo(true)}
                              aria-label={t('details.movixRatingInfoButtonLabel')}
                              title={t('details.movixRatingInfoButtonLabel')}
                              className="rounded-full text-gray-400 transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-red-500/70"
                            >
                              <Info className="h-4 w-4" />
                            </button>
                          </h3>
                          <div className="flex items-center gap-2">
                            <Star className="w-5 h-5 text-red-500 fill-red-500" />
                            <p className="text-gray-300 text-lg font-bold">{movixRating.toFixed(1)}<span className="text-sm font-normal text-gray-400">/10</span></p>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Genres */}
                    <div>
                      <h3 className="text-lg font-semibold mb-2">{t('details.genresLabel')}</h3>
                      <div className="flex flex-wrap gap-2">
                        {tvShow.genres?.map((genre, index) => (
                          <motion.div
                            key={genre.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.1 + index * 0.05 }}
                          >
                            <Link
                              to={`/genre/tv/${genre.id}`}
                              className="flex items-center gap-1 px-3 py-2 bg-gray-800 rounded-lg text-sm hover:bg-gray-700 transition-colors inline-block border border-gray-700 hover:border-gray-600"
                            >
                              <span className="w-2 h-2 rounded-full bg-red-500"></span>
                              {genre.name}
                            </Link>
                          </motion.div>
                        ))}
                      </div>


                    </div>
                    {/* Classification par âge */}
                    <div>
                      <h3 className="text-lg font-semibold mb-2">{t('details.classificationLabel')}</h3>
                      <div className="flex items-center gap-2">
                        {certifications['FR'] ? (
                          <span className="bg-red-600/70 text-white px-3 py-1 rounded-md font-bold">
                            {getClassificationLabel(certifications['FR'], t)}
                          </span>
                        ) : certifications['US'] ? (
                          <span className="bg-red-600/70 text-white px-3 py-1 rounded-md font-bold">
                            {getClassificationLabel(certifications['US'], t)}
                          </span>
                        ) : (
                          <span className="text-gray-400">{t('details.notClassified')}</span>
                        )}
                      </div>
                    </div>
                  </motion.div>


                  {/* Saisons et épisodes */}
                  <motion.div
                    ref={seasonsSectionRef}
                    className="mb-6 seasons-section"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                  >
                    <h3 className="text-xl font-bold mb-4">{t('details.seasonsLabel')}</h3>

                    {/* Grid of seasons with animations */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
                      <AnimatePresence>
                        {animeMode && animeData?.seasons ? (
                          /* Affichage des saisons pour les animes */
                          animeData.seasons.map((season: any, index: number) => {
                            const seasonNumber = season.number || (index + 1);
                            return (
                              <motion.div
                                key={`anime-season-${seasonNumber}`}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ duration: 0.3, delay: index * 0.05 }}
                                className={`group cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 bg-gray-900 ${selectedSeason === seasonNumber ? 'border-red-600' : 'border-gray-800 hover:border-red-500'}`}
                                onClick={() => handleSeasonChange(seasonNumber)}
                                whileHover={{ y: -5 }}
                              >
                                <div className="relative pb-[150%] bg-gray-900">
                                  {!shouldHide('seasonImages') ? (
                                    <div className="absolute inset-0 w-full h-full bg-gradient-to-tr from-purple-900 to-indigo-800 flex items-center justify-center p-4">
                                      <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')]"></div>
                                      <div className="text-center z-10">
                                        <div className="w-16 h-16 mx-auto mb-2 rounded-full bg-white/10 flex items-center justify-center">
                                          <span className="text-2xl font-bold text-white">{seasonNumber}</span>
                                        </div>
                                        {/* Nom de la saison dans l'image retiré */}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="absolute inset-0 w-full h-full bg-gray-800 flex items-center justify-center">
                                      <div className="flex flex-col items-center gap-2 text-gray-400">
                                        <EyeOff className="w-12 h-12" />
                                        <span className="text-sm">{t('details.imageMasked')}</span>
                                      </div>
                                    </div>
                                  )}
                                  {/* Gradient retiré si nécessaire ou laissé pour l'esthétique */}
                                  {/* <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3">
                          <h3 className="text-base font-bold text-white line-clamp-2">{season.name}</h3>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-gray-400 ml-auto">{season.episodes.length} épisodes</span>
                          </div>
                        </div> */}
                                  {selectedSeason === seasonNumber && (
                                    <div className="absolute top-2 right-2 bg-red-600 text-white text-xs px-2 py-1 rounded-full">{t('details.currentSeasonBadge')}</div>
                                  )}
                                </div>
                                {/* Nom complet de la saison affiché en dessous pour les animes */}
                                <div className="p-3 bg-gray-900">
                                  <h3 className="text-base font-bold text-white">
                                    {shouldHide('episodeNames') ? getMaskedContent(season.name, 'episodeNames') : season.name}
                                  </h3>
                                  <span className="text-xs text-gray-400 mt-1 block">{season.episodes.length} {t('details.episodes')}</span>
                                </div>
                              </motion.div>
                            );
                          })
                        ) : (
                          /* Affichage standard des saisons pour les séries non-anime */
                          [...(tvShow.seasons ?? [])]
                            .filter((sm) => !(String(id) === '71446' && sm.season_number === 1))
                            .sort((a, b) => a.season_number - b.season_number)
                            .map((seasonMeta) => {
                            const season = seasonMeta.season_number;
                            const details = seasonsDetails[season] || seasonMeta;
                            const imageUrl = details?.poster_path ? `https://image.tmdb.org/t/p/original${details.poster_path}` : getSeasonFallbackSvg(t('details.season').toUpperCase());
                            const imageKey = `season-${season}-poster`;
                            const hasFailed = failedImages[imageKey];
                            const retryUrl = hasFailed ? `${imageUrl}?retry=${Date.now()}` : imageUrl;

                            return (
                              <motion.div
                                key={season}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ duration: 0.3 }}
                                className={`group cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 ${selectedSeason === season ? 'border-red-600' : 'border-gray-800 hover:border-red-500'}`}
                                onClick={() => handleSeasonChange(season)}
                                whileHover={{ y: -5 }}
                              >
                                <div className="relative pb-[150%] bg-gray-900">
                                  {!shouldHide('seasonImages') ? (
                                    <img
                                      src={hasFailed ? getSeasonFallbackSvg(t('details.season').toUpperCase()) : retryUrl}
                                      alt={details?.name || `${t('details.season')} ${season}`}
                                      className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                      onError={(e) => {
                                        if (!hasFailed) {
                                          setFailedImages(prev => ({ ...prev, [imageKey]: true }));
                                        } else {
                                            e.currentTarget.src = getSeasonFallbackSvg(t('details.season').toUpperCase());
                                        }
                                      }}
                                      key={retryUrl}
                                    />
                                  ) : (
                                    <div className="absolute inset-0 w-full h-full bg-gray-800 flex items-center justify-center">
                                      <div className="flex flex-col items-center gap-2 text-gray-400">
                                        <EyeOff className="w-12 h-12" />
                                        <span className="text-sm">{t('details.imageMasked')}</span>
                                      </div>
                                    </div>
                                  )}
                                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3">
                                    <h3 className="text-base font-bold text-white line-clamp-2">
                          {shouldHide('episodeNames') ? getMaskedContent(getSeasonDisplayName(season, id, t, details?.name), 'episodeNames') : getSeasonDisplayName(season, id, t, details?.name)}
                                    </h3>
                                    <div className="flex items-center gap-2 mt-1">
                                      <span className="text-xs text-gray-300">{details?.air_date ? new Date(details.air_date).getFullYear() : ''}</span>
                                      <span className="text-xs text-gray-400 ml-auto">{details?.episodes?.length ?? details?.episode_count ?? 0} {t('details.episodes')}</span>
                                    </div>
                                  </div>
                                  {selectedSeason === season && (
                                    <div className="absolute top-2 right-2 bg-red-600 text-white text-xs px-2 py-1 rounded-full">{t('details.currentSeasonBadge')}</div>
                                  )}
                                </div>
                              </motion.div>
                            );
                          })
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Episodes grid with animations */}
                    <AnimatePresence mode="wait">
                      {selectedSeason !== null && (
                        <motion.div
                          key={`season-${selectedSeason}`}
                          ref={episodesSectionRef}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.4 }}
                          className="w-full episodes-section"
                        >
                          {/* AnimatePresence pour la transition anime/standard */}
                          <AnimatePresence mode="wait">
                            {animeMode && animeData?.seasons ? (
                              <motion.div
                                key="anime-view"
                                initial={{ opacity: 0, y: -10 }} // Départ légèrement au-dessus
                                animate={{ opacity: 1, y: 0 }}   // Arrivée à la position normale
                                exit={{ opacity: 0, y: 10 }}    // Sortie légèrement vers le bas
                                transition={{ duration: 0.3 }}
                              >
                                {/* Toggle Button (toujours affiché) */}
                                {(() => {
                                  const currentSeason = animeData.seasons.find((s: any) => (s.number || (animeData.seasons.indexOf(s) + 1)) === selectedSeason);
                                  return currentSeason?.episodes?.length > 0;
                                })() && (
                                    <div className="flex justify-start mb-4"> {/* Alignement à gauche */}
                                      <button
                                        ref={dropdownToggleButtonRef}
                                        className="px-4 py-2 rounded-lg font-medium bg-gray-800 hover:bg-gray-700 text-white dropdown-toggle-button"
                                        onClick={() => {
                                          const currentSeason = animeData.seasons.find((s: any) => (s.number || (animeData.seasons.indexOf(s) + 1)) === selectedSeason);
                                          const currentDefault = getDefaultDropdownMode(currentSeason?.episodes?.length || 0);
                                          setDropdownMode((prev) => prev !== null ? !prev : !currentDefault);
                                        }}
                                      >
                                        {(() => {
                                          const currentSeason = animeData.seasons.find((s: any) => (s.number || (animeData.seasons.indexOf(s) + 1)) === selectedSeason);
                                          const currentDefault = getDefaultDropdownMode(currentSeason?.episodes?.length || 0);
                                          const currentMode = dropdownMode !== null ? dropdownMode : currentDefault;
                                          return currentMode ? t('details.showEpisodeGrid') : t('details.showDropdown');
                                        })()}
                                      </button>
                                    </div>
                                  )}
                                {/* Render Dropdown or Grid */}
                                {(() => {
                                  const currentSeason = animeData.seasons.find((s: any) => (s.number || (animeData.seasons.indexOf(s) + 1)) === selectedSeason);
                                  return renderEpisodes(currentSeason?.episodes || [], 'anime');
                                })()}
                              </motion.div>
                            ) : (
                              <motion.div
                                key="standard-view"
                                initial={{ opacity: 0, y: -10 }} // Départ légèrement au-dessus
                                animate={{ opacity: 1, y: 0 }}   // Arrivée à la position normale
                                exit={{ opacity: 0, y: 10 }}    // Sortie légèrement vers le bas
                                transition={{ duration: 0.3 }}
                              >
                                {/* Toggle Button (toujours affiché) */}
                                {(seasonsDetails[selectedSeason]?.episodes?.length > 0) && (
                                  <div className="flex justify-start mb-4"> {/* Alignement à gauche */}
                                    <button
                                      ref={dropdownToggleButtonRef}
                                      className="px-4 py-2 rounded-lg font-medium bg-gray-800 hover:bg-gray-700 text-white dropdown-toggle-button"
                                      onClick={() => {
                                        const currentDefault = getDefaultDropdownMode(seasonsDetails[selectedSeason]?.episodes?.length || 0);
                                        setDropdownMode((prev) => prev !== null ? !prev : !currentDefault);
                                      }}
                                    >
                                      {(() => {
                                        const currentDefault = getDefaultDropdownMode(seasonsDetails[selectedSeason]?.episodes?.length || 0);
                                        const currentMode = dropdownMode !== null ? dropdownMode : currentDefault;
                                        return currentMode ? t('details.showEpisodeGrid') : t('details.showDropdown');
                                      })()}
                                    </button>
                                  </div>
                                )}
                                {/* Render Dropdown or Grid */}
                                {renderEpisodes(seasonsDetails[selectedSeason]?.episodes || [], 'standard')}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                </motion.div>
              ) : activeTab === 'cast' ? (
                <motion.div
                  key="cast"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <h3 className="text-lg font-semibold mb-4">{t('details.castTab')}</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {cast.map((actor, index) => (
                      <motion.div
                        key={actor.id}
                        className="flex items-center gap-3 p-2 rounded-lg cursor-pointer"
                        onClick={() => navigate(`/person/${actor.id}`)}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 + index * 0.05 }}
                        whileHover={{
                          backgroundColor: "rgba(255,255,255,0.05)",
                          scale: 1.02,
                          transition: { duration: 0.2 }
                        }}
                      >
                        {actor.profile_path ? (
                          <motion.img
                            src={`https://image.tmdb.org/t/p/original${actor.profile_path}`}
                            alt={actor.name}
                            className="w-12 h-12 rounded-full object-cover"
                            whileHover={{ scale: 1.1 }}
                          />
                        ) : (
                          <motion.div
                            className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-lg"
                            style={{ backgroundColor: `hsl(${actor.name.charCodeAt(0) * 7 % 360}, 50%, 40%)` }}
                            whileHover={{ scale: 1.1 }}
                          >
                            {actor.name.charAt(0).toUpperCase()}
                          </motion.div>
                        )}
                        <div>
                          <p className="font-medium">{actor.name}</p>
                          <p className="text-sm text-gray-400">{actor.character || t('details.actorRole')}</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              ) : activeTab === 'characters' ? (
                <motion.div
                  key="characters"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <CharactersSection data={characters} loading={charactersLoading} />
                </motion.div>
              ) : activeTab === 'crew' ? (
                <motion.div
                  key="crew"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <h3 className="text-lg font-semibold mb-4">{t('details.crewTab')}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {crew.map((member, index) => (
                      <motion.div
                        key={member.id}
                        className="flex items-center gap-3 p-2 rounded-lg cursor-pointer"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 + index * 0.05 }}
                        whileHover={{
                          backgroundColor: "rgba(255,255,255,0.05)",
                          scale: 1.02,
                          transition: { duration: 0.2 }
                        }}
                        onClick={() => navigate(`/person/${member.id}`)}
                      >
                        {member.profile_path ? (
                          <motion.img
                            src={`https://image.tmdb.org/t/p/original${member.profile_path}`}
                            alt={member.name}
                            className="w-12 h-12 rounded-full object-cover"
                            whileHover={{ scale: 1.1 }}
                          />
                        ) : (
                          <motion.div
                            className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-lg"
                            style={{ backgroundColor: `hsl(${member.name.charCodeAt(0) * 7 % 360}, 50%, 40%)` }}
                            whileHover={{ scale: 1.1 }}
                          >
                            {member.name.charAt(0).toUpperCase()}
                          </motion.div>
                        )}
                        <div>
                          <p className="font-medium">{member.name}</p>
                          <p className="text-sm text-gray-400">{member.jobs.join(', ')}</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              ) : activeTab === 'details' ? (
                <motion.div
                  key="details"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  {/* Sociétés de production */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                  >
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Building className="w-5 h-5" />
                      {t('details.productionCompanies')}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {((tvShow as any).production_companies || []).length > 0 ? (
                        ((tvShow as any).production_companies || []).map((company: any, index: number) => (
                          <motion.div
                            key={company.id}
                            className="flex items-center gap-3 bg-gray-800 p-3 rounded-lg"
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 + index * 0.1 }}
                            whileHover={{
                              backgroundColor: "rgba(75,85,99, 0.8)",
                              y: -3,
                              transition: { duration: 0.2 }
                            }}
                          >
                            <motion.div
                              className="w-12 h-12 flex items-center justify-center bg-gray-700 rounded overflow-hidden"
                              whileHover={{ scale: 1.1 }}
                            >
                              {company.logo_path ? (
                                <img
                                  src={`https://image.tmdb.org/t/p/original${company.logo_path}`}
                                  alt={company.name}
                                  className="max-h-10 max-w-10"
                                />
                              ) : (
                                <Building className="w-6 h-6 text-gray-400" />
                              )}
                            </motion.div>
                            <span className="text-gray-200">{company.name}</span>
                          </motion.div>
                        ))
                      ) : (
                        <div className="col-span-2 text-gray-400 italic">{t('details.noProductionCompany')}</div>
                      )}
                    </div>
                  </motion.div>

                  {/* Pays d'origine */}
                  {((tvShow as any).origin_country || []).length > 0 && (
                    <motion.div
                      className="mb-6"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.5 }}
                    >
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <MapPin className="w-5 h-5" />
                        {t('details.originCountry')}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {((tvShow as any).origin_country || []).map((country: string, index: number) => (
                          <motion.div
                            key={country}
                            className="bg-gray-800 px-3 py-2 rounded-lg border border-gray-700"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.1 + index * 0.05 }}
                            whileHover={{
                              backgroundColor: "rgba(75,85,99, 0.8)",
                              y: -2,
                              borderColor: "rgba(107,114,128, 0.8)",
                              transition: { duration: 0.2 }
                            }}
                          >
                            {country}
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Langues */}
                  {((tvShow as any).spoken_languages || []).length > 0 && (
                    <motion.div
                      className="mb-6"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.6 }}
                    >
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <Languages className="w-5 h-5" />
                        {t('details.languagesLabel')}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {((tvShow as any).spoken_languages || []).map((lang: any, index: number) => (
                          <motion.div
                            key={lang.iso_639_1}
                            className="bg-gray-800 px-3 py-2 rounded-lg border border-gray-700"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.1 + index * 0.05 }}
                            whileHover={{
                              backgroundColor: "rgba(75,85,99, 0.8)",
                              y: -2,
                              borderColor: "rgba(107,114,128, 0.8)",
                              transition: { duration: 0.2 }
                            }}
                          >
                            {lang.name}
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Date de diffusion */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.7 }}
                  >
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Calendar className="w-5 h-5" />
                      {t('details.firstAirDateLabel')}
                    </h3>
                    <motion.div
                      className="bg-gray-800 px-3 py-2 rounded-lg inline-block border border-gray-700"
                      whileHover={{
                        backgroundColor: "rgba(75,85,99, 0.8)",
                        y: -2,
                        borderColor: "rgba(107,114,128, 0.8)",
                        transition: { duration: 0.2 }
                      }}
                    >
                      {tvShow.first_air_date && !isNaN(new Date(tvShow.first_air_date).getTime())
                        ? new Date(tvShow.first_air_date).toLocaleDateString(i18n.language, {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric'
                        })
                        : t('details.dateNotAvailable')
                      }
                    </motion.div>
                  </motion.div>

                  {/* Statistiques de production */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.8 }}
                  >
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                        <path d="M3 3v18h18" />
                        <path d="M18 9l-6-6-6 6" />
                        <path d="M6 10l6-6 2 2" />
                      </svg>
                      {t('details.statisticsTitle')}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Nombre de saisons */}
                      <motion.div
                        className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                        whileHover={{
                          backgroundColor: "rgba(75,85,99, 0.8)",
                          y: -2,
                          borderColor: "rgba(107,114,128, 0.8)",
                          transition: { duration: 0.2 }
                        }}
                      >
                        <h4 className="text-gray-400 text-sm mb-1">{t('details.numberOfSeasons')}</h4>
                        <p className="text-gray-200 font-semibold">
                          {tvShow.number_of_seasons || t('details.notAvailableData')}
                        </p>
                      </motion.div>

                      {/* Nombre d'épisodes */}
                      <motion.div
                        className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                        whileHover={{
                          backgroundColor: "rgba(75,85,99, 0.8)",
                          y: -2,
                          borderColor: "rgba(107,114,128, 0.8)",
                          transition: { duration: 0.2 }
                        }}
                      >
                        <h4 className="text-gray-400 text-sm mb-1">{t('details.numberOfEpisodes')}</h4>
                        <p className="text-gray-200 font-semibold">
                          {tvShow.number_of_episodes || t('details.notAvailableData')}
                        </p>
                      </motion.div>

                      {/* Popularité */}
                      {tvShow.popularity && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.popularityLabel')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {tvShow.popularity.toFixed(0)}
                          </p>
                        </motion.div>
                      )}

                      {/* Durée moyenne des épisodes */}
                      {tvShow.episode_run_time && tvShow.episode_run_time.length > 0 && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.averageDuration')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {tvShow.episode_run_time[0]} minutes
                          </p>
                        </motion.div>
                      )}

                      {/* Statut */}
                      {tvShow.status && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.statusLabel')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {tvShow.status === 'Returning Series' ? t('details.seriesOngoing') :
                              tvShow.status === 'Ended' ? t('details.ended') :
                                tvShow.status === 'Canceled' ? t('details.cancelled') :
                                  tvShow.status === 'In Production' ? t('details.inProductionStatus') :
                                    tvShow.status}
                            {tvShow.in_production === true && ` (${t('details.inProductionNote')})`}
                            {tvShow.in_production === false && tvShow.status !== 'Ended' && tvShow.status !== 'Canceled' && ` (${t('details.productionEndedNote')})`}
                          </p>
                        </motion.div>
                      )}

                      {/* Dernière diffusion */}
                      {tvShow.last_air_date && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.lastEpisodeAired')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {shouldHide('episodeNames') ? (
                              getMaskedContent(t('details.maskedInfo'), 'episodeNames')
                            ) : (
                              tvShow.last_episode_to_air ? (
                                <>
                                  S{tvShow.last_episode_to_air.season_number} E{tvShow.last_episode_to_air.episode_number} - {shouldHide('episodeNames') ? getMaskedContent(tvShow.last_episode_to_air.name, 'episodeNames', undefined, tvShow.last_episode_to_air.episode_number) : tvShow.last_episode_to_air.name}
                                  <span className="ml-2 text-gray-400 text-sm">
                                    ({new Date(tvShow.last_episode_to_air.air_date).toLocaleDateString(i18n.language)})
                                  </span>
                                </>
                              ) : (
                                new Date(tvShow.last_air_date).toLocaleDateString(i18n.language, {
                                  day: 'numeric',
                                  month: 'long',
                                  year: 'numeric'
                                })
                              )
                            )}
                          </p>
                        </motion.div>
                      )}

                      {/* Prochain épisode */}
                      {tvShow.next_episode_to_air && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.nextEpisodeLabel')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {shouldHide('episodeNames') ? (
                              getMaskedContent(t('details.maskedInfo'), 'episodeNames')
                            ) : (
                              <>
                                S{tvShow.next_episode_to_air.season_number} E{tvShow.next_episode_to_air.episode_number} - {shouldHide('episodeNames') ? getMaskedContent(tvShow.next_episode_to_air.name, 'episodeNames', undefined, tvShow.next_episode_to_air.episode_number) : tvShow.next_episode_to_air.name}
                                <span className="ml-2 text-gray-400 text-sm">
                                  ({new Date(tvShow.next_episode_to_air.air_date).toLocaleDateString(i18n.language)})
                                </span>
                              </>
                            )}
                          </p>
                        </motion.div>
                      )}
                    </div>
                  </motion.div>

                  {/* Statistiques financières */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.85 }}
                  >
                    <div className="flex justify-between items-center mb-3">
                      <h3 className="text-lg font-semibold flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                          <path d="M12 18V6" />
                        </svg>
                        {t('details.financialStatsTitle')}
                      </h3>
                      <motion.div
                        className="flex bg-gray-900 rounded-lg overflow-hidden border border-gray-700"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                      >
                        <button
                          className={`px-3 py-1 text-sm ${financialStatsMode === 'simple' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-400 hover:text-white'}`}
                          onClick={() => setFinancialStatsMode('simple')}
                        >
                          {t('details.simpleMode')}
                        </button>
                        <button
                          className={`px-3 py-1 text-sm ${financialStatsMode === 'advanced' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-400 hover:text-white'}`}
                          onClick={() => setFinancialStatsMode('advanced')}
                        >
                          {t('details.advancedMode')}
                        </button>
                      </motion.div>
                    </div>

                    {/* Informations globales - toujours visibles en mode simple */}
                    <div className="mb-4">
                      <h4 className="text-md font-medium mb-2 text-gray-300 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500"></span>
                        {t('details.globalLabel')}
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Coût estimé par épisode */}
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.estimatedCostPerEpisode')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {tvShow.type === 'Scripted' ? (
                              tvShow.networks?.some(n => ['HBO', 'Netflix', 'Amazon', 'Apple TV+', 'Disney+'].includes(n.name))
                                ? t('details.costRange5to15M')
                                : t('details.costRange1to5M')
                            ) : tvShow.type === 'Reality' ?
                              t('details.costRange100Kto500K') :
                              t('details.notAvailableData')
                            }
                          </p>
                        </motion.div>

                        {/* Budget total estimé */}
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.estimatedTotalBudget')}</h4>
                          <p className="text-gray-200 font-semibold">
                            {tvShow.number_of_episodes && tvShow.type === 'Scripted' ? (
                              tvShow.networks?.some(n => ['HBO', 'Netflix', 'Amazon', 'Apple TV+', 'Disney+'].includes(n.name))
                                ? `~ ${(10 * tvShow.number_of_episodes).toLocaleString(i18n.language)} millions USD`
                                : `~ ${(3 * tvShow.number_of_episodes).toLocaleString(i18n.language)} millions USD`
                            ) : tvShow.type === 'Reality' && tvShow.number_of_episodes ?
                              `~ ${(0.3 * tvShow.number_of_episodes).toLocaleString(i18n.language)} millions USD` :
                              t('details.notAvailableData')
                            }
                          </p>
                        </motion.div>

                        {/* Section des revenus - affichée différemment selon le mode */}
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.revenueAndProfits')}</h4>

                          {financialStatsMode === 'simple' ? (
                            <div className="bg-gray-900 p-2 rounded-lg">
                              <div className="flex justify-between items-center">
                                <span className="text-sm text-gray-300">{t('details.profitabilityStatus')}</span>
                                <span className={`text-sm font-semibold ${tvShow.number_of_seasons && tvShow.vote_average &&
                                  (
                                    (tvShow.vote_average >= 7.5 && tvShow.number_of_seasons >= 1) ||
                                    (tvShow.vote_average >= 6.5 && tvShow.number_of_seasons >= 2) ||
                                    (tvShow.number_of_seasons >= 3)
                                  ) ? 'text-green-400' : 'text-yellow-400'
                                  }`}>
                                  {tvShow.number_of_seasons && tvShow.vote_average &&
                                    (
                                      (tvShow.vote_average >= 7.5 && tvShow.number_of_seasons >= 1) ||
                                      (tvShow.vote_average >= 6.5 && tvShow.number_of_seasons >= 2) ||
                                      (tvShow.number_of_seasons >= 3)
                                    ) ? t('details.probablyProfitable') : t('details.uncertainProfitability')}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <>
                              {/* Sources de revenus - mode avancé seulement */}
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.3 }}
                                className="mb-3"
                              >
                                <p className="text-sm text-gray-300 mb-2">
                                  <span className="font-semibold">{t('details.revenueSources')}</span> {t('details.byImportanceOrder')}
                                </p>
                                <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1">
                                  <li>{t('details.broadcastingRightsInitial')} <span className="text-gray-400">{tvShow.networks?.some(n => ['HBO', 'Netflix', 'Amazon', 'Disney+'].includes(n.name)) ? t('details.tv.finance.budgetHigh') : t('details.tv.finance.budgetLow')}</span></li>
                                  <li>{t('details.advertisingRevenue')} <span className="text-gray-400">{tvShow.networks?.some(n => ['NBC', 'CBS', 'ABC', 'FOX'].includes(n.name)) ? t('details.tv.finance.adRevenueHigh') : t('details.tv.finance.adRevenueVariable')}</span></li>
                                  <li>{t('details.internationalSales')} <span className="text-gray-400">{t('details.tv.finance.marketing')}</span></li>
                                  <li>{t('details.tv.finance.streamingLabel')} <span className="text-gray-400">{t('details.tv.finance.streaming')}</span></li>
                                  <li>{t('details.merchandisingLabel')} <span className="text-gray-400">{tvShow.popularity && tvShow.popularity > 100 ? t('details.potentiallyVeryHigh') : t('details.limited')}</span></li>
                                </ul>
                              </motion.div>

                              {/* Estimations de bénéfices - mode avancé seulement */}
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.3 }}
                                className="mb-3"
                              >
                                <p className="text-sm text-gray-300 mb-2">
                                  <span className="font-semibold">{t('details.profitabilityEstimate')}</span> {t('details.tv.finance.forShow', { name: tvShow.name })}
                                </p>

                                <div className="bg-gray-900 p-2 rounded-lg mb-2">
                                  <div className="flex justify-between items-center mb-1">
                                    <span className="text-xs text-gray-400">{t('details.breakEvenEstimate')}</span>
                                    <span className="text-xs font-semibold text-gray-300">
                                      {tvShow.vote_average >= 7.5 ? t('details.breakEven1to2') :
                                        tvShow.vote_average >= 6.5 ? t('details.breakEven2to3') :
                                          t('details.breakEven3plus')}
                                    </span>
                                  </div>

                                  <div className="flex justify-between items-center mb-1">
                                    <span className="text-xs text-gray-400">{t('details.potentialROI')}</span>
                                    <span className="text-xs font-semibold text-gray-300">
                                      {tvShow.vote_average >= 8 ? '200-400%' :
                                        tvShow.vote_average >= 7 ? '100-200%' :
                                          tvShow.vote_average >= 6 ? '30-100%' :
                                            'Incertain'}
                                    </span>
                                  </div>

                                  <div className="flex justify-between items-center">
                                    <span className="text-xs text-gray-400">{t('details.currentProfitabilityStatus')}</span>
                                    <span className={`text-xs font-semibold ${tvShow.number_of_seasons && tvShow.vote_average &&
                                      (
                                        (tvShow.vote_average >= 7.5 && tvShow.number_of_seasons >= 1) ||
                                        (tvShow.vote_average >= 6.5 && tvShow.number_of_seasons >= 2) ||
                                        (tvShow.number_of_seasons >= 3)
                                      ) ? 'text-green-400' : 'text-yellow-400'
                                      }`}>
                                      {tvShow.number_of_seasons && tvShow.vote_average &&
                                        (
                                          (tvShow.vote_average >= 7.5 && tvShow.number_of_seasons >= 1) ||
                                          (tvShow.vote_average >= 6.5 && tvShow.number_of_seasons >= 2) ||
                                          (tvShow.number_of_seasons >= 3)
                                        ) ? t('details.probablyProfitable') : t('details.uncertainProfitability')}
                                    </span>
                                  </div>
                                </div>
                              </motion.div>

                              {/* Facteurs de succès - mode avancé seulement */}
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                              >
                                <p className="text-sm text-gray-300 mb-2">
                                  <span className="font-semibold">{t('details.factorsImpacting')}</span>
                                </p>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="bg-gray-900 p-2 rounded-lg">
                                    <h5 className="text-xs font-medium text-green-400 mb-1">{t('details.positiveFactors')}</h5>
                                    <ul className="list-disc pl-4 text-xs text-gray-300 space-y-0.5">
                                      <li>{t('details.highRating')} ({tvShow.vote_average}/10)</li>
                                      <li>{t('details.popularityFactor')} ({tvShow.popularity?.toFixed(0)})</li>
                                      {tvShow.networks?.some(n => ['HBO', 'Netflix', 'Amazon', 'Apple TV+', 'Disney+'].includes(n.name)) &&
                                        <li>{t('details.premiumBroadcaster')}</li>
                                      }
                                      {tvShow.in_production &&
                                        <li>{t('details.stillInProduction')}</li>
                                      }
                                    </ul>
                                  </div>
                                  <div className="bg-gray-900 p-2 rounded-lg">
                                    <h5 className="text-xs font-medium text-red-400 mb-1">{t('details.negativeFactors')}</h5>
                                    <ul className="list-disc pl-4 text-xs text-gray-300 space-y-0.5">
                                      {!tvShow.in_production &&
                                        <li>{t('details.productionEndedFactor')}</li>
                                      }
                                      {tvShow.status === 'Canceled' &&
                                        <li>{t('details.seriesCancelledFactor')}</li>
                                      }
                                      {tvShow.vote_average < 6.5 &&
                                        <li>{t('details.lowAverageRating')}</li>
                                      }
                                      {tvShow.popularity && tvShow.popularity < 50 &&
                                        <li>{t('details.limitedPopularity')}</li>
                                      }
                                    </ul>
                                  </div>
                                </div>

                                <p className="text-xs text-gray-400 italic mt-3">
                                  {t('details.financialNote')}
                                </p>
                              </motion.div>
                            </>
                          )}
                        </motion.div>
                      </div>
                    </div>

                    {/* Informations par saison - seulement visible en mode avancé */}
                    {financialStatsMode === 'advanced' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.3 }}
                        className="mb-4"
                      >
                        <h4 className="text-md font-medium mb-2 text-gray-300 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                          {t('details.perSeasonLabel')}
                        </h4>

                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <div className="grid grid-cols-3 gap-2 text-xs text-gray-400 border-b border-gray-700 pb-2 mb-2">
                            <div>{t('details.seasonsLabel')}</div>
                            <div>{t('details.episodesLabel')}</div>
                            <div>{t('details.estimatedBudgetLabel')}</div>
                          </div>
                          <div className="space-y-2 max-h-60 overflow-y-auto">
                            {Array.from({ length: tvShow.number_of_seasons || 0 }, (_, i) => i + 1).map(season => (
                              <div key={season} className="grid grid-cols-3 gap-2 text-sm">
                                <div className="text-gray-200">{getSeasonDisplayName(season, id, t, `${t('details.season')} ${season}`)}</div>
                                <div className="text-gray-200">
                                  {seasonsDetails[season]
                                    ? seasonsDetails[season].episodes.length
                                    : "N/A"}
                                </div>
                                <div className="text-gray-200">
                                  {tvShow.type === 'Scripted' ? (
                                    tvShow.networks?.some(n => ['HBO', 'Netflix', 'Amazon', 'Apple TV+', 'Disney+'].includes(n.name))
                                      ? `~${(10 * (seasonsDetails[season] ? seasonsDetails[season].episodes.length : 10)).toLocaleString(i18n.language)}M USD`
                                      : `~${(3 * (seasonsDetails[season] ? seasonsDetails[season].episodes.length : 10)).toLocaleString(i18n.language)}M USD`
                                  ) : tvShow.type === 'Reality' ?
                                    `~${(0.3 * (seasonsDetails[season] ? seasonsDetails[season].episodes.length : 10)).toLocaleString(i18n.language)}M USD` :
                                    'N/A'
                                  }
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="mt-2 text-xs text-gray-400 italic">
                            {t('details.seasonBudgetNote')}
                          </div>
                        </motion.div>
                      </motion.div>
                    )}

                    {/* Informations par épisode - seulement visible en mode avancé */}
                    {financialStatsMode === 'advanced' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.3 }}
                        className="mb-4"
                      >
                        <h4 className="text-md font-medium mb-2 text-gray-300 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-500"></span>
                          {t('details.perEpisodeLabel')}
                        </h4>

                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.budgetBreakdownPerEpisode')}</h4>
                          <div className="mt-3 space-y-3">
                            <div className="relative pt-1">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    {t('details.productionAndFilming')}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    50-60%
                                  </span>
                                </div>
                              </div>
                              <div className="overflow-hidden h-2 mt-1 text-xs flex rounded bg-gray-700">
                                <div style={{ width: "55%" }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-red-500"></div>
                              </div>
                            </div>

                            <div className="relative pt-1">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    {t('details.actors')}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    20-30%
                                  </span>
                                </div>
                              </div>
                              <div className="overflow-hidden h-2 mt-1 text-xs flex rounded bg-gray-700">
                                <div style={{ width: "25%" }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-blue-500"></div>
                              </div>
                            </div>

                            <div className="relative pt-1">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    {t('details.specialEffects')}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    5-15%
                                  </span>
                                </div>
                              </div>
                              <div className="overflow-hidden h-2 mt-1 text-xs flex rounded bg-gray-700">
                                <div style={{ width: "10%" }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-green-500"></div>
                              </div>
                            </div>

                            <div className="relative pt-1">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    {t('details.postProduction')}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs font-semibold inline-block text-gray-300">
                                    10-15%
                                  </span>
                                </div>
                              </div>
                              <div className="overflow-hidden h-2 mt-1 text-xs flex rounded bg-gray-700">
                                <div style={{ width: "12%" }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-yellow-500"></div>
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 text-xs text-gray-400 italic">
                            {t('details.vfxNote')}
                          </div>
                        </motion.div>
                      </motion.div>
                    )}

                  </motion.div>

                  {/* Networks/Diffuseurs */}
                  {tvShow.networks && tvShow.networks.length > 0 && (
                    <motion.div
                      className="mb-6"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.9 }}
                    >
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                          <polyline points="17 2 12 7 7 2" />
                        </svg>
                        {t('details.broadcastNetworks')}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                        {tvShow.networks.map((network, index) => (
                          <motion.div
                            key={network.id}
                            className="flex items-center gap-3 bg-gray-800 p-3 rounded-lg"
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 + index * 0.1 }}
                            whileHover={{
                              backgroundColor: "rgba(75,85,99, 0.8)",
                              y: -3,
                              transition: { duration: 0.2 }
                            }}
                          >
                            <motion.div
                              className="w-12 h-12 flex items-center justify-center bg-gray-700 rounded overflow-hidden"
                              whileHover={{ scale: 1.1 }}
                            >
                              {network.logo_path ? (
                                <img
                                  src={`https://image.tmdb.org/t/p/original${network.logo_path}`}
                                  alt={network.name}
                                  className="max-h-10 max-w-10"
                                />
                              ) : (
                                <Building className="w-6 h-6 text-gray-400" />
                              )}
                            </motion.div>
                            <span className="text-gray-200">{network.name}</span>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                  {/* En fin d'onglet Détails : thèmes, titres alternatifs et
                      mots-clés relèvent de la fiche technique, pas de la
                      galerie de personnages. */}
                  <DetailExtraMetadata
                    themes={characters?.themes ?? []}
                    alternateTitles={extraAlternateTitles}
                    keywords={extraKeywords}
                  />
                </motion.div>
              ) : activeTab === 'videos' ? (
                <motion.div
                  key="videos"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                      <Video className="w-5 h-5" />
                        {t('details.videosAndTrailers')}
                    </h3>

                    <motion.button
                      whileHover={{
                        scale: 1.05,
                        boxShadow: "0 10px 25px rgba(147, 51, 234, 0.3)"
                      }}
                      whileTap={{ scale: 0.95 }}
                      transition={{ type: "spring", stiffness: 400, damping: 17 }}
                      onClick={() => {
                        if (!showMultiLangView) {
                          fetchMultiLangVideos();
                        }
                        setShowMultiLangView(!showMultiLangView);
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium shadow-lg border transition-all duration-300 ${showMultiLangView
                        ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 border-red-500/20'
                        : 'bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 border-purple-500/20'
                        }`}
                    >
                      {showMultiLangView ? <ArrowLeft className="w-4 h-4" /> : <Languages className="w-4 h-4" />}
                      {showMultiLangView ? t('details.back') : t('details.multiLanguages')}
                    </motion.button>
                  </div>

                  {/* Section Vidéos Générales */}
                  {(loadingVideos || loadingMultiLangVideos) ? (
                    <div className="flex items-center justify-center h-40 w-full">
                      <Loader className="w-8 h-8 animate-spin text-red-600" />
                    </div>
                  ) : showMultiLangView ? (
                    // Vue multi-langues
                    multiLangVideos.length > 0 ? (
                      (() => {
                        // Grouper les vidéos par langue
                        const videosByLanguage = multiLangVideos.reduce((acc: any, video: any) => {
                          const lang = video.iso_639_1 || 'unknown';
                          if (!acc[lang]) acc[lang] = [];
                          acc[lang].push(video);
                          return acc;
                        }, {});

                        // Noms des langues
                        const languageNames: { [key: string]: string } = {
                          'fr': t('details.langFrench'),
                          'en': t('details.langEnglish'),
                          'es': t('details.langSpanish'),
                          'de': t('details.langGerman'),
                          'it': t('details.langItalian'),
                          'pt': t('details.langPortuguese'),
                          'ja': t('details.langJapanese'),
                          'ko': t('details.langKorean'),
                          'zh': t('details.langChinese'),
                          'ru': t('details.langRussian'),
                          'unknown': t('details.langUnknown')
                        };

                        return Object.entries(videosByLanguage).map(([langCode, videos]: [string, any]) => (
                          <div key={langCode} className="mb-8">
                            <h4 className="text-lg font-medium mb-4 text-purple-400 border-b border-gray-700 pb-2">
                              {languageNames[langCode] || langCode.toUpperCase()}
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                              {videos.map((video: any, videoIndex: number) => (
                                <motion.div
                                  key={video.id}
                                  className="group bg-gray-800/70 rounded-xl overflow-hidden border border-gray-700/50 hover:border-purple-500/30"
                                  initial={{ opacity: 0, y: 20, scale: 0.9 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  transition={{
                                    delay: videoIndex * 0.05,
                                    duration: 0.4,
                                    type: "spring",
                                    stiffness: 100
                                  }}
                                  whileHover={{
                                    y: -8,
                                    scale: 1.02,
                                    boxShadow: "0 20px 40px rgba(147, 51, 234, 0.15)",
                                    transition: { duration: 0.3 }
                                  }}
                                  whileTap={{ scale: 0.98 }}
                                >
                                  <div
                                    className="relative cursor-pointer aspect-video overflow-hidden"
                                    onClick={() => {
                                      setSelectedVideo(video);
                                      setShowVideoPopup(true);
                                    }}
                                  >
                                    <motion.img
                                      src={`https://img.youtube.com/vi/${video.key}/mqdefault.jpg`}
                                      alt={video.name}
                                      className="w-full h-full object-cover"
                                      whileHover={{ scale: 1.05 }}
                                      transition={{ duration: 0.3 }}
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                                    <motion.div
                                      className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition-colors"
                                      whileHover={{ backgroundColor: "rgba(0,0,0,0.1)" }}
                                    >
                                      <motion.div
                                        className="w-14 h-14 rounded-full bg-purple-600/90 flex items-center justify-center shadow-lg"
                                        whileHover={{
                                          scale: 1.1,
                                          backgroundColor: "rgba(147, 51, 234, 1)",
                                          boxShadow: "0 0 20px rgba(147, 51, 234, 0.5)"
                                        }}
                                        whileTap={{ scale: 0.9 }}
                                        transition={{ type: "spring", stiffness: 400, damping: 17 }}
                                      >
                                        <Play className="w-6 h-6 text-white ml-1" />
                                      </motion.div>
                                    </motion.div>
                                  </div>
                                  <motion.div
                                    className="p-4"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: videoIndex * 0.05 + 0.2 }}
                                  >
                                    <h4 className="font-semibold mb-2 line-clamp-1 text-white group-hover:text-purple-400 transition-colors">{video.name}</h4>
                                    <div className="flex items-center text-sm text-gray-400">
                                      <motion.span
                                        className="bg-gray-700/70 px-2 py-1 rounded-md mr-2 text-xs font-medium"
                                        whileHover={{ backgroundColor: "rgba(55, 65, 81, 1)" }}
                                      >
                                        {video.type}
                                      </motion.span>
                                      {video.size && <span className="text-xs">{video.size}p</span>}
                                    </div>
                                  </motion.div>
                                </motion.div>
                              ))}
                            </div>
                          </div>
                        ));
                      })()
                    ) : (
                      <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                        <Video className="w-8 h-8 mb-2" />
                        <p>{t('details.noMultiLangVideo')}</p>
                      </div>
                    )
                  ) : videos.length > 0 ? (
                    <div className="space-y-8 mb-10">
                      {/* Group general videos by type */}
                      {['Trailer', 'Teaser', 'Clip', 'Behind the Scenes', 'Featurette'].map(videoType => {
                        const filteredVideos = videos.filter((video: any) => video.type === videoType);
                        if (filteredVideos.length === 0) return null;

                        return (
                          <div key={videoType} className="mb-6">
                            {/* ... Rendu existant pour les types de vidéos générales ... */}
                            <h4 className="text-lg font-medium mb-4 border-b border-gray-700 pb-2">
                              {videoType === 'Trailer' ? t('details.videoTrailers') :
                                videoType === 'Teaser' ? 'Teasers' :
                                  videoType === 'Clip' ? t('details.videoClips') :
                                    videoType === 'Behind the Scenes' ? t('details.videoBehindScenes') :
                                      videoType === 'Featurette' ? t('details.videoMakingOf') : videoType}
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                              {filteredVideos.map((video: any, index: number) => (
                                <motion.div
                                  key={video.id || video.key}
                                  className="group bg-gray-800/70 rounded-xl overflow-hidden border border-gray-700/50 hover:border-red-500/30"
                                  initial={{ opacity: 0, y: 20, scale: 0.9 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  transition={{
                                    delay: index * 0.1,
                                    duration: 0.4,
                                    type: "spring",
                                    stiffness: 100
                                  }}
                                  whileHover={{
                                    y: -8,
                                    scale: 1.02,
                                    boxShadow: "0 20px 40px rgba(239, 68, 68, 0.15)",
                                    transition: { duration: 0.3 }
                                  }}
                                  whileTap={{ scale: 0.98 }}
                                >
                                  <div
                                    className="relative cursor-pointer aspect-video overflow-hidden"
                                    onClick={() => {
                                      setSelectedVideo(video);
                                      setShowVideoPopup(true);
                                    }}
                                  >
                                    <motion.img
                                      src={`https://img.youtube.com/vi/${video.key}/mqdefault.jpg`}
                                      alt={video.name}
                                      className="w-full h-full object-cover"
                                      whileHover={{ scale: 1.05 }}
                                      transition={{ duration: 0.3 }}
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                                    <motion.div
                                      className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition-colors"
                                      whileHover={{ backgroundColor: "rgba(0,0,0,0.1)" }}
                                    >
                                      <motion.div
                                        className="w-14 h-14 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg"
                                        whileHover={{
                                          scale: 1.1,
                                          backgroundColor: "rgba(239, 68, 68, 1)",
                                          boxShadow: "0 0 20px rgba(239, 68, 68, 0.5)"
                                        }}
                                        whileTap={{ scale: 0.9 }}
                                        transition={{ type: "spring", stiffness: 400, damping: 17 }}
                                      >
                                        <Play className="w-6 h-6 text-white ml-1" />
                                      </motion.div>
                                    </motion.div>
                                  </div>
                                  <motion.div
                                    className="p-4"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: index * 0.1 + 0.2 }}
                                  >
                                    <h4 className="font-semibold mb-2 line-clamp-1 text-white group-hover:text-red-400 transition-colors">{video.name}</h4>
                                    <div className="flex items-center text-sm text-gray-400">
                                      <motion.span
                                        className={`text-xs px-2 py-1 rounded-md mr-2 font-medium ${video.type === 'Trailer'
                                          ? 'bg-red-600/70 text-white'
                                          : video.type === 'Teaser'
                                            ? 'bg-blue-600/70 text-white'
                                            : video.type === 'Clip'
                                              ? 'bg-green-600/70 text-white'
                                              : 'bg-gray-700/70 text-gray-300'
                                          }`}
                                        whileHover={{ backgroundColor: video.type === 'Trailer' ? 'rgba(239, 68, 68, 0.9)' : undefined }}
                                      >
                                        {video.type === 'Trailer' ? t('details.videoTrailer') :
                                          video.type === 'Teaser' ? 'Teaser' :
                                            video.type === 'Clip' ? t('details.videoClip') :
                                              video.type === 'Behind the Scenes' ? t('details.videoBehindScenes') :
                                                video.type === 'Featurette' ? t('details.videoMakingOf') : video.type}
                                      </motion.span>
                                      {video.published_at && (
                                        <span className="text-xs">
                                          {new Date(video.published_at).toLocaleDateString(i18n.language)}
                                        </span>
                                      )}
                                    </div>
                                  </motion.div>
                                </motion.div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                      {/* ... Rendu pour les autres types de vidéos générales ... */}
                      {videos.filter((video: any) =>
                        !['Trailer', 'Teaser', 'Clip', 'Behind the Scenes', 'Featurette'].includes(video.type)
                      ).length > 0 && (
                          <div className="mb-6">
                            <h4 className="text-lg font-medium mb-4 border-b border-gray-700 pb-2">
                              {t('details.otherVideos')}
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              {videos
                                .filter((video: any) => !['Trailer', 'Teaser', 'Clip', 'Behind the Scenes', 'Featurette'].includes(video.type))
                                .map((video: any, index: number) => (
                                  <motion.div
                                    key={video.id || video.key}
                                    className="bg-gray-800 rounded-lg overflow-hidden cursor-pointer"
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.1 * index, duration: 0.3 }}
                                    whileHover={{
                                      y: -5,
                                      transition: { duration: 0.2 }
                                    }}
                                    onClick={() => {
                                      setSelectedVideo(video);
                                      setShowVideoPopup(true);
                                    }}
                                  >
                                    {/* ... Rendu carte vidéo ... */}
                                    <div className="aspect-w-16 aspect-h-9 relative">
                                      <img
                                        src={`https://img.youtube.com/vi/${video.key}/hqdefault.jpg`}
                                        alt={video.name}
                                        className="w-full h-full object-cover"
                                      />
                                      <div className="absolute inset-0 flex items-center justify-center">
                                        <div className="w-16 h-16 rounded-full bg-red-600/80 flex items-center justify-center">
                                          <Play className="w-8 h-8 text-white ml-1" />
                                        </div>
                                      </div>
                                    </div>
                                    <div className="p-4">
                                      <h4 className="font-medium mb-1">{video.name}</h4>
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300">
                                          {video.type}
                                        </span>
                                        {video.published_at && (
                                          <span className="text-xs text-gray-400">
                                            {new Date(video.published_at).toLocaleDateString(i18n.language)}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </motion.div>
                                ))}
                            </div>
                          </div>
                        )}
                    </div>
                  ) : loadingVideos ? (
                    <div className="flex items-center justify-center h-40 w-full">
                      <Loader className="w-8 h-8 animate-spin text-red-600" />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                      <Video className="w-8 h-8 mb-2" />
                      <p>{t('details.noGeneralVideoFound')}</p>
                    </div>
                  )}

                  {/* Section Vidéos par Saison */}
                  <h3 className="text-xl font-semibold mt-10 mb-6 border-t border-gray-700 pt-6">
                    {t('details.videosBySeason')}
                  </h3>
                  {loadingVideos ? (
                    <div className="flex items-center justify-center h-40 w-full">
                      <Loader className="w-8 h-8 animate-spin text-red-600" />
                    </div>
                  ) : availableSeasons.length > 0 ? (
                    availableSeasons.map(seasonNum => (
                      <div key={`season-videos-${seasonNum}`} className="mb-8">
                        <div className="flex items-center justify-between mb-6">
                        <h4 className="text-lg font-semibold">{getSeasonDisplayName(seasonNum, id, t, `${t('details.season')} ${seasonNum}`)}</h4>

                          <motion.button
                            whileHover={{
                              scale: 1.05,
                              boxShadow: "0 10px 25px rgba(147, 51, 234, 0.3)"
                            }}
                            whileTap={{ scale: 0.95 }}
                            transition={{ type: "spring", stiffness: 400, damping: 17 }}
                            onClick={() => {
                              if (!showSeasonMultiLangView[seasonNum]) {
                                fetchSeasonMultiLangVideos(seasonNum);
                              }
                              setShowSeasonMultiLangView(prev => ({
                                ...prev,
                                [seasonNum]: !prev[seasonNum]
                              }));
                            }}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium shadow-lg border transition-all duration-300 ${showSeasonMultiLangView[seasonNum]
                              ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 border-red-500/20'
                              : 'bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 border-purple-500/20'
                              }`}
                          >
                            {showSeasonMultiLangView[seasonNum] ? <ArrowLeft className="w-4 h-4" /> : <Languages className="w-4 h-4" />}
                            {showSeasonMultiLangView[seasonNum] ? t('details.back') : t('details.multiLanguages')}
                          </motion.button>
                        </div>

                        {(loadingVideos || loadingSeasonMultiLangVideos[seasonNum]) ? (
                          <div className="flex items-center justify-center h-40">
                            <Loader className="w-8 h-8 animate-spin text-red-600" />
                          </div>
                        ) : showSeasonMultiLangView[seasonNum] ? (
                          // Vue multi-langues pour cette saison
                          seasonMultiLangVideos[seasonNum] && seasonMultiLangVideos[seasonNum].length > 0 ? (
                            (() => {
                              // Grouper les vidéos par langue
                              const videosByLanguage = seasonMultiLangVideos[seasonNum].reduce((acc: any, video: any) => {
                                const lang = video.iso_639_1 || 'unknown';
                                if (!acc[lang]) acc[lang] = [];
                                acc[lang].push(video);
                                return acc;
                              }, {});

                              // Noms des langues
                              const languageNames: { [key: string]: string } = {
                                'fr': t('details.langFrench'),
                                'en': t('details.langEnglish'),
                                'es': t('details.langSpanish'),
                                'de': t('details.langGerman'),
                                'it': t('details.langItalian'),
                                'pt': t('details.langPortuguese'),
                                'ja': t('details.langJapanese'),
                                'ko': t('details.langKorean'),
                                'zh': t('details.langChinese'),
                                'ru': t('details.langRussian'),
                                'unknown': t('details.langUnknown')
                              };

                              return Object.entries(videosByLanguage).map(([langCode, videos]: [string, any]) => (
                                <div key={`${seasonNum}-${langCode}`} className="mb-8">
                                  <h5 className="text-md font-medium mb-4 text-purple-400 border-b border-gray-700 pb-2">
                                    {languageNames[langCode] || langCode.toUpperCase()}
                                  </h5>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {videos.map((video: any, videoIndex: number) => (
                                      <motion.div
                                        key={video.id}
                                        className="group bg-gray-800/70 rounded-xl overflow-hidden border border-gray-700/50 hover:border-purple-500/30"
                                        initial={{ opacity: 0, y: 20, scale: 0.9 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        transition={{
                                          delay: videoIndex * 0.05,
                                          duration: 0.4,
                                          type: "spring",
                                          stiffness: 100
                                        }}
                                        whileHover={{
                                          y: -8,
                                          scale: 1.02,
                                          boxShadow: "0 20px 40px rgba(147, 51, 234, 0.15)",
                                          transition: { duration: 0.3 }
                                        }}
                                        whileTap={{ scale: 0.98 }}
                                      >
                                        <div
                                          className="relative cursor-pointer aspect-video overflow-hidden"
                                          onClick={() => {
                                            setSelectedVideo(video);
                                            setShowVideoPopup(true);
                                          }}
                                        >
                                          <motion.img
                                            src={`https://img.youtube.com/vi/${video.key}/mqdefault.jpg`}
                                            alt={video.name}
                                            className="w-full h-full object-cover"
                                            whileHover={{ scale: 1.05 }}
                                            transition={{ duration: 0.3 }}
                                          />
                                          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                                          <motion.div
                                            className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition-colors"
                                            whileHover={{ backgroundColor: "rgba(0,0,0,0.1)" }}
                                          >
                                            <motion.div
                                              className="w-14 h-14 rounded-full bg-purple-600/90 flex items-center justify-center shadow-lg"
                                              whileHover={{
                                                scale: 1.1,
                                                backgroundColor: "rgba(147, 51, 234, 1)",
                                                boxShadow: "0 0 20px rgba(147, 51, 234, 0.5)"
                                              }}
                                              whileTap={{ scale: 0.9 }}
                                              transition={{ type: "spring", stiffness: 400, damping: 17 }}
                                            >
                                              <Play className="w-6 h-6 text-white ml-1" />
                                            </motion.div>
                                          </motion.div>
                                        </div>
                                        <motion.div
                                          className="p-4"
                                          initial={{ opacity: 0 }}
                                          animate={{ opacity: 1 }}
                                          transition={{ delay: videoIndex * 0.05 + 0.2 }}
                                        >
                                          <h4 className="font-semibold mb-2 line-clamp-1 text-white group-hover:text-purple-400 transition-colors">{video.name}</h4>
                                          <div className="flex items-center text-sm text-gray-400">
                                            <motion.span
                                              className="bg-gray-700/70 px-2 py-1 rounded-md mr-2 text-xs font-medium"
                                              whileHover={{ backgroundColor: "rgba(55, 65, 81, 1)" }}
                                            >
                                              {video.type}
                                            </motion.span>
                                            {video.size && <span className="text-xs">{video.size}p</span>}
                                          </div>
                                        </motion.div>
                                      </motion.div>
                                    ))}
                                  </div>
                                </div>
                              ));
                            })()
                          ) : (
                            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                              <Video className="w-8 h-8 mb-2" />
                              <p>{t('details.noMultiLangVideoForSeason', { season: seasonNum })}</p>
                            </div>
                          )
                        ) : (
                          // Vue normale pour cette saison
                          seasonVideos[seasonNum] && seasonVideos[seasonNum].length > 0 ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                              {seasonVideos[seasonNum].map((video: any, index: number) => (
                                <motion.div
                                  key={video.id || video.key}
                                  className="group bg-gray-800/70 rounded-xl overflow-hidden border border-gray-700/50 hover:border-red-500/30"
                                  initial={{ opacity: 0, y: 20, scale: 0.9 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  transition={{
                                    delay: index * 0.1,
                                    duration: 0.4,
                                    type: "spring",
                                    stiffness: 100
                                  }}
                                  whileHover={{
                                    y: -8,
                                    scale: 1.02,
                                    boxShadow: "0 20px 40px rgba(239, 68, 68, 0.15)",
                                    transition: { duration: 0.3 }
                                  }}
                                  whileTap={{ scale: 0.98 }}
                                >
                                  <div
                                    className="relative cursor-pointer aspect-video overflow-hidden"
                                    onClick={() => {
                                      setSelectedVideo(video);
                                      setShowVideoPopup(true);
                                    }}
                                  >
                                    <motion.img
                                      src={`https://img.youtube.com/vi/${video.key}/mqdefault.jpg`}
                                      alt={video.name}
                                      className="w-full h-full object-cover"
                                      whileHover={{ scale: 1.05 }}
                                      transition={{ duration: 0.3 }}
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                                    <motion.div
                                      className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition-colors"
                                      whileHover={{ backgroundColor: "rgba(0,0,0,0.1)" }}
                                    >
                                      <motion.div
                                        className="w-14 h-14 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg"
                                        whileHover={{
                                          scale: 1.1,
                                          backgroundColor: "rgba(239, 68, 68, 1)",
                                          boxShadow: "0 0 20px rgba(239, 68, 68, 0.5)"
                                        }}
                                        whileTap={{ scale: 0.9 }}
                                        transition={{ type: "spring", stiffness: 400, damping: 17 }}
                                      >
                                        <Play className="w-6 h-6 text-white ml-1" />
                                      </motion.div>
                                    </motion.div>
                                  </div>
                                  <motion.div
                                    className="p-4"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: index * 0.1 + 0.2 }}
                                  >
                                    <h4 className="font-semibold mb-2 line-clamp-1 text-white group-hover:text-red-400 transition-colors">{video.name}</h4>
                                    <div className="flex items-center text-sm text-gray-400">
                                      <motion.span
                                        className={`text-xs px-2 py-1 rounded-md mr-2 font-medium ${video.type === 'Trailer' ? 'bg-red-600/70 text-white' :
                                          video.type === 'Teaser' ? 'bg-blue-600/70 text-white' :
                                            video.type === 'Clip' ? 'bg-green-600/70 text-white' :
                                              'bg-gray-700/70 text-gray-300'
                                          }`}
                                        whileHover={{ backgroundColor: video.type === 'Trailer' ? 'rgba(239, 68, 68, 0.9)' : undefined }}
                                      >
                                        {video.type === 'Trailer' ? t('details.videoTrailer') :
                                          video.type === 'Teaser' ? 'Teaser' :
                                            video.type === 'Clip' ? t('details.videoClip') :
                                              video.type === 'Behind the Scenes' ? t('details.videoBehindScenes') :
                                                video.type === 'Featurette' ? t('details.videoMakingOf') : video.type}
                                      </motion.span>
                                      {video.published_at && (
                                        <span className="text-xs">
                                          {new Date(video.published_at).toLocaleDateString(i18n.language)}
                                        </span>
                                      )}
                                    </div>
                                  </motion.div>
                                </motion.div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-gray-500 italic ml-4">{t('details.noVideoForSeason', { season: seasonNum })}</p>
                          )
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                      <Video className="w-8 h-8 mb-2" />
                      <p>{t('details.noSeasonForVideos')}</p>
                    </div>
                  )}
                </motion.div>
              ) : activeTab === 'images' ? (
                <motion.div
                  key="images"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <TVImagesSection tvId={id!} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        </div>
      </motion.div>

      {/* Modal pour les vidéos */}
      {showVideoPopup && selectedVideo && (
        <AnimatePresence mode="wait">
          {!isClosingVideo && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/90 flex items-center justify-center p-2 sm:p-4 z-[100000]"
              onClick={handleCloseVideo}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="w-full max-w-6xl bg-gray-900 rounded-2xl overflow-hidden relative"
                onClick={e => e.stopPropagation()}
              >
                <div className="p-4 flex justify-between items-center border-b border-gray-800">
                  <h3 className="text-xl font-semibold text-white">{selectedVideo.name}</h3>
                  <motion.button
                    onClick={handleCloseVideo}
                    className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <X className="h-6 w-6" />
                  </motion.button>
                </div>
                <div className="aspect-w-16 aspect-h-9">
                  <iframe
                    src={`https://www.youtube.com/embed/${selectedVideo.key}?autoplay=1`}
                    title={selectedVideo.name}
                    className="w-full h-[300px] sm:h-[400px] md:h-[500px] lg:h-[600px]"
                    allowFullScreen
                    allow="autoplay"
                  ></iframe>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      <LazySection
        index={0}
        immediateLoadCount={0}
        rootMargin="300px"
        minHeight="320px"
        className="px-4 md:px-8 lg:px-16 mt-20 mb-20"
      >
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          {loadingSimilar ? (
            <motion.div
              className="flex items-center justify-center h-64 space-y-4 bg-black/50"
              animate={{
                backgroundColor: ["rgba(0,0,0,0.5)", "rgba(0,0,0,0.3)", "rgba(0,0,0,0.5)"]
              }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <motion.div
                animate={{
                  rotate: 360,
                  transition: { duration: 1, repeat: Infinity, ease: "linear" }
                }}
              >
                <Loader className="h-8 w-8" />
              </motion.div>
            </motion.div>
          ) : recommendations.length > 0 ? (
            <EmblaCarousel
              title={<span><span className="text-red-600 mr-2">🔥</span>{t('details.similarSeries')}</span>}
              items={recommendations.map(show => ({
                id: Number(show.id),
                title: show.name,
                name: show.name,
                poster_path: show.poster_path,
                backdrop_path: show.backdrop_path || '',
                overview: show.overview,
                vote_average: show.vote_average,
                first_air_date: show.first_air_date,
                media_type: 'tv',
              }))}
              mediaType="tv-similar"
            />
          ) : (
            <motion.p
              className="text-center text-gray-400"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              {t('details.noSimilarSeriesAvailable')}
            </motion.p>
          )}
        </motion.div>
      </LazySection>

      {/* Section Commentaires - Lazy loaded when approaching viewport.
          Le ref est ancré sur le wrapper (toujours rendu) pour que le bouton
          "Commentaires" puisse scroller même avant le chargement lazy. */}
      <div ref={commentsRef} id="comments-section">
        <LazySection
          index={1}
          immediateLoadCount={0}
          rootMargin="200px"
          minHeight="400px"
          className="mt-20 mb-20"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <CommentsSection contentType="tv" contentId={id!} />
          </motion.div>
        </LazySection>
      </div>

      {showUpcomingModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-black rounded-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold">{t('details.similarSeries')}</h2>
              <button
                onClick={() => setShowSimilarModal(false)}
                className="p-2 hover:bg-black/80 rounded-lg transition-colors"
              >
                ✕
              </button>
            </div>
            {loadingSimilar ? (
              <div className="flex flex-col items-center justify-center h-64 space-y-4 bg-black/50">
                <Loader className="animate-spin h-8 w-8" />
                <p className="text-gray-400">{t('details.searchingSimilarSeries')}</p>
              </div>
            ) : recommendations.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {recommendations.map((item) => (
                  <Link
                    key={item.id}
                    to={`/tv/${encodeId(item.id || '')}`}
                    onClick={() => setShowSimilarModal(false)}
                    className="block group/item relative rounded-lg overflow-hidden"
                  >
                    <img
                      src={`https://image.tmdb.org/t/p/original${item.poster_path}`}
                      alt={item.name}
                      className="w-full aspect-[2/3] object-cover rounded-lg transition-transform duration-300 group-hover/item:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover/item:opacity-100 transition-opacity duration-300">
                      <div className="absolute bottom-0 left-0 right-0 p-4">
                        <h3 className="text-sm font-bold text-white line-clamp-2">
                          {item.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-2">
                          <div className="flex items-center gap-1">
                            <Star className="w-3 h-3 text-yellow-400" />
                            <span className="text-xs text-gray-300">
                              {item.vote_average.toFixed(1)}
                            </span>
                          </div>
                          {item.first_air_date && (
                            <div className="flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-gray-400" />
                              <span className="text-xs text-gray-300">
                                {new Date(item.first_air_date).getFullYear()}
                              </span>
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-gray-300 line-clamp-2">
                          {item.overview || t('details.noSummaryAvailable')}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center text-gray-400">
                {t('details.noSimilarSeriesFound')}
              </div>
            )}
          </div>
        </div>
      )}




      {showUpcomingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="bg-gray-900 rounded-lg p-8 max-w-md w-full flex flex-col items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-tv h-12 w-12 text-yellow-500 mb-4"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>
            <h3 className="text-2xl font-bold text-white mb-2">{t('details.episodeNotYetReleased')}</h3>
            <p className="text-gray-300 text-center max-w-md mb-6">{t('details.episodeNotYetReleasedDesc')}</p>
            <div className="flex gap-4 mt-2">
              <button
                className="px-6 py-3 bg-gray-700 text-white rounded-lg font-medium hover:bg-gray-600 transition-colors"
                onClick={() => {
                  setShowUpcomingModal(false);
                  setPendingEpisode(null);
                }}
              >
                {t('details.cancel')}
              </button>
              <button
                className="px-6 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
                onClick={() => {
                  setShowUpcomingModal(false);
                  setForceShowUpcoming(true);
                  if (pendingEpisode) {
                    if (cinemaMode && id && selectedSeason) {
                      // En mode cinéma, naviguer vers la page de visionnage dédiée
                      if (animeMode) {
                        navigate(`/watch/anime/${encodeId(id)}/season/${selectedSeason}/episode/${pendingEpisode}`);
                      } else {
                        navigate(`/watch/tv/${encodeId(id)}/s/${selectedSeason}/e/${pendingEpisode}`);
                      }
                      return;
                    }
                  }
                  setPendingEpisode(null);
                }}
              >
                {t('details.continueAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Popup de la bande-annonce */}
      {showTrailerPopup && trailerVideo && (
        <AnimatePresence mode="wait">
          {!isClosingTrailer && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/90 flex items-center justify-center p-2 sm:p-4 z-[100000]"
              onClick={handleCloseTrailer}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="w-full max-w-6xl bg-gray-900 rounded-2xl overflow-hidden relative"
                onClick={e => e.stopPropagation()}
              >
                <div className="p-4 flex justify-between items-center border-b border-gray-800">
                  <h3 className="text-xl font-semibold text-white">{t('details.bandeAnnonce')} - {tvShow?.name}</h3>
                  <motion.button
                    onClick={handleCloseTrailer}
                    className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <X className="h-6 w-6" />
                  </motion.button>
                </div>
                <div className="aspect-w-16 aspect-h-9">
                  <iframe
                    src={`https://www.youtube.com/embed/${trailerVideo.key}?autoplay=1`}
                    title={trailerVideo.name}
                    className="w-full h-[300px] sm:h-[400px] md:h-[500px] lg:h-[600px]"
                    allowFullScreen
                    allow="autoplay"
                  ></iframe>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      <MovixRatingInfoModal
        isOpen={showMovixRatingInfo}
        onClose={() => setShowMovixRatingInfo(false)}
      />


      </div>
    </MotionConfig>
  );
};

export default TVDetails;
