import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFrembedBase } from '../../utils/frembedConfig';
import { useParams, useNavigate } from 'react-router-dom'; // Added useNavigate
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import HLSPlayer from '../../components/HLSPlayer';
import PlayerOverlayPortal from '../../components/PlayerOverlayPortal';
import { motion, AnimatePresence } from 'framer-motion';
import { useAdFreePopup } from '../../context/AdFreePopupContext';
import AdFreePlayerAds from '../../components/AdFreePlayerAds';
import { getAdPopupMode } from '../../utils/adPopupMode';
import { extractM3u8FromEmbed, extractUqloadFile, extractVidzyM3u8, extractFsvidM3u8, registerServerResolvedSources, type M3u8Result } from '../../utils/extractM3u8';
import type { SeekStreamingHlsSource } from '../../utils/seekStreamingCandidates';
import { runExtractionPass } from '../../utils/runExtractionPass';
import { pickAutoSelectedSource, sortHostersByPriority, type SourceAvailability } from '../../utils/sourceAutoSelect';
import { getSourcePriorityPrefs, buildDefaults, subscribeToPriorityChanges } from '../../utils/sourcePriorityPrefs';
import { detectHoster } from '../../utils/hosterRegistry';
import { setLastPlayer } from '../../utils/lastPlayerPref';
import type { TopLevelSourceId } from '../../types/sourcePriority';
import { getTmdbId, encodeId } from '../../utils/idEncoder';
import { useAntiSpoilerSettings } from '../../hooks/useAntiSpoilerSettings';
import { useWrappedTracker } from '../../hooks/useWrappedTracker';
import { isUserVip, getVipHeaders } from '../../utils/authUtils';
import { serverResolveRequest } from '../../utils/serverResolveRequest';
import { isExtensionAvailable } from '../../utils/extensionProxy';
import { getTmdbLanguage } from '../../i18n';
import { useProfile } from '../../context/ProfileContext';
import { getClassificationLabel } from '../../utils/certificationUtils';
import { getCoflixPreferredUrl } from '../../utils/coflix';
import {
  createHlsAutoFallbackGuard,
  resolveAcceptedWatchSource,
  resolveRenderedWatchSource,
  syncHlsActiveSource,
} from '../../utils/hlsAutoFallbackGuard';
import { resolveKisskhTv } from '../../services/kisskhService';
import SwiftfluxGate from '../../components/SwiftfluxGate';
import {
  readSwiftflux,
  type SwiftfluxEntry,
  type SwiftfluxPlayback,
} from '../../services/swiftfluxService';
import type { KisskhSource, KisskhSubtitleTrack } from '../../types/kisskh';
import { markEpisodeHandoff } from '../../utils/playerFullscreenPersistence';
const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// Voir le commentaire jumeau dans HLSPlayer.tsx : on normalise l'hôte de la
// PAGE embed uqload (les TLD changent, l'extracteur ne connaît que
// `uqload.is`) mais jamais une URL de proxy signée ni un sous-domaine CDN
// `strmN.uqload.<tld>` — les réécrire invalide la signature de la cible.
const UQLOAD_EMBED_HOSTNAME = /^(?:www\.)?uqload\.[a-z0-9-]+$/i;

const normalizeUqloadEmbedUrl = (url: string): string => {
  if (!url) return url;

  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return url;
  }

  if (parsed.searchParams.has('url')) return url;
  if (!UQLOAD_EMBED_HOSTNAME.test(parsed.hostname)) return url;

  parsed.hostname = 'uqload.is';
  return parsed.toString();
};

// Interfaces
interface NextEpisodeType {
  season_number: number;
  episode_number: number;
  name: string;
  overview: string;
  air_date: string;
  vote_average: number;
  still_path?: string | null;
  show_id: number;
  show_name: string;
}

interface OmegaTvEpisodeResponse {
  players: Array<{ player: string; link: string; is_hd?: boolean }>;
}

interface CoflixTvEpisodeResponse {
  iframe_src?: string;
  player_links?: Array<{ decoded_url: string; clone_url?: string; quality: string; language: string }>;
  current_episode?: {
    iframe_src?: string;
    player_links?: Array<{ decoded_url: string; clone_url?: string; quality: string; language: string }>;
    season_number?: number;
    episode_number?: number;
    title?: string;
  };
}

// Interface pour FStream TV
interface FStreamTvResponse {
  success: boolean;
  source: string;
  type: string;
  tmdb: {
    id: number;
    title: string;
    original_title: string;
    release_date: string;
    overview: string;
  };
  search: {
    query: string;
    results: number;
    bestMatch: any;
  };
  episodes: {
    [episodeNumber: string]: {
      number: number;
      title: string;
      languages: {
        VF?: Array<{
          url: string;
          type: string;
          quality: string;
          player: string;
        }>;
        VOSTFR?: Array<{
          url: string;
          type: string;
          quality: string;
          player: string;
        }>;
        VOENG?: Array<{
          url: string;
          type: string;
          quality: string;
          player: string;
        }>;
        Default?: Array<{
          url: string;
          type: string;
          quality: string;
          player: string;
        }>;
      };
    };
  };
  total: number;
  metadata: {
    season: number;
    episode: number;
    extractedAt: string;
  };
}



// Interface pour la source Wiflix TV (Lynx)
interface WiflixTvResponse {
  success: boolean;
  tmdb_id: string;
  title: string;
  original_title: string;
  season: number;
  wiflix_url: string;
  episodes: {
    [episodeNumber: string]: {
      vf: Array<{
        name: string;
        url: string;
        episode: number;
        type: string;
      }>;
      vostfr: Array<{
        name: string;
        url: string;
        episode: number;
        type: string;
      }>;
    };
  };
  cache_timestamp: string;
}

interface ViperTvResponse {
  links: {
    vf: Array<{ server: string; url: string }>;
    vostfr: Array<{ server: string; url: string }>;
  };
}

interface VoxTvResponse {
  success: boolean;
  data: Array<{
    name: string;
    link: string;
  }>;
  tmdbId: string;
  season: string;
  episode: string;
}

// SwiftFlow source response (mirror of Wiflix/J1F episodes shape)
interface SwiftflowTvResponse {
  success: boolean;
  tmdb_id: number;
  title?: string;
  source?: string;
  season?: number;
  episodes: {
    [episodeNumber: string]: {
      vf: Array<{
        name: string;
        url: string;
        type: string;
        label?: string;
      }>;
      vostfr: Array<{
        name: string;
        url: string;
        type: string;
        label?: string;
      }>;
    };
  };
  cache_timestamp?: string;
  error?: string;
}

// Interface pour les saisons
interface Season {
  id: number;
  name: string;
  season_number: number;
  episode_count: number;
  poster_path?: string | null;
  overview?: string;
}

// Interface pour les épisodes dans l'affichage du menu
interface EpisodeInfo {
  id: number;
  name: string;
  episode_number: number;
  air_date?: string;
  overview?: string;
  still_path?: string | null;
  vote_average?: number;
}

type PlayerSourceType = 'darkino' | 'mp4' | 'm3u8' | 'frembed' | 'custom' | 'vostfr' | 'omega' | 'coflix' | 'fstream' | 'wiflix' | 'j1f' | 'swiftflow' | 'viper' | 'vox' | string | number; // Allow string for embed types

function formatPremidSourceDetail(...parts: Array<string | null | undefined>) {
  const normalizedParts = parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .filter((part, index, array) =>
      array.findIndex(entry => entry.toLowerCase() === part.toLowerCase()) === index
    );

  return normalizedParts.length > 0 ? normalizedParts.join(' - ') : undefined;
}


// --- Helper functions adapted from TVDetails.tsx ---

// Check Custom Links from MySQL API for TV Episodes
const checkCustomTVLink = async (showId: string, seasonNumber: number, episodeNumber: number) => {
  const customLinks: string[] = [];
  const mp4Links: { url: string; label?: string; language?: string; isVip?: boolean }[] = [];
  let isAvailable = false;

  try {
    // Méthode serveur : `resolve=1` + clé VIP, le serveur résout les m3u8 des
    // liens communautaires de cet épisode. Méthode extension/userscript :
    // liens bruts, extraction locale.
    const response = await axios.get(`${MAIN_API}/api/links/tv/${showId}`,
      serverResolveRequest({ season: seasonNumber, episode: episodeNumber }));

    // Enregistré ici : cette fonction ne renvoie que les URLs, la table
    // `m3u8ByPlayer` serait perdue en aval.
    registerServerResolvedSources(response.data);

    // For TV series, data is an array, not an object
    if (response.data && response.data.success && response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
      const episodeData = response.data.data[0]; // Get first episode from array
      const rawLinks = episodeData.links || [];
      const uniqueUrls = new Set<string>();

      console.log('Raw API TV links:', rawLinks);

      rawLinks.forEach((item: any) => {
        let urlToAdd: string | null = null;
        let label = "HD+";
        let language = 'FR';
        let isVip = false;

        if (typeof item === 'string') {
          urlToAdd = item;
        } else if (typeof item === 'object' && item !== null && typeof item.url === 'string') {
          urlToAdd = item.url;
          label = item.label || "Viblix";
          language = item.language || language;
          isVip = item.isVip || isVip;
        }

        if (urlToAdd) {
          isAvailable = true;
          if (urlToAdd.toLowerCase().endsWith('.mp4')) {
            if (!uniqueUrls.has(urlToAdd)) {
              uniqueUrls.add(urlToAdd);
              mp4Links.push({ url: urlToAdd, label, language, isVip });
            }
          } else {
            if (!customLinks.includes(urlToAdd)) {
              customLinks.push(urlToAdd);
            }
          }
        }
      });

      console.log('Processed API TV links - customLinks:', customLinks, 'mp4Links:', mp4Links);
    }
  } catch (error) {
    console.error('Error fetching custom TV links from API:', error);
  }

  return { isAvailable, customLinks, mp4Links };
};


// Check Frembed Availability for Episodes
const checkFrembedAvailability = async (showId: string, seasonNumber: number, episodeNumber: number): Promise<boolean> => {
  try {
    const checkUrl = `${getFrembedBase()}/api/public/v1/tv/${showId}?sa=${seasonNumber}&epi=${episodeNumber}`;
    const response = await axios.get(checkUrl, { timeout: 1000 });

    // Check status and if result has items
    return response.data?.status === 200 && response.data?.result?.totalItems > 0;

  } catch (error: any) {
    // console.error('Frembed Check Error:', error.message);
    // If the check endpoint fails (e.g., 404), assume unavailable
    return false;
  }
};

// New function to check if an episode exists in Omega data
const checkOmegaAvailability = (omegaData: any, seasonNumber: number, episodeNumber: number): boolean => {
  if (!omegaData || !omegaData.type || omegaData.type !== 'tv' || !omegaData.series || !omegaData.series.length) {
    return false;
  }

  try {
    const series = omegaData.series[0];
    const season = series.seasons?.find((s: { number: number }) => s.number === seasonNumber);
    if (!season) return false;

    const episode = season.episodes?.find((e: { number: string }) =>
      e.number === episodeNumber.toString());

    // Check if episode exists and has playable sources
    return !!episode &&
      !!episode.versions &&
      ((!!episode.versions.vf && !!episode.versions.vf.players && episode.versions.vf.players.length > 0) ||
        (!!episode.versions.vostfr && !!episode.versions.vostfr.players && episode.versions.vostfr.players.length > 0));
  } catch (error) {
    console.error('Error checking Omega availability:', error);
    return false;
  }
};

// Check Darkino Availability for TV Episodes (Adapted from TVDetails)
const checkDarkinoAvailability = async (
  _showTitle: string,
  _releaseYear: number,
  _seasonNumber: number,
  _episodeNumber: number,
  _showId: string,
  _updateRetryMessage?: (message: string) => void,
  _retryCount = 0
): Promise<false | { available: boolean; sources: any[]; darkinoId: string | null }> => {
  // Source Darkino/Nightflix retirée : endpoints api.movix.chat/api/search + /api/series/download désactivés.
  return false;
};

// Check sibnet availability for anime
const checkSibnetAvailability = async (videoId: string): Promise<string | null> => {
  if (!videoId) return null;

  try {
    const response = await axios.get(`https://colossal-latrina-movixfrembedapi-acb05587.koyeb.app/api/extract-sibnet?url=https:%2F%2Fvideo.sibnet.ru%2Fshell.php%3Fvideoid%3D${videoId}`);

    if (response.data && response.data.url) {
      // Replace dv98 with cvs123-1 as requested
      const modifiedUrl = response.data.url.replace('dv98.sibnet.ru', 'cvs123-1.sibnet.ru');
      return modifiedUrl;
    }
  } catch (error) {
    console.error('Error extracting sibnet URL:', error);
  }

  return null;
};

// Check Vox Availability
const checkVoxAvailability = async (
  tmdbId: string,
  season: number,
  episode: number
): Promise<VoxTvResponse | null> => {
  try {
    const response = await axios.get(`${MAIN_API}/api/drama/tv/${tmdbId}`, {
      params: { season, episode }
    });

    if (response.data && response.data.success && response.data.data && response.data.data.length > 0) {
      return response.data;
    }
  } catch (error) {
    console.error('Error checking Vox availability:', error);
  }
  return null;
};

// Pure helper — extrait la liste des players Omega pour la saison/épisode courants.
// Remonté au scope module (sans dépendance au composant) pour pouvoir être appelé
// depuis un `useMemo` qui construit la liste triée `sortedOmega`. Le shape de
// `omegaData` est loose (schéma backend non contractualisé), donc `unknown` + casts.
type OmegaPlayerMerged = {
  player: string;
  link: string;
  is_hd: boolean;
  label: string;
  lang: 'VF' | 'VOSTFR';
};
const extractOmegaPlayers = (omegaData: unknown, seasonNumber?: number, episodeNumber?: number): OmegaPlayerMerged[] => {
  if (!omegaData || typeof omegaData !== 'object') return [];
  const data = omegaData as { players?: unknown[]; type?: string; series?: Array<{ seasons?: Array<{ number: number; episodes?: Array<{ number: string | number; versions?: { vf?: { players?: Array<{ name: string; link: string }> }; vostfr?: { players?: Array<{ name: string; link: string }> } } }> }> }> };
  if (data.players && Array.isArray(data.players)) {
    return data.players as OmegaPlayerMerged[];
  }
  if (data.type === 'tv' && data.series && data.series.length > 0) {
    const series = data.series[0];
    const currentSeasonNumber = seasonNumber || parseInt(new URLSearchParams(window.location.search).get('season') || '1', 10);
    const currentEpisodeNumber = episodeNumber?.toString() || new URLSearchParams(window.location.search).get('episode') || '1';
    const season = series.seasons?.find((s) => s.number === currentSeasonNumber);
    const episode = season?.episodes?.find((e) => String(e.number) === String(currentEpisodeNumber));
    if (episode && episode.versions) {
      let players: OmegaPlayerMerged[] = [];
      if (episode.versions.vf && episode.versions.vf.players) {
        players = players.concat(episode.versions.vf.players.map((player) => ({
          player: player.name,
          link: player.link,
          is_hd: false,
          label: 'Sans pubs',
          lang: 'VF' as const,
        })));
      }
      if (episode.versions.vostfr && episode.versions.vostfr.players) {
        players = players.concat(episode.versions.vostfr.players.map((player) => ({
          player: player.name,
          link: player.link,
          is_hd: false,
          label: 'Sans pubs',
          lang: 'VOSTFR' as const,
        })));
      }
      return players;
    }
  }
  return [];
};

// --- Main Component ---
const WatchTv: React.FC = () => {
  const { tmdbid: encodedId, season: seasonParam, episode: episodeParam } = useParams<{ tmdbid: string; season: string; episode: string }>();
  const id = encodedId ? getTmdbId(encodedId) : null;
  const navigate = useNavigate(); // Hook for navigation
  const { currentProfile } = useProfile();

  const { t } = useTranslation();

  // Ensure IDs are valid before parsing
  const seasonNumber = parseInt(seasonParam || '1', 10);
  const episodeNumber = parseInt(episodeParam || '1', 10);
  const autoFallbackGuard = useMemo(() => createHlsAutoFallbackGuard(2), [id, seasonNumber, episodeNumber]);

  const [isLoading, setIsLoading] = useState(true);
  const [contentCert] = useState<string>('');
  const [isBlocked] = useState(false);
  const [loadingText, setLoadingText] = useState(t('watch.loadingSources'));
  const [showTitle, setShowTitle] = useState<string>('');
  const [episodeTitle, setEpisodeTitle] = useState<string>('');
  const [, setReleaseYear] = useState<number | null>(null);
  const [backdropPath, setBackdropPath] = useState<string | null>(null);
  const [, setEpisodeStillPath] = useState<string | null>(null);
  const [showPosterPath, setShowPosterPath] = useState<string | null>(null); // Store poster for progress saving

  // Anti-spoiler settings
  const { shouldHide, getMaskedContent } = useAntiSpoilerSettings();

  // Source states
  const [selectedSource, setSelectedSource] = useState<PlayerSourceType | null>(null);
  const [customSources, setCustomSources] = useState<string[]>([]);
  const [frembedAvailable, setFrembedAvailable] = useState(true);
  const [adFreeM3u8Url] = useState<string | null>(null); // Keep for potential future use
  const [coflixData, setCoflixData] = useState<CoflixTvEpisodeResponse | null>(null);
  const [omegaData, setOmegaData] = useState<OmegaTvEpisodeResponse | null>(null);
  const [darkinoAvailable, setDarkinoAvailable] = useState(false);
  const [darkinoSources, setDarkinoSources] = useState<any[]>([]);
  const [, setDarkinoShowId] = useState<string | null>(null);
  const [selectedDarkinoSource, setSelectedDarkinoSource] = useState<number>(0);
  const [mp4Sources, setMp4Sources] = useState<{ url: string; label?: string; language?: string; isVip?: boolean }[]>([]);
  const [selectedMp4Source, setSelectedMp4Source] = useState<number>(0);

  // SwiftFlux (MP4 direct du catalogue SwiftFlow) : ce qu'on sait exister
  // (`entries`, sans URL) et ce qui a été débloqué (`playback`, avec URL).
  // La porte d'entrée — pub puis Turnstile — s'intercale entre les deux.
  const [swiftfluxEntries, setSwiftfluxEntries] = useState<SwiftfluxEntry[]>([]);
  const [swiftfluxPlayback, setSwiftfluxPlayback] = useState<SwiftfluxPlayback | null>(null);
  // La porte se pose par-dessus ce qui joue : tant qu'elle n'a rien résolu, la
  // source courante reste en place et visible derrière, et la refermer ne coûte
  // rien à l'utilisateur.
  const [swiftfluxGateOpen, setSwiftfluxGateOpen] = useState(false);
  const [watchProgress] = useState<number>(0); // Used to set initial HLSPlayer time
  const [, setLoadingError] = useState<boolean>(false);
  const [nextEpisodeData, setNextEpisodeData] = useState<NextEpisodeType | null>(null);
  const [, setLoadingNextEpisode] = useState<boolean>(false);

  // Loading states for individual source types
  const [loadingDarkino, setLoadingDarkino] = useState(true);
  const [loadingCoflix, setLoadingCoflix] = useState(true);
  const [loadingOmega, setLoadingOmega] = useState(true);
  const [loadingCustom, setLoadingCustom] = useState(true);
  const [loadingSibnet, setLoadingSibnet] = useState(false);
  const [loadingFrembed, setLoadingFrembed] = useState(true);

  const [loadingExtractions, setLoadingExtractions] = useState(true); // Nouvel état pour les extractions
  const [vipRetryMessage, setVipRetryMessage] = useState<string | null>(null);
  const [onlyVostfrAvailable, setOnlyVostfrAvailable] = useState<boolean>(false);



  // FStream source states
  const [, setFstreamData] = useState<FStreamTvResponse | null>(null);
  const [fstreamSources, setFstreamSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedFstreamSource, setSelectedFstreamSource] = useState<number>(0);
  const [loadingFstream, setLoadingFstream] = useState(true);

  // Wiflix source states
  const [, setWiflixData] = useState<WiflixTvResponse | null>(null);
  const [wiflixSources, setWiflixSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedWiflixSource, setSelectedWiflixSource] = useState<number>(0);
  const [loadingWiflix, setLoadingWiflix] = useState(true);

  // J1F (1jour1film) source states
  const [, setJ1fData] = useState<any>(null);
  const [j1fSources, setJ1fSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedJ1fSource, setSelectedJ1fSource] = useState<number>(0);
  const [loadingJ1f, setLoadingJ1f] = useState(true);

  // SwiftFlow source states
  const [, setSwiftflowData] = useState<SwiftflowTvResponse | null>(null);
  const [swiftflowSources, setSwiftflowSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedSwiftflowSource, setSelectedSwiftflowSource] = useState<number>(0);
  const [loadingSwiftflow, setLoadingSwiftflow] = useState(true);

  // Extracted sources states (General HLS/File bucket)
  const [nexusHlsSources, setNexusHlsSources] = useState<SeekStreamingHlsSource[]>([]);
  const [nexusFileSources, setNexusFileSources] = useState<{ url: string; label: string }[]>([]);
  const [selectedNexusHlsSource, setSelectedNexusHlsSource] = useState<number>(0);
  const [selectedNexusFileSource, setSelectedNexusFileSource] = useState<number>(0);

  // Viper source states
  const [, setViperData] = useState<ViperTvResponse | null>(null);
  const [viperSources, setViperSources] = useState<{ url: string; label: string; quality: string; language: string }[]>([]);
  const [selectedViperSource, setSelectedViperSource] = useState<number>(0);
  const [loadingViper, setLoadingViper] = useState(true);

  // Vox source states
  const [, setVoxData] = useState<VoxTvResponse | null>(null);
  const [voxSources, setVoxSources] = useState<{ name: string; link: string }[]>([]);
  const [selectedVoxSource, setSelectedVoxSource] = useState<number>(0);
  const [loadingVox, setLoadingVox] = useState(true);

  // KissKH resolution is episode-scoped. The generation and controller reject
  // late completions without blocking any incumbent provider.
  const [kisskhSources, setKisskhSources] = useState<KisskhSource[]>([]);
  const [kisskhSubtitles, setKisskhSubtitles] = useState<KisskhSubtitleTrack[]>([]);
  const [loadingKisskh, setLoadingKisskh] = useState(true);
  const kisskhRequestGenerationRef = useRef(0);
  const kisskhRequestAbortRef = useRef<AbortController | null>(null);

  // PurStream (Bravo) HLS states
  const [purstreamSources, setPurstreamSources] = useState<{ url: string; label: string }[]>([]);
  const canUseBravo = isUserVip() || isExtensionAvailable();

  // Reset state lié à l'épisode courant quand saison/épisode change : sinon des URLs
  // de l'épisode précédent restent en mémoire (embed URL périmée pointant
  // vers l'épisode précédent, etc.). Critique pour les épisodes spéciaux (S0) où on enchaîne souvent
  // depuis un épisode régulier avec des sources vers un spécial sans source.
  useEffect(() => {
    // Embed URL/type d'un épisode précédent ne doivent jamais survivre à une nav d'épisode :
    // sinon un utilisateur arrivant sur un nouvel épisode verrait soit l'iframe pointant vers
    // le mauvais épisode, soit (combiné au reorder ternary plus bas) un faux contenu durant le
    // re-init.
    setEmbedUrl(null);
    setEmbedType(null);
  }, [seasonNumber, episodeNumber]);

  // Bump à chaque changement de prefs de priorité pour re-trier les sortedX.
  const [prefsVersion, setPrefsVersion] = useState<number>(0);
  useEffect(() => {
    return subscribeToPriorityChanges(() => setPrefsVersion((v) => v + 1));
  }, []);

  // Listes triées par priorité hoster utilisateur (avec override par top-level).
  // On annote chaque source avec son `type` détecté via `detectHoster` puis on
  // trie avec `sortHostersByPriority`. Les listes d'origine restent inchangées.
  const sortedFstream = useMemo(() => {
    const prefs = getSourcePriorityPrefs();
    const annotated = fstreamSources.map((s) => ({
      ...s,
      type: detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'fstream' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // Stabilité UX (M4) : pas de prefsVersion en deps — pin update les prefs et
  // l'indicateur #1, mais l'ordre affiché reste stable jusqu'au prochain refresh.
  }, [fstreamSources]);

  const sortedWiflix = useMemo(() => {
    const prefs = getSourcePriorityPrefs();
    const annotated = wiflixSources.map((s) => ({
      ...s,
      type: detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'wiflix' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiflixSources]);

  const sortedJ1f = useMemo(() => {
    const prefs = getSourcePriorityPrefs();
    const annotated = j1fSources.map((s) => ({
      ...s,
      type: detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'j1f' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j1fSources]);

  const sortedSwiftflow = useMemo(() => {
    const prefs = getSourcePriorityPrefs();
    const annotated = swiftflowSources.map((s) => ({
      ...s,
      type: detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'swiftflow' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swiftflowSources]);

  // Omega / Coflix : les listes viennent de champs dérivés (`omegaData` / `coflixData`).
  // On annote via detectHoster sur l'URL (`.link` pour omega, URL préférée pour coflix)
  // puis on trie.
  type CoflixPlayer = { decoded_url: string; clone_url?: string; quality: string; language: string };
  const sortedOmega = useMemo<Array<OmegaPlayerMerged & { type: string }>>(() => {
    const players = extractOmegaPlayers(omegaData, seasonNumber, episodeNumber);
    if (!players || players.length === 0) return [];
    const prefs = getSourcePriorityPrefs();
    const annotated = players.map((p) => ({
      ...p,
      type: detectHoster(p.link ?? '', {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'omega' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omegaData, seasonNumber, episodeNumber]);

  const sortedCoflix = useMemo<Array<CoflixPlayer & { type: string }>>(() => {
    const links: CoflixPlayer[] = coflixData?.player_links ?? [];
    if (!links || links.length === 0) return [];
    const prefs = getSourcePriorityPrefs();
    const annotated = links.map((p) => ({
      ...p,
      type: detectHoster(getCoflixPreferredUrl(p), {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'coflix' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coflixData]);

  // Viper : items `{ url, label, quality, language }`. Le champ `language`
  // active le tri langue primaire dans sortHostersByPriority.
  const sortedViper = useMemo(() => {
    const prefs = getSourcePriorityPrefs();
    const annotated = viperSources.map((s) => ({
      ...s,
      type: detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      }) ?? 'unknown',
    }));
    return sortHostersByPriority(annotated, { category: 'moviesTv', topLevel: 'viper' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viperSources]);

  // Ref to track the current source type to avoid issues with state updates
  const currentSourceRef = useRef<PlayerSourceType | null>(null);

  // Ref to keep the last valid hlsSrc across source switches
  const lastValidHlsSrcRef = useRef<string>('');

  // Ref tracking the URL currently active in the player (videoSource or embedUrl).
  // Used to reject stale auto-fallback sourceChange events from an unmounted/previous player.
  const currentActiveUrlRef = useRef<string>('');

  useEffect(() => {
    autoFallbackGuard.activate();
    if (currentActiveUrlRef.current) {
      autoFallbackGuard.syncActiveSource(currentActiveUrlRef.current);
    }
    return () => autoFallbackGuard.invalidate();
  }, [autoFallbackGuard]);

  // State for Embed player
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [embedType, setEmbedType] = useState<string | null>(null);

  const [showEmbedQuality, setShowEmbedQuality] = useState(false); // For the embed source menu

  useEffect(() => {
    if (!embedUrl) return;
    const normalizedEmbedUrl = normalizeUqloadEmbedUrl(embedUrl);
    if (normalizedEmbedUrl !== embedUrl) {
      setEmbedUrl(normalizedEmbedUrl);
    }
  }, [embedUrl]);

  // Add sibnet source for anime
  const [sibnetUrl, setSibnetUrl] = useState<string | null>(null);

  // Add videoSource state to track the selected mp4 URL
  const [videoSource, setVideoSource] = useState<string | null>(null);

  useEffect(() => {
    let directSourceUrl = '';
    if (selectedSource === 'nexus_hls') {
      directSourceUrl = nexusHlsSources[selectedNexusHlsSource]?.url || '';
    } else if (selectedSource === 'nexus_file') {
      directSourceUrl = nexusFileSources[selectedNexusFileSource]?.url || '';
    } else if (selectedSource === 'darkino') {
      directSourceUrl = darkinoSources[selectedDarkinoSource]?.m3u8 || '';
    } else if (selectedSource === 'mp4') {
      directSourceUrl =
        videoSource
        || sibnetUrl
        || mp4Sources[selectedMp4Source]?.url
        || '';
    } else if (selectedSource === 'm3u8') {
      directSourceUrl = adFreeM3u8Url || videoSource || '';
    } else if (
      selectedSource === 'bravo'
      || selectedSource === 'kisskh'
    ) {
      directSourceUrl = videoSource || '';
    }

    syncHlsActiveSource(
      autoFallbackGuard,
      currentActiveUrlRef,
      resolveRenderedWatchSource(selectedSource, directSourceUrl, embedUrl),
    );
  }, [
    adFreeM3u8Url,
    autoFallbackGuard,
    darkinoSources,
    embedUrl,
    mp4Sources,
    nexusFileSources,
    nexusHlsSources,
    selectedDarkinoSource,
    selectedMp4Source,
    selectedNexusFileSource,
    selectedNexusHlsSource,
    selectedSource,
    sibnetUrl,
    videoSource,
  ]);

  // état pour le menu des épisodes
  const [showEpisodesMenu, setShowEpisodesMenu] = useState(false);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [currentEpisodeInfo, setCurrentEpisodeInfo] = useState<EpisodeInfo | null>(null);
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState(seasonNumber);
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);

  // Ref to prevent fetching episodes on initial mount (already fetched in initialFetch)
  const isInitialEpisodeFetch = useRef(true);

  // Ne pas afficher le bouton Sources en mode HLS
  const [showSourceButton, setShowSourceButton] = useState(true);

  const {
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept,
    showAdFreePopup, // Added back
    shouldLoadIframe, // Added back
    adType // Added back
  } = useAdFreePopup();
  const [adPopupTriggered, setAdPopupTriggered] = useState(false);
  const [adPopupBypass, setAdPopupBypass] = useState(false);
  // Ajout de l'état pour savoir si l'utilisateur a cliqué sur la pub
  const [hasClickedAd, setHasClickedAd] = useState(false);

  // Movix Wrapped 2026 - Track TV viewing time
  useWrappedTracker({
    mode: 'viewing',
    viewingData: id ? {
      contentType: 'tv',
      contentId: id,
      seasonNumber: seasonNumber,
      episodeNumber: episodeNumber,
    } : undefined,
    isActive: !isLoading && !!id,
  });

  // Function to update VIP retry message
  const updateVipRetryMessage = (message: string) => {
    if (isLoading) { // Only show retry messages during initial load
      setVipRetryMessage(message);
      setLoadingText(message);
    }
  };

  // Function to handle navigation to the next episode
  const handleNextEpisodeNav = (targetSeason: number, targetEpisode: number) => {
    if (!id) return;
    console.log(`[Debug] Navigating to next episode: S${targetSeason}E${targetEpisode}`);
    // Navigation SPA volontaire (et non `window.location.href`) : un
    // rechargement complet déchargerait le document, ce qui fait perdre le
    // plein écran ET l'activation utilisateur — et sans activation, Firefox
    // refuse tout `requestFullscreen()`, donc le plein écran serait
    // irrécupérable. Ici le document survit, et le plein écran avec lui (il
    // est porté par le conteneur racine de l'app, voir `fullscreenTarget`).
    // L'état de la page repart quand même de zéro : le routeur remonte le
    // composant, `RouteLazyContent` posant `key={pathname}`.
    markEpisodeHandoff();
    navigate(`/watch/tv/${encodeId(id)}/s/${targetSeason}/e/${targetEpisode}`);
  };

  // Helper function to extract sibnet ID from URL or other source
  const extractSibnetIdFromUrl = (): string | null => {
    // This is a placeholder - in a real app, you would implement the logic
    // to extract the sibnet ID from URL parameters or some other source
    return null;
  };


  // --- Fetch Seasons Data ---
  const fetchSeasons = async () => {
    try {
      if (!id) return;

      const seasonResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
      });

      // Fetch all seasons for the show
      const allSeasonsResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
      });

      if (allSeasonsResponse.data && allSeasonsResponse.data.seasons) {
        setSeasons(allSeasonsResponse.data.seasons.filter((s: Season) => s.season_number > 0));
      }

      // Set episodes for the current season
      if (seasonResponse.data && seasonResponse.data.episodes) {
        setEpisodes(seasonResponse.data.episodes);
      }
    } catch (error) {
      console.error('Error fetching seasons:', error);
    }
  };

  // --- Fetch Next Episode Data ---
  const fetchNextEpisodeData = useCallback(async () => {
    // Note: `!seasonNumber` est faux pour S0 (épisode spécial) car 0 est falsy en JS — utiliser
    // un check explicite contre null/undefined. Sinon, sur les Spéciaux, fetchNextEpisodeData
    // sortait sans poser nextEpisodeData, ce qui cachait le groupe précédent/épisodes/suivant
    // (rendu conditionné par `{nextEpisodeData && ...}` côté UI).
    if (id == null || seasonNumber == null || episodeNumber == null || episodeNumber < 1) return;

    setLoadingNextEpisode(true);

    try {
      // Check if there's a next episode in the current season
      const nextEpisodeInCurrentSeason = await isNextEpisodeAvailable(id, seasonNumber, episodeNumber + 1);

      if (nextEpisodeInCurrentSeason) {
        setNextEpisodeData({
          season_number: seasonNumber,
          episode_number: episodeNumber + 1,
          name: nextEpisodeInCurrentSeason.name,
          overview: nextEpisodeInCurrentSeason.overview,
          air_date: nextEpisodeInCurrentSeason.air_date,
          vote_average: nextEpisodeInCurrentSeason.vote_average,
          still_path: nextEpisodeInCurrentSeason.still_path,
          show_id: parseInt(id),
          show_name: showTitle
        });
      } else {
        // Check if there's a next season
        const nextSeason = await isNextSeasonAvailable(id, seasonNumber + 1);

        if (nextSeason) {
          // Check if the first episode of next season is available
          const firstEpisodeOfNextSeason = await isNextEpisodeAvailable(id, seasonNumber + 1, 1);

          if (firstEpisodeOfNextSeason) {
            setNextEpisodeData({
              season_number: seasonNumber + 1,
              episode_number: 1,
              name: firstEpisodeOfNextSeason.name,
              overview: firstEpisodeOfNextSeason.overview,
              air_date: firstEpisodeOfNextSeason.air_date,
              vote_average: firstEpisodeOfNextSeason.vote_average,
              still_path: firstEpisodeOfNextSeason.still_path,
              show_id: parseInt(id),
              show_name: showTitle
            });
          } else {
            setNextEpisodeData(null);
          }
        } else {
          setNextEpisodeData(null);
        }
      }
    } catch (error) {
      console.error('Error checking next episode:', error);
      setNextEpisodeData(null);
    } finally {
      setLoadingNextEpisode(false);
    }
  }, [id, seasonNumber, episodeNumber, showTitle]);

  // Helper function to check if next episode exists
  const isNextEpisodeAvailable = async (showId: string, season: number, episode: number) => {
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${showId}/season/${season}/episode/${episode}`,
        { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
      );

      return response.data;
    } catch (error) {
      return null;
    }
  };

  // Helper function to check if next season exists
  const isNextSeasonAvailable = async (showId: string, season: number) => {
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${showId}/season/${season}`,
        { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
      );

      return response.data;
    } catch (error) {
      return null;
    }
  };

  // Check loading states to finish overall loading
  useEffect(() => {
    if (!isLoading) return; // Don't run if already finished loading or errored

    // Determine if all necessary sources have finished loading attempts
    // Determine if all necessary sources have finished loading attempts
    const areSourcesLoading = loadingDarkino || loadingCoflix || loadingOmega || loadingCustom || loadingSibnet || loadingFrembed || loadingFstream || loadingWiflix || loadingJ1f || loadingSwiftflow || loadingViper || loadingExtractions;

    if (!areSourcesLoading) {
      setVipRetryMessage(null); // Clear VIP message once attempts are done

      // Bug fix: Ensure a valid source is selected after loading completes
      // If current selected source isn't actually available, try to find a valid one
      if (
        (selectedSource === 'darkino' && (!darkinoSources || darkinoSources.length === 0)) ||
        (selectedSource === 'mp4' && (!mp4Sources || mp4Sources.length === 0) && !sibnetUrl) ||
        (selectedSource === 'm3u8' && !adFreeM3u8Url) ||
        (!selectedSource)
      ) {
        console.log("[Debug] Source selection issue detected, attempting to find valid source");

        // Try darkino first
        if (darkinoSources && darkinoSources.length > 0) {
          setSelectedSource('darkino');
          setSelectedDarkinoSource(0);
          // Clear any embed URLs to ensure HLS player is used
          setEmbedUrl(null);
          setEmbedType(null);
          setOnlyVostfrAvailable(false);
        }
        // Then try mp4
        else if (mp4Sources && mp4Sources.length > 0) {
          setSelectedSource('mp4');
          setSelectedMp4Source(0);
          setVideoSource(mp4Sources[0].url);
          // Clear any embed URLs to ensure HLS player is used
          setEmbedUrl(null);
          setEmbedType(null);
        }
        // Then try sibnet
        else if (sibnetUrl) {
          setSelectedSource('mp4');
          setVideoSource(sibnetUrl);
          // Clear any embed URLs to ensure HLS player is used
          setEmbedUrl(null);
          setEmbedType(null);
        }
        // Try custom sources
        else if (customSources && customSources.length > 0) {
          setSelectedSource('custom');
          setEmbedUrl(customSources[0]);
          setEmbedType('custom');
        }
        // Try Viper sources
        else if (viperSources.length > 0) {
          setSelectedSource('viper' as any);
          setSelectedViperSource(0);
          setEmbedUrl(viperSources[0].url);
          setEmbedType('viper');
        }
        // Try frembed as a fallback
        else if (frembedAvailable && id) {
          setSelectedSource('frembed');
          setEmbedUrl(`${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}`);
          setEmbedType('frembed');
        }
        // Note: Ne pas sélectionner automatiquement vostfr - laisser l'utilisateur choisir
        else {
          console.log("[Debug] No sources available, waiting for user selection");
        }
      }
      // Reset embed URL if HLS source is available to ensure HLS player is used
      else if ((selectedSource === 'darkino' && darkinoSources.length > 0) ||
        (selectedSource === 'mp4' && (mp4Sources.length > 0 || sibnetUrl)) ||
        (selectedSource === 'm3u8' && adFreeM3u8Url)) {
        setEmbedUrl(null);
        setEmbedType(null);
      }

      setIsLoading(false); // Mark loading as complete
    }
  }, [loadingDarkino, loadingCoflix, loadingOmega, loadingCustom, loadingSibnet, loadingFrembed, loadingFstream, loadingWiflix, loadingJ1f, loadingSwiftflow, loadingExtractions, isLoading, selectedSource, darkinoSources, mp4Sources, sibnetUrl, adFreeM3u8Url, id, seasonNumber, episodeNumber, customSources, frembedAvailable]);

  // Add effect to hide Sources button in HLS mode
  useEffect(() => {
    // Hide Sources button when playing HLS content (nexus_hls, nexus_file, darkino, mp4, m3u8)
    if ((selectedSource === 'nexus_hls' && nexusHlsSources.length > 0) ||
      (selectedSource === 'nexus_file' && nexusFileSources.length > 0) ||
      (selectedSource === 'darkino' && darkinoSources.length > 0) ||
      (selectedSource === 'mp4' && (mp4Sources.length > 0 || sibnetUrl)) ||
      (selectedSource === 'swiftflux' && !!swiftfluxPlayback) ||
      (selectedSource === 'm3u8' && adFreeM3u8Url) ||
      (selectedSource === 'bravo' && purstreamSources.length > 0 && canUseBravo) ||
      (selectedSource === 'kisskh' && kisskhSources.length > 0)) {
      setShowSourceButton(false);
    } else {
      setShowSourceButton(true);
    }
  }, [selectedSource, nexusHlsSources, nexusFileSources, darkinoSources, mp4Sources, sibnetUrl, swiftfluxPlayback, adFreeM3u8Url, purstreamSources, canUseBravo, kisskhSources]);

  // Effect to fetch episodes when the selected season changes in the menu
  useEffect(() => {
    const fetchEpisodesForSelectedSeason = async () => {
      if (!id || !selectedSeasonNumber) return; // Need show ID and a selected season

      console.log(`[WatchTv] Fetching episodes for selected season: ${selectedSeasonNumber}`);
      // Consider adding an setIsLoadingEpisodes state here
      try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${selectedSeasonNumber}`, {
          params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
        });
        if (response.data && response.data.episodes) {
          setEpisodes(response.data.episodes); // Update the episodes list
        } else {
          console.warn(`No episodes found for season ${selectedSeasonNumber}`);
          setEpisodes([]); // Clear if no episodes found
        }
      } catch (error) {
        console.error(`Error fetching episodes for season ${selectedSeasonNumber}:`, error);
        setEpisodes([]); // Clear on error
      } finally {
        // Consider setting setIsLoadingEpisodes(false) here
      }
    };

    // Check the ref to prevent running on the initial render
    if (isInitialEpisodeFetch.current) {
      isInitialEpisodeFetch.current = false; // Set ref to false after initial render
    } else {
      // Fetch episodes only when selectedSeasonNumber changes *after* the initial render
      fetchEpisodesForSelectedSeason();
    }
  }, [selectedSeasonNumber, id]); // Re-run whenever selectedSeasonNumber or the show id changes


  // Initial Fetch Effect
  useEffect(() => {
    kisskhRequestAbortRef.current?.abort();
    const kisskhController = new AbortController();
    const kisskhGeneration = kisskhRequestGenerationRef.current + 1;
    kisskhRequestGenerationRef.current = kisskhGeneration;
    kisskhRequestAbortRef.current = kisskhController;
    setKisskhSources([]);
    setKisskhSubtitles([]);
    setLoadingKisskh(true);

    // Validate parameters
    if (!id || isNaN(seasonNumber) || isNaN(episodeNumber) || seasonNumber < 0 || episodeNumber < 1) {
      console.error("Invalid ID, season, or episode number in URL");
      setLoadingError(true);
      setIsLoading(false);
      setLoadingKisskh(false);
      return () => kisskhController.abort();
    }

    const initialFetch = async () => {
      setIsLoading(true);
      setLoadingError(false); // Reset error on new fetch

      try {
        // Fetch show information and episode details
        const [showResponse, episodeResponse] = await Promise.all([
          axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
          }),
          axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}/episode/${episodeNumber}`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
          })
        ]);

        // Set show info
        const show = showResponse.data;
        setShowTitle(show.name);
        setReleaseYear(new Date(show.first_air_date).getFullYear());
        setBackdropPath(show.backdrop_path);
        setShowPosterPath(show.poster_path);

        // Set episode info
        const episode = episodeResponse.data;
        setEpisodeTitle(episode.name);
        setEpisodeStillPath(episode.still_path);
        setCurrentEpisodeInfo({
          id: episode.id,
          name: episode.name,
          episode_number: episode.episode_number,
          still_path: episode.still_path,
          overview: episode.overview,
          air_date: episode.air_date,
          vote_average: episode.vote_average
        });

        // Add TV show episode to continueWatching (if history is enabled)
        if (localStorage.getItem('settings_disable_history') !== 'true') {
          const continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}');

          // Ensure structure exists
          if (!continueWatching.movies) continueWatching.movies = [];
          if (!continueWatching.tv) continueWatching.tv = [];

          // Find existing TV show entry or create new one
          const showIdInt = parseInt(id!);
          const existingShow = continueWatching.tv.find((tvShow: any) => tvShow.id === showIdInt);

          if (existingShow) {
            // Update existing show with current episode and timestamp
            existingShow.currentEpisode = {
              season: seasonNumber,
              episode: episodeNumber
            };
            existingShow.lastAccessed = new Date().toISOString();
            // Move to front of array
            continueWatching.tv = continueWatching.tv.filter((tvShow: any) => tvShow.id !== showIdInt);
            continueWatching.tv.unshift(existingShow);
          } else {
            // Create new TV show entry
            const newTvEntry = {
              id: showIdInt,
              currentEpisode: {
                season: seasonNumber,
                episode: episodeNumber
              },
              lastAccessed: new Date().toISOString()
            };
            continueWatching.tv.unshift(newTvEntry);
          }

          // Keep only last 20 TV shows
          // continueWatching.tv = continueWatching.tv.slice(0, 20); // Removed limit
          localStorage.setItem('continueWatching', JSON.stringify(continueWatching));
        }

        // Get seasons information for episode navigation
        await fetchSeasons();

        // Resume playback functionality removed

        // Initialize loading states
        setLoadingDarkino(true);
        setLoadingCoflix(true);
        setLoadingOmega(true);
        setLoadingCustom(true);
        setLoadingSibnet(false);
        setLoadingFrembed(true);
        setLoadingFstream(true);
        setLoadingExtractions(true);
        // Reset MP4 sources specifically before fetching new ones
        setMp4Sources([]); // Add this line
        setFstreamData(null);
        setFstreamSources([]);

        // ========== EXÉCUTION PARALLÈLE DE TOUTES LES REQUÊTES API ==========
        const releaseYearData = new Date(show.first_air_date).getFullYear();

        // ========== INITIATE ALL ASYNCHRONOUS SOURCE CHECKS (NON-BLOCKING) ==========
        const kisskhPromise = (async () => {
          try {
            const resolution = await resolveKisskhTv(
              parseInt(id, 10),
              seasonNumber,
              episodeNumber,
              { signal: kisskhController.signal },
            );
            if (
              kisskhController.signal.aborted
              || kisskhRequestGenerationRef.current !== kisskhGeneration
            ) {
              return null;
            }
            return resolution;
          } catch {
            return null;
          } finally {
            if (
              !kisskhController.signal.aborted
              && kisskhRequestGenerationRef.current === kisskhGeneration
            ) {
              setLoadingKisskh(false);
            }
          }
        })();

        const darkinoPromise = checkDarkinoAvailability(
          show.name,
          releaseYearData,
          seasonNumber,
          episodeNumber,
          id!,
          updateVipRetryMessage
        ).catch(error => {
          console.error('Error checking Darkino availability:', error);
          return { available: false, sources: [] as any[], darkinoId: null };
        });

        const customLinksPromise = (async () => {
          try {
            // Fetch the full result including mp4Links
            return await checkCustomTVLink(id!, seasonNumber, episodeNumber);
          } catch (error) {
            console.error('Error checking custom TV links:', error);
            // Return default structure on error
            return { isAvailable: false, customLinks: [] as string[], mp4Links: [] as { url: string; label?: string; language?: string; isVip?: boolean }[] };
          } finally {
            setLoadingCustom(false);
          }
        })();

        const frembedAvailabilityPromise = (async () => {
          try {
            return await checkFrembedAvailability(id!, seasonNumber, episodeNumber);
          } catch (error) {
            console.error('Error checking Frembed availability:', error);
            return false;
          } finally {
            setLoadingFrembed(false);
          }
        })();

        const coflixPromise = (async () => {
          try {
            // Résolution serveur des m3u8 uniquement en méthode serveur.
            // Réservé à la lecture — la navigation ne déclenche pas d'extraction.
            const coflixResponse = await axios.get(`${MAIN_API}/api/tmdb/tv/${id}`,
              serverResolveRequest({ season: seasonNumber, episode: episodeNumber }));
            return coflixResponse.data;
          } catch (error) {
            console.error('Error fetching Coflix TV sources:', error);
            return null;
          } finally {
            setLoadingCoflix(false);
          }
        })();

        const omegaPromise = (async () => {
          let omegaDataResult = null;
          try {
            // Get IMDB ID for the show
            const imdbResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/external_ids`, {
              params: { api_key: TMDB_API_KEY },
            });

            if (imdbResponse.data && imdbResponse.data.imdb_id) {
              const imdbId = imdbResponse.data.imdb_id;
              // Appel sans params inutiles
              const omegaResponse = await axios.get(`${MAIN_API}/api/imdb/tv/${imdbId}`);
              omegaDataResult = omegaResponse.data;
            }
          } catch (error) {
            console.error('Error fetching Omega TV sources:', error);
            omegaDataResult = null;
          } finally {
            setLoadingOmega(false);
          }
          return omegaDataResult;
        })();

        // ========== CHECK PURSTREAM (BRAVO) SOURCE ==========
        const purstreamPromise = (async () => {
          try {
            const purstreamResponse = await axios.get(`${MAIN_API}/api/purstream/tv/${id}/stream`, {
              params: { season: seasonNumber, episode: episodeNumber },
              headers: { ...getVipHeaders() }
            });
            return purstreamResponse.data;
          } catch (error) {
            console.error('Error fetching PurStream TV sources:', error);
            return null;
          }
        })();

        // ========== CHECK FSTREAM SOURCE ==========
        const fstreamPromise = (async () => {
          try {
            // Méthode serveur : clé VIP + `resolve=1`, le serveur résout les
            // m3u8 du SEUL épisode demandé (`?episode=`) et les renvoie
            // signées. Méthode extension/userscript : liens bruts, extraction
            // locale.
            const fstreamResponse = await axios.get(`${MAIN_API}/api/fstream/tv/${id}/season/${seasonNumber}`,
              serverResolveRequest({ episode: episodeNumber }));
            return fstreamResponse.data;
          } catch (error) {
            console.error('Error fetching FStream TV sources:', error);
            return null;
          } finally {
            setLoadingFstream(false);
          }
        })();

        // ========== CHECK WIFLIX (LYNX) SOURCE ==========
        const wiflixPromise = (async () => {
          try {
            const wiflixResponse = await axios.get(`${MAIN_API}/api/wiflix/tv/${id}/${seasonNumber}`,
              serverResolveRequest({ episode: episodeNumber }));
            return wiflixResponse.data;
          } catch (error) {
            console.error('Error fetching Wiflix/Lynx TV source:', error);
            return null;
          } finally {
            setLoadingWiflix(false);
          }
        })();

        // ========== CHECK J1F (1JOUR1FILM) SOURCE ==========
        const j1fPromise = (async () => {
          try {
            const j1fResponse = await axios.get(`${MAIN_API}/api/j1f/tv/${id}/season/${seasonNumber}`,
              serverResolveRequest({ episode: episodeNumber }));
            return j1fResponse.data;
          } catch (error) {
            console.error('Error fetching 1jour1film TV source:', error);
            return null;
          } finally {
            setLoadingJ1f(false);
          }
        })();

        // ========== CHECK SWIFTFLOW SOURCE ==========
        const swiftflowPromise = (async () => {
          try {
            const swiftflowResponse = await axios.get(`${MAIN_API}/api/swiftflow/tv/${id}/season/${seasonNumber}`,
              serverResolveRequest({ episode: episodeNumber }));
            return swiftflowResponse.data;
          } catch (error) {
            console.error('Error fetching SwiftFlow TV source:', error);
            return null;
          } finally {
            setLoadingSwiftflow(false);
          }
        })();

        // ========== CHECK VIPER SOURCE ==========
        const viperPromise = (async () => {
          try {
            const viperResponse = await axios.get(`${MAIN_API}/api/cpasmal/tv/${id}/${seasonNumber}/${episodeNumber}`,
              serverResolveRequest());
            return viperResponse.data;
          } catch (error) {
            console.error('Error fetching Viper TV source:', error);
            return null;
          } finally {
            setLoadingViper(false);
          }
        })();

        // ========== CHECK VOX SOURCE ==========
        const voxPromise = (async () => {
          try {
            return await checkVoxAvailability(id!, seasonNumber, episodeNumber);
          } catch (error) {
            console.error('Error fetching Vox TV source:', error);
            return null;
          } finally {
            setLoadingVox(false);
          }
        })();

        // ========== AWAIT ALL SOURCE CHECKS TO COMPLETE ==========
        const [
          darkinoResult,
          customLinksResult,
          frembedAvailabilityResult,
          coflixResult,
          rawOmegaData,
          purstreamResult,
          fstreamResult,
          wiflixResult,
          viperResult,
          voxResult,
          j1fResult,
          swiftflowResult,
          kisskhResult,
        ] = await Promise.all([
          darkinoPromise,
          customLinksPromise,
          frembedAvailabilityPromise,
          coflixPromise,
          omegaPromise,
          purstreamPromise,
          fstreamPromise,
          wiflixPromise,
          viperPromise,
          voxPromise,
          j1fPromise,
          swiftflowPromise,
          kisskhPromise,
        ]);

        // ========== TRAITEMENT DES RÉSULTATS SWIFTFLUX ==========
        // Même réponse que SwiftFlow : l'appel amont rend l'URL du MP4 de
        // l'épisode en même temps que de quoi construire l'iframe. Pas de
        // requête supplémentaire.
        const swiftfluxResult = readSwiftflux(swiftflowResult);
        setSwiftfluxEntries(swiftfluxResult.entries);
        setSwiftfluxPlayback(null);

        // Mémorise les m3u8 que le serveur a résolues pour ces catalogues.
        // C'est la SEULE façon dont une m3u8 parvient au client : il n'existe
        // plus d'endpoint acceptant une URL à extraire. Les extracteurs de
        // `extractM3u8.ts` liront ce registre.
        [
          coflixResult, purstreamResult, fstreamResult, wiflixResult,
          viperResult, voxResult, j1fResult, swiftflowResult, customLinksResult,
        ].forEach(registerServerResolvedSources);

        const kisskhRequestIsCurrent = !kisskhController.signal.aborted
          && kisskhRequestGenerationRef.current === kisskhGeneration;
        if (kisskhRequestIsCurrent && kisskhResult) {
          setKisskhSources(kisskhResult.sources);
          setKisskhSubtitles(kisskhResult.subtitles);
        }

        // ========== PROCESS OMEGA RESULTS (before setting state) ==========
        let processedOmegaDataForState = null; // Variable to hold the data for setOmegaData
        let isOmegaAvailable = false; // Local var for decision making
        if (rawOmegaData) {
          isOmegaAvailable = checkOmegaAvailability(rawOmegaData, seasonNumber, episodeNumber);
          if (isOmegaAvailable) {
            processedOmegaDataForState = rawOmegaData;
            // Ajout: si supervideo ou dropload, tenter d'extraire le m3u8
            const omegaPlayers = extractOmegaPlayers(rawOmegaData, seasonNumber, episodeNumber);
            const supervideo = omegaPlayers.find((p: any) => p.player && p.player.toLowerCase().includes('supervideo'));
            if (supervideo) {
              await extractM3u8FromEmbed(supervideo, MAIN_API);
            }
            const dropload = omegaPlayers.find((p: any) => p.player && p.player.toLowerCase().includes('dropload'));
            if (dropload) {
              await extractM3u8FromEmbed(dropload, MAIN_API);
            }
          } else {
            console.log(`Omega source not available for S${seasonNumber}E${episodeNumber}`);
          }
        }
        setOmegaData(processedOmegaDataForState); // Update state with processed Omega data

        // ========== TRAITEMENT DES RÉSULTATS DE DARKINO ==========
        if (darkinoResult && darkinoResult.available && darkinoResult.sources.length > 0) {
          setDarkinoAvailable(true);
          // Pré-tri par priorité hoster (M4) — state ordonné par pin user.
          const prefsDk0 = getSourcePriorityPrefs();
          const sortedDarkinoSources = sortHostersByPriority(
            (darkinoResult.sources as any[]).map((s: any) => ({
              ...s,
              type: (detectHoster(s.m3u8 || '', {
                patternOverrides: prefsDk0.patternOverrides,
                customHosters: prefsDk0.customHosters,
              }) ?? detectHoster(s.label || s.quality || '', {
                patternOverrides: prefsDk0.patternOverrides,
                customHosters: prefsDk0.customHosters,
              })) ?? 'unknown',
            })),
            { category: 'moviesTv', topLevel: 'darkino' },
          );
          darkinoResult.sources = sortedDarkinoSources as typeof darkinoResult.sources;
          setDarkinoSources(sortedDarkinoSources);
          setDarkinoShowId(darkinoResult.darkinoId || null);
        } else {
          setDarkinoAvailable(false);
          setDarkinoSources([]);
          setDarkinoShowId(null);
        }
        setLoadingDarkino(false);

        // ========== TRAITEMENT DES RÉSULTATS DES LIENS CUSTOMS ==========
        setCustomSources(customLinksResult.customLinks || []);

        const fetchedMp4Sources: { url: string; label?: string; language?: string; isVip?: boolean }[] = customLinksResult.mp4Links || [];
        setMp4Sources(fetchedMp4Sources);

        // ========== TRAITEMENT DES RÉSULTATS DE FREMBED ==========
        setFrembedAvailable(frembedAvailabilityResult);

        // ========== TRAITEMENT DES RÉSULTATS COFLIX ==========
        if (coflixResult) {
          console.log('Coflix data received:', coflixResult);
          if (coflixResult?.current_episode &&
            (coflixResult?.current_episode?.iframe_src ||
              (coflixResult?.current_episode?.player_links && coflixResult?.current_episode?.player_links.length > 0))) {
            setCoflixData(coflixResult.current_episode);
          } else if (coflixResult?.iframe_src || (coflixResult?.player_links && coflixResult?.player_links.length > 0)) {
            setCoflixData(coflixResult);
          }
        }

        // ========== INITIALISATION DES CONTAINERS POUR SOURCES EXTRAITES ==========
        let finalHlsSources: SeekStreamingHlsSource[] = [];
        let finalFileSources: { url: string; label: string }[] = [];
        let localBravoSources: { url: string; label: string }[] = [];

        // ========== PURSTREAM (BRAVO) SOURCES (réservé VIP/extension) ==========
        if (purstreamResult && purstreamResult.sources && purstreamResult.sources.length > 0) {
          console.log('?? Processing PurStream (Bravo) result:', purstreamResult.sources.length, 'sources');
          const rawBravo = purstreamResult.sources
            .filter((s: { url: string; name: string; format: string }) => s.url)
            .map((s: { url: string; name: string; format: string }) => ({
              url: s.url,
              label: (s.name || 'HLS').replace(/^pur\s*\|\s*/i, '').replace(/\s*\|\s*/g, ' - '),
            }));
          // Pré-tri par priorité hoster (M4) avec fallback raw si tous unknown.
          const prefsBv0 = getSourcePriorityPrefs();
          const annotatedBravo = rawBravo.map((s) => ({
            ...s,
            type: (detectHoster(s.url || '', {
              patternOverrides: prefsBv0.patternOverrides,
              customHosters: prefsBv0.customHosters,
            }) ?? detectHoster(s.label || '', {
              patternOverrides: prefsBv0.patternOverrides,
              customHosters: prefsBv0.customHosters,
            })) ?? 'unknown',
          }));
          const allUnknown = annotatedBravo.every((s) => s.type === 'unknown');
          localBravoSources = allUnknown
            ? rawBravo
            : (sortHostersByPriority(annotatedBravo, { category: 'moviesTv', topLevel: 'bravo' }) as typeof rawBravo);
          // Stocker les sources brutes — la gate canUseBravo est appliquée au
          // render. Évite une race au mount où isExtensionAvailable() n'a pas
          // encore vu l'extension/userscript injecter ses flags et bloquerait
          // définitivement les sources même quand l'injection finit par arriver.
          setPurstreamSources(localBravoSources);
          console.log(`? PurStream (Bravo) sources set: ${localBravoSources.length}`);
        }

        // Add supervideo and dropload HLS sources if available (LOWER PRIORITY)
        if (rawOmegaData) {
          console.log('?? Processing Omega result for supervideo/dropload extraction...');
          const omegaPlayers = extractOmegaPlayers(rawOmegaData, seasonNumber, episodeNumber);

          // Paralléliser les extractions Omega
          const omegaExtractionPromises = [];

          const supervideo = omegaPlayers.find((p: any) => p.player && p.player.toLowerCase().includes('supervideo'));
          if (supervideo) {
            console.log('?? Found supervideo player:', supervideo);
            omegaExtractionPromises.push(
              extractM3u8FromEmbed(supervideo, MAIN_API).then(result => ({
                type: 'supervideo',
                result,
                label: 'Supervideo HLS 720p'
              }))
            );
          }

          const dropload = omegaPlayers.find((p: any) => p.player && p.player.toLowerCase().includes('dropload'));
          if (dropload) {
            console.log('?? Found dropload player:', dropload);
            omegaExtractionPromises.push(
              extractM3u8FromEmbed(dropload, MAIN_API).then(result => ({
                type: 'dropload',
                result,
                label: 'Dropload HLS 720p'
              }))
            );
          }

          if (omegaExtractionPromises.length > 0) {
            const omegaResults = await Promise.all(omegaExtractionPromises);
            omegaResults.forEach(({ type, result, label }) => {
              if (type === 'supervideo' && result?.success && result.hlsUrl) {
                finalHlsSources = [...finalHlsSources, { url: result.hlsUrl, label }];
                console.log(`? Added ${label} source:`, result.hlsUrl);
              } else if (type === 'dropload' && result?.success && result.m3u8Url) {
                finalHlsSources = [...finalHlsSources, { url: result.m3u8Url, label }];
                console.log(`? Added ${label} source:`, result.m3u8Url);
              }
            });
          }
        }

        // Process Firebase dropload links for m3u8 extraction
        if (customLinksResult.customLinks && customLinksResult.customLinks.length > 0) {
          console.log('?? Processing Firebase custom links for dropload extraction...');
          const droploadLinks = customLinksResult.customLinks.filter(url => url.toLowerCase().includes('dropload'));

          // Paralléliser les extractions dropload Firebase
          if (droploadLinks.length > 0) {
            const droploadPromises = droploadLinks.map(async (droploadUrl) => {
              console.log('?? Processing Firebase dropload link:', droploadUrl);
              try {
                const droploadResult = await extractM3u8FromEmbed({
                  player: 'dropload',
                  link: droploadUrl
                }, MAIN_API);
                console.log('?? Firebase Dropload extraction result:', droploadResult);
                if (droploadResult?.success && droploadResult.m3u8Url) {
                  return { url: droploadResult.m3u8Url, label: 'Dropload HLS 720p' };
                }
              } catch (error) {
                console.error('? Error extracting m3u8 from Firebase dropload link:', error);
              }
              return null;
            });

            const droploadResults = await Promise.all(droploadPromises);
            const validDroploadResults = droploadResults.filter(result => result !== null);
            finalHlsSources = [...finalHlsSources, ...validDroploadResults];
            console.log(`? Added ${validDroploadResults.length} Firebase Dropload HLS sources`);
          }
        }

        // Process Firebase custom links — passe d'extraction générique
        if (customLinksResult.customLinks && customLinksResult.customLinks.length > 0) {
          const customPass = await runExtractionPass(
            customLinksResult.customLinks
              .filter((url: unknown): url is string => typeof url === 'string' && !!url)
              .map((url: string) => ({ url })),
            MAIN_API,
            {
              origin: 'custom',
              context: { category: 'moviesTv', topLevel: 'custom' },
            },
          );
          finalHlsSources = [...finalHlsSources, ...customPass.hls];
          finalFileSources = [...finalFileSources, ...customPass.file];
        }

        // Process Coflix MULTI links — passe d'extraction générique (ignore Omega)
        if (coflixResult) {
          const multiLinks = (coflixResult.current_episode && coflixResult.current_episode.player_links)
            ? coflixResult.current_episode.player_links
            : (coflixResult.player_links || []);

          const coflixPass = await runExtractionPass(
            multiLinks
              .map((p: any) => ({
                url: getCoflixPreferredUrl(p),
                label: typeof p?.player === 'string' ? p.player : '',
                player: typeof p?.player === 'string' ? p.player : '',
              }))
              .filter((source: { url: string }) => !!source.url),
            MAIN_API,
            {
              origin: 'coflix',
              context: { category: 'moviesTv', topLevel: 'coflix' },
            },
          );
          finalHlsSources = [...finalHlsSources, ...coflixPass.hls];
          finalFileSources = [...finalFileSources, ...coflixPass.file];
        }


        console.log('?? Final HLS sources after supervideo/dropload processing:', finalHlsSources);

        // ========== TRAITEMENT DES RÉSULTATS FSTREAM ==========
        let fstreamProcessedSources: { url: string; label: string; category: string }[] = [];
        const fstreamHlsSources: { url: string; label: string; category: string }[] = [];
        const fsvidSources: { url: string; label: string; category: string }[] = [];

        // Check if user is VIP (déclaré au niveau de la fonction pour être accessible partout)
        const isVip = localStorage.getItem('is_vip') === 'true';

        if (fstreamResult && fstreamResult.success && fstreamResult.episodes) {

          // Get the specific episode data
          const episodeData = fstreamResult.episodes[episodeNumber.toString()];
          if (episodeData && episodeData.languages) {
            // Process all FStream language categories with priority to fsvid sources
            const categories = ['VF', 'VOSTFR', 'VOENG', 'Default'];
            const otherSources: { url: string; label: string; category: string }[] = [];

            categories.forEach(category => {
              const categoryPlayers = episodeData.languages[category] || [];
              const fsvidPlayers = categoryPlayers.filter((player: any) =>
                player.url && player.url.toLowerCase().includes('fsvid')
              );

              // Pour chaque catégorie, ne garder qu'une seule source fsvid (priorité à PREMIUM puis FSvid)
              if (fsvidPlayers.length > 0) {
                const premiumPlayer = fsvidPlayers.find((player: any) =>
                  player.player === 'PREMIUM'
                );
                const selectedFsvidPlayer = premiumPlayer || fsvidPlayers[0];

                const source = {
                  url: selectedFsvidPlayer.url,
                  label: `${category} - ${selectedFsvidPlayer.player} ${selectedFsvidPlayer.quality}`,
                  category: category,
                  // Rempli par mainapi quand il a déjà résolu la source.
                  m3u8Url: selectedFsvidPlayer.m3u8Url
                };

                fsvidSources.push(source);
              }

              // Traiter les autres sources (non-fsvid)
              const otherPlayers = categoryPlayers.filter((player: any) =>
                !player.url || !player.url.toLowerCase().includes('fsvid')
              );

              otherPlayers.forEach((player: any) => {
                const source = {
                  url: player.url,
                  label: `${category} - ${player.player} ${player.quality}`,
                  category: category,
                  // Rempli par mainapi quand il a déjà résolu la source.
                  m3u8Url: player.m3u8Url
                };
                otherSources.push(source);
              });
            });

            // Pour l'affichage dans le menu : utiliser seulement les sources non-fsvid
            // Pour l'extraction M3U8 : utiliser toutes les sources (fsvid + autres) si VIP
            fstreamProcessedSources = [...otherSources];
          }

          console.log('? FStream TV sources processed:', fstreamProcessedSources.length);
          console.log('?? FStream fsvid sources found:', fsvidSources.length);

          // =========== EXTRACTION M3U8 DES SOURCES FSTREAM ===========
          console.log('?? Extracting M3U8 from FStream TV sources...');

          // Paralléliser les extractions M3U8 pour vidzy, fsvid et uqload
          const fstreamExtractionPromises: Promise<{ type: string; result: M3u8Result | null; originalSource: { url: string; label: string; category: string } }>[] = [];

          // mainapi a pu résoudre la source côté serveur (extraction par
          // épisode) : dans ce cas on réutilise sa m3u8 signée au lieu de
          // relancer une extraction. Renvoie null si rien n'a été pré-résolu.
          const serverResolvedSource = (
            source: { url: string; label: string; category: string; m3u8Url?: string },
            type: string
          ) => (
            source.m3u8Url
              ? Promise.resolve({
                  type,
                  result: { m3u8Url: source.m3u8Url, success: true } as M3u8Result,
                  originalSource: source
                })
              : null
          );

          // Extraire M3U8 des sources vidzy
          const vidzySources = fstreamProcessedSources.filter(source =>
            source.url.toLowerCase().includes('vidzy')
          );

          if (vidzySources.length > 0) {
            console.log(`?? Found ${vidzySources.length} vidzy sources, extracting M3U8...`);
            vidzySources.forEach(vidzySource => {
              fstreamExtractionPromises.push(
                serverResolvedSource(vidzySource, 'vidzy') ??
                extractVidzyM3u8(vidzySource.url, MAIN_API).then(result => ({
                  type: 'vidzy',
                  result,
                  originalSource: vidzySource
                }))
              );
            });
          }

          // Extraire M3U8 des sources fsvid (VIP ou extension locale)
          if ((isVip || isExtensionAvailable()) && fsvidSources.length > 0) {
            console.log(`?? Found ${fsvidSources.length} fsvid sources, extracting M3U8...`);
            fsvidSources.forEach(fsvidSource => {
              fstreamExtractionPromises.push(
                serverResolvedSource(fsvidSource, 'fsvid') ??
                extractFsvidM3u8(fsvidSource.url, MAIN_API).then(result => ({
                  type: 'fsvid',
                  result,
                  originalSource: fsvidSource
                }))
              );
            });
          }

          // Extraire M3U8 des sources uqload
          const uqloadSources = fstreamProcessedSources.filter(source =>
            source.url.toLowerCase().includes('uqload')
          );

          if (uqloadSources.length > 0) {
            console.log(`?? Found ${uqloadSources.length} uqload sources, extracting M3U8...`);
            uqloadSources.forEach(uqloadSource => {
              fstreamExtractionPromises.push(
                serverResolvedSource(uqloadSource, 'uqload') ??
                extractUqloadFile(normalizeUqloadEmbedUrl(uqloadSource.url), MAIN_API).then(result => ({
                  type: 'uqload',
                  result,
                  originalSource: uqloadSource
                }))
              );
            });
          }

          if (fstreamExtractionPromises.length > 0) {
            const fstreamExtractionResults = await Promise.all(fstreamExtractionPromises);

            // Séparer les sources fsvid, vidzy et uqload pour les ordonner correctement
            const fsvidHlsSources: { url: string; label: string; category: string }[] = [];
            const vidzyHlsSources: { url: string; label: string; category: string }[] = [];
            const uqloadHlsSources: { url: string; label: string; category: string }[] = [];

            fstreamExtractionResults.forEach(({ type, result, originalSource }) => {
              if (type === 'fsvid' && result?.success && result.m3u8Url) {
                // Vérifier si une source fsvid pour cette catégorie existe déjà
                const existingFsvid = fsvidHlsSources.find(s => s.category === originalSource.category);
                if (!existingFsvid) {
                  fsvidHlsSources.push({
                    url: result.m3u8Url,
                    label: `${originalSource.category} - Fsvid HLS`,
                    category: originalSource.category
                  });
                  console.log(`? Added Fsvid HLS source: ${result.m3u8Url}`);
                } else {
                  console.log(`?? Skipping duplicate Fsvid HLS source for category ${originalSource.category}`);
                }
              } else if (type === 'vidzy' && result?.success && result.m3u8Url) {
                vidzyHlsSources.push({
                  url: result.m3u8Url,
                  label: `${originalSource.category} - Vidzy HLS`,
                  category: originalSource.category
                });
                console.log(`? Added Vidzy HLS source: ${result.m3u8Url}`);
              } else if (type === 'uqload' && result?.success && result.m3u8Url) {
                uqloadHlsSources.push({
                  url: result.m3u8Url,
                  label: `${originalSource.category} - UQLOAD HLS`,
                  category: originalSource.category
                });
                console.log(`? Added UQLOAD HLS source: ${result.m3u8Url}`);
              }
            });

            // Ajouter fsvid en premier, puis vidzy, puis uqload
            fstreamHlsSources.push(...fsvidHlsSources, ...vidzyHlsSources, ...uqloadHlsSources);
          }

          console.log(`?? FStream TV HLS sources extracted: ${fstreamHlsSources.length}`);
        } else {
          setFstreamData(null);
          console.log('? No FStream TV sources available');
        }

        setFstreamSources(fstreamProcessedSources);

        // =========== TRAITEMENT DES RÉSULTATS WIFLIX (LYNX) ===========
        let wiflixProcessedSources: { url: string; label: string; category: string }[] = [];

        if (wiflixResult && wiflixResult.success && wiflixResult.episodes) {
          console.log('?? Processing Wiflix/Lynx TV result:', wiflixResult);
          setWiflixData(wiflixResult);

          // Get the specific episode data
          const episodeData = wiflixResult.episodes[episodeNumber.toString()];
          if (episodeData) {
            // Process Wiflix categories with priority to VF sources
            const categories = ['vf', 'vostfr'];
            const vfSources: { url: string; label: string; category: string }[] = [];
            const vostfrSources: { url: string; label: string; category: string }[] = [];

            categories.forEach(category => {
              const categoryPlayers = episodeData[category as keyof typeof episodeData] || [];
              categoryPlayers.forEach((player: any) => {
                const source = {
                  url: player.url,
                  label: `Lynx ${category.toUpperCase()} - ${player.name}`,
                  category: category.toUpperCase()
                };

                if (category === 'vf') {
                  vfSources.push(source);
                } else {
                  vostfrSources.push(source);
                }
              });
            });

            // Mettre les sources VF en premier
            wiflixProcessedSources = [...vfSources, ...vostfrSources];

            console.log('? Wiflix/Lynx TV sources processed:', wiflixProcessedSources.length);
            console.log('?? Wiflix VF sources found:', vfSources.length);
          }
        } else {
          setWiflixData(null);
          console.log('? No Wiflix/Lynx TV sources available');
        }

        setWiflixSources(wiflixProcessedSources);
        console.log('?? [WatchTv] Wiflix/Lynx TV sources set:', wiflixProcessedSources.length, wiflixProcessedSources);

        // =========== TRAITEMENT DES RÉSULTATS J1F (1JOUR1FILM) ===========
        let j1fProcessedSources: { url: string; label: string; category: string }[] = [];

        if (j1fResult && j1fResult.success && j1fResult.episodes) {
          setJ1fData(j1fResult);
          const episodeData = j1fResult.episodes[episodeNumber.toString()];
          if (episodeData) {
            const categories = ['vf', 'vostfr'];
            const vfSources: { url: string; label: string; category: string }[] = [];
            const vostfrSources: { url: string; label: string; category: string }[] = [];
            categories.forEach(category => {
              const categoryPlayers = episodeData[category as keyof typeof episodeData] || [];
              categoryPlayers.forEach((player: any) => {
                const source = {
                  url: player.url,
                  label: `1J1F ${category.toUpperCase()} - ${player.name}`,
                  category: category.toUpperCase(),
                };
                if (category === 'vf') vfSources.push(source);
                else vostfrSources.push(source);
              });
            });
            j1fProcessedSources = [...vfSources, ...vostfrSources];
          }
        } else {
          setJ1fData(null);
        }

        setJ1fSources(j1fProcessedSources);

        // --- Passe d'extraction m3u8 générique (tous hosters supportés) ---
        if (j1fProcessedSources.length > 0) {
          const j1fPass = await runExtractionPass(j1fProcessedSources, MAIN_API, {
            origin: 'j1f',
            context: { category: 'moviesTv', topLevel: 'j1f' },
          });
          finalHlsSources = [...finalHlsSources, ...j1fPass.hls];
          finalFileSources = [...finalFileSources, ...j1fPass.file];
        }
        console.log('?? [WatchTv] 1jour1film TV sources set:', j1fProcessedSources.length);

        // =========== TRAITEMENT DES RÉSULTATS SWIFTFLOW ===========
        let swiftflowProcessedSources: { url: string; label: string; category: string }[] = [];

        if (swiftflowResult && swiftflowResult.success && swiftflowResult.episodes) {
          setSwiftflowData(swiftflowResult);
          const episodeData = swiftflowResult.episodes[episodeNumber.toString()];
          if (episodeData) {
            const categories = ['vf', 'vostfr'];
            const vfSources: { url: string; label: string; category: string }[] = [];
            const vostfrSources: { url: string; label: string; category: string }[] = [];
            categories.forEach(category => {
              const categoryPlayers = episodeData[category as keyof typeof episodeData] || [];
              categoryPlayers.forEach((player: any) => {
                const source = {
                  url: player.url,
                  label: `SwiftFlow ${category.toUpperCase()}${player.label ? ` - ${player.label}` : ''}`,
                  category: category.toUpperCase(),
                };
                if (category === 'vf') vfSources.push(source);
                else vostfrSources.push(source);
              });
            });
            swiftflowProcessedSources = [...vfSources, ...vostfrSources];
          }
        } else {
          setSwiftflowData(null);
        }

        setSwiftflowSources(swiftflowProcessedSources);

        // --- Passe d'extraction m3u8 générique (tous hosters supportés) ---
        if (swiftflowProcessedSources.length > 0) {
          const swiftflowPass = await runExtractionPass(swiftflowProcessedSources, MAIN_API, {
            origin: 'swiftflow',
            context: { category: 'moviesTv', topLevel: 'swiftflow' },
          });
          finalHlsSources = [...finalHlsSources, ...swiftflowPass.hls];
          finalFileSources = [...finalFileSources, ...swiftflowPass.file];
        }
        console.log('[WatchTv] SwiftFlow TV sources set:', swiftflowProcessedSources.length);

        // =========== EXTRACTION M3U8 DEPUIS WIFLIX TV (passe générique) ===========
        // Remplace les anciens blocs voe / uqload / doodstream / seekstreaming
        // écrits à la main : `runExtractionPass` route chaque lien vers
        // l'extracteur correspondant, donc tout hoster supporté est couvert.
        if (wiflixProcessedSources.length > 0) {
          const wiflixPass = await runExtractionPass(wiflixProcessedSources, MAIN_API, {
            origin: 'wiflix',
            context: { category: 'moviesTv', topLevel: 'wiflix' },
          });
          // VF devant, VOSTFR derrière — l'ordre historique de ce bloc.
          finalHlsSources = [
            ...wiflixPass.hls.filter(s => !s.isVostfr),
            ...finalHlsSources,
            ...wiflixPass.hls.filter(s => s.isVostfr),
          ];
          finalFileSources = [
            ...wiflixPass.file.filter(s => !s.isVostfr),
            ...finalFileSources,
            ...wiflixPass.file.filter(s => s.isVostfr),
          ];
        }

        // =========== TRAITEMENT DES RÉSULTATS VIPER ===========
        const viperProcessedSources: { url: string; label: string; quality: string; language: string }[] = [];
        if (viperResult && viperResult.links) {
          console.log('?? Processing Viper TV result:', viperResult);
          setViperData(viperResult);

          const vfLinks = viperResult.links.vf || [];
          const vostfrLinks = viperResult.links.vostfr || [];

          vfLinks.forEach((link: { server: string; url: string }) => {
            viperProcessedSources.push({
              url: link.url,
              label: link.server,
              quality: 'HD',
              language: 'VF'
            });
          });

          vostfrLinks.forEach((link: { server: string; url: string }) => {
            viperProcessedSources.push({
              url: link.url,
              label: link.server,
              quality: 'HD',
              language: 'VOSTFR'
            });
          });

          setViperSources(viperProcessedSources);
          console.log(`? Viper TV sources processed: ${viperProcessedSources.length}`);

          // =========== EXTRACTION M3U8 DEPUIS VIPER (passe générique) ===========
          if (viperProcessedSources.length > 0) {
            const viperPass = await runExtractionPass(viperProcessedSources, MAIN_API, {
              origin: 'viper',
              context: { category: 'moviesTv', topLevel: 'viper' },
            });
            // VF devant, VOSTFR derrière — l'ordre historique de ce bloc.
            finalHlsSources = [
              ...viperPass.hls.filter(s => !s.isVostfr),
              ...finalHlsSources,
              ...viperPass.hls.filter(s => s.isVostfr),
            ];
            finalFileSources = [
              ...viperPass.file.filter(s => !s.isVostfr),
              ...finalFileSources,
              ...viperPass.file.filter(s => s.isVostfr),
            ];
          }
        } else {
          setViperData(null);
          setViperSources([]);
        }

        // =========== TRAITEMENT DES RÉSULTATS VOX ===========
        let voxProcessedSources: { name: string; link: string }[] = [];
        if (voxResult && voxResult.success && voxResult.data && voxResult.data.length > 0) {
          console.log('Vox sources found:', voxResult.data.length);
          setVoxData(voxResult);
          voxProcessedSources = voxResult.data;
          setVoxSources(voxProcessedSources);

          // =========== EXTRACTION M3U8 DEPUIS VOX (passe générique) ===========
          // Vox n'extrayait que voe et vidmoly ; la passe couvre tous les hosters.
          if (voxProcessedSources.length > 0) {
            const voxPass = await runExtractionPass(
              voxProcessedSources.map(source => ({ url: source.link, label: source.name })),
              MAIN_API,
              {
                origin: 'vox',
                context: { category: 'moviesTv', topLevel: 'vox' },
              },
            );
            finalHlsSources = [...finalHlsSources, ...voxPass.hls];
            finalFileSources = [...finalFileSources, ...voxPass.file];
          }
        } else {
          console.log('Vox source not available from API');
          setVoxData(null);
          setVoxSources([]);
        }

        // Ajouter les sources HLS FStream aux sources finales
        if (fstreamHlsSources.length > 0) {
          // Prioriser les sources VF puis Default pour FStream HLS
          const fsvidVfSources = fstreamHlsSources.filter(s => s.category === 'VF');
          const fsvidDefaultSources = fstreamHlsSources.filter(s => s.category === 'Default');
          const fsvidOtherSources = fstreamHlsSources.filter(s => s.category !== 'VF' && s.category !== 'Default');

          const prioritizedFstreamHls = [...fsvidVfSources, ...fsvidDefaultSources, ...fsvidOtherSources];
          finalHlsSources = [...prioritizedFstreamHls, ...finalHlsSources];
          console.log(`?? Added ${fstreamHlsSources.length} FStream TV HLS sources to final sources`);
        }

        // Set the final sources
        setNexusHlsSources(finalHlsSources);
        setNexusFileSources(finalFileSources);

        // =========== FIN DES EXTRACTIONS ===========
        console.log('? Extractions M3U8 terminées');
        setLoadingExtractions(false);

        // Check for Sibnet links for anime
        if (show.genres.some((genre: any) => genre.id === 16)) { // 16 is Animation genre
          setLoadingSibnet(true);
          try {
            const sibnetVideoId = extractSibnetIdFromUrl();
            if (sibnetVideoId) {
              const sibnetSourceUrl = await checkSibnetAvailability(sibnetVideoId);
              setSibnetUrl(sibnetSourceUrl);
            }
          } catch (error) {
            console.error('Error checking Sibnet availability:', error);
          } finally {
            setLoadingSibnet(false);
          }
        }

        // ========== DETERMINE DEFAULT SELECTED SOURCE (priority-driven) ==========
        // L'ordre est piloté par `pickAutoSelectedSource` qui lit les prefs utilisateur.
        // Par défaut (prefs vides) → ordre hardcodé historique, 100% rétrocompat.
        //
        // Legacy priority pour référence :
        // nexus_hls > [embedseek custom promu] > nexus_file > bravo > mp4 > darkino >
        // omega (supervideo) > wiflix > viper > adFree (m3u8) > mp4 (dup) > fstream >
        // omega (deep fallback) > wiflix/viper (deep) > coflix (multi) > fstream (deep) >
        // custom > frembed > vox > vostfr

        console.log('=== INITIALFETCH SOURCE PRIORITY LOGIC ===');
        console.log('Final HLS sources (Nexus + extracted):', finalHlsSources.length);
        console.log('Final File sources (Nexus + extracted):', finalFileSources.length);
        console.log('Darkino available:', darkinoResult && typeof darkinoResult === 'object' ? darkinoResult.available : false);
        console.log('Darkino sources count:', darkinoResult && typeof darkinoResult === 'object' ? darkinoResult.sources?.length : 0);
        console.log('MP4 sources count:', fetchedMp4Sources.length);
        console.log('Viper sources count:', viperProcessedSources.length);
        console.log('FStream sources count:', fstreamProcessedSources.length);
        console.log('AdFree M3U8 URL:', adFreeM3u8Url);
        console.log('Custom sources available:', customLinksResult.customLinks?.length || 0);

        // Vérifier si un lien embedseek existe dans les custom sources.
        // Legacy : embedseek custom était promu EN TÊTE (juste après nexus_hls).
        // Nouveau : on le garde comme pré-check de la priorité pour préserver le comportement
        // tel-quel tant que la priorité user n'a pas été configurée (rétrocompat 100%).
        const embedseekLink = customLinksResult.customLinks?.find((link: string) =>
          link.toLowerCase().includes('embedseek.com')
        );

        // Helper : applique la config d'embed pour l'id choisi. Close sur toutes les
        // variables locales de `initialFetch`. Retourne true si géré.
        const applyEmbedConfig = (sourceId: TopLevelSourceId): boolean => {
          switch (sourceId) {
            case 'nexus_hls': {
              console.log('✅ Selecting NEXUS HLS as primary source');
              const prefsNh = getSourcePriorityPrefs();
              const sortedHls = sortHostersByPriority(
                finalHlsSources.map((s: any) => ({
                  ...s,
                  type: s.seekKind
                    ? 'seekstreaming'
                    : ((detectHoster(s.url || '', {
                        patternOverrides: prefsNh.patternOverrides,
                        customHosters: prefsNh.customHosters,
                      }) ?? detectHoster(s.label || '', {
                        patternOverrides: prefsNh.patternOverrides,
                        customHosters: prefsNh.customHosters,
                      })) ?? 'unknown'),
                })),
                { category: 'moviesTv', topLevel: 'nexus_hls' },
              );
              const topHls = sortedHls[0];
              const idxNh = finalHlsSources.findIndex((s: any) => s.url === topHls.url);
              setSelectedSource('nexus_hls');
              setSelectedNexusHlsSource(idxNh >= 0 ? idxNh : 0);
              setVideoSource(topHls.url);
              currentSourceRef.current = 'nexus_hls';
              setEmbedUrl(null);
              setEmbedType(null);
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'nexus_file': {
              console.log('✅ Selecting NEXUS FILE as primary source');
              const prefsNf = getSourcePriorityPrefs();
              const sortedFile = sortHostersByPriority(
                finalFileSources.map((s: any) => ({
                  ...s,
                  type: (detectHoster(s.url || '', {
                    patternOverrides: prefsNf.patternOverrides,
                    customHosters: prefsNf.customHosters,
                  }) ?? detectHoster(s.label || '', {
                    patternOverrides: prefsNf.patternOverrides,
                    customHosters: prefsNf.customHosters,
                  })) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'nexus_hls' },
              );
              const topFile = sortedFile[0];
              const idxNf = finalFileSources.findIndex((s: any) => s.url === topFile.url);
              setSelectedSource('nexus_file');
              setSelectedNexusFileSource(idxNf >= 0 ? idxNf : 0);
              setVideoSource(topFile.url);
              currentSourceRef.current = 'nexus_file';
              setEmbedUrl(null);
              setEmbedType(null);
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'bravo': {
              const prefsBv = getSourcePriorityPrefs();
              const sortedBravo = sortHostersByPriority(
                localBravoSources.map((s: any) => ({
                  ...s,
                  type: (detectHoster(s.url || '', {
                    patternOverrides: prefsBv.patternOverrides,
                    customHosters: prefsBv.customHosters,
                  }) ?? detectHoster(s.label || '', {
                    patternOverrides: prefsBv.patternOverrides,
                    customHosters: prefsBv.customHosters,
                  })) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'bravo' },
              );
              const allUnknownBv = sortedBravo.every((s: any) => s.type === 'unknown');
              const bestBravo = allUnknownBv
                ? localBravoSources[localBravoSources.length - 1]
                : sortedBravo[0];
              console.log(`✅ Selecting BRAVO as default source (HLS) → ${bestBravo.label}`);
              setSelectedSource('bravo');
              setVideoSource(bestBravo.url);
              setEmbedUrl(null);
              setEmbedType(null);
              currentSourceRef.current = 'bravo';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'mp4': {
              console.log('✅ Selecting MP4 as source');
              setSelectedSource('mp4');
              setSelectedMp4Source(0);
              setVideoSource(fetchedMp4Sources[0].url);
              currentSourceRef.current = 'mp4';
              setEmbedUrl(null);
              setEmbedType(null);
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'darkino': {
              if (!darkinoResult || !darkinoResult.available || !darkinoResult.sources.length) return false;
              console.log('✅ Selecting DARKINO as source');
              const prefsDk = getSourcePriorityPrefs();
              const sortedDk = sortHostersByPriority(
                darkinoResult.sources.map((s: any) => ({
                  ...s,
                  type: (detectHoster(s.m3u8 || '', {
                    patternOverrides: prefsDk.patternOverrides,
                    customHosters: prefsDk.customHosters,
                  }) ?? detectHoster(s.label || s.quality || '', {
                    patternOverrides: prefsDk.patternOverrides,
                    customHosters: prefsDk.customHosters,
                  })) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'darkino' },
              );
              const topDk = sortedDk[0];
              const idxDk = darkinoResult.sources.findIndex((s: any) => s.m3u8 === topDk.m3u8);
              setSelectedSource('darkino');
              setSelectedDarkinoSource(idxDk >= 0 ? idxDk : 0);
              setVideoSource(topDk.m3u8);
              setEmbedUrl(null);
              setEmbedType(null);
              return true;
            }
            case 'fstream': {
              console.log('✅ Selecting FSTREAM as source');
              // Trier localement pour que l'URL choisie matche le futur sortedFstream[0]
              // (le state fstreamSources vient juste d'être set et le memo sortedFstream
              // n'a pas encore recalculé). Preserve la consistance UI ↔ embedUrl.
              const prefsFs = getSourcePriorityPrefs();
              const sortedFstreamLocal = sortHostersByPriority(
                fstreamProcessedSources.map((s) => ({
                  ...s,
                  type: detectHoster(s.url, {
                    patternOverrides: prefsFs.patternOverrides,
                    customHosters: prefsFs.customHosters,
                  }) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'fstream' },
              );
              setSelectedSource('fstream');
              setSelectedFstreamSource(0);
              setEmbedUrl(sortedFstreamLocal[0].url);
              setEmbedType('fstream');
              currentSourceRef.current = 'fstream';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'omega': {
              // Omega auto-select n'est valide que si un lecteur supervideo existe
              if (!isOmegaAvailable || !rawOmegaData) return false;
              const omegaPlayers = extractOmegaPlayers(rawOmegaData, seasonNumber, episodeNumber);
              const supervideo = omegaPlayers.find((p: any) => p.player && p.player.toLowerCase().includes('supervideo'));
              if (!supervideo) return false;
              console.log('✅ Selecting OMEGA (Supervideo) as source');
              setSelectedSource('omega');
              setEmbedUrl(supervideo.link);
              setEmbedType('omega');
              currentSourceRef.current = 'omega';
              return true;
            }
            case 'wiflix': {
              console.log('✅ Selecting WIFLIX/LYNX as source');
              // Trier localement pour que l'URL choisie matche le futur sortedWiflix[0]
              // (le state wiflixSources vient juste d'être set et le memo sortedWiflix
              // n'a pas encore recalculé). Preserve la consistance UI ↔ embedUrl.
              const prefsWf = getSourcePriorityPrefs();
              const sortedWiflixLocal = sortHostersByPriority(
                wiflixProcessedSources.map((s) => ({
                  ...s,
                  type: detectHoster(s.url, {
                    patternOverrides: prefsWf.patternOverrides,
                    customHosters: prefsWf.customHosters,
                  }) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'wiflix' },
              );
              setSelectedSource('wiflix');
              setSelectedWiflixSource(0);
              setEmbedUrl(sortedWiflixLocal[0].url);
              setEmbedType('wiflix');
              currentSourceRef.current = 'wiflix';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'j1f': {
              console.log('✅ Selecting 1JOUR1FILM as source');
              const prefsJ1f = getSourcePriorityPrefs();
              const sortedJ1fLocal = sortHostersByPriority(
                j1fProcessedSources.map((s) => ({
                  ...s,
                  type: detectHoster(s.url, {
                    patternOverrides: prefsJ1f.patternOverrides,
                    customHosters: prefsJ1f.customHosters,
                  }) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'j1f' },
              );
              setSelectedSource('j1f');
              setSelectedJ1fSource(0);
              setEmbedUrl(sortedJ1fLocal[0].url);
              setEmbedType('j1f');
              currentSourceRef.current = 'j1f';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'swiftflow': {
              console.log('✅ Selecting SWIFTFLOW as source');
              const prefsSwiftflow = getSourcePriorityPrefs();
              const sortedSwiftflowLocal = sortHostersByPriority(
                swiftflowProcessedSources.map((s) => ({
                  ...s,
                  type: detectHoster(s.url, {
                    patternOverrides: prefsSwiftflow.patternOverrides,
                    customHosters: prefsSwiftflow.customHosters,
                  }) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'swiftflow' },
              );
              setSelectedSource('swiftflow');
              setSelectedSwiftflowSource(0);
              setEmbedUrl(sortedSwiftflowLocal[0].url);
              setEmbedType('swiftflow');
              currentSourceRef.current = 'swiftflow';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'swiftflux': {
              if (!swiftfluxResult.available) return false;
              // Aucune URL à poser : la porte d'entrée la demandera au serveur
              // une fois la pub vue et le Turnstile validé.
              setSelectedSource('swiftflux');
              setVideoSource('');
              setEmbedUrl(null);
              setEmbedType(null);
              currentSourceRef.current = 'swiftflux';
              setOnlyVostfrAvailable(false);
              setSwiftfluxGateOpen(true);
              return true;
            }
            case 'viper': {
              console.log('✅ Selecting VIPER as source');
              // Pré-tri langue + hoster pour respecter la préférence user
              // (ex. VOSTFR > VF, puis voe > vidmoly > …).
              const prefsV = getSourcePriorityPrefs();
              const sortedViperLocal = sortHostersByPriority(
                viperProcessedSources.map((s) => ({
                  ...s,
                  type: detectHoster(s.url, {
                    patternOverrides: prefsV.patternOverrides,
                    customHosters: prefsV.customHosters,
                  }) ?? 'unknown',
                })),
                { category: 'moviesTv', topLevel: 'viper' },
              );
              setSelectedSource('viper' as any);
              setSelectedViperSource(0);
              setEmbedUrl(sortedViperLocal[0].url);
              setEmbedType('viper');
              currentSourceRef.current = 'viper';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'coflix': {
              // Coflix auto-select n'est valide que si multi links existent
              let multiLinks: any[] = [];
              if (coflixResult) {
                multiLinks = (coflixResult.current_episode && coflixResult.current_episode.player_links)
                  ? coflixResult.current_episode.player_links
                  : coflixResult.player_links || [];
              }
              if (!multiLinks.length) return false;
              // Préserver l'ancien comportement : si pas de lecteur6 ET des mp4 dispo,
              // on préfère mp4 plutôt que coflix (fallback spécial legacy).
              const hasLecteur6 = multiLinks.some((p: any) => getCoflixPreferredUrl(p).toLowerCase().includes('lecteur6'));
              if (!hasLecteur6 && fetchedMp4Sources.length > 0) {
                // Fall through : signal au picker de retomber sur MP4
                return false;
              }
              const preferred = multiLinks.find((p: any) =>
                (p.language && typeof p.language === 'string' && p.language.toLowerCase().includes('french')) ||
                (p.quality && typeof p.quality === 'string' && p.quality.toLowerCase().includes('french')) ||
                getCoflixPreferredUrl(p).toLowerCase().includes('lecteur6')
              ) || multiLinks[0];
              const url = getCoflixPreferredUrl(preferred);
              console.log('✅ Selecting COFLIX as source');
              setSelectedSource('coflix');
              setEmbedUrl(url);
              setEmbedType('coflix');
              currentSourceRef.current = 'coflix';
              return true;
            }
            case 'custom': {
              if (!customLinksResult.customLinks || !customLinksResult.customLinks.length) return false;
              // Legacy : embedseek est promu vers le haut ; sinon 1er custom link
              const url = embedseekLink ?? customLinksResult.customLinks[0];
              console.log(embedseekLink
                ? `✅ Selecting EMBEDSEEK (Custom) — URL: ${url}`
                : '✅ Selecting CUSTOM as source');
              setSelectedSource('custom');
              setEmbedUrl(url);
              setEmbedType('custom');
              currentSourceRef.current = 'custom';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'frembed': {
              if (!frembedAvailabilityResult) return false;
              console.log('✅ Selecting FREMBED as source');
              setSelectedSource('frembed');
              setEmbedUrl(`${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}`);
              setEmbedType('frembed');
              currentSourceRef.current = 'frembed';
              return true;
            }
            case 'vox': {
              if (!voxProcessedSources.length) return false;
              console.log('✅ Selecting VOX as source');
              setSelectedSource('vox');
              setSelectedVoxSource(0);
              setEmbedUrl(voxProcessedSources[0].link);
              setEmbedType('vox');
              currentSourceRef.current = 'vox';
              setOnlyVostfrAvailable(false);
              return true;
            }
            case 'kisskh': {
              const source = kisskhResult?.sources[0];
              if (!kisskhRequestIsCurrent || !source || !['hls', 'mp4'].includes(source.type)) return false;
              setSelectedSource('kisskh');
              setVideoSource(source.url);
              setEmbedUrl(null);
              setEmbedType(null);
              currentSourceRef.current = 'kisskh';
              setOnlyVostfrAvailable(false);
              return true;
            }
            // Les ids restants (vostfr) ne sont pas auto-select
            // pour les séries (vostfr est le fallback final).
            default:
              return false;
          }
        };

        // Legacy embedseek promotion : si embedseek existe ET nexus_hls n'est pas dispo,
        // il était promu #2 dans l'ancien code (juste après nexus_hls). On applique cette
        // règle avant le picker pour préserver la rétrocompat exacte.
        // Exceptions :
        //  - un lecteur Viblix (source `mp4`) passe devant : la promotion
        //    court-circuitait le picker et sélectionnait `custom` alors que `mp4`
        //    est classé bien avant `custom` dans l'ordre par défaut ;
        //  - si l'user a customisé l'ordre (pin ou drag), on laisse le picker.
        let embedseekPromoted = false;
        if (embedseekLink && finalHlsSources.length === 0 && fetchedMp4Sources.length === 0) {
          const prefs = getSourcePriorityPrefs();
          const userOrderIds = prefs.categories.moviesTv.sourceOrder.map((s) => s.id);
          const defaultOrderIds = buildDefaults().categories.moviesTv.sourceOrder.map((s) => s.id);
          const hasUserCustomized = prefs.categories.moviesTv.pinnedSource !== null
            || userOrderIds.length !== defaultOrderIds.length
            || userOrderIds.some((id, i) => id !== defaultOrderIds[i]);
          if (!hasUserCustomized) {
            applyEmbedConfig('custom');
            embedseekPromoted = true;
          }
        }

        if (!embedseekPromoted) {
          // Priority-driven auto-select. Availability construite à partir des sources locales.
          const availability: SourceAvailability[] = [
            { id: 'nexus_hls', hasData: finalHlsSources.length > 0 },
            { id: 'nexus_file', hasData: finalFileSources.length > 0 },
            { id: 'bravo', hasData: localBravoSources.length > 0 && canUseBravo },
            { id: 'mp4', hasData: fetchedMp4Sources.length > 0 },
            { id: 'darkino', hasData: !!(darkinoResult && darkinoResult.available && darkinoResult.sources.length > 0) },
            { id: 'fstream', hasData: fstreamProcessedSources.length > 0 },
            { id: 'omega', hasData: !!(isOmegaAvailable && rawOmegaData) },
            { id: 'wiflix', hasData: wiflixProcessedSources.length > 0 },
            { id: 'j1f', hasData: j1fProcessedSources.length > 0 },
            { id: 'swiftflow', hasData: swiftflowProcessedSources.length > 0 },
            { id: 'swiftflux', hasData: swiftfluxResult.available },
            { id: 'viper', hasData: viperProcessedSources.length > 0 },
            { id: 'coflix', hasData: !!(coflixResult && (coflixResult.current_episode?.player_links?.length || coflixResult.player_links?.length)) },
            { id: 'custom', hasData: !!(customLinksResult.customLinks && customLinksResult.customLinks.length) },
            { id: 'frembed', hasData: !!frembedAvailabilityResult },
            { id: 'vox', hasData: voxProcessedSources.length > 0 },
            { id: 'kisskh', hasData: kisskhRequestIsCurrent && !!kisskhResult?.sources.length },
            { id: 'vostfr', hasData: false },
          ];

          let applied = false;
          const availList: SourceAvailability[] = [...availability];
          for (let i = 0; i < availList.length; i++) {
            const pick = pickAutoSelectedSource(availList);
            if (!pick) break;
            if (applyEmbedConfig(pick)) {
              applied = true;
              break;
            }
            // applyEmbedConfig false → retirer ce candidat et retry
            const idx = availList.findIndex((a) => a.id === pick);
            if (idx >= 0) availList[idx] = { ...availList[idx], hasData: false };
          }

          if (!applied) {
            // Fallback final : vostfr
            setSelectedSource('vostfr');
            setOnlyVostfrAvailable(true);
            currentSourceRef.current = 'vostfr';
          }
        }

        // Get next episode info
        // This try-catch is for fetchNextEpisodeData only
        try {
          await fetchNextEpisodeData();
        } catch (error) {
          console.error('Error fetching next episode:', error);
        }

        setIsLoading(false);
      } catch (error) { // This catch belongs to the main try block starting after initialFetch declaration
        console.error("Error loading TV data:", error);
        setLoadingError(true);
        setLoadingText(t('watch.dataLoadError'));
        setLoadingExtractions(false);
        setIsLoading(false);
      } // End of main try-catch block
    }; // End of initialFetch function

    initialFetch();
    return () => {
      kisskhController.abort();
      if (kisskhRequestAbortRef.current === kisskhController) {
        kisskhRequestAbortRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, seasonNumber, episodeNumber]); // Rerun if essential params change

  // Progress saving functionality removed

  // --- Event Listener for Source Changes from HLSPlayer Menu ---
  useEffect(() => {
    const handleSourceChangeFromMenu = (event: CustomEvent) => {
      const { type, url, origin, fromSrc } = event.detail as { type: PlayerSourceType | string, url: string, id?: string | number, origin?: string, fromSrc?: string };
      const isAutomaticFallback =
        typeof origin === 'string' && origin.includes('auto-fallback');
      const isKisskhFallbackCompletion = origin === 'kisskh-fallback';

      // Reject stale auto-fallback events whose originating src no longer matches
      // the currently-active player URL. This prevents a late error handler from
      // a previously-selected player reverting a user's manual switch.
      if ((isAutomaticFallback || isKisskhFallbackCompletion) && typeof fromSrc === 'string' && fromSrc) {
        if (fromSrc !== currentActiveUrlRef.current) {
          console.log(
            `[WatchTv] Ignoring stale auto-fallback sourceChange (from=${fromSrc.substring(0, 80)} current=${currentActiveUrlRef.current.substring(0, 80)})`
          );
          return;
        }
      }

      // SwiftFlux se sélectionne sans URL : elle n'existe pas encore côté
      // client. On repasse par la porte d'entrée, qui la demandera au serveur
      // une fois la pub vue et le Turnstile validé.
      if (type === 'swiftflux') {
        if (!isAutomaticFallback) setLastPlayer('swiftflux');
        setShowEmbedQuality(false);
        // Déjà débloquée pour cet épisode : rien à redemander, on bascule.
        if (swiftfluxPlayback) {
          setOnlyVostfrAvailable(false);
          setEmbedUrl(null);
          setEmbedType(null);
          setVideoSource('');
          currentSourceRef.current = 'swiftflux';
          setSelectedSource('swiftflux');
          return;
        }
        // Sinon on ouvre la porte SANS toucher à la source courante : ce qui
        // joue continue derrière, et refermer la porte n'a rien cassé.
        setSwiftfluxGateOpen(true);
        return;
      }

      const bravoAllowed = type !== 'bravo' || canUseBravo;

      const acceptedPlaybackUrl = (() => {
        switch (type) {
          case 'nexus_hls':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: nexusHlsSources.map(source => source.url),
              fallback: 'first',
            });
          case 'nexus_file':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: nexusFileSources.map(source => source.url),
              fallback: 'first',
            });
          case 'darkino':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: darkinoSources.map(source => source.m3u8),
              fallback: 'first',
            });
          case 'mp4':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: mp4Sources.map(source => source.url),
              fallback: 'first',
            });
          case 'm3u8':
            return resolveAcceptedWatchSource({
              requestedSource: url || adFreeM3u8Url,
            });
          case 'sibnet':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: sibnetUrl ? [sibnetUrl] : [],
              fallback: 'first',
            });
          case 'bravo':
            return resolveAcceptedWatchSource({
              requestedSource: url,
              availableSources: purstreamSources.map(source => source.url),
              allowed: bravoAllowed,
              fallback: 'last',
            });
          case 'kisskh_main':
            return isKisskhFallbackCompletion
              ? resolveAcceptedWatchSource({ requestedSource: url })
              : resolveAcceptedWatchSource({
                  requestedSource: url,
                  availableSources: kisskhSources.map(source => source.url),
                  fallback: 'first',
                });
          case 'frembed':
          case 'custom':
          case 'vostfr':
          case 'omega':
          case 'coflix':
          case 'wiflix':
          case 'j1f':
          case 'swiftflow':
          case 'viper':
          case 'adfree':
          case 'vox':
            return resolveAcceptedWatchSource({ requestedSource: url });
          case 'fstream':
            return resolveAcceptedWatchSource({ requestedSource: url });
          default:
            return null;
        }
      })();

      if (!acceptedPlaybackUrl) return;

      // M11 — track last manually-picked player for "remember last player".
      // Filtre les events auto-fallback ; setLastPlayer valide les ids en interne.
      if (acceptedPlaybackUrl) {
        syncHlsActiveSource(
          autoFallbackGuard,
          currentActiveUrlRef,
          acceptedPlaybackUrl,
        );
      }

      if (
        !isAutomaticFallback
        && typeof type === 'string'
      ) {
        setLastPlayer(type === 'kisskh_main' ? 'kisskh' : type);
      }

      // When a source is picked from the menu, hide the "no content" message and the menu itself.
      setOnlyVostfrAvailable(false);
      setShowEmbedQuality(false);

      // Handle HLS source selections
      if (type === 'nexus_hls' || type === 'nexus_file' || type === 'darkino' || type === 'mp4' || type === 'm3u8' || type === 'sibnet' || type === 'bravo' || type === 'kisskh_main') {
        setEmbedUrl(null); // Hide iframe
        setEmbedType(null);

        if (type === 'nexus_hls') {
          const index = nexusHlsSources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedNexusHlsSource(index);
            setSelectedSource('nexus_hls');
            setVideoSource(nexusHlsSources[index].url);
            currentSourceRef.current = 'nexus_hls';
          } else if (nexusHlsSources.length > 0) {
            setSelectedNexusHlsSource(0);
            setSelectedSource('nexus_hls');
            setVideoSource(nexusHlsSources[0].url);
            currentSourceRef.current = 'nexus_hls';
          }
        } else if (type === 'nexus_file') {
          const index = nexusFileSources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedNexusFileSource(index);
            setSelectedSource('nexus_file');
            setVideoSource(nexusFileSources[index].url);
            currentSourceRef.current = 'nexus_file';
          } else if (nexusFileSources.length > 0) {
            setSelectedNexusFileSource(0);
            setSelectedSource('nexus_file');
            setVideoSource(nexusFileSources[0].url);
            currentSourceRef.current = 'nexus_file';
          }
        } else if (type === 'darkino') {
          const index = darkinoSources.findIndex(s => s.m3u8 === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedDarkinoSource(index);
            setSelectedSource('darkino');
            currentSourceRef.current = 'darkino';
          } else {
            if (darkinoSources.length > 0) {
              setSelectedDarkinoSource(0);
              setSelectedSource('darkino');
              currentSourceRef.current = 'darkino';
            }
          }
        } else if (type === 'mp4') {
          const index = mp4Sources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedMp4Source(index);
            setSelectedSource('mp4');
            setVideoSource(mp4Sources[index].url);
            currentSourceRef.current = 'mp4';
          } else {
            if (mp4Sources.length > 0) {
              setSelectedMp4Source(0);
              setSelectedSource('mp4');
              setVideoSource(mp4Sources[0].url);
              currentSourceRef.current = 'mp4';
            }
          }
        } else if (type === 'm3u8') {
          const m3u8UrlToUse = acceptedPlaybackUrl;
          if (m3u8UrlToUse) {
            setSelectedSource('m3u8');
            setVideoSource(m3u8UrlToUse);
            currentSourceRef.current = 'm3u8';
          } else {
            if (darkinoAvailable) {
              setSelectedSource('darkino');
              setSelectedDarkinoSource(0);
              currentSourceRef.current = 'darkino';
            } else if (mp4Sources.length > 0) {
              setSelectedSource('mp4');
              setSelectedMp4Source(0);
              setVideoSource(mp4Sources[0].url);
              currentSourceRef.current = 'mp4';
            }
          }
        }
        else if (type === 'sibnet' && acceptedPlaybackUrl) {
          setSelectedSource('mp4'); // Treat as mp4
          setVideoSource(acceptedPlaybackUrl);
          currentSourceRef.current = 'mp4';
        }
        else if (type === 'bravo') {
          // Sélection d'une source Bravo (PurStream) depuis le menu
          const chosenBravoUrl = acceptedPlaybackUrl;
          if (chosenBravoUrl) {
            setSelectedSource('bravo');
            setVideoSource(chosenBravoUrl);
            setEmbedUrl(null);
            setEmbedType(null);
            currentSourceRef.current = 'bravo';
          }
        }
        else if (type === 'kisskh_main' && acceptedPlaybackUrl) {
          setSelectedSource('kisskh');
          setVideoSource(acceptedPlaybackUrl);
          setEmbedUrl(null);
          setEmbedType(null);
          currentSourceRef.current = 'kisskh';
          if (isKisskhFallbackCompletion) {
            setKisskhSources(current => current.map(source => (
              source.id === event.detail.id
                ? { ...source, url: acceptedPlaybackUrl, fallbackToken: '' }
                : source
            )));
          }
        }
      }
      // Handle Embed source selections
      else if (type === 'frembed' || type === 'custom' || type === 'vostfr' || type === 'omega' || type === 'coflix' || type === 'fstream' || type === 'wiflix' || type === 'j1f' || type === 'swiftflow' || type === 'viper' || type === 'adfree' || type === 'vox') {
        setEmbedUrl(acceptedPlaybackUrl!);
        setEmbedType(type as string); // type is known to be a string here
        setSelectedSource(type as PlayerSourceType);
        currentSourceRef.current = type as PlayerSourceType; // Or null for embeds if ref not used

        // Handle FStream source selection
        if (type === 'fstream') {
          const index = sortedFstream.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedFstreamSource(index);
          } else if (sortedFstream.length > 0) {
            setSelectedFstreamSource(0);
            setEmbedUrl(sortedFstream[0].url);
          }

          // Ne pas déclencher le popup ads si on change juste de source FStream
          // Le popup ne doit se déclencher qu'au chargement initial, pas lors du changement de source
        }
        // Handle Wiflix source selection
        else if (type === 'wiflix') {
          const index = sortedWiflix.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedWiflixSource(index);
          } else if (sortedWiflix.length > 0) {
            setSelectedWiflixSource(0);
            setEmbedUrl(sortedWiflix[0].url);
          }
        }
        // Handle J1F source selection
        else if (type === 'j1f') {
          const index = sortedJ1f.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedJ1fSource(index);
          } else if (sortedJ1f.length > 0) {
            setSelectedJ1fSource(0);
            setEmbedUrl(sortedJ1f[0].url);
          }
        }
        // Handle SwiftFlow source selection
        else if (type === 'swiftflow') {
          const index = sortedSwiftflow.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedSwiftflowSource(index);
          } else if (sortedSwiftflow.length > 0) {
            setSelectedSwiftflowSource(0);
            setEmbedUrl(sortedSwiftflow[0].url);
          }
        }
        // Handle Viper source selection
        else if (type === 'viper') {
          const index = viperSources.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedViperSource(index);
            console.log(`? [WatchTv] Playing Viper source #${index}: ${viperSources[index].label}`);
          } else if (viperSources.length > 0) {
            setSelectedViperSource(0);
            setEmbedUrl(viperSources[0].url);
          }
        }
        // Handle Vox source selection
        else if (type === 'vox') {
          const index = voxSources.findIndex(s => s.link === url);
          if (index !== -1) {
            setSelectedVoxSource(index);
          } else if (voxSources.length > 0) {
            setSelectedVoxSource(0);
            setEmbedUrl(voxSources[0].link);
          }
        }
      }
      // Handle dropdown toggles (no state change needed here)
      else if (type === 'darkino_main' || type === 'omega_main' || type === 'multi_main' || type === 'vostfr_main' || type === 'fstream_main' || type === 'wiflix_main') {
        // console.log(`[WatchTv] Dropdown toggle ignored: ${type}`);
      }
      // Handle unknown types
      else {
        // console.warn(`[WatchTv] Unknown source type received: ${type}`);
      }
    };
    window.addEventListener('sourceChange', handleSourceChangeFromMenu as EventListener);
    return () => {
      window.removeEventListener('sourceChange', handleSourceChangeFromMenu as EventListener);
    };
  }, [
    nexusHlsSources, nexusFileSources, darkinoSources, mp4Sources, adFreeM3u8Url, sibnetUrl, darkinoAvailable, fstreamSources, viperSources, voxSources, purstreamSources, kisskhSources, sortedFstream, sortedWiflix, sortedJ1f, j1fSources, sortedSwiftflow, swiftflowSources, canUseBravo, swiftfluxPlayback, // Data sources
    setOnlyVostfrAvailable, setShowEmbedQuality, setSwiftfluxGateOpen, // State setters for visibility
    setEmbedUrl, setEmbedType, setSelectedSource, // General source setters
    setSelectedNexusHlsSource, setSelectedNexusFileSource, setSelectedDarkinoSource, setSelectedMp4Source, setSelectedFstreamSource, setVideoSource, setSelectedViperSource, // HLS specific setters
    currentSourceRef, autoFallbackGuard // Refs
  ]);

  // --- Render Logic ---

  // Determine the current source URL for HLSPlayer based on selectedSource state
  let hlsSrc = '';
  if (selectedSource === 'nexus_hls' && nexusHlsSources.length > selectedNexusHlsSource) {
    hlsSrc = nexusHlsSources[selectedNexusHlsSource]?.url || '';
    if (!hlsSrc) {
      console.error(`[Debug] Invalid nexus hls source at index ${selectedNexusHlsSource}`, nexusHlsSources[selectedNexusHlsSource]);
    }
  } else if (selectedSource === 'nexus_file' && nexusFileSources.length > selectedNexusFileSource) {
    hlsSrc = nexusFileSources[selectedNexusFileSource]?.url || '';
    if (!hlsSrc) {
      console.error(`[Debug] Invalid nexus file source at index ${selectedNexusFileSource}`, nexusFileSources[selectedNexusFileSource]);
    }
  } else if (selectedSource === 'darkino' && darkinoSources.length > selectedDarkinoSource) {
    hlsSrc = darkinoSources[selectedDarkinoSource]?.m3u8 || '';
    if (!hlsSrc) {
      console.error(`[Debug] Invalid darkino source at index ${selectedDarkinoSource}`, darkinoSources[selectedDarkinoSource]);
    }
  } else if (selectedSource === 'mp4') {
    // Use videoSource as the primary source if available
    hlsSrc = videoSource || '';

    // Fallback logic if videoSource is not set
    if (!hlsSrc) {
      if (sibnetUrl) {
        hlsSrc = sibnetUrl;
      } else if (mp4Sources.length > selectedMp4Source) {
        hlsSrc = mp4Sources[selectedMp4Source]?.url || '';
        if (!hlsSrc) {
          console.error(`[Debug] Invalid mp4 source at index ${selectedMp4Source}`, mp4Sources[selectedMp4Source]);
        }
      }
    }
  } else if (selectedSource === 'swiftflux') {
    // Vide tant que la porte d'entrée n'a pas rendu l'URL ; le rendu affiche
    // alors la porte, pas le lecteur.
    hlsSrc = swiftfluxPlayback?.url || '';
  } else if (selectedSource === 'm3u8' && adFreeM3u8Url) {
    hlsSrc = adFreeM3u8Url;
  } else if (selectedSource === 'bravo') {
    // Sources Bravo (PurStream) — utilise videoSource défini lors de la sélection
    hlsSrc = videoSource || '';
  } else if (selectedSource === 'kisskh') {
    hlsSrc = videoSource || '';
  }

  // Sauvegarder la dernière source valide
  if (hlsSrc && hlsSrc.trim() !== '') {
    lastValidHlsSrcRef.current = hlsSrc;
  }


  // Add debug logging if source type is selected but no url is available
  if (selectedSource && (selectedSource === 'darkino' || selectedSource === 'mp4' || selectedSource === 'm3u8') && !hlsSrc) {
    console.error(`[Debug] Source type ${selectedSource} selected but no URL available`);
    console.info('darkinoSources:', darkinoSources);
    console.info('mp4Sources:', mp4Sources);
    console.info('sibnetUrl:', sibnetUrl);
    console.info('videoSource:', videoSource);
    console.info('adFreeM3u8Url:', adFreeM3u8Url);
  }

  // Determine the poster for HLSPlayer

  // Function to handle source change events from HLSPlayer or other components
  const handleSourceChange = useCallback((type: PlayerSourceType | string, id: string | number, url?: string) => {

    // Determine the base type (e.g., 'darkino' from 'darkino_0')
    const baseType = typeof type === 'string' ? type.split('_')[0] : type;
    const index = typeof type === 'string' ? parseInt(type.split('_')[1] || '0', 10) : 0;

    // Hide Embeds if selecting an HLS/MP4 source
    if (['nexus_hls', 'nexus_file', 'darkino', 'mp4', 'm3u8', 'sibnet'].includes(String(baseType))) {
      setEmbedUrl(null);
      setEmbedType(null);
    }

    switch (baseType) {
      case 'nexus_hls':
        if (nexusHlsSources.length > index) {
          setSelectedNexusHlsSource(index);
          setSelectedSource('nexus_hls');
          setVideoSource(nexusHlsSources[index].url);
          currentSourceRef.current = 'nexus_hls';
        } else {
          console.error(`[WatchTv] Invalid Nexus HLS index: ${index}`);
        }
        break;
      case 'nexus_file':
        if (nexusFileSources.length > index) {
          setSelectedNexusFileSource(index);
          setSelectedSource('nexus_file');
          setVideoSource(nexusFileSources[index].url);
          currentSourceRef.current = 'nexus_file';
        } else {
          console.error(`[WatchTv] Invalid Nexus File index: ${index}`);
        }
        break;
      case 'darkino':
        if (darkinoSources.length > index) {
          setSelectedDarkinoSource(index);
          setSelectedSource('darkino');
          currentSourceRef.current = 'darkino';
        } else {
          console.error(`[WatchTv] Invalid Darkino index: ${index}`);
        }
        break;
      case 'mp4':
        if (mp4Sources.length > index) {
          setSelectedMp4Source(index);
          setSelectedSource('mp4');
          setVideoSource(mp4Sources[index].url);
          currentSourceRef.current = 'mp4';
        } else {
          console.error(`[WatchTv] Invalid MP4 index: ${index}`);
        }
        break;
      case 'sibnet':
        if (sibnetUrl) {
          setSelectedSource('mp4'); // Treat as mp4
          setVideoSource(sibnetUrl);
          currentSourceRef.current = 'mp4';
        } else {
          console.error(`[WatchTv] Sibnet URL not available`);
        }
        break;
      case 'm3u8':
        if (adFreeM3u8Url) {
          setSelectedSource('m3u8');
          setVideoSource(adFreeM3u8Url);
          currentSourceRef.current = 'm3u8';
        } else {
          console.error(`[WatchTv] M3U8 URL not available`);
        }
        break;
      case 'frembed':
        const frembedUrl = `${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}`;
        setEmbedUrl(frembedUrl);
        setEmbedType('frembed');
        setSelectedSource('frembed');
        break;
      case 'custom':
        // Find the custom source URL by index (assuming id is the index)
        if (typeof id === 'number' && customSources.length > id) {
          setEmbedUrl(customSources[id]);
          setEmbedType('custom');
          setSelectedSource('custom');
        } else if (typeof url === 'string') { // Fallback if URL is directly provided
          setEmbedUrl(url);
          setEmbedType('custom');
          setSelectedSource('custom');
        } else {
          console.error(`[WatchTv] Invalid Custom source index/URL: ${id}`);
        }
        break;
      case 'omega':
        // Find the omega source URL by index (assuming id is the index)
        if (omegaData?.players && typeof id === 'number' && omegaData.players.length > id) {
          setEmbedUrl(omegaData.players[id].link);
          setEmbedType('omega');
          setSelectedSource('omega');
        } else if (typeof url === 'string') { // Fallback if URL is directly provided
          setEmbedUrl(url);
          setEmbedType('omega');
          setSelectedSource('omega');
        } else {
          console.error(`[WatchTv] Invalid Omega source index/URL: ${id}`);
        }
        break;
      case 'fstream':
        // Find the FStream source URL by index (assuming id is the index)
        if (typeof id === 'number' && sortedFstream.length > id) {
          setEmbedUrl(sortedFstream[id].url);
          setEmbedType('fstream');
          setSelectedSource('fstream');
          setSelectedFstreamSource(id);
        } else if (typeof url === 'string') { // Fallback if URL is directly provided
          setEmbedUrl(url);
          setEmbedType('fstream');
          setSelectedSource('fstream');
        } else {
          console.error(`[WatchTv] Invalid FStream source index/URL: ${id}`);
        }
        break;
      case 'viper':
        // Find the Viper source URL by index (assuming id is the index)
        if (typeof id === 'number' && viperSources.length > id) {
          setEmbedUrl(viperSources[id].url);
          setEmbedType('viper');
          setSelectedSource('viper');
          setSelectedViperSource(id);
        } else if (typeof url === 'string') { // Fallback if URL is directly provided
          const vIndex = viperSources.findIndex(s => s.url === url);
          if (vIndex !== -1) setSelectedViperSource(vIndex);
          setEmbedUrl(url);
          setEmbedType('viper');
          setSelectedSource('viper');
        } else {
          console.error(`[WatchTv] Invalid Viper source index/URL: ${id}`);
        }
        break;
      case 'vox':
        // Find the Vox source URL by index (assuming id is the index)
        if (typeof id === 'number' && voxSources.length > id) {
          setEmbedUrl(voxSources[id].link);
          setEmbedType('vox');
          setSelectedSource('vox');
          setSelectedVoxSource(id);
        } else if (typeof url === 'string') { // Fallback if URL is directly provided
          const vIndex = voxSources.findIndex(s => s.link === url);
          if (vIndex !== -1) setSelectedVoxSource(vIndex);
          setEmbedUrl(url);
          setEmbedType('vox');
          setSelectedSource('vox');
        } else {
          console.error(`[WatchTv] Invalid Vox source index/URL: ${id}`);
        }
        break;
      // Add cases for 'vostfr' or others if needed
      default:
        console.warn(`[WatchTv] Unknown source type in handleSourceChange: ${type}`);
    }

  }, [nexusHlsSources, nexusFileSources, darkinoSources, mp4Sources, adFreeM3u8Url, customSources, omegaData, sortedFstream, sibnetUrl, viperSources, voxSources, seasonNumber, episodeNumber]); // Include all dependencies

  // Memoize callback functions for HLSPlayer
  const handleHlsError = useCallback(() => {
    // SwiftFlux monte le lecteur avec une source vide le temps que la porte
    // soit franchie : l'erreur est attendue et ne doit pas déclencher de repli,
    // qui arracherait la source sous la porte encore ouverte.
    if (selectedSource === 'swiftflux' && !swiftfluxPlayback) return;

    console.error(`Error playing HLS source: ${selectedSource}`);

    // Try the next source or fallback to other sources
    if (selectedSource === 'darkino') {
      // Try to find the next valid darkino source
      let nextValidIndex = -1;
      for (let i = selectedDarkinoSource + 1; i < darkinoSources.length; i++) {
        if (darkinoSources[i]?.m3u8 && darkinoSources[i].m3u8.trim() !== '') {
          nextValidIndex = i;
          break;
        }
      }

      if (nextValidIndex !== -1) {
        console.log(`Trying next valid darkino source: ${nextValidIndex + 1} of ${darkinoSources.length}`);
        setSelectedDarkinoSource(nextValidIndex);
      }
      // If we've tried all darkino sources, try nexus sources first
      else if (nexusHlsSources.length > 0) {
        console.log(`All darkino sources failed, switching to nexus HLS source`);
        setSelectedSource('nexus_hls');
        setSelectedNexusHlsSource(0);
        setVideoSource(nexusHlsSources[0].url);
      }
      // If no nexus HLS, try nexus file sources
      else if (nexusFileSources.length > 0) {
        console.log(`No nexus HLS sources, switching to nexus file source`);
        setSelectedSource('nexus_file');
        setSelectedNexusFileSource(0);
        setVideoSource(nexusFileSources[0].url);
      }
      // If no nexus sources, try mp4 sources
      else if (mp4Sources.length > 0) {
        console.log(`No nexus sources available, switching to mp4 source`);
        setSelectedSource('mp4');
        setSelectedMp4Source(0);
        setVideoSource(mp4Sources[0].url);
      }
      // If no mp4 sources, try fstream
      else if (sortedFstream.length > 0) {
        console.log(`No mp4 sources available, switching to fstream`);
        setSelectedSource('fstream');
        setSelectedFstreamSource(0);
        setEmbedUrl(sortedFstream[0].url);
        setEmbedType('fstream');
      }
      // If no fstream sources, try omega
      else if (sortedOmega.length > 0) {
        console.log(`No mp4 sources available, switching to omega`);
        setSelectedSource('omega');
        setEmbedUrl(sortedOmega[0].link);
        setEmbedType('omega');
      }
      // If no omega, try coflix
      else if (sortedCoflix.length > 0) {
        console.log(`No omega sources available, switching to coflix`);
        setSelectedSource('coflix');
        setEmbedUrl(getCoflixPreferredUrl(sortedCoflix[0]));
        setEmbedType('coflix');
      }
      // If no coflix, try frembed
      else if (frembedAvailable && id) {
        console.log(`No coflix sources available, switching to frembed`);
        handleSourceChange('frembed', String(id));
      }
      // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
      else {
        console.log(`No viable sources found, user must choose manually`);
      }
    }
    // Handle mp4 source errors
    else if (selectedSource === 'mp4') {
      // Try the next mp4 source if available
      if (selectedMp4Source < mp4Sources.length - 1) {
        console.log(`Trying next mp4 source: ${selectedMp4Source + 1} of ${mp4Sources.length}`);
        const nextIndex = selectedMp4Source + 1;
        setSelectedMp4Source(nextIndex);
        setVideoSource(mp4Sources[nextIndex]?.url);
      }
      // If we've tried all mp4 sources and darkino is available, try darkino
      else if (darkinoSources.length > 0) {
        console.log(`All mp4 sources failed, switching to darkino source`);
        setSelectedSource('darkino');
        setSelectedDarkinoSource(0);
      }
      // If no darkino, try nexus sources
      else if (nexusHlsSources.length > 0) {
        console.log(`No darkino sources available, switching to nexus HLS source`);
        setSelectedSource('nexus_hls');
        setSelectedNexusHlsSource(0);
        setVideoSource(nexusHlsSources[0].url);
      }
      // If no nexus HLS, try nexus file sources
      else if (nexusFileSources.length > 0) {
        console.log(`No nexus HLS sources, switching to nexus file source`);
        setSelectedSource('nexus_file');
        setSelectedNexusFileSource(0);
        setVideoSource(nexusFileSources[0].url);
      }
      // If no nexus sources, try omega
      else if (sortedOmega.length > 0) {
        console.log(`No nexus sources available, switching to omega`);
        setSelectedSource('omega');
        setEmbedUrl(sortedOmega[0].link);
        setEmbedType('omega');
      }
      // If no omega, try coflix
      else if (sortedCoflix.length > 0) {
        console.log(`No omega sources available, switching to coflix`);
        setSelectedSource('coflix');
        setEmbedUrl(getCoflixPreferredUrl(sortedCoflix[0]));
        setEmbedType('coflix');
      }
      // If no coflix, try frembed
      else if (frembedAvailable && id) {
        console.log(`No coflix sources available, switching to frembed`);
        handleSourceChange('frembed', String(id));
      }
      // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
      else {
        console.log(`No viable sources found, user must choose manually`);
      }
    }
    // Handle m3u8 source errors
    else if (selectedSource === 'm3u8') {
      // If m3u8 fails, try darkino if available
      if (darkinoSources.length > 0) {
        console.log(`m3u8 source failed, switching to darkino source`);
        setSelectedSource('darkino');
        setSelectedDarkinoSource(0);
      }
      // If no darkino, try mp4
      else if (mp4Sources.length > 0) {
        console.log(`No darkino sources available, switching to mp4 source`);
        setSelectedSource('mp4');
        setSelectedMp4Source(0);
        setVideoSource(mp4Sources[0].url);
      }
      // If no mp4 sources, try fstream
      else if (sortedFstream.length > 0) {
        console.log(`No mp4 sources available, switching to fstream`);
        setSelectedSource('fstream');
        setSelectedFstreamSource(0);
        setEmbedUrl(sortedFstream[0].url);
        setEmbedType('fstream');
      }
      // If no fstream sources, try omega
      else if (sortedOmega.length > 0) {
        console.log(`No mp4 sources available, switching to omega`);
        setSelectedSource('omega');
        setEmbedUrl(sortedOmega[0].link);
        setEmbedType('omega');
      }
      // If no omega, try coflix
      else if (sortedCoflix.length > 0) {
        console.log(`No omega sources available, switching to coflix`);
        setSelectedSource('coflix');
        setEmbedUrl(getCoflixPreferredUrl(sortedCoflix[0]));
        setEmbedType('coflix');
      }
      // If no coflix, try frembed
      else if (frembedAvailable && id) {
        console.log(`No coflix sources available, switching to frembed`);
        handleSourceChange('frembed', String(id));
      }
      // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
      else {
        console.log(`No viable sources found, user must choose manually`);
      }
    }
    // Handle omega source errors
    else if (selectedSource === 'omega') {
      // If omega fails, try coflix
      if (coflixData && coflixData.player_links && coflixData.player_links.length > 0) {
        console.log(`Omega source failed, switching to coflix`);
        setSelectedSource('coflix');
        setEmbedUrl(getCoflixPreferredUrl(coflixData.player_links[0]));
        setEmbedType('coflix');
      }
      // If no coflix, try frembed
      else if (frembedAvailable && id) {
        console.log(`No coflix sources available, switching to frembed`);
        handleSourceChange('frembed', String(id));
      }
      // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
      else {
        console.log(`No viable sources found, user must choose manually`);
      }
    }
    // Handle coflix source errors
    else if (selectedSource === 'coflix') {
      // If coflix fails, try frembed
      if (frembedAvailable && id) {
        console.log(`Coflix source failed, switching to frembed`);
        handleSourceChange('frembed', String(id));
      }
      // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
      else {
        console.log(`No viable sources found, user must choose manually`);
      }
    }
    // Default fallback for other source types
    else if (frembedAvailable && id) {
      handleSourceChange('frembed', String(id));
    }
    // Note: Ne pas forcer vostfr automatiquement - laisser l'utilisateur choisir depuis le menu
  }, [selectedSource, selectedDarkinoSource, darkinoSources, mp4Sources, id, videoSource, selectedMp4Source, handleSourceChange, frembedAvailable, seasonNumber, episodeNumber, swiftfluxPlayback]);



  // Callback for HLSPlayer previous episode button
  const handlePreviousEpisodeNavCallback = useCallback(() => {
    let targetSeason = seasonNumber;
    let targetEpisode = episodeNumber;

    if (episodeNumber > 1) {
      targetEpisode = episodeNumber - 1;
    } else if (seasonNumber > 1) {
      targetSeason = seasonNumber - 1;
      // Trouver le dernier épisode de la saison précédente
      const previousSeason = seasons.find(s => s.season_number === targetSeason);
      targetEpisode = previousSeason ? previousSeason.episode_count : 1; // Fallback à 1
    }

    // Naviguer seulement si la cible est différente
    if (targetSeason !== seasonNumber || targetEpisode !== episodeNumber) {
      handleNextEpisodeNav(targetSeason, targetEpisode); // Utilise la fonction de navigation existante
    }
  }, [seasonNumber, episodeNumber, seasons, handleNextEpisodeNav]);

  // Memoize object props for HLSPlayer
  const hlsTvShowProp = useMemo(() => ({
    name: showTitle,
    backdrop_path: backdropPath || undefined
  }), [showTitle, backdropPath]);

  const hlsNextEpisodeProp = useMemo(() => (
    nextEpisodeData ? {
      seasonNumber: nextEpisodeData.season_number,
      episodeNumber: nextEpisodeData.episode_number,
      name: nextEpisodeData.name,
      overview: nextEpisodeData.overview,
      vote_average: nextEpisodeData.vote_average,
      // Sans ça, la proposition « À suivre » retombait sur le fond de la
      // série : la même vignette pour tous les épisodes.
      still_path: nextEpisodeData.still_path,
      air_date: nextEpisodeData.air_date
    } : null
  ), [nextEpisodeData]);

  // Function to load VO/VOSTFR player when user chooses to
  const handleLoadVostfr = useCallback(() => {
    setShowEmbedQuality(true); // Show sources menu only, keep "onlyVostfrAvailable" true for now
  }, [setShowEmbedQuality]);

  // Listener pour l'événement showSourcesMenu (déclenché par HLSPlayer en cas d'erreur 403)
  useEffect(() => {
    const handleShowSourcesMenu = () => {
      setShowEmbedQuality(true);
    };
    window.addEventListener('showSourcesMenu', handleShowSourcesMenu);
    return () => {
      window.removeEventListener('showSourcesMenu', handleShowSourcesMenu);
    };
  }, []);

  // Fix for React error #300 - Make sure omegaData is not rendered directly
  // useEffect(() => {
  //   if (omegaData && typeof omegaData === 'object' && !Array.isArray(omegaData)) {
  //     // Clean up omegaData to ensure it's correctly structured
  //     if (!omegaData.players || !Array.isArray(omegaData.players)) {
  //       setOmegaData({ players: [] });
  //     }
  //   }
  // }, [omegaData]);

  useEffect(() => {
    // On ne fait rien si VIP activé
    if (import.meta.env.is_vip === 'true' || import.meta.env.is_vip === true || localStorage.getItem('is_vip') === 'true') {
      console.log('?? VIP activé, popup désactivée');
      return;
    }
    // On ne fait rien si déjà passé le popup ou si popup déjà affiché
    if (adPopupTriggered || adPopupBypass) {
      console.log('?? Popup déjà déclenchée ou bypass activé:', { adPopupTriggered, adPopupBypass });
      return;
    }
    // Quand tous les chargements sont terminés
    if (!loadingDarkino && !loadingCoflix && !loadingOmega && !loadingCustom && !loadingSibnet && !loadingFrembed && !loadingFstream && !loadingWiflix && !loadingVox) {
      console.log('?? Vérification popup pour source:', selectedSource);

      // NOUVEAU: Déclencher le popup pour TOUS les lecteurs dès qu'une source est sélectionnée
      if (selectedSource && !adPopupTriggered) {
        console.log('?? Déclenchement popup pour source TV:', selectedSource);

        // Vérifier s'il n'y a que des sources VO/VOSTFR disponibles
        const hasVfSources = darkinoSources.length > 0 ||
          (mp4Sources.length > 0 && !mp4Sources.every(source =>
            source.language === 'VOSTFR' || source.language === 'VO'
          )) ||
          sibnetUrl ||
          adFreeM3u8Url ||
          (omegaData && extractOmegaPlayers(omegaData, seasonNumber, episodeNumber).length > 0) ||
          (coflixData?.player_links && coflixData.player_links.length > 0) ||
          (fstreamSources.length > 0 && fstreamSources.some(source =>
            source.category === 'VF' || source.category === 'VFQ'
          )) ||
          (wiflixSources.length > 0 && wiflixSources.some(source =>
            source.category === 'VF'
          )) ||
          (j1fSources.length > 0 && j1fSources.some(source =>
            source.category === 'VF'
          )) ||
          (swiftflowSources.length > 0 && swiftflowSources.some(source =>
            source.category === 'VF'
          )) ||
          (viperSources.length > 0 && viperSources.some(source =>
            source.language === 'VF'
          )) ||
          (voxSources.length > 0); // Assuming Vox is mostly VF/VOSTFR, consider generic check

        const isVoVostfrOnly = !hasVfSources;

        // Déclencher le popup avec le type de lecteur approprié
        let playerType = selectedSource;
        let additionalInfo: any = { isVoVostfrOnly };

        // Mapper les types de sources aux types de lecteurs pour le popup
        switch (selectedSource) {
          case 'nexus_hls':
          case 'nexus_file':
            playerType = 'nexus_' + selectedSource.split('_')[1];
            break;
          case 'darkino':
          case 'mp4':
          case 'm3u8':
            playerType = 'darkino';
            break;
          case 'omega':
            playerType = 'omega';
            const extractedPlayers = extractOmegaPlayers(omegaData, seasonNumber, episodeNumber);
            additionalInfo = {
              omegaData: {
                player_links: extractedPlayers.map((p: { player: string; link: string; is_hd?: boolean; label?: string; lang?: string }) => ({ player: p.player, link: p.link }))
              },
              isVoVostfrOnly
            };
            break;
          case 'coflix':
            playerType = 'multi';
            additionalInfo = { coflixData, isVoVostfrOnly };
            break;
          case 'fstream':
            playerType = 'fstream';
            break;
          case 'wiflix':
            playerType = 'wiflix';
            break;
          case 'j1f':
            playerType = 'j1f';
            break;
          case 'swiftflow':
            playerType = 'swiftflow';
            break;
          case 'swiftflux':
            playerType = 'swiftflux';
            break;
          case 'viper':
            playerType = 'viper';
            break;
          case 'vox':
            playerType = 'vox';
            break;
          case 'frembed':
            playerType = 'frembed';
            break;
          case 'custom':
            playerType = 'adfree'; // Type générique pour les liens custom
            break;
          default:
            // Pour les autres types (embed URLs, etc.)
            if (typeof selectedSource === 'string') {
              playerType = 'adfree'; // Type générique
            } else {
              playerType = 'adfree'; // Type par défaut
            }
            break;
        }

        console.log(`?? Popup déclenché pour ${playerType} (source TV: ${selectedSource})`);
        showPopupForPlayer(playerType, additionalInfo);
        setAdPopupTriggered(true);
        return;
      }
    }
  }, [loadingDarkino, loadingCoflix, loadingOmega, loadingCustom, loadingSibnet, loadingFrembed, loadingFstream, loadingWiflix, loadingVox, selectedSource, darkinoSources, mp4Sources, sibnetUrl, adFreeM3u8Url, omegaData, coflixData, fstreamSources, wiflixSources, voxSources, adPopupTriggered, adPopupBypass, showPopupForPlayer, seasonNumber, episodeNumber]);

  // Si on ferme le popup (croix), on bloque définitivement l'accès au lecteur (pas de bypass)
  useEffect(() => {
    // Si on ferme le popup (croix) ET qu'on n'a PAS cliqué sur la pub, on bloque l'accès au lecteur
    if (!showAdFreePopup && adPopupTriggered && !shouldLoadIframe && !hasClickedAd) {
      setAdPopupBypass(true); // On bloque l'accès au lecteur
    }
    // Si on ferme le popup (croix) ET qu'on a cliqué sur la pub, on laisse passer (pas de blocage)
  }, [showAdFreePopup, adPopupTriggered, shouldLoadIframe, hasClickedAd]);

  // All useEffect and hooks must be here, before any return

  useEffect(() => {
    const setVh = () => {
      document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    };
    setVh();
    window.addEventListener('resize', setVh);
    return () => window.removeEventListener('resize', setVh);
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100vh';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100vh';
    return () => {
      document.body.style.overflow = '';
      document.body.style.height = '';
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
    };
  }, []);

  // Now, after all hooks, you can do conditional returns:
  // Normal/auto replace the whole view with the popup (dialog/auto over the gated
  // black screen). Click-anywhere falls through so the player loads behind the
  // transparent catcher, which is rendered as an overlay in the main return.
  if (showAdFreePopup && adPopupTriggered && !adPopupBypass && getAdPopupMode() !== 'click-anywhere') {
    return <AdFreePlayerAds onClose={handlePopupClose} onAccept={handlePopupAccept} adType={adType} onAdClick={() => setHasClickedAd(true)} />;
  }
  if (adPopupBypass) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-black">
        <div className="text-white text-2xl font-bold mb-4">{t('watch.mustWatchAd')}</div>
        <div className="text-gray-400 text-lg">{t('watch.reloadToRetry')}</div>
      </div>
    );
  }
  // Si la popup doit être affichée mais n'est pas encore montrée, attendre
  if (adPopupTriggered && !shouldLoadIframe && !hasClickedAd) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-black">
        <div className="text-white text-2xl font-bold mb-4">{t('watch.loading')}</div>
        <div className="text-gray-400 text-lg">{t('watch.pleaseWait')}</div>
      </div>
    );
  }

  // Age restriction blocking screen
  if (isBlocked) {
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
            {t('details.contentBlockedDesc', { rating: getClassificationLabel(contentCert, t), age: currentProfile?.ageRestriction ?? 0 })}
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

  const preMidSourceDetail = (() => {
    switch (selectedSource) {
      case 'darkino': {
        const source = darkinoSources[selectedDarkinoSource];
        return formatPremidSourceDetail(
          source?.label || source?.quality || (darkinoSources.length > 0 ? `Source ${selectedDarkinoSource + 1}` : undefined),
          source?.language,
        );
      }
      case 'nexus_hls': {
        const source = nexusHlsSources[selectedNexusHlsSource];
        return formatPremidSourceDetail(
          source?.label || (source ? `Source ${selectedNexusHlsSource + 1}` : undefined),
        );
      }
      case 'nexus_file': {
        const source = nexusFileSources[selectedNexusFileSource];
        return formatPremidSourceDetail(
          source?.label || (source ? `Source ${selectedNexusFileSource + 1}` : undefined),
        );
      }
      case 'mp4': {
        const source =
          mp4Sources.find(entry => entry.url === videoSource) ||
          mp4Sources[selectedMp4Source];
        return formatPremidSourceDetail(
          source?.label || (source ? `Source ${selectedMp4Source + 1}` : sibnetUrl ? 'Sibnet' : undefined),
          source?.language,
          source?.isVip ? 'VIP' : undefined,
        );
      }
      case 'm3u8':
        return sibnetUrl && videoSource === sibnetUrl ? 'Sibnet' : undefined;
      case 'fstream': {
        const source =
          sortedFstream.find(entry => entry.url === embedUrl) ||
          sortedFstream[selectedFstreamSource];
        return formatPremidSourceDetail(source?.label, source?.category);
      }
      case 'wiflix': {
        const source =
          sortedWiflix.find(entry => entry.url === embedUrl) ||
          sortedWiflix[selectedWiflixSource];
        return formatPremidSourceDetail(source?.label, source?.category);
      }
      case 'j1f': {
        const source =
          sortedJ1f.find(entry => entry.url === embedUrl) ||
          sortedJ1f[selectedJ1fSource];
        return formatPremidSourceDetail(source?.label, source?.category);
      }
      case 'swiftflow': {
        const source =
          sortedSwiftflow.find(entry => entry.url === embedUrl) ||
          sortedSwiftflow[selectedSwiftflowSource];
        return formatPremidSourceDetail(source?.label, source?.category);
      }
      case 'swiftflux':
        return formatPremidSourceDetail(
          swiftfluxPlayback?.label,
          swiftfluxPlayback?.quality ?? undefined,
          swiftfluxPlayback?.language,
        );
      case 'viper': {
        const source =
          viperSources.find(entry => entry.url === embedUrl) ||
          viperSources[selectedViperSource];
        return formatPremidSourceDetail(
          source?.label,
          source?.quality,
          source?.language,
        );
      }
      case 'vox': {
        const source =
          voxSources.find(entry => entry.link === embedUrl) ||
          voxSources[selectedVoxSource];
        return formatPremidSourceDetail(source?.name);
      }
      case 'bravo': {
        const source =
          purstreamSources.find(entry => entry.url === videoSource) ||
          purstreamSources[0];
        return formatPremidSourceDetail(source?.label);
      }
      default:
        return undefined;
    }
  })();

  return (
    <div style={{ minHeight: 'calc(var(--vh, 1vh) * 100)', overflow: 'hidden' }} className="w-full bg-black text-white overflow-hidden fixed inset-0">
      <style dangerouslySetInnerHTML={{
        __html: `
          .loading-container {
            --uib-size: 35px;
            --uib-color: white;
            --uib-speed: 1s;
            --uib-stroke: 3.5px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: var(--uib-size);
            height: calc(var(--uib-size) * 0.9);
          }

          .loading-bar {
            width: var(--uib-stroke);
            height: 100%;
            background-color: var(--uib-color);
            border-radius: calc(var(--uib-stroke) / 2);
            transition: background-color 0.3s ease;
          }

          .loading-bar:nth-child(1) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.45) infinite;
          }

          .loading-bar:nth-child(2) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.3) infinite;
          }

          .loading-bar:nth-child(3) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.15) infinite;
          }

          .loading-bar:nth-child(4) {
            animation: grow var(--uib-speed) ease-in-out infinite;
          }

          @keyframes grow {
            0%, 100% {
              transform: scaleY(0.3);
            }
            50% {
              transform: scaleY(1);
            }
          }
        `
      }} />
      <div
        hidden
        data-premid-watch-context=""
        data-premid-title={showTitle || undefined}
        data-premid-media-type="tv"
        data-premid-season={seasonNumber}
        data-premid-episode={episodeNumber}
        data-premid-episode-title={
          episodeTitle || currentEpisodeInfo?.name || undefined
        }
        data-premid-source-label={embedType || selectedSource || undefined}
        data-premid-source-detail={preMidSourceDetail}
      />
      {isLoading ? (
        <div className="flex flex-col items-center justify-center h-full bg-black">
          <div className="loading-container">
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
          </div>
          <div className="text-white text-xl font-medium mt-6">{vipRetryMessage || loadingText}</div>
        </div>
      ) : onlyVostfrAvailable ? (
        <div className="h-full bg-black text-white flex flex-col items-center justify-center p-4">
          <div className="max-w-2xl w-full bg-gray-900/95 rounded-xl p-8 text-center shadow-2xl border border-gray-800">
            <div className="mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-16 w-16 text-yellow-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-2xl font-bold text-white mb-2">{t('watch.contentNotFoundInSources')}</h2>
              <p className="text-gray-300 mb-6">
                {t('watch.episodeNotFoundDesc')}
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => navigate(`/tv/${encodeId(id!)}`)}
                  className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-all duration-200 shadow-lg"
                >
                  {t('watch.back')}
                </button>
                <button
                  onClick={handleLoadVostfr}
                  className="px-6 py-3 bg-red-800 hover:bg-red-700 text-white rounded-lg transition-all duration-200 shadow-lg"
                >
                  {t('watch.chooseVostfrPlayer')}
                </button>
              </div>
            </div>
          </div>

          {/* Source Selection Menu */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10001] bg-black/60 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10002]">
                  <div className="flex justify-between items-center p-4 border-b border-gray-700/60 sticky top-0 bg-black/95 z-10">
                    <h3 className="text-white text-lg font-bold">{t('watch.changeSource')}</h3>
                    <button
                      onClick={() => setShowEmbedQuality(false)}
                      className="text-gray-400 hover:text-red-500 transition-colors text-2xl font-bold focus:outline-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="p-4">
                    <HLSPlayer
                      priorityCategory="moviesTv"
                      autoFallbackGuard={autoFallbackGuard}
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}
                      src={''}
                      className="hidden"
                      movieId={undefined}
                      tvShowId={id ?? undefined}
                      seasonNumber={seasonNumber}
                      episodeNumber={episodeNumber}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={[
                        ...(sibnetUrl ? [{ url: sibnetUrl, label: "Sibnet (Anime)", language: "VOSTFR" }] : []),
                        ...mp4Sources
                      ]}
                      swiftfluxAvailable={swiftfluxEntries.length > 0}
                      swiftfluxUrl={swiftfluxPlayback?.url}
            frembedAvailable={frembedAvailable}
                      customSources={customSources}
                      omegaSources={sortedOmega}
                      coflixSources={sortedCoflix}
                      fstreamSources={sortedFstream}
                      wiflixSources={sortedWiflix}
                      j1fSources={sortedJ1f}
                      swiftflowSources={sortedSwiftflow}
                      purstreamSources={purstreamSources}
                      adFreeM3u8Url={adFreeM3u8Url}
                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={selectedSource === 'frembed' ? 'frembed' : (embedType || undefined)}
                      embedUrl={selectedSource === 'frembed' ? `${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}` : (embedUrl ?? undefined)}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : embedUrl ? ( // Render Embed Iframe
        <div className="w-full h-full flex flex-col items-center justify-center relative">
          {/* Back to Info Button */}
          <button
            onClick={() => navigate(`/tv/${encodeId(id!)}`)}
            className="absolute top-4 left-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('watch.back')}
          </button>

          {/* Next Episode Button (for embed view in the other embed section) */}
          {nextEpisodeData && (
            <div className="absolute top-4 right-4 z-50 flex items-center gap-2">
              {/* Previous Episode Button - hide if at first episode of first season */}
              {!(seasonNumber === 1 && episodeNumber === 1) && (() => {
                // Utiliser `seasonNumber` direct (et pas `|| 1`) : pour S0E2 par exemple,
                // l'épisode précédent est S0E1, pas S1:01 — `0 || 1 = 1` cassait le label.
                const prevLabel = episodeNumber > 1
                  ? `S${seasonNumber}:${String(episodeNumber - 1).padStart(2, '0')}`
                  : seasonNumber > 0
                    ? `S${seasonNumber - 1}:01`
                    : `S1:01`;
                return (
                  <button
                    onClick={() => {
                      let targetSeason = seasonNumber;
                      let targetEpisode = episodeNumber;

                      if (episodeNumber > 1) {
                        targetEpisode = episodeNumber - 1;
                      } else if (seasonNumber > 1) {
                        targetSeason = seasonNumber - 1;
                        // Trouver le dernier épisode de la saison précédente
                        const previousSeason = seasons.find(s => s.season_number === targetSeason);
                        targetEpisode = previousSeason ? previousSeason.episode_count : 1; // Fallback à 1
                      }

                      // Naviguer seulement si la cible est différente
                      if (targetSeason !== seasonNumber || targetEpisode !== episodeNumber) {
                        handleNextEpisodeNav(targetSeason, targetEpisode);
                      }
                    }}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
                    title={prevLabel}
                    aria-label={prevLabel}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                    </svg>
                    <span>{prevLabel}</span>
                  </button>
                );
              })()}

              {/* Episodes Button — icône seule, label exposé via title/aria-label */}
              <button
                onClick={() => setShowEpisodesMenu(!showEpisodesMenu)}
                className="flex items-center justify-center px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
                title={t('watch.episodes')}
                aria-label={t('watch.episodes')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h7" />
                </svg>
              </button>

              {/* Only show Next button if nextEpisodeData exists */}
              {nextEpisodeData && (() => {
                const nextLabel = `S${nextEpisodeData.season_number}:${String(nextEpisodeData.episode_number).padStart(2, '0')}`;
                return (
                  <button
                    onClick={() => handleNextEpisodeNav(nextEpisodeData.season_number, nextEpisodeData.episode_number)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
                    title={nextLabel}
                    aria-label={nextLabel}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                    </svg>
                    <span>{nextLabel}</span>
                  </button>
                );
              })()}
            </div>
          )}

          {/* Episodes Menu */}
          <AnimatePresence>
            {showEpisodesMenu && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
                className="fixed top-16 right-4 md:right-4 left-4 md:left-auto z-[11000] bg-black/95 border border-gray-800 rounded-lg shadow-2xl md:w-96 w-auto max-h-[80vh] overflow-hidden flex flex-col"
              >
                <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                  <h3 className="text-lg font-semibold text-white">{showTitle}</h3>
                  <button
                    onClick={() => setShowEpisodesMenu(false)}
                    className="text-gray-400 hover:text-white"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Saison actuelle (Menu déroulant personnalisé) */}
                <div className="p-4 border-b border-gray-800/50">
                  <h4 className="text-sm text-gray-400 mb-2">{t('watch.seasonLabel')}</h4>
                  <div className="relative w-full">
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

                    {/* Dropdown des saisons animé */}
                    <AnimatePresence>
                      {showSeasonDropdown && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.2, ease: "easeInOut" }}
                          className="absolute top-full left-0 right-0 mt-1 bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl max-h-60 overflow-y-auto z-20 custom-scrollbar"
                        >
                          {seasons.map((season) => (
                            <button
                              key={season.id}
                              onClick={() => {
                                setSelectedSeasonNumber(season.season_number);
                                setShowSeasonDropdown(false);
                              }}
                              className={`w-full text-left px-4 py-3 text-sm transition-colors duration-150 ${selectedSeasonNumber === season.season_number
                                ? 'bg-red-800/50 text-red-100 font-semibold'
                                : 'text-gray-200 hover:bg-gray-700/50'
                                }`}
                            >
                              {t('watch.seasonN', { n: season.season_number })}
                              <span className="text-xs text-gray-400 ml-1">({t('watch.episodesCount', { count: season.episode_count })})</span>
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Episode actuel */}
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
                        S{seasonNumber} E{episodeNumber} — {t('watch.watching')}
                      </div>
                      <h4 className="text-white font-medium mb-1">
                        {shouldHide('episodeNames')
                          ? getMaskedContent(currentEpisodeInfo.name, 'episodeNames', undefined, episodeNumber)
                          : `${episodeNumber}. ${currentEpisodeInfo.name}`}
                      </h4>
                      <p className="text-xs text-gray-300 line-clamp-3">
                        {shouldHide('episodeOverviews')
                          ? getMaskedContent(currentEpisodeInfo.overview || t('watch.noDescriptionAvailable'), 'episodeOverviews', undefined, episodeNumber)
                          : (currentEpisodeInfo.overview || t('watch.noDescriptionAvailable'))}
                      </p>
                    </div>
                  </div>
                )}

                {/* Liste des épisodes */}
                <div className="flex-1 overflow-y-auto p-1">
                  <div className="grid gap-2 p-2">
                    {episodes.map((episode) => (
                      <button
                        key={episode.id}
                        onClick={() => {
                          handleNextEpisodeNav(selectedSeasonNumber, episode.episode_number);
                          setShowEpisodesMenu(false);
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
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The Embed Iframe */}
          <iframe
            key={`iframe-${embedType || ''}-${embedUrl || ''}`}
            src={embedUrl || ''}
            className="w-full h-full border-0"
            allowFullScreen
            referrerPolicy={(embedUrl || '').toLowerCase().includes('ezplayer') ? 'no-referrer' : 'strict-origin-when-cross-origin'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            sandbox={(() => {
              const urlLower = embedUrl ? embedUrl.toLowerCase() : '';

              // Jamais de sandbox pour Mixdrop, Doodstream, ou les lecteurs multi (emmmmbed.com, lecteur6.com)
              if (urlLower.includes("mixdrop") || urlLower.includes("dood") || urlLower.includes("emmmmbed") || urlLower.includes("lecteur6")) {
                return undefined;
              }

              // Jamais de sandbox pour supervideo ou dropload
              if (urlLower.includes("supervideo") || urlLower.includes("dropload")) {
                return undefined;
              }

              // Jamais de sandbox pour les liens Firebase Upload
              if (urlLower.includes('uqload') || urlLower.includes('luluvdoo')) {
                return undefined;
              }

              // Pour omega : jamais de sandbox si mixdrop ou dood (déjà vérifié ci-dessus)
              if (embedType === 'omega') {
                if (urlLower.includes('mixdrop') || urlLower.includes('dood')) {
                  return undefined;
                }
                return "allow-scripts allow-same-origin allow-presentation";
              }
              // Pour coflix : jamais de sandbox pour les lecteurs multi
              if (embedType === 'coflix') {
                return undefined;
              }
              return undefined;
            })()}
          ></iframe>

          {/* Source Selection Menu */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10001] bg-black/60 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10002]">
                  <div className="flex justify-between items-center p-4 border-b border-gray-700/60 sticky top-0 bg-black/95 z-10">
                    <h3 className="text-white text-lg font-bold">{t('watch.changeSource')}</h3>
                    <button
                      onClick={() => setShowEmbedQuality(false)}
                      className="text-gray-400 hover:text-red-500 transition-colors text-2xl font-bold focus:outline-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="p-4">
                    <HLSPlayer
                      priorityCategory="moviesTv"
                      autoFallbackGuard={autoFallbackGuard}
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}
                      src={''}
                      className="hidden"
                      movieId={undefined}
                      tvShowId={id ?? undefined}
                      seasonNumber={seasonNumber}
                      episodeNumber={episodeNumber}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={[
                        ...(sibnetUrl ? [{ url: sibnetUrl, label: "Sibnet (Anime)", language: "VOSTFR" }] : []),
                        ...mp4Sources
                      ]}
                      swiftfluxAvailable={swiftfluxEntries.length > 0}
                      swiftfluxUrl={swiftfluxPlayback?.url}
            frembedAvailable={frembedAvailable}
                      customSources={customSources}
                      omegaSources={sortedOmega}
                      coflixSources={sortedCoflix}
                      fstreamSources={sortedFstream}
                      wiflixSources={sortedWiflix}
                      j1fSources={sortedJ1f}
                      swiftflowSources={sortedSwiftflow}
                      viperSources={sortedViper}

                      voxSources={voxSources}
                      purstreamSources={purstreamSources}
                      adFreeM3u8Url={adFreeM3u8Url}
                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={selectedSource === 'frembed' ? 'frembed' : (embedType || undefined)}
                      embedUrl={selectedSource === 'frembed' ? `${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}` : (embedUrl ?? undefined)}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      // SwiftFlux non encore résolue passe aussi par ici, avec une source vide :
      // c'est le lecteur qu'on doit voir derrière le voile de la porte, avec son
      // menu des sources — pas un écran noir — donc la refermer laisse de quoi
      // choisir autre chose.
      ) : ((hlsSrc && hlsSrc.trim() !== '') || selectedSource === 'swiftflux') && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}
            key={`${selectedSource}-${selectedMp4Source}-${hlsSrc}-${videoSource}`} // Updated key to include videoSource
            // Le lecteur remplit déjà la fenêtre ici : le plein écran est porté
            // par le conteneur racine de l'app, pour survivre au remontage du
            // lecteur (changement d'épisode ou de source).
            fullscreenTarget="page"
            src={hlsSrc}
            // Le CDN SwiftFlux répond une 302 vers un autre domaine : en mode
            // CORS le navigateur refuse de la suivre. Les autres sources gardent
            // `crossOrigin`, dont dépendent le booster de volume et l'égaliseur.
            disableCrossOrigin={selectedSource === 'swiftflux'}
            poster={showPosterPath ? `https://image.tmdb.org/t/p/w500${showPosterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            className="w-full h-full"
            autoPlay={true}
            // Basic onError handler for HLS - could try next MP4/Darkino if needed
            onError={handleHlsError}
            // Map properties for the nextEpisode prop
            nextEpisode={hlsNextEpisodeProp}
            onNextEpisode={handleNextEpisodeNav}
            onPreviousEpisode={handlePreviousEpisodeNavCallback}
            tvShowId={id ?? undefined}
            seasonNumber={seasonNumber}
            episodeNumber={episodeNumber}
            controls={true}
            // Pass all available sources for the menu inside HLSPlayer
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            darkinoSources={darkinoSources}
            mp4Sources={[
              ...(sibnetUrl ? [{ url: sibnetUrl, label: "Sibnet (Anime)", language: "VOSTFR" }] : []),
              ...mp4Sources
            ]}
            swiftfluxAvailable={swiftfluxEntries.length > 0}
            swiftfluxUrl={swiftfluxPlayback?.url}
            frembedAvailable={frembedAvailable}
            customSources={customSources}
            omegaSources={sortedOmega}
            coflixSources={sortedCoflix}
            fstreamSources={sortedFstream}
            wiflixSources={sortedWiflix}
                      j1fSources={sortedJ1f}
                      swiftflowSources={sortedSwiftflow}
            viperSources={sortedViper}

            voxSources={voxSources}
            purstreamSources={purstreamSources}
            adFreeM3u8Url={adFreeM3u8Url}
            // Pass TV show context for UI/progress saving
            tvShow={hlsTvShowProp}
            initialTime={watchProgress} // Add initialTime prop
            // Pass episodes data for internal episodes menu
            episodes={episodes}
            seasons={seasons}
            showTitle={showTitle}
            currentEpisodeInfo={currentEpisodeInfo}
            onEpisodeSelect={handleNextEpisodeNav}
          />



          {/* Source Selection Menu */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10001] bg-black/60 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10002]">
                  <div className="flex justify-between items-center p-4 border-b border-gray-700/60 sticky top-0 bg-black/95 z-10">
                    <h3 className="text-white text-lg font-bold">{t('watch.changeSource')}</h3>
                    <button
                      onClick={() => setShowEmbedQuality(false)}
                      className="text-gray-400 hover:text-red-500 transition-colors text-2xl font-bold focus:outline-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="p-4">
                    <HLSPlayer
                      priorityCategory="moviesTv"
                      autoFallbackGuard={autoFallbackGuard}
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}
                      src={''}
                      className="hidden"
                      movieId={undefined}
                      tvShowId={id ?? undefined}
                      seasonNumber={seasonNumber}
                      episodeNumber={episodeNumber}
                      controls={false}
                      darkinoSources={darkinoSources}
                      mp4Sources={[
                        ...(sibnetUrl ? [{ url: sibnetUrl, label: "Sibnet (Anime)", language: "VOSTFR" }] : []),
                        ...mp4Sources
                      ]}
                      swiftfluxAvailable={swiftfluxEntries.length > 0}
                      swiftfluxUrl={swiftfluxPlayback?.url}
            frembedAvailable={frembedAvailable}
                      customSources={customSources}
                      omegaSources={sortedOmega}
                      coflixSources={sortedCoflix}
                      fstreamSources={sortedFstream}
                      wiflixSources={sortedWiflix}
                      j1fSources={sortedJ1f}
                      swiftflowSources={sortedSwiftflow}
                      viperSources={sortedViper}

                      voxSources={voxSources}
                      purstreamSources={purstreamSources}
                      adFreeM3u8Url={adFreeM3u8Url}
                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={selectedSource === 'frembed' ? 'frembed' : (embedType || undefined)}
                      embedUrl={selectedSource === 'frembed' ? `${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}` : (embedUrl ?? undefined)}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center relative bg-black">
          <HLSPlayer
                      priorityCategory="moviesTv"
                      autoFallbackGuard={autoFallbackGuard}
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}
                      src={''}
            className="hidden"
            movieId={undefined}
            tvShowId={id ?? undefined}
            seasonNumber={seasonNumber}
            episodeNumber={episodeNumber}
            controls={false}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            darkinoSources={darkinoSources}
            mp4Sources={[
              ...(sibnetUrl ? [{ url: sibnetUrl, label: "Sibnet (Anime)", language: "VOSTFR" }] : []),
              ...mp4Sources
            ]}
            swiftfluxAvailable={swiftfluxEntries.length > 0}
            swiftfluxUrl={swiftfluxPlayback?.url}
            frembedAvailable={frembedAvailable}
            customSources={customSources}
            omegaSources={sortedOmega}
            coflixSources={sortedCoflix}
            fstreamSources={sortedFstream}
            wiflixSources={sortedWiflix}
                      j1fSources={sortedJ1f}
                      swiftflowSources={sortedSwiftflow}
            viperSources={sortedViper}

            purstreamSources={purstreamSources}
            adFreeM3u8Url={adFreeM3u8Url}
            autoPlay={false}
            onlyQualityMenu={true}
            embedType={selectedSource === 'frembed' ? 'frembed' : (embedType || undefined)}
            embedUrl={selectedSource === 'frembed' ? `${getFrembedBase()}/api/serie.php?id=${id}&sa=${seasonNumber}&epi=${episodeNumber}` : (embedUrl ?? undefined)}
          />
        </div>
      )}

      {showSourceButton && (
        <div className="absolute top-16 right-4 z-[9000] flex items-center gap-2">
          {/* Bouton Ouvrir dans une nouvelle page */}
          <button
            onClick={() => {
              const targetUrl = embedType === 'vostfr'
                ? `https://vidlink.pro/tv/${id}/${seasonNumber}/${episodeNumber}`
                : embedUrl || '';
              window.open(targetUrl, '_blank', 'noopener');
            }}
            className="flex items-center gap-1 sm:gap-2 px-3 py-2 rounded-lg bg-gray-800/90 border border-gray-600 hover:bg-gray-700/90 text-white font-medium text-sm transition-all duration-200"
            title={t('watch.openInNewPage')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>

          {/* Bouton Changer de source */}
          <button
            onClick={() => setShowEmbedQuality(true)}
            className="flex items-center gap-1 sm:gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            <span className="hidden sm:inline">{t('watch.sources')}</span>
          </button>
        </div>
      )}

      {/* Click-anywhere: transparent catcher overlaid on the preloaded player.
          Normal/auto already returned the popup above, so this renders only for
          click-anywhere. */}
      {showAdFreePopup && adPopupTriggered && !adPopupBypass && (
        <AdFreePlayerAds onClose={handlePopupClose} onAccept={handlePopupAccept} adType={adType} onAdClick={() => setHasClickedAd(true)} />
      )}

      {/* Porte SwiftFlux — posée par-dessus le lecteur en cours, jamais à sa
          place : la refermer rend la main à ce qui jouait déjà.

          Elle attend que NOTRE popup pub soit passée. Deux fenêtres empilées
          demanderaient deux publicités à la fois, et celle du partenaire
          masquerait la nôtre — l'utilisateur cliquerait la seconde sans avoir
          vu la première, qui est celle qui finance le site. */}
      {swiftfluxGateOpen && !showAdFreePopup && !adPopupBypass
        && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) && (
        <SwiftfluxGate
          request={{ kind: 'tv', tmdbId: id || '', season: seasonNumber, episode: episodeNumber, index: 0 }}
          onResolved={(playback) => {
            setSwiftfluxPlayback(playback);
            setEmbedUrl(null);
            setEmbedType(null);
            setVideoSource('');
            currentSourceRef.current = 'swiftflux';
            setSelectedSource('swiftflux');
            setSwiftfluxGateOpen(false);
          }}
          onClose={() => setSwiftfluxGateOpen(false)}
        />
      )}
    </div>
  );
};

export default WatchTv;
