import { motion, AnimatePresence } from 'framer-motion';
import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, memo, useMemo } from 'react';
import type HlsType from 'hls.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Rewind, FastForward, Volume1, ChevronRight, PictureInPicture, Users, Loader2, Repeat, Cast, Airplay, Info, X, Copy, Check, Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import type pakoType from 'pako';

let HlsLib: typeof HlsType | null = null;
const loadHls = async (): Promise<typeof HlsType> => {
  if (HlsLib) return HlsLib;
  const mod = await import('hls.js');
  HlsLib = mod.default;
  return HlsLib;
};

let pakoLib: typeof pakoType | null = null;
const loadPako = async (): Promise<typeof pakoType> => {
  if (pakoLib) return pakoLib;
  const mod = await import('pako');
  pakoLib = mod.default;
  return pakoLib;
};
import HLSPlayerSettingsPanel from './HLSPlayerSettingsPanel';
import { toast } from 'sonner';
import { isUserVip } from '../utils/authUtils';
import { isExtensionAvailable } from '../utils/extensionProxy';
import { isDnsLikeError, notifyDnsBlocked } from '../utils/dnsErrorDetection';
import { isLowLatencyEnabled } from '../utils/lowLatencyPref';
import {
  initializeCastApi,
  requestCastSession,
  loadMediaOnCastWithFallback,
  parseM3u8Manifest,
  selectBestStream,
  preferFrenchAudioVariant,
  initializeAirPlay,
  requestAirPlay,
  isAirPlaySupported,
  isRemotePlaybackSupported,
} from '../utils/castUtils';
import { useAntiSpoilerSettings } from '../hooks/useAntiSpoilerSettings';
import { useTranslation } from 'react-i18next';
import { encodeId } from '../utils/idEncoder';
import { RIVESTREAM_PROXIES } from '../config/rivestreamProxy';
import { PROXY_BASE_URL, PROXIES_EMBED_API } from '../config/runtime';
import { getTmdbLanguage } from '../i18n';
import { getCoflixPreferredUrl } from '../utils/coflix';
import { safePlay } from '../utils/safePlay';
import ReactCountryFlag from 'react-country-flag';
import { PinButton } from './ui/PinButton';
import {
  getSourcePriorityPrefs,
  subscribeToPriorityChanges,
  pinSource,
  unpinSource,
  pinHoster,
  unpinHoster,
} from '../utils/sourcePriorityPrefs';
import { detectHoster } from '../utils/hosterRegistry';
import { sortHostersByPriority } from '../utils/sourceAutoSelect';
import type {
  HosterId, TopLevelSourceId, LanguageId, PriorityCategory,
} from '../types/sourcePriority';

// Milestone 4 — mapping des `source.type` (top-level row) vers `TopLevelSourceId`.
// Doit rester en phase avec `SOURCE_MAIN_TO_TOP_LEVEL` dans HLSPlayerSettingsPanel.tsx.
const SOURCE_MAIN_TO_TOP_LEVEL: Record<string, TopLevelSourceId> = {
  darkino_main: 'darkino',
  fstream_main: 'fstream',
  wiflix_main: 'wiflix',
  j1f_main: 'j1f',
  omega_main: 'omega',
  multi_main: 'coflix',
  viper_main: 'viper',
  vox_main: 'vox',
  bravo_main: 'bravo',
  rivestream_main: 'rivestream_hls',
  vostfr_main: 'vostfr',
  frembed_main: 'frembed',
  mp4: 'mp4',
  custom: 'custom',
};


// Add TMDB API key
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// Constante pour contrôler la vérification VIP pour Rivestream
const ENABLE_RIVESTREAM_VIP_CHECK = false;

// Helper function to check if Rivestream is available (VIP check if enabled)
const isRivestreamAvailable = (): boolean => {
  if (!ENABLE_RIVESTREAM_VIP_CHECK) {
    return true; // Si la vérification VIP est désactivée, Rivestream est toujours disponible
  }
  return isUserVip();
};

// Helper function to extract original URL from proxy URL
const getOriginalUrl = (url: string): string => {
  const proxyPrefix = `${PROXY_BASE_URL}/proxy/`;
  if (PROXY_BASE_URL && url.includes(proxyPrefix)) {
    return url.replace(proxyPrefix, '');
  }
  return url;
};

// Add this utility at the top of the component (after imports, before HLSPlayer)
const clampVolume = (v: number) => Math.max(0, Math.min(1, v));

const normalizeUqloadEmbedUrl = (url: string): string => {
  return url
    .replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is')
    .replace(/uqload%2e[a-z0-9-]+/gi, 'uqload%2eis');
};

// On DNS-level ISP blocks, cascading through every remaining HLS source is
// wasteful: they all use similar domains that the ISP is likely blocking
// the same way. This helper short-circuits the cascade by dispatching a
// sourceChange event for the first available embed (Omega, then Coflix).
// Returns true if an embed was dispatched (caller should skip the normal
// HLS cascade), false if no embed available.
const dispatchDnsEmbedFallback = (
  currentSrc: string,
  omegaSources?: unknown[],
  coflixSources?: unknown[]
): boolean => {
  if (omegaSources && omegaSources.length > 0) {
    const omega = omegaSources[0] as { link?: string };
    if (omega?.link) {
      console.log('🎬 DNS block detected — jumping straight to Omega embed');
      window.dispatchEvent(new CustomEvent('sourceChange', {
        detail: {
          type: 'omega',
          id: 'omega_0',
          url: omega.link,
          origin: 'dns-auto-fallback',
          fromSrc: currentSrc,
        },
      }));
      return true;
    }
  }
  if (coflixSources && coflixSources.length > 0) {
    const coflix = coflixSources[0];
    if (coflix) {
      console.log('🎬 DNS block detected — jumping straight to Coflix embed');
      window.dispatchEvent(new CustomEvent('sourceChange', {
        detail: {
          type: 'coflix',
          id: 'coflix_0',
          url: getCoflixPreferredUrl(coflix),
          origin: 'dns-auto-fallback',
          fromSrc: currentSrc,
        },
      }));
      return true;
    }
  }
  return false;
};

const SOURCE_STREAM_QUALITY_CACHE_EVENT = 'movix:source-stream-quality-cache-updated';
const sourceStreamQualityCache = new Map<string, string>();
const sourceStreamBitrateEstimateCache = new Map<string, number>();

const getSourceQualityCacheKeys = (sourceUrl?: string | null): string[] => {
  if (!sourceUrl) return [];

  const normalizedUrl = normalizeUqloadEmbedUrl(sourceUrl);
  return normalizedUrl === sourceUrl ? [sourceUrl] : [sourceUrl, normalizedUrl];
};

const getInitialSourceQualityState = (): Record<string, string> => {
  return Object.fromEntries(sourceStreamQualityCache.entries());
};

const SourceQualityMeta = ({ qualityLabel, isActive = false }: { qualityLabel: string; isActive?: boolean }) => {
  const { t } = useTranslation();
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const hasEstimatedBitrate = /~\s*\d+\s*kbps/i.test(qualityLabel);
  const labelClassName = `text-[11px] ${isActive ? 'text-red-300' : 'text-gray-500'}`;

  if (!hasEstimatedBitrate) {
    return (
      <span className={`mt-1 ${labelClassName}`}>
        {qualityLabel}
      </span>
    );
  }

  return (
    <span
      className="relative mt-1 inline-flex w-fit max-w-full flex-col"
      onMouseEnter={() => setIsTooltipVisible(true)}
      onMouseLeave={() => setIsTooltipVisible(false)}
      onFocus={() => setIsTooltipVisible(true)}
      onBlur={() => setIsTooltipVisible(false)}
      tabIndex={0}
    >
      <span className={`${labelClassName} cursor-help decoration-dotted underline underline-offset-2`}>
        {qualityLabel}
      </span>
      <AnimatePresence>
        {isTooltipVisible && (
          <motion.span
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="pointer-events-none absolute left-0 top-full z-[120] mt-2 w-64 rounded-lg border border-white/10 bg-black/95 px-3 py-2 text-left text-[10px] leading-relaxed text-gray-100 shadow-2xl"
          >
            {t('watch.estimatedBitrateTooltip')}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
};

// Helper function to detect if URL is MP4 (even in proxy URLs with encoded parameters)
const isMP4Source = (url: string): boolean => {
  const normalizedUrl = normalizeUqloadEmbedUrl(url);
  const lowerUrl = normalizedUrl.toLowerCase();

  // Direct MP4 detection
  if (lowerUrl.endsWith('.mp4') || lowerUrl.includes('.mp4?')) {
    return true;
  }

  // Check for proxy URLs with encoded parameters
  if (lowerUrl.includes('proxy') && lowerUrl.includes('url=')) {
    try {
      // Try to decode the URL parameter
      const urlMatch = normalizedUrl.match(/url=([^&]+)/);
      if (urlMatch && urlMatch[1]) {
        const decodedUrl = decodeURIComponent(urlMatch[1]).toLowerCase();
        if (decodedUrl.includes('.mp4')) {
          return true;
        }
      }
    } catch (e) {
      console.warn('❌ Failed to decode proxy URL:', e);
    }
  }

  // Check for UQLOAD proxified URLs - these are treated as MP4 streams
  // Format: proxy/https%3A%2F%2Fuqload.is%2Fembed-...
  if (lowerUrl.includes('proxy') && lowerUrl.includes('uqload')) {
    return true;
  }

  // Check for specific proxy patterns
  if ((
    (PROXY_BASE_URL && lowerUrl.includes(`${PROXY_BASE_URL.toLowerCase()}/proxy/`)) ||
    (PROXIES_EMBED_API && lowerUrl.includes(`${PROXIES_EMBED_API.toLowerCase()}/proxy/`)) ||
    lowerUrl.includes('localhost') ||
    lowerUrl.includes('127.0.0.1')
  ) && lowerUrl.includes('.mp4')) {
    return true;
  }
  
  // DoodStream - extracted URLs are MP4 (from extension or proxy)
  if (lowerUrl.includes('doodstream-proxy') || lowerUrl.includes('d0000d.com') || lowerUrl.includes('cloudatacdn') || lowerUrl.includes('doodstream.com') || lowerUrl.includes('dood.') || lowerUrl.includes('myvidplay.com') || lowerUrl.includes('dsvplay.com') || lowerUrl.includes('doply.net')) {
    return true;
  }

  // Check for sibnet
  if (lowerUrl.includes('sibnet.ru') && lowerUrl.includes('.mp4')) {
    return true;
  }

  return false;
};

// Utility function to create HLS config based on domain
const createHlsConfig = (src: string) => {
  const isPulseTopstrime = src.includes('pulse.topstrime.online');
  const isServersicuro = src.includes('serversicuro.cc');

  if (isPulseTopstrime) {
    console.log('🔧 Applying pulse.topstrime.online optimizations: limited concurrent requests (max 4 segments)');
  }

  if (isServersicuro) {
    console.log('🔧 Applying serversicuro.cc optimizations: enhanced audio support and buffer management');
  }

  return {
    enableWorker: true,
    lowLatencyMode: isLowLatencyEnabled('movies'), // opt-in via Settings › Performance
    startFragPrefetch: !isPulseTopstrime, // Désactiver le prefetch pour pulse.topstrime.online
    backBufferLength: isPulseTopstrime ? 30 : (isServersicuro ? 60 : 90),
    maxBufferLength: isPulseTopstrime ? 4 : (isServersicuro ? 20 : 30), // Augmenter pour serversicuro
    maxMaxBufferLength: isPulseTopstrime ? 8 : (isServersicuro ? 300 : 600), // Augmenter pour serversicuro
    maxBufferSize: isPulseTopstrime ? 4 * 1000 * 1000 : (isServersicuro ? 30 * 1000 * 1000 : 60 * 1000 * 1000), // Augmenter pour serversicuro
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 2,
    // Configuration pour prévenir les erreurs de buffer append
    appendErrorMaxRetry: 5,
    enableSoftwareAES: true, // Utiliser le déchiffrement logiciel pour éviter les problèmes de codec
    // Configuration de buffer plus conservatrice pour éviter les erreurs
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    maxSeekHole: 2,
    // Configuration spécifique pour serversicuro.cc
    ...(isServersicuro && {
      maxLoadingDelay: 4000,
      fragLoadingTimeOut: 20000, // Timeout plus long pour les fragments
      manifestLoadingTimeOut: 20000, // Timeout plus long pour le manifest
      levelLoadingTimeOut: 20000, // Timeout plus long pour les niveaux
      fragLoadingMaxRetry: 3, // Plus de tentatives pour serversicuro
      levelLoadingMaxRetry: 3,
      manifestLoadingMaxRetry: 3,
      // Configuration pour gérer les problèmes de codec
      forceKeyFrameOnDiscontinuity: true,
      forceKeyFrameOnStart: true,
      // Configuration de buffer plus robuste
      liveBackBufferLength: 30,
      liveMaxBackBufferLength: 60
    }),
    // Limiter les requêtes simultanées pour pulse.topstrime.online
    ...(isPulseTopstrime && {
      maxLoadingDelay: 6000, // Délai max entre les requêtes (plus long)
      fragLoadingTimeOut: 30000, // Timeout plus long pour les fragments
      manifestLoadingTimeOut: 15000, // Timeout pour le manifest
      levelLoadingTimeOut: 15000, // Timeout pour les niveaux
      fragLoadingMaxRetry: 1, // Moins de tentatives automatiques
      levelLoadingMaxRetry: 1,
      manifestLoadingMaxRetry: 1
    })
  };


};

// ── Cinep (topstream/purstream) subtitles ─────────────────────────────────
// Some cinep masters declare #EXT-X-MEDIA:TYPE=SUBTITLES with a URI pointing
// straight at a .vtt file. hls.js expects that URI to be an m3u8 playlist and
// hard-fails with "Missing #EXTM3U", which kills the whole source. Replace such
// direct subtitle URIs with an inline data: playlist (one segment = the raw
// .vtt) so hls.js parses a valid playlist, then fetches the .vtt DIRECTLY — the
// browser extension injects the required Referer/Origin headers, no proxy
// server involved. Video segments stay direct too. Idempotent: already-wrapped
// (data:) or real playlist URIs pass through untouched.
const rewriteCinepSubtitleUris = (text: string, baseUrl: string): string => {
  if (!text || text.indexOf('#EXT-X-MEDIA:') === -1) return text;
  return text.split('\n').map((line) => {
    if (!/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=SUBTITLES/i.test(line)) return line;
    return line.replace(/URI="([^"]+)"/i, (whole, uri) => {
      if (/^data:/i.test(uri)) return whole; // already wrapped
      let abs: string;
      try { abs = new URL(uri, baseUrl).href; } catch { return whole; }
      const path = abs.split('?')[0].toLowerCase();
      if (!(path.endsWith('.vtt') || path.endsWith('.srt'))) return whole; // real playlist
      if (abs.includes('/cinep-proxy')) return whole; // server already wrapped it (VIP path)
      const wrapper =
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:999999\n' +
        '#EXT-X-MEDIA-SEQUENCE:0\n' +
        '#EXTINF:999999.0,\n' +
        abs + '\n' +
        '#EXT-X-ENDLIST\n';
      return `URI="data:application/vnd.apple.mpegurl,${encodeURIComponent(wrapper)}"`;
    });
  }).join('\n');
};

// Playlist loader that post-processes the master playlist to fix direct-.vtt
// subtitle declarations (see rewriteCinepSubtitleUris). Only attached for
// cinep/purstream sources; extends the default loader so xhrSetup/proxy still apply.
const makeCinepSubtitlePLoader = (HlsCtor: typeof HlsType): any => {
  const BaseLoader: any = (HlsCtor as any).DefaultConfig.loader;
  return class CinepSubtitlePLoader extends BaseLoader {
    load(context: any, config: any, callbacks: any) {
      const originalOnSuccess = callbacks.onSuccess;
      callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
        try {
          if (response && typeof response.data === 'string') {
            response.data = rewriteCinepSubtitleUris(response.data, ctx?.url || context?.url || '');
          }
        } catch { /* pass through unmodified on any error */ }
        originalOnSuccess(response, stats, ctx, networkDetails);
      };
      super.load(context, config, callbacks);
    }
  };
};

// True when an hls.js error is about loading/parsing a subtitle track/file.
// Used to keep a broken subtitle from killing video playback.
const isSubtitleLoadError = (data: any): boolean => {
  const details = typeof data?.details === 'string' ? data.details.toLowerCase() : '';
  if (details.includes('subtitle')) return true;
  const url = data?.url || data?.frag?.url || data?.context?.url || '';
  return /\.(vtt|srt)([?&]|$)/i.test(url);
};

// Global variables to track failed segments for retry
const failed429Segments: Set<number> = new Set();
let retryTimeout: NodeJS.Timeout | null = null;

// Function to clear failed segments when playback is successful
const clearFailed429Segments = () => {
  if (failed429Segments.size > 0) {
    console.log(`✅ Clearing ${failed429Segments.size} failed segments from retry list`);
    failed429Segments.clear();
  }
};

// Utility function to handle 429 errors with smart retry logic
const handle429Error = (hls: any, videoRef: React.RefObject<HTMLVideoElement>, data: any, currentSrc: string = '') => {
  const failedUrl = data.frag?.url || data.url || 'unknown';
  const isTopstrime = failedUrl.includes('pulse.topstrime.online');

  // Check for Rivestream proxy rotation
  const isProxyUrl = failedUrl.includes('.workers.dev/proxy?url=');
  const currentProxyIndex = RIVESTREAM_PROXIES.findIndex(proxy => failedUrl.includes(proxy));

  if (currentProxyIndex !== -1 || isProxyUrl) {
    console.log('🚨 Rivestream Proxy 429 detected, switching proxy...');
    const nextProxyIndex = currentProxyIndex !== -1 ? (currentProxyIndex + 1) % RIVESTREAM_PROXIES.length : 0;
    const nextProxy = RIVESTREAM_PROXIES[nextProxyIndex];

    let newUrl;
    if (currentProxyIndex !== -1) {
      const currentProxy = RIVESTREAM_PROXIES[currentProxyIndex];
      newUrl = failedUrl.replace(currentProxy, nextProxy);
      console.log(`🔄 Switching from ${currentProxy} to ${nextProxy}`);
    } else {
      try {
        const urlObj = new URL(failedUrl);
        const oldHost = urlObj.host;
        urlObj.host = nextProxy;
        newUrl = urlObj.toString();
        console.log(`🔄 Switching from ${oldHost} (proxy pattern detected) to ${nextProxy}`);
      } catch (e) {
        newUrl = failedUrl.replace(/^(https?:\/\/)[^\/]+/, `$1${nextProxy}`);
      }
    }

    const sourceChangeEvent = new CustomEvent('sourceChange', {
      detail: { type: 'rivestream_hls', url: newUrl, id: 'rivestream_retry', origin: 'auto-fallback', fromSrc: currentSrc || failedUrl }
    });
    window.dispatchEvent(sourceChangeEvent);
    return;
  }

  if (isTopstrime) {
    console.error('🚨 Error 429 detected on pulse.topstrime.online');
  } else {
    console.error('🚨 Error 429 detected');
  }
  console.log('🔍 Failed request details:', failedUrl);

  // Sauvegarder la position actuelle et les informations du fragment qui a échoué
  const currentTime = videoRef.current ? videoRef.current.currentTime : 0;
  const failedFragUrl = data.frag?.url || data.url;
  const failedFragSN = data.frag?.sn; // Sequence number du fragment qui a échoué

  console.log(`🔍 Failed fragment SN: ${failedFragSN}, URL: ${failedFragUrl}`);

  // Ajouter le segment à la liste des segments qui ont échoué
  if (typeof failedFragSN === 'number') {
    failed429Segments.add(failedFragSN);
    console.log(`📝 Added segment ${failedFragSN} to retry list. Total failed segments: ${failed429Segments.size}`);
  }

  // Vérifier si on a trop d'erreurs 429 consécutives
  const retryKey = `429_${isTopstrime ? 'topstrime' : 'other'}`;
  if (!(window as any).error429RetryCount) {
    (window as any).error429RetryCount = {};
  }
  (window as any).error429RetryCount[retryKey] = ((window as any).error429RetryCount[retryKey] || 0) + 1;

  // Si trop d'erreurs 429, déclencher un changement de source
  if ((window as any).error429RetryCount[retryKey] > 3) {
    console.error(`❌ Too many 429 errors (${(window as any).error429RetryCount[retryKey]}), switching source...`);
    (window as any).error429RetryCount[retryKey] = 0; // Reset le compteur


    setTimeout(() => {
      // Déclencher le changement de source via un événement personnalisé
      const sourceChangeEvent = new CustomEvent('forceSourceChange', {
        detail: { reason: 'too_many_429_errors', url: failedUrl }
      });
      window.dispatchEvent(sourceChangeEvent);
    }, 1000);
    return;
  }

  // Arrêter toutes les requêtes en cours
  if (hls) {
    hls.stopLoad();
    console.log('🛑 Stopped all HLS loading operations');
  }

  // Annuler le timeout précédent s'il existe
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }

  // Attendre un délai plus long avant de réessayer pour éviter les 429 répétés
  retryTimeout = setTimeout(() => {
    console.log('🔄 Retrying after 429 error...');
    if (hls && videoRef.current) {
      // Calculer la position exacte du segment qui a échoué
      // En général, chaque segment fait ~10 secondes, mais on utilise la position actuelle
      const targetTime = Math.max(0, currentTime - 5); // Reculer de 5 secondes pour être sûr

      console.log(`🎯 Targeting time: ${targetTime}s to retry failed segment ${failedFragSN}`);

      // Redémarrer le chargement depuis une position légèrement antérieure
      hls.startLoad(targetTime);

      // Repositionner la vidéo sur la position cible
      if (videoRef.current.readyState >= 1) {
        videoRef.current.currentTime = targetTime;
      } else {
        // Si la vidéo n'est pas prête, attendre qu'elle le soit
        const onLoadedMetadata = () => {
          if (videoRef.current) {
            videoRef.current.currentTime = targetTime;
            videoRef.current.removeEventListener('loadedmetadata', onLoadedMetadata);
          }
        };
        videoRef.current.addEventListener('loadedmetadata', onLoadedMetadata);
      }

      console.log(`▶️ Restarted HLS loading from: ${targetTime}s`);
    }
    retryTimeout = null;
  }, 5000); // Attendre 5 secondes pour éviter les 429 répétés
};

// Utility function to reset media element error state
const resetMediaElementError = (videoElement: HTMLVideoElement): Promise<void> => {
  return new Promise((resolve) => {
    console.log('🔧 Resetting media element error state...');

    // Clear any existing error
    if (videoElement.error) {
      console.log('🚨 Media element has error:', videoElement.error.message);
    }

    // Remove source and reload to clear error state
    videoElement.removeAttribute('src');
    videoElement.load();

    // Wait for the element to be ready for new source
    const onEmptied = () => {
      console.log('✅ Media element error state cleared');
      videoElement.removeEventListener('emptied', onEmptied);
      resolve();
    };

    videoElement.addEventListener('emptied', onEmptied);

    // Fallback timeout in case emptied event doesn't fire
    setTimeout(() => {
      videoElement.removeEventListener('emptied', onEmptied);
      resolve();
    }, 500);
  });
};

// Type for next content threshold configuration
type NextContentThreshold =
  | number // Percentage mode (0-100), e.g., 95 for 95%
  | {
    mode: 'percentage';
    value: number; // 0-100
  }
  | {
    mode: 'timeBeforeEnd';
    value: number; // seconds before end, e.g., 120 for 2 minutes
  };

interface HLSPlayerProps {
  src: string;
  controls?: boolean;
  autoPlay?: boolean;
  className?: string;
  poster?: string;
  backdrop?: string; // Add backdrop prop for loading image and control menu background
  onEnded?: () => void;
  onError?: () => void;
  nextMovie?: Movie | null;
  onNextMovie?: (movieId: number) => Promise<void>;
  onIgnore?: () => void;
  tvShow?: {
    name: string;
    backdrop_path?: string;
  } | null;
  nextEpisode?: {
    seasonNumber: number;
    episodeNumber: number;
    name?: string;
    overview?: string;
    vote_average?: number;
  } | null;
  onNextEpisode?: (seasonNumber: number, episodeNumber: number) => void;
  movieId?: string;  // ID TMDB du film
  tvShowId?: string; // ID TMDB de la série
  seasonNumber?: number;
  episodeNumber?: number;
  subtitleUrl?: string; // Optional subtitle URL
  darkinoSources?: any[];
  mp4Sources?: { url: string; label?: string; language?: string; isVip?: boolean }[];
  nexusHlsSources?: { url: string; label: string }[];
  nexusFileSources?: { url: string; label: string }[];
  purstreamSources?: { url: string; label: string }[];
  rivestreamSources?: { url: string; label: string; quality: number; service: string; category: string }[];
  rivestreamCaptions?: { label: string; file: string }[];
  loadingRivestream?: boolean;
  frembedAvailable?: boolean;
  customSources?: string[];
  omegaSources?: any[];
  coflixSources?: any[];
  fstreamSources?: { url: string; label: string; category: string }[];
  wiflixSources?: { url: string; label: string; category: string }[];
  j1fSources?: { url: string; label: string; category: string }[];
  viperSources?: { url: string; label: string; quality: string; language: string }[];
  voxSources?: { name: string; link: string }[];
  onlyQualityMenu?: boolean; // Ajout pour l'affichage du menu qualité seul
  embedType?: string; // Type de la source embed actuellement sélectionnée
  embedUrl?: string;  // URL de la source embed actuellement sélectionnée
  adFreeM3u8Url?: string | null; // URL du m3u8 Lumedia
  onShowEpisodesMenu?: () => void; // Callback pour afficher le menu épisodes depuis HLSPlayer
  onPreviousEpisode?: () => void; // Callback pour naviguer vers l'épisode précédent
  title?: string; // Optional movie title to override TMDB lookup
  initialTime?: number; // Optional starting time in seconds
  selectedCoflixPlayerIndex?: number; // Optional index for Coflix player
  selectedOmegaPlayerIndex?: number; // Optional index for Omega player
  isAnime?: boolean; // Nouvelle prop pour distinguer les animes des séries normales

  // New props for WatchPartyRoom integration
  videoRef?: React.RefObject<HTMLVideoElement>; // To pass video element ref to parent
  isPlaying?: boolean; // Controlled play/pause state from parent
  onPlayerPlay?: () => void;      // Callback when video plays
  onPlayerPause?: () => void;     // Callback when video pauses
  onPlayerTimeUpdate?: (currentTime: number) => void; // Callback for time updates
  onPlayerSeeked?: () => void;      // Callback when seeking is complete
  onPlayerEnded?: () => void;       // Callback when video ends (distinct from original onEnded for different purposes)

  // New prop to determine if the user is a guest in a watch party
  isWatchPartyGuest?: boolean;     // If true, user cannot use progress bar or forward/backward buttons

  // New props for episodes menu integration
  episodes?: EpisodeInfo[];
  seasons?: Season[];
  showTitle?: string;
  currentEpisodeInfo?: EpisodeInfo | null;
  onEpisodeSelect?: (seasonNumber: number, episodeNumber: number) => void;

  // Threshold configuration for when to show next episode/movie popup
  // Examples:
  //   - 95 (simple number = percentage mode)
  //   - { mode: 'percentage', value: 90 }
  //   - { mode: 'timeBeforeEnd', value: 120 } (120 seconds = 2 minutes before end)
  nextContentThreshold?: NextContentThreshold; // Default: 95 (percentage)
  onShowSources?: () => void; // Callback to show sources menu

  /**
   * Catégorie de priorité utilisateur appliquée au tri des hosters dans le panel
   * Serveurs. `'moviesTv'` pour WatchMovie/WatchTv, `'anime'` pour WatchAnime.
   * Par défaut `'moviesTv'` côté panel si non fourni.
   */
  priorityCategory?: 'moviesTv' | 'anime';
}

interface MovieInfo {
  title: string;
  overview: string;
  releaseDate: string;
  rating: number;
  runtime: number;
}

interface Quality {
  height: number;
  url: string | string[];
}

interface AudioTrack {
  id: number;
  name: string;
  language: string;
  groupId: string;
}

interface Movie {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  runtime: number;
  poster_path: string;
}

interface EpisodeInfo {
  id: number;
  name: string;
  episode_number: number;
  air_date?: string;
  overview?: string;
  still_path?: string | null;
  vote_average?: number;
}

interface Season {
  id: number;
  season_number: number;
  episode_count: number;
  name: string;
}

interface WatchProgress {
  position: number;
  timestamp: string;
  duration: number;
}

interface NextEpisodePromptProps {
  showPrompt: boolean;
  nextEpisode?: {
    title?: string;
    name?: string;
    episode_number?: number;
    season_number?: number;
    episodeNumber?: number;
    seasonNumber?: number;
    overview?: string;
    still_path?: string;
    vote_average?: number;
  } | null;
  tvShow?: {
    name: string;
    backdrop_path?: string;
  } | null;
  onPlay: () => void;
  onIgnore: () => void;
  shouldHide: (contentType: 'seasonImages' | 'episodeNames' | 'episodeImages' | 'episodeOverviews' | 'nextEpisodeInfo') => boolean;
  getMaskedContent: (originalContent: string, contentType: 'seasonImages' | 'episodeNames' | 'episodeImages' | 'episodeOverviews' | 'nextEpisodeInfo', maskText?: string, episodeNumber?: number) => string;
}

// Add new interface for subtitle styling
interface SubtitleStyle {
  fontSize: number; // Font size in rem (0.5 to 3)
  backgroundOpacity: number; // Background opacity (0 to 1)
  color: string; // Hex color code (e.g., #ffffff, #ffff00)
  delay: number; // Delay in seconds (can be negative for early display)
}

// Add new interface for zoom functionality
interface ZoomState {
  scale: number;
  translateX: number;
  translateY: number;
  isZoomed: boolean;
}

// Ajouter de nouvelles interfaces pour les types de sources
interface SourceOption {
  type: string;
  id: string;
  label: string;
  url: string;
  isActive?: boolean;
  quality?: string;
  language?: string;
}

interface SourceGroup {
  type: 'hls' | 'embed';
  title: string;
  sources: SourceOption[];
}

// Add the helper function here
const capitalizeFirstLetter = (string: string | undefined | null): string => {
  if (!string) return '';
  return string.charAt(0).toUpperCase() + string.slice(1);
};

// Extend Window interface for Chromecast
declare global {
  interface Window {
    chrome?: {
      cast?: {
        isAvailable: boolean;
        initialize: (apiConfig: any, onInitSuccess: () => void, onInitError: (error: any) => void) => void;
        requestSession: (onSuccess: (session: any) => void, onError: (error: any) => void) => void;
        SessionRequest: new (applicationId: string) => any;
        ApiConfig: new (sessionRequest: any, onSessionSuccess: (session: any) => void, onReceiverAvailable: (availability: string) => void) => any;
        media: {
          MediaInfo: new (contentId: string, contentType: string) => any;
          MovieMediaMetadata: new () => any;
          LoadRequest: new (mediaInfo: any) => any;
        };
      };
    };
  }
  namespace JSX {
    interface IntrinsicElements {
      'google-cast-launcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

// Add MAIN_API from env

// Ajouter ces types pour les API propriétaires de WebKit juste après les interfaces existantes
interface HTMLVideoElementWithWebkit extends HTMLVideoElement {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitShowPlaybackTargetPicker?: () => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitWirelessVideoPlaybackDisabled?: boolean;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

// Define a ref type to expose HLSPlayer controls
export interface HLSPlayerRef {
  play: () => Promise<void>;
  pause: () => void;
  seek: (time: number) => void;
  seekTo: (time: number) => void;
  getDuration: () => number;
  getCurrentTime: () => number;
  isPaused: () => boolean;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  getVideoElement: () => HTMLVideoElement | null;
}

// Convert HLSPlayer to use forwardRef
const HLSPlayer = forwardRef<HLSPlayerRef, HLSPlayerProps>(({
  src,
  controls = true,
  autoPlay = true,
  className = '',
  poster,
  backdrop,
  nextMovie,
  onNextMovie,
  onIgnore,
  tvShow,
  nextEpisode,
  onNextEpisode,
  movieId,
  tvShowId,
  seasonNumber,
  episodeNumber,
  onEnded,
  onError,
  subtitleUrl,
  darkinoSources = [],
  mp4Sources = [],
  nexusHlsSources = [],
  nexusFileSources = [],
  purstreamSources = [],
  rivestreamSources = [],
  rivestreamCaptions = [],
  loadingRivestream = false,
  frembedAvailable = false,
  customSources = [],
  omegaSources = [],
  coflixSources = [],
  fstreamSources = [],
  wiflixSources = [],
  j1fSources = [],
  viperSources = [],
  voxSources = [],
  onlyQualityMenu = false,
  embedType,
  embedUrl,
  adFreeM3u8Url = null,
  onShowEpisodesMenu,
  onPreviousEpisode,
  title,
  initialTime,
  isAnime = false,
  isWatchPartyGuest,
  episodes = [],
  seasons = [],
  showTitle,
  currentEpisodeInfo,
  onEpisodeSelect,
  nextContentThreshold = 95, // Default to 95%
  // WatchPartyRoom integration props
  onPlayerPlay,
  onPlayerPause,
  onPlayerSeeked,
  onPlayerEnded,
  onShowSources,
  priorityCategory,
}, ref) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  // Lazy-loaded HLS.js constructor — see loadHls() at top of file. Stored in state
  // so effects depending on it re-run after the first dynamic import resolves.
  // Initial value MUST be wrapped in `() => HlsLib`: once the dynamic import has
  // resolved, HlsLib points to the Hls *class*. Passing it directly makes React's
  // useState see `typeof === 'function'` and invoke it as a lazy initializer
  // without `new` — which a class constructor rejects with
  // "Class constructor e cannot be invoked without 'new'" on every remount
  // (e.g. when the parent's `key` changes after a source switch).
  const [Hls, setHls] = useState<typeof HlsType | null>(() => HlsLib);
  useEffect(() => {
    if (Hls) return;
    let cancelled = false;
    void loadHls().then((lib) => {
      if (!cancelled) setHls(() => lib);
    });
    return () => { cancelled = true; };
  }, [Hls]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [volume, setVolume] = useState(() => {
    const savedVolume = localStorage.getItem('playerVolume');
    return savedVolume ? parseFloat(savedVolume) : 1;
  });

  // Anti-spoiler settings
  const { shouldHide, getMaskedContent } = useAntiSpoilerSettings();
  const [isLooping, setIsLooping] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(1); // Store volume before mute
  
  // Volume booster state (up to 300%)
  const [volumeBoost, setVolumeBoost] = useState(() => {
    const savedBoost = localStorage.getItem('playerVolumeBoost');
    return savedBoost ? parseFloat(savedBoost) : 1;
  });
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  // Audio Enhancer nodes
  const bassFilterRef = useRef<BiquadFilterNode | null>(null);
  const trebleFilterRef = useRef<BiquadFilterNode | null>(null);
  const midFilterRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);

  // Audio Enhancer state
  const [audioEnhancerMode, setAudioEnhancerMode] = useState<'off' | 'cinema' | 'music' | 'dialogue' | 'custom'>(() => {
    return (localStorage.getItem('playerAudioEnhancer') as any) || 'off';
  });

  // Custom audio enhancer values
  const [customAudio, setCustomAudio] = useState(() => {
    const saved = localStorage.getItem('playerCustomAudio');
    return saved ? JSON.parse(saved) : {
      bassGain: 0, bassFreq: 200,
      midGain: 0, midFreq: 2000, midQ: 1,
      trebleGain: 0, trebleFreq: 6000,
      compThreshold: 0, compRatio: 1, compKnee: 40, compAttack: 0, compRelease: 0.25
    };
  });

  // Video OLED smoothing state
  const [videoOledMode, setVideoOledMode] = useState<'off' | 'natural' | 'cinema' | 'vivid' | 'custom'>(() => {
    return (localStorage.getItem('playerVideoOled') as any) || 'off';
  });

  // Custom video OLED values
  const [customOled, setCustomOled] = useState(() => {
    const defaults = { contrast: 1, saturate: 1, brightness: 1, sepia: 0 };
    const saved = localStorage.getItem('playerCustomOled');
    if (!saved) return defaults;
    try {
      const parsed = JSON.parse(saved);
      // Merge with defaults so older saved values without all fields don't crash .toFixed()
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState<TimeRanges | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [show403Error, setShow403Error] = useState(false);
  const show403ErrorRef = useRef(false);
  const forbiddenSourceSwitchInFlightRef = useRef(false);
  
  // Sync ref with state
  useEffect(() => {
    show403ErrorRef.current = show403Error;
  }, [show403Error]);

  useEffect(() => {
    forbiddenSourceSwitchInFlightRef.current = false;
    show403ErrorRef.current = false;
    setShow403Error(false);
  }, [src]);
  
  const [, setIsBuffering] = useState(false);
  const bufferingTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout ref for buffering indicator delay
  const sourceTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout ref for automatic source switching
  const [showSettings, setShowSettings] = useState(false);
  const [, setQualities] = useState<Quality[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number | 'auto'>('auto');
  const [sourceStreamQualities, setSourceStreamQualities] = useState<Record<string, string>>(() => getInitialSourceQualityState());
  const [copiedSourceUrl, setCopiedSourceUrl] = useState<string | null>(null);
  const copiedSourceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [subtitles, setSubtitles] = useState<TextTrack[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<string>('off');
  // External subtitles (OpenSubtitles) states
  const [availableExternalLangCodes, setAvailableExternalLangCodes] = useState<Set<string> | null>(null);
  const [externalLangsLoading, setExternalLangsLoading] = useState(false);
  const allExternalLanguages = useMemo(
    () => {
      const localizedLanguages = t('watch.externalSubtitleLanguages', { returnObjects: true });
      if (!localizedLanguages || typeof localizedLanguages !== 'object') {
        return [];
      }

      return Object.entries(localizedLanguages as Record<string, string>).map(([code, label]) => ({
        code,
        label,
      }));
    },
    [t, i18n.language, i18n.resolvedLanguage]
  );
  // Filter to only show languages that have subtitles available for this movie/episode
  const externalLanguages = useMemo(
    () => {
      if (availableExternalLangCodes === null) return allExternalLanguages;
      return allExternalLanguages.filter(lang => availableExternalLangCodes.has(lang.code));
    },
    [allExternalLanguages, availableExternalLangCodes]
  );
  const [selectedExternalLang, setSelectedExternalLang] = useState<string | null>(null);
  const [selectedExternalSub] = useState<any | null>(null);
  const [externalSubs, setExternalSubs] = useState<any[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [loadingSubtitle, setLoadingSubtitle] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout>();
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState<number>(0);
  const [settingsTab, setSettingsTab] = useState<'quality' | 'subtitles' | 'audio' | 'style' | 'format' | 'speed' | 'progression' | 'enhancer' | 'oled'>('quality'); // Add 'progression', 'enhancer', 'oled'
  // Nouvel état pour la largeur du menu paramètres
  const [settingsMenuWidth, setSettingsMenuWidth] = useState(0);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const sourceMenuRef = useRef<HTMLDivElement>(null);

  const isSourceMenuTarget = useCallback((target: EventTarget | null) => {
    return target instanceof HTMLElement && !!target.closest('[data-source-menu]');
  }, []);

  const scrollSourceMenuTargetIntoView = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;

    const focusableTarget = target.closest<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );

    if (!focusableTarget) return;

    window.requestAnimationFrame(() => {
      focusableTarget.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      });
    });
  }, []);

  const handleSourceMenuFocusCapture = useCallback((event: React.FocusEvent<HTMLElement>) => {
    scrollSourceMenuTargetIntoView(event.target);
  }, [scrollSourceMenuTargetIntoView]);

  const progressBarRef = useRef<HTMLDivElement>(null);
  const [showNextMovie, setShowNextMovie] = useState(false);
  const [showNextMovieOverlay, setShowNextMovieOverlay] = useState(false);
  const [hasIgnored, setHasIgnored] = useState(false);
  const [, setTimeRemaining] = useState<number>(0);
  const [showPlayAnimation] = useState(false);
  const [showPauseAnimation] = useState(false);
  const [showForwardAnimation, setShowForwardAnimation] = useState(false);
  const [showRewindAnimation, setShowRewindAnimation] = useState(false);
  const [forwardClickCount, setForwardClickCount] = useState(0);
  const [rewindClickCount, setRewindClickCount] = useState(0);
  const forwardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rewindTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Mobile double-tap (Crunchy/Netflix-like) state
  const [showLeftTapAnimation, setShowLeftTapAnimation] = useState(false);
  const [showRightTapAnimation, setShowRightTapAnimation] = useState(false);
  const [leftTapCount, setLeftTapCount] = useState(0);
  const [rightTapCount, setRightTapCount] = useState(0);
  const leftTapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rightTapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  // Tap detection refs for single vs double tap on touch devices
  const lastTapTimeRef = useRef<number>(0);
  const lastTapSideRef = useRef<'left' | 'right' | null>(null);
  const singleTapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const touchMovedRef = useRef<boolean>(false);
  const ignoreNextClickRef = useRef<boolean>(false);
  const controlsToggleInProgressRef = useRef<boolean>(false);
  const touchActiveRef = useRef<boolean>(false);

  // Fonction utilitaire pour empêcher les clics synthétiques après un touch
  const preventSyntheticClick = useCallback(() => {
    console.log('Touch ended, setting ignoreNextClick to true');
    ignoreNextClickRef.current = true;
    setTimeout(() => {
      console.log('Resetting ignoreNextClick to false');
      ignoreNextClickRef.current = false;
    }, 150); // Délai plus court pour ne pas bloquer les vrais clics
  }, []);

  const [nextMovieInfo, setNextMovieInfo] = useState<MovieInfo | null>(null);
  const [showNextEpisodeOverlay, setShowNextEpisodeOverlay] = useState(false);
  const [hasDeclinedNextEpisode, setHasDeclinedNextEpisode] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [hasLoadedProgress, setHasLoadedProgress] = useState(false);
  const progressSaveInterval = useRef<NodeJS.Timeout>();
  const [, setSelectedSource] = useState<string | null>(null);
  const [currentDarkiIndex, setCurrentDarkiIndex] = useState(0);
  const [currentNexusHlsIndex, setCurrentNexusHlsIndex] = useState(0);
  const [currentNexusFileIndex, setCurrentNexusFileIndex] = useState(0);
  const [currentBravoIndex, setCurrentBravoIndex] = useState(0);
  const [, setM3u8Url] = useState<string | null>(null);
  const [, setLoadingError] = useState(false);
  const [, setSelectedSubtitleUrl] = useState<string | null>(null);
  const [showNextEpisodePrompt, setShowNextEpisodePrompt] = useState(false);
  const [, setSelectedSubtitleLang] = useState<string | null>(null);
  const imdbCacheRef = useRef<Record<string, string | null>>({});
  const [hoverState, setHoverState] = useState<{
    time: number | null;
    x: number;
    previewUrl: string | null;
    showPreview: boolean;
  }>({
    time: null,
    x: 0,
    previewUrl: null,
    showPreview: false,
  });
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewHlsRef = useRef<HlsType | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewStyle, setPreviewStyle] = useState({});

  const [isDragging, setIsDragging] = useState(false);
  const [activeSubtitleCues, setActiveSubtitleCues] = useState<VTTCue[]>([]);
  const [subtitleContainerVisible, setSubtitleContainerVisible] = useState(false);
  // Subtitle translation
  const [translateSubsTo, setTranslateSubsTo] = useState<string | null>(null);
  const translationCacheRef = useRef<Map<string, string>>(new Map());
  const [translatedCueTexts, setTranslatedCueTexts] = useState<Map<string, string>>(new Map());
  const [translationProgress, setTranslationProgress] = useState<{ done: number; total: number } | null>(null);
  const [translationLang, setTranslationLang] = useState<string | null>(null);
  const translationAbortRef = useRef(false);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(() => {
    // Try to load saved subtitle style from localStorage
    const savedStyle = localStorage.getItem('subtitleStyle');
    if (savedStyle) {
      try {
        const parsed = JSON.parse(savedStyle);

        // Migrate from old format if needed
        let fontSize = 1.5;
        if (typeof parsed.fontSize === 'string') {
          // Old format: 'small' | 'medium' | 'large'
          fontSize = parsed.fontSize === 'small' ? 1 : parsed.fontSize === 'large' ? 2 : 1.5;
        } else if (typeof parsed.fontSize === 'number') {
          fontSize = parsed.fontSize;
        }

        let backgroundOpacity = 0.4;
        if (typeof parsed.backgroundColor === 'string') {
          // Old format: 'transparent' | 'semi' | 'dark'
          backgroundOpacity = parsed.backgroundColor === 'transparent' ? 0.1 : parsed.backgroundColor === 'dark' ? 0.7 : 0.4;
        } else if (typeof parsed.backgroundOpacity === 'number') {
          backgroundOpacity = parsed.backgroundOpacity;
        }

        // Migrate color from old format if needed
        let color = '#ffffff';
        if (typeof parsed.color === 'string') {
          if (parsed.color === 'yellow') {
            color = '#fcd34d'; // yellow-300
          } else if (parsed.color === 'white') {
            color = '#ffffff';
          } else if (parsed.color.startsWith('#')) {
            color = parsed.color;
          }
        }

        return {
          fontSize,
          backgroundOpacity,
          color,
          delay: parsed.delay || 0
        };
      } catch (e) {
        console.error('Error parsing saved subtitle style', e);
      }
    }
    // Default values if nothing saved or error parsing
    return {
      fontSize: 1.5, // 1.5rem - medium size
      backgroundOpacity: 0.4, // 40% opacity - semi transparent
      color: '#ffffff', // white
      delay: 0
    };
  });
  // Ajout d'un nouveau state pour le format d'affichage
  const [videoAspectRatio, setVideoAspectRatio] = useState<'cover' | 'contain' | '16:9' | '4:3' | 'original'>('contain');
  const [, setIsLandscape] = useState(window.innerWidth > window.innerHeight);
  // Ajout d'un nouveau state pour la vitesse de lecture
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(() => {
    const savedSpeed = localStorage.getItem('playerPlaybackSpeed');
    return savedSpeed ? parseFloat(savedSpeed) : 1;
  });

  // Nouvel état pour les groupes de sources - maintenant géré par useMemo
  const [showDarkinoMenu, setShowDarkinoMenu] = useState(false);
  const [showOmegaMenu, setShowOmegaMenu] = useState(false);
  const [showCoflixMenu, setShowCoflixMenu] = useState(false);
  const [showNexusMenu, setShowNexusMenu] = useState(false);
  const [showFstreamMenu, setShowFstreamMenu] = useState(false);
  const [showWiflixMenu, setShowWiflixMenu] = useState(false);
  const [showJ1fMenu, setShowJ1fMenu] = useState(false);
  const [showViperMenu, setShowViperMenu] = useState(false);
  const [showVoxMenu, setShowVoxMenu] = useState(false);
  const [showRivestreamMenu, setShowRivestreamMenu] = useState(false);
  const [showBravoMenu, setShowBravoMenu] = useState(false);

  // Setup cinep DNR headers for PurStream sources (non-VIP extension users)
  useEffect(() => {
    if (purstreamSources && purstreamSources.length > 0 && window.movixSetupHeaders) {
      // Only need one call per unique hostname
      const seen = new Set<string>();
      for (const s of purstreamSources) {
        if (!s.url) continue;
        try {
          const host = new URL(s.url).hostname;
          if (seen.has(host)) continue;
          seen.add(host);
          window.movixSetupHeaders!('cinep', s.url).catch(() => {});
        } catch { /* ignore invalid urls */ }
      }
    }
  }, [purstreamSources]);

  // const [currentHlsSrc, setCurrentHlsSrc] = useState<string>(src); // Track currently loaded HLS src

  // Définition de currentSourceRef

  // Ajout du state pour le menu VO/VOSTFR
  const [showVostfrMenu, setShowVostfrMenu] = useState(false);

  // États pour le menu des épisodes intégré
  const [showInternalEpisodesMenu, setShowInternalEpisodesMenu] = useState(false);
  // `?? 1` au lieu de `|| 1` : sinon un épisode spécial (seasonNumber === 0, falsy) tombait
  // par défaut sur S1 dans le menu d'épisodes interne — cassait la sélection courante en S0.
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState(seasonNumber ?? 1);
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);
  const [episodesBySeasons, setEpisodesBySeasons] = useState<{ [key: number]: EpisodeInfo[] }>({});
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);

  // Ajout de src et subtitleUrl aux dépendances pour recalculer quand la source change

  // Fonction pour recalculer la largeur du menu des paramètres
  const recalculateMenuWidth = useCallback(() => {
    if (showSettings && tabsContainerRef.current) {
      setTimeout(() => {
        if (tabsContainerRef.current) {
          const tabElements = tabsContainerRef.current.querySelectorAll('button');
          let totalTabsWidth = 0;

          tabElements.forEach((tab) => {
            const style = window.getComputedStyle(tab);
            const width = tab.getBoundingClientRect().width;
            const marginLeft = parseFloat(style.marginLeft || '0');
            const marginRight = parseFloat(style.marginRight || '0');
            totalTabsWidth += width + marginLeft + marginRight;
          });

          // Ne pas soustraire une partie du dernier onglet quand il y a beaucoup d'onglets
          // Cela assure que tous les onglets sont visibles, même "Progression"
          if (tabElements.length > 4 && tabElements.length <= 5) {
            // Soustraire moins pour 5 onglets
            const lastTab = tabElements[tabElements.length - 1];
            const lastTabWidth = lastTab.getBoundingClientRect().width;
            totalTabsWidth -= (lastTabWidth * 0.4); // Réduire à 40% au lieu de 75%
          } else if (tabElements.length <= 4) {
            // Pour 4 onglets ou moins, garder le comportement original
            const lastTab = tabElements[tabElements.length - 1];
            const lastTabWidth = lastTab.getBoundingClientRect().width;
            totalTabsWidth -= (lastTabWidth * 0.75);
          }
          // Ne rien soustraire si plus de 5 onglets pour assurer la visibilité

          // Ajouter un peu plus de marge pour le conteneur
          const containerPadding = 32; // Augmenté de 24 à 32
          totalTabsWidth += containerPadding;

          // La largeur minimale est de 350px sur mobile et 480px sur desktop
          const baseMinWidth = window.innerWidth < 768 ? 350 : 480;
          const minWidth = tabElements.length >= 6 ? baseMinWidth + 40 : baseMinWidth;

          const calculatedWidth = Math.max(minWidth, totalTabsWidth);
          const maxWidth = window.innerWidth * 0.95; // Augmenté de 0.9 à 0.95
          const finalWidth = Math.min(calculatedWidth, maxWidth);

          setSettingsMenuWidth(finalWidth);
        }
      }, 10);
    }
  }, [showSettings]);

  // Add state to track if the active source is HLS/MP4
  const [isPipActive, setIsPipActive] = useState(false);
  const [isWatchPartyActive] = useState(false);

  // Add state for PiP backdrop image
  const [pipBackdropImage, setPipBackdropImage] = useState<string | null>(null);

  // Function to fetch the best backdrop image like in MovieDetails.tsx
  const fetchPiPBackdropImage = async (movieId: string) => {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/movie/${movieId}/images`, {
        params: { api_key: TMDB_API_KEY },
      });

      // Trouver la meilleure image de fond
      const backdrops = response.data.backdrops;
      if (backdrops && backdrops.length > 0) {
        // Trier par résolution et choisir la meilleure
        const bestBackdrop = backdrops.sort((a: any, b: any) => b.width - a.width)[0];
        setPipBackdropImage(`https://image.tmdb.org/t/p/w1280${bestBackdrop.file_path}`);
      }
    } catch (error) {
      console.error('Error fetching PiP backdrop image:', error);
    }
  };

  // Chromecast states
  const [isCasting, setIsCasting] = useState(false);
  const [castSession, setCastSession] = useState<any>(null);
  const [castAvailable, setCastAvailable] = useState(false);
  // True once the Cast SDK has finished loading. Used to trigger the
  // CAST_STATE_CHANGED listener effect as soon as the framework is ready,
  // without waiting for the user to start playback.
  const [castSdkReady, setCastSdkReady] = useState(false);
  // True if the Cast SDK didn't load within 5s of mount — strong hint that an
  // adblocker, ISP or shielded-browser policy is blocking gstatic.com. Lets us
  // show a specific error instead of the generic "no devices found" message.
  const [castSdkBlocked, setCastSdkBlocked] = useState(false);
  const [showCastMenu, setShowCastMenu] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [isCastLoading, setIsCastLoading] = useState(false);
  const [castCurrentTime, setCastCurrentTime] = useState(0);
  const [castDuration, setCastDuration] = useState(0);
  const [isCastDragging, setIsCastDragging] = useState(false);
  const [castDragTime, setCastDragTime] = useState(0);

  // AirPlay states
  const [isAirPlaying, setIsAirPlaying] = useState(false);
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [airPlayError, setAirPlayError] = useState<string | null>(null);
  const [isAirPlayLoading, setIsAirPlayLoading] = useState(false);
  const castButtonRef = useRef<HTMLElement | null>(null);
  const lastLoadedCastSrcRef = useRef<string | null>(null);
  // Single-flight guard: when a cast is started from startCasting(), the SDK
  // also fires SESSION_STARTED which triggers a second loadMedia for the same
  // src. Two concurrent LOAD requests race on the receiver (the first gets
  // LOAD_CANCELLED), surfacing spurious errors or restarting playback.
  const castLoadInFlightRef = useRef<string | null>(null);
  // Native Android cast bridge (injected by the Movix Android app WebView).
  // When present, clicking cast routes through the Google Cast SDK on-device
  // instead of the web cast_sender.js SDK (which isn't available inside WebView).
  const [nativeCastBridge, setNativeCastBridge] = useState<any>(null);

  // Persist the last playback position across src changes so that switching
  // servers/players (e.g. anime source picker) keeps the viewer at the same
  // moment instead of restarting from 0. Reset only when the actual
  // movie/episode identity changes.
  const lastKnownTimeRef = useRef<number>(0);
  const lastEpisodeKeyRef = useRef<string>('');

  // Lock mode: blocks all interactions with the player. Unlocked by triple
  // click/tap, Escape (desktop) or the browser back button (mobile).
  const [isLocked, setIsLocked] = useState(false);
  const [showLockTip, setShowLockTip] = useState(false);
  const lockTapCountRef = useRef(0);
  const lockTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockPushedHistoryRef = useRef(false);

  // Animation smooth fullscreen
  const [isFullscreenAnimating] = useState(false);

  // Overlays raccourcis clavier
  const [showStreamInfo, setShowStreamInfo] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const showOsd = useCallback((message: string) => {
    toast(message, { duration: 1500 });
  }, []);

  const normalizeSourceQualityLabel = useCallback((quality?: string | number | null): string | null => {
    if (typeof quality === 'number' && Number.isFinite(quality) && quality > 0) {
      return `${quality}p`;
    }

    if (typeof quality === 'string') {
      const trimmedQuality = quality.trim();
      if (!trimmedQuality) {
        return null;
      }

      const normalizedResolutionMatch = trimmedQuality.match(/^(\d{3,4})\s*[xX]\s*(\d{3,4})(p)?$/);
      if (normalizedResolutionMatch) {
        const [, width, height] = normalizedResolutionMatch;
        return `${width} x ${height}p`;
      }

      return trimmedQuality;
    }

    return null;
  }, []);

  const formatDetectedStreamQuality = useCallback((level?: {
    height?: number;
    width?: number;
    bitrate?: number;
    averageBitrate?: number;
    realBitrate?: number;
    estimatedBitrate?: boolean;
    attrs?: {
      BANDWIDTH?: string | number;
      'AVERAGE-BANDWIDTH'?: string | number;
    };
  } | null): string | null => {
    if (!level) return null;

    const width = typeof level.width === 'number' && level.width > 0 ? Math.round(level.width) : null;
    const height = typeof level.height === 'number' && level.height > 0 ? Math.round(level.height) : null;
    const bitrateCandidates = [
      typeof level.realBitrate === 'number' ? level.realBitrate : null,
      typeof level.averageBitrate === 'number' ? level.averageBitrate : null,
      typeof level.bitrate === 'number' ? level.bitrate : null,
      typeof level.attrs?.['AVERAGE-BANDWIDTH'] === 'number' ? level.attrs['AVERAGE-BANDWIDTH'] : Number(level.attrs?.['AVERAGE-BANDWIDTH']),
      typeof level.attrs?.BANDWIDTH === 'number' ? level.attrs.BANDWIDTH : Number(level.attrs?.BANDWIDTH),
    ];
    const bitrate = bitrateCandidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) || null;
    const resolutionLabel = width && height
      ? `${width} x ${height}p`
      : (height ? `${height}p` : (width ? `${width}px` : null));
    const bitrateLabel = bitrate ? `${level.estimatedBitrate ? '~' : ''}${Math.round(bitrate / 1000)} kbps` : null;

    if (resolutionLabel && bitrateLabel) {
      return `${resolutionLabel} • ${bitrateLabel}`;
    }

    return resolutionLabel || bitrateLabel || null;
  }, []);

  const estimateAverageBitrate = useCallback(async (sourceUrl?: string | null, duration?: number): Promise<number | null> => {
    if (!sourceUrl || !duration || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    const cacheKeys = getSourceQualityCacheKeys(sourceUrl);
    const cachedBitrate = cacheKeys
      .map(cacheKey => sourceStreamBitrateEstimateCache.get(cacheKey))
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);

    if (cachedBitrate) {
      return cachedBitrate;
    }

    try {
      const response = await fetch(normalizeUqloadEmbedUrl(sourceUrl), { method: 'HEAD' });
      if (!response.ok) {
        return null;
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return null;
      }

      const estimatedBitrate = Math.round((contentLength * 8) / duration);
      if (!Number.isFinite(estimatedBitrate) || estimatedBitrate <= 0) {
        return null;
      }

      cacheKeys.forEach((cacheKey) => {
        sourceStreamBitrateEstimateCache.set(cacheKey, estimatedBitrate);
      });

      return estimatedBitrate;
    } catch (error) {
      console.debug('Impossible d’estimer le bitrate du flux', error);
      return null;
    }
  }, []);

  const rememberSourceQuality = useCallback((sourceUrl?: string | null, qualityLabel?: string | null) => {
    if (!sourceUrl || !qualityLabel) return;

    const cacheKeys = getSourceQualityCacheKeys(sourceUrl);
    let cacheChanged = false;

    cacheKeys.forEach((cacheKey) => {
      if (sourceStreamQualityCache.get(cacheKey) !== qualityLabel) {
        sourceStreamQualityCache.set(cacheKey, qualityLabel);
        cacheChanged = true;
      }
    });

    if (!cacheChanged) {
      return;
    }

    setSourceStreamQualities(prev => {
      const next = { ...prev };

      cacheKeys.forEach((cacheKey) => {
        next[cacheKey] = qualityLabel;
      });

      return next;
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SOURCE_STREAM_QUALITY_CACHE_EVENT));
    }
  }, []);

  const getSourceQualityLabel = useCallback((sourceUrl?: string | null, fallbackQuality?: string | number | null, sourceLabel?: string): string | null => {
    if (!sourceUrl) return null;

    const detectedQuality = getSourceQualityCacheKeys(sourceUrl)
      .map(cacheKey => sourceStreamQualities[cacheKey] || sourceStreamQualityCache.get(cacheKey))
      .find((quality): quality is string => Boolean(quality));
    if (detectedQuality) {
      return detectedQuality;
    }

    const fallbackLabel = normalizeSourceQualityLabel(fallbackQuality);
    if (!fallbackLabel) {
      return null;
    }

    const normalizedSourceLabel = sourceLabel?.trim().toLowerCase() || '';
    const normalizedFallbackLabel = fallbackLabel.toLowerCase();

    if (
      normalizedSourceLabel &&
      (normalizedSourceLabel === normalizedFallbackLabel || normalizedSourceLabel.includes(normalizedFallbackLabel))
    ) {
      return null;
    }

    return fallbackLabel;
  }, [normalizeSourceQualityLabel, sourceStreamQualities]);

  const renderSourceQualityMeta = useCallback((sourceUrl?: string | null, isActive = false, fallbackQuality?: string | number | null, sourceLabel?: string) => {
    const qualityLabel = getSourceQualityLabel(sourceUrl, fallbackQuality, sourceLabel);
    if (!qualityLabel) return null;

    return (
      <SourceQualityMeta qualityLabel={qualityLabel} isActive={isActive} />
    );
  }, [getSourceQualityLabel]);

  const handleCopySourceUrl = useCallback(async (event: React.MouseEvent<HTMLButtonElement>, sourceUrl?: string | null) => {
    event.stopPropagation();

    if (!sourceUrl || sourceUrl === '#') {
      return;
    }

    try {
      await navigator.clipboard.writeText(sourceUrl);
      setCopiedSourceUrl(sourceUrl);

      if (copiedSourceTimeoutRef.current) {
        clearTimeout(copiedSourceTimeoutRef.current);
      }

      copiedSourceTimeoutRef.current = setTimeout(() => {
        setCopiedSourceUrl(currentUrl => currentUrl === sourceUrl ? null : currentUrl);
      }, 1800);

      toast.success(t('common.copied'));
    } catch (error) {
      console.error('Erreur lors de la copie du flux:', error);
      toast.error(t('common.error'));
    }
  }, [t]);

  const renderCopySourceButton = useCallback((sourceUrl?: string | null) => {
    if (!sourceUrl || sourceUrl === '#') {
      return null;
    }

    const isCopied = copiedSourceUrl === sourceUrl;

    return (
      <button
        type="button"
        onClick={(event) => void handleCopySourceUrl(event, sourceUrl)}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-700/70 bg-gray-900/60 text-gray-300 transition-colors hover:bg-gray-800/80 hover:text-white"
        title={isCopied ? t('common.copied') : t('common.copy')}
        aria-label={isCopied ? t('common.copied') : t('common.copy')}
      >
        {isCopied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
      </button>
    );
  }, [copiedSourceUrl, handleCopySourceUrl, t]);

  useEffect(() => {
    return () => {
      if (copiedSourceTimeoutRef.current) {
        clearTimeout(copiedSourceTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncSourceQualityCache = () => {
      setSourceStreamQualities(getInitialSourceQualityState());
    };

    window.addEventListener(SOURCE_STREAM_QUALITY_CACHE_EVENT, syncSourceQualityCache);

    return () => {
      window.removeEventListener(SOURCE_STREAM_QUALITY_CACHE_EVENT, syncSourceQualityCache);
    };
  }, []);

  // Function to fetch episodes for a specific season
  const fetchEpisodesForSeason = useCallback(async (seasonNum: number) => {
    if (!tvShowId || !seasonNum || episodesBySeasons[seasonNum]) {
      return; // Don't fetch if already have data for this season
    }

    setLoadingEpisodes(true);
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${tvShowId}/season/${seasonNum}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
      });

      if (response.data && response.data.episodes) {
        setEpisodesBySeasons(prev => ({
          ...prev,
          [seasonNum]: response.data.episodes
        }));
      }
    } catch (error) {
      console.error(`Error fetching episodes for season ${seasonNum}:`, error);
    } finally {
      setLoadingEpisodes(false);
    }
  }, [tvShowId, episodesBySeasons]);

  // Add watch party toggle function
  const toggleWatchParty = () => {
    // Store current playback position and source info
    const currentPosition = videoRef.current ? videoRef.current.currentTime : 0;

    // Find the currently selected Nexus source (if any)
    let currentNexusSource = null;

    // Check if current src matches any Nexus HLS source
    if (nexusHlsSources && nexusHlsSources.length > 0) {
      const matchingHlsSource = nexusHlsSources.find(source => source.url === src);
      if (matchingHlsSource) {
        currentNexusSource = {
          url: matchingHlsSource.url,
          label: matchingHlsSource.label,
          type: 'hls' as const
        };
      }
    }

    // Check if current src matches any Nexus File source
    if (!currentNexusSource && nexusFileSources && nexusFileSources.length > 0) {
      const matchingFileSource = nexusFileSources.find(source => source.url === src);
      if (matchingFileSource) {
        currentNexusSource = {
          url: matchingFileSource.url,
          label: matchingFileSource.label,
          type: 'file' as const
        };
      }
    }

    // Find the currently selected Bravo source (if any)
    let currentBravoSource = null;
    if (purstreamSources && purstreamSources.length > 0) {
      const matchingBravoSource = purstreamSources.find(source => source.url === src);
      if (matchingBravoSource) {
        currentBravoSource = {
          url: matchingBravoSource.url,
          label: matchingBravoSource.label
        };
      }
    }
    if (!currentBravoSource && mp4Sources && mp4Sources.length > 0) {
      const matchingBravoSource = mp4Sources.find(source =>
        source.url === src && source.label && source.label.includes('🦁 Bravo')
      );
      if (matchingBravoSource) {
        currentBravoSource = {
          url: matchingBravoSource.url,
          label: matchingBravoSource.label,
          language: matchingBravoSource.language,
          isVip: matchingBravoSource.isVip
        };
      }
    }

    // Combine Nexus HLS and File sources into a single array
    const nexusSources = [
      ...(Array.isArray(nexusHlsSources) ? nexusHlsSources.map(source => ({
        url: source.url,
        label: source.label,
        type: 'hls' as const
      })) : []),
      ...(Array.isArray(nexusFileSources) ? nexusFileSources.map(source => ({
        url: source.url,
        label: source.label,
        type: 'file' as const
      })) : [])
    ];

    // Navigate to watchparty creation page with media info
    const mediaInfo = {
      src, // This will be the initially selected main source
      position: currentPosition,
      title: title || tvShow?.name || "Media",
      poster: poster,
      mediaType: movieId ? "movie" : "tv",
      mediaId: movieId || tvShowId,
      seasonNumber,
      episodeNumber,
      // Map darkinoSources to NightflixSourceInfo structure
      // Ensure that darkinoSources (which is of type any[] from props) is correctly processed
      // Assuming darkinoSources from props is an array of objects like: { m3u8: string, quality?: string, language?: string, label?: string }
      nightflixSources: Array.isArray(darkinoSources) ? darkinoSources.map(source => ({
        src: typeof source.m3u8 === 'string' ? source.m3u8 : '', // Ensure src is always a string
        quality: typeof source.quality === 'string' ? source.quality : undefined,
        language: typeof source.language === 'string' ? source.language : undefined,
        label: typeof source.label === 'string' ? source.label : undefined
      })) : [], // Default to empty array if darkinoSources is not an array
      // Add Nexus sources to the media info
      nexusSources: nexusSources,
      // Add Bravo/PurStream sources to the media info
      bravoSources: Array.isArray(purstreamSources) ? purstreamSources.map(source => ({
        url: source.url,
        label: source.label
      })) : [],
      // Add generic MP4/file sources to the media info
      mp4Sources: Array.isArray(mp4Sources) ? mp4Sources.map(source => ({
        url: source.url,
        label: source.label,
        language: source.language,
        isVip: source.isVip
      })) : [],
      // Add Rivestream HLS sources (VO/VOSTFR) to the media info
      rivestreamSources: Array.isArray(rivestreamSources) ? rivestreamSources.map(source => ({
        url: source.url,
        label: source.label,
        quality: source.quality,
        service: source.service,
        category: source.category
      })) : [],
      // Add captions/subtitles for Rivestream sources
      captions: Array.isArray(rivestreamCaptions) ? rivestreamCaptions.map(caption => ({
        label: caption.label,
        file: caption.file
      })) : [],
      // Add currently selected Nexus source info for proper Bravo player transmission
      currentNexusSource: currentNexusSource,
      // Add currently selected Bravo source info
      currentBravoSource: currentBravoSource
    };

    // Save media info to sessionStorage
    sessionStorage.setItem('watchPartyMedia', JSON.stringify(mediaInfo));

    // Navigate to watchparty creation page
    navigate('/watchparty/create');
  };

  // UseEffect pour calculer la largeur du menu des paramètres
  useEffect(() => {
    if (showSettings && tabsContainerRef.current) {
      // Récupérer la largeur totale des onglets et calculer une largeur optimale
      setTimeout(() => {
        // Utiliser setTimeout pour s'assurer que les onglets sont bien rendus
        if (tabsContainerRef.current) {
          // Mesurer précisément la largeur nécessaire pour les onglets visibles
          const tabElements = tabsContainerRef.current.querySelectorAll('button');
          let totalTabsWidth = 0;

          // Calculer la largeur totale des onglets visibles + espacement
          tabElements.forEach((tab) => {
            const style = window.getComputedStyle(tab);
            const width = tab.getBoundingClientRect().width;
            const marginLeft = parseFloat(style.marginLeft || '0');
            const marginRight = parseFloat(style.marginRight || '0');
            totalTabsWidth += width + marginLeft + marginRight;
          });

          // Ne pas soustraire une partie du dernier onglet quand il y a beaucoup d'onglets
          // Cela assure que tous les onglets sont visibles, même "Progression"
          if (tabElements.length > 4 && tabElements.length <= 5) {
            // Soustraire moins pour 5 onglets
            const lastTab = tabElements[tabElements.length - 1];
            const lastTabWidth = lastTab.getBoundingClientRect().width;
            totalTabsWidth -= (lastTabWidth * 0.4); // Réduire à 40% au lieu de 75%
          } else if (tabElements.length <= 4) {
            // Pour 4 onglets ou moins, garder le comportement original
            const lastTab = tabElements[tabElements.length - 1];
            const lastTabWidth = lastTab.getBoundingClientRect().width;
            totalTabsWidth -= (lastTabWidth * 0.75);
          }
          // Ne rien soustraire si plus de 5 onglets pour assurer la visibilité

          // Ajouter un peu plus de marge pour le conteneur
          const containerPadding = 32; // Augmenté de 24 à 32
          totalTabsWidth += containerPadding;

          // La largeur minimale est de 350px sur mobile et 480px sur desktop
          const minWidth = window.innerWidth < 768 ? 350 : 480;

          // Assurer que la largeur est suffisante mais pas excessive
          const calculatedWidth = Math.max(minWidth, totalTabsWidth);

          // Limiter à une largeur maximale pour les grands écrans
          const maxWidth = window.innerWidth * 0.9; // 90% de la largeur de l'écran
          const finalWidth = Math.min(calculatedWidth, maxWidth);

          // Mettre à jour la largeur du menu
          setSettingsMenuWidth(finalWidth);
        }
      }, 0);
    }
  }, [showSettings, audioTracks.length, subtitles.length, src, subtitleUrl]);

  // Fonction pour organiser les sources en groupes - Utilisation de useMemo pour éviter les boucles infinies
  useEffect(() => {
    const isSourceMenuVisible = onlyQualityMenu || (showSettings && settingsTab === 'quality');
    if (!isSourceMenuVisible) return;

    const sourceMenu = sourceMenuRef.current;
    if (!sourceMenu) return;

    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;

      if (activeElement instanceof HTMLElement && sourceMenu.contains(activeElement)) {
        scrollSourceMenuTargetIntoView(activeElement);
        return;
      }

      const firstFocusable = sourceMenu.querySelector<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );

      if (!firstFocusable) return;

      firstFocusable.focus();
      scrollSourceMenuTargetIntoView(firstFocusable);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [onlyQualityMenu, showSettings, settingsTab, scrollSourceMenuTargetIntoView]);

  useEffect(() => {
    const isSourceMenuVisible = onlyQualityMenu || (showSettings && settingsTab === 'quality');
    if (!isSourceMenuVisible) return;

    const lenis = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
    if (lenis) lenis.stop();

    return () => {
      const lenisInstance = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
      if (lenisInstance) lenisInstance.start();
    };
  }, [onlyQualityMenu, showSettings, settingsTab]);

  const sourceGroups = useMemo(() => {
    console.log('🔍 [HLSPlayer] Building sourceGroups with:', {
      darkinoSources: darkinoSources?.length || 0,
      mp4Sources: mp4Sources?.length || 0,
      nexusHlsSources: nexusHlsSources?.length || 0,
      nexusFileSources: nexusFileSources?.length || 0,
      rivestreamSources: rivestreamSources?.length || 0,
      frembedAvailable,
      customSources: customSources?.length || 0,
      omegaSources: omegaSources?.length || 0,
      coflixSources: coflixSources?.length || 0,
      fstreamSources: fstreamSources?.length || 0,
      onlyQualityMenu
    });

    const hlsSources: SourceOption[] = [];
    const embedSources: SourceOption[] = [];

    // Add AdFree m3u8 source if available
    if (adFreeM3u8Url) {
      hlsSources.push({
        type: 'm3u8',
        id: 'm3u8_adfree',
        label: t('watch.lumediaAdFreeSource'),
        url: adFreeM3u8Url,
        quality: 'HD',
        language: 'FR'
      });
    }

    // Process Darkino sources - Add only the main button
    if (darkinoSources && darkinoSources.length > 0) {
      hlsSources.push({
        type: 'darkino_main',
        id: 'darkino_main',
        label: t('watch.nightflixSource', { count: darkinoSources.length }),
        url: '#',
      });
    }

    // Process Nexus sources - Add only one main button
    if ((nexusHlsSources && nexusHlsSources.length > 0) || (nexusFileSources && nexusFileSources.length > 0)) {
      const totalNexusSources = (nexusHlsSources?.length || 0) + (nexusFileSources?.length || 0);
      hlsSources.push({
        type: 'nexus_main',
        id: 'nexus_main',
        label: t('watch.nexusSource', { count: totalNexusSources }),
        url: '#',
      });
    }

    // Process PurStream (Bravo) sources - réservé VIP/extension
    if (purstreamSources && purstreamSources.length > 0 && (isUserVip() || isExtensionAvailable())) {
      hlsSources.push({
        type: 'bravo_main',
        id: 'bravo_main',
        label: t('watch.bravoSource', { count: purstreamSources.length }),
        url: '#',
      });
    }

    // Process MP4 sources
    if (mp4Sources && mp4Sources.length > 0) {
      mp4Sources.forEach((source, index) => {
        hlsSources.push({
          type: 'mp4',
          id: `mp4_${index}`,
          label: `${source.isVip ? '🔥 ' : ''}${source.label || ''}`,
          url: source.url,
          quality: source.label || 'HD',
          language: source.language || 'FR'
        });
      });
    }

    // Add Frembed option
    if (frembedAvailable) {
      if (movieId) {
        embedSources.push({
          type: 'frembed',
          id: 'frembed_main',
          label: t('watch.frembedPlayer'),
          url: `https://frembed.click/api/film.php?id=${movieId}`,
        });
      } else if (tvShowId && seasonNumber && episodeNumber) {
        embedSources.push({
          type: 'frembed',
          id: 'frembed_main',
          label: t('watch.frembedPlayer'),
          url: `https://frembed.click/api/serie.php?id=${tvShowId}&sa=${seasonNumber}&epi=${episodeNumber}`,
        });
      }
    }

    // Add custom sources (Movix players)
    if (customSources && customSources.length > 0) {
      customSources.forEach((source, index) => {
        const srcLower = source.toLowerCase();
        const isSeek = srcLower.includes('embedseek.') || srcLower.includes('seekplayer.') || srcLower.includes('seeks.cloud') || srcLower.includes('seekplays.');
        embedSources.push({
          type: 'custom',
          id: `custom_${index}`,
          label: isSeek ? t('watch.seekStreamingPlayer', { n: index + 1 }) : t('watch.movixPlayer', { n: index + 1 }),
          url: source,
        });
      });
    }

    // Add Omega sources - Add only the main button
    if (omegaSources && omegaSources.length > 0) {
      embedSources.push({
        type: 'omega_main',
        id: 'omega_main',
        label: t('watch.omegaPlayers', { count: omegaSources.length }),
        url: '#',
      });
    }

    // Add Coflix sources - Add only the main button
    if (coflixSources && coflixSources.length > 0) {
      embedSources.push({
        type: 'multi_main',
        id: 'multi_main',
        label: t('watch.multiPlayers', { count: coflixSources.length }),
        url: '#',
      });
    }

    // Add FStream sources
    if (fstreamSources && fstreamSources.length > 0) {
      console.log('✅ [HLSPlayer] Adding FStream sources to embedSources:', fstreamSources.length);
      embedSources.push({
        type: 'fstream_main',
        id: 'fstream_main',
        label: t('watch.fstreamPlayers', { count: fstreamSources.length }),
        url: '#',
      });
    } else {
      console.log('❌ [HLSPlayer] No FStream sources available:', fstreamSources);
    }

    // Add Wiflix sources
    if (wiflixSources && wiflixSources.length > 0) {
      console.log('✅ [HLSPlayer] Adding Wiflix/Lynx sources to embedSources:', wiflixSources.length);
      embedSources.push({
        type: 'wiflix_main',
        id: 'wiflix_main',
        label: t('watch.lynxPlayers', { count: wiflixSources.length }),
        url: '#',
      });
    } else {
      console.log('❌ [HLSPlayer] No Wiflix/Lynx sources available:', wiflixSources);
    }

    // Add J1F (1jour1film) sources
    if (j1fSources && j1fSources.length > 0) {
      embedSources.push({
        type: 'j1f_main',
        id: 'j1f_main',
        label: t('watch.j1fPlayers', { count: j1fSources.length }),
        url: '#',
      });
    }

    // Add Viper sources
    if (viperSources && viperSources.length > 0) {
      console.log('✅ [HLSPlayer] Adding Viper sources to embedSources:', viperSources.length);
      embedSources.push({
        type: 'viper_main',
        id: 'viper_main',
        label: t('watch.viperPlayers', { count: viperSources.length }),
        url: '#',
      });
    }

    // Add Vox sources
    if (voxSources && voxSources.length > 0) {
      console.log('✅ [HLSPlayer] Adding Vox sources to embedSources:', voxSources.length);
      embedSources.push({
        type: 'vox_main',
        id: 'vox_main',
        label: t('watch.voxPlayers', { count: voxSources.length }),
        url: '#',
      });
    }

    // Add ad-free iframe if available
    if (embedUrl && embedType === 'adfree') {
      embedSources.push({
        type: 'adfree',
        id: 'adfree_main',
        label: t('watch.lumediaAdFreePlayer'),
        url: embedUrl,
        isActive: true
      });
    }

    // Mark currently active source
    if (embedUrl && embedType && embedType !== 'adfree') {
      const sourceToMark = embedSources.find(s => s.type === embedType && s.url === embedUrl);
      if (sourceToMark) {
        sourceToMark.isActive = true;
      }
    }

    // Process Rivestream sources - Add main button with dropdown menu (VIP check si activé)
    if (isRivestreamAvailable()) {
      if (rivestreamSources && rivestreamSources.length > 0) {
        embedSources.push({
          type: 'rivestream_main',
          id: 'rivestream_main',
          label: `🎬 ${t('watch.voVostfrPlayer', { n: 'HLS' })} (${rivestreamSources.length})`,
          url: '#',
        });
      } else if (loadingRivestream) {
        embedSources.push({
          type: 'rivestream_main',
          id: 'rivestream_main',
          label: `⏳ ${t('watch.loadingVoVostfr')}`,
          url: '#',
        });
      } else {
        // Bouton pour déclencher le chargement si pas encore chargé
        embedSources.push({
          type: 'rivestream_hls',
          id: 'rivestream_trigger',
          label: `🌎 ${t('watch.voVostfrPlayer', { n: 'HLS' })}`,
          url: '#',
        });
      }
    }

    // Ajouter les sources VOSTFR dans un menu déroulant
    embedSources.push({
      type: 'vostfr_main',
      id: 'vostfr_main',
      label: `🌎 ${t('watch.voVostfrPlayers')}`,
      url: '#',
    });

    // NOTE: FStream submenu is handled directly in the UI section, not here to avoid duplication

    // Définir les lecteurs VO/VOSTFR à conserver (enlever 6, 4 et 2)
    if (showVostfrMenu) {
      const vostfrSources = [
        { id: 'peachify', label: 'Peachify', url: '' }, // Peachify (priorité, FR subs + accent Movix)
        { id: 'vostfr', label: 'Videasy', url: '' }, // Videasy
        { id: 'vidlink', label: 'Vidlink', url: '' }, // vidlink
        { id: 'vidsrccc', label: 'Vidsrc.io', url: '' }, // vidsrc.io
        { id: 'vidsrcwtf1', label: 'Vidsrc.wtf 1', url: '' } // vidsrc.wtf (v1)
      ];

      vostfrSources.forEach(source => {
        let finalUrl = '#';
        // IMPORTANT: utiliser `!= null` et pas `seasonNumber && ...` — pour les épisodes spéciaux
        // (TMDB season 0 / "Spéciaux"), seasonNumber vaut 0 qui est falsy en JS. Le check tronqué
        // laissait alors finalUrl à '#' → l'iframe chargeait `src="#"` (= la page courante elle-même)
        // → boucle récursive : "chargement entier", "Contenu non trouvé" qui réapparaît dedans, et
        // boutons Sources/Open dupliqués (rendus dans le parent ET dans l'iframe imbriqué).
        if (tvShowId != null && seasonNumber != null && episodeNumber != null) {
          // TV Show URLs
          if (source.id === 'peachify') finalUrl = `https://peachify.top/embed/tv/${tvShowId}/${seasonNumber}/${episodeNumber}?sub=French&accent=dc2626`;
          else if (source.id === 'vidlink') finalUrl = `https://vidlink.pro/tv/${tvShowId}/${seasonNumber}/${episodeNumber}`; // vidlink.pro
          else if (source.id === 'vidsrccc') finalUrl = `https://vidsrc.io/embed/tv?tmdb=${tvShowId}&season=${seasonNumber}&episode=${episodeNumber}`;
          else if (source.id === 'vostfr') finalUrl = `https://player.videasy.net/tv/${tvShowId}/${seasonNumber}/${episodeNumber}`; // Videasy
          else if (source.id === 'vidsrcwtf1') finalUrl = `https://vidsrc.wtf/api/1/tv/?id=${tvShowId}&s=${seasonNumber}&e=${episodeNumber}`; // Assumed pattern
        } else if (movieId) {
          // Movie URLs (existing logic)
          if (source.id === 'peachify') finalUrl = `https://peachify.top/embed/movie/${movieId}?sub=French&accent=dc2626`;
          else if (source.id === 'vidlink') finalUrl = `https://vidlink.pro/movie/${movieId}`; // vidlink.pro
          else if (source.id === 'vidsrccc') finalUrl = `https://vidsrc.io/embed/movie?tmdb=${movieId}`;
          else if (source.id === 'vostfr') finalUrl = `https://player.videasy.net/movie/${movieId}`;
          else if (source.id === 'vidsrcwtf1') finalUrl = `https://vidsrc.wtf/api/1/movie/?id=${movieId}`;
        }

        embedSources.push({
          type: 'vostfr',
          id: source.id,
          label: source.label,
          url: finalUrl, // Use the generated URL
          isActive: false
        });
      });
    }

    // Organiser en groupes
    const groups: SourceGroup[] = [];

    if (hlsSources.length > 0) {
      groups.push({
        type: 'hls',
        title: t('watch.sourcesPremiumHLS'),
        sources: hlsSources
      });
    }

    if (embedSources.length > 0) {
      groups.push({
        type: 'embed',
        title: t('watch.embedPlayers'),
        sources: embedSources
      });
    }

    console.log('✅ [HLSPlayer] Final sourceGroups:', groups);
    return groups;
  }, [
    darkinoSources?.length,
    mp4Sources?.length,
    nexusHlsSources?.length,
    nexusFileSources?.length,
    rivestreamSources?.length,
    loadingRivestream,
    frembedAvailable,
    customSources?.length,
    omegaSources?.length,
    coflixSources?.length,
    fstreamSources?.length,
    wiflixSources?.length,
    j1fSources?.length,
    viperSources?.length,
    movieId,
    adFreeM3u8Url,
    showDarkinoMenu,
    showOmegaMenu,
    showCoflixMenu,
    showNexusMenu,
    showFstreamMenu,
    showWiflixMenu,
    showJ1fMenu,
    showViperMenu,
    showVostfrMenu,
    embedType,
    embedUrl,
    showVoxMenu,
    tvShowId,
    seasonNumber,
    episodeNumber
  ]);



  // Initialize episodes data when component mounts or episodes prop changes
  useEffect(() => {
    if (episodes && episodes.length > 0 && seasonNumber) {
      setEpisodesBySeasons(prev => ({
        ...prev,
        [seasonNumber]: episodes
      }));
    }
  }, [episodes, seasonNumber]);

  // Fetch episodes when season changes in the dropdown
  useEffect(() => {
    if (selectedSeasonNumber && selectedSeasonNumber !== seasonNumber && !episodesBySeasons[selectedSeasonNumber]) {
      fetchEpisodesForSeason(selectedSeasonNumber);
    }
  }, [selectedSeasonNumber, seasonNumber, episodesBySeasons, fetchEpisodesForSeason]);

  // Adjust default settings tab for anime HLS mode
  useEffect(() => {
    if (isAnime && tvShowId && src.includes('.m3u8')) {
      // Always set to format for anime HLS mode, regardless of current tab
      setSettingsTab('format');
    }
  }, [isAnime, tvShowId, src]);

  // Fonction pour gérer le changement de source
  const handleSourceChange = (sourceType: string, sourceId: string, sourceUrl: string) => {
    // --- Dropdown Toggle Handling (Doesn't close settings) ---
    if (sourceType === 'darkino_main' || sourceType === 'omega_main' || sourceType === 'multi_main' || sourceType === 'vostfr_main' || sourceType === 'nexus_main' || sourceType === 'fstream_main' || sourceType === 'wiflix_main' || sourceType === 'j1f_main' || sourceType === 'viper_main' || sourceType === 'vox_main' || sourceType === 'rivestream_main' || sourceType === 'bravo_main') {
      setShowDarkinoMenu(sourceType === 'darkino_main' ? !showDarkinoMenu : false);
      setShowOmegaMenu(sourceType === 'omega_main' ? !showOmegaMenu : false);
      setShowCoflixMenu(sourceType === 'multi_main' ? !showCoflixMenu : false);
      setShowVostfrMenu(sourceType === 'vostfr_main' ? !showVostfrMenu : false);
      setShowNexusMenu(sourceType === 'nexus_main' ? !showNexusMenu : false);
      setShowFstreamMenu(sourceType === 'fstream_main' ? !showFstreamMenu : false);
      setShowWiflixMenu(sourceType === 'wiflix_main' ? !showWiflixMenu : false);
      setShowJ1fMenu(sourceType === 'j1f_main' ? !showJ1fMenu : false);
      setShowViperMenu(sourceType === 'viper_main' ? !showViperMenu : false);
      setShowVoxMenu(sourceType === 'vox_main' ? !showVoxMenu : false);
      setShowRivestreamMenu(sourceType === 'rivestream_main' ? !showRivestreamMenu : false);
      setShowBravoMenu(sourceType === 'bravo_main' ? !showBravoMenu : false);
      return; // Return here, DON'T close settings
    }

    // --- Actual Source Selection ---
    // Determine target URL for HLS sources first
    let targetUrl = sourceUrl; // Default to sourceUrl
    if (sourceType === 'darkino') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (darkinoSources && darkinoSources[index]) {
        targetUrl = darkinoSources[index].m3u8 || '';
      }
    } else if (sourceType === 'nexus_hls') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (nexusHlsSources && nexusHlsSources[index]) {
        targetUrl = nexusHlsSources[index].url || '';
      }
    } else if (sourceType === 'nexus_file') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (nexusFileSources && nexusFileSources[index]) {
        targetUrl = nexusFileSources[index].url || '';
      }
    } else if (sourceType === 'mp4') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (mp4Sources && mp4Sources[index]) {
        targetUrl = mp4Sources[index].url || '';
      }
    } else if (sourceType === 'omega') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (omegaSources && omegaSources[index]) targetUrl = omegaSources[index].link;
    } else if (sourceType === 'coflix') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (coflixSources && coflixSources[index]) targetUrl = getCoflixPreferredUrl(coflixSources[index]);
    } else if (sourceType === 'fstream') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (fstreamSources && fstreamSources[index]) {
        targetUrl = fstreamSources[index].url || '';
      }
    } else if (sourceType === 'wiflix') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (wiflixSources && wiflixSources[index]) {
        targetUrl = wiflixSources[index].url || '';
      }
    } else if (sourceType === 'j1f') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (j1fSources && j1fSources[index]) {
        targetUrl = j1fSources[index].url || '';
      }
    } else if (sourceType === 'viper') {
      const index = parseInt(sourceId, 10);
      if (viperSources && viperSources[index]) {
        targetUrl = viperSources[index].url || '';
      }
    } else if (sourceType === 'wiflix') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (wiflixSources && wiflixSources[index]) {
        targetUrl = wiflixSources[index].url || '';
      }
    } else if (sourceType === 'rivestream') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (rivestreamSources && rivestreamSources[index]) {
        targetUrl = rivestreamSources[index].url || '';
      }
    } else if (sourceType === 'bravo') {
      const index = parseInt(sourceId.split('_')[1], 10);
      if (purstreamSources && purstreamSources[index]) {
        targetUrl = purstreamSources[index].url || '';
        // Setup cinep headers via extension for non-VIP users (raw URLs)
        if (targetUrl && window.movixSetupHeaders) {
          window.movixSetupHeaders('cinep', targetUrl).catch(() => {});
        }
      }
    } else if (sourceType === 'vox') {
      const index = parseInt(sourceId, 10);
      if (voxSources && voxSources[index]) {
        targetUrl = voxSources[index].link || '';
      }
    }
    // Note: Frembed, Custom, VOSTFR, AdFree M3U8 already use correct sourceUrl

    if (!targetUrl && sourceType !== 'vostfr_main' && sourceType !== 'vostfr_main' && sourceType !== 'omega_main' && sourceType !== 'multi_main' && sourceType !== 'darkino_main' && sourceType !== 'rivestream_main' && sourceType !== 'bravo_main' && sourceType !== 'vox_main') {
      console.error("Could not determine target URL for source:", sourceType, sourceId);
      return;
    }

    // Dispatch event for ALL source selections (HLS and Embed)
    const sourceChangeEvent = new CustomEvent('sourceChange', {
      detail: {
        type: sourceType,
        id: sourceId,
        url: targetUrl
      }
    });
    window.dispatchEvent(sourceChangeEvent);

    // Après avoir changé de source, recalculer la largeur du menu après un court délai
    // pour tenir compte des nouveaux onglets qui pourraient apparaître (audio, sous-titres)
    setTimeout(() => {
      recalculateMenuWidth();
    }, 500);

    // Close settings panel for embed sources (keep open for HLS sources to allow quality selection)
    const embedTypes = ['frembed', 'custom', 'omega', 'coflix', 'vostfr', 'adfree', 'fstream', 'wiflix', 'j1f', 'viper', 'vox'];
    if (embedTypes.includes(sourceType)) {
      // For embed sources, always close settings
      setShowSettings(false);
    }
  };
  // Effect to set initial volume and muted state on the video element
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      let initialVolume = parseFloat(localStorage.getItem('playerVolume') || '1');
      initialVolume = clampVolume(initialVolume);
      video.volume = initialVolume;
      setVolume(initialVolume);
      if (initialVolume > 0) {
        setPreviousVolume(initialVolume);
      }
    }
  }, []); // Run only once on mount

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      setIsLandscape(window.innerWidth > window.innerHeight);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Réinitialiser les index quand la source change
  useEffect(() => {
    // Détecter le type de source actuelle et ajuster les index
    let foundDarkinoIndex = -1;
    let foundNexusHlsIndex = -1;
    let foundNexusFileIndex = -1;
    let foundBravoIndex = -1;

    // Chercher dans les sources Nightflix
    if (darkinoSources && darkinoSources.length > 0) {
      foundDarkinoIndex = darkinoSources.findIndex(source => source.m3u8 === src);
    }

    // Chercher dans les sources Nexus HLS
    if (nexusHlsSources && nexusHlsSources.length > 0) {
      foundNexusHlsIndex = nexusHlsSources.findIndex(source => source.url === src);
    }

    // Chercher dans les sources Nexus File
    if (nexusFileSources && nexusFileSources.length > 0) {
      foundNexusFileIndex = nexusFileSources.findIndex(source => source.url === src);
    }

    if (purstreamSources && purstreamSources.length > 0) {
      foundBravoIndex = purstreamSources.findIndex(source => source.url === src);
    }

    // Mettre à jour les index selon la source trouvée
    if (foundDarkinoIndex >= 0) {
      setCurrentDarkiIndex(foundDarkinoIndex);
      setCurrentNexusHlsIndex(0);
      setCurrentNexusFileIndex(0);
      setCurrentBravoIndex(0);
      console.log(`🔥 Current source is Nightflix #${foundDarkinoIndex + 1}`);
    } else if (foundNexusHlsIndex >= 0) {
      setCurrentDarkiIndex(darkinoSources?.length || 0); // Marquer comme épuisé
      setCurrentNexusHlsIndex(foundNexusHlsIndex);
      setCurrentNexusFileIndex(0);
      setCurrentBravoIndex(0);
      console.log(`🚀 Current source is Nexus HLS #${foundNexusHlsIndex + 1}`);
    } else if (foundNexusFileIndex >= 0) {
      setCurrentDarkiIndex(darkinoSources?.length || 0); // Marquer comme épuisé
      setCurrentNexusHlsIndex(nexusHlsSources?.length || 0); // Marquer comme épuisé
      setCurrentNexusFileIndex(foundNexusFileIndex);
      setCurrentBravoIndex(0);
      console.log(`🚀 Current source is Nexus File #${foundNexusFileIndex + 1}`);
    } else if (foundBravoIndex >= 0) {
      setCurrentDarkiIndex(darkinoSources?.length || 0); // Marquer comme épuisé
      setCurrentNexusHlsIndex(nexusHlsSources?.length || 0); // Marquer comme épuisé
      setCurrentNexusFileIndex(nexusFileSources?.length || 0); // Marquer comme épuisé
      setCurrentBravoIndex(foundBravoIndex);
      console.log(`🦁 Current source is Bravo #${foundBravoIndex + 1}`);
    } else {
      // Source inconnue, réinitialiser tous les index
      setCurrentDarkiIndex(0);
      setCurrentNexusHlsIndex(0);
      setCurrentNexusFileIndex(0);
      setCurrentBravoIndex(0);
      console.log('🔄 Unknown source, reset all indexes');
    }
  }, [src, darkinoSources, nexusHlsSources, nexusFileSources, purstreamSources]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Wait until HLS.js has been dynamically imported before we set up the player.
    // The non-HLS branches (MP4, native canPlayType) only need this guard for the
    // shared types in the cleanup; the effect re-runs once Hls is available.
    if (!Hls) return;

    // Clear any existing timeouts when src changes or component unmounts
    const clearBufferingTimeout = () => {
      if (bufferingTimeoutRef.current) {
        clearTimeout(bufferingTimeoutRef.current);
        bufferingTimeoutRef.current = null;
      }
    };

    const clearSourceTimeout = () => {
      if (sourceTimeoutRef.current) {
        clearTimeout(sourceTimeoutRef.current);
        sourceTimeoutRef.current = null;
      }
    };

    const handleLoadStart = () => {
      setIsLoading(true); // Show loading indicator on initial load
      setIsBuffering(false); // Reset buffering state
      clearBufferingTimeout();
      clearSourceTimeout();

      // Démarrer un timeout pour changer automatiquement de source si le chargement prend trop de temps
      // Timeout long (45s) pour laisser le temps aux flux HLS lents de charger
      sourceTimeoutRef.current = setTimeout(() => {
        console.log('⏰ Source loading timeout after 45 seconds - triggering automatic source switch');
        handleHlsError();
      }, 45000); // 45 secondes timeout - laisser le temps au lecteur HLS de charger
    };

    const handleCanPlay = () => {
      setIsLoading(false); // Hide loading indicator when ready to play
      setIsBuffering(false); // Not buffering
      clearBufferingTimeout();
      clearSourceTimeout(); // Annuler le timeout car la source fonctionne
    };

    const handlePlaying = () => {
      setIsLoading(false); // Hide loading indicator when playing starts/resumes
      setIsBuffering(false); // Not buffering
      clearBufferingTimeout();
      clearSourceTimeout(); // Annuler le timeout car la source fonctionne

      // Nettoyer les compteurs de retry de fragParsing car la lecture fonctionne
      if ((window as any).fragParsingGlobalRetry) {
        delete (window as any).fragParsingGlobalRetry;
        console.log('✅ Cleared fragment parsing global retry counter');
      }

      // Réinitialiser les compteurs d'erreurs HTTP car la source fonctionne
      if ((window as any).error429RetryCount) {
        (window as any).error429RetryCount = {};
        console.log('✅ Cleared 429 error retry counters');
      }
      if ((window as any).error502RetryCount) {
        (window as any).error502RetryCount = {};
        console.log('✅ Cleared 502 error retry counters');
      }
      if ((window as any).bufferStalledRetryCount) {
        (window as any).bufferStalledRetryCount = {};
        console.log('✅ Cleared buffer stalled error retry counters');
      }
      if ((window as any).fragParsingLateRetries) {
        delete (window as any).fragParsingLateRetries;
        console.log('✅ Cleared fragment parsing late retry counters');
      }
    };

    const handleWaiting = () => {
      // Potential buffering event (could be seek or network issue)
      setIsBuffering(true);
      clearBufferingTimeout();
      // Only show the main loading indicator if buffering persists
      bufferingTimeoutRef.current = setTimeout(() => {
        setIsLoading(true);
      }, 300); // Show spinner only if buffering lasts > 300ms
    };
    const handleProgress = () => setBuffered(video.buffered);

    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('progress', handleProgress);

    // Check if source is MP4
    // Les sources mp4 (y compris Bravo/Purstream et Sibnet) sont jouées directement dans la balise <video> sans passer par Hls.js
    const normalizedSrc = normalizeUqloadEmbedUrl(src);
    const isMP4 = isMP4Source(normalizedSrc);
    // Bravo/Purstream fournit des liens mp4 compatibles avec cette logique
    if (isMP4) {
      // For MP4, directly set the source on the video element
      videoRef.current.src = normalizedSrc;

      // Restore position across source switches (e.g. anime player change).
      const mp4ResumeTime = lastKnownTimeRef.current;
      if (mp4ResumeTime > 0.5) {
        const restoreMp4Position = () => {
          const v = videoRef.current;
          if (!v) return;
          try {
            v.currentTime = mp4ResumeTime;
          } catch {}
          v.removeEventListener('loadedmetadata', restoreMp4Position);
        };
        videoRef.current.addEventListener('loadedmetadata', restoreMp4Position);
      }

      if (autoPlay) {
        safePlay(videoRef.current).catch(e => console.error('Error autoplay:', e));
      }

      // Set default quality since no HLS qualities available
      setQualities([{ height: 720, url: normalizedSrc }]);
      setCurrentQuality('auto');

      let mp4MetadataCancelled = false;
      const handleMp4LoadedMetadata = () => {
        const detectedHeight = typeof video.videoHeight === 'number' && video.videoHeight > 0
          ? Math.round(video.videoHeight)
          : 720;

        setQualities([{ height: detectedHeight, url: normalizedSrc }]);
        setCurrentQuality(detectedHeight > 0 ? detectedHeight : 'auto');

        void (async () => {
          const estimatedBitrate = await estimateAverageBitrate(normalizedSrc, video.duration);
          if (mp4MetadataCancelled) {
            return;
          }

          const qualityLabel = formatDetectedStreamQuality({
            width: video.videoWidth,
            height: video.videoHeight,
            bitrate: estimatedBitrate ?? undefined,
            estimatedBitrate: estimatedBitrate !== null,
          });

          rememberSourceQuality(normalizedSrc, qualityLabel);
        })();
      };

      video.addEventListener('loadedmetadata', handleMp4LoadedMetadata);
      if (video.readyState >= 1) {
        handleMp4LoadedMetadata();
      }

      // Handle subtitles if provided
      if (subtitleUrl) {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'Français';
        track.srclang = 'fr';
        track.src = subtitleUrl;
        video.appendChild(track);

        // Update subtitles state after a brief delay to allow DOM to update
        setTimeout(() => {
          const tracks = Array.from(video.textTracks);
          setSubtitles(tracks);

          // Default all tracks to disabled
          tracks.forEach(t => {
            t.mode = 'disabled';
          });
        }, 100);
      }

      return () => {
        mp4MetadataCancelled = true;
        clearBufferingTimeout();
        video.removeEventListener('loadstart', handleLoadStart);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('progress', handleProgress);
        video.removeEventListener('loadedmetadata', handleMp4LoadedMetadata);

        // Clear video source
        video.src = '';
      };
    } else if (Hls.isSupported()) {
      // Utiliser la configuration HLS optimisée selon le domaine
      const hlsConfig: any = createHlsConfig(normalizedSrc);
      // Cinep/purstream masters can declare direct-.vtt subtitles that crash
      // hls.js — route them through the proxy vttwrap endpoint. Video stays direct.
      const isBravoSrc = Array.isArray(purstreamSources) && purstreamSources.some(s => s.url === normalizedSrc);
      if (isBravoSrc && Hls) {
        hlsConfig.pLoader = makeCinepSubtitlePLoader(Hls);
      }
      console.log(`📡 [HLSPlayer] Initializing HLS with URL: ${normalizedSrc.substring(0, 100)}...`);
      const hls = new Hls(hlsConfig);

      hlsRef.current = hls;
      // Le proxy sera automatiquement appliqué par xhrSetup si nécessaire
      hls.loadSource(normalizedSrc);
      hls.attachMedia(video);

      const updateCurrentSourceStreamQuality = (levelIndex?: number) => {
        const fallbackIndex = typeof levelIndex === 'number' && levelIndex >= 0
          ? levelIndex
          : (hls.currentLevel >= 0 ? hls.currentLevel : hls.firstLevel);
        const level = typeof fallbackIndex === 'number' && fallbackIndex >= 0 ? hls.levels[fallbackIndex] : undefined;
        const qualityLabel = formatDetectedStreamQuality(level);

        rememberSourceQuality(normalizedSrc, qualityLabel);
      };

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        // Le manifest a été parsé, le flux est valide - annuler le timeout de changement de source
        clearSourceTimeout();
        console.log('✅ Manifest parsed - source timeout cleared, stream is valid');

        // Nettoyer les compteurs de retry car le manifest a été parsé avec succès
        if ((window as any).fragParsingGlobalRetry) {
          delete (window as any).fragParsingGlobalRetry;
        }
        if ((window as any).fragParsingLateRetries) {
          delete (window as any).fragParsingLateRetries;
        }

        const availableQualities = data.levels.map(level => ({
          height: level.height,
          url: level.url
        }));
        setQualities(availableQualities);
        updateCurrentSourceStreamQuality();

        // Re-apply playback speed after manifest is parsed
        if (videoRef.current) {
          console.log(`[HLS Manifest Parsed] Re-applying playback speed: ${playbackSpeed}`);
          videoRef.current.playbackRate = playbackSpeed;
        }

        // Vérifier la compatibilité audio/vidéo
        const isServersicuro = normalizedSrc.includes('serversicuro.cc');
        if (isServersicuro) {
          console.log('🔍 Checking audio/video codec compatibility for serversicuro...');

          // Vérifier si l'audio est disponible
          if (data.audioTracks && data.audioTracks.length > 0) {
            console.log('✅ Audio tracks found:', data.audioTracks.length);
            data.audioTracks.forEach((track, index) => {
              console.log(`  Track ${index}: ${track.name || 'Unknown'} (${track.lang || 'unknown'})`);
            });
          } else {
            console.warn('⚠️ No audio tracks found in manifest');
          }

          // Vérifier les niveaux vidéo
          if (data.levels && data.levels.length > 0) {
            console.log('✅ Video levels found:', data.levels.length);
            data.levels.forEach((level, index) => {
              console.log(`  Level ${index}: ${level.width}x${level.height} (${level.bitrate}bps)`);
            });
          }
        }

        // Restore position across source switches (e.g. anime player change).
        const hlsResumeTime = lastKnownTimeRef.current;
        if (hlsResumeTime > 0.5 && videoRef.current) {
          const seekTarget = hlsResumeTime;
          const trySeek = () => {
            const v = videoRef.current;
            if (!v) return;
            if (v.readyState >= 1) {
              try {
                v.currentTime = seekTarget;
              } catch {}
            } else {
              setTimeout(trySeek, 80);
            }
          };
          trySeek();
        }

        if (autoPlay) {
          safePlay(video).catch(e => console.error('Erreur de lecture automatique:', e));
        }

        const tracks = data.audioTracks || [];
        const audioTracksList = tracks.map((track, index) => ({
          id: index,
          name: track.name || `Audio ${index + 1}`,
          language: track.lang || 'unknown',
          groupId: track.groupId
        }));
        setAudioTracks(audioTracksList);

        // Désactiver tous les sous-titres par défaut
        video.textTracks.addEventListener('addtrack', (event) => {
          const track = event.track;
          if (track) {
            track.mode = 'disabled';
          }
        });

        Array.from(video.textTracks).forEach(track => {
          track.mode = 'disabled';
        });
      });

      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_) => {
        const tracks = Array.from(video.textTracks);
        setSubtitles(tracks);
      });

      // Ajouter un gestionnaire pour détecter les problèmes de lecture
      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        // Un fragment a été chargé, le flux fonctionne - annuler le timeout de changement de source
        clearSourceTimeout();

        const isServersicuro = src.includes('serversicuro.cc');
        if (isServersicuro && data.frag) {
          console.log(`✅ Fragment loaded: ${data.frag.sn} (${data.frag.type})`);

          // Vérifier si c'est un fragment audio
          if (data.frag.type === 'audio') {
            console.log('🔊 Audio fragment loaded successfully');
          }
        }
      });

      // Gestionnaire pour les problèmes de buffer
      hls.on('hlsBufferEmptyError' as any, () => {
        const isServersicuro = src.includes('serversicuro.cc');
        if (isServersicuro) {
          console.warn('⚠️ Buffer empty error for serversicuro - attempting recovery...');
          hls.startLoad();
        }
      });

      // Gestionnaire pour les problèmes de niveau
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        const isServersicuro = src.includes('serversicuro.cc');
        if (isServersicuro) {
          console.log(`📊 Level loaded: ${data.level} (${data.details?.totalduration}s)`);
        }
      });

      // Listener pour détecter les fragments chargés avec succès (pour nettoyer la liste des échecs 429)
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        updateCurrentSourceStreamQuality(data.level);
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const isPulseTopstrime = src.includes('pulse.topstrime.online');
        if (isPulseTopstrime && data.frag && typeof data.frag.sn === 'number') {
          // Si un segment qui était dans la liste des échecs 429 est maintenant chargé avec succès
          if (failed429Segments.has(data.frag.sn)) {
            console.log(`✅ Segment ${data.frag.sn} loaded successfully after 429 retry`);
            failed429Segments.delete(data.frag.sn);
          }

          // Si on a réussi à charger plusieurs segments d'affilée, nettoyer la liste
          if (failed429Segments.size > 0) {
            // Si on est en train de lire normalement, nettoyer la liste des échecs
            if (!videoRef.current?.paused) {
              clearFailed429Segments();
            }
          }
        }
      });

      // Surveillance de la santé du buffer pour prévenir les erreurs
      hls.on(Hls.Events.BUFFER_APPENDING, () => {
        // Vérifier l'état de l'élément média avant l'ajout au buffer
        if (video.error) {
          console.warn('⚠️ Media element has error state during buffer append, clearing...');
          video.load(); // Reset l'élément média
        }
      });

      // Surveillance des niveaux de buffer
      hls.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
        if (data.type === 'video' || data.type === 'audio') {
          const buffered = video.buffered;
          if (buffered.length > 0) {
            const bufferEnd = buffered.end(buffered.length - 1);
            const currentTime = video.currentTime;
            const bufferAhead = bufferEnd - currentTime;

            // Si le buffer devient trop faible, préparer une récupération préventive
            if (bufferAhead < 2 && !video.paused) {
              console.log(`📊 Low buffer detected: ${bufferAhead.toFixed(2)}s ahead`);
            }
          }
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Gestion de l'erreur 403 : auto-switch vers le prochain lecteur HLS disponible
        if (data.response && (data.response.code === 403 || data.response.code === 4033)) {
          console.warn('🚫 403/4033 Forbidden error detected - trying next HLS player...');
          if (sourceTimeoutRef.current) {
            clearTimeout(sourceTimeoutRef.current);
            sourceTimeoutRef.current = null;
          }
          hls.destroy();
          setIsLoading(false);
          handleHlsError();
          return;
        }

        // A broken/unsupported subtitle must never kill video playback — drop
        // the subtitle track and continue instead of switching source.
        if (isSubtitleLoadError(data)) {
          console.warn('💬 Subtitle load/parse error — dropping subtitle, keeping playback:', data.details);
          try {
            if (hls.subtitleTrack >= 0) hls.subtitleTrack = -1;
            (hls as any).subtitleDisplay = false;
          } catch { /* ignore */ }
          return;
        }

        // Vérifier si c'est une erreur 429 (Too Many Requests)
        const is429Error = data.response && data.response.code === 429;
        const isPulseTopstrime = src.includes('pulse.topstrime.online');

        // Gestion spécifique des erreurs audio/vidéo
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          console.warn('🔊 Audio/Video Error detected:', data.details);

          // Gestion spécifique des erreurs de buffer stalled
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            console.error('🚨 Buffer stalled error detected - attempting recovery...');

            // Vérifier si on a trop d'erreurs bufferStalled consécutives
            const retryKey = `bufferStalled_general`;
            if (!(window as any).bufferStalledRetryCount) {
              (window as any).bufferStalledRetryCount = {};
            }
            (window as any).bufferStalledRetryCount[retryKey] = ((window as any).bufferStalledRetryCount[retryKey] || 0) + 1;

            // Si trop d'erreurs bufferStalled, déclencher un changement de source
            if ((window as any).bufferStalledRetryCount[retryKey] > 2) {
              console.error(`❌ Too many buffer stalled errors (${(window as any).bufferStalledRetryCount[retryKey]}), switching source...`);
              (window as any).bufferStalledRetryCount[retryKey] = 0; // Reset le compteur
              setTimeout(() => {
                // Déclencher le changement de source via un événement personnalisé
                const sourceChangeEvent = new CustomEvent('forceSourceChange', {
                  detail: { reason: 'too_many_buffer_stalled_errors', url: src }
                });
                window.dispatchEvent(sourceChangeEvent);
              }, 1000);
              return;
            }

            // Essayer de récupérer sans changer la position
            if (videoRef.current && hlsRef.current) {
              const currentTime = videoRef.current.currentTime;

              console.log(`🎯 Attempting recovery from buffer stalled error at ${currentTime}s`);

              hlsRef.current.stopLoad();
              setTimeout(() => {
                if (hlsRef.current && videoRef.current) {
                  hlsRef.current.startLoad(currentTime);
                  console.log(`▶️ Restarted HLS loading from: ${currentTime}s after buffer stalled error`);
                }
              }, 2000);
            }
            return;
          }

          // Gestion spécifique des erreurs de buffer append
          if (data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR) {
            console.error('🚨 Buffer append error detected - attempting recovery...');

            // Sauvegarder la position actuelle
            const currentTime = videoRef.current?.currentTime || 0;
            const wasPlaying = !videoRef.current?.paused;

            if (videoRef.current && hlsRef.current) {
              // Utiliser la fonction utilitaire pour réinitialiser l'état d'erreur
              resetMediaElementError(videoRef.current).then(() => {
                if (hlsRef.current && videoRef.current) {
                  console.log('🔄 Reattaching HLS after buffer append error...');

                  // Détacher et réattacher HLS pour un reset complet
                  hlsRef.current.detachMedia();
                  hlsRef.current.attachMedia(videoRef.current);
                  // Le proxy sera automatiquement appliqué par xhrSetup si nécessaire
                  hlsRef.current.loadSource(src);

                  // Restaurer la position et l'état de lecture
                  const onLoadedMetadata = () => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = Math.max(0, currentTime - 2); // Reculer légèrement
                      if (wasPlaying) {
                        safePlay(videoRef.current).catch(e => console.error('Error resuming playback:', e));
                      }
                      videoRef.current.removeEventListener('loadedmetadata', onLoadedMetadata);
                    }
                  };
                  videoRef.current.addEventListener('loadedmetadata', onLoadedMetadata);
                }
              }).catch((error) => {
                console.error('❌ Failed to recover from buffer append error:', error);
                // Si la récupération échoue, déclencher le changement de source
                setTimeout(() => {
                  handleHlsError();
                }, 1000);
              });
              return;
            }
          }

          if (data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR) {
            console.warn('🔊 Fragment parsing error detected:', data);

            const currentTime = videoRef.current?.currentTime || 0;
            const isEarlyError = currentTime < 30; // Dans les 30 premières secondes
            const failedFragSN = data.frag?.sn;

            // Utiliser un compteur global pour les erreurs au début (pas par fragment)
            if (!(window as any).fragParsingGlobalRetry) {
              (window as any).fragParsingGlobalRetry = 0;
            }

            const globalRetryCount = (window as any).fragParsingGlobalRetry;

            if (globalRetryCount < 4 && isEarlyError) {
              // Incrémenter le compteur global
              (window as any).fragParsingGlobalRetry = globalRetryCount + 1;

              console.log(`🔄 Attempting to recover from parsing error (attempt ${globalRetryCount + 1}/4)...`);
              console.log(`⏭️ Skipping problematic fragment at start (SN: ${failedFragSN})`);

              // Arrêter le chargement en cours
              hls.stopLoad();

              // Calculer la distance de saut basée sur la durée du fragment problématique
              const fragmentDuration = data.frag?.duration || 10; // Durée par défaut de 10s
              const skipDistance = Math.max(15, fragmentDuration * (globalRetryCount + 1));
              const skipTime = skipDistance;

              console.log(`🎯 Jumping forward to ${skipTime}s to skip corrupted fragments (fragment duration: ${fragmentDuration}s)`);

              // Attendre un peu puis redémarrer en sautant
              setTimeout(() => {
                if (hlsRef.current && videoRef.current) {
                  hlsRef.current.startLoad(skipTime);

                  const onCanPlay = () => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = skipTime;
                      safePlay(videoRef.current).catch(e => console.error('Error resuming playback:', e));
                      videoRef.current.removeEventListener('canplay', onCanPlay);
                      console.log(`✅ Playback resumed at ${skipTime}s`);
                    }
                  };
                  videoRef.current.addEventListener('canplay', onCanPlay);
                }
              }, 500);

              return;
            } else if (!isEarlyError) {
              // Pour les erreurs plus tard dans la vidéo (après 30s)
              // Utiliser un compteur séparé par fragment
              if (!(window as any).fragParsingLateRetries) {
                (window as any).fragParsingLateRetries = {};
              }

              const retryKey = `frag_${failedFragSN || 'unknown'}`;
              const lateRetryCount = (window as any).fragParsingLateRetries[retryKey] || 0;

              if (lateRetryCount < 2) {
                (window as any).fragParsingLateRetries[retryKey] = lateRetryCount + 1;
                console.log(`🔄 Late fragment error (attempt ${lateRetryCount + 1}/2) - restarting HLS load...`);

                hls.stopLoad();
                setTimeout(() => {
                  if (hlsRef.current) {
                    hlsRef.current.startLoad(Math.max(0, currentTime - 2));
                  }
                }, 300);

                return;
              } else {
                // Trop de tentatives pour ce fragment, vérifier si on doit vraiment sauter
                console.warn(`⏭️ Skipping problematic fragment ${failedFragSN} at ${currentTime}s`);
                delete (window as any).fragParsingLateRetries[retryKey];

                if (videoRef.current) {
                  // Vérifier si le fragment problématique est déjà dans le buffer
                  const video = videoRef.current;
                  const buffered = video.buffered;
                  let shouldSkip = true;

                  // Vérifier si le fragment problématique est dans le buffer
                  for (let i = 0; i < buffered.length; i++) {
                    const start = buffered.start(i);
                    const end = buffered.end(i);

                    // Si le temps actuel est dans une plage bufférée, ne pas sauter
                    if (currentTime >= start && currentTime <= end) {
                      console.log(`📺 Fragment already buffered from ${start}s to ${end}s, no need to skip`);
                      shouldSkip = false;
                      break;
                    }
                  }

                  if (shouldSkip) {
                    // Calculer la position du prochain fragment valide
                    // Au lieu de sauter 10s fixe, calculer la durée du fragment problématique
                    const fragmentDuration = data.frag?.duration || 10; // Durée par défaut de 10s
                    const skipTime = currentTime + fragmentDuration;

                    // Vérifier que le saut ne dépasse pas la durée totale
                    if (video.duration && skipTime < video.duration) {
                      video.currentTime = skipTime;
                      console.log(`🎯 Jumped to ${skipTime}s to skip corrupted fragment (duration: ${fragmentDuration}s)`);
                    } else {
                      console.log(`⚠️ Cannot skip beyond video duration (${video.duration}s), staying at current position`);
                    }
                  } else {
                    console.log(`✅ Fragment is already buffered, continuing playback without skip`);
                  }
                }

                return;
              }
            } else {
              // Trop de tentatives au début, changer de source
              console.error('❌ Max parsing retry attempts reached, switching to next source...');
              (window as any).fragParsingGlobalRetry = 0; // Reset le compteur

              // Déclencher le changement de source
              setTimeout(() => {
                handleHlsError();
              }, 500);

              return;
            }
          }

          if (data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR) {
            console.warn('⚠️ Codec error - trying to continue playback...');
            // Ne pas déclencher de changement de source pour les erreurs de codec
            return;
          }
        }

        // Gestion des erreurs de chargement de fragments
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          console.warn('🌐 Network Error detected:', data.details);

          if (isDnsLikeError(data)) {
            let host: string | undefined;
            try { host = new URL(src).hostname; } catch { /* ignore */ }
            const switched = dispatchDnsEmbedFallback(src, omegaSources, coflixSources);
            notifyDnsBlocked({ host, details: data.details, switched });
            if (switched) return;
          }

          if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
            console.log('🔄 Fragment load error - attempting recovery...');
            hls.startLoad();
            return;
          }

          if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
            console.error('📋 Manifest load error - switching source...');
            setTimeout(() => {
              handleHlsError();
            }, 1000);
            return;
          }
        }

        if (is429Error && isPulseTopstrime) {
          handle429Error(hlsRef.current, videoRef, data, src);
          return;
        }

        if (data.fatal) {
          console.error('🚨 HLS Fatal Error:', data.type, data.details);

          if (isDnsLikeError(data)) {
            let host: string | undefined;
            try { host = new URL(src).hostname; } catch { /* ignore */ }
            const switched = dispatchDnsEmbedFallback(src, omegaSources, coflixSources);
            notifyDnsBlocked({ host, details: data.details, switched });
            if (switched) return;
          }

          // Logique de récupération améliorée avant le changement de source
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // Compter les tentatives de récupération pour éviter les boucles infinies
            const recoveryKey = `${data.type}_${data.details}`;
            const currentAttempts = (window as any).hlsRecoveryAttempts?.[recoveryKey] || 0;

            if (currentAttempts < 2) {
              // Initialiser le compteur si nécessaire
              if (!(window as any).hlsRecoveryAttempts) {
                (window as any).hlsRecoveryAttempts = {};
              }
              (window as any).hlsRecoveryAttempts[recoveryKey] = currentAttempts + 1;

              console.log(`🔄 Attempting media error recovery (${currentAttempts + 1}/2)...`);

              // Stratégie de récupération différente selon le type d'erreur
              if (data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR) {
                // Déjà géré par le code spécifique plus haut
                return;
              } else {
                // Autres erreurs média
                hls.recoverMediaError();
                return;
              }
            } else {
              console.warn('⚠️ Max recovery attempts reached, switching source...');
              // Reset le compteur pour cette erreur
              delete (window as any).hlsRecoveryAttempts[recoveryKey];
            }
          }

          console.log('🔄 Triggering automatic source switching...');

          // Déclencher le changement automatique de source après un court délai
          setTimeout(() => {
            handleHlsError();
          }, 500);
        } else {
          console.warn('⚠️ HLS Non-fatal Error:', data.type, data.details);
        }
      });

      return () => {
        clearBufferingTimeout(); // Clear timeout on cleanup
        clearSourceTimeout(); // Clear source timeout on cleanup
        // Nettoyer les tentatives de récupération
        if ((window as any).hlsRecoveryAttempts) {
          delete (window as any).hlsRecoveryAttempts;
        }
        if ((window as any).fragParsingGlobalRetry) {
          delete (window as any).fragParsingGlobalRetry;
        }
        if ((window as any).fragParsingLateRetries) {
          delete (window as any).fragParsingLateRetries;
        }
        video.removeEventListener('loadstart', handleLoadStart);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('progress', handleProgress);
        hls.destroy();
        hlsRef.current = null;
      };
    } else {
      // For browsers that don't support HLS.js (like Safari)
      video.src = normalizedSrc;
      if (autoPlay) {
        safePlay(video).catch(e => console.error('Error autoplay in fallback mode:', e));
      }

      return () => {
        clearBufferingTimeout();
        clearSourceTimeout(); // Clear source timeout on cleanup
        // Nettoyer les tentatives de récupération
        if ((window as any).hlsRecoveryAttempts) {
          delete (window as any).hlsRecoveryAttempts;
        }
        if ((window as any).fragParsingGlobalRetry) {
          delete (window as any).fragParsingGlobalRetry;
        }
        if ((window as any).fragParsingLateRetries) {
          delete (window as any).fragParsingLateRetries;
        }
        video.removeEventListener('loadstart', handleLoadStart);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('progress', handleProgress);
        video.src = '';
      };
    }
  }, [src, autoPlay, onEnded, onError, subtitleUrl, Hls]); // REMOVED playbackSpeed

  // Auto next episode preference (must be declared before useEffect that references it)
  const [autoNextEpisodeEnabled, setAutoNextEpisodeEnabled] = useState(() => {
    const savedPref = localStorage.getItem('playerAutoNextEpisodePref');
    return savedPref !== null ? JSON.parse(savedPref) : true; // Default to true
  });

  useEffect(() => {
    localStorage.setItem('playerAutoNextEpisodePref', JSON.stringify(autoNextEpisodeEnabled));
  }, [autoNextEpisodeEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      void ensureAudioEnhancerReady();
      setIsPlaying(true);
      // Call WatchPartyRoom callback if provided
      if (onPlayerPlay) onPlayerPlay();
    };
    const handlePause = () => {
      setIsPlaying(false);
      // Call WatchPartyRoom callback if provided
      if (onPlayerPause) onPlayerPause();
    };
    const handleEnded = () => {
      setIsPlaying(false);

      // Si la lecture en boucle est activée, remettre la vidéo au début
      if (isLooping && videoRef.current) {
        videoRef.current.currentTime = 0;
        safePlay(videoRef.current).catch(e => console.error('Error replaying video:', e));
        // Appeler onEnded et onPlayerEnded même en mode boucle
        if (onEnded) onEnded();
        if (onPlayerEnded) onPlayerEnded();
        // IMPORTANT: Ne pas appeler onNextEpisode en mode boucle
        return;
      }

      // Appeler onEnded et onPlayerEnded
      if (onEnded) onEnded();
      if (onPlayerEnded) onPlayerEnded();

      // Seulement naviguer vers l'épisode suivant si la lecture en boucle n'est PAS activée
      if (nextMovie) {
        setShowNextMovie(true);
      }
      if (nextEpisode && onNextEpisode && autoNextEpisodeEnabled) {
        onNextEpisode(nextEpisode.seasonNumber, nextEpisode.episodeNumber);
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
    };
  }, [nextMovie, nextEpisode, onNextEpisode, isLooping, onEnded, onPlayerEnded, onPlayerPlay, onPlayerPause, autoNextEpisodeEnabled, audioEnhancerMode, volumeBoost, customAudio]);

  // Add seeked event listener for WatchParty seek sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleSeeked = () => {
      // Call WatchPartyRoom callback if provided
      if (onPlayerSeeked) {
        console.log('[HLSPlayer] Seeked event - calling onPlayerSeeked');
        onPlayerSeeked();
      }
    };

    video.addEventListener('seeked', handleSeeked);

    return () => {
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [onPlayerSeeked]);

  // Unlock helper: cleans timers and history sentinel.
  const unlockPlayer = useCallback(() => {
    setIsLocked(false);
    setShowLockTip(false);
    lockTapCountRef.current = 0;
    if (lockTapTimerRef.current) {
      clearTimeout(lockTapTimerRef.current);
      lockTapTimerRef.current = null;
    }
    if (lockTipTimerRef.current) {
      clearTimeout(lockTipTimerRef.current);
      lockTipTimerRef.current = null;
    }
    if (lockPushedHistoryRef.current) {
      lockPushedHistoryRef.current = false;
      // Consume the sentinel state we pushed on lock so the user's real
      // history isn't polluted. Guard with try/catch for environments where
      // history manipulation can throw.
      try {
        if (window.history.state && (window.history.state as any).hlsPlayerLocked) {
          window.history.back();
        }
      } catch {}
    }
  }, []);

  const enterLockMode = useCallback(() => {
    setIsLocked(true);
    setShowLockTip(true);
    setShowControls(false);
    setShowSettings(false);
    setShowCastMenu(false);
    lockTapCountRef.current = 0;

    if (lockTipTimerRef.current) clearTimeout(lockTipTimerRef.current);
    lockTipTimerRef.current = setTimeout(() => setShowLockTip(false), 3500);

    // Push a sentinel history state so the mobile back button exits lock
    // mode instead of leaving the player page.
    try {
      window.history.pushState({ hlsPlayerLocked: true }, '');
      lockPushedHistoryRef.current = true;
    } catch {}
  }, []);

  const registerLockTap = useCallback(() => {
    lockTapCountRef.current += 1;
    if (lockTapTimerRef.current) clearTimeout(lockTapTimerRef.current);

    if (lockTapCountRef.current >= 3) {
      unlockPlayer();
      return;
    }

    // Re-show the tip on interaction so the user knows how to exit, and
    // reset the counter after a short window of inactivity.
    setShowLockTip(true);
    if (lockTipTimerRef.current) clearTimeout(lockTipTimerRef.current);
    lockTipTimerRef.current = setTimeout(() => setShowLockTip(false), 2000);

    lockTapTimerRef.current = setTimeout(() => {
      lockTapCountRef.current = 0;
    }, 600);
  }, [unlockPlayer]);

  // Desktop Escape + mobile back button unlock the player.
  useEffect(() => {
    if (!isLocked) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        unlockPlayer();
      }
    };
    const handlePopState = () => {
      lockPushedHistoryRef.current = false;
      unlockPlayer();
    };

    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isLocked, unlockPlayer]);

  useEffect(() => () => {
    if (lockTapTimerRef.current) clearTimeout(lockTapTimerRef.current);
    if (lockTipTimerRef.current) clearTimeout(lockTipTimerRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handleDurationChange = () => {
      setDuration(video.duration);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleDurationChange);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleDurationChange);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (isDragging) return;
      setCurrentTime(video.currentTime);
      setDuration(video.duration);
      // Keep the last known position in a ref that survives cleanup of the
      // main src effect (which clears video.src and resets currentTime).
      if (video.currentTime > 0.5) {
        lastKnownTimeRef.current = video.currentTime;
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [isDragging]);

  // Reset persisted position when the actual episode/movie changes (not on
  // a mere source switch for the same episode).
  useEffect(() => {
    const key = `${tvShowId ?? movieId ?? ''}|${seasonNumber ?? ''}|${episodeNumber ?? ''}`;
    if (lastEpisodeKeyRef.current && lastEpisodeKeyRef.current !== key) {
      lastKnownTimeRef.current = 0;
    }
    lastEpisodeKeyRef.current = key;
  }, [tvShowId, movieId, seasonNumber, episodeNumber]);


  const handleSubtitleChange = (subtitleId: string | null) => {
    const video = videoRef.current;
    if (!video) return;

    // Désactiver tous les tracks
    Array.from(video.textTracks).forEach(track => {
      track.mode = 'disabled';
    });

    if (!subtitleId || subtitleId === 'off') {
      setSelectedSubtitleUrl(null);
      setSelectedSubtitleLang(null);
      setCurrentSubtitle('off');
      setActiveSubtitleCues([]);
      setSubtitleContainerVisible(false);
      return;
    }

    if (subtitleId.startsWith('internal:')) {
      const track = Array.from(video.textTracks).find((t, idx) => `internal:${idx}` === subtitleId);
      if (track) {
        track.mode = 'hidden';
        setCurrentSubtitle(subtitleId);
        setSelectedSubtitleLang(track.language || null);
        const trackUrl = track.hasOwnProperty('src') ? (track as any).src : track.hasOwnProperty('url') ? (track as any).url : '';
        setSelectedSubtitleUrl(trackUrl);
        refreshActiveCues(video, track, subtitleStyle.delay);
      }
    } else if (subtitleId.startsWith('external:')) {
      // La sélection d'un sous-titre externe est déjà gérée dans le bouton (setCurrentSubtitle)
      // On ne fait rien ici, car loadExternalSubtitle s'occupe d'ajouter le track et de le sélectionner
    }
  };

  // Fetch imdb id from TMDB for a movieId or tvShowId (strip leading 'tt' for OpenSubtitles)
  const fetchImdbId = async (tmdbId?: string | number, isTvShow: boolean = false): Promise<string | null> => {
    if (!tmdbId) return null;
    const key = String(tmdbId);
    const cacheKey = `${key}_${isTvShow ? 'tv' : 'movie'}`;

    if (imdbCacheRef.current[cacheKey]) return imdbCacheRef.current[cacheKey];

    try {
      const endpoint = isTvShow ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${key}/external_ids?api_key=${TMDB_API_KEY}`;
      const res = await axios.get(url);
      const imdb = res.data?.external_ids?.imdb_id || res.data?.imdb_id || null; // e.g. 'tt1300854'

      if (imdb) {
        imdbCacheRef.current[cacheKey] = imdb.replace(/^tt/, '');
        return imdbCacheRef.current[cacheKey];
      }
      imdbCacheRef.current[cacheKey] = null;
      return null;
    } catch (err) {
      console.error('Error fetching imdb id from TMDB', err);
      imdbCacheRef.current[cacheKey] = null;
      return null;
    }
  };

  // Fetch available subtitle languages from OpenSubtitles for the current movie/episode
  useEffect(() => {
    let cancelled = false;

    const fetchAvailableLanguages = async () => {
      const hasMovieId = !!movieId;
      const hasTvShowId = !!tvShowId;

      if (!hasMovieId && !hasTvShowId) {
        setAvailableExternalLangCodes(null);
        return;
      }

      setExternalLangsLoading(true);
      try {
        let imdb: string | null = null;
        let osUrl: string;

        if (hasTvShowId && tvShowId && seasonNumber && episodeNumber) {
          imdb = await fetchImdbId(tvShowId, true);
          if (!imdb) { setExternalLangsLoading(false); return; }
          osUrl = `https://rest.opensubtitles.org/search/episode-${episodeNumber}/imdbid-${imdb}/season-${seasonNumber}`;
        } else if (hasMovieId) {
          imdb = await fetchImdbId(movieId, false);
          if (!imdb) { setExternalLangsLoading(false); return; }
          osUrl = `https://rest.opensubtitles.org/search/imdbid-${imdb}`;
        } else {
          setExternalLangsLoading(false);
          return;
        }

        const res = await axios.get(osUrl, { headers: { 'User-Agent': 'Movix/1.0' } });
        if (cancelled) return;

        if (Array.isArray(res.data)) {
          const langs = new Set<string>();
          for (const sub of res.data) {
            if (sub.SubLanguageID) langs.add(sub.SubLanguageID);
          }
          setAvailableExternalLangCodes(langs);
        } else {
          setAvailableExternalLangCodes(new Set());
        }
      } catch (err) {
        console.error('Error fetching available subtitle languages', err);
        if (!cancelled) setAvailableExternalLangCodes(null);
      } finally {
        if (!cancelled) setExternalLangsLoading(false);
      }
    };

    fetchAvailableLanguages();
    return () => { cancelled = true; };
  }, [movieId, tvShowId, seasonNumber, episodeNumber]);

  // When user selects an external language, query OpenSubtitles for that imdb id
  const handleExternalLanguageSelect = async (langCode: string) => {
    setSelectedExternalLang(langCode);
    setExternalSubs([]);

    // Check if we have either a movie or TV show ID
    const hasMovieId = !!movieId;
    const hasTvShowId = !!tvShowId;

    if (!hasMovieId && !hasTvShowId) {
      console.warn('No movieId or tvShowId (TMDB) provided, external subtitles require one of these');
      return;
    }

    setExternalLoading(true);
    try {
      let imdb: string | null = null;
      let osUrl: string;

      if (hasTvShowId && tvShowId && seasonNumber && episodeNumber) {
        // TV Show: use the new route format for series
        imdb = await fetchImdbId(tvShowId, true);
        if (!imdb) {
          console.warn('No imdb id found for TV show', tvShowId);
          setExternalLoading(false);
          return;
        }

        // Format: episode-{episodeNumber}/imdbid-{imdb}/season-{seasonNumber}/sublanguageid-{langCode}
        osUrl = `https://rest.opensubtitles.org/search/episode-${episodeNumber}/imdbid-${imdb}/season-${seasonNumber}/sublanguageid-${langCode}`;
      } else if (hasMovieId) {
        // Movie: use the existing route format
        imdb = await fetchImdbId(movieId, false);
        if (!imdb) {
          console.warn('No imdb id found for movie', movieId);
          setExternalLoading(false);
          return;
        }

        osUrl = `https://rest.opensubtitles.org/search/imdbid-${imdb}/sublanguageid-${langCode}`;
      } else {
        console.warn('Missing required parameters for external subtitles');
        setExternalLoading(false);
        return;
      }

      // OpenSubtitles requires a User-Agent header; set a simple one
      console.log(`Fetching OpenSubtitles from: ${osUrl}`);
      const res = await axios.get(osUrl, { headers: { 'User-Agent': 'Movix/1.0' } });
      if (Array.isArray(res.data)) {
        console.log(`Found ${res.data.length} subtitle results for ${hasTvShowId ? 'TV show' : 'movie'}`);
        setExternalSubs(res.data);
      } else {
        console.log('No subtitle results found or unexpected response format');
        setExternalSubs([]);
      }
    } catch (err) {
      console.error('Error fetching OpenSubtitles', err);
      setExternalSubs([]);
    } finally {
      setExternalLoading(false);
    }
  };

  // Load selected external subtitle into the video by creating a <track> element
  const loadExternalSubtitle = async (sub: any, id?: string) => {
    if (!videoRef.current || !sub) return;
    setLoadingSubtitle(true);
    try {
      const video = videoRef.current;

      // Remove existing external tracks we added previously and revoke blob urls
      const existingTracks = Array.from(video.querySelectorAll('track[data-external="1"]')) as HTMLTrackElement[];
      existingTracks.forEach(t => {
        try {
          if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
        } catch (e) { }
        t.remove();
      });

      const trackEl = document.createElement('track');
      trackEl.kind = 'subtitles';
      trackEl.label = `${sub.LanguageName || sub.SubLanguageID || selectedExternalLang} - ${sub.SubFileName || 'External'}`;
      trackEl.srclang = sub.ISO639 || sub.SubLanguageID || (selectedExternalLang || 'und');
      trackEl.setAttribute('data-external', '1');

      // Prefer the official SubDownloadLink (it's a .gz containing an .srt)
      const downloadLink = sub.SubDownloadLink || sub.SubDownloadLinkForBrowser || sub.DownloadLink || sub.Link || null;
      if (downloadLink) {
        try {
          // Download and extract the .gz file locally using PAKO
          const response = await fetch(downloadLink, {
            headers: {
              'User-Agent': 'Movix/1.0'
            }
          });

          if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const buffer = new Uint8Array(arrayBuffer);

          // Check if it's a valid gzip file
          if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
            console.warn('File does not appear to be gzipped, trying direct processing');
            // Try to process as regular SRT file
            const srtContent = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
            const vttContent = 'WEBVTT\n\n' + srtContent
              .replace(/^\s*\d+\s*$/gm, '')
              .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
            const blob = new Blob([vttContent], { type: 'text/vtt' });
            const objUrl = URL.createObjectURL(blob);
            trackEl.src = objUrl;
            console.log('Processed as regular SRT file');
            return;
          }

          // Extract using PAKO (lazy-loaded)
          const pako = await loadPako();
          let extractedData: Uint8Array;
          try {
            extractedData = pako.inflate(buffer);
            console.log(`Successfully extracted ${extractedData.length} bytes from gzip`);
          } catch (error) {
            console.error('PAKO extraction failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to extract gzip file: ${errorMessage}`);
          }

          // Convert to string and handle encoding detection using our helper function (exact same logic as server.js)
          const detectedEncoding = detectEncoding(extractedData);
          let srtContent: string;

          try {
            // Premier essai avec l'encodage détecté
            if (detectedEncoding === 'utf16le' || detectedEncoding === 'utf16be') {
              // Gestion spéciale pour UTF-16 (exactement comme dans server.js)
              try {
                srtContent = new TextDecoder(detectedEncoding).decode(extractedData);
                console.log(`Successfully decoded with detected encoding: ${detectedEncoding}`);
              } catch (utf16Err) {
                // Si UTF-16 échoue, essayer UTF-8
                srtContent = new TextDecoder('utf-8', { fatal: false }).decode(extractedData);
                console.log(`UTF-16 failed, fallback to UTF-8 successful`);
              }
            } else {
              // Pour les autres encodages
              srtContent = new TextDecoder(detectedEncoding).decode(extractedData);
              console.log(`Successfully decoded with detected encoding: ${detectedEncoding}`);
            }
          } catch (err) {
            console.warn(`Failed to decode with detected encoding ${detectedEncoding}, trying fallbacks like server.js`);
            try {
              // Premier fallback: Latin-1 (exactement comme dans server.js)
              srtContent = new TextDecoder('latin1').decode(extractedData);
              console.log('Fallback to Latin-1 successful');
            } catch (e2) {
              // Deuxième fallback: UTF-8 (exactement comme dans server.js)
              srtContent = new TextDecoder('utf-8', { fatal: false }).decode(extractedData);
              console.log('Fallback to UTF-8 successful');
            }
          }

          // Clean up the SRT content (same logic as server.js)
          srtContent = srtContent.replace(/\r\n/g, '\n').trim();

          // Convert SRT to VTT format
          const vttContent = 'WEBVTT\n\n' + srtContent
            .replace(/^\s*\d+\s*$/gm, '') // Remove sequence numbers
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'); // Convert commas to dots in timestamps

          const blob = new Blob([vttContent], { type: 'text/vtt' });
          const objUrl = URL.createObjectURL(blob);
          trackEl.src = objUrl;

          console.log('Successfully extracted and converted subtitle using PAKO');
        } catch (err) {
          console.error('Failed to fetch/extract external subtitle with PAKO:', err);
          // fallback: try to use SubDownloadLink directly (may be blocked by CORS)
          trackEl.src = downloadLink;
        }
      } else {
        // No download link: try common ID based cloud URL (may be blocked)
        const id = sub.IDSubtitleFile || sub.IDSubtitle || sub.ID || sub.SubID || '';
        if (id) {
          trackEl.src = `https://cloudnestra.com/sub/ops-${id}.vtt&ext=.vtt`;
        } else {
          console.warn('No usable download link for subtitle', sub);
        }
      }

      video.appendChild(trackEl);

      // Wait for the browser to parse the VTT and populate cues.
      const enableTrack = (textTrack?: TextTrack | null) => {
        const added = textTrack || Array.from(video.textTracks).find(t => (t as any).label === trackEl.label || t.language === trackEl.srclang);
        if (added) {
          // Disable all other tracks
          Array.from(video.textTracks).forEach(t => t.mode = 'disabled');
          added.mode = 'hidden';
          // Use the external id if provided, otherwise fall back to language code
          setCurrentSubtitle(id || added.language || String(trackEl.srclang));
          setSubtitleContainerVisible(true);
          refreshActiveCues(video, added, subtitleStyle.delay);
          return true;
        }
        return false;
      };

      let resolved = false;
      const onLoad = () => {
        if (resolved) return;
        resolved = enableTrack();
        try { trackEl.removeEventListener('load', onLoad); } catch (e) { }
      };
      try { trackEl.addEventListener('load', onLoad); } catch (e) { }

      // Fallback polling for cues
      let attempts = 0;
      const maxAttempts = 15;
      const poll = () => {
        if (resolved) return;
        attempts += 1;
        const ok = enableTrack();
        if (ok) {
          resolved = true;
          try { trackEl.removeEventListener('load', onLoad); } catch (e) { }
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(poll, 200);
        } else {
          try { trackEl.removeEventListener('load', onLoad); } catch (e) { }
        }
      };
      setTimeout(poll, 150);
    } catch (err) {
      console.error('Error loading external subtitle', err);
    } finally {
      setLoadingSubtitle(false);
    }
  };

  // Helper function to detect text encoding from byte array (exact same logic as server.js)
  const detectEncoding = (buffer: Uint8Array): string => {
    // Détecter BOM UTF-16/UTF-8 (exactement comme dans server.js)
    let encoding: string | null = null;
    if (buffer.length >= 2) {
      if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        encoding = 'utf16le';
      } else if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
        encoding = 'utf16be';
      } else if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        encoding = 'utf8';
      }
    }

    if (!encoding) {
      // Heuristique de détection d'encodage (reproduction de la logique server.js)
      // On simule chardet.detect() avec une approche basée sur les patterns de bytes
      const sample = buffer.slice(0, Math.min(1000, buffer.length));

      // Vérifier si c'est probablement UTF-8
      let isUtf8 = true;
      let i = 0;
      while (i < sample.length) {
        if (sample[i] < 0x80) {
          // ASCII character
          i++;
        } else if ((sample[i] & 0xE0) === 0xC0) {
          // 2-byte UTF-8 sequence
          if (i + 1 >= sample.length || (sample[i + 1] & 0xC0) !== 0x80) {
            isUtf8 = false;
            break;
          }
          i += 2;
        } else if ((sample[i] & 0xF0) === 0xE0) {
          // 3-byte UTF-8 sequence
          if (i + 2 >= sample.length ||
            (sample[i + 1] & 0xC0) !== 0x80 ||
            (sample[i + 2] & 0xC0) !== 0x80) {
            isUtf8 = false;
            break;
          }
          i += 3;
        } else {
          isUtf8 = false;
          break;
        }
      }

      if (isUtf8) {
        encoding = 'utf8';
      } else {
        // Vérifier si c'est probablement Latin-1 (ISO-8859-1)
        const hasHighBytes = sample.some(byte => byte > 0x7F && byte < 0xA0);
        if (!hasHighBytes) {
          encoding = 'latin1';
        } else {
          // Vérifier si c'est probablement Windows-1252
          const hasWin1252Chars = sample.some(byte =>
            (byte >= 0x80 && byte <= 0x9F) ||
            (byte >= 0xA0 && byte <= 0xFF)
          );
          if (hasWin1252Chars) {
            encoding = 'windows-1252';
          } else {
            // Fallback par défaut
            encoding = 'latin1';
          }
        }
      }
    }

    return encoding || 'utf8';
  };

  // Add this helper function to refresh active cues
  const refreshActiveCues = (video: HTMLVideoElement, track: TextTrack, delay: number) => {
    if (!track || !video) return;

    // Manually check which cues should be active based on current time and delay
    const adjustedTime = video.currentTime - delay;

    // Filter cues based on the adjusted time
    const adjustedCues = (Array.from(track.cues || []) as VTTCue[]).filter(cue =>
      cue.startTime <= adjustedTime && adjustedTime <= cue.endTime
    );

    // Segmented HLS WebVTT repeats the same cue across segment boundaries, so
    // track.cues can contain identical cues that render twice. Dedup on time+text.
    const seen = new Set<string>();
    const dedupedCues = adjustedCues.filter(cue => {
      const key = `${cue.startTime}-${cue.endTime}-${cue.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setActiveSubtitleCues(dedupedCues);
    setSubtitleContainerVisible(dedupedCues.length > 0);

  };

  // Batch-translate texts by joining them with a separator in a single request (POST to avoid URL length limits)
  const batchTranslateChunk = useCallback(async (texts: string[], targetLang: string): Promise<Map<string, string>> => {
    const SEPARATOR = '\n\n||||\n\n';
    const results = new Map<string, string>();
    const plains = texts.map(t => t.replace(/<[^>]*>/g, ''));
    const joined = plains.join(SEPARATOR);

    let batchOk = false;
    try {
      const res = await axios.post(
        'https://translate.googleapis.com/translate_a/single',
        new URLSearchParams({ q: joined }),
        { params: { client: 'gtx', sl: 'auto', tl: targetLang, dt: 't' } }
      );
      const fullTranslated = (res.data[0] as Array<[string]>).map(s => s[0]).join('');
      const parts = fullTranslated.split(/\s*\|{4}\s*/);

      // Only trust the batched result when Google preserved every separator.
      // Why: if parts.length !== texts.length, the response is unreliable and
      // the original code fell back to the source-language plain text, which
      // got stored as "translation" and rendered as if it were one — silent
      // failure where the user sees the indicator "Translation active" with
      // untranslated subtitles. Bailing here forces the per-cue fallback.
      if (parts.length === texts.length) {
        for (let i = 0; i < texts.length; i++) {
          const part = (parts[i] || '').trim();
          if (part) results.set(texts[i], part);
        }
        batchOk = true;
      }
    } catch {
      // batched call rejected — fall through to per-cue path
    }

    if (batchOk) return results;

    // Per-cue fallback: slower but reliable when the batched separator broke.
    await Promise.all(plains.map(async (plain, i) => {
      if (!plain.trim()) return;
      try {
        const res = await axios.post(
          'https://translate.googleapis.com/translate_a/single',
          new URLSearchParams({ q: plain }),
          { params: { client: 'gtx', sl: 'auto', tl: targetLang, dt: 't' } }
        );
        const translated = ((res.data[0] as Array<[string]>) || []).map(s => s[0]).join('').trim();
        // Only store actual translations. On empty/failure, leave the key
        // unset so the renderer's `|| cue.text` fallback picks up the
        // original (with HTML preserved) instead of polluting the Map.
        if (translated) results.set(texts[i], translated);
      } catch {
        // skip — renderer falls back to cue.text on lookup miss
      }
    }));

    return results;
  }, []);

  // Start translating all cues of the current active track
  const startSubtitleTranslation = useCallback(async () => {
    if (!translateSubsTo || !videoRef.current) return;

    const video = videoRef.current;
    const activeTrack = Array.from(video.textTracks).find(
      track => track.mode === 'showing' || track.mode === 'hidden'
    );
    if (!activeTrack?.cues?.length) return;

    // Deduplicate cue texts
    const uniqueTexts: string[] = [];
    const seen = new Set<string>();
    for (const cue of Array.from(activeTrack.cues)) {
      const text = (cue as VTTCue).text;
      if (text && !seen.has(text)) {
        seen.add(text);
        uniqueTexts.push(text);
      }
    }

    translationAbortRef.current = false;
    translationCacheRef.current.clear();
    setTranslatedCueTexts(new Map());
    setTranslationProgress({ done: 0, total: uniqueTexts.length });
    setTranslationLang(translateSubsTo);

    const results = new Map<string, string>();
    // Use byte length to handle multibyte characters (Chinese, Arabic, etc.)
    const MAX_BYTES = 4000;
    const getByteLen = (s: string) => new Blob([s]).size;
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentLen = 0;

    for (const text of uniqueTexts) {
      const plain = text.replace(/<[^>]*>/g, '');
      const addition = getByteLen(plain) + 20; // separator overhead
      if (currentLen + addition > MAX_BYTES && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLen = 0;
      }
      currentChunk.push(text);
      currentLen += addition;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    // Process chunks with parallel batches of 3 concurrent requests
    const CONCURRENT = 3;
    let totalDone = 0;

    for (let i = 0; i < chunks.length; i += CONCURRENT) {
      if (translationAbortRef.current) break;

      const batch = chunks.slice(i, i + CONCURRENT);
      const batchResults = await Promise.all(
        batch.map(chunk => batchTranslateChunk(chunk, translateSubsTo))
      );

      for (const map of batchResults) {
        for (const [key, val] of map) {
          results.set(key, val);
          translationCacheRef.current.set(key, val);
        }
      }

      totalDone += batch.reduce((sum, c) => sum + c.length, 0);
      if (!translationAbortRef.current) {
        setTranslatedCueTexts(new Map(results));
        setTranslationProgress({ done: Math.min(totalDone, uniqueTexts.length), total: uniqueTexts.length });
      }
    }

    if (!translationAbortRef.current) {
      setTranslationProgress(null);
      // If nothing came back translated, surface the failure rather than
      // showing a misleading "Translation active" badge over English subs.
      if (results.size === 0 && uniqueTexts.length > 0) {
        setTranslationLang(null);
        setTranslatedCueTexts(new Map());
        toast.error(t('watch.translationFailed'));
      }
    }
  }, [translateSubsTo, batchTranslateChunk, t]);

  // Cancel ongoing translation
  const cancelSubtitleTranslation = useCallback(() => {
    translationAbortRef.current = true;
    setTranslationProgress(null);
    setTranslatedCueTexts(new Map());
    setTranslationLang(null);
  }, []);

  const handleMouseMove = useCallback((e?: Event | React.MouseEvent | PointerEvent) => {
    // Ignore touch drag events (touch taps/toggles are handled separately)
    if (touchActiveRef.current) return;
    if (e && 'pointerType' in e && (e as PointerEvent).pointerType === 'touch') return;

    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (isPlaying && !showCastMenu) {
      controlsTimeoutRef.current = setTimeout(() => {
        // Vérifier si des animations +10/-10 sont en cours avant de cacher
        if (!showCastMenu && !showForwardAnimation && !showRewindAnimation && !showLeftTapAnimation && !showRightTapAnimation) {
          setShowControls(false);
          setShowVolumeSlider(false);
        }
      }, 5000);
    }
  }, [isPlaying, showCastMenu, showForwardAnimation, showRewindAnimation, showLeftTapAnimation, showRightTapAnimation]);


  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch(e => console.error('Erreur de lecture:', e));
    } else {
      video.pause();
      setIsPlaying(false);
      // Suppression de l'animation de pause
      // showTemporaryAnimation(setShowPauseAnimation);
    }
  };

  const toggleLoop = () => {
    setIsLooping(prev => !prev);
  };


  // Updated Mute Toggle Handler
  const handleMuteToggle = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.muted) {
      // Unmute: Restore volume state and video muted property
      let restoreVolume = previousVolume > 0 ? previousVolume : 1;
      restoreVolume = clampVolume(restoreVolume);
      video.muted = false;
      video.volume = restoreVolume;
      setVolume(restoreVolume);
      localStorage.setItem('playerVolume', restoreVolume.toString());
    } else {
      setPreviousVolume(volume); // Store current volume before muting
      video.muted = true;
      setVolume(0);
    }
  };

  // Updated Volume Slider Handler
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    let newVolume = parseFloat(e.target.value);
    if (isNaN(newVolume)) return;
    newVolume = clampVolume(newVolume);
    video.volume = newVolume;
    setVolume(newVolume);
    localStorage.setItem('playerVolume', newVolume.toString());

    if (newVolume > 0 && video.muted) {
      video.muted = false;
      setPreviousVolume(newVolume);
    } else if (newVolume === 0 && !video.muted) {
      setPreviousVolume(volume > 0 ? volume : previousVolume);
      video.muted = true;
    }
    if (newVolume > 0) {
      setPreviousVolume(newVolume);
    }
  };

  // Volume booster initialization function (with audio enhancer chain)
  const initializeVolumeBooster = useCallback(() => {
    const video = videoRef.current;
    if (!video || sourceNodeRef.current) return; // Don't reinitialize if already set up

    try {
      // Create AudioContext if not exists
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const ctx = audioContextRef.current;

      // Create media element source
      sourceNodeRef.current = ctx.createMediaElementSource(video);

      // Create audio enhancer nodes
      // Bass filter (low-shelf)
      bassFilterRef.current = ctx.createBiquadFilter();
      bassFilterRef.current.type = 'lowshelf';
      bassFilterRef.current.frequency.value = 200;
      bassFilterRef.current.gain.value = 0;

      // Mid filter (peaking)
      midFilterRef.current = ctx.createBiquadFilter();
      midFilterRef.current.type = 'peaking';
      midFilterRef.current.frequency.value = 2000;
      midFilterRef.current.Q.value = 1;
      midFilterRef.current.gain.value = 0;

      // Treble filter (high-shelf)
      trebleFilterRef.current = ctx.createBiquadFilter();
      trebleFilterRef.current.type = 'highshelf';
      trebleFilterRef.current.frequency.value = 6000;
      trebleFilterRef.current.gain.value = 0;

      // Dynamics compressor
      compressorRef.current = ctx.createDynamicsCompressor();
      compressorRef.current.threshold.value = 0;
      compressorRef.current.knee.value = 40;
      compressorRef.current.ratio.value = 1;
      compressorRef.current.attack.value = 0;
      compressorRef.current.release.value = 0.25;

      // Create gain node for volume boost
      gainNodeRef.current = ctx.createGain();
      gainNodeRef.current.gain.value = volumeBoost;

      // Connect chain: source -> bass -> mid -> treble -> compressor -> gain -> destination
      sourceNodeRef.current.connect(bassFilterRef.current);
      bassFilterRef.current.connect(midFilterRef.current);
      midFilterRef.current.connect(trebleFilterRef.current);
      trebleFilterRef.current.connect(compressorRef.current);
      compressorRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(ctx.destination);

      // Apply current enhancer mode
      applyAudioEnhancerPreset(audioEnhancerMode);

      // Try to resume immediately; if the context was created without a user
      // gesture it will stay 'suspended' and the video will appear muted until
      // the user interacts with the page. Attempt a resume right away and fall
      // back to one-shot gesture listeners below.
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      console.log('🔊 Volume booster + Audio Enhancer initialized');
    } catch (error) {
      console.error('❌ Failed to initialize volume booster:', error);
    }
  }, [volumeBoost, audioEnhancerMode]);

  // Audio Enhancer presets
  const applyAudioEnhancerPreset = useCallback((mode: 'off' | 'cinema' | 'music' | 'dialogue' | 'custom', customValues?: typeof customAudio) => {
    const bass = bassFilterRef.current;
    const mid = midFilterRef.current;
    const treble = trebleFilterRef.current;
    const comp = compressorRef.current;
    if (!bass || !mid || !treble || !comp) return;

    switch (mode) {
      case 'cinema':
        bass.gain.value = 8; bass.frequency.value = 150;
        mid.gain.value = 3; mid.frequency.value = 2500; mid.Q.value = 0.8;
        treble.gain.value = 4; treble.frequency.value = 8000;
        comp.threshold.value = -24; comp.knee.value = 30; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
        break;
      case 'music':
        bass.gain.value = 6; bass.frequency.value = 200;
        mid.gain.value = -1; mid.frequency.value = 1500; mid.Q.value = 1.2;
        treble.gain.value = 5; treble.frequency.value = 6000;
        comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.15;
        break;
      case 'dialogue':
        bass.gain.value = -2; bass.frequency.value = 200;
        mid.gain.value = 7; mid.frequency.value = 3000; mid.Q.value = 1.5;
        treble.gain.value = 3; treble.frequency.value = 5000;
        comp.threshold.value = -30; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.001; comp.release.value = 0.1;
        break;
      case 'custom': {
        const v = customValues || customAudio;
        bass.gain.value = v.bassGain; bass.frequency.value = v.bassFreq;
        mid.gain.value = v.midGain; mid.frequency.value = v.midFreq; mid.Q.value = v.midQ;
        treble.gain.value = v.trebleGain; treble.frequency.value = v.trebleFreq;
        comp.threshold.value = v.compThreshold; comp.knee.value = v.compKnee; comp.ratio.value = v.compRatio; comp.attack.value = v.compAttack; comp.release.value = v.compRelease;
        break;
      }
      case 'off':
      default:
        bass.gain.value = 0; mid.gain.value = 0; treble.gain.value = 0;
        comp.threshold.value = 0; comp.knee.value = 40; comp.ratio.value = 1; comp.attack.value = 0; comp.release.value = 0.25;
        break;
    }
    console.log(`🎧 Audio enhancer mode: ${mode}`);
  }, [customAudio]);

  async function ensureAudioEnhancerReady() {
    const shouldEnableAudioProcessing = audioEnhancerMode !== 'off' || volumeBoost > 1;
    if (!shouldEnableAudioProcessing) return;

    if (audioContextRef.current?.state === 'closed') {
      audioContextRef.current = null;
      sourceNodeRef.current = null;
      gainNodeRef.current = null;
      bassFilterRef.current = null;
      midFilterRef.current = null;
      trebleFilterRef.current = null;
      compressorRef.current = null;
    }

    if (
      !sourceNodeRef.current ||
      !gainNodeRef.current ||
      !bassFilterRef.current ||
      !midFilterRef.current ||
      !trebleFilterRef.current ||
      !compressorRef.current
    ) {
      initializeVolumeBooster();
    }

    if (audioContextRef.current?.state === 'suspended') {
      try {
        await audioContextRef.current.resume();
      } catch (error) {
        console.error('Failed to resume audio context:', error);
      }
    }

    if (gainNodeRef.current?.gain) {
      gainNodeRef.current.gain.value = volumeBoost;
    }

    applyAudioEnhancerPreset(audioEnhancerMode);
  }

  // Handle audio enhancer mode change
  const handleAudioEnhancerChange = useCallback((mode: 'off' | 'cinema' | 'music' | 'dialogue' | 'custom') => {
    setAudioEnhancerMode(mode);
    localStorage.setItem('playerAudioEnhancer', mode);

    if (bassFilterRef.current) {
      applyAudioEnhancerPreset(mode);
    } else {
      initializeVolumeBooster();
    }
  }, [applyAudioEnhancerPreset, initializeVolumeBooster]);

  // Handle custom audio parameter change
  const handleCustomAudioChange = useCallback((key: string, value: number) => {
    setCustomAudio((prev: typeof customAudio) => {
      const updated = { ...prev, [key]: value };
      localStorage.setItem('playerCustomAudio', JSON.stringify(updated));
      // Apply in real-time if custom mode is active
      if (audioEnhancerMode === 'custom') {
        applyAudioEnhancerPreset('custom', updated);
      }
      return updated;
    });
  }, [audioEnhancerMode, applyAudioEnhancerPreset]);

  // Handle video OLED mode change
  const handleVideoOledChange = useCallback((mode: 'off' | 'natural' | 'cinema' | 'vivid' | 'custom') => {
    setVideoOledMode(mode);
    localStorage.setItem('playerVideoOled', mode);
  }, []);

  // Handle custom OLED parameter change
  const handleCustomOledChange = useCallback((key: string, value: number) => {
    setCustomOled((prev: typeof customOled) => {
      const updated = { ...prev, [key]: value };
      localStorage.setItem('playerCustomOled', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Get CSS filter for OLED mode
  const getVideoOledFilter = useCallback(() => {
    switch (videoOledMode) {
      case 'natural':
        return 'contrast(1.08) saturate(1.15) brightness(1.02)';
      case 'cinema':
        return 'contrast(1.15) saturate(1.1) brightness(0.97) sepia(0.08)';
      case 'vivid':
        return 'contrast(1.22) saturate(1.35) brightness(1.03)';
      case 'custom':
        return `contrast(${customOled.contrast}) saturate(${customOled.saturate}) brightness(${customOled.brightness}) sepia(${customOled.sepia})`;
      case 'off':
      default:
        return 'none';
    }
  }, [videoOledMode, customOled]);

  // Handle volume boost change
  const handleVolumeBoostChange = useCallback((newBoost: number) => {
    const clampedBoost = Math.max(1, Math.min(3, newBoost)); // 100% to 300%
    setVolumeBoost(clampedBoost);
    localStorage.setItem('playerVolumeBoost', clampedBoost.toString());

    if (gainNodeRef.current && gainNodeRef.current.gain) {
      gainNodeRef.current.gain.value = clampedBoost;
    } else {
      // Initialize if not already done
      initializeVolumeBooster();
      if (gainNodeRef.current && gainNodeRef.current.gain) {
        gainNodeRef.current.gain.value = clampedBoost;
      }
    }
  }, [initializeVolumeBooster]);

  // Reset volume boost
  const resetVolumeBoost = useCallback(() => {
    handleVolumeBoostChange(1);
  }, [handleVolumeBoostChange]);

  // Effect to update gain node when volumeBoost changes
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volumeBoost;
    }
  }, [volumeBoost]);

  useEffect(() => {
    void ensureAudioEnhancerReady();
  }, [src, audioEnhancerMode, volumeBoost, customAudio]);

  // Ensure the Web Audio graph resumes on the first real user gesture after
  // mount. Without this, a suspended AudioContext (created before any gesture)
  // routes video audio into silence — users had to wiggle the volume booster
  // slider to trigger a resume.
  useEffect(() => {
    const resume = () => {
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };

    const video = videoRef.current;
    const videoEvents: Array<keyof HTMLMediaElementEventMap> = ['playing', 'canplay', 'volumechange'];
    videoEvents.forEach(e => video?.addEventListener(e, resume));

    const gestureEvents: Array<keyof DocumentEventMap> = ['pointerdown', 'touchstart', 'keydown'];
    gestureEvents.forEach(e =>
      document.addEventListener(e, resume, { capture: true, passive: true } as AddEventListenerOptions)
    );

    return () => {
      videoEvents.forEach(e => video?.removeEventListener(e, resume));
      gestureEvents.forEach(e =>
        document.removeEventListener(e, resume, { capture: true } as EventListenerOptions)
      );
    };
  }, [src]);

  // Cleanup audio context on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
      }
    };
  }, []);

  const skipTime = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime += seconds;

      if (seconds > 0) {
        // Gérer les clics multiples pour forward
        setForwardClickCount(prev => prev + 1);

        // Si pas d'animation en cours, la démarrer
        if (!showForwardAnimation) {
          setShowForwardAnimation(true);
        }

        // Clear le timeout précédent et en créer un nouveau
        if (forwardTimeoutRef.current) {
          clearTimeout(forwardTimeoutRef.current);
        }

        forwardTimeoutRef.current = setTimeout(() => {
          setForwardClickCount(0);
          setShowForwardAnimation(false);
          forwardTimeoutRef.current = null;
        }, 1500);
      } else {
        // Gérer les clics multiples pour rewind
        setRewindClickCount(prev => prev + 1);

        // Si pas d'animation en cours, la démarrer
        if (!showRewindAnimation) {
          setShowRewindAnimation(true);
        }

        // Clear le timeout précédent et en créer un nouveau
        if (rewindTimeoutRef.current) {
          clearTimeout(rewindTimeoutRef.current);
        }

        rewindTimeoutRef.current = setTimeout(() => {
          setRewindClickCount(0);
          setShowRewindAnimation(false);
          rewindTimeoutRef.current = null;
        }, 1500);
      }
    }
  };

  const toggleFullscreen = async () => {
    const playerElement = containerRef.current;
    const videoElement = videoRef.current as HTMLVideoElementWithWebkit | null;

    if (!playerElement || !videoElement) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };

    const isFullscreenNow = Boolean(
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      videoElement.webkitDisplayingFullscreen === true,
    );

    if (!isFullscreenNow) {
      const tryRequestFullscreen = async (element: HTMLElement | HTMLVideoElementWithWebkit) => {
        const extendedElement = element as typeof element & {
          webkitRequestFullscreen?: () => Promise<void> | void;
          mozRequestFullScreen?: () => Promise<void> | void;
          msRequestFullscreen?: () => Promise<void> | void;
        };

        const requestFullscreenFn =
          element.requestFullscreen ||
          extendedElement.webkitRequestFullscreen ||
          extendedElement.mozRequestFullScreen ||
          extendedElement.msRequestFullscreen;

        if (typeof requestFullscreenFn !== 'function') return false;

        try {
          await Promise.resolve(requestFullscreenFn.call(element));
          return true;
        } catch (err) {
          const error = err as Error;
          console.error(`Error attempting to enable full-screen mode: ${error.message} (${error.name})`);
          return false;
        }
      };

      let hasEnteredFullscreen = false;

      for (const target of [playerElement, videoElement]) {
        if (!target) continue;

        if (await tryRequestFullscreen(target)) {
          hasEnteredFullscreen = true;
          break;
        }
      }

      if (!hasEnteredFullscreen && typeof videoElement.webkitEnterFullscreen === 'function') {
        try {
          videoElement.webkitEnterFullscreen();
          hasEnteredFullscreen = true;
        } catch (err) {
          const error = err as Error;
          console.error(`Error attempting to enable iOS full-screen mode: ${error.message} (${error.name})`);
        }
      }

      if (!hasEnteredFullscreen) {
        console.warn('Fullscreen API not available on this device.');
      }
    } else {
      if (typeof doc.exitFullscreen === 'function') {
        try {
          await doc.exitFullscreen();
        } catch (err) {
          const error = err as Error;
          console.error(`Error attempting to exit full-screen mode: ${error.message} (${error.name})`);
        }
      }

      if (typeof doc.webkitExitFullscreen === 'function') {
        try {
          await Promise.resolve(doc.webkitExitFullscreen());
        } catch (err) {
          const error = err as Error;
          console.error(`Error attempting to exit webkit full-screen mode: ${error.message} (${error.name})`);
        }
      }

      if (typeof videoElement.webkitExitFullscreen === 'function') {
        try {
          videoElement.webkitExitFullscreen();
        } catch (err) {
          const error = err as Error;
          console.error(`Error attempting to exit iOS full-screen mode: ${error.message} (${error.name})`);
        }
      }
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const video = videoRef.current as HTMLVideoElementWithWebkit | null;
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(
        Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || (video && video.webkitDisplayingFullscreen)),
      );
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Add state for PiP error message display
  const [pipError, setPipError] = useState<string | null>(null);

  // Add reference for the PiP error timeout
  const pipErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null);




  const togglePip = async () => {
    // Clear any previous error and timeout
    setPipError(null);
    if (pipErrorTimeoutRef.current) {
      clearTimeout(pipErrorTimeoutRef.current);
      pipErrorTimeoutRef.current = null;
    }

    try {
      // Obtenir l'élément vidéo
      const video = videoRef.current;
      if (!video) {
        setPipError(t('watch.pipNotAvailable'));
        pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
        return;
      }

      // Détection de Firefox
      const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

      // Si déjà en PiP, sortir du mode PiP
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
        return;
      }

      // Vérifier si la vidéo est prête
      if (video.readyState === 0) {
        setPipError(t('watch.videoNotReady'));
        pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
        return;
      }

      // Pour Firefox : utiliser le bouton natif de Firefox si disponible
      if (isFirefox) {
        // Firefox gère son propre bouton PiP, on essaie quand même l'API standard
        try {
          // Certaines versions de Firefox supportent cette API
          if (typeof video.requestPictureInPicture === 'function') {
            await video.requestPictureInPicture();
            setIsPipActive(true);
          } else {
            // Sinon, on suggère d'utiliser le bouton natif de Firefox
            setPipError(t('watch.usePipFirefox'));
            pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
          }
        } catch (firefoxError) {
          console.warn('Firefox PiP error:', firefoxError);
          setPipError(t('watch.usePipFirefox'));
          pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
        }
        return;
      }

      // Pour les autres navigateurs
      if (!document.pictureInPictureEnabled) {
        setPipError(t('watch.pipNotSupported'));
        pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
        return;
      }

      // Si la vidéo est en pause, essayer de la lire (certains navigateurs l'exigent)
      if (video.paused) {
        try {
          await video.play();
        } catch (playError) {
          console.warn('Could not auto-play video for PiP:', playError);
          // Continue anyway - some browsers allow PiP without playing
        }
      }

      // Request PiP mode pour navigateurs standards
      await video.requestPictureInPicture();
      setIsPipActive(true);
    } catch (error) {
      console.error('Error toggling picture-in-picture:', error);

      // Show fallback message or UI indication that PiP failed
      let errorMsg = t('watch.pipActivateError');

      if (error instanceof DOMException) {
        if (error.name === 'NotAllowedError') {
          errorMsg = t('watch.pipBlocked');
        } else if (error.name === 'NotSupportedError') {
          errorMsg = t('watch.pipVideoNotSupported');
        }
      }

      setPipError(errorMsg);
      pipErrorTimeoutRef.current = setTimeout(() => setPipError(null), 3000);
    }
  };

  // Chromecast functions
  const initializeCast = useCallback(async () => {
    const success = await initializeCastApi();
    setCastAvailable(success);
    if (success) {
      setCastSdkReady(true);
    }
  }, []);

  const toggleCast = () => {
    if (isCasting) {
      // Disconnect from cast
      if (nativeCastBridge) {
        nativeCastBridge.stop().catch((err: unknown) => {
          console.warn('Native cast stop failed:', err);
        });
        // isCasting will flip to false when CAST_SESSION_ENDED fires
        return;
      }
      if (castSession) {
        castSession.stop();
        setCastSession(null);
        setIsCasting(false);
      }
    } else {
      // Start casting immediately without showing menu
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = undefined;
      }
      setShowCastMenu(false);
      // Fire and forget; internal loading states are handled within startCasting
      startCasting();
    }
  };

  // Function to ensure video element is properly configured for AirPlay
  /**
   * Toggle AirPlay connection
   * 
   * IMPORTANT: AirPlay requires Safari's native HLS playback.
   * When AirPlay is activated, we must:
   * 1. Destroy HLS.js instance (MSE is incompatible with AirPlay)
   * 2. Use Safari's native HLS support
   * 3. Show the AirPlay device picker
   */
  const toggleAirPlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isAirPlaying) {
      // Disconnect from AirPlay
      try {
        console.log('[AirPlay] Disconnecting...');
        // Reconnect with HLS.js for normal playback
        loadSource();
      } catch (error) {
        console.error('[AirPlay] Error disconnecting:', error);
      }
    } else {
      // Hide cast menu and show controls
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = undefined;
      }
      setShowCastMenu(false);

      // Start AirPlay
      startAirPlay();
    }
  };

  /**
   * Start AirPlay session
   * This will switch from HLS.js to native playback and show the device picker
   * (Safari path), or fall back to the W3C Remote Playback API picker for
   * browsers without WebKit AirPlay or chrome.cast (Firefox / shielded Brave).
   */
  const startAirPlay = async () => {
    setIsAirPlayLoading(true);
    try {
      const video = videoRef.current;
      if (!video) throw new Error('No video element');

      const useWebKitPath = isAirPlaySupported();
      const useRemoteFallback = !useWebKitPath && isRemotePlaybackSupported(video);

      if (!useWebKitPath && !useRemoteFallback) {
        throw new Error('AirPlay/Remote Playback not supported on this device/browser');
      }

      console.log('[AirPlay] Starting session via', useWebKitPath ? 'WebKit' : 'Remote Playback API');

      if (useWebKitPath) {
        const currentTime = video.currentTime;
        const wasPlaying = !video.paused;

        // Step 1: Show the system picker FIRST, synchronously inside the user
        // gesture. webkitShowPlaybackTargetPicker silently no-ops without
        // transient activation — awaiting the source swap (manifest fetch)
        // before showing it burns the gesture on slow networks. The user takes
        // at least a second to pick a device, which gives the swap below time
        // to finish in parallel.
        await requestAirPlay(video);
        console.log('[AirPlay] Device picker shown successfully');

        // Step 2: Destroy HLS.js instance if it exists
        // AirPlay is incompatible with MSE (Media Source Extensions)
        if (hlsRef.current) {
          console.log('[AirPlay] Destroying HLS.js instance for native playback...');
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        // Step 3: Switch to native Safari playback
        // Safari has built-in HLS support that works with AirPlay
        const airPlayUrl = src;

        console.log('[AirPlay] Switching to native playback with URL:', airPlayUrl);

        // Configure video element for AirPlay
        video.setAttribute('x-webkit-airplay', 'allow');
        const videoWithAirPlay = video as HTMLVideoElementWithWebkit;
        if (typeof videoWithAirPlay.webkitWirelessVideoPlaybackDisabled !== 'undefined') {
          videoWithAirPlay.webkitWirelessVideoPlaybackDisabled = false;
        }
        if ('disableRemotePlayback' in video) {
          (video as any).disableRemotePlayback = false;
        }

        // Set the source directly (Safari will handle HLS natively)
        video.src = airPlayUrl;

        // Wait for video to be ready. Reject on media error and after 15s so
        // a stream the native pipeline can't load (CORS, headers, dead host)
        // doesn't leave the player stuck on the connecting spinner forever.
        await new Promise<void>((resolve, reject) => {
          const cleanupListeners = () => {
            window.clearTimeout(timeoutId);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('error', onError);
          };
          const onLoadedMetadata = () => {
            cleanupListeners();
            resolve();
          };
          const onError = () => {
            cleanupListeners();
            const mediaError = video.error;
            reject(new Error(`AirPlay: native stream failed to load${mediaError ? ` (code ${mediaError.code})` : ''}`));
          };
          const timeoutId = window.setTimeout(() => {
            cleanupListeners();
            reject(new Error('AirPlay: timed out loading native stream'));
          }, 15000);
          video.addEventListener('loadedmetadata', onLoadedMetadata);
          video.addEventListener('error', onError);
          video.load();
        });

        // Restore position only once metadata is ready — seeking before
        // loadedmetadata gets discarded by Safari and playback restarts at 0.
        video.currentTime = currentTime;

        // Resume playback if it was playing
        if (wasPlaying) {
          await video.play();
        }
      } else {
        // Remote Playback API fallback — DON'T destroy HLS.js. The picker is
        // shown via `video.remote.prompt()` and the receiver gets whatever
        // src is currently on the element (works for MP4 / native HLS, fails
        // gracefully for HLS.js blob URLs — same caveat as Safari without
        // native HLS).
        if ('disableRemotePlayback' in video) {
          (video as any).disableRemotePlayback = false;
        }

        // Show the Remote Playback picker — must run inside the user gesture.
        await requestAirPlay(video);
        console.log('[AirPlay] Device picker shown successfully');
      }

    } catch (error) {
      console.error('[AirPlay] Error starting AirPlay:', error);
      setAirPlayError(error instanceof Error ? error.message : t('watch.airplayError'));
      // Keep menu open so the user actually sees the error message.
      setShowCastMenu(true);

      // If AirPlay failed, try to restore HLS.js playback
      try {
        await loadSource();
      } catch (restoreError) {
        console.error('[AirPlay] Failed to restore HLS.js playback:', restoreError);
      }
    } finally {
      setIsAirPlayLoading(false);
    }
  };

  const loadCurrentMediaOnCastSession = useCallback(async (session: any) => {
    const mySrc = src;
    // Dedupe concurrent loads of the same src (startCasting + SESSION_STARTED
    // both call this for a fresh session).
    if (castLoadInFlightRef.current === mySrc) {
      console.log('[Cast] Load already in flight for this src, skipping duplicate');
      return;
    }
    castLoadInFlightRef.current = mySrc;
    try {
      setIsCastLoading(true);
      setCastError(null);
      setShowCastMenu(false);
      setCastSession(session);

      // Parse M3U8 manifest to get streams and subtitles
      let streams: any[] = [];
      if (src.includes('.m3u8')) {
        streams = await parseM3u8Manifest(src);
      }

      // Select best stream (French priority)
      const bestStream = streams.length > 0 ? selectBestStream(streams) : null;
      const streamUrl = bestStream?.url || src;
      // If provider encodes audio track in variant (-a1/-a2), prefer French audio
      const preferredStreamUrl = await preferFrenchAudioVariant(streamUrl, src);
      if (preferredStreamUrl !== streamUrl) {
        console.log('Cast chosen stream URL (prefer FR):', { original: streamUrl, preferred: preferredStreamUrl });
      }

      // Build subtitle tracks for the cast — only the externally-supplied
      // VOSTFR track today. Internal HLS subtitle tracks are already inside
      // the manifest, the receiver handles those natively. Activate them on
      // the receiver only if the user had subtitles visible locally.
      const subtitlesForCast = subtitleUrl
        ? [{ url: subtitleUrl, language: 'fr', label: 'Français' }]
        : [];
      const enableSubsOnCast = subtitlesForCast.length > 0 && currentSubtitle !== 'off';

      // Load media on cast device — try multiple HLS content-types in case
      // the receiver rejects our first MIME choice (some Chromecasts only
      // accept lowercase "application/x-mpegurl", others want the RFC 8216
      // "application/vnd.apple.mpegurl"). Cinepulse does the same.
      await loadMediaOnCastWithFallback(
        session,
        preferredStreamUrl,
        title || tvShow?.name || 'Media',
        poster,
        videoRef.current?.currentTime || 0,
        isPlaying,
        subtitlesForCast,
        enableSubsOnCast,
        // VOD content (movies / episodes) is seekable — BUFFERED is correct here
        // (LIVE is only used by LiveTVPlayer for live channels).
        'BUFFERED',
      );

      setIsCasting(true);
      lastLoadedCastSrcRef.current = src;

      console.log('Successfully started casting with language selection');

    } catch (error) {
      // A newer load for a different src cancelled this one on the receiver
      // (LOAD_INTERRUPTED / error 904). Expected during episode/server
      // switches — not a user-facing failure.
      if (castLoadInFlightRef.current !== mySrc) {
        console.log('[Cast] Load superseded by a newer source, ignoring error');
        return;
      }
      console.error('Error starting cast:', error);
      setCastError(error instanceof Error ? error.message : t('watch.castError'));
      // Keep menu open so the user actually sees the error message.
      setShowCastMenu(true);
    } finally {
      // Only the owning load clears the in-flight marker / spinner — a
      // superseded load must not wipe the state of the one that replaced it.
      if (castLoadInFlightRef.current === mySrc) {
        castLoadInFlightRef.current = null;
        setIsCastLoading(false);
      }
    }
  }, [isPlaying, poster, src, t, title, tvShow?.name, subtitleUrl, currentSubtitle]);

  const startCasting = async () => {
    // Native Android WebView path — route through the on-device Google Cast SDK.
    if (nativeCastBridge) {
      try {
        setIsCastLoading(true);
        setCastError(null);

        // Same FR-preference logic as the web path so the Chromecast gets the
        // French audio track when the provider exposes multiple audio variants.
        let streams: MediaStream[] = [];
        if (src.includes('.m3u8')) {
          streams = await parseM3u8Manifest(src);
        }
        const bestStream = streams.length > 0 ? selectBestStream(streams) : null;
        const streamUrl = bestStream?.url || src;
        const preferredStreamUrl = await preferFrenchAudioVariant(streamUrl, src);

        const finalUrl = preferredStreamUrl;

        const posterUrl = poster
          ? (poster.startsWith('http') ? poster : `https://image.tmdb.org/t/p/w500${poster}`)
          : null;

        await nativeCastBridge.loadMedia(
          finalUrl,
          title || tvShow?.name || 'Movix',
          posterUrl,
          videoRef.current?.currentTime || 0,
        );
        // Track what we loaded so the src-change effect doesn't reload on every render.
        lastLoadedCastSrcRef.current = src;
        // Session state (isCasting, loading done) is driven by
        // CAST_SESSION_STARTED / FAILED events dispatched by the native bridge.
      } catch (error) {
        console.error('Native cast failed:', error);
        setCastError(error instanceof Error ? error.message : t('watch.castError'));
        setShowCastMenu(true);
        setIsCastLoading(false);
      }
      return;
    }

    try {
      // Ask for the cast session immediately while we are still inside the user gesture.
      const session = castSession ?? await requestCastSession();
      await loadCurrentMediaOnCastSession(session);
    } catch (error) {
      console.error('Error starting cast session:', error);
      setCastError(error instanceof Error ? error.message : t('watch.castError'));
      // Keep menu open so the user actually sees the error message.
      setShowCastMenu(true);
      setIsCastLoading(false);
    }
  };






  const handleCastSessionUpdate = (session: any) => {
    setCastSession(session);
    setIsCasting(!!session);
  };

  const handleCastSessionEnd = () => {
    setCastSession(null);
    setIsCasting(false);
    setCastCurrentTime(0);
    setCastDuration(0);
    lastLoadedCastSrcRef.current = null;
  };

  // Function to update cast progress
  const updateCastProgress = useCallback(() => {
    if (!isCasting || !castSession || isCastDragging) return;

    try {
      const session: any = castSession;
      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
      if (!media) return;

      const current = media.getEstimatedTime ? media.getEstimatedTime() : (media.currentTime || 0);
      const duration = media.getDuration ? media.getDuration() : (media.duration || 0);

      setCastCurrentTime(current);
      setCastDuration(duration);
    } catch (e) {
      console.error('Error updating cast progress:', e);
    }
  }, [isCasting, castSession, isCastDragging]);

  // Update cast progress every second
  useEffect(() => {
    if (!isCasting) return;

    const interval = setInterval(updateCastProgress, 1000);
    return () => clearInterval(interval);
  }, [isCasting, updateCastProgress]);

  // Cast progress bar handlers
  const handleCastProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const currentDuration = castDuration || duration;
    if (!currentDuration || isCastDragging) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    const newTime = percentage * currentDuration;

    // Update state immediately for visual feedback
    setCastCurrentTime(newTime);

    // Update CSS variables for immediate visual update
    const fillPercentage = percentage * 100;
    const progressBar = e.currentTarget as HTMLDivElement;
    progressBar.style.setProperty('--slider-progress', `${fillPercentage}%`);
    progressBar.style.setProperty('--slider-fill', `${fillPercentage}%`);
    progressBar.style.setProperty('--slider-pointer', `${fillPercentage}%`);

    seekCastTo(newTime);
  }, [castDuration, duration, isCastDragging]);

  const handleCastProgressDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsCastDragging(true);
    e.preventDefault();

    // Calculate initial drag time
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const currentDuration = castDuration || duration;
    const newTime = percentage * currentDuration;
    setCastDragTime(newTime);

    // Add dragging attribute for visual feedback
    const element = document.querySelector('.cast-progress-bar');
    if (element) {
      element.setAttribute('data-dragging', 'true');
    }
  }, [castDuration, duration]);

  const handleCastProgressDragMove = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const currentDuration = castDuration || duration;
    if (!isCastDragging || !currentDuration) return;

    const progressBar = document.querySelector('.cast-progress-bar') as HTMLDivElement;
    if (!progressBar) return;

    const rect = progressBar.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, mouseX / rect.width));
    const newTime = percentage * currentDuration;

    setCastDragTime(newTime);

    // Update all CSS variables for smooth visual feedback
    const fillPercentage = percentage * 100;
    progressBar.style.setProperty('--slider-progress', `${fillPercentage}%`);
    progressBar.style.setProperty('--slider-fill', `${fillPercentage}%`);
    progressBar.style.setProperty('--slider-pointer', `${fillPercentage}%`);
  }, [isCastDragging, castDuration, duration]);

  const handleCastProgressDragEnd = useCallback(() => {
    const currentDuration = castDuration || duration;
    if (!isCastDragging || !currentDuration) return;

    setIsCastDragging(false);
    seekCastTo(castDragTime);
    setCastDragTime(0);

    // Remove dragging attribute
    const element = document.querySelector('.cast-progress-bar');
    if (element) {
      element.removeAttribute('data-dragging');
    }

    // Reset CSS variables to match the final state after a short delay
    setTimeout(() => {
      const progressBar = document.querySelector('.cast-progress-bar') as HTMLDivElement;
      if (progressBar && !isCastDragging) {
        const finalPercentage = (castCurrentTime / currentDuration) * 100;
        progressBar.style.setProperty('--slider-progress', `${finalPercentage}%`);
        progressBar.style.setProperty('--slider-fill', `${finalPercentage}%`);
        progressBar.style.setProperty('--slider-pointer', `${finalPercentage}%`);
      }
    }, 100);
  }, [isCastDragging, castDuration, duration, castDragTime, castCurrentTime]);

  const seekCastTo = useCallback((time: number) => {
    if (!castSession) return;

    try {
      const session: any = castSession;
      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
      if (!media) return;

      if ((window as any).chrome?.cast?.media) {
        const req = new (window as any).chrome.cast.media.SeekRequest();
        req.currentTime = time;
        media.seek(req, () => { }, () => { });
      } else if (typeof media.seek === 'function') {
        media.seek(time, () => { }, () => { });
      }
    } catch (e) {
      console.error('Cast seek failed:', e);
    }
  }, [castSession]);

  // Touch handlers for cast progress bar
  const handleCastProgressTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const currentDuration = castDuration || duration;
    const newTime = (percentage / 100) * currentDuration;

    setIsCastDragging(true);
    setCastDragTime(newTime);

    // Update CSS variables for immediate visual feedback
    const element = e.currentTarget as HTMLElement;
    element.style.setProperty('--slider-progress', `${percentage}%`);
    element.style.setProperty('--slider-fill', `${percentage}%`);
    element.style.setProperty('--slider-pointer', `${percentage}%`);
  }, [castDuration, duration]);

  const handleCastProgressTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isCastDragging) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const currentDuration = castDuration || duration;
    const newTime = (percentage / 100) * currentDuration;

    setCastDragTime(newTime);

    // Update CSS variables for immediate visual feedback
    const element = e.currentTarget as HTMLElement;
    element.style.setProperty('--slider-progress', `${percentage}%`);
    element.style.setProperty('--slider-fill', `${percentage}%`);
    element.style.setProperty('--slider-pointer', `${percentage}%`);
  }, [isCastDragging, castDuration, duration]);

  const handleCastProgressTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isCastDragging) return;

    const touch = e.changedTouches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const currentDuration = castDuration || duration;
    const newTime = (percentage / 100) * currentDuration;

    setIsCastDragging(false);
    setCastDragTime(0);
    seekCastTo(newTime);

    // Re-sync CSS variables with final state
    setTimeout(() => {
      const element = e.currentTarget as HTMLElement;
      const finalPercentage = currentDuration > 0 ? ((castCurrentTime || currentTime) / currentDuration) * 100 : 0;
      element.style.setProperty('--slider-progress', `${finalPercentage}%`);
      element.style.setProperty('--slider-fill', `${finalPercentage}%`);
      element.style.setProperty('--slider-pointer', `${finalPercentage}%`);
    }, 100);
  }, [isCastDragging, castDuration, duration, castCurrentTime, currentTime, seekCastTo]);

  // Add event listeners for cast progress bar dragging
  useEffect(() => {
    if (!isCastDragging) return;

    const handleMouseMove = (e: MouseEvent) => handleCastProgressDragMove(e);
    const handleMouseUp = () => handleCastProgressDragEnd();

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isCastDragging, castDuration, handleCastProgressDragMove, handleCastProgressDragEnd]);

  // Native listener binding for pointer & mouse movement to ensure controls wake up
  // across all platforms (including Firefox on Linux Wayland)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onUserPointerActivity = (e: Event) => {
      handleMouseMove(e);
    };

    const events = ['pointermove', 'mousemove', 'pointerenter', 'mouseenter'];

    events.forEach(eventName => {
      container.addEventListener(eventName, onUserPointerActivity, { passive: true });
    });

    const handleDocumentPointerMove = (e: Event) => {
      if (document.fullscreenElement || container.contains(e.target as Node)) {
        onUserPointerActivity(e);
      }
    };

    document.addEventListener('pointermove', handleDocumentPointerMove, { passive: true });
    document.addEventListener('mousemove', handleDocumentPointerMove, { passive: true });

    return () => {
      events.forEach(eventName => {
        container.removeEventListener(eventName, onUserPointerActivity);
      });
      document.removeEventListener('pointermove', handleDocumentPointerMove);
      document.removeEventListener('mousemove', handleDocumentPointerMove);
    };
  }, [handleMouseMove]);

  // Add event listener for PIP changes initiated outside our button
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleEnterPIP = () => setIsPipActive(true);
    const handleExitPIP = () => setIsPipActive(false);

    video.addEventListener('enterpictureinpicture', handleEnterPIP);
    video.addEventListener('leavepictureinpicture', handleExitPIP);

    return () => {
      video.removeEventListener('enterpictureinpicture', handleEnterPIP);
      video.removeEventListener('leavepictureinpicture', handleExitPIP);
    };
  }, []);

  // Fetch PiP backdrop image when movieId changes
  useEffect(() => {
    if (movieId) {
      fetchPiPBackdropImage(movieId);
    }
  }, [movieId]);

  // Cast SDK load timeout — if `__onGCastApiAvailable` hasn't fired after 5s,
  // gstatic.com is almost certainly blocked (adblocker, ISP filter, shielded
  // browser). Surface this as a distinct state so the UI can guide the user
  // instead of showing a generic "no devices found".
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ((window as any).chrome?.cast) return; // Already loaded — nothing to wait for.

    const timeoutId = window.setTimeout(() => {
      if (!(window as any).chrome?.cast) {
        console.warn('[Cast] SDK did not load within 5s — likely blocked by adblock/ISP');
        setCastSdkBlocked(true);
      }
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, []);

  // Initialize Chromecast
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if ((window as any).chrome?.cast?.isAvailable) {
      initializeCast();
      return;
    }

    const previousCallback = (window as any).__onGCastApiAvailable;
    (window as any).__onGCastApiAvailable = (isAvailable: boolean) => {
      if (typeof previousCallback === 'function') {
        previousCallback(isAvailable);
      }

      // SDK fired its callback — clear the "blocked" flag if it was set.
      setCastSdkBlocked(false);

      if (isAvailable) {
        void initializeCast();
      } else {
        setCastAvailable(false);
      }
    };

    return () => {
      (window as any).__onGCastApiAvailable = previousCallback;
    };
  }, [initializeCast]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const castFramework = (window as any).cast?.framework;
    const castContext = castFramework?.CastContext?.getInstance?.();
    const sessionStateEvent = castFramework?.CastContextEventType?.SESSION_STATE_CHANGED;

    if (!castContext || !sessionStateEvent) return;

    const handleSessionStateChanged = (event: any) => {
      const frameworkSession = castContext.getCurrentSession?.();
      const session = frameworkSession?.getSessionObj?.() ?? null;
      const sessionState = event?.sessionState;

      if (
        sessionState === castFramework?.SessionState?.SESSION_ENDED ||
        sessionState === 'SESSION_ENDED' ||
        !session
      ) {
        handleCastSessionEnd();
        return;
      }

      setCastSession(session);

      const isResumed =
        sessionState === castFramework?.SessionState?.SESSION_RESUMED ||
        sessionState === 'SESSION_RESUMED';

      // Resumed session (page reload / navigation while casting): the receiver
      // is usually already playing. Re-loading media here would restart the TV
      // from 0 — adopt the session as-is instead and let the src-change effect
      // push new media only when the user actually switches episode/server.
      if (isResumed && Array.isArray(session.media) && session.media.length > 0) {
        lastLoadedCastSrcRef.current = src;
        setIsCasting(true);
        return;
      }

      const shouldLoadMedia =
        sessionState === castFramework?.SessionState?.SESSION_STARTED ||
        sessionState === 'SESSION_STARTED' ||
        isResumed;

      if (shouldLoadMedia) {
        void loadCurrentMediaOnCastSession(session);
      }
    };

    castContext.addEventListener(sessionStateEvent, handleSessionStateChanged);

    // Track real device availability: the API may be loaded but no receivers
    // reachable. In that case google-cast-launcher hides itself visually but
    // the host <div> still reserves space and swallows clicks — so we drive
    // castAvailable from CAST_STATE instead of just "is the SDK loaded".
    const castStateEvent = castFramework?.CastContextEventType?.CAST_STATE_CHANGED;
    const noDevicesState = castFramework?.CastState?.NO_DEVICES_AVAILABLE ?? 'NO_DEVICES_AVAILABLE';

    const applyCastState = (state: any) => {
      setCastAvailable(state !== noDevicesState && state !== 'NO_DEVICES_AVAILABLE');
    };

    if (typeof castContext.getCastState === 'function') {
      applyCastState(castContext.getCastState());
    }

    const handleCastStateChanged = (event: any) => {
      applyCastState(event?.castState);
    };

    if (castStateEvent) {
      castContext.addEventListener(castStateEvent, handleCastStateChanged);
    }

    return () => {
      castContext.removeEventListener(sessionStateEvent, handleSessionStateChanged);
      if (castStateEvent) {
        castContext.removeEventListener(castStateEvent, handleCastStateChanged);
      }
    };
  }, [loadCurrentMediaOnCastSession, castSdkReady, src]);

  // Detect the Movix Android app WebView cast bridge.
  // When the React Native shell injects window.MovixAndroidCast, we route
  // casts through the on-device Google Cast SDK instead of the web SDK
  // (chrome.cast is not available inside Android WebView).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bridge = (window as any).MovixAndroidCast;
    if (!bridge || typeof bridge.isSupported !== 'function') return;

    let cancelled = false;
    bridge
      .isSupported()
      .then((supported: boolean) => {
        if (cancelled || !supported) return;
        setNativeCastBridge(bridge);
        setCastAvailable(true);
      })
      .catch(() => {
        /* no-op — Cast stays disabled on devices without Play Services */
      });

    const onSessionStarted = () => {
      setIsCasting(true);
      setIsCastLoading(false);
      setCastError(null);
      // NB: lastLoadedCastSrcRef is set when startCasting actually queues a
      // media load; don't overwrite it here because the src may have changed
      // between queueing and device selection.
    };
    const onSessionEnded = () => {
      setIsCasting(false);
      setIsCastLoading(false);
      lastLoadedCastSrcRef.current = null;
    };
    const onSessionFailed = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      setIsCasting(false);
      setIsCastLoading(false);
      setCastError(
        typeof detail.error === 'number'
          ? `${t('watch.castError')} (code ${detail.error})`
          : t('watch.castError'),
      );
      setShowCastMenu(true);
    };

    window.addEventListener('CAST_SESSION_STARTED', onSessionStarted);
    window.addEventListener('CAST_SESSION_RESUMED', onSessionStarted);
    window.addEventListener('CAST_SESSION_ENDED', onSessionEnded);
    window.addEventListener('CAST_SESSION_FAILED', onSessionFailed);

    return () => {
      cancelled = true;
      window.removeEventListener('CAST_SESSION_STARTED', onSessionStarted);
      window.removeEventListener('CAST_SESSION_RESUMED', onSessionStarted);
      window.removeEventListener('CAST_SESSION_ENDED', onSessionEnded);
      window.removeEventListener('CAST_SESSION_FAILED', onSessionFailed);
    };
  }, [src, t]);

  useEffect(() => {
    if (!castSession || !isCasting) return;
    if (lastLoadedCastSrcRef.current === src) return;

    void loadCurrentMediaOnCastSession(castSession);
  }, [castSession, isCasting, loadCurrentMediaOnCastSession, src]);

  // Native Android cast: when the source changes mid-cast (e.g. next episode),
  // push the new media to the existing cast session.
  useEffect(() => {
    if (!nativeCastBridge || !isCasting) return;
    if (lastLoadedCastSrcRef.current === src) return;
    void startCasting();
    // startCasting is recreated each render and deliberately excluded; the
    // guard above already prevents loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeCastBridge, isCasting, src]);

  useEffect(() => {
    const video = videoRef.current;
    // Either WebKit AirPlay (Safari) or W3C Remote Playback API (Firefox /
    // browsers without cast.framework). isRemotePlaybackSupported already
    // excludes Safari and Chrome-with-cast so the two checks don't overlap.
    if (!video || (!isAirPlaySupported() && !isRemotePlaybackSupported(video))) {
      setAirPlayAvailable(false);
      return;
    }

    const onStateChange = (state: { isAvailable: boolean; isConnected: boolean; isConnecting: boolean }) => {
      setAirPlayAvailable(state.isAvailable);
      setIsAirPlaying(state.isConnected);
    };

    const cleanup = initializeAirPlay(video, onStateChange);

    return () => {
      if (cleanup) {
        cleanup();
      }
    };
  }, [videoRef]);

  // Close cast menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showCastMenu) {
        const target = event.target as HTMLElement;
        const clickedInsideButton = !!castButtonRef.current?.contains(target);
        if (!target.closest('.cast-menu') && !clickedInsideButton) {
          setShowCastMenu(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCastMenu]);

  // ClipMenu gère lui-même sa fermeture via le composant modal

  // Handle cast session events
  useEffect(() => {
    if (castSession) {
      // Keep isCasting in sync and detect session end correctly
      const updateListener = (isAlive?: boolean) => {
        // When called without param, just refresh the session reference
        handleCastSessionUpdate(castSession);
        // If the SDK provides isAlive and it's false, the session ended
        if (typeof isAlive === 'boolean' && !isAlive) {
          handleCastSessionEnd();
        }
      };

      if (castSession.addUpdateListener) {
        castSession.addUpdateListener(updateListener);
      }

      // Do NOT use addMediaListener to end the session; it's for media changes.
      // If needed, we could hook into media status updates here without ending the session.

      return () => {
        if (castSession.removeUpdateListener) {
          castSession.removeUpdateListener(updateListener);
        }
      };
    }
  }, [castSession]);

  // Clear cast error after 5 seconds
  useEffect(() => {
    if (castError) {
      const timer = setTimeout(() => {
        setCastError(null);
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [castError]);

  // AirPlay menu is now handled by the unified cast menu

  // Clear AirPlay error after 5 seconds
  useEffect(() => {
    if (airPlayError) {
      const timer = setTimeout(() => {
        setAirPlayError(null);
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [airPlayError]);

  const formatTime = (time: number): string => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };


  const getBufferedWidth = () => {
    if (!buffered || buffered.length === 0) return 0;
    const currentBuffer = Array.from(Array(buffered.length).keys())
      .find(i => buffered.start(i) <= currentTime && currentTime <= buffered.end(i));
    if (currentBuffer === undefined) return 0;
    return (buffered.end(currentBuffer) / duration) * 100;
  };

  const handleAudioTrackChange = (trackId: number) => {
    if (hlsRef.current) {
      hlsRef.current.audioTrack = trackId;
      setCurrentAudioTrack(trackId);
      setShowSettings(false);
    }
  };

  const handlePlaybackSpeedChange = (speed: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
      setPlaybackSpeed(speed);
      localStorage.setItem('playerPlaybackSpeed', speed.toString());
      // setShowSettings(false); // REMOVED: Don't close settings automatically
    }
  };

  const getLanguageName = (code: string): React.ReactNode => {
    const languages: { [key: string]: { name: string, countryCode?: string } } = {
      'fr': { name: t('languages.fr'), countryCode: 'FR' },
      'en': { name: t('languages.en'), countryCode: 'GB' },
      'es': { name: t('languages.es'), countryCode: 'ES' },
      'de': { name: t('languages.de'), countryCode: 'DE' },
      'it': { name: t('languages.it'), countryCode: 'IT' },
      'ja': { name: t('languages.ja'), countryCode: 'JP' },
      'ko': { name: t('languages.ko'), countryCode: 'KR' },
      'zh': { name: t('languages.zh'), countryCode: 'CN' },
      'pt': { name: t('languages.pt'), countryCode: 'PT' },
      'ru': { name: t('languages.ru'), countryCode: 'RU' },
      'hi': { name: t('languages.hi'), countryCode: 'IN' },
      'ar': { name: t('languages.ar'), countryCode: 'SA' },
      'unknown': { name: t('common.unknown', 'Unknown') }
    };
    const lang = languages[code] || { name: code };
    return <><span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>{lang.countryCode ? <ReactCountryFlag countryCode={lang.countryCode as string} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /> : '🌐'}</span> {lang.name}</>;
  };

  const handleReplay = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
      setShowNextMovie(false);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    const progressBar = progressBarRef.current;
    if (!progressBar || !videoRef.current) return;

    const rect = progressBar.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clickPosition = (clientX - rect.left) / rect.width;
    const newTime = clickPosition * duration;

    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const getProgressKey = useCallback(() => {
    if (movieId) {
      return `progress_${movieId}`;
    }
    if (tvShowId && seasonNumber && episodeNumber) {
      return `progress_tv_${tvShowId}_s${seasonNumber}_e${episodeNumber}`;
    }
    return null;
  }, [movieId, tvShowId, seasonNumber, episodeNumber]);

  // State for saving progress preference
  const [saveProgressEnabled, setSaveProgressEnabled] = useState(() => {
    const savedPref = localStorage.getItem('playerSaveProgressPref');
    return savedPref !== null ? JSON.parse(savedPref) : true; // Default to true
  });

  // Effect to save the preference to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('playerSaveProgressPref', JSON.stringify(saveProgressEnabled));
  }, [saveProgressEnabled]);

  // States for next content threshold configuration
  const [nextContentThresholdMode, setNextContentThresholdMode] = useState<'percentage' | 'timeBeforeEnd'>(() => {
    const savedMode = localStorage.getItem('playerNextContentThresholdMode');
    if (savedMode) return savedMode as 'percentage' | 'timeBeforeEnd';

    // Initialize from prop if it's an object with mode
    if (typeof nextContentThreshold === 'object' && 'mode' in nextContentThreshold) {
      return nextContentThreshold.mode;
    }
    return 'percentage'; // Default
  });

  const [nextContentThresholdValue, setNextContentThresholdValue] = useState<number>(() => {
    const savedValue = localStorage.getItem('playerNextContentThresholdValue');
    if (savedValue) return parseFloat(savedValue);

    // Initialize from prop
    if (typeof nextContentThreshold === 'number') {
      return nextContentThreshold;
    } else if (typeof nextContentThreshold === 'object' && 'value' in nextContentThreshold) {
      return nextContentThreshold.value;
    }
    return 95; // Default
  });

  // Effect to save threshold preferences to localStorage
  useEffect(() => {
    localStorage.setItem('playerNextContentThresholdMode', nextContentThresholdMode);
    localStorage.setItem('playerNextContentThresholdValue', nextContentThresholdValue.toString());
  }, [nextContentThresholdMode, nextContentThresholdValue]);

  // Update saveProgress function
  const saveProgress = useCallback(() => {
    // Check if saving is enabled
    if (!saveProgressEnabled) {
      // console.log("[saveProgress] Aborted: Saving disabled by user preference.");
      return;
    }

    const video = videoRef.current;
    const key = getProgressKey();

    if (!video) return;

    // Ne pas sauvegarder si on est tout au début ou à la fin
    if (video.currentTime < 30 || video.currentTime > video.duration - 30) return;

    // Continue watching functionality removed

    if (!key) return;
    const progress: WatchProgress = {
      position: video.currentTime,
      timestamp: new Date().toISOString(),
      duration: video.duration
    };
    localStorage.setItem(key, JSON.stringify(progress));
  }, [getProgressKey, tvShowId, seasonNumber, episodeNumber, tvShow, saveProgressEnabled]);

  const loadProgress = useCallback(() => {
    const video = videoRef.current;
    const key = getProgressKey();
    console.log(`[loadProgress] Called. Key: ${key}, Video readyState: ${video?.readyState}`);

    if (!video || !key) {
      console.log("[loadProgress] Aborted: No video or key.");
      setHasLoadedProgress(true); // Ensure this is set even if aborting early
      return;
    }

    const setVideoTime = () => {
      console.log(`[loadProgress] setVideoTime called. Current video time: ${video.currentTime}, Duration: ${video.duration}`);
      // Check if duration is valid before seeking
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        // Use initialTime prop if provided and valid
        if (initialTime && initialTime > 0 && initialTime < video.duration - 30) {
          console.log(`[loadProgress] Seeking to initialTime prop: ${initialTime}`);
          video.currentTime = initialTime;
        } else {
          // Otherwise, use localStorage progress
          const savedProgress = localStorage.getItem(key);
          if (savedProgress) {
            try {
              const progress: WatchProgress = JSON.parse(savedProgress);
              if (progress.position < video.duration - 30) {
                console.log(`[loadProgress] Seeking to saved localStorage position: ${progress.position}`);
                video.currentTime = progress.position;
              } else {
                console.log(`[loadProgress] Not seeking: localStorage progress is too close to end.`);
              }
            } catch (error) {
              console.error('[loadProgress] Error parsing saved progress:', error);
            }
          } else {
            console.log(`[loadProgress] No localStorage progress found for key: ${key}`);
          }
        }
      } else {
        console.log(`[loadProgress] Not seeking: Duration invalid/zero (${video.duration || 'N/A'}).`);
      }
      // Ensure we don't add multiple listeners if readyState changes quickly
      video.removeEventListener('canplay', setVideoTime);
    };

    // Check if the video is already ready
    if (video.readyState >= 3) { // HAVE_FUTURE_DATA or higher (more robust than HAVE_METADATA)
      console.log("[loadProgress] Video already playable. Calling setVideoTime directly.");
      setVideoTime();
    } else {
      console.log("[loadProgress] Video not playable yet. Adding 'canplay' listener.");
      // Make sure listener isn't added multiple times
      video.removeEventListener('canplay', setVideoTime);
      video.addEventListener('canplay', setVideoTime, { once: true });
    }
    setHasLoadedProgress(true); // Mark progress load attempt as done
  }, [getProgressKey, initialTime]);
  // Initialiser la sauvegarde périodique
  useEffect(() => {
    console.log("[Effect saveProgress Interval] Setting up interval.");
    if (!progressSaveInterval.current) {
      progressSaveInterval.current = setInterval(() => {
        // console.log("[Effect saveProgress Interval] Interval fired."); // Keep this commented unless needed, can be noisy
        saveProgress();
      }, 10000); // Toutes les 10 secondes
    }

    return () => {
      console.log("[Effect saveProgress Interval] Cleaning up interval.");
      if (progressSaveInterval.current) {
        clearInterval(progressSaveInterval.current);
        progressSaveInterval.current = undefined; // Clear the ref
        console.log("[Effect saveProgress Interval] Final save before cleanup.");
        saveProgress(); // Sauvegarde finale avant de quitter
      }
    };
  }, [saveProgress]);

  // Charger la progression au montage
  useEffect(() => {
    console.log(`[Effect loadProgress] Running. hasLoadedProgress: ${hasLoadedProgress}`);
    if (!hasLoadedProgress) {
      loadProgress();
    }
    // Cleanup function is not needed here as loadProgress sets hasLoadedProgress
  }, [hasLoadedProgress, loadProgress]);

  // Sauvegarder avant de quitter la page
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveProgress();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [saveProgress]);

  // Écouter les événements de changement de source forcé
  useEffect(() => {
    const handleForceSourceChange = (event: CustomEvent) => {
      console.log('🔄 Force source change event received:', event.detail);
      handleHlsError();
    };

    window.addEventListener('forceSourceChange', handleForceSourceChange as EventListener);
    return () => {
      window.removeEventListener('forceSourceChange', handleForceSourceChange as EventListener);
    };
  }, []);

  // Helper function to determine if next content popup should be shown
  const shouldShowNextContent = (currentTime: number, duration: number): boolean => {
    if (!duration || duration === 0) return false;

    const progress = (currentTime / duration) * 100;
    const remaining = duration - currentTime;

    // Use internal states instead of prop
    if (nextContentThresholdMode === 'percentage') {
      return progress >= nextContentThresholdValue;
    }

    // Handle timeBeforeEnd mode
    if (nextContentThresholdMode === 'timeBeforeEnd') {
      return remaining <= nextContentThresholdValue;
    }

    return false;
  };

  const handleTimeUpdate = (e: any) => {
    const player = e.target;
    const remaining = player.duration - player.currentTime;
    setTimeRemaining(remaining);

    // Sauvegarder la progression si on est au-delà de 30 secondes
    // et à plus de 30 secondes de la fin
    if (player.currentTime > 30 && remaining > 30) {
      saveProgress();
    }

    // Afficher le film suivant ou l'épisode suivant selon le seuil configuré
    if (shouldShowNextContent(player.currentTime, player.duration)) {
      if (nextMovie && !showNextMovieOverlay && !hasIgnored) {
        setShowNextMovieOverlay(true);
      } else if (nextEpisode && !showNextEpisodeOverlay && !hasDeclinedNextEpisode && autoNextEpisodeEnabled) {
        setShowNextEpisodeOverlay(true);
      }
    }
  };

  const handleVideoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore click if a touch gesture is active or just ended
    if (touchActiveRef.current || ignoreNextClickRef.current) {
      return;
    }

    // Vérifier si le clic n'est pas sur les contrôles ou le menu des paramètres
    const target = e.target as HTMLElement;
    if (
      target.closest('.control-bar') ||
      target.closest('.settings-menu') ||
      target.closest('.volume-slider') ||
      target.closest('.progress-bar') ||
      showSettings ||
      showVolumeSlider
    ) {
      return;
    }

    // Empêcher la fermeture des contrôles si des animations +10/-10 sont en cours (y compris overlays touch)
    const isSkipAnimationActive = showForwardAnimation || showRewindAnimation || showLeftTapAnimation || showRightTapAnimation;

    if (showControls && !isSkipAnimationActive) {
      // Si les contrôles sont déjà affichés et pas d'animation en cours, on les cache
      setShowControls(false);
      // On nettoie aussi le timeout existant si présent
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = undefined;
      }
    } else if (!showControls) {
      // Si les contrôles sont cachés, on les affiche
      setShowControls(true);
      // On définit un timeout pour les cacher après un délai
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      if (isPlaying && !isSkipAnimationActive) {
        // Détecter l'orientation mobile paysage et plein écran
        const isLandscape = window.innerHeight < window.innerWidth;
        const isMobileLandscape = isMobile && isLandscape;
        const isFullscreenMode = document.fullscreenElement !== null;
        const isMobileLandscapeFullscreen = isMobileLandscape && isFullscreenMode;

        // En mode paysage mobile plein écran, timeout plus court
        let timeout = 5000;
        if (isMobileLandscapeFullscreen) {
          timeout = 2000; // Très court en plein écran paysage
        } else if (isMobileLandscape) {
          timeout = 3000; // Court en paysage normal
        }

        controlsTimeoutRef.current = setTimeout(() => {
          // Vérifier à nouveau si des animations sont en cours avant de cacher
          if (!showForwardAnimation && !showRewindAnimation) {
            setShowControls(false);
            setShowVolumeSlider(false);
          }
        }, timeout);
      }
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Tenter la lecture automatique seulement si autoPlay est true
    if (autoPlay) {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => setIsPlaying(true))
          .catch(() => {
            // Si l'autoplay échoue, on ne fait rien et on attend l'interaction utilisateur
            setIsPlaying(false);
          });
      }
    }
  }, [autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignorer si l'utilisateur est en train de taper dans un champ texte
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const keyboardTarget = e.target instanceof HTMLElement ? e.target : document.activeElement;
      if (isSourceMenuTarget(keyboardTarget)) {
        return;
      }

      // En mode verrouillé, seule la sortie explicite (Échap) est gérée
      // ailleurs; on ignore tous les autres raccourcis.
      if (isLocked) {
        return;
      }

      const key = e.key;

      // Ctrl+J — Infos du flux vidéo (style VLC)
      if (e.ctrlKey && key.toLowerCase() === 'j') {
        e.preventDefault();
        setShowStreamInfo(prev => !prev);
        return;
      }

      // ? — Aide raccourcis clavier (fonctionne sur AZERTY et QWERTY)
      if (key === '?') {
        e.preventDefault();
        setShowShortcutsHelp(prev => !prev);
        return;
      }

      // Ignorer les raccourcis simples si Ctrl/Alt/Meta sont enfoncés (sauf exceptions ci-dessus)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // === Raccourcis basés sur e.key (caractère réel — compatible AZERTY/QWERTY) ===
      switch (key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          return;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          return;
        case 'm':
          e.preventDefault();
          handleMuteToggle();
          return;
        case 'j':
          e.preventDefault();
          skipTime(-10);
          return;
        case 'l':
          e.preventDefault();
          skipTime(10);
          return;
        case 'p':
          e.preventDefault();
          togglePip();
          return;
        case 'c': {
          e.preventDefault();
          // Construire la liste des sous-titres disponibles avec leur label
          const subEntries: { id: string; label: string }[] = [];
          if (video) {
            Array.from(video.textTracks).forEach((track, idx) => {
              const id = `internal:${idx}`;
              const label = track.label || track.language || `Piste ${idx + 1}`;
              subEntries.push({ id, label });
            });
          }
          if (rivestreamCaptions && rivestreamCaptions.length > 0) {
            rivestreamCaptions.forEach((cap, idx) => {
              subEntries.push({ id: `rivestream:${idx}`, label: cap.label || `Rivestream ${idx + 1}` });
            });
          }
          if (subEntries.length === 0) {
            showOsd('Aucun sous-titre disponible');
            return;
          }

          let nextId: string;
          let nextLabel: string;
          if (currentSubtitle === 'off') {
            nextId = subEntries[0].id;
            nextLabel = subEntries[0].label;
          } else {
            const currentIdx = subEntries.findIndex(e => e.id === currentSubtitle);
            if (currentIdx === -1 || currentIdx === subEntries.length - 1) {
              nextId = 'off';
              nextLabel = 'Désactivés';
            } else {
              nextId = subEntries[currentIdx + 1].id;
              nextLabel = subEntries[currentIdx + 1].label;
            }
          }
          handleSubtitleChange(nextId);
          showOsd(`Sous-titres : ${nextLabel}`);
          return;
        }
        case 'r':
          e.preventDefault();
          toggleLoop();
          return;
      }

      // === Raccourcis basés sur e.key pour les symboles ===
      switch (key) {
        case '>': // Shift+> = Accélérer
          e.preventDefault();
          {
            const fasterSpeed = Math.min(3, playbackSpeed + 0.25);
            video.playbackRate = fasterSpeed;
            setPlaybackSpeed(fasterSpeed);
            localStorage.setItem('playerPlaybackSpeed', fasterSpeed.toString());
          }
          return;
        case '<': // Shift+< = Ralentir
          e.preventDefault();
          {
            const slowerSpeed = Math.max(0.25, playbackSpeed - 0.25);
            video.playbackRate = slowerSpeed;
            setPlaybackSpeed(slowerSpeed);
            localStorage.setItem('playerPlaybackSpeed', slowerSpeed.toString());
          }
          return;
        case '+': // Accélérer
          e.preventDefault();
          {
            const fasterSpeed = Math.min(3, playbackSpeed + 0.25);
            video.playbackRate = fasterSpeed;
            setPlaybackSpeed(fasterSpeed);
            localStorage.setItem('playerPlaybackSpeed', fasterSpeed.toString());
          }
          return;
        case '-': // Ralentir
          e.preventDefault();
          {
            const slowerSpeed = Math.max(0.25, playbackSpeed - 0.25);
            video.playbackRate = slowerSpeed;
            setPlaybackSpeed(slowerSpeed);
            localStorage.setItem('playerPlaybackSpeed', slowerSpeed.toString());
          }
          return;
        case '.': // Image suivante (en pause)
          if (video.paused) {
            e.preventDefault();
            video.currentTime = Math.min(video.duration, video.currentTime + (1 / 30));
          }
          return;
        case ',': // Image précédente (en pause)
          if (video.paused) {
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - (1 / 30));
          }
          return;
        case '0': // Vitesse normale
          e.preventDefault();
          video.playbackRate = 1;
          setPlaybackSpeed(1);
          localStorage.setItem('playerPlaybackSpeed', '1');
          return;
        case '1': case '2': case '3':
        case '4': case '5': case '6':
        case '7': case '8': case '9':
          e.preventDefault();
          if (video.duration) {
            const percent = parseInt(key) / 10;
            video.currentTime = video.duration * percent;
          }
          return;
      }

      // === Raccourcis basés sur e.code (touches physiques sans caractère) ===
      switch (e.code) {
        case 'ArrowLeft':
          e.preventDefault();
          skipTime(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skipTime(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const newVolumeUp = clampVolume(video.volume + 0.05);
            video.volume = newVolumeUp;
            setVolume(newVolumeUp);
            localStorage.setItem('playerVolume', newVolumeUp.toString());
            setShowVolumeSlider(true);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const newVolumeDown = clampVolume(video.volume - 0.05);
            video.volume = newVolumeDown;
            setVolume(newVolumeDown);
            localStorage.setItem('playerVolume', newVolumeDown.toString());
            setShowVolumeSlider(true);
          }
          break;
        case 'Home':
          e.preventDefault();
          if (video.duration) video.currentTime = 0;
          break;
        case 'End':
          e.preventDefault();
          if (video.duration) video.currentTime = video.duration;
          break;
        case 'Escape':
          if (showStreamInfo) {
            e.preventDefault();
            setShowStreamInfo(false);
          }
          if (showShortcutsHelp) {
            e.preventDefault();
            setShowShortcutsHelp(false);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyPress);

    return () => {
      document.removeEventListener('keydown', handleKeyPress);
    };
  }, [playbackSpeed, showStreamInfo, showShortcutsHelp, currentSubtitle, subtitles, showOsd, isSourceMenuTarget, isLocked]);

  useEffect(() => {
    const fetchNextMovieDetails = async () => {
      if (nextMovie) {
        try {
          const response = await axios.get(
            `https://api.themoviedb.org/3/movie/${nextMovie.id}`,
            {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage()
              }
            }
          );
          setNextMovieInfo({
            title: response.data.title,
            overview: response.data.overview,
            releaseDate: response.data.release_date,
            rating: response.data.vote_average,
            runtime: response.data.runtime
          });
        } catch (error) {
          console.error('Erreur lors de la récupération des détails du film suivant:', error);
        }
      }
    };

    fetchNextMovieDetails();
  }, [nextMovie]);

  const handleIgnore = () => {
    setHasDeclinedNextEpisode(true);
    setShowNextEpisodeOverlay(false);
    if (onIgnore) {
      onIgnore();
    }
  };

  useEffect(() => {
    setHasDeclinedNextEpisode(false);
  }, [src]);

  useEffect(() => {
    // Détection des appareils tactiles
    const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    setIsTouchDevice(touch);
    if (touch && containerRef.current) {
      containerRef.current.classList.add('touch-device');
    }
  }, []);

  // Gestionnaire global pour empêcher les clics synthétiques après TOUS les touchend
  useEffect(() => {
    const handleGlobalTouchEnd = () => {
      // Empêcher les clics synthétiques après n'importe quel touchend
      preventSyntheticClick();
    };

    // Ajouter l'écouteur global sur le document
    document.addEventListener('touchend', handleGlobalTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchend', handleGlobalTouchEnd);
    };
  }, [preventSyntheticClick]);

  const tryNextDarkiSource = useCallback(async () => {
    // Utiliser darkinoSources au lieu de darkiSources
    if (currentDarkiIndex < darkinoSources.length - 1) {
      setLoadingError(false);
      const nextIndex = currentDarkiIndex + 1;
      setCurrentDarkiIndex(nextIndex);
      setSelectedSource(`darki-${nextIndex}`);
      const nextSource = darkinoSources[nextIndex];

      console.log(`Trying Nightflix source ${nextIndex + 1}/${darkinoSources.length}:`, nextSource);

      try {
        // Directement utiliser l'URL m3u8 de la source Darkino
        const m3u8Url = nextSource.m3u8;

        if (m3u8Url && typeof m3u8Url === 'string') {
          console.log('Switching to Nightflix source:', m3u8Url);

          // Dispatch event to change source
          const sourceChangeEvent = new CustomEvent('sourceChange', {
            detail: {
              type: 'darkino',
              id: `darkino_${nextIndex}`,
              url: m3u8Url,
              origin: 'auto-fallback',
              fromSrc: src
            }
          });
          window.dispatchEvent(sourceChangeEvent);

          setM3u8Url(m3u8Url);
          return true;
        }
      } catch (error) {
        console.error('Erreur lors du changement vers la source Nightflix:', error);
        // Essayer la source suivante récursivement
        return await tryNextDarkiSource();
      }
    }

    console.log('Toutes les sources Nightflix ont été épuisées');
    setLoadingError(true);
    return false;
  }, [currentDarkiIndex, darkinoSources, src]);

  const loadSource = async () => {
    if (!videoRef.current) return;

    // Lazy-load HLS.js if we haven't yet — needed for non-MP4 sources
    const Hls = await loadHls();
    if (!videoRef.current) return;

    // Save current position before switching source
    const savedPosition = videoRef.current.currentTime > 0 ? videoRef.current.currentTime : initialTime || 0;
    const wasPlaying = !videoRef.current.paused;

    // Check if source is MP4
    const isMP4 = isMP4Source(src);

    if (isMP4) {
      // For MP4, directly set the source on the video element
      videoRef.current.src = src;
      setLoadingError(false);

      // Add onloadedmetadata handler to restore position
      const handleLoaded = () => {
        if (videoRef.current) { // Null check
          if (savedPosition > 0) {
            console.log(`MP4: Restoring position to ${savedPosition}s`);
            videoRef.current.currentTime = savedPosition;

            if (wasPlaying && autoPlay) {
              safePlay(videoRef.current).catch(e => console.error('Error playing MP4 after position restore:', e));
            }
          } else if (autoPlay) {
            safePlay(videoRef.current).catch(e => console.error('Error playing MP4:', e));
          }
          videoRef.current.removeEventListener('loadedmetadata', handleLoaded);
        }
      };

      videoRef.current.addEventListener('loadedmetadata', handleLoaded);

    } else if (!src) { // Removed hlsRef.current check for now, will be handled by hls.on below
      return;
    } else {
      // Ensure HLS instance exists or create new one if needed
      if (!hlsRef.current) {
        if (Hls.isSupported()) {
          // Utiliser la configuration HLS optimisée selon le domaine
          const hlsConfig = createHlsConfig(normalizeUqloadEmbedUrl(src));
          hlsRef.current = new Hls(hlsConfig);
        } else {
          console.error("HLS not supported, and trying to play non-MP4 source.");
          setLoadingError(true);
          // Don't call onError immediately, let the parent handle fallback to other sources
          if (onError) {
            console.log("HLS not supported, calling onError to try other source types");
            onError();
          }
          return;
        }
      }

      // Now hlsRef.current should exist if HLS is supported
      const hls = hlsRef.current;
      if (!hls) { // Should not happen if HLS is supported
        setLoadingError(true);
        // Don't call onError immediately, let the parent handle fallback to other sources
        if (onError) {
          console.log("HLS instance not available, calling onError to try other source types");
          onError();
        }
        return;
      }

      try {
        // Le proxy sera automatiquement appliqué par xhrSetup si nécessaire
        const normalizedSrc = normalizeUqloadEmbedUrl(src);
        console.log(`📡 [HLSPlayer] Loading HLS source: ${normalizedSrc.substring(0, 100)}...`);
        hls.loadSource(normalizedSrc);
        hls.attachMedia(videoRef.current); // videoRef.current is already checked at the beginning
        setLoadingError(false);

        // Add event listener for when HLS manifest is parsed and ready
        const handleManifestParsed = () => {
          if (videoRef.current) { // Null check
            if (savedPosition > 0) {
              console.log(`HLS: Restoring position to ${savedPosition}s after manifest parsed`);

              const checkAndSeek = () => {
                if (videoRef.current && videoRef.current.readyState >= 3) {
                  videoRef.current.currentTime = savedPosition;

                  if (wasPlaying && autoPlay) {
                    safePlay(videoRef.current).catch(e => console.error('Error playing HLS after position restore:', e));
                  }
                } else {
                  // Try again in a short moment
                  setTimeout(checkAndSeek, 100);
                }
              };

              checkAndSeek();
            } else if (autoPlay) {
              safePlay(videoRef.current).catch(e => console.error('Error playing HLS:', e));
            }
          }

          hls.off(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
        };

        hls.on(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
      } catch (error) {
        console.error('Error loading initial M3U8 with direct src:', error);
        setLoadingError(true);
        // Don't call onError immediately, let internal error handling try other sources first
        // onError will be called by tryNextSource when all darkino sources are exhausted
      }
    }
  };


  // Fonction pour essayer la prochaine source Nexus HLS
  const tryNextNexusHlsSource = useCallback(async () => {
    if (nexusHlsSources && currentNexusHlsIndex < nexusHlsSources.length - 1) {
      const nextIndex = currentNexusHlsIndex + 1;
      setCurrentNexusHlsIndex(nextIndex);
      const nextSource = nexusHlsSources[nextIndex];

      console.log(`Trying Nexus HLS source ${nextIndex + 1}/${nexusHlsSources.length}:`, nextSource);

      const sourceChangeEvent = new CustomEvent('sourceChange', {
        detail: {
          type: 'nexus_hls',
          id: `nexus_hls_${nextIndex}`,
          url: nextSource.url,
          origin: 'auto-fallback',
          fromSrc: src
        }
      });
      window.dispatchEvent(sourceChangeEvent);
      return true;
    }
    return false;
  }, [nexusHlsSources, currentNexusHlsIndex, src]);

  // Fonction pour essayer la prochaine source Nexus File
  const tryNextNexusFileSource = useCallback(async () => {
    if (nexusFileSources && currentNexusFileIndex < nexusFileSources.length - 1) {
      const nextIndex = currentNexusFileIndex + 1;
      setCurrentNexusFileIndex(nextIndex);
      const nextSource = nexusFileSources[nextIndex];

      console.log(`Trying Nexus File source ${nextIndex + 1}/${nexusFileSources.length}:`, nextSource);

      const sourceChangeEvent = new CustomEvent('sourceChange', {
        detail: {
          type: 'nexus_file',
          id: `nexus_file_${nextIndex}`,
          url: nextSource.url,
          origin: 'auto-fallback',
          fromSrc: src
        }
      });
      window.dispatchEvent(sourceChangeEvent);
      return true;
    }
    return false;
  }, [nexusFileSources, currentNexusFileIndex, src]);

  // Fonction pour essayer la prochaine source Bravo (PurStream)
  const tryNextBravoSource = useCallback(async () => {
    if (purstreamSources && currentBravoIndex < purstreamSources.length - 1) {
      const nextIndex = currentBravoIndex + 1;
      setCurrentBravoIndex(nextIndex);
      const nextSource = purstreamSources[nextIndex];

      console.log(`Trying Bravo source ${nextIndex + 1}/${purstreamSources.length}:`, nextSource);

      const sourceChangeEvent = new CustomEvent('sourceChange', {
        detail: {
          type: 'bravo',
          id: `bravo_${nextIndex}`,
          url: nextSource.url,
          origin: 'auto-fallback',
          fromSrc: src
        }
      });
      window.dispatchEvent(sourceChangeEvent);
      return true;
    }
    return false;
  }, [purstreamSources, currentBravoIndex, src]);

  const handleHlsError = async () => {
    console.log('🔄 Source loading failed or timeout occurred. Current src:', src?.substring(0, 100));
    let savedPosition = 0;
    if (videoRef.current) {
      savedPosition = videoRef.current.currentTime;
      setCurrentTime(savedPosition);
      console.log(`💾 Saved position: ${savedPosition}s`);
    }

    let switched = false;

    // 0. Si c'est une source Rivestream (avec proxy), essayer de basculer vers un autre proxy
    const currentSrc = src || '';
    const currentProxyIndex = RIVESTREAM_PROXIES.findIndex(proxy => currentSrc.includes(proxy));

    if (currentProxyIndex !== -1) {
       // Check if we should stop purely on 403 (although this function shouldn't be called on 403, better safe)
       // This check is hard to do here without access to the response status.
       // The caller (onError / hls error handler) is responsible for filtering 403.
       // However, to prevent infinite loops, we can add a retry limit per URL.
       
       // Using global or persistent state to track retries for this specific URL pattern
       const urlKey = "retry_" + currentSrc.split('?')[1]?.substring(0, 50); // Use part of query param as key
       if (urlKey) {
           const retries = (window as any)[urlKey] || 0;
           if (retries > 10) { // Safety break
               console.error("🚨 Infinite loop detected in Rivestream proxy rotation. Stopping.");
               if (onError) onError(); else setLoadingError(true);
               return;
           }
           (window as any)[urlKey] = retries + 1;
       }

      console.log('🚨 Rivestream Proxy error detected, attempting to switch proxy...');
      const nextProxyIndex = (currentProxyIndex + 1) % RIVESTREAM_PROXIES.length;

      // Si on a fait le tour des proxies, on abandonne la rotation de proxy et on passe à la suite (source suivante)
      // On utilise window.rivestreamRetryCount pour tracker les retries si besoin, ou juste on vérifie si on revient au premier
      // Pour l'instant, faisons simple : si on est sur le dernier proxy, on considère que ça a échoué globalement pour cette source
      // MAIS les utilisateurs veulent réessayer, donc on tourne. 
      // Sauf si on veut éviter une boucle infinie. On peut stocker le retry count dans une ref ou state.
      // Modif requested: "fait une liste en haut du fichier avec les deux urls en backup" -> implied rotation.

      const nextProxy = RIVESTREAM_PROXIES[nextProxyIndex];
      const currentProxy = RIVESTREAM_PROXIES[currentProxyIndex];

      console.log(`🔄 Switching Rivestream proxy from ${currentProxy} to ${nextProxy}`);
      const newUrl = currentSrc.replace(currentProxy, nextProxy);

      const sourceChangeEvent = new CustomEvent('sourceChange', {
        detail: { type: 'rivestream_hls', url: newUrl, id: 'rivestream_retry', origin: 'auto-fallback', fromSrc: currentSrc }
      });
      window.dispatchEvent(sourceChangeEvent);
      switched = true;
      // Return early to prevent other switching logic if we successfully rotated proxy
      return;
    }


    // 1. Essayer la prochaine source Nightflix (Darkino) si disponible
    if (!switched && darkinoSources && darkinoSources.length > 0 && currentDarkiIndex < darkinoSources.length - 1) {
      console.log(`🔥 Switching to next Nightflix source: ${currentDarkiIndex + 2} of ${darkinoSources.length}`);
      switched = await tryNextDarkiSource();
    }

    // 2. Si les sources Nightflix sont épuisées, essayer les sources Nexus HLS
    if (!switched && nexusHlsSources && nexusHlsSources.length > 0) {
      const isCurrentNexusHls = nexusHlsSources.some(s => s.url === currentSrc);
      if (currentNexusHlsIndex < nexusHlsSources.length - 1) {
        console.log(`🚀 Switching to next Nexus HLS source: ${currentNexusHlsIndex + 2} of ${nexusHlsSources.length}`);
        switched = await tryNextNexusHlsSource();
      } else if (!isCurrentNexusHls && currentNexusHlsIndex === 0 && currentDarkiIndex >= (darkinoSources?.length || 0)) {
        // Si on n'a pas encore essayé la première source Nexus HLS et que Nightflix est épuisé
        console.log('🚀 Switching to first Nexus HLS source');
        const sourceChangeEvent = new CustomEvent('sourceChange', {
          detail: {
            type: 'nexus_hls',
            id: 'nexus_hls_0',
            url: nexusHlsSources[0].url,
            origin: 'auto-fallback',
            fromSrc: currentSrc
          }
        });
        window.dispatchEvent(sourceChangeEvent);
        setCurrentNexusHlsIndex(0);
        switched = true;
      }
    }

    // 3. Si les sources Nexus HLS sont épuisées, essayer les sources Nexus File
    if (!switched && nexusFileSources && nexusFileSources.length > 0) {
      const isCurrentNexusFile = nexusFileSources.some(s => s.url === currentSrc);
      if (currentNexusFileIndex < nexusFileSources.length - 1) {
        console.log(`🚀 Switching to next Nexus File source: ${currentNexusFileIndex + 2} of ${nexusFileSources.length}`);
        switched = await tryNextNexusFileSource();
      } else if (!isCurrentNexusFile && currentNexusFileIndex === 0 && currentNexusHlsIndex >= (nexusHlsSources?.length || 0)) {
        // Si on n'a pas encore essayé la première source Nexus File et que Nexus HLS est épuisé
        console.log('🚀 Switching to first Nexus File source');
        const sourceChangeEvent = new CustomEvent('sourceChange', {
          detail: {
            type: 'nexus_file',
            id: 'nexus_file_0',
            url: nexusFileSources[0].url,
            origin: 'auto-fallback',
            fromSrc: currentSrc
          }
        });
        window.dispatchEvent(sourceChangeEvent);
        setCurrentNexusFileIndex(0);
        switched = true;
      }
    }

    // 3.5. Si les sources Nexus File sont épuisées, essayer les sources Bravo (PurStream)
    if (!switched && purstreamSources && purstreamSources.length > 0) {
      const isCurrentBravo = purstreamSources.some(s => s.url === currentSrc);
      if (currentBravoIndex < purstreamSources.length - 1) {
        console.log(`🦁 Switching to next Bravo source: ${currentBravoIndex + 2} of ${purstreamSources.length}`);
        switched = await tryNextBravoSource();
      } else if (!isCurrentBravo && currentBravoIndex === 0 && currentNexusFileIndex >= (nexusFileSources?.length || 0)) {
        // Si on n'a pas encore essayé la première source Bravo et que les sources précédentes sont épuisées
        console.log('🦁 Switching to first Bravo source');
        const sourceChangeEvent = new CustomEvent('sourceChange', {
          detail: {
            type: 'bravo',
            id: 'bravo_0',
            url: purstreamSources[0].url,
            origin: 'auto-fallback',
            fromSrc: currentSrc
          }
        });
        window.dispatchEvent(sourceChangeEvent);
        setCurrentBravoIndex(0);
        switched = true;
      }
    }

    // 4. Si aucune source HLS n'a fonctionné, essayer les sources embed
    if (!switched && omegaSources && omegaSources.length > 0) {
      console.log('🎬 Switching to Omega embed sources');
      const omegaEvent = new CustomEvent('sourceChange', {
        detail: {
          type: 'omega',
          id: 'omega_0',
          url: omegaSources[0].link,
          origin: 'auto-fallback',
          fromSrc: currentSrc
        }
      });
      window.dispatchEvent(omegaEvent);
      switched = true;
    }

    if (!switched && coflixSources && coflixSources.length > 0) {
      console.log('🎬 Switching to Multi embed sources');
      const coflixEvent = new CustomEvent('sourceChange', {
        detail: {
          type: 'coflix',
          id: 'coflix_0',
          url: getCoflixPreferredUrl(coflixSources[0]),
          origin: 'auto-fallback',
          fromSrc: currentSrc
        }
      });
      window.dispatchEvent(coflixEvent);
      switched = true;
    }

    // 5. Si aucun changement automatique n'a fonctionné
    if (!switched) {
      console.log("❌ No automatic source switching available");
      if (onError) {
        console.log("📞 Calling parent onError");
        onError();
      } else {
        setLoadingError(true);
      }
    } else {
      console.log("✅ Successfully switched to alternative source");
      // Restaurer la position sauvegardée après un délai
      setTimeout(() => {
        if (videoRef.current && savedPosition > 0) {
          videoRef.current.currentTime = savedPosition;
          console.log(`⏰ Restored position: ${savedPosition}s`);
        }
      }, 1000);
    }
  };

  // Trigger loadSource when src changes
  useEffect(() => {
    if (src) {
      loadSource();
    }
  }, [src]);

  // Remove any legacy referrer meta injected by older player builds
  useEffect(() => {
    const removeLegacyReferrerMeta = () => {
      const meta = document.getElementById('temp-referrer-meta');
      if (meta) {
        document.head.removeChild(meta);
      }
    };

    removeLegacyReferrerMeta();

    return () => {
      removeLegacyReferrerMeta();
    };
  }, []);

  // Monitor for network errors only (timeout is handled in the main useEffect)
  useEffect(() => {
    if (src && src.trim() !== '') {
      // Monitor for network errors
      const handleError = async (event: Event) => {
        const target = event.target as HTMLVideoElement;
        if (target.error) {
          console.log(`Video error detected: ${target.error.code} - ${target.error.message}`);
          
          // Vérification explicite de l'erreur 403 via un fetch
          if (target.error.code === 4) {
            try {
              console.log(`🕵️ verifying error 403 for url: ${src}`);
              const response = await fetch(src, { method: 'HEAD' });
              if (response.status === 403 || response.status === 4033) {
                 console.warn('🚫 403/4033 Forbidden error confirmed via fetch - trying next HLS player...');
                 setIsLoading(false);
                 handleHlsError();
                 return;
              }
            } catch (err) {
               console.warn('Could not verify error via fetch', err);
            }
          }

          if (target.error.code === 4 || target.error.message.includes('ERR_NAME_NOT_RESOLVED')) {
            console.log('Network error detected, attempting source switch');
            if (isDnsLikeError(null, target.error)) {
              let host: string | undefined;
              try { host = new URL(src).hostname; } catch { /* ignore */ }
              const switched = dispatchDnsEmbedFallback(src, omegaSources, coflixSources);
              notifyDnsBlocked({ host, details: `videoErrorCode${target.error.code}`, switched });
              if (switched) return;
            }
            handleHlsError();
          }
        }
      };

      const videoElement = videoRef.current;
      if (videoElement) {
        videoElement.addEventListener('error', handleError);
      }

      return () => {
        if (videoElement) {
          videoElement.removeEventListener('error', handleError);
        }
      };
    }
  }, [src]); // Only depend on src, not internal darkino logic

  // Setup HLS error handlers
  useEffect(() => {
    if (!Hls) return;
    const hls = hlsRef.current;
    if (hls) {
      const onHlsError = (_event: any, data: any) => {
        // Gestion de l'erreur 403 : auto-switch vers le prochain lecteur HLS disponible
        if (data.response && (data.response.code === 403 || data.response.code === 4033)) {
          console.warn('🚫 403/4033 Forbidden error detected - trying next HLS player...');
          if (sourceTimeoutRef.current) {
            clearTimeout(sourceTimeoutRef.current);
            sourceTimeoutRef.current = null;
          }
          hls.destroy();
          setIsLoading(false);
          handleHlsError();
          return;
        }

        // A broken/unsupported subtitle must never kill video playback — drop
        // the subtitle track and continue instead of switching source.
        if (isSubtitleLoadError(data)) {
          console.warn('💬 Subtitle load/parse error — dropping subtitle, keeping playback:', data.details);
          try {
            if (hls.subtitleTrack >= 0) hls.subtitleTrack = -1;
            (hls as any).subtitleDisplay = false;
          } catch { /* ignore */ }
          return;
        }

        // Vérifier si c'est une erreur 429 (Too Many Requests)
        const is429Error = data.response && data.response.code === 429;
        const isPulseTopstrime = src.includes('pulse.topstrime.online');

        if (is429Error && isPulseTopstrime) {
          handle429Error(hls, videoRef, data, src);
          return;
        }

        // Handle Buffer Append Errors specificially
        if (data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR) {
          console.warn('⚠️ HLS bufferAppendError detected, attempting to recover media error...');
          try {
            hls.recoverMediaError();
          } catch (e) {
            console.error('Failed to recover from bufferAppendError:', e);
            // If recovery fails, let it fall through to fatal handling or switch source
            if (data.fatal) {
              handleHlsError();
            }
          }
          return;
        }

        if (data.fatal || data.details === 'manifestLoadError' || data.details === 'levelLoadError') {
          console.error('Fatal HLS error:', data.type, data.details, data);

          // Check if it's a network error
          if (data.details === 'manifestLoadError' ||
            data.details === 'levelLoadError' ||
            (data.response && data.response.code === 404) ||
            (data.response && data.response.code === 0)) {
            console.log('Network error detected in HLS, attempting source switch');
            handleHlsError();
          } else if (data.fatal) {
            console.log('Fatal HLS error, attempting source switch');
            handleHlsError();
          }
        }
      };

      hls.on(Hls.Events.ERROR, onHlsError);

      return () => {
        hls.off(Hls.Events.ERROR, onHlsError);
      };
    }
  }, [src, Hls]); // Only depend on src, let parent handle source switching

  // Add event handler to restore position after source change
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleSourceLoaded = () => {
      // When a new source loads, check if we need to restore position
      if (initialTime && initialTime > 0) {
        console.log(`Setting initial time on source change: ${initialTime}`);
        video.currentTime = initialTime;
      }
    };

    video.addEventListener('loadedmetadata', handleSourceLoaded);

    return () => {
      video.removeEventListener('loadedmetadata', handleSourceLoaded);
    };
  }, [initialTime, src]); // Depend on src instead of currentDarkiIndex



  const handleProgressHover = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    const progressBar = progressBarRef.current;
    if (!progressBar || !duration || !containerRef.current) return;

    const progressBarRect = progressBar.getBoundingClientRect();
    const playerRect = containerRef.current.getBoundingClientRect();

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const progressPosition = (clientX - progressBarRect.left) / progressBarRect.width;
    const time = progressPosition * duration;

    const xRelativeToPlayer = clientX - playerRect.left;

    // Check if source is MP4 - if so, don't show preview
    const isMP4 = isMP4Source(src);
    if (isMP4) {
      // For MP4 sources, just show time position without preview
      setHoverState(prev => ({ ...prev, time, x: xRelativeToPlayer, showPreview: false, previewUrl: null }));
      return;
    }

    // Update hover position and time immediately
    setHoverState(prev => ({ ...prev, time, x: xRelativeToPlayer, showPreview: false, previewUrl: null }));

    // Clear previous timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    if (previewHlsRef.current) {
      previewHlsRef.current.destroy();
      previewHlsRef.current = null;
    }

    // Set new timeout to fetch and show preview
    hoverTimeoutRef.current = setTimeout(() => {
      setLoadingPreview(true);
      fetchPreviewFor(time);
    }, 150);
  };

  const fetchPreviewFor = (time: number) => {
    // Check if source is MP4 - if so, don't show preview
    const isMP4 = isMP4Source(src);
    if (isMP4) {
      console.log("Preview not available for MP4 sources");
      return;
    }

    if (!hlsRef.current) return;
    const hls = hlsRef.current;
    const levelDetails = hls.levels[hls.currentLevel]?.details;

    if (!levelDetails || levelDetails.fragments.length === 0) {
      console.log("HLS level details not available for preview.");
      return;
    }

    // Find the fragment for the given time
    const fragment = levelDetails.fragments.find(frag => {
      return time >= frag.start && time < frag.start + frag.duration;
    });

    if (!fragment) {
      console.log(`No fragment found for time: ${time}`);
      return;
    }

    // Ensure the fragment URL is absolute
    const fragmentUrl = new URL(fragment.url, levelDetails.url).href;

    setHoverState(prev => ({ ...prev, previewUrl: fragmentUrl, showPreview: true }));
  };

  const handleProgressLeave = () => {
    if (!isDragging) {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      setHoverState({ time: null, x: 0, showPreview: false, previewUrl: null });
      setLoadingPreview(false);
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
    }
  };
  // Ajout d'un ref pour stocker la dernière position de drag
  const lastDragClientXRef = useRef<number | null>(null);

  const handleProgressDragStart = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    setIsDragging(true);
    // Stocker la position initiale
    let clientX: number;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
    } else {
      clientX = e.clientX;
    }
    lastDragClientXRef.current = clientX;
    handleProgressHover(e); // Update position immediately
  };

  const handleProgressDragMove = (clientX: number) => {
    lastDragClientXRef.current = clientX;
    if (progressBarRef.current && duration && containerRef.current) {
      const progressBarRect = progressBarRef.current.getBoundingClientRect();
      const playerRect = containerRef.current.getBoundingClientRect();
      let progressPosition = (clientX - progressBarRect.left) / progressBarRect.width;
      progressPosition = Math.max(0, Math.min(1, progressPosition)); // Clamp between 0 and 1
      const time = progressPosition * duration;
      const xRelativeToPlayer = clientX - playerRect.left;

      // Check if source is MP4 - if so, don't show preview
      const isMP4 = isMP4Source(src);
      if (isMP4) {
        // For MP4 sources, just show time position without preview
        setHoverState(prev => ({ ...prev, time, x: xRelativeToPlayer, showPreview: false }));
        setCurrentTime(time);
        return;
      }

      setHoverState(prev => ({ ...prev, time, x: xRelativeToPlayer, showPreview: true })); // Toujours showPreview: true
      setCurrentTime(time);
      // --- Ajout pour le preview pendant le drag ---
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
      hoverTimeoutRef.current = setTimeout(() => {
        setLoadingPreview(true);
        fetchPreviewFor(time);
      }, 150);
    }
  };

  const handleProgressDragEnd = () => {
    setIsDragging(false);
    // Utiliser la dernière position connue du curseur/touch pour le seek
    if (videoRef.current && lastDragClientXRef.current !== null && progressBarRef.current && duration && containerRef.current) {
      const progressBarRect = progressBarRef.current.getBoundingClientRect();
      let progressPosition = (lastDragClientXRef.current - progressBarRect.left) / progressBarRect.width;
      progressPosition = Math.max(0, Math.min(1, progressPosition)); // Clamp between 0 and 1
      const seekTime = progressPosition * duration;
      videoRef.current.currentTime = seekTime;
      setCurrentTime(seekTime);
      setHoverState(prev => ({ ...prev, time: seekTime }));
    }
    // On garde le preview visible un court instant après le drag
    setTimeout(() => {
      setHoverState({ time: null, x: 0, showPreview: false, previewUrl: null });
      setLoadingPreview(false);
    }, 300);
  };

  // Gestion des événements globaux pour le glissement
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      handleProgressDragMove(e.clientX);
    };

    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      if (e.touches.length > 0) {
        e.preventDefault(); // Prevent page scroll
        handleProgressDragMove(e.touches[0].clientX);
      }
    };

    const handleGlobalMouseUp = () => {
      if (isDragging) {
        handleProgressDragEnd();
      }
    };

    const handleGlobalTouchEnd = () => {
      if (isDragging) {
        handleProgressDragEnd();
      }
      // Note: preventSyntheticClick() est maintenant géré par le gestionnaire global
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
      document.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
      document.addEventListener('touchend', handleGlobalTouchEnd);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      document.removeEventListener('touchmove', handleGlobalTouchMove);
      document.removeEventListener('touchend', handleGlobalTouchEnd);
    };
  }, [isDragging, duration]);

  useEffect(() => {
    if (hoverState.time !== null && containerRef.current) {
      const playerWidth = containerRef.current.clientWidth;
      const edgePadding = 8;

      // When dragging, the tooltip is small. We center it on the cursor.
      // When not dragging, it's the larger video preview.
      const tooltipWidth = 192; // Always use the width of the preview (192px)
      const halfTooltipWidth = tooltipWidth / 2;

      let leftPosition = hoverState.x - halfTooltipWidth;

      // Adjust for left edge
      if (leftPosition < edgePadding) {
        leftPosition = edgePadding;
      }

      // Adjust for right edge
      if (leftPosition + tooltipWidth > playerWidth - edgePadding) {
        leftPosition = playerWidth - tooltipWidth - edgePadding;
      }

      setPreviewStyle({
        left: `${leftPosition}px`,
      });
    }
  }, [isDragging, hoverState.x, hoverState.time]);

  useEffect(() => {
    if (!Hls) return;
    if (hoverState.showPreview && hoverState.previewUrl && previewVideoRef.current) {
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          maxBufferLength: 5,
          maxMaxBufferLength: 10,
        });
        previewHlsRef.current = hls;

        const manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:5.000,\n${hoverState.previewUrl}\n#EXT-X-ENDLIST`;
        const manifestBlob = new Blob([manifest], { type: 'application/vnd.apple.mpegurl' });
        const manifestUrl = URL.createObjectURL(manifestBlob);

        hls.loadSource(manifestUrl);
        hls.attachMedia(previewVideoRef.current);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          safePlay(previewVideoRef.current).catch(e => console.error("Preview autoplay failed", e));
        });

        return () => {
          URL.revokeObjectURL(manifestUrl);
        };
      }
    } else if (!hoverState.showPreview && previewHlsRef.current) {
      previewHlsRef.current.destroy();
      previewHlsRef.current = null;
    }
  }, [hoverState.showPreview, hoverState.previewUrl, Hls]);

  // Add this effect to update subtitles when HLS adds tracks
  useEffect(() => {
    if (!Hls) return;
    const video = videoRef.current;
    if (!video || !hlsRef.current) return;

    const handleTracksAdded = () => {
      console.log("Subtitle tracks updated by HLS");
      const tracks = Array.from(video.textTracks);
      console.log(`Found ${tracks.length} text tracks:`,
        tracks.map(t => `${t.label} (${t.language})`).join(', '));

      setSubtitles(tracks);

      // Initially disable all tracks
      tracks.forEach(track => {
        track.mode = 'disabled';
      });
    };

    // Set up the handler for when HLS.js adds subtitle tracks
    hlsRef.current.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, handleTracksAdded);

    // Check for tracks that might already be there
    if (video.textTracks && video.textTracks.length > 0) {
      handleTracksAdded();
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.off(Hls.Events.SUBTITLE_TRACKS_UPDATED, handleTracksAdded);
      }
    };
  }, [Hls]);

  // Add this effect to handle external subtitle URL
  useEffect(() => {
    if (!videoRef.current || !subtitleUrl) return;

    // Remove existing subtitles first
    Array.from(videoRef.current.textTracks).forEach(track => {
      if (track.mode !== 'disabled') {
        track.mode = 'disabled';
      }
    });

    // Create a new text track for the external subtitle
    const track = videoRef.current.addTextTrack('subtitles', 'External', 'fr');

    // Fetch and parse the subtitle file
    fetch(subtitleUrl)
      .then(response => response.text())
      .then(text => {
        try {
          // Simple VTT parser (this is simplified, you may need a proper parser)
          const cues = text.split('\n\n').slice(1).map(block => {
            const lines = block.split('\n');
            const timeRegex = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
            const timeMatch = lines[0].match(timeRegex);

            if (timeMatch) {
              const startTime =
                parseInt(timeMatch[1]) * 3600 +
                parseInt(timeMatch[2]) * 60 +
                parseInt(timeMatch[3]) +
                parseInt(timeMatch[4]) / 1000;

              const endTime =
                parseInt(timeMatch[5]) * 3600 +
                parseInt(timeMatch[6]) * 60 +
                parseInt(timeMatch[7]) +
                parseInt(timeMatch[8]) / 1000;

              const text = lines.slice(1).join('\n');
              const cue = new VTTCue(startTime, endTime, text);
              return cue;
            }
            return null;
          }).filter(Boolean);

          // Add cues to track
          cues.forEach(cue => {
            if (cue) track.addCue(cue);
          });

          // Make track active
          track.mode = 'hidden';
          setCurrentSubtitle('fr');
        } catch (error) {
          console.error('Error parsing subtitles:', error);
        }
      })
      .catch(error => {
        console.error('Error fetching subtitles:', error);
      });
  }, [subtitleUrl]);

  // This effect handles tracking active cues for manual subtitle rendering with delay
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleCueChange = (event: Event) => {
      const track = event.target as TextTrack;
      if (track && (track.mode === 'showing' || track.mode === 'hidden')) {
        refreshActiveCues(video, track, subtitleStyle.delay);
      }
    };

    // Add cuechange listener to all text tracks
    Array.from(video.textTracks).forEach(track => {
      track.addEventListener('cuechange', handleCueChange);

      // Trigger initial cue check
      if (track.mode === 'showing' || track.mode === 'hidden') {
        const event = new Event('cuechange');
        track.dispatchEvent(event);
      }
    });

    // Set up timeupdate listener to handle subtitle delay
    const handleTimeUpdate = () => {
      const activeTrack = Array.from(video.textTracks).find(track =>
        track.mode === 'showing' || track.mode === 'hidden');
      if (activeTrack) {
        refreshActiveCues(video, activeTrack, subtitleStyle.delay);
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);

    // Also immediately check for cues when this effect runs (e.g., when delay changes)
    const activeTrack = Array.from(video.textTracks).find(track =>
      track.mode === 'showing' || track.mode === 'hidden');
    if (activeTrack) {
      refreshActiveCues(video, activeTrack, subtitleStyle.delay);
    }

    return () => {
      // Remove listeners when component unmounts
      if (video) {
        Array.from(video.textTracks).forEach(track => {
          track.removeEventListener('cuechange', handleCueChange);
        });
        video.removeEventListener('timeupdate', handleTimeUpdate);
      }
    };
  }, [subtitleStyle.delay]);

  // Add this effect to force refresh active cues when subtitle tracks change
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Find the active track and refresh its cues
    const activeTrack = Array.from(video.textTracks).find(track =>
      track.mode === 'showing' || track.mode === 'hidden');
    if (activeTrack) {
      refreshActiveCues(video, activeTrack, subtitleStyle.delay);
    }
  }, [subtitles.length]);

  // Add a function to format the delay for display
  const formatDelay = (delayInSeconds: number): string => {
    const sign = delayInSeconds >= 0 ? '+' : '';
    return `${sign}${delayInSeconds}s`;
  };

  // Get font size class based on selected style
  const getSubtitleFontSizeStyle = () => {
    return {
      fontSize: `${subtitleStyle.fontSize}rem`
    };
  };

  // Get background opacity style based on selected value
  const getSubtitleBackgroundStyle = () => {
    return {
      backgroundColor: `rgba(0, 0, 0, ${subtitleStyle.backgroundOpacity})`
    };
  };

  // Get text color style based on selected color
  const getSubtitleTextColorStyle = () => {
    return {
      color: subtitleStyle.color
    };
  };

  // Add an effect to save subtitle style changes to localStorage
  useEffect(() => {
    localStorage.setItem('subtitleStyle', JSON.stringify(subtitleStyle));
  }, [subtitleStyle]);

  // Create wrapper functions for style updates to keep code cleaner
  const updateSubtitleFontSize = (size: number) => {
    setSubtitleStyle(prev => ({ ...prev, fontSize: Math.max(0.5, Math.min(3, size)) }));
  };

  const updateSubtitleBackgroundOpacity = (opacity: number) => {
    setSubtitleStyle(prev => ({ ...prev, backgroundOpacity: Math.max(0, Math.min(1, opacity)) }));
  };

  const updateSubtitleColor = (color: string) => {
    setSubtitleStyle(prev => ({ ...prev, color }));
  };

  const updateSubtitleDelay = (delayChange: number) => {
    setSubtitleStyle(prev => ({
      ...prev,
      delay: Math.min(Math.max(prev.delay + delayChange, -10), 10)
    }));
  };

  const resetSubtitleDelay = () => {
    setSubtitleStyle(prev => ({ ...prev, delay: 0 }));
  };

  useEffect(() => {
    // Pour désactiver les sous-titres natifs au montage et après chaque mise à jour
    const disableNativeTextTracks = () => {
      const video = videoRef.current;
      if (!video) return;

      // Désactiver les sous-titres natifs pour tous les tracks
      for (const track of Array.from(video.textTracks)) {
        // On garde le mode 'hidden' pour ceux qui sont actifs, mais on s'assure qu'aucun n'est en mode 'showing'
        if (track.mode === 'showing') {
          track.mode = 'hidden';
        }
      }
    };

    // Exécuter immédiatement
    disableNativeTextTracks();

    // Ajouter un écouteur pour les changements d'affichage des tracks
    const handleTrackChange = () => {
      disableNativeTextTracks();
    };

    const video = videoRef.current;
    if (video) {
      video.textTracks.addEventListener('change', handleTrackChange);
    }

    return () => {
      if (video) {
        video.textTracks.removeEventListener('change', handleTrackChange);
      }
    };
  }, []);

  // Auto-charger le premier sous-titre français des Rivestream captions
  useEffect(() => {
    const loadFirstFrenchSubtitle = async () => {
      if (!rivestreamCaptions || rivestreamCaptions.length === 0) return;
      if (currentSubtitle && currentSubtitle.startsWith('rivestream:')) return; // Déjà un sous-titre Rivestream chargé

      const video = videoRef.current;
      if (!video) return;

      // Le premier caption devrait déjà être français grâce au tri dans WatchTv.tsx
      const firstCaption = rivestreamCaptions[0];
      const isFrench = firstCaption.label.toLowerCase().includes('français') ||
        firstCaption.label.toLowerCase().includes('french');

      if (!isFrench) return; // Ne charger que si c'est bien un sous-titre français

      console.log('🎬 Auto-loading French Rivestream subtitle:', firstCaption.label);
      setLoadingSubtitle(true);

      try {
        // Fetch le fichier de sous-titres via le proxy
        const response = await fetch(firstCaption.file);
        const srtContent = await response.text();

        // Convertir SRT en VTT
        const vttContent = 'WEBVTT\n\n' + srtContent
          .replace(/\r\n/g, '\n')
          .replace(/^\s*\d+\s*$/gm, '') // Supprimer les numéros de séquence
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') // Convertir virgules en points
          .trim();

        // Créer un blob URL
        const blob = new Blob([vttContent], { type: 'text/vtt' });
        const blobUrl = URL.createObjectURL(blob);

        // Créer l'élément track
        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = firstCaption.label;
        trackEl.srclang = 'fr';
        trackEl.src = blobUrl;
        trackEl.default = false;

        video.appendChild(trackEl);

        // Activer le track
        const enableTrack = () => {
          const textTrack = Array.from(video.textTracks).find(
            t => (t as any).label === trackEl.label
          );
          if (textTrack) {
            // Désactiver tous les autres tracks
            Array.from(video.textTracks).forEach(t => t.mode = 'disabled');
            textTrack.mode = 'hidden';
            setCurrentSubtitle('rivestream:0');
            setSubtitleContainerVisible(true);
            refreshActiveCues(video, textTrack, subtitleStyle.delay);
            setLoadingSubtitle(false);
            console.log('✅ French Rivestream subtitle loaded and activated:', firstCaption.label);
          }
        };

        trackEl.addEventListener('load', enableTrack);
        setTimeout(enableTrack, 200);
      } catch (error) {
        console.error('❌ Error auto-loading French Rivestream subtitle:', error);
        setLoadingSubtitle(false);
      }
    };

    loadFirstFrenchSubtitle();
  }, [rivestreamCaptions]); // Se déclenche quand rivestreamCaptions change

  // Fonction pour appliquer le format d'affichage
  const getVideoObjectFitClass = () => {
    switch (videoAspectRatio) {
      case 'cover':
        return 'object-cover';
      case 'contain':
        return 'object-contain';
      case '16:9':
        return 'object-cover aspect-video';
      case '4:3':
        return 'object-cover aspect-4/3';
      case 'original':
        return 'object-contain';
      default:
        return 'object-cover';
    }
  };

  // Update subtitle style
  useEffect(() => {
    if (currentSubtitle && videoRef.current && videoRef.current.textTracks) {
      updateSubtitleStyle(videoRef.current.textTracks, subtitleStyle);
    }
  }, [currentSubtitle, subtitleStyle, videoRef]);

  // Function to apply subtitle styling to text tracks
  const updateSubtitleStyle = (_textTracks: TextTrackList, style: SubtitleStyle) => {
    // Save style preferences to localStorage
    localStorage.setItem('subtitleStyle', JSON.stringify(style));

    // Apply styles to native text tracks if needed
    // Most styling is handled via CSS classes in the custom subtitle renderer

    // If using browser's native text track rendering, we would apply styles here
    // But since we're using a custom renderer (the div with activeSubtitleCues),
    // the actual styling is applied through the CSS classes in the JSX

    // The delay is applied when processing cues in refreshActiveCues function
  };

  // Update playback speed when it changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
      localStorage.setItem('playerPlaybackSpeed', playbackSpeed.toString());
    }
  }, [playbackSpeed, videoRef]);

  // Update video source when episode or format change
  useEffect(() => {
    if (src) {
      loadSource();
    }
  }, [src]);

  // Function to reset progress for the current item
  const resetCurrentProgress = () => {
    const video = videoRef.current;
    const key = getProgressKey();

    if (key) {
      console.log(`[resetCurrentProgress] Removing progress for key: ${key}`);
      localStorage.removeItem(key);
      // Continue watching functionality removed

      if (video) {
        video.currentTime = 0;
        setCurrentTime(0);
        // Maybe add a toast notification here
      }
      // Optionally close settings after resetting?
      // setShowSettings(false);
    } else {
      console.log("[resetCurrentProgress] No progress key found for current item.");
    }
  };

  const handleBackToInfo = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (movieId) {
      navigate(`/movie/${encodeId(movieId)}`);
    } else if (tvShowId) {
      navigate(`/tv/${encodeId(tvShowId)}`);
    }
  };

  // ===== Milestone 4 — état pin pour le rendu inline `onlyQualityMenu` =====
  // Mirror de la logique dans HLSPlayerSettingsPanel.tsx pour que le menu
  // sources affiché en mode embed (sidebar) montre les mêmes PinButton que
  // l'onglet Quality du panneau settings.
  const __pinCategory: PriorityCategory = 'moviesTv';
  const [__pinnedSourceId, __setPinnedSourceId] = useState<TopLevelSourceId | null>(
    () => getSourcePriorityPrefs().categories.moviesTv.pinnedSource?.id ?? null,
  );
  const [__pinnedHosterId, __setPinnedHosterId] = useState<HosterId | null>(
    () => getSourcePriorityPrefs().categories.moviesTv.pinnedHoster?.id ?? null,
  );
  useEffect(() => subscribeToPriorityChanges((p) => {
    __setPinnedSourceId(p.categories.moviesTv.pinnedSource?.id ?? null);
    __setPinnedHosterId(p.categories.moviesTv.pinnedHoster?.id ?? null);
  }), []);
  const __enrichAndSort = useCallback(<T extends Record<string, unknown>>(
    list: T[],
    topLevel?: TopLevelSourceId | LanguageId,
  ): Array<T & { type: HosterId }> => {
    if (!list || list.length === 0) return [];
    const prefs = getSourcePriorityPrefs();
    const withType = list.map((item) => {
      const rec = item as Record<string, unknown>;
      const url = String(rec?.url ?? rec?.link ?? rec?.m3u8 ?? '');
      const type = detectHoster(url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown';
      return { ...item, type } as T & { type: HosterId };
    });
    return sortHostersByPriority(withType, { category: __pinCategory, topLevel });
  }, []);
  const __detectHosterFromUrl = useCallback((url?: string | null, label?: string | null): HosterId | null => {
    const prefs = getSourcePriorityPrefs();
    const opts = {
      patternOverrides: prefs.patternOverrides,
      customHosters: prefs.customHosters,
    };
    // Tente d'abord sur l'URL, puis fallback sur le label si dispo. Pour les
    // sources HLS extraites (darkino, nexus_hls), l'URL m3u8 finale ne
    // contient souvent plus le nom du hoster (CDN nu) alors que le label
    // l'expose ("Uqload HD", "Vidmoly VF", etc.) → on récupère ces cas.
    if (url) {
      const fromUrl = detectHoster(url, opts);
      if (fromUrl) return fromUrl;
    }
    if (label) {
      const fromLabel = detectHoster(label, opts);
      if (fromLabel) return fromLabel;
    }
    return null;
  }, []);
  const __toggleHosterPin = useCallback((hosterId: HosterId) => {
    if (__pinnedHosterId === hosterId) {
      unpinHoster(__pinCategory);
    } else {
      pinHoster(__pinCategory, hosterId);
    }
  }, [__pinnedHosterId]);
  const __renderHosterPin = useCallback((hosterId: HosterId | null | undefined) => {
    if (!hosterId || hosterId === 'unknown') return null;
    return (
      <PinButton
        isPinned={__pinnedHosterId === hosterId}
        onToggle={() => __toggleHosterPin(hosterId)}
        size={12}
        className="shrink-0"
      />
    );
  }, [__pinnedHosterId, __toggleHosterPin]);

  // Dans le composant HLSPlayer, juste avant le return principal :
  if (onlyQualityMenu) {
    return (
      <div
        ref={sourceMenuRef}
        className="w-full"
        data-lenis-prevent
        data-source-menu
        onFocusCapture={handleSourceMenuFocusCapture}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key="quality"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            transition={{ duration: 0.25 }}
            className="pr-2"
          >
            {settingsTab === 'quality' && (
              <>
                {sourceGroups.map((group, groupIndex) => (
                  <div key={`group_${groupIndex}`} className="mb-6">
                    <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">{group.title}</h4>
                    {group.sources.map(source => {
                      // Skip rendering individual VOSTFR sources here, they are handled in the dropdown
                      if (source.type === 'vostfr') return null;

                      let isActive = false;
                      // Updated isActive logic for HLS sources
                      if (source.type === 'darkino_main') {
                        // Main Darkino button is active if any child Darkino source is playing
                        isActive = darkinoSources.some(ds => ds.m3u8 === src);
                      } else if (source.type === 'nexus_main') {
                        // Main Nexus button is active if any child Nexus source is playing
                        isActive = nexusHlsSources.some(ns => ns.url === src) || nexusFileSources.some(ns => ns.url === src);
                      } else if (source.type === 'mp4') {
                        isActive = src === source.url; // Direct comparison for MP4
                      } else if (source.type === 'm3u8') { // Added check for AdFree M3U8
                        isActive = src === source.url;
                      } else {
                        // Existing logic for embed sources
                        isActive = !!source.isActive || (onlyQualityMenu && embedType === source.type && embedUrl === source.url);
                      }
                      const topLevelForPin: TopLevelSourceId | null = SOURCE_MAIN_TO_TOP_LEVEL[source.type] ?? null;
                      return (
                        <React.Fragment key={source.id}>
                          <div className="mb-2 flex items-stretch gap-2">
                            <button
                              onClick={() => handleSourceChange(source.type, source.id, source.url)}
                              disabled={(source.type === 'rivestream_hls' && loadingRivestream)}
                              className={`w-full flex-1 px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isActive ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                                } ${onlyQualityMenu && embedType && embedUrl && source.type === embedType && source.url === embedUrl ? 'ring-2 ring-red-500 bg-gray-800/80' : ''} ${(source.type === 'rivestream_hls' && loadingRivestream) ? 'opacity-70 cursor-not-allowed' : ''
                                }`}
                            >
                              <div className="min-w-0 flex flex-1 flex-col">
                                <span className={`${isActive ? 'text-red-600 font-medium' : 'text-white'} ${(source.type === 'rivestream_hls' && loadingRivestream) ? 'animate-pulse' : ''
                                  }`}>
                                  {source.label}
                                  {topLevelForPin && __pinnedSourceId === topLevelForPin && (
                                    <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                  )}
                                </span>
                                {group.type === 'hls' && (source.type === 'mp4' || source.type === 'm3u8') && renderSourceQualityMeta(source.url, isActive, source.quality, source.label)}
                              </div>
                              <div className="ml-3 flex items-center gap-2">
                                {(source.type === 'darkino_main' || source.type === 'omega_main' || source.type === 'multi_main' || source.type === 'fstream_main' || source.type === 'wiflix_main' || source.type === 'j1f_main' || source.type === 'nexus_main' || source.type === 'rivestream_main' || source.type === 'bravo_main' || source.type === 'viper_main' || source.type === 'vox_main') && (
                                  <ChevronRight className={`w-4 h-4 transition-transform ${(source.type === 'darkino_main' && showDarkinoMenu) ||
                                    (source.type === 'omega_main' && showOmegaMenu) ||
                                    (source.type === 'multi_main' && showCoflixMenu) ||
                                    (source.type === 'fstream_main' && showFstreamMenu) ||
                                    (source.type === 'wiflix_main' && showWiflixMenu) ||
                                    (source.type === 'j1f_main' && showJ1fMenu) ||
                                    (source.type === 'nexus_main' && showNexusMenu) ||
                                    (source.type === 'rivestream_main' && showRivestreamMenu) ||
                                    (source.type === 'bravo_main' && showBravoMenu) ||
                                    (source.type === 'viper_main' && showViperMenu) ||
                                    (source.type === 'vox_main' && showVoxMenu)
                                    ? 'rotate-90' : ''}`}
                                  />
                                )}
                                {onlyQualityMenu && embedType && embedUrl && source.type === embedType && source.url === embedUrl && (
                                  <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>
                                )}
                                {isActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                              </div>
                            </button>
                            {topLevelForPin && (
                              <div className="flex items-center">
                                <PinButton
                                  isPinned={__pinnedSourceId === topLevelForPin}
                                  onToggle={() => (__pinnedSourceId === topLevelForPin
                                    ? unpinSource()
                                    : pinSource(topLevelForPin))}
                                  size={14}
                                />
                              </div>
                            )}
                            {group.type === 'hls' && (source.type === 'mp4' || source.type === 'm3u8') && renderCopySourceButton(source.url)}
                          </div>
                          {/* Sous-menus animés comme dans le player */}
                          {source.type === 'darkino_main' && (
                            <AnimatePresence>
                              {showDarkinoMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {darkinoSources.map((darkiSource, index) => {
                                    // Updated isActive for individual Darkino sources
                                    const isDarkinoSourceActive = src === darkiSource.m3u8;
                                    const darkiHosterId = __detectHosterFromUrl(darkiSource.m3u8, darkiSource.label || darkiSource.quality);
                                    return (
                                      <motion.div
                                        key={`darkino_${index}`}
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.2, delay: index * 0.03 }}
                                        className="mb-2 flex items-stretch gap-2"
                                      >
                                        <button
                                          onClick={() => handleSourceChange('darkino', `darkino_${index}`, darkiSource.m3u8 || '')}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isDarkinoSourceActive ? 'bg-gray-800/80 border-l-2 border-red-600 pl-3' : 'bg-gray-900/40 text-gray-300'
                                            }`}
                                        >
                                          <div className="min-w-0 flex flex-1 flex-col">
                                            <span className={isDarkinoSourceActive ? 'text-red-600 font-medium' : 'text-white'}>
                                              {darkiSource.label || darkiSource.quality || `Source ${index + 1}`}
                                              {darkiHosterId && darkiHosterId !== 'unknown' && __pinnedHosterId === darkiHosterId && (
                                                <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                              )}
                                            </span>
                                            {renderSourceQualityMeta(darkiSource.m3u8, isDarkinoSourceActive, darkiSource.quality, darkiSource.label || darkiSource.quality || `Source ${index + 1}`)}
                                          </div>
                                          <div className="ml-3 flex items-center gap-2">
                                            <span className="text-xs text-gray-400">{darkiSource.language || t('watch.french')}</span>
                                            {isDarkinoSourceActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                          </div>
                                        </button>
                                        {__renderHosterPin(darkiHosterId)}
                                        {renderCopySourceButton(darkiSource.m3u8)}
                                      </motion.div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {source.type === 'nexus_main' && (
                            <AnimatePresence>
                              {showNexusMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {/* Nexus HLS Sources */}
                                  {nexusHlsSources && nexusHlsSources.length > 0 && nexusHlsSources.map((nexusSource: any, index: number) => {
                                    const isNexusHlsActive = src === nexusSource.url;
                                    const nexusHlsHosterId = __detectHosterFromUrl(nexusSource.url, nexusSource.label);
                                    return (
                                      <motion.div
                                        key={`nexus_hls_${index}`}
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.2, delay: index * 0.03 }}
                                        className="mb-2 flex items-stretch gap-2"
                                      >
                                        <button
                                          onClick={() => handleSourceChange('nexus_hls', `nexus_hls_${index}`, nexusSource.url || '')}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isNexusHlsActive ? 'bg-gray-800/80 border-l-2 border-red-600 pl-3' : 'bg-gray-900/40 text-gray-300'
                                            }`}
                                        >
                                          <div className="min-w-0 flex flex-1 flex-col">
                                            <span className={isNexusHlsActive ? 'text-red-600 font-medium' : 'text-white'}>
                                          🚀 {nexusSource.label || `Nexus HLS ${index + 1}`}
                                          {nexusHlsHosterId && nexusHlsHosterId !== 'unknown' && __pinnedHosterId === nexusHlsHosterId && (
                                            <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                          )}
                                        </span>
                                            {renderSourceQualityMeta(nexusSource.url, isNexusHlsActive, undefined, nexusSource.label || `Nexus HLS ${index + 1}`)}
                                          </div>
                                          {isNexusHlsActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                        </button>
                                        {__renderHosterPin(nexusHlsHosterId)}
                                        {renderCopySourceButton(nexusSource.url)}
                                      </motion.div>
                                    );
                                  })}

                                  {/* Nexus File Sources */}
                                  {nexusFileSources && nexusFileSources.length > 0 && nexusFileSources.map((nexusSource: any, index: number) => {
                                    const isNexusFileActive = src === nexusSource.url;
                                    const nexusFileHosterId = __detectHosterFromUrl(nexusSource.url, nexusSource.label);
                                    return (
                                      <motion.div
                                        key={`nexus_file_${index}`}
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.2, delay: index * 0.03 }}
                                        className="mb-2 flex items-stretch gap-2"
                                      >
                                        <button
                                          onClick={() => handleSourceChange('nexus_file', `nexus_file_${index}`, nexusSource.url || '')}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isNexusFileActive ? 'bg-gray-800/80 border-l-2 border-red-600 pl-3' : 'bg-gray-900/40 text-gray-300'
                                            }`}
                                        >
                                          <div className="min-w-0 flex flex-1 flex-col">
                                            <span className={isNexusFileActive ? 'text-red-600 font-medium' : 'text-white'}>
                                          {nexusSource.label || `Nexus File ${index + 1}`}
                                          {nexusFileHosterId && nexusFileHosterId !== 'unknown' && __pinnedHosterId === nexusFileHosterId && (
                                            <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                          )}
                                        </span>
                                            {renderSourceQualityMeta(nexusSource.url, isNexusFileActive, undefined, nexusSource.label || `Nexus File ${index + 1}`)}
                                          </div>
                                          {isNexusFileActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                        </button>
                                        {__renderHosterPin(nexusFileHosterId)}
                                        {renderCopySourceButton(nexusSource.url)}
                                      </motion.div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {source.type === 'omega_main' && (
                            <AnimatePresence>
                              {showOmegaMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {omegaSources && omegaSources.length > 0 && (
                                    <div className="mb-2 mr-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-500 italic flex items-center gap-2">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
                                      {t('watch.warningWrongContentSometimes')}
                                    </div>
                                  )}
                                  {omegaSources && omegaSources.length > 0 && omegaSources.map((omegaSource: any, index: number) => {
                                    const isEmbedActive = onlyQualityMenu && embedType === 'omega' && embedUrl === omegaSource.link;
                                    const omegaHosterId = __detectHosterFromUrl(omegaSource.link, omegaSource.player);
                                    return (
                                      <div key={`omega_${index}`} className="mb-2 flex items-stretch gap-2">
                                        <motion.button
                                          initial={{ opacity: 0, x: -20 }}
                                          animate={{ opacity: 1, x: 0 }}
                                          transition={{ duration: 0.2, delay: index * 0.03 }}
                                          onClick={() => handleSourceChange('omega', `omega_${index}`, omegaSource.link || '')}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isEmbedActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                        >
                                          <span>
                                            {capitalizeFirstLetter(omegaSource.player || t('watch.playerN', { n: index + 1 }))}
                                            {omegaHosterId && omegaHosterId !== 'unknown' && __pinnedHosterId === omegaHosterId && (
                                              <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                            )}
                                          </span>
                                          {(omegaSource.player?.toLowerCase().includes('supervideo') || omegaSource.player?.toLowerCase().includes('dropload')) && (
                                            <span className="text-xs text-gray-400">{t('watch.noAds')}</span>
                                          )}
                                          {isEmbedActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                        </motion.button>
                                        {__renderHosterPin(omegaHosterId)}
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {source.type === 'multi_main' && (
                            <AnimatePresence>
                              {showCoflixMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {coflixSources && coflixSources.length > 0 && coflixSources.map((coflixSource: any, index: number) => {
                                    const coflixUrl = getCoflixPreferredUrl(coflixSource);
                                    const isCoflixActive = onlyQualityMenu && embedType === 'coflix' && embedUrl === coflixUrl;
                                    const coflixHosterId = __detectHosterFromUrl(coflixUrl, coflixSource.quality);
                                    return (
                                      <div key={`coflix_${index}`} className="mb-2 flex items-stretch gap-2">
                                        <motion.button
                                          initial={{ opacity: 0, x: -20 }}
                                          animate={{ opacity: 1, x: 0 }}
                                          transition={{ duration: 0.2, delay: index * 0.03 }}
                                          onClick={() => handleSourceChange('coflix', `coflix_${index}`, coflixUrl)}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isCoflixActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                        >
                                          <span>
                                            {(coflixSource.quality || `Source ${index + 1}`).split('/')[0].trim() || `Source ${index + 1}`}
                                            {coflixHosterId && coflixHosterId !== 'unknown' && __pinnedHosterId === coflixHosterId && (
                                              <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                            )}
                                          </span>
                                          <span className="text-xs text-gray-400">{coflixSource.language || t('watch.french')}</span>
                                          {isCoflixActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                        </motion.button>
                                        {__renderHosterPin(coflixHosterId)}
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Ajout du menu déroulant VOSTFR */}
                          {source.type === 'vostfr_main' && (
                            <AnimatePresence>
                              {showVostfrMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {[
                                    { id: 'peachify', label: 'Peachify' },
                                    { id: 'vostfr', label: 'Videasy' },
                                    { id: 'vidlink', label: 'Vidlink' },
                                    { id: 'vidsrccc', label: 'Vidsrc.io' },
                                    { id: 'vidsrcwtf1', label: 'Vidsrc.wtf 1' }
                                  ].map((vostfrSource, index) => {
                                    // IMPORTANT: `!= null` au lieu de truthy check — sinon seasonNumber=0
                                    // (épisode spécial / Spéciaux TMDB) tombe dans le fallback '#' qui fait
                                    // charger la page courante en boucle dans l'iframe.
                                    const sourceUrl = movieId ?
                                      vostfrSource.id === 'peachify' ? `https://peachify.top/embed/movie/${movieId}?sub=French&accent=dc2626` :
                                        vostfrSource.id === 'vidlink' ? `https://vidlink.pro/movie/${movieId}` :
                                          vostfrSource.id === 'vidsrccc' ? `https://vidsrc.io/embed/movie?tmdb=${movieId}` :
                                            vostfrSource.id === 'vostfr' ? `https://player.videasy.net/movie/${movieId}` :
                                              `https://vidsrc.wtf/api/1/movie/?id=${movieId}` :
                                      (tvShowId != null && seasonNumber != null && episodeNumber != null) ?
                                        vostfrSource.id === 'peachify' ? `https://peachify.top/embed/tv/${tvShowId}/${seasonNumber}/${episodeNumber}?sub=French&accent=dc2626` :
                                          vostfrSource.id === 'vidlink' ? `https://vidlink.pro/tv/${tvShowId}/${seasonNumber}/${episodeNumber}` :
                                            vostfrSource.id === 'vidsrccc' ? `https://vidsrc.io/embed/tv?tmdb=${tvShowId}&season=${seasonNumber}&episode=${episodeNumber}` :
                                              vostfrSource.id === 'vostfr' ? `https://player.videasy.net/tv/${tvShowId}/${seasonNumber}/${episodeNumber}` :
                                                `https://vidsrc.wtf/api/1/tv/?id=${tvShowId}&s=${seasonNumber}&e=${episodeNumber}` :
                                        '#'; // Fallback if neither movie nor TV info is present

                                    // Active state check for VOSTFR sources in main menu
                                    const isVostfrActive = embedType === 'vostfr' && embedUrl === sourceUrl;

                                    return (
                                      <motion.button
                                        key={`vostfr_${index}`}
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.2, delay: index * 0.03 }}
                                        onClick={() => handleSourceChange('vostfr', vostfrSource.id, sourceUrl)}
                                        className={`w-full px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center bg-gray-900/40 text-gray-300 ${isVostfrActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                      >
                                        <span>{vostfrSource.label}</span>
                                        <span className="text-xs text-gray-400">{t('watch.voVostfr')}</span>
                                        {isVostfrActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                      </motion.button>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Ajout du menu déroulant FStream avec sous-catégories par langue */}
                          {source.type === 'fstream_main' && (
                            console.log('🔍 [HLSPlayer] Rendering FStream menu, showFstreamMenu:', showFstreamMenu, 'fstreamSources:', fstreamSources?.length),
                            <AnimatePresence>
                              {showFstreamMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {fstreamSources && fstreamSources.length > 0 && (() => {
                                    // Organiser les sources par catégorie
                                    const sourcesByCategory = fstreamSources.reduce((acc, source) => {
                                      const category = source.category || 'Default';
                                      if (!acc[category]) acc[category] = [];
                                      acc[category].push(source);
                                      return acc;
                                    }, {} as Record<string, typeof fstreamSources>);

                                    // Définir l'ordre et les emojis des catégories
                                    const categoryOrder = [
                                      { key: 'VFQ', label: t('watch.frenchQuality'), flagCode: 'FR' },
                                      { key: 'VFF', label: t('watch.frenchFilm'), flagCode: 'FR' },
                                      { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                      { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' },
                                      { key: 'Default', label: t('watch.unknownLang'), emoji: '🌍' }
                                    ];

                                    return categoryOrder.map((cat) => {
                                      const categorySources = sourcesByCategory[cat.key];
                                      if (!categorySources || categorySources.length === 0) return null;

                                      return (
                                        <div key={`fstream_category_${cat.key}`} className="mb-3">
                                          {/* En-tête de catégorie */}
                                          <div className="flex items-center gap-2 mb-2 px-2">
                                            <span className="text-lg">{'flagCode' in cat && cat.flagCode ? <ReactCountryFlag countryCode={cat.flagCode as string} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /> : cat.emoji}</span>
                                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                              {cat.label} ({categorySources.length})
                                            </span>
                                          </div>
                                          {/* Sources de la catégorie */}
                                          {categorySources.map((fstreamSource, index) => {
                                            const globalIndex = fstreamSources.findIndex(s => s.url === fstreamSource.url);
                                            const isFstreamActive = onlyQualityMenu && embedType === 'fstream' && getOriginalUrl(embedUrl || '') === fstreamSource.url;
                                            const fstreamHosterId = __detectHosterFromUrl(fstreamSource.url, fstreamSource.label);
                                            return (
                                              <div key={`fstream_${cat.key}_${index}`} className="mb-1 ml-4 flex items-stretch gap-2">
                                                <motion.button
                                                  initial={{ opacity: 0, x: -20 }}
                                                  animate={{ opacity: 1, x: 0 }}
                                                  transition={{ duration: 0.2, delay: index * 0.03 }}
                                                  onClick={() => handleSourceChange('fstream', `fstream_${globalIndex}`, fstreamSource.url)}
                                                  className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isFstreamActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                >
                                                  <span>
                                                    {fstreamSource.label}
                                                    {fstreamHosterId && fstreamHosterId !== 'unknown' && __pinnedHosterId === fstreamHosterId && (
                                                      <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                    )}
                                                  </span>
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs text-gray-500">{fstreamSource.category}</span>
                                                    {isFstreamActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                  </div>
                                                </motion.button>
                                                {__renderHosterPin(fstreamHosterId)}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    }).filter(Boolean);
                                  })()}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Ajout du menu déroulant Wiflix/Lynx */}
                          {source.type === 'wiflix_main' && (
                            <AnimatePresence>
                              {showWiflixMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {wiflixSources && wiflixSources.length > 0 && (() => {
                                    // Organiser les sources par catégorie
                                    const sourcesByCategory = wiflixSources.reduce((acc, source) => {
                                      const category = source.category || 'Default';
                                      if (!acc[category]) acc[category] = [];
                                      acc[category].push(source);
                                      return acc;
                                    }, {} as Record<string, typeof wiflixSources>);

                                    // Définir l'ordre et les emojis des catégories
                                    const categoryOrder = [
                                      { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                      { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' }
                                    ];

                                    return categoryOrder.map((cat) => {
                                      const categorySources = sourcesByCategory[cat.key];
                                      if (!categorySources || categorySources.length === 0) return null;

                                      return (
                                        <div key={`wiflix_category_${cat.key}`} className="mb-3">
                                          {/* En-tête de catégorie */}
                                          <div className="flex items-center gap-2 mb-2 px-2">
                                            <span className="text-lg"><ReactCountryFlag countryCode={cat.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /></span>
                                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                              {cat.label} ({categorySources.length})
                                            </span>
                                          </div>
                                          {/* Sources de la catégorie */}
                                          {categorySources.map((wiflixSource, index) => {
                                            const globalIndex = wiflixSources.findIndex(s => s.url === wiflixSource.url);
                                            const isWiflixActive = onlyQualityMenu && embedType === 'wiflix' && embedUrl === wiflixSource.url;
                                            const wiflixHosterId = __detectHosterFromUrl(wiflixSource.url, wiflixSource.label);
                                            return (
                                              <div key={`wiflix_${cat.key}_${index}`} className="mb-1 ml-4 flex items-stretch gap-2">
                                                <motion.button
                                                  initial={{ opacity: 0, x: -20 }}
                                                  animate={{ opacity: 1, x: 0 }}
                                                  transition={{ duration: 0.2, delay: index * 0.03 }}
                                                  onClick={() => handleSourceChange('wiflix', `wiflix_${globalIndex}`, wiflixSource.url)}
                                                  className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isWiflixActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                >
                                                  <span>
                                                    {wiflixSource.label}
                                                    {wiflixHosterId && wiflixHosterId !== 'unknown' && __pinnedHosterId === wiflixHosterId && (
                                                      <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                    )}
                                                  </span>
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs text-gray-500">{wiflixSource.category}</span>
                                                    {isWiflixActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                  </div>
                                                </motion.button>
                                                {__renderHosterPin(wiflixHosterId)}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    }).filter(Boolean);
                                  })()}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Ajout du menu déroulant J1F / 1jour1film */}
                          {source.type === 'j1f_main' && (
                            <AnimatePresence>
                              {showJ1fMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {j1fSources && j1fSources.length > 0 && (() => {
                                    const sourcesByCategory = j1fSources.reduce((acc, source) => {
                                      const category = source.category || 'Default';
                                      if (!acc[category]) acc[category] = [];
                                      acc[category].push(source);
                                      return acc;
                                    }, {} as Record<string, typeof j1fSources>);

                                    const categoryOrder = [
                                      { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                      { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' }
                                    ];

                                    return categoryOrder.map((cat) => {
                                      const categorySources = sourcesByCategory[cat.key];
                                      if (!categorySources || categorySources.length === 0) return null;

                                      return (
                                        <div key={`j1f_category_${cat.key}`} className="mb-3">
                                          <div className="flex items-center gap-2 mb-2 px-2">
                                            <span className="text-lg"><ReactCountryFlag countryCode={cat.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /></span>
                                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                              {cat.label} ({categorySources.length})
                                            </span>
                                          </div>
                                          {categorySources.map((j1fSource, index) => {
                                            const globalIndex = j1fSources.findIndex(s => s.url === j1fSource.url);
                                            const isJ1fActive = onlyQualityMenu && embedType === 'j1f' && embedUrl === j1fSource.url;
                                            const j1fHosterId = __detectHosterFromUrl(j1fSource.url, j1fSource.label);
                                            return (
                                              <div key={`j1f_${cat.key}_${index}`} className="mb-1 ml-4 flex items-stretch gap-2">
                                                <motion.button
                                                  initial={{ opacity: 0, x: -20 }}
                                                  animate={{ opacity: 1, x: 0 }}
                                                  transition={{ duration: 0.2, delay: index * 0.03 }}
                                                  onClick={() => handleSourceChange('j1f', `j1f_${globalIndex}`, j1fSource.url)}
                                                  className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isJ1fActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                >
                                                  <span>
                                                    {j1fSource.label}
                                                    {j1fHosterId && j1fHosterId !== 'unknown' && __pinnedHosterId === j1fHosterId && (
                                                      <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                    )}
                                                  </span>
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs text-gray-500">{j1fSource.category}</span>
                                                    {isJ1fActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                  </div>
                                                </motion.button>
                                                {__renderHosterPin(j1fHosterId)}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    }).filter(Boolean);
                                  })()}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Sous-menu Bravo (PurStream) */}
                          {source.type === 'bravo_main' && (
                            <AnimatePresence>
                              {showBravoMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {purstreamSources && purstreamSources.length > 0 ? (
                                    purstreamSources.map((bravoSource, index) => {
                                      const isBravoActive = src === bravoSource.url
                                        || (embedType === 'bravo' && !!embedUrl && embedUrl.includes(bravoSource.url));
                                      const bravoHosterId = __detectHosterFromUrl(bravoSource.url, bravoSource.label);
                                      return (
                                        <motion.div
                                          key={`bravo_${index}`}
                                          initial={{ opacity: 0, x: -20 }}
                                          animate={{ opacity: 1, x: 0 }}
                                          transition={{ duration: 0.2, delay: index * 0.03 }}
                                          className="mb-1 ml-4 flex items-stretch gap-2"
                                        >
                                          <button
                                            onClick={() => handleSourceChange('bravo', `bravo_${index}`, bravoSource.url)}
                                            className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isBravoActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                          >
                                            <div className="min-w-0 flex flex-1 flex-col">
                                              <span className={isBravoActive ? 'text-red-600 font-medium' : 'text-white'}>
                                                {bravoSource.label}
                                                {bravoHosterId && bravoHosterId !== 'unknown' && __pinnedHosterId === bravoHosterId && (
                                                  <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                )}
                                              </span>
                                              {renderSourceQualityMeta(bravoSource.url, isBravoActive, undefined, bravoSource.label)}
                                            </div>
                                            {isBravoActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                          </button>
                                          {__renderHosterPin(bravoHosterId)}
                                          {renderCopySourceButton(bravoSource.url)}
                                        </motion.div>
                                      );
                                    })
                                  ) : (
                                    <div className="px-4 py-2 text-sm text-gray-400">
                                      {t('watch.noSources')}
                                    </div>
                                  )}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Sous-menu Rivestream */}
                          {source.type === 'rivestream_main' && (
                            <AnimatePresence>
                              {showRivestreamMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {rivestreamSources && rivestreamSources.length > 0 ? (() => {
                                    // Organiser les sources par catégorie (service)
                                    const sourcesByCategory = rivestreamSources.reduce((acc, source) => {
                                      const category = source.category || 'Other';
                                      if (!acc[category]) acc[category] = [];
                                      acc[category].push(source);
                                      return acc;
                                    }, {} as Record<string, typeof rivestreamSources>);

                                    // Définir l'ordre et les emojis des catégories
                                    const categoryOrder = [
                                      { key: 'flowcast', emoji: '🌊' },
                                      { key: 'asiacloud', emoji: '☁️' },
                                      { key: 'hindicast', flagCode: 'IN' },
                                      { key: 'aqua', emoji: '💧' },
                                      { key: 'humpy', emoji: '🎬' },
                                      { key: 'primevids', emoji: '⭐' },
                                      { key: 'shadow', emoji: '🌑' },
                                      { key: 'animez', emoji: '🎭' },
                                      { key: 'yggdrasil', emoji: '🌳' },
                                      { key: 'putafilme', emoji: '🎞️' },
                                      { key: 'ophim', emoji: '🎥' }
                                    ];

                                    const result = categoryOrder.map((cat) => {
                                      const categorySources = sourcesByCategory[cat.key];
                                      if (!categorySources || categorySources.length === 0) return null;

                                      return (
                                        <div key={`rivestream_category_${cat.key}`} className="mb-3">
                                          {/* En-tête de catégorie */}
                                          <div className="flex items-center gap-2 mb-2 px-2">
                                            <span className="text-lg">{'flagCode' in cat && cat.flagCode ? <ReactCountryFlag countryCode={cat.flagCode as string} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /> : cat.emoji}</span>
                                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                              {cat.key} ({categorySources.length})
                                            </span>
                                          </div>
                                          {/* Sources de la catégorie */}
                                          {categorySources.map((rivestreamSource, index) => {
                                            const globalIndex = rivestreamSources.findIndex(s => s.url === rivestreamSource.url);
                                            const isRivestreamActive = src === rivestreamSource.url;
                                            const rivestreamHosterId = __detectHosterFromUrl(rivestreamSource.url, rivestreamSource.label || rivestreamSource.service);
                                            return (
                                              <motion.div
                                                key={`rivestream_${cat.key}_${index}`}
                                                initial={{ opacity: 0, x: -20 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{ duration: 0.2, delay: index * 0.03 }}
                                                className="mb-1 ml-4 flex items-stretch gap-2"
                                              >
                                                <button
                                                  onClick={() => handleSourceChange('rivestream', `rivestream_${globalIndex}`, rivestreamSource.url)}
                                                  className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isRivestreamActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                >
                                                  <div className="min-w-0 flex flex-1 flex-col">
                                                    <span className={isRivestreamActive ? 'text-red-600 font-medium' : 'text-white'}>
                                                      {rivestreamSource.label}
                                                      {rivestreamHosterId && rivestreamHosterId !== 'unknown' && __pinnedHosterId === rivestreamHosterId && (
                                                        <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                      )}
                                                    </span>
                                                    {renderSourceQualityMeta(rivestreamSource.url, isRivestreamActive, rivestreamSource.quality, rivestreamSource.label)}
                                                  </div>
                                                  <div className="ml-3 flex items-center gap-2">
                                                    <span className="text-xs text-gray-400">{rivestreamSource.service}</span>
                                                    {isRivestreamActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                                  </div>
                                                </button>
                                                {__renderHosterPin(rivestreamHosterId)}
                                                {renderCopySourceButton(rivestreamSource.url)}
                                              </motion.div>
                                            );
                                          })}
                                        </div>
                                      );
                                    }).filter(Boolean);

                                    return result;
                                  })() : (
                                    <div className="px-4 py-2 text-sm text-gray-400">
                                      {t('watch.noSources')}
                                    </div>
                                  )}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}

                          {/* Sous-menu Viper (embed section) */}
                          {source.type === 'viper_main' && (
                            <AnimatePresence>
                              {showViperMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {viperSources.map((vSource, index) => {
                                    const isViperSourceActive = embedType === 'viper' && embedUrl === vSource.url;
                                    const viperHosterId = __detectHosterFromUrl(vSource.url, vSource.label);
                                    return (
                                      <div key={`viper_embed_${index}`} className="mb-1 flex items-stretch gap-2">
                                        <motion.button
                                          initial={{ opacity: 0, x: -20 }}
                                          animate={{ opacity: 1, x: 0 }}
                                          transition={{ duration: 0.2, delay: index * 0.03 }}
                                          onClick={() => handleSourceChange('viper', index.toString(), vSource.url)}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isViperSourceActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                        >
                                          <div className="flex flex-col">
                                            <span className={isViperSourceActive ? 'text-red-600 font-medium' : 'text-white'}>
                                              {vSource.label}
                                              {viperHosterId && viperHosterId !== 'unknown' && __pinnedHosterId === viperHosterId && (
                                                <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                              )}
                                            </span>
                                            <div className="flex gap-2">
                                              {vSource.language && <span className="text-[10px] text-gray-500 uppercase">{vSource.language}</span>}
                                              {vSource.quality && <span className="text-[10px] text-gray-500">{vSource.quality}</span>}
                                            </div>
                                          </div>
                                          {isViperSourceActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                        </motion.button>
                                        {__renderHosterPin(viperHosterId)}
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                          {/* Sous-menu Vox */}
                          {source.type === 'vox_main' && (
                            <AnimatePresence>
                              {showVoxMenu && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{ duration: 0.2, ease: "easeOut" }}
                                  className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                >
                                  {voxSources.map((vSource, index) => {
                                    const isVoxSourceActive = embedType === 'vox' && embedUrl === vSource.link;
                                    const voxHosterId = __detectHosterFromUrl(vSource.link, vSource.name);
                                    return (
                                      <div key={`vox_embed_${index}`} className="mb-1 flex items-stretch gap-2">
                                        <motion.button
                                          initial={{ opacity: 0, x: -20 }}
                                          animate={{ opacity: 1, x: 0 }}
                                          transition={{ duration: 0.2, delay: index * 0.03 }}
                                          onClick={() => handleSourceChange('vox', index.toString(), vSource.link)}
                                          className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isVoxSourceActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                        >
                                          <div className="flex flex-col">
                                            <span className={isVoxSourceActive ? 'text-red-600 font-medium' : 'text-white'}>
                                              {vSource.name}
                                              {voxHosterId && voxHosterId !== 'unknown' && __pinnedHosterId === voxHosterId && (
                                                <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                              )}
                                            </span>
                                          </div>
                                          {isVoxSourceActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                        </motion.button>
                                        {__renderHosterPin(voxHosterId)}
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    play: async () => {
      if (videoRef.current) {
        return videoRef.current.play();
      }
      return Promise.reject('No video element available');
    },
    pause: () => {
      if (videoRef.current) {
        videoRef.current.pause();
      }
    },
    seek: (time: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    },
    seekTo: (time: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    },
    getDuration: () => {
      return videoRef.current ? videoRef.current.duration : 0;
    },
    getCurrentTime: () => {
      return videoRef.current ? videoRef.current.currentTime : 0;
    },
    isPaused: () => {
      return videoRef.current ? videoRef.current.paused : true;
    },
    setPlaybackRate: (rate: number) => {
      if (videoRef.current) {
        videoRef.current.playbackRate = Math.max(0.95, Math.min(1.05, rate));
      }
    },
    getPlaybackRate: () => {
      return videoRef.current ? videoRef.current.playbackRate : 1;
    },
    getVideoElement: () => videoRef.current,
  }));



  // Add zoom state
  const [zoomState, setZoomState] = useState<ZoomState>({
    scale: 1,
    translateX: 0,
    translateY: 0,
    isZoomed: false
  });

  // Refs for smooth zoom (YouTube-like) - avoid React re-renders during gesture
  const zoomRef = useRef({ scale: 1, translateX: 0, translateY: 0 });
  const isPinchingRef = useRef(false);
  const lastPinchDistanceRef = useRef<number | null>(null);
  const pinchCenterRef = useRef({ x: 0, y: 0 });
  const videoWrapperRef = useRef<HTMLDivElement | null>(null);

  // Apply transform directly to DOM for smooth animation (YouTube-like)
  const applyZoomTransform = useCallback((scale: number, translateX: number, translateY: number) => {
    if (videoWrapperRef.current) {
      videoWrapperRef.current.style.transform = `scale(${scale}) translate(${translateX}px, ${translateY}px)`;
    }
  }, []);

  // Clamp translation within bounds
  const clampTranslation = useCallback((scale: number, translateX: number, translateY: number) => {
    if (!containerRef.current || scale <= 1) {
      return { x: 0, y: 0 };
    }
    
    const rect = containerRef.current.getBoundingClientRect();
    const maxTranslateX = (rect.width * (scale - 1)) / (2 * scale);
    const maxTranslateY = (rect.height * (scale - 1)) / (2 * scale);
    
    return {
      x: Math.max(-maxTranslateX, Math.min(maxTranslateX, translateX)),
      y: Math.max(-maxTranslateY, Math.min(maxTranslateY, translateY))
    };
  }, []);

  const resetZoom = useCallback(() => {
    zoomRef.current = { scale: 1, translateX: 0, translateY: 0 };
    
    // Animate the reset smoothly
    if (videoWrapperRef.current) {
      videoWrapperRef.current.style.transition = 'transform 0.25s ease-out';
      applyZoomTransform(1, 0, 0);
      setTimeout(() => {
        if (videoWrapperRef.current) {
          videoWrapperRef.current.style.transition = 'none';
        }
      }, 250);
    }
    
    setZoomState({
      scale: 1,
      translateX: 0,
      translateY: 0,
      isZoomed: false
    });
  }, [applyZoomTransform]);

  const handleZoomTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Two finger touch - start pinch zoom gesture
      isPinchingRef.current = true;
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      lastPinchDistanceRef.current = Math.sqrt(dx * dx + dy * dy);
      
      pinchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2
      };
    } else if (e.touches.length === 1) {
      // Single touch start: store start position and reset movement state
      const t = e.touches[0];
      touchStartXRef.current = t.clientX;
      touchStartYRef.current = t.clientY;
      touchMovedRef.current = false;
      touchActiveRef.current = true;

      if (isMobile) {
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current);
          controlsTimeoutRef.current = undefined;
        }
      }
    }
  };

  const handleZoomTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && isPinchingRef.current && lastPinchDistanceRef.current !== null) {
      e.preventDefault();
      
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      
      // Calculate current distance
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      const currentDistance = Math.sqrt(dx * dx + dy * dy);
      
      // Calculate scale change ratio (smoother than absolute calculation)
      const scaleChange = currentDistance / lastPinchDistanceRef.current;
      let newScale = zoomRef.current.scale * scaleChange;
      
      // Clamp scale between 1 and 4
      newScale = Math.max(1, Math.min(4, newScale));
      
      // Calculate new center
      const newCenterX = (touch1.clientX + touch2.clientX) / 2;
      const newCenterY = (touch1.clientY + touch2.clientY) / 2;
      
      // Calculate pan based on center movement
      const panX = (newCenterX - pinchCenterRef.current.x) / newScale;
      const panY = (newCenterY - pinchCenterRef.current.y) / newScale;
      
      let newTranslateX = zoomRef.current.translateX + panX;
      let newTranslateY = zoomRef.current.translateY + panY;
      
      // Clamp translation
      const clamped = clampTranslation(newScale, newTranslateX, newTranslateY);
      newTranslateX = clamped.x;
      newTranslateY = clamped.y;
      
      // Reset to center if scale is essentially 1
      if (newScale < 1.02) {
        newScale = 1;
        newTranslateX = 0;
        newTranslateY = 0;
      }
      
      // Update ref (no React re-render)
      zoomRef.current = {
        scale: newScale,
        translateX: newTranslateX,
        translateY: newTranslateY
      };
      
      // Apply transform directly to DOM for smooth animation
      applyZoomTransform(newScale, newTranslateX, newTranslateY);
      
      // Update pinch tracking for next frame
      lastPinchDistanceRef.current = currentDistance;
      pinchCenterRef.current = { x: newCenterX, y: newCenterY };
      
    } else if (e.touches.length === 1) {
      // Single finger pan when zoomed
      if (zoomRef.current.scale > 1) {
        const t = e.touches[0];
        if (touchStartXRef.current !== null && touchStartYRef.current !== null) {
          const dx = t.clientX - touchStartXRef.current;
          const dy = t.clientY - touchStartYRef.current;
          
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            touchMovedRef.current = true;
            
            // Pan the zoomed view
            let newTranslateX = zoomRef.current.translateX + dx / zoomRef.current.scale;
            let newTranslateY = zoomRef.current.translateY + dy / zoomRef.current.scale;
            
            // Clamp translation
            const clamped = clampTranslation(zoomRef.current.scale, newTranslateX, newTranslateY);
            newTranslateX = clamped.x;
            newTranslateY = clamped.y;
            
            zoomRef.current.translateX = newTranslateX;
            zoomRef.current.translateY = newTranslateY;
            
            applyZoomTransform(zoomRef.current.scale, newTranslateX, newTranslateY);
            
            // Update start position for next move
            touchStartXRef.current = t.clientX;
            touchStartYRef.current = t.clientY;
          }
        }
      } else {
        // Detect movement to avoid interpreting drags as taps
        const t = e.touches[0];
        if (touchStartXRef.current !== null && touchStartYRef.current !== null) {
          const dx = Math.abs(t.clientX - touchStartXRef.current);
          const dy = Math.abs(t.clientY - touchStartYRef.current);
          if (dx > 10 || dy > 10) {
            touchMovedRef.current = true;
          }
        }
      }
    }
  };

  // Create a stable toggle function to avoid double calls
  const toggleControlsStable = useCallback((reason: string) => {
    if (controlsToggleInProgressRef.current) {
      console.log('Toggle already in progress, skipping:', reason);
      return;
    }

    controlsToggleInProgressRef.current = true;
    console.log('Toggling controls:', reason, 'current state:', showControls);

    const newState = !showControls;
    console.log('Setting controls to:', newState);

    setShowControls(newState);

    if (newState && isPlaying && !showCastMenu) {
      // Auto-hide after same delay as mouse move path
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = setTimeout(() => {
        // Do not hide if skip animations or tap overlays are showing
        if (!showCastMenu && !showForwardAnimation && !showRewindAnimation && !showLeftTapAnimation && !showRightTapAnimation) {
          console.log('Auto-hiding controls after 5s');
          setShowControls(false);
          setShowVolumeSlider(false);
        }
      }, 5000);
    }

    // Reset the flag after a short delay
    setTimeout(() => {
      controlsToggleInProgressRef.current = false;
    }, 100);
  }, [showControls, isPlaying, showCastMenu, showForwardAnimation, showRewindAnimation, showLeftTapAnimation, showRightTapAnimation]);

  const handleZoomTouchEnd = (e: React.TouchEvent) => {
    touchActiveRef.current = false;

    // Prevent synthetic click from interfering - ALWAYS do this regardless of movement
    preventSyntheticClick();

    // End pinch gesture and sync React state
    if (e.touches.length < 2 && isPinchingRef.current) {
      isPinchingRef.current = false;
      lastPinchDistanceRef.current = null;

      // Snap to 1 if very close, with smooth animation
      if (zoomRef.current.scale < 1.05) {
        zoomRef.current = { scale: 1, translateX: 0, translateY: 0 };
        
        // Animate back to 1
        if (videoWrapperRef.current) {
          videoWrapperRef.current.style.transition = 'transform 0.2s ease-out';
          applyZoomTransform(1, 0, 0);
          setTimeout(() => {
            if (videoWrapperRef.current) {
              videoWrapperRef.current.style.transition = 'none';
            }
          }, 200);
        }
        
        setZoomState({
          scale: 1,
          translateX: 0,
          translateY: 0,
          isZoomed: false
        });
      } else {
        // Sync React state with current zoom values
        setZoomState({
          scale: zoomRef.current.scale,
          translateX: zoomRef.current.translateX,
          translateY: zoomRef.current.translateY,
          isZoomed: zoomRef.current.scale > 1
        });
      }
    }

    // Ignore if a drag occurred (scrub or scroll)
    if (touchMovedRef.current) {
      touchMovedRef.current = false;
      return;
    }

    const now = Date.now();

    // Determine tap side using last known start X within container
    if (!containerRef.current) {
      console.log('No container ref, returning');
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const startX = touchStartXRef.current ?? rect.left + rect.width / 2;
    const relativeX = startX - rect.left;
    const isRightSide = relativeX > rect.width * 0.7; // right 30%
    const isLeftSide = relativeX < rect.width * 0.3;  // left 30%

    // If tap is near center, treat as center single tap (controls toggle) after delay
    let side: 'left' | 'right' | 'center' = 'center';
    if (isRightSide) side = 'right';
    else if (isLeftSide) side = 'left';

    console.log('Touch end - startX:', startX, 'relativeX:', relativeX, 'side:', side, 'rect.width:', rect.width);

    const DOUBLE_TAP_DELAY = 250; // ms

    // If animation is already showing, a single tap on that side should immediately add another skip
    if (side === 'right' && showRightTapAnimation) {
      console.log('Right side tap while animation showing: adding +10s');
      setRightTapCount(prev => prev + 1);
      if (videoRef.current) videoRef.current.currentTime += 10;
      // Reset the timeout to keep animation visible
      if (rightTapTimeoutRef.current) clearTimeout(rightTapTimeoutRef.current);
      rightTapTimeoutRef.current = setTimeout(() => {
        setRightTapCount(0);
        setShowRightTapAnimation(false);
        rightTapTimeoutRef.current = null;
      }, 800);
      lastTapTimeRef.current = now;
      lastTapSideRef.current = 'right';
      return;
    }

    if (side === 'left' && showLeftTapAnimation) {
      console.log('Left side tap while animation showing: adding -10s');
      setLeftTapCount(prev => prev + 1);
      if (videoRef.current) videoRef.current.currentTime -= 10;
      // Reset the timeout to keep animation visible
      if (leftTapTimeoutRef.current) clearTimeout(leftTapTimeoutRef.current);
      leftTapTimeoutRef.current = setTimeout(() => {
        setLeftTapCount(0);
        setShowLeftTapAnimation(false);
        leftTapTimeoutRef.current = null;
      }, 800);
      lastTapTimeRef.current = now;
      lastTapSideRef.current = 'left';
      return;
    }

    if (side === 'center') {
      // Center tap: handle as potential toggle controls
      console.log('Center tap detected, setting timeout for controls toggle');
      if (singleTapTimeoutRef.current) clearTimeout(singleTapTimeoutRef.current);
      singleTapTimeoutRef.current = setTimeout(() => {
        console.log('Center tap timeout triggered');
        toggleControlsStable('center tap');
      }, DOUBLE_TAP_DELAY);
      lastTapTimeRef.current = now;
      lastTapSideRef.current = 'left'; // arbitrary to mark a tap
      return;
    }

    // Side taps (left/right): detect double-tap and accumulate
    const sameSide = lastTapSideRef.current === side;
    const withinDelay = now - lastTapTimeRef.current <= DOUBLE_TAP_DELAY;

    console.log('Double-tap detection:', {
      side,
      lastSide: lastTapSideRef.current,
      sameSide,
      timeDiff: now - lastTapTimeRef.current,
      withinDelay,
      DOUBLE_TAP_DELAY
    });

    if (sameSide && withinDelay) {
      console.log('DOUBLE TAP DETECTED on', side, 'side!');
      // Double tap detected on same side: cancel pending single tap toggle
      if (singleTapTimeoutRef.current) {
        console.log('Cancelling pending single tap timeout');
        clearTimeout(singleTapTimeoutRef.current);
        singleTapTimeoutRef.current = null;
      } else {
        console.log('No pending single tap timeout to cancel');
      }

      // Accumulate and seek
      if (side === 'right') {
        console.log('Right double-tap: seeking +10s');
        setRightTapCount(prev => prev + 1);
        setShowRightTapAnimation(true);
        if (videoRef.current) videoRef.current.currentTime += 10;
        if (rightTapTimeoutRef.current) clearTimeout(rightTapTimeoutRef.current);
        rightTapTimeoutRef.current = setTimeout(() => {
          setRightTapCount(0);
          setShowRightTapAnimation(false);
          rightTapTimeoutRef.current = null;
        }, 800);
      } else if (side === 'left') {
        console.log('Left double-tap: seeking -10s');
        setLeftTapCount(prev => prev + 1);
        setShowLeftTapAnimation(true);
        if (videoRef.current) videoRef.current.currentTime -= 10;
        if (leftTapTimeoutRef.current) clearTimeout(leftTapTimeoutRef.current);
        leftTapTimeoutRef.current = setTimeout(() => {
          setLeftTapCount(0);
          setShowLeftTapAnimation(false);
          leftTapTimeoutRef.current = null;
        }, 800);
      }

      // Ensure controls are not shown due to these taps
      console.log('Double-tap: hiding controls');
      setShowControls(false);

      // Update last tap time to allow rapid accumulation (+20, +30...)
      lastTapTimeRef.current = now;
      lastTapSideRef.current = side as 'left' | 'right';
    } else {
      console.log('First tap on', side, 'side - waiting for potential second tap');
      // First tap on a side: wait for potential second tap; if no second tap, toggle controls
      if (singleTapTimeoutRef.current) clearTimeout(singleTapTimeoutRef.current);
      singleTapTimeoutRef.current = setTimeout(() => {
        // Single tap on side: toggle controls (same as center tap)
        console.log('Side tap timeout elapsed - no second tap, toggling controls');
        toggleControlsStable('side tap');
      }, DOUBLE_TAP_DELAY);
      console.log('Set single tap timeout with ID:', singleTapTimeoutRef.current);
      lastTapTimeRef.current = now;
      lastTapSideRef.current = side as 'left' | 'right';
    }
  };

  // Add double click (desktop only) to reset zoom or toggle fullscreen
  const handleDoubleTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Si clic sur bouton, icône, barre de contrôle, menu paramètres, barre de progression, poster, on ignore
    if (
      target.closest('button, .control-bar, .settings-menu, .progress-bar, .poster, .volume-slider') ||
      target.tagName === 'BUTTON' ||
      target.getAttribute('role') === 'button' ||
      target.classList.contains('pointer-events-none')
    ) {
      return;
    }

    // On mobile, don't use double click; it's handled by touch logic
    if (isTouchDevice) return;
    const touch = e as unknown as React.TouchEvent;
    const containerWidth = containerRef.current?.clientWidth || 0;
    const isLeft = ((touch.touches[0] as any)?.clientX || 0) < containerWidth / 2;
    if (isLeft) {
      skipTime(-10);
    } else {
      skipTime(10);
    }
  };

  // Resolve a backdrop/poster URL: supports full URL or TMDB poster_path starting with '/'
  const getImageUrl = (path?: string | null, size: 'w500' | 'w780' | 'w1280' | 'original' = 'w1280') => {
    if (!path) return undefined;
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return `https://image.tmdb.org/t/p/${size}${path}`;
    return path;
  };

  const shouldHideCursor =
    !isCasting &&
    isFullscreen &&
    isPlaying &&
    !showControls &&
    !showSettings &&
    !showCastMenu &&
    !showVolumeSlider &&
    !isDragging &&
    !showForwardAnimation &&
    !showRewindAnimation &&
    !showLeftTapAnimation &&
    !showRightTapAnimation;

  // Return the JSX element
  return (
    <div
      ref={containerRef}
      className={`relative group w-full h-full bg-black rounded-xl overflow-hidden ${isLoading ? 'aspect-[16/9]' : ''} video-container ${className} ${isFullscreenAnimating ? 'fullscreen-animating' : ''} select-none ${shouldHideCursor || isLocked ? 'cursor-none' : ''}`}
      onPointerMove={handleMouseMove}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && !showCastMenu && setShowControls(false)}
      onClick={handleVideoClick}
      onTouchStart={handleZoomTouchStart}
      onTouchMove={handleZoomTouchMove}
      onTouchEnd={handleZoomTouchEnd}
      onDoubleClick={handleDoubleTap}
    >
      {/* Cast Control Overlay - replaces HLS player when casting (Netflix-like) */}
      {isCasting && (
        <div
          className="absolute inset-0 z-[15000] flex flex-col items-center justify-center p-4 sm:p-6 bg-gray-900 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
          data-lenis-prevent
          style={{
            backgroundImage: backdrop ? `url(${getImageUrl(backdrop, 'original')})` : poster ? `url(${getImageUrl(poster, 'original')})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          {/* Cast Banner at the top */}
          <div className="absolute top-0 left-0 right-0 z-20 bg-black/95 shadow-lg">
            <div className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                </svg>
                <div className="flex flex-col">
                  <span className="text-white font-bold text-lg">{t('watch.castingInProgress')}</span>
                  <span className="text-white text-sm">{(() => {
                    if (castSession) {
                      const deviceName = castSession?.receiver?.friendlyName ||
                        castSession?.receiverFriendlyName ||
                        castSession?.receiver?.name ||
                        castSession?.receiver?.label ||
                        castSession?.deviceName ||
                        castSession?.name ||
                        'Chromecast';
                      return deviceName;
                    }
                    return 'Chromecast';
                  })()}</span>
                </div>
              </div>
              <button
                onClick={() => toggleCast()}
                className="text-white hover:text-gray-300 transition-colors duration-200"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Dim overlay over the backdrop (no blur) */}
          <div className="absolute inset-0 bg-black/60" />
          <div className="flex flex-col md:flex-row items-center gap-4 sm:gap-6 max-w-3xl w-full pt-16 sm:pt-20">
            {poster && (
              <div className="w-56 h-80 md:w-64 md:h-96 rounded-xl overflow-hidden shadow-2xl border border-white/10 relative z-10">
                <img src={getImageUrl(poster, 'w780')} alt={t('common.poster')} className="w-full h-full object-cover" />
              </div>
            )}
            <div className="flex-1 flex flex-col items-center md:items-start text-center md:text-left">
              <h2 className="text-white text-3xl md:text-4xl font-bold mb-2 line-clamp-2 drop-shadow-lg">
                {title || tvShow?.name || (movieId ? t('watch.movie') : tvShowId ? t('watch.series') : t('watch.content'))}
              </h2>
              {tvShowId != null && seasonNumber != null && episodeNumber != null && (
                <div className="mb-4">
                  <p className="text-white text-lg font-semibold bg-black/30 px-3 py-1 rounded-full border border-white/20 drop-shadow-lg">
                    {t('watch.seasonEpisodeLabel', { season: seasonNumber, episode: episodeNumber })}
                  </p>
                  {currentEpisodeInfo?.name && (
                    <p className="text-white text-base font-medium mt-2 bg-black/20 px-3 py-1 rounded-lg border border-white/10 drop-shadow-lg">
                      {shouldHide('episodeNames')
                        ? getMaskedContent(currentEpisodeInfo.name, 'episodeNames', undefined, episodeNumber)
                        : `${episodeNumber}. ${currentEpisodeInfo.name}`}
                    </p>
                  )}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:gap-4 relative z-10">
                {/* Reculer -10s */}
                <button
                  onClick={() => {
                    try {
                      const session: any = castSession as any;
                      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
                      if (!media) return;
                      const current = media.getEstimatedTime ? media.getEstimatedTime() : (media.currentTime || 0);
                      const target = Math.max(0, current - 10);
                      if ((window as any).chrome?.cast?.media) {
                        const req = new (window as any).chrome.cast.media.SeekRequest();
                        req.currentTime = target;
                        media.seek(req, () => { }, () => { });
                      } else if (typeof media.seek === 'function') {
                        media.seek(target, () => { }, () => { });
                      }
                    } catch (e) { console.error('Cast seek -10 failed', e); }
                  }}
                  className="inline-flex items-center gap-2 sm:gap-2 px-3 sm:px-4 py-3 sm:py-3 rounded-xl bg-black/40 text-white hover:bg-black/60 transition-all duration-200 border border-white/30 hover:border-white/50 font-semibold text-xs sm:text-sm shadow-lg backdrop-blur-sm min-w-0"
                  title={t('watch.rewind10s')}
                >
                  <Rewind className="w-5 h-5 sm:w-5 sm:h-5" />
                  <span className="hidden sm:inline">{t('watch.rewind10Short')}</span>
                </button>
                {/* Toggle Play/Pause (between -10s and +10s) */}
                <button
                  onClick={() => {
                    try {
                      const session: any = castSession as any;
                      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
                      if (!media) return;
                      const isPlayingCast = media?.playerState === 'PLAYING';
                      if (isPlayingCast) {
                        if (typeof media.pause === 'function') {
                          media.pause(null, () => { }, () => { });
                        } else if ((window as any).chrome?.cast?.media) {
                          const req = new (window as any).chrome.cast.media.PauseRequest();
                          media.pause(req, () => { }, () => { });
                        }
                      } else {
                        if (typeof media.play === 'function') {
                          media.play(null, () => { }, () => { });
                        } else if ((window as any).chrome?.cast?.media) {
                          const req = new (window as any).chrome.cast.media.PlayRequest();
                          media.play(req, () => { }, () => { });
                        }
                      }
                    } catch (e) { console.error('Cast toggle play/pause failed', e); }
                  }}
                  className="inline-flex items-center gap-2 sm:gap-2 px-5 sm:px-6 py-3 sm:py-3 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-all duration-200 border border-red-500 hover:border-red-400 font-bold text-sm sm:text-base shadow-xl backdrop-blur-sm min-w-0"
                  title={t('watch.playPause')}
                >
                  {(() => {
                    try {
                      const session: any = castSession as any;
                      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
                      const isPlayingCast = media?.playerState === 'PLAYING';
                      return isPlayingCast ? <Pause className="w-6 h-6 sm:w-5 sm:h-5" /> : <Play className="w-6 h-6 sm:w-5 sm:h-5" />;
                    } catch {
                      return <Play className="w-6 h-6 sm:w-5 sm:h-5" />;
                    }
                  })()}
                  <span className="hidden sm:inline">
                    {(() => {
                      try {
                        const session: any = castSession as any;
                        const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
                        const isPlayingCast = media?.playerState === 'PLAYING';
                        return isPlayingCast ? t('watch.pause') : t('watch.play');
                      } catch {
                        return t('watch.play');
                      }
                    })()}
                  </span>
                </button>

                {/* Avancer +10s (after play/pause) */}
                <button
                  onClick={() => {
                    try {
                      const session: any = castSession as any;
                      const media = session?.getMediaSession ? session.getMediaSession() : (Array.isArray(session?.media) ? session.media[0] : null);
                      if (!media) return;
                      const current = media.getEstimatedTime ? media.getEstimatedTime() : (media.currentTime || 0);
                      const target = Math.max(0, current + 10);
                      if ((window as any).chrome?.cast?.media) {
                        const req = new (window as any).chrome.cast.media.SeekRequest();
                        req.currentTime = target;
                        media.seek(req, () => { }, () => { });
                      } else if (typeof media.seek === 'function') {
                        media.seek(target, () => { }, () => { });
                      }
                    } catch (e) { console.error('Cast seek +10 failed', e); }
                  }}
                  className="inline-flex items-center gap-2 sm:gap-2 px-3 sm:px-4 py-3 sm:py-3 rounded-xl bg-black/40 text-white hover:bg-black/60 transition-all duration-200 border border-white/30 hover:border-white/50 font-semibold text-xs sm:text-sm shadow-lg backdrop-blur-sm min-w-0"
                  title={t('watch.forward10s')}
                >
                  <span className="hidden sm:inline">{t('watch.forward10Short')}</span>
                  <FastForward className="w-5 h-5 sm:w-5 sm:h-5" />
                </button>

              </div>

              {/* Cast Progress Bar */}
              <div className="mt-4 sm:mt-6 w-full relative z-30">
                <div className="flex items-center space-x-3 pointer-events-auto">
                  <div
                    className="group relative w-full h-8 sm:h-10 flex items-center cursor-pointer select-none cast-progress-bar"
                    data-media-time-slider=""
                    aria-label={t('watch.seekLabel')}
                    role="slider"
                    tabIndex={0}
                    {...({ autoComplete: "off" } as any)}
                    aria-disabled="false"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={(() => {
                      const currentDuration = castDuration || duration;
                      const currentTimeValue = castCurrentTime || currentTime;
                      return currentDuration > 0 ? Math.round((currentTimeValue / currentDuration) * 100) : 0;
                    })()}
                    aria-valuetext={`${formatTime(castCurrentTime || currentTime)} out of ${formatTime(castDuration || duration)}`}
                    aria-orientation="horizontal"
                    style={{
                      '--slider-progress': `${(() => {
                        const currentDuration = castDuration || duration;
                        const currentTimeValue = castCurrentTime || currentTime;
                        return currentDuration > 0 ? (currentTimeValue / currentDuration) * 100 : 0;
                      })()}%`,
                      '--slider-fill': `${(() => {
                        const currentDuration = castDuration || duration;
                        const currentTimeValue = castCurrentTime || currentTime;
                        return currentDuration > 0 ? (currentTimeValue / currentDuration) * 100 : 0;
                      })()}%`,
                      '--slider-pointer': `${(() => {
                        const currentDuration = castDuration || duration;
                        const currentTimeValue = castCurrentTime || currentTime;
                        return currentDuration > 0 ? (currentTimeValue / currentDuration) * 100 : 0;
                      })()}%`
                    } as React.CSSProperties}
                    onClick={handleCastProgressClick}
                    onMouseDown={handleCastProgressDragStart}
                    onTouchStart={handleCastProgressTouchStart}
                    onTouchMove={handleCastProgressTouchMove}
                    onTouchEnd={handleCastProgressTouchEnd}
                    onMouseEnter={() => {
                      const element = document.querySelector('.cast-progress-bar');
                      if (element) {
                        element.setAttribute('data-pointing', 'true');
                      }
                    }}
                    onMouseLeave={() => {
                      const element = document.querySelector('.cast-progress-bar');
                      if (element) {
                        element.removeAttribute('data-pointing');
                      }
                    }}
                  >
                    <div className="relative w-full bg-gray-500/25 rounded-full transition-[height] duration-100 h-1.5">
                      <div
                        className="absolute top-0 left-0 h-full bg-gray-500/25 rounded-full"
                        style={{ width: 'var(--slider-progress)' }}
                      />
                      <div
                        className="absolute top-0 left-0 h-full bg-red-500 rounded-full"
                        style={{ width: 'var(--slider-fill)' }}
                      />
                      <div
                        className="absolute top-1/2 rounded-full bg-white border border-white/50 shadow-md transition-opacity duration-150 -translate-x-1/2 -translate-y-1/2 group-data-[dragging]:opacity-100 opacity-100 w-4 h-4 sm:w-5 sm:h-5"
                        style={{ left: 'var(--slider-fill)' }}
                      />
                      <div
                        className="absolute bottom-full mb-2.5 opacity-0 transition-opacity duration-200 group-data-[pointing]:opacity-100 pointer-events-none"
                        style={{
                          position: 'absolute',
                          left: 'min(max(0px, calc(var(--slider-pointer) - 30.45px)), calc(100% - 60.9px))',
                          width: 'max-content',
                          bottom: 'calc(100% + var(--media-slider-preview-offset, 0px))'
                        }}
                      >
                        <div className="px-2 py-1.5 text-sm sm:px-3 sm:py-2 sm:text-base font-bold bg-black/80 backdrop-blur-sm text-white rounded-lg whitespace-nowrap shadow-xl border border-white/20">
                          {formatTime(isCastDragging ? castDragTime : (castCurrentTime || currentTime))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4 sm:mt-6 text-white text-sm sm:text-lg font-bold bg-black/40 px-3 sm:px-4 py-2 rounded-xl border border-white/20 backdrop-blur-sm shadow-lg relative z-30 sticky bottom-4 sm:static">
                {formatTime(isCastDragging ? castDragTime : (castCurrentTime || currentTime))} / {formatTime(castDuration || duration)}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Video Player Element with zoom transform */}
      {!isCasting && (
        <div
          ref={videoWrapperRef}
          className="w-full h-full relative"
          style={{
            transformOrigin: 'center center',
            willChange: 'transform'
          }}
        >
          <video
            ref={videoRef}
            className={`w-full h-full ${getVideoObjectFitClass()} ${className} ${!isPlaying ? 'grayscale' : ''} subtitles-disabled transition-all duration-500 ${isFullscreenAnimating ? 'z-[9999] scale-[1.04] grayscale bg-black' : ''} ${shouldHideCursor ? 'cursor-none' : ''}`}
            style={{
              filter: !isPlaying ? undefined : (videoOledMode !== 'off' ? getVideoOledFilter() : undefined),
              transition: 'filter 0.5s ease'
            }}
            playsInline
            // Required so MediaElementAudioSourceNode (volume booster + audio enhancer)
            // doesn't output silence on cross-origin proxied media. All proxies return
            // Access-Control-Allow-Origin: *, so the request still succeeds.
            crossOrigin="anonymous"
            {...{ referrerPolicy: "strict-origin-when-cross-origin" } as React.VideoHTMLAttributes<HTMLVideoElement>}
            poster={poster}
            onTimeUpdate={handleTimeUpdate}
            preload="auto"
            x-webkit-airplay="allow"
            disableRemotePlayback={false}
          >
            {/* Source elements for AirPlay compatibility - allows native playback */}
            {src && src.includes('.m3u8') && (
              <source src={src} type="application/x-mpegURL" />
            )}
            {src && !isMP4Source(src) && (
              <source src={src} type="video/mp4" />
            )}
            {t('watch.browserNotSupported')}
            {subtitleUrl && (
              <track
                kind="subtitles"
                src={subtitleUrl}
                srcLang="fr"
                label={t('watch.french')}
                default
              />
            )}
          </video>
        </div>
      )}

      {/* PiP Overlay - displays when in Picture-in-Picture mode */}
      {isPipActive && (
        <div
          className="absolute inset-0 z-[14000] flex flex-col items-center justify-center p-4 sm:p-6 bg-gray-900 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
          data-lenis-prevent
          style={{
            backgroundImage: pipBackdropImage ? `linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.9)), url(${pipBackdropImage})` : backdrop ? `linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.9)), url(https://image.tmdb.org/t/p/w1280${backdrop})` : poster ? `linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.9)), url(https://image.tmdb.org/t/p/w1280${poster})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          {/* PiP Banner at the top */}
          <div className="absolute top-0 left-0 right-0 z-20 bg-black/95 shadow-lg">
            <div className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 7h-8v6h8V7zm2-4H3C1.9 3 1 3.9 1 5v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z" />
                </svg>
                <div className="flex flex-col">
                  <span className="text-white font-bold text-lg">{t('watch.pipModeTitle')}</span>
                  <span className="text-white text-sm">{t('watch.videoPlaying')}</span>
                </div>
              </div>
              <button
                onClick={() => togglePip()}
                className="text-white hover:text-gray-300 transition-colors duration-200"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Content Info */}
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
            <div className="bg-black/60 backdrop-blur-md rounded-2xl p-6 max-w-md w-full">
              <h2 className="text-white text-2xl font-bold mb-2">
                {title || (tvShow ? tvShow.name : t('watch.content'))}
              </h2>
              {currentEpisodeInfo && (
                <p className="text-gray-300 text-lg mb-4">
                  {t('watch.seasonEpisodeDash', { season: seasonNumber, episode: episodeNumber })}
                </p>
              )}
              <div className="flex items-center justify-center gap-4 text-sm text-gray-400">
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                  </svg>
                  {isPlaying ? t('watch.playing') : t('watch.paused')}
                </span>
              </div>
            </div>
          </div>

          {/* Basic Controls */}
          <div className="absolute bottom-0 left-0 right-0 z-20 bg-black/95">
            <div className="flex items-center justify-center gap-6 px-6 py-6">
              <button
                onClick={() => skipTime(-10)}
                className="text-white hover:text-gray-300 transition-colors duration-200 p-4 bg-black/40 rounded-full hover:bg-black/60"
                title={t('watch.rewind10s')}
              >
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.334 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
                </svg>
              </button>

              <button
                onClick={togglePlay}
                className="text-white hover:text-gray-300 transition-colors duration-200 p-6 bg-black/40 rounded-full hover:bg-black/60"
                title={isPlaying ? t('watch.pause') : t('watch.play')}
              >
                {isPlaying ? (
                  <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => skipTime(10)}
                className="text-white hover:text-gray-300 transition-colors duration-200 p-4 bg-black/40 rounded-full hover:bg-black/60"
                title={t('watch.forward10s')}
              >
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6L14.6 7.2A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Zoom indicator - top center with reset button */}
      {zoomState.isZoomed && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8, y: -20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: -20 }}
          className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black/90 backdrop-blur-sm text-white px-4 py-3 rounded-xl z-50 shadow-2xl border border-white/20 flex items-center gap-3"
        >
          <span className="text-lg font-bold">{t('watch.zoomValue', { value: Math.round(zoomState.scale * 100) })}</span>
          <button
            onClick={resetZoom}
            className="bg-red-600 hover:bg-red-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {t('common.reset')}
          </button>
        </motion.div>
      )}

      {/* Touch Left Tap Animation - Crunchyroll style overlay */}
      <AnimatePresence>
        {showLeftTapAnimation && isTouchDevice && (
          <motion.div
            key="left-tap-animation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute left-0 top-0 bottom-0 z-50 pointer-events-none"
            data-media-gesture=""
            style={{ pointerEvents: 'none', width: '30%' }}
          >
            <div className="absolute inset-0 m-2 rounded-2xl bg-white/15 backdrop-blur-[2px] flex items-center justify-center">
              <motion.span
                key={leftTapCount}
                initial={{ scale: 0.9 }}
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 0.25 }}
                className="text-white text-xl font-bold select-none"
              >
                -{leftTapCount * 10}
              </motion.span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Touch Right Tap Animation - Crunchyroll style overlay */}
      <AnimatePresence>
        {showRightTapAnimation && isTouchDevice && (
          <motion.div
            key="right-tap-animation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute right-0 top-0 bottom-0 z-50 pointer-events-none"
            data-media-gesture=""
            style={{ pointerEvents: 'none', width: '30%' }}
          >
            <div className="absolute inset-0 m-2 rounded-2xl bg-white/15 backdrop-blur-[2px] flex items-center justify-center">
              <motion.span
                key={rightTapCount}
                initial={{ scale: 0.9 }}
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 0.25 }}
                className="text-white text-xl font-bold select-none"
              >
                +{rightTapCount * 10}
              </motion.span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PiP Error Toast Notification */}
      <AnimatePresence>
        {pipError && (
          <motion.div
            key="pip-error"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg z-50 flex items-center"
          >
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{pipError}</span>
          </motion.div>
        )}
      </AnimatePresence>


      {/* Custom subtitle renderer with dynamic styling */}
      {subtitleContainerVisible && (
        <div className={`absolute ${showControls ? 'bottom-24' : 'bottom-10'} transition-all duration-300 left-0 right-0 flex flex-col items-center justify-center pointer-events-none`}>
          <div
            className="px-4 py-2 rounded text-center max-w-[90%] subtitle-container"
            style={getSubtitleBackgroundStyle()}
          >
            {activeSubtitleCues.map((cue, index) => {
              // Process subtitle text to handle dialogues with line breaks
              const escapeHtml = (str: string): string =>
                str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

              const processSubtitleText = (text: string): string => {
                const lines = text.split('\n');
                const processedLines = lines
                  .map(line => line.trim())
                  .filter(line => line.length > 0)
                  // Escape for XSS safety, then restore i/b/u formatting tags
                  // (VTT/SRT italic/bold/underline) so they render instead of
                  // showing as literal <i>…</i>.
                  .map(line => escapeHtml(line)
                    .replace(/&lt;(\/?)([biu])(?:\.[^&\s]*)?&gt;/gi, '<$1$2>'));
                return processedLines.join('<br>');
              };

              const displayText = (translationLang && translatedCueTexts.get(cue.text)) || cue.text;

              return (
                <div
                  key={index}
                  className="font-medium"
                  style={{ ...getSubtitleFontSizeStyle(), ...getSubtitleTextColorStyle() }}
                  dangerouslySetInnerHTML={{ __html: processSubtitleText(displayText) }}
                />
              );
            })}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          {backdrop && videoRef.current?.readyState === 0 && (
            <div className="relative w-full h-full flex items-center justify-center">
              <img
                src={backdrop}
                alt={t('common.backdrop')}
                className="w-full h-full object-cover max-w-full"
              />
              <div className="absolute inset-0 bg-black/60" />
            </div>
          )}
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
          </div>
          <div className="absolute left-0 right-0 bottom-20 z-10 flex justify-center pointer-events-none">
            <p className="text-sm text-gray-300 text-center px-4 bg-black/50 rounded-lg py-2">
              {t('watch.loadingTip')}
            </p>
          </div>
        </div>
      )}

      {/* Message d'erreur 403 */ }
      {show403Error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-[9000]" style={{ pointerEvents: 'auto' }}>
          {/* Bouton retour en cas d'erreur */}
          <button
            onClick={() => navigate(-1)}
            className="absolute top-4 left-4 z-[9001] flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('watch.back')}
          </button>

          <div className="bg-gray-900/90 p-8 rounded-xl border border-red-500/50 max-w-lg text-center backdrop-blur-sm shadow-2xl relative">
            <div className="mx-auto w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-4 animate-pulse">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">{t('watch.error403')}</h3>
            <p className="text-gray-300 mb-6 font-medium">
              {t('watch.accessDenied')}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onShowSources) {
                  onShowSources();
                } else {
                  // Fallback: dispatch event to show sources
                  window.dispatchEvent(new CustomEvent('showSourcesMenu'));
                }
              }}
              className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-all transform hover:scale-105 shadow-lg flex items-center justify-center mx-auto gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7zM4 7a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1zM2 11a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z" />
              </svg>
              {t('watch.changePlayer')}
            </button>
          </div>
        </div>
      )}

      {/* Animation de lecture */}
      <motion.div
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: showPlayAnimation ? 1 : 0, scale: showPlayAnimation ? 1 : 0.3 }}
        className="absolute inset-0 flex items-center justify-center z-50"
      >
        <div className="bg-black/60 rounded-full p-6">
          <Play size={48} className="text-white" />
        </div>
      </motion.div>

      {/* Animation de pause */}
      <motion.div
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: showPauseAnimation ? 1 : 0, scale: showPauseAnimation ? 1 : 0.3 }}
        className="absolute inset-0 flex items-center justify-center z-50"
      >
        <div className="bg-black/60 rounded-full p-6">
          <Pause size={48} className="text-white" />
        </div>
      </motion.div>

      {/* Animation d'avance rapide */}
      <AnimatePresence>
        {showForwardAnimation && (
          <motion.div
            initial={{ opacity: 0, scale: 0.3, x: 60 }}
            animate={{
              opacity: 1,
              scale: 1,
              x: 0
            }}
            exit={{ opacity: 0, scale: 0.3, x: 60 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-end pr-[15%] z-50 pointer-events-none"
          >
            <motion.div
              className="bg-black/95 rounded-3xl p-5 md:p-6 flex flex-col items-center shadow-2xl border border-white/30 min-w-[110px] md:min-w-[130px]"
              animate={{
                scale: [1, 1.05, 1],
              }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
            >
              <FastForward size={window.innerWidth < 768 ? 44 : 52} className="text-white mb-1" />
              <motion.span
                className="text-white text-lg md:text-xl font-bold tracking-wide"
                key={forwardClickCount}
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 0.2 }}
              >
                +{forwardClickCount * 10}s
              </motion.span>
              <div className="w-full h-1 bg-white/25 rounded-full mt-2">
                <motion.div
                  className="h-full bg-white rounded-full"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Animation de retour rapide */}
      <AnimatePresence>
        {showRewindAnimation && (
          <motion.div
            initial={{ opacity: 0, scale: 0.3, x: -60 }}
            animate={{
              opacity: 1,
              scale: 1,
              x: 0
            }}
            exit={{ opacity: 0, scale: 0.3, x: -60 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-start pl-[15%] z-50 pointer-events-none"
          >
            <motion.div
              className="bg-black/95 rounded-3xl p-5 md:p-6 flex flex-col items-center shadow-2xl border border-white/30 min-w-[110px] md:min-w-[130px]"
              animate={{
                scale: [1, 1.05, 1],
              }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
            >
              <Rewind size={window.innerWidth < 768 ? 44 : 52} className="text-white mb-1" />
              <motion.span
                className="text-white text-lg md:text-xl font-bold tracking-wide"
                key={rewindClickCount}
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 0.2 }}
              >
                -{rewindClickCount * 10}s
              </motion.span>
              <div className="w-full h-1 bg-white/25 rounded-full mt-2">
                <motion.div
                  className="h-full bg-white rounded-full"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Nouveaux boutons de contrôle au centre */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, scale: 0.7, y: 20 }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{ opacity: 0, scale: 0.7, y: 20 }}
            transition={{
              duration: 0.2,
              ease: "easeOut"
            }}
            className="absolute inset-0 flex items-center justify-center gap-8 z-50 pointer-events-none"
          >
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                skipTime(-10);
              }}
              initial={{ rotate: 0 }}
              whileHover={{
                scale: 1.18,
                backgroundColor: "rgba(0, 0, 0, 0.85)",
                rotate: -5
              }}
              whileTap={{
                scale: 0.92,
                rotate: -10
              }}
              transition={{ duration: 0.1 }}
              className="bg-black/70 rounded-full p-7 text-white transition-colors shadow-lg pointer-events-auto"
            >
              <Rewind size={56} />
            </motion.button>
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                e.stopPropagation();
                togglePlay();
              }}
              initial={{ scale: 1 }}
              whileHover={{
                scale: 1.25,
                backgroundColor: "rgba(0, 0, 0, 0.85)",
                boxShadow: "0 0 32px rgba(255, 255, 255, 0.3)"
              }}
              whileTap={{
                scale: 0.9,
                rotate: 5
              }}
              transition={{ duration: 0.1 }}
              className="bg-black/70 rounded-full p-8 text-white transition-colors shadow-xl pointer-events-auto"
            >
              {isPlaying ? <Pause size={64} /> : <Play size={64} />}
            </motion.button>
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                skipTime(10);
              }}
              initial={{ rotate: 0 }}
              whileHover={{
                scale: 1.18,
                backgroundColor: "rgba(0, 0, 0, 0.85)",
                rotate: 5
              }}
              whileTap={{
                scale: 0.92,
                rotate: 10
              }}
              transition={{ duration: 0.1 }}
              className="bg-black/70 rounded-full p-7 text-white transition-colors shadow-lg pointer-events-auto"
            >
              <FastForward size={56} />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {!isCasting && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: showControls ? 1 : 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent"
        />)}

      {!isCasting && (hoverState.time !== null && (showControls || isDragging)) && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 10 }}
          animate={{ opacity: 1, scale: isDragging ? 0.95 : 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 10 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="absolute bottom-24 bg-black rounded-lg overflow-hidden shadow-2xl z-50 border border-gray-700 pointer-events-none flex flex-col"
          style={previewStyle}
        >
          {/* Toujours afficher la miniature vidéo + le temps, même en drag */}
          <div className="relative w-48 h-28 bg-gray-900">
            {hoverState.showPreview && hoverState.previewUrl && (
              <video
                ref={previewVideoRef}
                className="w-full h-full object-cover"
                muted
                autoPlay
                playsInline
                {...{ referrerPolicy: "strict-origin-when-cross-origin" } as React.VideoHTMLAttributes<HTMLVideoElement>}
                onCanPlay={() => setLoadingPreview(false)}
                onWaiting={() => setLoadingPreview(true)}
              />
            )}
            {loadingPreview && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                <Loader2 className="w-6 h-6 animate-spin text-white" />
              </div>
            )}
          </div>
          <div className="bg-black/80 w-full text-center py-1">
            <p className="text-white text-sm font-medium">
              {formatTime(hoverState.time)}
            </p>
          </div>
        </motion.div>
      )}

      {/* Back to Info Button */}
      <motion.button
        onClick={handleBackToInfo}
        initial={{ opacity: 0, y: -20 }}
        animate={{
          opacity: showControls ? 1 : 0,
          y: showControls ? 0 : -20
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
        whileTap={{ scale: 0.95 }}
        style={{ pointerEvents: showControls ? 'auto' : 'none' }}
        aria-hidden={!showControls}
        tabIndex={showControls ? 0 : -1}
        className="absolute top-4 left-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        {t('watch.back')}
      </motion.button>

      {/* Next Episode Button */}
      {nextEpisode && onNextEpisode && (
        <motion.div
          className="absolute top-4 right-4 z-50 flex items-center gap-2"
          initial={{ opacity: 0, y: -20 }}
          animate={{
            opacity: showControls ? 1 : 0,
            y: showControls ? 0 : -20
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          style={{ pointerEvents: showControls ? 'auto' : 'none' }}
          aria-hidden={!showControls}
        >
          {/* Previous Episode Button - hide if at first episode of first season */}
          {!(seasonNumber === 1 && episodeNumber === 1) && (
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                // Appeler le callback parent
                if (onPreviousEpisode) {
                  onPreviousEpisode();
                }
              }}
              whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
              <span>
                {(episodeNumber && episodeNumber > 1) ?
                  `S${seasonNumber || 1}:${String((episodeNumber || 1) - 1).padStart(2, '0')}` :
                  (seasonNumber && seasonNumber > 1 ?
                    `S${(seasonNumber || 1) - 1}:01` :
                    `S1:01`)}
              </span>
            </motion.button>
          )}

          {/* Episodes Button */}
          <motion.button
            onClick={(e) => {
              e.stopPropagation();
              console.log('Episodes button clicked. Episodes available:', episodes?.length || 0);
              console.log('onShowEpisodesMenu available:', !!onShowEpisodesMenu);
              console.log('tvShowId:', tvShowId);

              // En mode anime (tvShowId présent), toujours utiliser le fallback externe
              if (tvShowId && onShowEpisodesMenu) {
                console.log('Using external episodes menu for anime');
                onShowEpisodesMenu();
              }
              // Pour les séries normales, utiliser le menu interne si disponible
              else if (episodes && episodes.length > 0) {
                console.log('Using internal episodes menu');
                setShowInternalEpisodesMenu(!showInternalEpisodesMenu);
              }
              // Fallback vers l'ancien système
              else if (onShowEpisodesMenu) {
                console.log('Using fallback external episodes menu');
                onShowEpisodesMenu();
              }
              else {
                console.log('No episodes menu available');
              }
            }}
            whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <span className="hidden sm:inline">{t('watch.episodes')}</span>
          </motion.button>

          <motion.button
            onClick={(e) => {
              e.stopPropagation();
              if (nextEpisode.seasonNumber && nextEpisode.episodeNumber) {
                onNextEpisode(nextEpisode.seasonNumber, nextEpisode.episodeNumber);
              }
            }}
            whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
          >
            <span>S{nextEpisode.seasonNumber || 1}:{String(nextEpisode.episodeNumber || 1).padStart(2, '0')}</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
            </svg>
          </motion.button>
        </motion.div>
      )}

      {/* Sources Button (Top Right, below navigation) */}
      {onShowSources && (
        <motion.button
          onClick={onShowSources}
          initial={{ opacity: 0, y: -20 }}
          animate={{
            opacity: showControls ? 1 : 0,
            y: showControls ? 0 : -20
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
          whileTap={{ scale: 0.95 }}
          style={{ pointerEvents: showControls ? 'auto' : 'none' }}
          aria-hidden={!showControls}
          tabIndex={showControls ? 0 : -1}
          className="absolute top-16 right-2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg bg-black/70 backdrop-blur-sm border border-gray-700 text-white font-medium text-sm shadow-lg border-opacity-50"
        >
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span>{t('watch.sources')}</span>
        </motion.button>
      )}

      {/* Informations sur le contenu en haut à gauche - move this down to make room for back button */}
      <motion.div
        className="absolute top-16 left-0 p-4 flex items-center gap-3 z-40"
        initial={{ opacity: 0, y: -20 }}
        animate={{
          opacity: showControls ? 1 : 0,
          y: showControls ? 0 : -20
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ pointerEvents: showControls ? 'auto' : 'none' }}
        aria-hidden={!showControls}
      >
        {poster && (
          <div className="h-20 w-14 rounded overflow-hidden shadow-md">
            <img
              src={poster}
              alt={t('common.poster')}
              className="h-full w-full object-cover"
            />
          </div>
        )}
        <div className="flex flex-col text-white">
          <h3 className="text-sm md:text-base font-bold line-clamp-1">
            {title || tvShow?.name || (movieId ? t('watch.movie') : tvShowId ? t('watch.series') : "")}
          </h3>
          {tvShowId != null && seasonNumber != null && episodeNumber != null && (
            // `!= null` au lieu de truthy : `{0 && <p/>}` rend le 0 brut dans le DOM
            // (un littéral "0" apparaît entre le titre et la durée pour les Spéciaux S0).
            <p className="text-xs text-gray-300">
              {t('watch.seasonEpisodeLabel', { season: seasonNumber, episode: episodeNumber })}
            </p>
          )}
          <p className="text-xs text-gray-300">
            {formatTime(currentTime)} / {formatTime(duration)}
          </p>
        </div>
      </motion.div>
      {controls && !isCasting && (
        <motion.div
          className="absolute bottom-0 left-0 right-0 p-4 control-bar"
          initial={{ opacity: 0, y: 20 }}
          animate={{
            opacity: showControls ? 1 : 0,
            y: showControls ? 0 : 20
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          style={{ pointerEvents: showControls || isDragging ? 'auto' : 'none' }}
          aria-hidden={!showControls}
        >
          <div
            ref={progressBarRef}
            className={`relative h-4 md:h-3 bg-gray-600/50 rounded-full mb-2 md:mb-4 group progress-bar ${!isWatchPartyGuest ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
            onClick={!isDragging && !isWatchPartyGuest ? handleProgressClick : undefined}
            onMouseDown={!isWatchPartyGuest ? handleProgressDragStart : undefined}
            onTouchStart={!isWatchPartyGuest ? (e) => {
              handleProgressDragStart(e);
              e.stopPropagation(); // Éviter le déclenchement du clic vidéo
            } : undefined}
            onMouseMove={!isWatchPartyGuest ? handleProgressHover : undefined}
            onMouseLeave={!isWatchPartyGuest ? handleProgressLeave : undefined}
          >
            <div
              className="absolute h-full bg-gray-600/50 rounded-full"
              style={{ width: `${getBufferedWidth()}%` }}
            />
            <div
              className="absolute h-full bg-red-600 rounded-full"
              style={{ width: `${(currentTime / duration) * 100}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-red-600 rounded-full -ml-2"
              style={{ left: `${(currentTime / duration) * 100}%` }}
            />
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 md:gap-4 flex-1 min-w-0">
              <div className="flex items-center gap-1 md:gap-2">
                <button
                  onClick={!isWatchPartyGuest ? togglePlay : undefined}
                  onTouchEnd={!isWatchPartyGuest ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    togglePlay();
                  } : undefined}
                  className={`text-white transition-colors ${!isWatchPartyGuest ? 'hover:text-gray-300' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={isWatchPartyGuest}
                  aria-disabled={isWatchPartyGuest}
                >
                  {isPlaying ? <Pause size={isMobile ? 20 : 24} /> : <Play size={isMobile ? 20 : 24} />}
                </button>
                <button
                  onClick={!isWatchPartyGuest ? () => skipTime(-10) : undefined}
                  className={`text-white transition-colors ${!isWatchPartyGuest ? 'hover:text-gray-300' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={isWatchPartyGuest}
                  aria-disabled={isWatchPartyGuest}
                >
                  <Rewind size={isMobile ? 20 : 24} />
                </button>
                <button
                  onClick={!isWatchPartyGuest ? () => skipTime(10) : undefined}
                  className={`text-white transition-colors ${!isWatchPartyGuest ? 'hover:text-gray-300' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={isWatchPartyGuest}
                  aria-disabled={isWatchPartyGuest}
                >
                  <FastForward size={isMobile ? 20 : 24} />
                </button>
                <div className="relative group flex items-center h-[24px] mr-4">
                  <div className="flex items-center group/volume h-full">
                    <button
                      onClick={handleMuteToggle} // Use the updated handler
                      className="text-white hover:text-gray-300 transition-colors flex items-center justify-center h-full"
                    >
                      {/* Icon logic should check videoRef.current.muted */}
                      {videoRef.current?.muted || volume === 0 ? (
                        <VolumeX size={isMobile ? 20 : 24} />
                      ) : volume < 0.5 ? (
                        <Volume1 size={isMobile ? 20 : 24} />
                      ) : (
                        <Volume2 size={isMobile ? 20 : 24} />
                      )}
                    </button>

                    <div className={`
                      overflow-hidden transition-all duration-200 flex items-center h-full
                      ${isMobile && !isFullscreen ? 'w-0' : 'ml-2 w-[112px]'}
                      ${!isMobile && !isFullscreen ? 'w-0 group-hover/volume:w-[112px]' : ''}
                    `}>
                      <div className="w-[100px] mx-[6px] flex items-center h-full">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={volume} // Keep slider value controlled by state
                          onChange={handleVolumeChange} // Use updated handler
                          className="w-full accent-red-600 appearance-none h-1 rounded-full"
                          style={{
                            background: `linear-gradient(to right, #dc2626 ${volume * 100}%, rgba(255, 255, 255, 0.2) ${volume * 100}%)`
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-white text-xs md:text-sm whitespace-nowrap min-w-[85px]">
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            </div>

            <div className="flex items-center gap-2 md:gap-4">
              <div className="relative flex items-center h-[24px]">
                <button
                  onClick={toggleWatchParty}
                  className="text-white hover:text-red-600 transition-colors flex items-center justify-center"
                  aria-label={t('watch.watchParty')}
                >
                  <motion.div
                    animate={{
                      scale: isWatchPartyActive ? 0.85 : 1,
                      color: isWatchPartyActive ? '#dc2626' : '#ffffff'
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{
                      duration: 0.2,
                      ease: "easeInOut"
                    }}
                  >
                    <Users size={isMobile ? 20 : 24} />
                  </motion.div>
                </button>
              </div>
              <div className="relative flex items-center h-[24px]">
                <button
                  onClick={togglePip}
                  className="text-white hover:text-red-600 transition-colors flex items-center justify-center"
                  aria-label={t('watch.pictureInPicture')}
                >
                  <motion.div
                    animate={{
                      scale: isPipActive ? 0.85 : 1,
                      color: isPipActive ? '#dc2626' : '#ffffff'
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{
                      duration: 0.2,
                      ease: "easeInOut"
                    }}
                  >
                    <PictureInPicture size={isMobile ? 20 : 24} />
                  </motion.div>
                </button>
              </div>
              <div className="relative flex items-center h-[24px]">
                <button
                  onClick={toggleLoop}
                  className="text-white hover:text-red-600 transition-colors flex items-center justify-center"
                  aria-label={t('watch.loopPlayback')}
                >
                  <motion.div
                    animate={{
                      scale: isLooping ? 0.85 : 1,
                      color: isLooping ? '#dc2626' : '#ffffff'
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{
                      duration: 0.2,
                      ease: "easeInOut"
                    }}
                  >
                    <Repeat size={isMobile ? 20 : 24} />
                  </motion.div>
                </button>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  enterLockMode();
                }}
                className="text-white hover:text-red-600 transition-colors flex items-center justify-center h-[24px]"
                aria-label={t('watch.lockControls')}
                title={t('watch.lockControls')}
              >
                <Lock size={isMobile ? 20 : 24} />
              </button>
              <div className="relative flex items-center h-[24px]">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-white hover:text-red-600 transition-colors flex items-center justify-center"
                >
                  <motion.div
                    animate={{
                      rotate: showSettings ? 180 : 0
                    }}
                    transition={{
                      duration: 0.3,
                      ease: "easeInOut"
                    }}
                  >
                    <Settings size={isMobile ? 20 : 24} />
                  </motion.div>
                </button>
              </div>
              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-red-600 transition-colors flex items-center justify-center h-[24px]"
              >
                {isFullscreen ?
                  <Minimize size={isMobile ? 20 : 24} /> :
                  <Maximize size={isMobile ? 20 : 24} />
                }
              </button>
              {/* Smart Cast/AirPlay Button - Always visible */}
              <div className="relative flex items-center h-[24px]">
                  {castAvailable && !isTouchDevice && !airPlayAvailable && !isCasting ? (
                    <motion.div
                      animate={{ scale: 1, color: '#ffffff' }}
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      transition={{
                        duration: 0.2,
                        ease: "easeInOut"
                      }}
                    >
                      <google-cast-launcher
                        ref={(node) => {
                          castButtonRef.current = node as HTMLElement | null;
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowControls(true);
                          setShowCastMenu(false);
                        }}
                        className="block cursor-pointer"
                        title={t('watch.cast')}
                        style={{
                          display: 'inline-flex',
                          width: `${isMobile ? 20 : 24}px`,
                          height: `${isMobile ? 20 : 24}px`,
                          maxWidth: `${isMobile ? 20 : 24}px`,
                          maxHeight: `${isMobile ? 20 : 24}px`,
                          overflow: 'hidden',
                          ['--connected-color' as any]: '#dc2626',
                          ['--disconnected-color' as any]: '#ffffff'
                        }}
                      />
                    </motion.div>
                  ) : (
                    <button
                      ref={(node) => {
                        castButtonRef.current = node;
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowControls(true);

                        if (isCasting) {
                          toggleCast();
                          setShowCastMenu(false);
                          return;
                        }

                        if (isAirPlaying) {
                          toggleAirPlay();
                          setShowCastMenu(false);
                          return;
                        }

                        // Neither target detected — open the menu so the user
                        // gets feedback (status, tips, error) instead of a
                        // silent no-op.
                        if (!castAvailable && !airPlayAvailable) {
                          setCastError(null);
                          setAirPlayError(null);
                          setShowCastMenu(true);
                          return;
                        }

                        if (airPlayAvailable && !castAvailable) {
                          toggleAirPlay();
                        } else {
                          toggleCast();
                        }

                        setShowCastMenu(false);
                      }}
                      className="text-white hover:text-red-600 transition-colors flex items-center justify-center"
                      aria-label={airPlayAvailable && !castAvailable ? t('watch.airplay') : castAvailable && !airPlayAvailable ? t('watch.cast') : t('watch.streamTo')}
                    >
                      <motion.div
                        animate={{
                          scale: (isAirPlaying || isCasting) ? 0.85 : 1,
                          color: (isAirPlaying || isCasting) ? '#dc2626' : '#ffffff'
                        }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        transition={{
                          duration: 0.2,
                          ease: "easeInOut"
                        }}
                      >
                        {/* Show AirPlay icon if only AirPlay is available, Cast if only Cast is available, or Cast if both are available */}
                        {airPlayAvailable && !castAvailable ? (
                          <Airplay size={isMobile ? 20 : 24} />
                        ) : (
                          <Cast size={isMobile ? 20 : 24} />
                        )}
                      </motion.div>
                    </button>
                  )}

                  {/* Smart Menu - Shows AirPlay or Cast based on availability */}
                  {showCastMenu && (
                    <motion.div
                      onClick={(e) => e.stopPropagation()}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute bottom-full right-0 mb-2 bg-black/95 border border-gray-700 rounded-lg shadow-xl p-3 min-w-[250px] z-50 cast-menu"
                    >
                      <div className="text-white text-sm font-medium mb-2">
                        {airPlayAvailable && !castAvailable ? t('watch.airplayTo') :
                          castAvailable && !airPlayAvailable ? t('watch.castTo') :
                            t('watch.streamTo')}
                      </div>

                      {/* Message préventif explicatif — masqué si rien n'est disponible,
                          l'encart jaune plus bas prend le relais avec un message clair. */}
                      {(airPlayAvailable || castAvailable) && (
                        <div className="mb-3 p-2 bg-blue-900/30 border border-blue-700/50 rounded text-xs text-blue-200">
                          <div className="font-medium mb-1">⚠️ {t('watch.importantInfo')}</div>
                          {airPlayAvailable && !castAvailable ? (
                            <>
                              <div>• {t('watch.airplayAvailableApple')}</div>
                              <div>• {t('watch.ensureSameWifi')}</div>
                            </>
                          ) : castAvailable && !airPlayAvailable ? (
                            <>
                              <div>• {t('watch.castAutoFrench')}</div>
                              <div>• {t('watch.featureInDevelopment')}</div>
                            </>
                          ) : (
                            <>
                              <div>• {t('watch.chooseStreamMethod')}</div>
                              <div>• {t('watch.airplayForAppleCastForChromecast')}</div>
                            </>
                          )}
                          <div>• {t('watch.someSourcesIncompatible')}</div>
                        </div>
                      )}

                      {/* Show appropriate options based on availability */}
                      {airPlayAvailable && !castAvailable ? (
                        // AirPlay only
                        <div className="space-y-2">
                          <button
                            onClick={() => toggleAirPlay()}
                            disabled={isAirPlayLoading}
                            className={`w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 rounded transition-colors flex items-center gap-2 ${isAirPlayLoading ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                          >
                            {isAirPlayLoading ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>{t('watch.connecting')}</span>
                              </>
                            ) : (
                              <>
                                <span>📱</span>
                                <span>{t('watch.airplay')}</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : castAvailable && !airPlayAvailable ? (
                        // Cast only
                        <div className="space-y-2">
                          <button
                            onClick={() => startCasting()}
                            disabled={isCastLoading}
                            className={`w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 rounded transition-colors flex items-center gap-2 ${isCastLoading ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                          >
                            {isCastLoading ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>{t('watch.connecting')}</span>
                              </>
                            ) : (
                              <>
                                <span>📺</span>
                                <span>{t('watch.cast')}</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : !airPlayAvailable && !castAvailable ? (
                        // Neither target detected — distinguish "browser doesn't support cast at all"
                        // (Firefox / Edge non-Chromium / Safari without AirPlay element) from
                        // "browser supports it but nothing on the LAN / SDK blocked by adblock".
                        (() => {
                          const browserSupportsCast = typeof (window as any).chrome?.cast !== 'undefined';
                          const browserSupportsAirPlay = isAirPlaySupported();
                          const browserSupportsAny = browserSupportsCast || browserSupportsAirPlay;
                          // Priority: SDK blocked > no devices on Wi-Fi > browser doesn't support
                          const reasonKey = castSdkBlocked
                            ? 'watch.castUnavailableSdkBlocked'
                            : browserSupportsAny
                              ? 'watch.castUnavailableNoDevices'
                              : 'watch.castUnavailableUnsupportedBrowser';
                          return (
                            <div className="p-2 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-200 space-y-1">
                              <div className="font-medium">{t('watch.castUnavailable')}</div>
                              <div className="opacity-90">{t(reasonKey)}</div>
                              <div>• {t('watch.castUnavailableHelpChromecast')}</div>
                              <div>• {t('watch.castUnavailableHelpAirPlay')}</div>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowCastMenu(false);
                                  navigate('/help/chromecast');
                                }}
                                className="mt-2 text-yellow-100 underline hover:text-white text-xs"
                              >
                                {t('watch.castUnavailableSeeHelp')} →
                              </button>
                            </div>
                          );
                        })()
                      ) : (
                        // Both available - show choice
                        <div className="space-y-2">
                          {airPlayAvailable && (
                            <button
                              onClick={() => toggleAirPlay()}
                              disabled={isAirPlayLoading}
                              className={`w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 rounded transition-colors flex items-center gap-2 ${isAirPlayLoading ? 'opacity-50 cursor-not-allowed' : ''
                                }`}
                            >
                              {isAirPlayLoading ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <span>{t('watch.airplayConnecting')}</span>
                                </>
                              ) : (
                                <>
                                  <span>📱</span>
                                  <span>{t('watch.airplay')}</span>
                                </>
                              )}
                            </button>
                          )}

                          {castAvailable && (
                            <button
                              onClick={() => {
                                setShowCastMenu(false);
                                startCasting();
                              }}
                              disabled={isCastLoading}
                              className={`w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 rounded transition-colors flex items-center gap-2 ${isCastLoading ? 'opacity-50 cursor-not-allowed' : ''
                                }`}
                            >
                              {isCastLoading ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <span>{t('watch.castConnecting')}</span>
                                </>
                              ) : (
                                <>
                                  <span>📺</span>
                                  <span>{t('watch.cast')}</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Show appropriate errors */}
                      {(airPlayError || castError) && (
                        <div className="mt-2 p-2 bg-red-900/50 border border-red-700 rounded text-xs text-red-300">
                          {airPlayError || castError}
                        </div>
                      )}
                    </motion.div>
                  )}
                </div>
            </div>
          </div>
        </motion.div>
      )}

      {showNextEpisodeOverlay && nextEpisode && !hasDeclinedNextEpisode && (
        <NextEpisodePrompt
          showPrompt={showNextEpisodePrompt}
          nextEpisode={nextEpisode}
          tvShow={tvShow}
          onPlay={() => {
            setShowNextEpisodePrompt(false);
            // `!= null` pour autoriser les Spéciaux (S0) — sinon le bouton "Lire" du
            // popup "épisode suivant" ne fait rien quand le suivant est dans la saison 0.
            if (onNextEpisode && nextEpisode && nextEpisode.seasonNumber != null && nextEpisode.episodeNumber != null) {
              onNextEpisode(nextEpisode.seasonNumber, nextEpisode.episodeNumber);
            }
          }}
          onIgnore={handleIgnore}
          shouldHide={shouldHide}
          getMaskedContent={getMaskedContent}
        />
      )}

      {showNextMovie && nextMovie && onNextMovie && (
        <NextMovieOverlay
          movie={nextMovie}
          onPlay={() => {
            if (onNextMovie) {
              onNextMovie(nextMovie.id);
            }
          }}
          onIgnore={() => {
            setShowNextMovie(false);
            setHasIgnored(true);
          }}
        />
      )}

      {showNextMovieOverlay && nextMovie && nextMovieInfo && !showNextMovie && !hasIgnored && (
        <NextUpPrompt
          movie={nextMovie}
          movieInfo={nextMovieInfo}
          onPlay={handleReplay}
          onIgnore={() => {
            setShowNextMovieOverlay(false);
            setHasIgnored(true);
          }}
        />
      )}
      {/* Settings Panel - Moved outside the main controls conditional */}
      <AnimatePresence>
        {showSettings && (
        <HLSPlayerSettingsPanel
          key="settings-panel"
          {...{
            settingsMenuRef,
            settingsMenuWidth,
            audioTracks,
            subtitles,
            t,
            setShowSettings,
            tabsContainerRef,
            isAnime,
            tvShowId,
            src,
            settingsTab,
            setSettingsTab,
            sourceMenuRef,
            handleSourceMenuFocusCapture,
            sourceGroups,
            darkinoSources,
            nexusHlsSources,
            nexusFileSources,
            viperSources,
            voxSources,
            purstreamSources,
            embedUrl,
            onlyQualityMenu,
            embedType,
            loadingRivestream,
            handleSourceChange,
            renderSourceQualityMeta,
            renderCopySourceButton,
            showDarkinoMenu,
            showOmegaMenu,
            showCoflixMenu,
            showFstreamMenu,
            showWiflixMenu,
            showJ1fMenu,
            showNexusMenu,
            showRivestreamMenu,
            showBravoMenu,
            showViperMenu,
            showVoxMenu,
            showVostfrMenu,
            omegaSources,
            coflixSources,
            fstreamSources,
            wiflixSources,
            j1fSources,
            rivestreamSources,
            rivestreamCaptions,
            getOriginalUrl,
            capitalizeFirstLetter,
            getCoflixPreferredUrl,
            getLanguageName,
            currentAudioTrack,
            handleAudioTrackChange,
            currentSubtitle,
            handleSubtitleChange,
            episodeNumber,
            seasonNumber,
            movieId,
            selectedExternalLang,
            externalLanguages,
            externalLangsLoading,
            handleExternalLanguageSelect,
            externalLoading,
            translateSubsTo,
            setTranslateSubsTo,
            translationProgress,
            translationLang,
            startSubtitleTranslation,
            cancelSubtitleTranslation,
            loadingSubtitle,
            loadExternalSubtitle,
            setLoadingSubtitle,
            selectedExternalSub,
            externalSubs,
            setCurrentSubtitle,
            setSubtitleContainerVisible,
            refreshActiveCues,
            subtitleStyle,
            updateSubtitleFontSize,
            updateSubtitleBackgroundOpacity,
            updateSubtitleColor,
            formatDelay,
            resetSubtitleDelay,
            updateSubtitleDelay,
            playbackSpeed,
            handlePlaybackSpeedChange,
            saveProgressEnabled,
            setSaveProgressEnabled,
            autoNextEpisodeEnabled,
            setAutoNextEpisodeEnabled,
            nextContentThresholdMode,
            setNextContentThresholdMode,
            nextContentThresholdValue,
            setNextContentThresholdValue,
            resetCurrentProgress,
            audioEnhancerMode,
            handleAudioEnhancerChange,
            customAudio,
            handleCustomAudioChange,
            setCustomAudio,
            applyAudioEnhancerPreset,
            volumeBoost,
            handleVolumeBoostChange,
            resetVolumeBoost,
            videoOledMode,
            handleVideoOledChange,
            customOled,
            handleCustomOledChange,
            setCustomOled,
            getVideoOledFilter,
            videoRef,
            videoAspectRatio,
            setVideoAspectRatio,
            zoomState,
            resetZoom,
            priorityCategory,
          }}
        />
        )}
      </AnimatePresence>

      {/* Episodes Menu - Internal to HLSPlayer for fullscreen compatibility */}
      <AnimatePresence>
        {showInternalEpisodesMenu && episodes && episodes.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="absolute top-16 right-4 left-4 md:left-auto z-[12000] bg-black/95 border border-gray-800 rounded-lg shadow-2xl md:w-96 w-auto max-h-[80vh] flex flex-col"
            data-lenis-prevent
          >
            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-white">{showTitle || tvShow?.name || t('watch.episodes')}</h3>
              <button
                onClick={() => setShowInternalEpisodesMenu(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Season Selection */}
            {seasons && seasons.length > 1 && (
              <div className="p-4 border-b border-gray-800/50 overflow-visible">
                <h4 className="text-sm text-gray-400 mb-2">{t('watch.season')}</h4>
                <div className="relative w-full overflow-visible">
                  <button
                    onClick={() => setShowSeasonDropdown(!showSeasonDropdown)}
                    className="w-full flex items-center justify-between bg-gray-800/50 hover:bg-gray-700/50 rounded-lg p-3 text-white transition-colors duration-200"
                  >
                    <span className="font-medium">{t('watch.seasonN', { n: selectedSeasonNumber })}</span>
                    <motion.div
                      animate={{ rotate: showSeasonDropdown ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </motion.div>
                  </button>

                  <AnimatePresence>
                    {showSeasonDropdown && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2, ease: "easeInOut" }}
                        className="absolute top-full left-0 right-0 mt-1 bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl max-h-60 overflow-y-auto z-[13000]"
                      >
                        {seasons.map((season) => (
                          <button
                            key={season.id}
                            onClick={() => {
                              setSelectedSeasonNumber(season.season_number);
                              setShowSeasonDropdown(false);
                              // Fetch episodes for the selected season if not already loaded
                              if (!episodesBySeasons[season.season_number]) {
                                fetchEpisodesForSeason(season.season_number);
                              }
                            }}
                            className={`w-full text-left px-4 py-3 text-sm transition-colors duration-150 ${selectedSeasonNumber === season.season_number
                              ? 'bg-red-800/50 text-red-100 font-semibold'
                              : 'text-gray-200 hover:bg-gray-700/50'
                              }`}
                          >
                            {t('watch.seasonDropdown', { n: season.season_number })}
                            <span className="text-xs text-gray-400 ml-1">{t('watch.nEpisodes', { count: season.episode_count })}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* Current Episode Info */}
            {currentEpisodeInfo && (
              <div className="p-4 border-b border-gray-800/50 flex gap-3">
                {currentEpisodeInfo.still_path && (
                  shouldHide('episodeImages') ? (
                    <div className="w-24 h-auto rounded object-cover bg-gray-800 flex items-center justify-center min-h-[60px]">
                      <span className="text-xs text-gray-400">{t('watch.hiddenImage')}</span>
                    </div>
                  ) : (
                    <img
                      src={`https://image.tmdb.org/t/p/w300${currentEpisodeInfo.still_path}`}
                      alt={currentEpisodeInfo.name}
                      className="w-24 h-auto rounded object-cover"
                    />
                  )
                )}
                <div className="flex-1">
                  <div className="text-xs text-gray-400 mb-1">
                    S{seasonNumber} E{episodeNumber} • {t('watch.inProgress')}
                  </div>
                  <h4 className="text-white font-medium mb-1">
                    {shouldHide('episodeNames')
                      ? getMaskedContent(currentEpisodeInfo.name, 'episodeNames', undefined, episodeNumber)
                      : `${episodeNumber}. ${currentEpisodeInfo.name}`}
                  </h4>
                  <p className="text-xs text-gray-300 line-clamp-3">
                    {shouldHide('episodeOverviews')
                      ? getMaskedContent(currentEpisodeInfo.overview || t('watch.noDescription'), 'episodeOverviews', undefined, episodeNumber)
                      : (currentEpisodeInfo.overview || t('watch.noDescription'))}
                  </p>
                </div>
              </div>
            )}

            {/* Episodes List */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden p-1" data-lenis-prevent>
              <div className="grid gap-2 p-2">
                {loadingEpisodes ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-white" />
                    <span className="ml-2 text-white">{t('watch.loadingEpisodes')}</span>
                  </div>
                ) : (
                  (episodesBySeasons[selectedSeasonNumber] || []).map((episode) => (
                    <button
                      key={episode.id}
                      onClick={() => {
                        if (onEpisodeSelect) {
                          onEpisodeSelect(selectedSeasonNumber, episode.episode_number);
                        }
                        setShowInternalEpisodesMenu(false);
                      }}
                      className={`flex items-start gap-3 p-2 rounded-lg transition-colors ${episodeNumber === episode.episode_number && seasonNumber === selectedSeasonNumber
                        ? 'bg-red-900/30 border border-red-800/50'
                        : 'hover:bg-gray-800/50'
                        }`}
                    >
                      {episode.still_path ? (
                        shouldHide('episodeImages') ? (
                          <div className="w-20 h-12 bg-gray-800 rounded flex items-center justify-center">
                            <span className="text-xs text-gray-400">{t('watch.hiddenImage')}</span>
                          </div>
                        ) : (
                          <img
                            src={`https://image.tmdb.org/t/p/w300${episode.still_path}`}
                            alt={episode.name}
                            className="w-20 h-12 object-cover rounded"
                          />
                        )
                      ) : (
                        <div className="w-20 h-12 bg-gray-800 rounded flex items-center justify-center">
                          <span className="text-sm text-gray-400">{t('watch.noImage')}</span>
                        </div>
                      )}
                      <div className="flex-1 text-left">
                        <div className="text-xs text-gray-400">{t('watch.episodeN', { n: episode.episode_number })}</div>
                        <h5 className="text-sm text-white font-medium line-clamp-1">
                          {shouldHide('episodeNames')
                            ? getMaskedContent(episode.name, 'episodeNames', undefined, episode.episode_number)
                            : `${episode.episode_number}. ${episode.name}`}
                        </h5>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay Infos du flux vidéo (Ctrl+J) */}
      <AnimatePresence>
        {showStreamInfo && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="absolute top-4 left-4 z-[20000] bg-black/90 backdrop-blur-md rounded-xl border border-gray-700/50 p-4 text-white font-mono text-xs max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-bold text-blue-400">{t('watch.streamInfoTitle')}</span>
              </div>
              <button onClick={() => setShowStreamInfo(false)} className="p-1 hover:bg-gray-700 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1.5">
              {videoRef.current && (
                <>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.resolution')}</span>
                    <span>{videoRef.current.videoWidth}×{videoRef.current.videoHeight}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.duration')}</span>
                    <span>{videoRef.current.duration ? `${Math.floor(videoRef.current.duration / 3600).toString().padStart(2, '0')}:${Math.floor((videoRef.current.duration % 3600) / 60).toString().padStart(2, '0')}:${Math.floor(videoRef.current.duration % 60).toString().padStart(2, '0')}` : t('common.notAvailable')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.position')}</span>
                    <span>{`${Math.floor(videoRef.current.currentTime / 3600).toString().padStart(2, '0')}:${Math.floor((videoRef.current.currentTime % 3600) / 60).toString().padStart(2, '0')}:${Math.floor(videoRef.current.currentTime % 60).toString().padStart(2, '0')}`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.speed')}</span>
                    <span>{playbackSpeed}x</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.volume')}</span>
                    <span>{Math.round(volume * 100)}%{videoRef.current.muted ? ` (${t('watch.mutedState')})` : ''}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.state')}</span>
                    <span>{videoRef.current.paused ? `⏸ ${t('watch.paused')}` : `▶ ${t('watch.playing')}`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.loopPlayback')}</span>
                    <span>{isLooping ? t('common.enabled') : t('common.disabled')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.quality')}</span>
                    <span>{currentQuality === 'auto' ? 'Auto' : `${currentQuality}p`}</span>
                  </div>
                </>
              )}
              {hlsRef.current && (
                <>
                  <hr className="border-gray-700 my-2" />
                  <div className="text-gray-400 text-[10px] uppercase tracking-wider mb-1">{t('watch.hlsLabel')}</div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.levels')}</span>
                    <span>{hlsRef.current.levels?.length || 0}</span>
                  </div>
                  {hlsRef.current.levels?.[hlsRef.current.currentLevel] && (
                    <>
                      <div className="flex justify-between">
                          <span className="text-gray-400">{t('watch.bitrate')}</span>
                        <span>{(hlsRef.current.levels[hlsRef.current.currentLevel].bitrate / 1000).toFixed(0)} kbps</span>
                      </div>
                      {hlsRef.current.levels[hlsRef.current.currentLevel].codecSet && (
                        <div className="flex justify-between">
                            <span className="text-gray-400">{t('watch.codec')}</span>
                          <span className="text-right max-w-[160px] truncate">{hlsRef.current.levels[hlsRef.current.currentLevel].codecSet}</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.audioTracks')}</span>
                    <span>{audioTracks.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.subtitles')}</span>
                    <span>{currentSubtitle === 'off' ? t('common.disabled') : currentSubtitle}</span>
                  </div>
                </>
              )}
              {!hlsRef.current && (
                <>
                  <hr className="border-gray-700 my-2" />
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('watch.type')}</span>
                    <span>{t('watch.mp4Direct')}</span>
                  </div>
                </>
              )}
              <hr className="border-gray-700 my-2" />
              <div className="flex justify-between">
                <span className="text-gray-400">{t('watch.fullscreen')}</span>
                <span>{isFullscreen ? t('common.yes') : t('common.no')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">{t('watch.pip')}</span>
                <span>{isPipActive ? t('watch.active') : t('common.disabled')}</span>
              </div>
            </div>
            <div className="mt-3 text-[10px] text-gray-500 text-center">{t('watch.streamInfoCloseHint')}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay Aide raccourcis clavier (Shift+?) */}
      <AnimatePresence>
        {showShortcutsHelp && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-[20000] bg-black/90 backdrop-blur-md flex items-center justify-center"
            onClick={() => setShowShortcutsHelp(false)}
          >
            <div
              className="bg-gray-900/95 rounded-2xl border border-gray-700/50 p-6 max-w-2xl w-full mx-4 max-h-[85vh] overflow-y-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="text-xl">⌨️</span> {t('watch.keyboardShortcuts')}
                </h3>
                <button onClick={() => setShowShortcutsHelp(false)} className="p-1.5 hover:bg-gray-700 rounded-lg transition-colors">
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
                {/* Lecture */}
                <div className="col-span-1 sm:col-span-2 text-xs font-bold text-red-400 uppercase tracking-wider mt-2 mb-1">{t('watch.shortcutsPlayback')}</div>
                {[
                  ['Espace / K', t('watch.shortcutPlayPause')],
                  ['J', t('watch.shortcutRewind10s')],
                  ['L', t('watch.shortcutForward10s')],
                  ['← / →', t('watch.shortcutSeek10s')],
                  ['Home', t('watch.shortcutVideoStart')],
                  ['End', t('watch.shortcutVideoEnd')],
                  ['1-9', t('watch.shortcutJumpPercent')],
                  ['R', t('watch.shortcutToggleLoop')],
                ].map(([key, desc]) => (
                  <div key={key} className="flex justify-between py-1">
                    <kbd className="bg-gray-800 px-2 py-0.5 rounded text-xs text-gray-300 font-mono border border-gray-700">{key}</kbd>
                    <span className="text-gray-400 text-xs">{desc}</span>
                  </div>
                ))}

                {/* Volume */}
                <div className="col-span-1 sm:col-span-2 text-xs font-bold text-red-400 uppercase tracking-wider mt-3 mb-1">{t('watch.volume')}</div>
                {[
                  ['↑ / ↓', t('watch.shortcutVolumeAdjust')],
                  ['M', t('watch.shortcutToggleMute')],
                ].map(([key, desc]) => (
                  <div key={key} className="flex justify-between py-1">
                    <kbd className="bg-gray-800 px-2 py-0.5 rounded text-xs text-gray-300 font-mono border border-gray-700">{key}</kbd>
                    <span className="text-gray-400 text-xs">{desc}</span>
                  </div>
                ))}

                {/* Vitesse */}
                <div className="col-span-1 sm:col-span-2 text-xs font-bold text-red-400 uppercase tracking-wider mt-3 mb-1">{t('watch.speed')}</div>
                {[
                  ['Shift + > / <', t('watch.shortcutSpeedAdjust')],
                  ['+ / -', t('watch.shortcutSpeedAdjust')],
                  ['0', t('watch.shortcutNormalSpeed')],
                  ['. (pause)', t('watch.shortcutNextFrame')],
                  [', (pause)', t('watch.shortcutPreviousFrame')],
                ].map(([key, desc]) => (
                  <div key={key} className="flex justify-between py-1">
                    <kbd className="bg-gray-800 px-2 py-0.5 rounded text-xs text-gray-300 font-mono border border-gray-700">{key}</kbd>
                    <span className="text-gray-400 text-xs">{desc}</span>
                  </div>
                ))}

                {/* Affichage */}
                <div className="col-span-1 sm:col-span-2 text-xs font-bold text-red-400 uppercase tracking-wider mt-3 mb-1">{t('watch.shortcutsDisplay')}</div>
                {[
                  ['F', t('watch.shortcutToggleFullscreen')],
                  ['P', t('watch.shortcutTogglePip')],
                  ['C', t('watch.shortcutCycleSubtitles')],
                  ['Ctrl + J', t('watch.shortcutStreamInfo')],
                  ['Shift + ?', t('watch.shortcutThisHelp')],
                  ['Escape', t('watch.shortcutCloseOverlays')],
                ].map(([key, desc]) => (
                  <div key={key} className="flex justify-between py-1">
                    <kbd className="bg-gray-800 px-2 py-0.5 rounded text-xs text-gray-300 font-mono border border-gray-700">{key}</kbd>
                    <span className="text-gray-400 text-xs">{desc}</span>
                  </div>
                ))}
              </div>

              <div className="mt-5 text-center text-xs text-gray-500">
                {t('watch.shortcutsCloseHintPrefix')} <kbd className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-400 border border-gray-700">Escape</kbd> {t('common.or')} <kbd className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-400 border border-gray-700">Shift + ?</kbd> {t('watch.shortcutsCloseHintSuffix')}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lock overlay — swallows all pointer interactions and counts taps for unlock */}
      {isLocked && (
        <div
          className="absolute inset-0 z-[20000] bg-transparent cursor-none"
          onClick={(e) => { e.stopPropagation(); registerLockTap(); }}
          onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseMove={(e) => e.stopPropagation()}
          onWheel={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onTouchStart={(e) => { e.stopPropagation(); registerLockTap(); }}
          onTouchMove={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onTouchEnd={(e) => e.stopPropagation()}
        >
          {showLockTip && (
            <div className="absolute left-0 right-0 bottom-20 z-10 flex justify-center pointer-events-none">
              <p className="text-sm text-gray-300 text-center px-4 bg-black/50 rounded-lg py-2">
                {isTouchDevice ? t('watch.lockTipMobile') : t('watch.lockTipDesktop')}
              </p>
            </div>
          )}
        </div>
      )}

    </div>
  );
});

const NextMovieOverlay: React.FC<{
  movie: NonNullable<HLSPlayerProps['nextMovie']>;
  onPlay: () => void;
  onIgnore: () => void;
}> = ({ movie, onPlay, onIgnore }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = window.innerWidth < 768;
  const isLandscape = window.innerWidth > window.innerHeight;

  // Adapter les dimensions pour le mode paysage sur mobile
  const getPositionClasses = () => {
    if (isMobile) {
      if (isLandscape) {
        // Mode paysage sur mobile
        return {
          container: 'left-auto right-8 bottom-4 w-[240px] h-32',
          image: 'w-14'
        };
      } else {
        // Mode portrait sur mobile
        return {
          container: 'left-0 right-0 w-[96%] mx-auto mb-2 h-40',
          image: 'w-20'
        };
      }
    } else {
      // Desktop
      return {
        container: 'right-0 m-4 w-1/3 h-48',
        image: 'w-32'
      };
    }
  };

  const positionClasses = getPositionClasses();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`absolute ${positionClasses.container} bg-black/80 rounded-lg overflow-hidden`}
    >
      <div className="flex h-full">
        <img
          src={`https://image.tmdb.org/t/p/w300${movie.poster_path}`}
          alt={movie.title}
          className={`h-full ${positionClasses.image} object-cover`}
        />
        <div className="flex-1 p-4 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-start">
              <h3 className={`${isMobile ? 'text-base' : 'text-lg'} font-bold mb-1`}>{t('watch.upNext')}</h3>
              <button
                onClick={onIgnore}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <p className={`${isMobile ? 'text-xs' : 'text-sm'} font-medium`}>{movie.title}</p>
            <p className={`${isMobile ? 'text-xs' : 'text-xs text-gray-400'} ${isLandscape && isMobile ? 'hidden' : ''}`}>{movie.overview}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate(`/movie/${encodeId(movie.id)}`)}
              className={`px-4 py-1 bg-white text-black ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-200 transition-colors`}
            >
              {t('watch.playback')}
            </button>
            <button
              onClick={onPlay}
              className={`px-4 py-1 bg-gray-600/50 text-white ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-600 transition-colors`}
            >
              {t('watch.rewatch')}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const NextUpPrompt: React.FC<{
  movie: NonNullable<HLSPlayerProps['nextMovie']>;
  movieInfo: MovieInfo;
  onPlay: () => void;
  onIgnore: () => void;
}> = ({ movie, movieInfo, onIgnore }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = window.innerWidth < 768;
  const isLandscape = window.innerWidth > window.innerHeight;

  // Restore responsive bottom-right positioning
  const getPositionClasses = () => {
    const isFullscreen = !!document.fullscreenElement;
    if (isMobile) {
      if (isLandscape) {
        // Mobile Landscape: Bottom right, slightly smaller
        return {
          container: `${isFullscreen ? 'bottom-16' : 'bottom-4'} right-4 w-64 h-36`,
          image: 'w-16'
        };
      } else {
        // Mobile Portrait: Bottom center, almost full width
        return {
          container: `${isFullscreen ? 'bottom-16' : 'bottom-2'} left-2 right-2 w-auto h-40`,
          image: 'w-20'
        };
      }
    } else {
      // Desktop: Bottom right, larger
      return {
        container: `${isFullscreen ? 'bottom-20' : 'bottom-4'} right-4 w-96 h-48`,
        image: 'w-32'
      };
    }
  };

  const positionClasses = getPositionClasses();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`absolute ${positionClasses.container} bg-black/80 rounded-lg overflow-hidden z-50`}
    >
      <div className="flex h-full">
        <img
          src={`https://image.tmdb.org/t/p/w300${movie.poster_path}`}
          alt={movie.title}
          className={`h-full ${positionClasses.image} object-cover`}
        />
        <div className="flex-1 p-4 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-start">
              <h3 className={`${isMobile ? 'text-base' : 'text-lg'} font-bold mb-1`}>{t('watch.upNext')}</h3>
              <button
                onClick={onIgnore}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <p className={`${isMobile ? 'text-xs' : 'text-sm'} font-medium`}>{movie.title}</p>
            <p className={`${isMobile ? 'text-xs' : 'text-xs text-gray-400'} ${isLandscape && isMobile ? 'hidden' : ''}`}>
              {movieInfo.releaseDate.split('-')[0]} • {movieInfo.rating.toFixed(1)}/10
            </p>
            <p className={`${isLandscape && isMobile ? 'hidden' : 'text-xs line-clamp-1'} ${!isMobile ? 'text-gray-400 line-clamp-2' : ''} mt-1`}>
              {movieInfo.overview}
            </p>
          </div>
          <div className="flex gap-2 mt-1">
            <button
              onClick={() => navigate(`/movie/${encodeId(movie.id)}`)}
              className={`px-4 py-1 bg-white text-black ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-200 transition-colors`}
            >
              {t('watch.playback')}
            </button>
            <button
              onClick={onIgnore}
              className={`px-4 py-1 bg-gray-600/50 text-white ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-600 transition-colors`}
            >
              {t('watch.later')}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const NextEpisodePrompt: React.FC<NextEpisodePromptProps> = ({ nextEpisode, tvShow, onPlay, onIgnore, shouldHide, getMaskedContent }) => {
  const { t } = useTranslation();
  const handlePlay = () => {
    onPlay();
  };
  const isMobile = window.innerWidth < 768;
  const isLandscape = window.innerWidth > window.innerHeight;

  // Utilise la même logique de positionnement que NextUpPrompt
  const getPositionClasses = () => {
    const isFullscreen = !!document.fullscreenElement;
    if (isMobile) {
      if (isLandscape) {
        // Mobile paysage : bas droite, plus petit
        return {
          container: `${isFullscreen ? 'bottom-16' : 'bottom-4'} right-4 w-64 h-36`,
          image: 'w-16'
        };
      } else {
        // Mobile portrait : bas centre, presque toute la largeur
        return {
          container: `${isFullscreen ? 'bottom-16' : 'bottom-2'} left-2 right-2 w-auto h-40`,
          image: 'w-20'
        };
      }
    } else {
      // Desktop : bas droite, plus grand
      return {
        container: `${isFullscreen ? 'bottom-20' : 'bottom-4'} right-4 w-96 h-48`,
        image: 'w-32'
      };
    }
  };

  const positionClasses = getPositionClasses();

  if (!nextEpisode) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`absolute bottom-0 ${positionClasses.container} bg-black/80 rounded-lg overflow-hidden`}
    >
      <div className="flex h-full">
        {tvShow?.backdrop_path && (
          shouldHide('episodeImages') ? (
            <div className={`h-full ${positionClasses.image} bg-gray-600 flex items-center justify-center`}>
              <span className="text-gray-400 text-xs">{t('watch.hiddenImage')}</span>
            </div>
          ) : (
            <img
              src={`https://image.tmdb.org/t/p/w500${tvShow.backdrop_path}`}
              className={`h-full ${positionClasses.image} object-cover`}
              alt={tvShow.name}
            />
          )
        )}
        <div className="flex-1 p-4 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-start">
              <h3 className={`${isMobile ? 'text-base' : 'text-lg'} font-bold mb-1`}>{t('watch.upNext')}</h3>
              <button
                onClick={onIgnore}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <p className={`${isMobile ? 'text-xs' : 'text-sm'} font-medium`}>
              {shouldHide('episodeNames')
                ? getMaskedContent((nextEpisode.name || nextEpisode.title || ''), 'episodeNames', undefined, nextEpisode.episodeNumber || nextEpisode.episode_number)
                : `${nextEpisode.episodeNumber || nextEpisode.episode_number}. ${nextEpisode.name || nextEpisode.title || ''}`}
            </p>

            <p className={`${isLandscape && isMobile ? 'hidden' : 'text-xs line-clamp-1'} ${!isMobile ? 'text-gray-400 line-clamp-2' : ''} mt-1`}>
              {shouldHide('episodeOverviews')
                ? getMaskedContent(nextEpisode.overview || '', 'episodeOverviews', undefined, nextEpisode.episodeNumber || nextEpisode.episode_number)
                : (nextEpisode.overview || '')}
            </p>
          </div>
          <div className="flex gap-2 mt-1">
            <button
              onClick={handlePlay}
              className={`px-4 py-1 bg-white text-black ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-200 transition-colors`}
            >
              {t('watch.playback')}
            </button>
            <button
              onClick={onIgnore}
              className={`px-4 py-1 bg-gray-600/50 text-white ${isMobile ? 'text-xs' : 'text-sm'} font-medium rounded hover:bg-gray-600 transition-colors`}
            >
              {t('watch.later')}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default memo(HLSPlayer); // Envelopper avec React.memo
