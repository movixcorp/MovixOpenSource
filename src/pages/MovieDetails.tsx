import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import axios from 'axios';
import { Loader, Video, Star, Calendar, List, Check, ChevronRight, Play, Film, X, Building, MapPin, Languages, Library, Info, ArrowLeft, Image, Download, MessageSquare, AlertTriangle, Archive, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import AddToListButton from '../components/AddToListButton';
import DetailsSkeleton from '../components/skeletons/DetailsSkeleton';

import ShareButtons from '../components/ShareButtons';
import { useAdFreePopup } from '../context/AdFreePopupContext';
import EmblaCarousel from '../components/EmblaCarousel';
import { encodeId, getTmdbId } from '../utils/idEncoder';
import CommentsSection from '../components/CommentsSection';
import LikeDislikeButton, { calculateLikeDislikeRating, type LikeDislikeStats } from '../components/LikeDislikeButton';
import MovixRatingInfoModal from '../components/MovixRatingInfoModal';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import { buildSiteUrl } from '../config/runtime';
import LazySection from '../components/LazySection';
import SEO from '../components/SEO';
import { getTmdbLanguage } from '../i18n';
import i18n from '../i18n';
import { useProfile } from '../context/ProfileContext';
import { getClassificationLabel as getClassificationLabelUtil, isContentAllowed } from '../utils/certificationUtils';
import CharactersSection from '../components/CharactersSection';
import DetailExtraMetadata from '../components/DetailExtraMetadata';
import { isLikelyAnime } from '../utils/animeSignals';
import { loadDetailCharacters, type DetailCharacters } from '../services/detailCharacters';
import { normalizeAlternateTitles, normalizeKeywords, type AlternateTitle } from '../utils/tmdbMetadata';
import { rememberMedia } from '../utils/mediaSearchIndex';

const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

interface Movie {
  title: string;
  overview: string;
  poster_path: string;
  release_date: string;
  vote_average: number;
  genres: { id: number; name: string }[];
  runtime: number;
  backdrop_path?: string;
}

interface KinocheckResponse {
  youtube_video_id: string;
}

interface FrembedResponse {
  status: number;
  result: {
    Total: number;
    items: Array<{
      title: string;
      tmdb: string;
      imdb: string;
      year: string;
      quality: string;
      version: string;
      poster: string;
      link: string;
    }>;
  };
}

interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
}

interface CrewMember {
  id: number;
  name: string;
  job: string;
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
}

interface ExtractedVideoSource {
  url: string;
  quality: string;
  label: string;
}

interface MovieExtended extends Movie {
  production_companies?: { id: number; name: string; logo_path: string | null }[];
  production_countries?: { iso_3166_1: string; name: string }[];
  spoken_languages?: { iso_639_1: string; name: string }[];
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path: string | null;
    backdrop_path: string | null;
  } | null;
  budget?: number;
  revenue?: number;
  status?: string;
  original_language?: string;
  original_title?: string;
  /** Arrivent par `append_to_response`, d'où les deux formes propres à TMDB. */
  keywords?: { keywords?: Array<{ id: number; name: string }> };
  alternative_titles?: { titles?: Array<{ iso_3166_1?: string; title?: string; type?: string }> };
}

interface TMDBImage {
  aspect_ratio: number;
  file_path: string;
  height: number;
  iso_639_1: string | null;
  vote_average: number;
  vote_count: number;
  width: number;
}

interface MovieImages {
  backdrops: TMDBImage[];
  logos: TMDBImage[];
  posters: TMDBImage[];
}

// Use shared certification utility
const getClassificationLabel = getClassificationLabelUtil;

// Ajout de l'interface Collection manquante
interface Collection {
  id: number;
  name: string;
  poster_path: string | null;
  backdrop_path: string | null;
  parts: Array<{
    id: number;
    title: string;
    poster_path: string | null;
    release_date: string;
    vote_average: number;
    overview?: string;
  }>;
}

// Constante pour activer/désactiver la vérification VIP pour le bouton download
const ENABLE_VIP_DOWNLOAD_CHECK = false;

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

const DEFAULT_IMAGE = 'https://via.placeholder.com/185x278/1F2937/FFFFFF?text=Aucune+image';

// Composant pour une image avec lazy loading
const LazyImage = ({ src, alt, className, onLoad }: {
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

// Composant pour la section Images
const ImagesSection = ({ movieId, images, loading }: { movieId: string; images: MovieImages | null; loading: boolean }) => {
  const { t } = useTranslation();
  const [selectedCategory, setSelectedCategory] = useState<'backdrops' | 'posters' | 'logos'>('backdrops');
  const [showImages, setShowImages] = useState(true);
  const [loadedImagesCount, setLoadedImagesCount] = useState(0);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('all');
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);

  // États pour le téléchargement ZIP
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [zipStatus, setZipStatus] = useState<'idle' | 'downloading' | 'zipping' | 'complete' | 'error'>('idle');
  const [downloadedCount, setDownloadedCount] = useState(0);

  // Cap initial render to ~24 images, reveal the rest on idle (Audit #15)
  const [showAllImages, setShowAllImages] = useState(false);
  useEffect(() => {
    if (showAllImages) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const ric = w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200) as unknown as number);
    const cic = w.cancelIdleCallback ?? ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
    const id = ric(() => setShowAllImages(true));
    return () => cic(id);
  }, [showAllImages]);

  const handleToggleImages = () => {
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
      const folder = zip.folder(`movie-${movieId}-${selectedCategory}`);

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
      saveAs(content, `movie-${movieId}-${categoryName}.zip`);

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

  // Ensure images panel is visible by default when movieId changes
  useEffect(() => {
    setShowImages(true);
  }, [movieId]);

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
                            layoutId="movie-images-tabs-indicator"
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
                              {getImagesByCategory().length} images
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
                  {(showAllImages ? getImagesByCategory() : getImagesByCategory().slice(0, 24)).map((image, index) => (
                    <motion.div
                      key={`mobile-${selectedCategory}-${index}`}
                      className="relative group rounded-lg overflow-hidden flex-shrink-0 w-64 sm:w-72 snap-center"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.02, duration: 0.25 }}
                    >
                      <div className={`w-full h-auto ${selectedCategory === 'logos' ? 'p-6 bg-white/5 flex items-center justify-center' : ''}`}>
                        <LazyImage
                          src={`https://image.tmdb.org/t/p/w500${image.file_path}`}
                          alt={`${selectedCategory} ${index + 1}`}
                          className="w-full h-auto object-contain"
                          onLoad={handleImageLoad}
                        />
                      </div>

                      <motion.button
                        onClick={() => downloadImage(
                          image.file_path,
                          `movie-${movieId}-${selectedCategory}-${index + 1}.jpg`
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
                  {(showAllImages ? getImagesByCategory() : getImagesByCategory().slice(0, 24)).map((image, index) => (
                    <motion.div
                      key={`desktop-${selectedCategory}-${index}`}
                      className="relative group rounded-lg overflow-hidden"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.04, duration: 0.3 }}
                      whileHover={{ scale: 1.02 }}
                    >
                      <div className={`w-full h-auto ${selectedCategory === 'logos' ? 'p-8 bg-white/5' : ''}`}>
                        <LazyImage
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
                            `movie-${movieId}-${selectedCategory}-${index + 1}.jpg`
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

// Définir une interface NextMovieType pour le film suivant
interface NextMovieType {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  poster_path: string;
  runtime: number;
}

const MovieDetails = (): JSX.Element => {
  const { t } = useTranslation();
  const { id: encodedId } = useParams<{ id: string }>();
  const id = encodedId ? getTmdbId(encodedId) : null;
  const navigate = useNavigate();
  const { resetVipStatus } = useAdFreePopup(); // Récupérer la fonction reset
  const { currentProfile } = useProfile();

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: id ? { pageName: 'movie-details', contentId: id } : undefined,
  });

  const [movie, setMovie] = useState<MovieExtended | null>(null);
  const [movixVoteStats, setMovixVoteStats] = useState<LikeDislikeStats>({ likes: 0, dislikes: 0 });
  const [showMovixRatingInfo, setShowMovixRatingInfo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trailerVideoId, setTrailerVideoId] = useState<string | null>(null);
  const [cast, setCast] = useState<CastMember[]>([]);
  // Le générique complet, pour la galerie de personnages : `cast` reste tronqué
  // à vingt pour l'onglet Distribution, qui n'a pas la même vocation.
  const [fullCast, setFullCast] = useState<CastMember[]>([]);
  const [crew, setCrew] = useState<GroupedCrewMember[]>([]);
  const [characters, setCharacters] = useState<DetailCharacters | null>(null);
  const [charactersLoading, setCharactersLoading] = useState(false);
  const [alternateTitles, setAlternateTitles] = useState<AlternateTitle[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [backdropImage, setBackdropImage] = useState<string | null>(null);
  const [showTrailerPopup, setShowTrailerPopup] = useState(false);
  const [isClosingTrailer, setIsClosingTrailer] = useState(false);

  useEffect(() => {
    setMovixVoteStats({ likes: 0, dislikes: 0 });
  }, [id]);

  const movixRating = calculateLikeDislikeRating(movixVoteStats);

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

  // Mode cinéma toujours activé

  const [activeTab, setActiveTab] = useState<'overview' | 'details' | 'collection' | 'videos' | 'images' | 'cast' | 'characters' | 'crew'>('overview');
  // Add new state for financial stats mode
  const [financialStatsMode, setFinancialStatsMode] = useState<'simple' | 'advanced'>('simple');

  const [watchProgress, setWatchProgress] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [hasProgress, setHasProgress] = useState(false);

  const [showVideo, setShowVideo] = useState(false);
  const [videos, setVideos] = useState<any[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);

  // États pour les vidéos multi-langues
  const [multiLangVideos, setMultiLangVideos] = useState<any[]>([]);
  const [loadingMultiLangVideos, setLoadingMultiLangVideos] = useState(false);
  const [showMultiLangView, setShowMultiLangView] = useState(false);

  const [customUrl, setCustomUrl] = useState<string | null>(null);

  const [watchStatus, setWatchStatus] = useState<WatchStatus>({
    watchlist: false,
    favorite: false,
    watched: false
  });

  const [showAddToList, setShowAddToList] = useState(false);

  const [isAvailable, setIsAvailable] = useState<boolean>(true);

  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const [showSimilarModal, setShowSimilarModal] = useState(false);

  // Nouvel état pour le film suivant recommandé (film disponible)
  const [nextRecommendedMovie, setNextRecommendedMovie] = useState<NextMovieType | null>(null);
  const [isReleased, setIsReleased] = useState(true);
  const [releaseYear, setReleaseYear] = useState<number | null>(null);



  // Ajout d'un état pour suivre si le film est sorti
  const [showPlayerAnyway, setShowPlayerAnyway] = useState<boolean>(false);

  const [collection, setCollection] = useState<Collection | null>(null);
  const [loadingCollection, setLoadingCollection] = useState(false);
  const [images, setImages] = useState<MovieImages | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [certifications, setCertifications] = useState<{ [key: string]: string }>({});

  // État pour la popup vidéo
  const [showVideoPopup, setShowVideoPopup] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<any>(null);
  const [isClosingVideo, setIsClosingVideo] = useState(false);

  const [isTabsScrollable, setIsTabsScrollable] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement>(null);



  // Ajouter un state pour le hover des cartes de la collection (juste après la déclaration des autres states)
  const [isCollectionCardHovered, setIsCollectionCardHovered] = useState(false);
  const [showCollectionLeftButton, setShowCollectionLeftButton] = useState(false);
  const [showCollectionRightButton, setShowCollectionRightButton] = useState(true);
  const collectionRowRef = useRef<HTMLDivElement>(null);
  // Référence pour la section commentaires
  const commentsRef = useRef<HTMLDivElement>(null);

  // Vérifier si la barre d'onglets est scrollable
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
  }, [movie?.belongs_to_collection]);

  // Réinitialiser le statut VIP quand l'ID du film change
  useEffect(() => {
    resetVipStatus();
  }, [id, resetVipStatus]);

  /**
   * Les personnages de la fiche. AniList est tentée quand le film a le profil
   * d'un anime — un long-métrage japonais animé y est mieux décrit que par un
   * générique — et le générique TMDB prend le relais sinon, ou si AniList ne
   * connaît pas l'œuvre.
   */
  useEffect(() => {
    if (!movie) return;
    let stale = false;
    setCharactersLoading(true);

    void loadDetailCharacters({
      looksLikeAnime: isLikelyAnime(
        {
          original_language: movie.original_language,
          production_companies: movie.production_companies,
          genres: movie.genres,
        },
        { results: movie.keywords?.keywords ?? [] },
      ),
      anilistTitles: [movie.original_title, movie.title].filter((title): title is string => Boolean(title)),
      cast: fullCast,
    })
      .then((result) => { if (!stale) setCharacters(result); })
      .catch(() => { if (!stale) setCharacters(null); })
      .finally(() => { if (!stale) setCharactersLoading(false); });

    return () => { stale = true; };
  }, [movie, fullCast]);


  // Declare fetchMovieDetails type before using it
  /**
   * Ce que la fiche vient de récupérer alimente le catalogue local de
   * recherche. Titres alternatifs, mots-clés, thèmes et noms de personnages
   * sont exactement ce que `search/multi` ne sait pas trouver : les garder
   * rend la fiche retrouvable par ces mots-là (voir `utils/mediaSearchIndex`).
   */
  useEffect(() => {
    if (!movie || !id) return;
    rememberMedia({
      mediaType: 'movie',
      id: Number(id),
      title: movie.title,
      posterPath: movie.poster_path,
      backdropPath: movie.backdrop_path,
      date: movie.release_date,
      voteAverage: movie.vote_average,
      genreIds: movie.genres?.map((genre) => genre.id),
      overview: movie.overview,
      terms: [
        movie.original_title,
        ...alternateTitles.map((entry) => entry.title),
        ...keywords,
        ...(characters?.themes ?? []),
        ...(characters?.groups.flatMap((group) => group.characters.map((item) => item.name)) ?? []),
      ].filter((term): term is string => Boolean(term)),
    });
  }, [movie, id, alternateTitles, keywords, characters]);

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

  const fetchMovieDetails = useCallback(async (): Promise<MovieExtended | undefined> => {
    if (!id) return undefined;
    try {
      setLoading(true);
      // `append_to_response` plutôt que deux requêtes de plus : mots-clés et
      // titres alternatifs voyagent avec la fiche, sans aller-retour en sus.
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}&append_to_response=keywords,alternative_titles`
      );
      setMovie(response.data);
      setKeywords(normalizeKeywords(response.data?.keywords, getTmdbLanguage()));
      setAlternateTitles(normalizeAlternateTitles(response.data?.alternative_titles, [
        response.data?.title, response.data?.original_title,
      ]));

      // Also fetch credits
      const creditsResponse = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/credits?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );
      setCast(creditsResponse.data.cast.slice(0, 20));
      setFullCast(creditsResponse.data.cast || []);
      setCrew(groupCrewMembers(creditsResponse.data.crew));

      const releaseDatesResponse = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/release_dates?api_key=${TMDB_API_KEY}`
      );
      const releaseDatesData = releaseDatesResponse.data.results;
      const newCertifications: { [key: string]: string } = {};
      const frRelease = releaseDatesData.find((r: any) => r.iso_3166_1 === 'FR');
      if (frRelease && frRelease.release_dates) {
        const theatricalRelease = frRelease.release_dates.find((rd: any) => rd.type === 3 || rd.type === 2); // Theatrical or Theatrical (limited)
        if (theatricalRelease && theatricalRelease.certification) {
          newCertifications['FR'] = theatricalRelease.certification;
        }
      }
      if (!newCertifications['FR']) {
        const usRelease = releaseDatesData.find((r: any) => r.iso_3166_1 === 'US');
        if (usRelease && usRelease.release_dates) {
          const theatricalRelease = usRelease.release_dates.find((rd: any) => rd.certification !== "");
          if (theatricalRelease && theatricalRelease.certification) {
            newCertifications['US'] = theatricalRelease.certification;
          }
        }
      }
      setCertifications(newCertifications);

      // Check if movie belongs to a collection (Loaded lazily on tab click)
      // if (response.data.belongs_to_collection) {
      //   fetchCollection(response.data.belongs_to_collection.id);
      // }

      return response.data;
    } catch (error) {
      console.error("Error fetching movie details:", error);
      setError(t('details.movieLoadError'));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Use fetchData to call fetchMovieDetails
  const fetchData = async () => {
    const movieData = await fetchMovieDetails();
    if (movieData && movieData.release_date) {
      const releaseYear = new Date(movieData.release_date).getFullYear();
      setReleaseYear(releaseYear);
    }
  };

  // Ajouter une fonction pour récupérer les détails de la collection
  const fetchCollection = async (collectionId: number) => {
    setLoadingCollection(true);
    try {
      const response = await axios.get<Collection>(`https://api.themoviedb.org/3/collection/${collectionId}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
      });

      // For each part in the collection, fetch the full movie details to get the overview
      const collectionWithDetails = { ...response.data };
      if (collectionWithDetails.parts && collectionWithDetails.parts.length > 0) {
        const updatedParts = await Promise.all(
          collectionWithDetails.parts.map(async (part) => {
            try {
              const movieDetails = await axios.get(`https://api.themoviedb.org/3/movie/${part.id}`, {
                params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
              });
              return { ...part, overview: movieDetails.data.overview };
            } catch (err) {
              console.error(`Error fetching details for movie ${part.id}:`, err);
              return part;
            }
          })
        );
        collectionWithDetails.parts = updatedParts;
      }

      setCollection(collectionWithDetails);
    } catch (error) {
      console.error('Error fetching collection:', error);
    } finally {
      setLoadingCollection(false);
    }
  };

  // Function to fetch movie videos
  const fetchMovieVideos = useCallback(async () => {
    if (!id) return;
    try {
      console.log('Fetching videos for movie:', id);
      setLoadingVideos(true);
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/videos`,
        {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage()
          }
        }
      );

      // First try to get French videos
      let fetchedVideos = response.data.results;
      console.log('French videos response:', fetchedVideos);

      // If no French videos, try English
      if (fetchedVideos.length === 0) {
        console.log('No French videos found, trying English...');
        const enResponse = await axios.get(
          `https://api.themoviedb.org/3/movie/${id}/videos`,
          {
            params: {
              api_key: TMDB_API_KEY,
              language: 'en-US'
            }
          }
        );
        fetchedVideos = enResponse.data.results;
        console.log('English videos response:', fetchedVideos);
      }

      setVideos(fetchedVideos);

      // Set trailer for the trailer popup
      const trailer = fetchedVideos.find((v: any) => v.type === 'Trailer');
      if (trailer) {
        console.log('Trailer found:', trailer);
        setTrailerVideoId(trailer.key);
      } else {
        console.log('No trailer found for this movie');
        setTrailerVideoId(null);
      }
    } catch (error) {
      console.error('Error fetching videos:', error);
      setTrailerVideoId(null);
    } finally {
      setLoadingVideos(false);
    }
  }, [id]);

  // Function to fetch multi-language videos
  const fetchMultiLangVideos = useCallback(async () => {
    if (!id) return;
    try {
      setLoadingMultiLangVideos(true);
      // Fetch videos without language parameter to get all languages
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/videos`,
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

  // Fetch trailer on page load so the Bande-annonce button is enabled
  useEffect(() => {
    fetchMovieVideos().then(() => setVideosLoaded(true));
  }, [fetchMovieVideos]);

  // State to track if videos have been loaded (for click-to-load behavior)
  const [videosLoaded, setVideosLoaded] = useState(false);

  // Handler for when Videos tab is clicked - loads videos on demand
  const handleVideosTabClick = useCallback(() => {
    setActiveTab('videos');
    if (!videosLoaded && !loadingVideos) {
      fetchMovieVideos().then(() => setVideosLoaded(true));
    }
  }, [videosLoaded, loadingVideos, fetchMovieVideos]);

  // Function to fetch images
  const fetchImages = useCallback(async () => {
    if (!id || images) return;
    setLoadingImages(true);
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/movie/${id}/images`, {
        params: { api_key: TMDB_API_KEY },
      });
      setImages(response.data);
    } catch (error) {
      console.error('Error fetching movie images:', error);
    } finally {
      setLoadingImages(false);
    }
  }, [id, images]);

  // Handler for when Images tab is clicked
  const handleImagesTabClick = useCallback(() => {
    setActiveTab('images');
    if (!images && !loadingImages) {
      fetchImages();
    }
  }, [images, loadingImages, fetchImages]);

  // Handler for when Collection tab is clicked
  const handleCollectionTabClick = useCallback(() => {
    setActiveTab('collection');
    if (movie?.belongs_to_collection && !collection && !loadingCollection) {
      fetchCollection(movie.belongs_to_collection.id);
    }
     
  }, [movie, collection, loadingCollection]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        // Only fetch movie details initially - videos are loaded on demand
        await fetchMovieDetails();
      } catch (error) {
        console.error('Error:', error);
        setError(t('details.dataLoadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, fetchMovieDetails]);

  useEffect(() => {
    const loadWatchStatus = () => {
      const watchlistItems = JSON.parse(localStorage.getItem('watchlist_movie') || '[]');
      const favoriteItems = JSON.parse(localStorage.getItem('favorite_movie') || '[]');
      const watchedItems = JSON.parse(localStorage.getItem('watched_movie') || '[]');

      setWatchStatus({
        watchlist: watchlistItems.some((item: any) => item.id === Number(id)),
        favorite: favoriteItems.some((item: any) => item.id === Number(id)),
        watched: watchedItems.some((item: any) => item.id === Number(id))
      });
    };

    loadWatchStatus();
  }, [id]);

  const updateWatchStatus = (type: keyof WatchStatus, value: boolean) => {
    setWatchStatus(prev => {
      const newStatus = { ...prev, [type]: value };

      const itemToSave = {
        id: Number(id),
        type: 'movie',
        title: movie?.title || '',
        poster_path: movie?.poster_path || '',
        addedAt: new Date().toISOString()
      };

      const key = `${type}_movie`;
      const existingItems = JSON.parse(localStorage.getItem(key) || '[]');

      if (value) {
        const updatedItems = [
          itemToSave,
          ...existingItems.filter((item: any) => item.id !== Number(id))
        ];
        localStorage.setItem(key, JSON.stringify(updatedItems));
      } else {
        const filteredItems = existingItems.filter((item: any) => item.id !== Number(id));
        localStorage.setItem(key, JSON.stringify(filteredItems));
      }

      return newStatus;
    });
  };

  // Convert WatchButtons to a regular function to access parent scope variables
  function WatchButtons() {
    // Format time from seconds to MM:SS or HH:MM:SS if hours > 0
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

    return (
      <div className="flex flex-col gap-4 mt-4">
        {/* Première ligne avec Regarder et Bande-annonce */}
        <div className="flex flex-wrap gap-3 w-full min-w-0">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={handleWatchClick}
            className="flex flex-col items-center gap-2 px-4 sm:px-6 py-4 sm:py-5 bg-red-600 hover:bg-red-700 rounded-lg flex-1 min-w-0 justify-center text-xs sm:text-sm"
          >
            {hasProgress ? (
              <>
                <Play className="w-5 h-5 sm:w-6 sm:h-6 flex-shrink-0" />
                <div className="flex flex-col items-center text-center w-full min-w-0">
                  <span>{t('details.continueBtn')}</span>
                  <span className="text-xs bg-red-800/80 text-white px-1.5 py-0.5 rounded font-medium mt-1">
                    {formatTime(watchProgress)}/{formatTime(videoDuration)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <Play className="w-5 h-5 sm:w-6 sm:h-6 flex-shrink-0" />
                <span className="text-center">{t('details.watchBtn')}</span>
              </>
            )}
          </motion.button>

          {(!ENABLE_VIP_DOWNLOAD_CHECK || localStorage.getItem('is_vip') === 'true') && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
              onClick={() => navigate(`/download/movie/${id}`)}
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
            disabled={!trailerVideoId}
          >
            <Video className="w-4 h-4" />
            {t('details.bandeAnnonce')}
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={() => updateWatchStatus('watchlist', !watchStatus.watchlist)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.watchlist
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <motion.div
              initial={{ rotate: 0 }}
              animate={watchStatus.watchlist ? { rotate: [0, -15, 15, -5, 5, 0] } : {}}
              transition={{ duration: 0.5 }}
            >
              <List className="w-4 h-4" />
            </motion.div>
            {t('details.toWatchBtn')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={() => updateWatchStatus('favorite', !watchStatus.favorite)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.favorite
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <motion.div
              animate={watchStatus.favorite ?
                { scale: [1, 1.3, 1], color: ['#fff', '#fbbf24', '#fff'] } :
                {}
              }
              transition={{ duration: 0.5 }}
            >
              <Star className="w-4 h-4" />
            </motion.div>
            {t('details.favoritesBtn')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
            onClick={() => updateWatchStatus('watched', !watchStatus.watched)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${watchStatus.watched
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700'
              }`}
          >
            <motion.div
              animate={watchStatus.watched ?
                { scale: [1, 1.3, 1], rotate: [0, 0, 360] } :
                {}
              }
              transition={{ duration: 0.5 }}
            >
              <Check className="w-4 h-4" />
            </motion.div>
            {t('details.watchedBtn')}
          </motion.button>


          <AddToListButton
            mediaId={Number(id)}
            mediaType="movie"
            title={movie?.title || ''}
            posterPath={movie?.poster_path || ''}
          />

          <ShareButtons
            title={movie?.title || ''}
            description={movie?.overview || ''}
            imageUrl={movie?.poster_path ? `https://image.tmdb.org/t/p/original${movie.poster_path}` : undefined}
            url={buildSiteUrl(`/movie/${encodedId || id}`)}
          />
        </div>
      </div>
    );
  }



  // Watch progress tracking functionality removed

  const handleWatchClick = () => {
    // Mode cinéma toujours actif - naviguer vers la page de visionnage
    navigate(`/watch/movie/${encodeId(id || '')}`);
  };

  const fetchRecommendations = async () => {
    setLoadingSimilar(true);
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/recommendations?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );
      console.log('Films recommandés:', response.data.results);
      const movies = response.data.results.slice(0, 20);

      // Ne plus vérifier la disponibilité sur frembed, retourner directement les résultats TMDB
      const availableMovies = movies.map((movie: any) => ({ ...movie, isAvailable: true }));
      console.log('Films disponibles:', availableMovies);
      setRecommendations(availableMovies);

      // Définir le film suivant recommandé s'il y en a un disponible
      if (availableMovies.length > 0) {
        setNextRecommendedMovie(availableMovies[0]);
      }
    } catch (error) {
      console.error('Error fetching recommendations:', error);
    } finally {
      setLoadingSimilar(false);
    }
  };

  const handleShowSimilar = async () => {
    if (recommendations.length === 0) {
      await fetchRecommendations();
    }
  };

  useEffect(() => {
    if (id && movie && recommendations.length === 0) {
      fetchRecommendations();
    }
  }, [id, movie]);

  useEffect(() => {
    // Setup SEO and movie data
    if (movie) {
      const year = movie.release_date ? new Date(movie.release_date).getFullYear() : '';
      const rating = movie.vote_average?.toFixed(1);
      const genres = movie.genres?.map(g => g.name).join(', ') || '';

      // Vérifie si le film est sorti ou non
      const releaseDate = movie.release_date && !isNaN(new Date(movie.release_date).getTime())
        ? new Date(movie.release_date)
        : null;
      setIsReleased(releaseDate ? releaseDate <= new Date() : true);

      // Simple movie title
      document.title = `${movie.title} - Movix`;
    } else {
      document.title = 'Film - Movix';
    }
  }, [movie, id]);

  const scrollToPlayer = () => {
    const playerSection = document.getElementById('video-player-section');
    if (playerSection) {
      playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const fetchMovieImages = async () => {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/movie/${id}/images`, {
        params: { api_key: TMDB_API_KEY },
      });

      // Trouver la meilleure image de fond
      const backdrops = response.data.backdrops;
      if (backdrops && backdrops.length > 0) {
        // Trier par résolution et choisir la meilleure
        const bestBackdrop = backdrops.sort((a: any, b: any) => b.width - a.width)[0];
        setBackdropImage(`https://image.tmdb.org/t/p/w1280${bestBackdrop.file_path}`);
      }
    } catch (error) {
      console.error('Error fetching movie images:', error);
    }
  };

  useEffect(() => {
    if (id) {
      fetchMovieImages();
    }
  }, [id]);



  // Ajouter les fonctions de gestion de scroll de la collection (juste après les fonctions pour similarRow)
  const handleCollectionRowScroll = () => {
    if (collectionRowRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = collectionRowRef.current;
      setShowCollectionLeftButton(scrollLeft > 0);
      setShowCollectionRightButton(scrollLeft < scrollWidth - clientWidth);
    }
  };

  const scrollCollectionRow = (direction: 'left' | 'right') => {
    if (collectionRowRef.current) {
      const { clientWidth } = collectionRowRef.current;
      const scrollAmount = direction === 'left' ? -clientWidth : clientWidth;
      collectionRowRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  // Ajouter un useEffect pour gérer le scroll sur hover de la collection
  useEffect(() => {
    const container = collectionRowRef.current;
    if (!container) return;
    if (!isCollectionCardHovered) return;

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: Event) => {
      if (e instanceof WheelEvent && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
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
  }, [isCollectionCardHovered]);

  // Ajout de ce useEffect pour définir l'état initial des boutons de la collection
  useEffect(() => {
    // Attendre que la collection soit chargée et que la ref soit définie
    if (collection && collectionRowRef.current) {
      // Appeler la fonction de scroll pour définir l'état initial
      handleCollectionRowScroll();

      // Optionnel: Ajouter un écouteur de redimensionnement pour recalculer si nécessaire
      const handleResize = () => handleCollectionRowScroll();
      window.addEventListener('resize', handleResize);

      // Nettoyage de l'écouteur
      return () => window.removeEventListener('resize', handleResize);
    }
  }, [collection]); // Déclenché lorsque la collection change

  // Progress loading functionality removed

  useEffect(() => {
    // Load watch progress when movie ID changes
    if (id) {
      const progressKey = `progress_${id}`;
      const savedData = localStorage.getItem(progressKey);

      if (savedData) {
        try {
          const progressData = JSON.parse(savedData);
          if (progressData.position && progressData.duration) {
            // Only show resume if at least 30 seconds have been watched
            // and if less than 95% of the movie has been watched
            const percentage = (progressData.position / progressData.duration) * 100;
            if (progressData.position > 30 && percentage < 95) {
              setWatchProgress(progressData.position);
              setVideoDuration(progressData.duration);
              setHasProgress(true);
            } else {
              setHasProgress(false);
            }
          }
        } catch (error) {
          console.error("Error parsing progress data:", error);
          setHasProgress(false);
        }
      } else {
        setHasProgress(false);
      }
    }
  }, [id]);

  if (loading) {
    return <DetailsSkeleton />;
  }
  if (error) return <div className="text-center text-red-500">{error}</div>;
  if (!movie) return <div className="text-center">{t('details.movieNotFound')}</div>;

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

  // Trouver le réalisateur, s'il existe
  const director = crew.find(member => member.jobs.includes('Director'));
  const movieYear = movie.release_date && !isNaN(new Date(movie.release_date).getTime())
    ? new Date(movie.release_date).getFullYear()
    : null;
  const movieTitle = movieYear ? `${movie.title} (${movieYear}) - Movix` : `${movie.title} - Movix`;
  const movieCanonicalUrl = buildSiteUrl(`/movie/${encodedId || id}`);
  const movieSocialImage = movie.backdrop_path || movie.poster_path
    ? `https://image.tmdb.org/t/p/original${movie.backdrop_path || movie.poster_path}`
    : undefined;
  const movieDescription = movie.overview?.trim() || `Découvrez ${movie.title} sur Movix.`;

  return (
    <MotionConfig reducedMotion="user">
      <SEO
        title={movieTitle}
        description={movieDescription}
        ogType="video.movie"
        ogUrl={movieCanonicalUrl}
        ogImage={movieSocialImage}
        canonical={movieCanonicalUrl}
      />
      <style>
        {`
          /* Netflix-style poster hover effects - COPIED FROM Home.tsx */
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
            margin: 0 -0.5rem -5rem -0.5rem; /* Ajuster la marge inférieure si nécessaire */
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
          /* This pushes all posters after the hovered one to the right */
          .poster-container:hover ~ .poster-container {
            transform: translateX(0); /* Reset previous rule */
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
          /* Décaler les cards suivantes quand l'animation de hover est active */
          .poster-container:has(.poster-card:hover) ~ .poster-container {
            transform: translateX(100px);
          }
          /* Solution de secours pour les navigateurs ne supportant pas :has */
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
          /* Fin des styles copiés de Home.tsx pour le hover */

          /* Styles existants pour section-title et no-scroll (vérifier s'ils sont nécessaires) */
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
          .no-scroll {
            overflow: hidden !important; /* Cache TOUT overflow, pas seulement horizontal */
            pointer-events: none !important; /* Désactive TOUS les événements de souris */
            touch-action: none !important; /* Désactive les événements tactiles */
            user-select: none !important; /* Empêche la sélection de texte */
            isolation: isolate; /* Crée un nouveau contexte d'empilement */
          }
          /* Réactiver uniquement pour les enfants directs */
          .no-scroll > * {
            pointer-events: auto !important;
          }
        `}
      </style>


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
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 min-h-screen text-white px-4 md:px-8 lg:px-16 py-6"
      >
        {/* Header avec titre et année */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mb-8"
        >
          <h1 className="section-title text-4xl md:text-5xl font-bold">
            {movie.title} ({movie.release_date && !isNaN(new Date(movie.release_date).getTime()) ? new Date(movie.release_date).getFullYear() : ''})
            {movie.release_date && !isNaN(new Date(movie.release_date).getTime()) ? (
              new Date(movie.release_date) > new Date() ?
                <span className="ml-2 text-sm font-medium bg-yellow-600 text-white px-2 py-1 rounded-md">{t('details.upcomingBadge')}</span> :
                <span className="ml-2 text-sm font-medium bg-green-600 text-white px-2 py-1 rounded-md">{t('details.releasedBadge')}</span>
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
              src={movie.poster_path ? `https://image.tmdb.org/t/p/original${movie.poster_path}` : DEFAULT_IMAGE}
              alt={movie.title}
              className="w-full rounded-lg shadow-lg"
            />

            {/* Boutons d'action en-dessous du poster */}
            <div className="mt-6">
              <WatchButtons />
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
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'overview'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'details'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                  onClick={handleVideosTabClick}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'videos'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                  onClick={handleImagesTabClick}
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'images'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'cast'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                  className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'crew'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-white'
                    }`}
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
                    className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'characters'
                      ? 'text-white'
                      : 'text-gray-400 hover:text-white'
                      }`}
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

                {/* N'afficher l'onglet Collection que si le film appartient à une collection */}
                {movie?.belongs_to_collection && (
                  <motion.button
                    onClick={handleCollectionTabClick}
                    className={`px-6 py-3 font-medium text-sm flex-shrink-0 relative ${activeTab === 'collection'
                      ? 'text-white'
                      : 'text-gray-400 hover:text-white'
                      }`}
                    whileHover={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                    whileTap={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                  >
                    {t('details.sagaTab')}
                    {activeTab === 'collection' && (
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

              {/* Indicateur de défilement à droite */}
              {isTabsScrollable && (
                <div className="absolute right-0 top-0 h-full w-12 bg-gradient-to-l from-black to-transparent pointer-events-none flex items-center justify-end pr-2">
                  <motion.div
                    animate={{
                      opacity: [0.7, 1, 0.7],
                    }}
                    transition={{
                      repeat: Infinity,
                      duration: 1.5,
                      repeatType: "reverse"
                    }}
                  >
                    <ChevronRight className="w-5 h-5 text-gray-300 opacity-70" />
                  </motion.div>
                </div>
              )}
            </div>

            {/* Contenu des tabs */}
            <AnimatePresence mode="wait">
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
                        contentType="movie"
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
                            href={`https://www.themoviedb.org/movie/${id}`}
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
                    <p className="text-gray-300">{movie.overview || t('details.noSynopsis')}</p>
                  </motion.div>

                  {/* Info basiques */}
                  <motion.div
                    className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    {/* Durée */}
                    <div>
                      <h3 className="text-lg font-semibold mb-2">{t('details.durationLabel')}</h3>
                      <p className="text-gray-300">{movie.runtime} {t('details.minutesLabel')}</p>
                    </div>

                    {/* Notes */}
                    <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <h3 className="text-lg font-semibold mb-2">{t('details.ratingLabel')}</h3>
                        <div className="flex items-center gap-2">
                          <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                          <p className="text-gray-300 text-lg font-bold">{movie.vote_average != null ? movie.vote_average.toFixed(1) : 'N/A'}<span className="text-sm font-normal text-gray-400">/10</span></p>
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

                    {/* Réalisateur */}
                    {director && (
                      <div>
                        <h3 className="text-lg font-semibold mb-2">{t('details.directorLabel')}</h3>
                        <p className="text-gray-300">{director.name}</p>
                      </div>
                    )}
                  </motion.div>

                  {/* Genres */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                  >
                    <h3 className="text-lg font-semibold mb-2">{t('details.genresLabel')}</h3>
                    <div className="flex flex-wrap gap-2">
                      {movie.genres.map((genre, index) => (
                        <motion.div
                          key={genre.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.1 + index * 0.05 }}
                        >
                          <Link
                            to={`/genre/movie/${genre.id}`}
                            className="flex items-center gap-1 px-3 py-2 bg-gray-800 rounded-lg text-sm hover:bg-gray-700 transition-colors inline-block border border-gray-700 hover:border-gray-600"
                          >
                            <span className="w-2 h-2 rounded-full bg-red-500"></span>
                            {genre.name}
                          </Link>
                        </motion.div>
                      ))}
                    </div>

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
                          <p className="text-sm text-gray-400">
                            {member.jobs.map(job => {
                              const translations: { [key: string]: string } = {
                                'Director': t('details.jobDirector'),
                                'Producer': t('details.jobProducer'),
                                'Executive Producer': t('details.jobExecProducer'),
                                'Writer': t('details.jobWriter'),
                                'Director of Photography': t('details.jobDOP'),
                                'Editor': t('details.jobEditor'),
                                'Production Design': t('details.jobProdDesign'),
                                'Costume Design': t('details.jobCostume'),
                                'Music': t('details.jobMusic'),
                                'Sound': t('details.jobSound'),
                                'Screenplay': t('details.jobScreenplay'),
                                'Story': t('details.jobStory'),
                                'Characters': t('details.jobCharacters'),
                                'Casting': t('details.jobCasting'),
                                'Art Direction': t('details.jobArtDirection'),
                                'Set Decoration': t('details.jobSetDecoration')
                              };
                              return translations[job] || job;
                            }).join(', ')}
                          </p>
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
                  {/* Production Companies */}
                  {movie.production_companies && movie.production_companies.length > 0 && (
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
                        {movie.production_companies.map((company, index) => (
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
                              className="w-12 h-12 flex items-center justify-center bg-gray-700 rounded"
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
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Production Countries */}
                  {movie.production_countries && movie.production_countries.length > 0 && (
                    <motion.div
                      className="mb-6"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.2 }}
                    >
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <MapPin className="w-5 h-5" />
                        {t('details.productionCountries')}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {movie.production_countries.map((country, index) => (
                          <motion.div
                            key={country.iso_3166_1}
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
                            {country.name}
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Languages */}
                  {movie.spoken_languages && movie.spoken_languages.length > 0 && (
                    <motion.div
                      className="mb-6"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                    >
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <Languages className="w-5 h-5" />
                        {t('details.languagesLabel')}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {movie.spoken_languages.map((language, index) => (
                          <motion.div
                            key={language.iso_639_1}
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
                            {language.name}
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Date de sortie */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Calendar className="w-5 h-5" />
                      {t('details.releaseDateLabel')}
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
                      {movie.release_date && !isNaN(new Date(movie.release_date).getTime())
                        ? new Date(movie.release_date).toLocaleDateString(i18n.language, {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric'
                        })
                        : t('details.dateNotAvailable')
                      }
                    </motion.div>
                  </motion.div>

                  {/* Statistiques financières */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
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

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Budget */}
                      <motion.div
                        className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                        whileHover={{
                          backgroundColor: "rgba(75,85,99, 0.8)",
                          y: -2,
                          borderColor: "rgba(107,114,128, 0.8)",
                          transition: { duration: 0.2 }
                        }}
                      >
                        <h4 className="text-gray-400 text-sm mb-1">{t('details.budgetLabel')}</h4>
                        <p className="text-gray-200 font-semibold">
                          {movie.budget && movie.budget > 0
                            ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(movie.budget)
                            : t('details.notDisclosed')
                          }
                        </p>
                      </motion.div>

                      {/* Revenus */}
                      <motion.div
                        className="bg-gray-800 p-3 rounded-lg border border-gray-700"
                        whileHover={{
                          backgroundColor: "rgba(75,85,99, 0.8)",
                          y: -2,
                          borderColor: "rgba(107,114,128, 0.8)",
                          transition: { duration: 0.2 }
                        }}
                      >
                        <h4 className="text-gray-400 text-sm mb-1">{t('details.revenueLabel')}</h4>
                        <p className="text-gray-200 font-semibold">
                          {movie.revenue && movie.revenue > 0
                            ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(movie.revenue)
                            : t('details.notDisclosed')
                          }
                        </p>
                      </motion.div>

                      {/* Bénéfice/Perte */}
                      {movie.budget && movie.revenue && movie.budget > 0 && movie.revenue > 0 && (
                        <motion.div
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-400 text-sm mb-1">{t('details.profitLossLabel')}</h4>
                          <p className={`font-semibold ${movie.revenue - movie.budget > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(movie.revenue - movie.budget)}
                            {movie.revenue > 0 && movie.budget > 0 && (
                              <span className="ml-2 text-xs text-gray-400">
                                ({Math.round((movie.revenue / movie.budget - 1) * 100)}% {movie.revenue > movie.budget ? t('details.profitPercent') : t('details.lossPercent')})
                              </span>
                            )}
                          </p>
                        </motion.div>
                      )}

                      {/* Statut */}
                      {movie.status && (
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
                            {movie.status === 'Released' ? t('details.statusReleased') :
                              movie.status === 'Post Production' ? t('details.statusPostProd') :
                                movie.status === 'In Production' ? t('details.statusInProd') :
                                  movie.status === 'Planned' ? t('details.statusPlanned') :
                                    movie.status}
                          </p>
                        </motion.div>
                      )}

                      {/* Section détaillée sur les revenus et bénéfices - Only shown in advanced mode */}
                      {financialStatsMode === 'advanced' && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.3 }}
                          className="bg-gray-800 p-3 rounded-lg border border-gray-700 col-span-1 md:col-span-2 mt-4"
                          whileHover={{
                            backgroundColor: "rgba(75,85,99, 0.8)",
                            y: -2,
                            borderColor: "rgba(107,114,128, 0.8)",
                            transition: { duration: 0.2 }
                          }}
                        >
                          <h4 className="text-gray-300 text-sm font-medium mb-3">{t('details.financialDetailsAdvanced')}</h4>

                          {/* Sources de revenus */}
                          <div className="mb-4">
                            <p className="text-sm text-gray-300 mb-2">
                              <span className="font-semibold">{t('details.revenueSources')}</span> ({t('details.byImportanceOrder')}):
                            </p>
                            <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1">
                              <li>{t('details.boxOffice')}: <span className="text-gray-400">~40-60% {t('details.ofTotalRevenue')}</span></li>
                              <li>{t('details.vodStreaming')}: <span className="text-gray-400">~15-30% {t('details.ofTotalRevenue')}</span></li>
                              <li>{t('details.tvRights')}: <span className="text-gray-400">~10-20% {t('details.ofTotalRevenue')}</span></li>
                              <li>{t('details.dvdBluRay')}: <span className="text-gray-400">~5-15% {t('details.ofTotalRevenue')}</span></li>
                              <li>{t('details.merchandisingLabel')}: <span className="text-gray-400">{movie.belongs_to_collection ? t('details.potentiallyVeryHigh') : t('details.variableByMovie')}</span></li>
                            </ul>
                          </div>

                          {/* Analyse de rentabilité */}
                          <div className="mb-4">
                            <p className="text-sm text-gray-300 mb-2">
                              <span className="font-semibold">{t('details.profitabilityEstimate')}</span> {t('details.forMovie', { title: movie.title })}:
                            </p>

                            <div className="bg-gray-900 p-2 rounded-lg mb-2">
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-xs text-gray-400">{t('details.breakEvenEstimate')}:</span>
                                <span className="text-xs font-semibold text-gray-300">
                                  {movie.budget && movie.budget > 0
                                    ? `~${new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(movie.budget * 2.5)}`
                                    : t('details.notAvailableData')}
                                </span>
                              </div>

                              <div className="flex justify-between items-center mb-1">
                                <span className="text-xs text-gray-400">{t('details.roiLabel')}:</span>
                                <span className="text-xs font-semibold text-gray-300">
                                  {movie.budget && movie.revenue && movie.budget > 0
                                    ? `${Math.round((movie.revenue / movie.budget - 1) * 100)}%`
                                    : t('details.notAvailableData')}
                                </span>
                              </div>

                              <div className="flex justify-between items-center">
                                <span className="text-xs text-gray-400">{t('details.commercialClassification')}:</span>
                                <span className={`text-xs font-semibold ${movie.budget && movie.revenue && movie.budget > 0 ? (
                                  movie.revenue >= movie.budget * 2.5 ? 'text-green-400' :
                                    movie.revenue >= movie.budget ? 'text-yellow-400' :
                                      'text-red-400'
                                ) : 'text-gray-300'
                                  }`}>
                                  {movie.budget && movie.revenue && movie.budget > 0 ? (
                                    movie.revenue >= movie.budget * 3 ? t('details.blockbuster') :
                                      movie.revenue >= movie.budget * 2.5 ? t('details.commercialSuccess') :
                                        movie.revenue >= movie.budget * 1.5 ? t('details.profitableMovie') :
                                          movie.revenue >= movie.budget ? t('details.breakEvenStatus') :
                                            t('details.commercialFailure')
                                  ) : t('details.notAvailableData')}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Facteurs de succès */}
                          <div>
                            <p className="text-sm text-gray-300 mb-2">
                              <span className="font-semibold">{t('details.factorsImpacting')}:</span>
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-gray-900 p-2 rounded-lg">
                                <h5 className="text-xs font-medium text-green-400 mb-1">{t('details.positiveFactors')}</h5>
                                <ul className="list-disc pl-4 text-xs text-gray-300 space-y-0.5">
                                  {movie.vote_average >= 7 && <li>{t('details.highRating', { rating: movie.vote_average })}</li>}
                                  {movie.belongs_to_collection && <li>{t('details.belongsToFranchise')}</li>}
                                  {movie.genres?.some(g => ['Action', 'Adventure', 'Animation', 'Fantasy', 'Science Fiction'].includes(g.name)) &&
                                    <li>{t('details.popularGenre')}</li>}
                                  {movie.production_companies?.some(c =>
                                    ['Walt Disney Pictures', 'Marvel Studios', 'Universal Pictures', 'Warner Bros.'].includes(c.name)) &&
                                    <li>{t('details.majorStudio')}</li>}
                                </ul>
                              </div>
                              <div className="bg-gray-900 p-2 rounded-lg">
                                <h5 className="text-xs font-medium text-red-400 mb-1">{t('details.limitingFactors')}</h5>
                                <ul className="list-disc pl-4 text-xs text-gray-300 space-y-0.5">
                                  {movie.vote_average < 6 && <li>{t('details.lowRating', { rating: movie.vote_average })}</li>}
                                  {movie.budget && movie.budget > 150000000 && <li>{t('details.veryHighBudget')}</li>}
                                  {movie.production_countries?.every(c => c.iso_3166_1 !== 'US') &&
                                    <li>{t('details.nonHollywood')}</li>}
                                  {movie.genres?.some(g => ['Documentary', 'Foreign', 'History', 'War'].includes(g.name)) &&
                                    <li>{t('details.nicheGenre')}</li>}
                                  {movie.release_date && new Date(movie.release_date) > new Date(2020, 0, 1) && new Date(movie.release_date) < new Date(2022, 0, 1) &&
                                    <li>{t('details.pandemicRelease')}</li>}
                                </ul>
                              </div>
                            </div>
                          </div>

                          <p className="text-xs text-gray-400 italic mt-3">
                            {t('details.financialNote')}
                          </p>
                        </motion.div>
                      )}
                    </div>
                  </motion.div>
                  {/* En fin d'onglet Détails : thèmes, titres alternatifs et
                      mots-clés relèvent de la fiche technique, pas de la
                      galerie de personnages. */}
                  <DetailExtraMetadata
                    themes={characters?.themes ?? []}
                    alternateTitles={alternateTitles}
                    keywords={keywords}
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

                  {(loadingVideos || loadingMultiLangVideos) ? (
                    <div className="flex items-center justify-center h-40">
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
                        <p>{t('details.noMultiLangVideoForMovie')}</p>
                      </div>
                    )
                  ) : (
                    // Vue normale
                    videos.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {videos.map((video: any, index: number) => (
                          <motion.div
                            key={video.id}
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
                    ) : (
                      <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                        <Film className="w-8 h-8 mb-2" />
                        <p>{t('details.noVideoAvailableForMovie')}</p>
                      </div>
                    )
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
                  <ImagesSection movieId={id!} images={images} loading={loadingImages} />
                </motion.div>
              ) : (
                <motion.div
                  key="collection"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  {loadingCollection ? (
                    <div className="flex items-center justify-center h-40 w-full">
                      <Loader className="w-8 h-8 animate-spin text-red-600" />
                    </div>
                  ) : collection ? (
                    <div>
                      <div className="mb-6">
                        <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                          <Library className="w-5 h-5" />
                          {collection.name}
                        </h3>

                        <motion.div
                          className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mt-4 px-4 md:px-8"
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.4, ease: "easeOut" }}
                        >
                          {collection.parts
                            .sort((a, b) => new Date(a.release_date).getTime() - new Date(b.release_date).getTime())
                            .map((part, index) => (
                              <motion.div
                                key={part.id}
                                className="poster-container cursor-pointer"
                                onClick={() => navigate(`/movie/${encodeId(part.id)}`)}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.03 * index, duration: 0.3 }}
                              >
                                <div className="poster-card">
                                  {/* Poster image */}
                                  <img
                                    src={part.poster_path ? `https://image.tmdb.org/t/p/original${part.poster_path}` : DEFAULT_IMAGE}
                                    alt={part.title}
                                    className="w-full h-auto object-cover rounded-lg poster"
                                    onError={(e) => {
                                      const target = e.target as HTMLImageElement;
                                      target.onerror = null;
                                      target.src = 'data:image/svg+xml;utf8,<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="50" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>';
                                    }}
                                  />

                                  {/* Hover content */}
                                  <div className="hover-content">
                                    {/* Top section: landscape image */}
                                    <div className="w-full h-24 md:h-28 relative">
                                      <img
                                        src={part.poster_path ? `https://image.tmdb.org/t/p/original${part.poster_path}` : DEFAULT_IMAGE}
                                        alt={part.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                          const target = e.target as HTMLImageElement;
                                          target.onerror = null;
                                          target.src = 'data:image/svg+xml;utf8,<svg width="500" height="281" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 281" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="30" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>';
                                        }}
                                      />

                                      {/* Play and Info buttons overlay */}
                                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-black/20 flex items-center justify-center">
                                        {/* Watchlist button */}
                                        <button
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            // Watchlist logic
                                            const storageKey = 'watchlist_movie';
                                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                                            const exists = typeWatchlist.some((media: any) => media.id === part.id);
                                            if (!exists) {
                                              typeWatchlist.push({
                                                id: part.id,
                                                type: 'movie',
                                                title: part.title,
                                                poster_path: part.poster_path,
                                                addedAt: new Date().toISOString()
                                              });
                                              localStorage.setItem(storageKey, JSON.stringify(typeWatchlist));
                                              // Notification
                                              const notification = document.createElement('div');
                                              notification.className = 'fixed top-16 right-4 bg-green-500 text-white py-2 px-4 rounded shadow-lg z-50 animate-fadeIn';
                                              notification.textContent = t('search.addedToWatchlist');
                                              document.body.appendChild(notification);
                                              // Update button
                                              const button = e.currentTarget;
                                              button.querySelector('svg')?.classList.add('text-yellow-400');
                                              button.querySelector('svg')?.setAttribute('fill', 'currentColor');
                                              setTimeout(() => {
                                                notification.classList.add('animate-fadeOut');
                                                setTimeout(() => {
                                                  document.body.removeChild(notification);
                                                }, 500);
                                              }, 1500);
                                            } else {
                                              const updatedTypeWatchlist = typeWatchlist.filter((media: any) => media.id !== part.id);
                                              localStorage.setItem(storageKey, JSON.stringify(updatedTypeWatchlist));
                                              // Update button
                                              const button = e.currentTarget;
                                              button.querySelector('svg')?.classList.remove('text-yellow-400');
                                              button.querySelector('svg')?.setAttribute('fill', 'black');
                                              // Notification
                                              const notification = document.createElement('div');
                                              notification.className = 'fixed top-16 right-4 bg-red-500 text-white py-2 px-4 rounded shadow-lg z-50 animate-fadeIn';
                                              notification.textContent = t('search.removedFromWatchlist');
                                              document.body.appendChild(notification);
                                              setTimeout(() => {
                                                notification.classList.add('animate-fadeOut');
                                                setTimeout(() => {
                                                  document.body.removeChild(notification);
                                                }, 500);
                                              }, 1500);
                                            }
                                          }}
                                          className="bg-white rounded-full p-2 transform transition-transform hover:scale-110 mr-2 z-20 group/watchlist relative"
                                        >
                                          <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/watchlist:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                                            {(() => {
                                              const storageKey = 'watchlist_movie';
                                              const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                                              const exists = typeWatchlist.some((media: any) => media.id === part.id);
                                              return exists ? t('search.removeFromWatchlist') : t('search.addToWatchlist');
                                            })()}
                                          </div>
                                          <Star
                                            className={`w-4 h-4 ${(() => {
                                              const storageKey = 'watchlist_movie';
                                              const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                                              const exists = typeWatchlist.some((media: any) => media.id === part.id);
                                              return exists ? 'text-yellow-400' : 'text-black';
                                            })()}`}
                                            fill={(() => {
                                              const storageKey = 'watchlist_movie';
                                              const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                                              const exists = typeWatchlist.some((media: any) => media.id === part.id);
                                              return exists ? 'currentColor' : 'black';
                                            })()}
                                          />
                                        </button>

                                        {/* Info button */}
                                        <Link to={`/movie/${encodeId(part.id)}`} className="bg-black/60 border border-white/40 rounded-full p-2 transform transition-transform hover:scale-110 z-20 group/info relative">
                                          <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/info:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                                            {t('common.viewPoster')}
                                          </div>
                                          <Info className="w-4 h-4 text-white" />
                                        </Link>
                                      </div>
                                    </div>

                                    {/* Bottom section: information */}
                                    <div className="p-3 flex flex-col flex-grow">
                                      <h3 className="text-sm font-bold text-white line-clamp-1 mb-1">
                                        {part.title}
                                      </h3>
                                      <div className="flex items-center gap-2 mt-1 mb-2">
                                        <div className="flex items-center gap-1">
                                          <Star className="w-3 h-3 text-yellow-400" />
                                          <span className="text-xs text-gray-300">
                                            {part.vote_average ? part.vote_average.toFixed(1) : 'N/A'}
                                          </span>
                                        </div>
                                        {part.release_date && (
                                          <div className="flex items-center gap-1">
                                            <Calendar className="w-3 h-3 text-gray-400" />
                                            <span className="text-xs text-gray-300">
                                              {new Date(part.release_date).getFullYear()}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                      {part.id === Number(id) && (
                                        <div className="bg-red-600 text-white text-xs px-2 py-1 rounded-full self-start">
                                          {t('details.currentBadge')}
                                        </div>
                                      )}

                                      {/* Ajout du résumé pour l'overview */}
                                      {part.overview && (
                                        <p className="text-xs text-gray-300 mt-2 line-clamp-3">
                                          {part.overview}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </motion.div>
                            ))}
                        </motion.div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                      <Film className="w-8 h-8 mb-2" />
                      <p>{t('details.noSagaInfoAvailable')}</p>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* Lecteur vidéo */}
        <motion.div
          id="video-player-section"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="mt-12 space-y-6"
        >
          <h2 className="text-2xl font-bold mb-4">{t('details.watchBtn')}</h2>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
            className="aspect-w-16 aspect-h-9 relative"
          >
            {!isAvailable ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center h-[500px] bg-black rounded-lg"
              >
                <motion.p
                  className="text-gray-400"
                  animate={{
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity
                  }}
                >
                  {t('details.movieNotYetAvailable')}
                </motion.p>
              </motion.div>
            ) : !isReleased && !showPlayerAnyway ? (
              <motion.div
                className="h-[500px] flex flex-col items-center justify-center bg-black/70 rounded-lg p-6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5 }}
              >
                <Film className="w-16 h-16 text-yellow-500 mb-4" />
                <motion.h3
                  className="text-2xl font-bold text-white mb-2"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  {t('details.movieNotYetReleased')}
                </motion.h3>
                <motion.p
                  className="text-gray-300 text-center max-w-md mb-6"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.3 }}
                >
                  {t('details.movieNotYetReleasedDesc')}
                </motion.p>
                <motion.button
                  className="px-6 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  onClick={() => setShowPlayerAnyway(true)}
                >
                  {t('details.continueAnyway')}
                </motion.button>
              </motion.div>
            ) : (
              // Display cinema mode button in place of video player
              <motion.div
                className="h-[500px] flex flex-col items-center justify-center bg-gradient-to-b from-black/40 to-black/80 rounded-lg p-6"
                style={{
                  backgroundImage: movie?.backdrop_path
                    ? `linear-gradient(to bottom, rgba(0,0,0,0.6), rgba(0,0,0,0.8)), url(https://image.tmdb.org/t/p/original${movie.backdrop_path})`
                    : undefined,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5 }}
              >
                <motion.div
                  className="w-24 h-24 rounded-full bg-red-600/80 hover:bg-red-600 flex items-center justify-center mb-6 cursor-pointer"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={handleWatchClick}
                >
                  <Play className="w-12 h-12 text-white ml-2" />
                </motion.div>
                <motion.h3
                  className="text-2xl font-bold text-white mb-2"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  {movie?.title || t('details.clickToPlayTitle')}
                </motion.h3>
                <motion.p
                  className="text-gray-300 text-center max-w-md"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.3 }}
                >
                  {t('details.clickToPlayDesc')}
                </motion.p>
              </motion.div>
            )}
          </motion.div>
        </motion.div>

        {/* Section Films Similaires — pas de break-out : on laisse le wrapper
            page (px-4 md:px-8 lg:px-16) gérer le padding gauche/droit, comme
            le reste du contenu de la page. Le pattern visuel reste celui d'une
            content row Home (EmblaCarousel applique son propre -mx-3 md:-mx-4
            interne). */}
        {recommendations.length > 0 && (
          <LazySection
            index={0}
            immediateLoadCount={0}
            rootMargin="300px"
            minHeight="320px"
            className="mt-12"
          >
            <EmblaCarousel
              title={<span><span className="text-red-600 mr-2">🔥</span>{t('details.similarMovies')}</span>}
              items={recommendations.map(movie => ({
                id: movie.id,
                title: movie.title,
                poster_path: movie.poster_path,
                backdrop_path: movie.backdrop_path,
                overview: movie.overview,
                vote_average: movie.vote_average,
                release_date: movie.release_date,
                media_type: 'movie',
              }))}
              mediaType="movie-similar"
            />
          </LazySection>
        )}

        {/* Section Commentaires - Lazy loaded when approaching viewport.
            Ref ancré sur le wrapper (toujours rendu) pour que le bouton
            "Commentaires" puisse scroller avant le chargement lazy. */}
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
              <CommentsSection contentType="movie" contentId={id!} />
            </motion.div>
          </LazySection>
        </div>

        {/* Modal Rapport */}




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

        {/* Modal pour la bande-annonce */}
        {showTrailerPopup && (
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
                    <h3 className="text-xl font-semibold text-white">{t('details.bandeAnnonce')} - {movie?.title}</h3>
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
                    {trailerVideoId ? (
                      <iframe
                        src={`https://www.youtube.com/embed/${trailerVideoId}?autoplay=1`}
                        title={`${t('details.bandeAnnonce')} - ${movie?.title}`}
                        className="w-full h-[300px] sm:h-[400px] md:h-[500px] lg:h-[600px]"
                        allowFullScreen
                        allow="autoplay"
                      ></iframe>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center bg-gray-900">
                        <Film className="w-12 h-12 text-gray-600 mb-4" />
                        <p className="text-gray-400 text-lg">{t('details.noTrailerAvailable')}</p>
                      </div>
                    )}
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


      </motion.div>
    </MotionConfig>
  );
};

export default MovieDetails;
