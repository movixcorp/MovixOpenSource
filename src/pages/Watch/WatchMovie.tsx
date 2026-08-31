import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFrembedBase } from '../../utils/frembedConfig';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import HLSPlayer from '../../components/HLSPlayer';
import PlayerOverlayPortal from '../../components/PlayerOverlayPortal';
import { motion, AnimatePresence } from 'framer-motion';
import { useAdFreePopup } from '../../context/AdFreePopupContext';
import AdFreePlayerAds from '../../components/AdFreePlayerAds';
import { extractM3u8FromEmbed, extractUqloadFile, extractVidzyM3u8, extractFsvidM3u8, extractDoodStreamFile, isDoodStreamExtractionEnabled, registerServerResolvedSources, type M3u8Result } from '../../utils/extractM3u8';
import type { SeekStreamingHlsSource } from '../../utils/seekStreamingCandidates';
import { runExtractionPass } from '../../utils/runExtractionPass';
import { pickAutoSelectedSource, sortHostersByPriority, type SourceAvailability } from '../../utils/sourceAutoSelect';
import type { TopLevelSourceId } from '../../types/sourcePriority';
import { getSourcePriorityPrefs, subscribeToPriorityChanges } from '../../utils/sourcePriorityPrefs';
import { detectHoster } from '../../utils/hosterRegistry';
import { setLastPlayer } from '../../utils/lastPlayerPref';
import { getTmdbId } from '../../utils/idEncoder';
import { useWrappedTracker } from '../../hooks/useWrappedTracker';
import { isUserVip, getVipHeaders } from '../../utils/authUtils';
import { serverResolveRequest } from '../../utils/serverResolveRequest';
import { isExtensionAvailable } from '../../utils/extensionProxy';
import { getTmdbLanguage } from '../../i18n';
import { useProfile } from '../../context/ProfileContext';
import { isContentAllowed, getClassificationLabel } from '../../utils/certificationUtils';
import { getCoflixPreferredUrl } from '../../utils/coflix';
import { KisskhServiceError, resolveKisskhMovie } from '../../services/kisskhService';
import SwiftfluxGate from '../../components/SwiftfluxGate';
import {
  readSwiftflux,
  type SwiftfluxEntry,
  type SwiftfluxPlayback,
} from '../../services/swiftfluxService';
import type { KisskhSource, KisskhSubtitleTrack } from '../../types/kisskh';
import {
  createHlsAutoFallbackGuard,
  resolveAcceptedWatchSource,
  resolveRenderedWatchSource,
  syncHlsActiveSource,
} from '../../utils/hlsAutoFallbackGuard';
const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

const normalizeUqloadEmbedUrl = (url: string): string => {
  return url
    .replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is')
    .replace(/uqload%2e[a-z0-9-]+/gi, 'uqload%2eis');
};

interface NextMovieType {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  poster_path: string;
  runtime: number;
}

interface OmegaMovieResponse {
  player_links: Array<{
    player: string;
    link: string;
    is_hd: boolean;
    label?: string;
  }>;
  version: string;
}

interface CoflixResponse {
  tmdb_details: {
    id: number;
    title: string;
    original_title: string;
    release_date: string;
    poster_path: string;
    backdrop_path: string;
    overview: string;
    vote_average: number;
  };
  iframe_src: string;
  player_links: Array<{
    decoded_url: string;
    clone_url?: string;
    quality: string;
    language: string;
  }>;
}

interface FStreamResponse {
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
  players: {
    VFQ?: Array<{
      url: string;
      type: string;
      quality: string;
      player: string;
    }>;
    VFF?: Array<{
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
    Default?: Array<{
      url: string;
      type: string;
      quality: string;
      player: string;
    }>;
  };
  total: number;
  metadata: {
    extractedAt: string;
  };
}



// Interface pour la source Wiflix (Lynx)
interface WiflixMovieResponse {
  success: boolean;
  tmdb_id: string;
  title: string;
  original_title: string;
  wiflix_url: string;
  players: {
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
  cache_timestamp: string;
}

// Interface pour la source 1jour1film (J1F) — meme forme que Wiflix
interface J1fMovieResponse {
  success: boolean;
  tmdb_id: string;
  title: string;
  original_title: string;
  source: '1jour1film';
  j1f_url: string;
  players: {
    vf: Array<{ name: string; url: string; type: string; label?: string; source?: string }>;
    vostfr: Array<{ name: string; url: string; type: string; label?: string; source?: string }>;
  };
  cache_timestamp: string;
}

// Interface pour la source SwiftFlow — meme forme que J1F (1jour1film)
interface SwiftflowMovieResponse {
  success: boolean;
  tmdb_id: number;
  title: string;
  year: number;
  source: 'swiftflow';
  players: {
    vf: Array<{ name: string; url: string; type: string; label?: string }>;
    vostfr: Array<{ name: string; url: string; type: string; label?: string }>;
  };
  cache_timestamp: string;
}

// Interface pour la source Viper (Cpasmal)
interface ViperMovieResponse {
  title: string;
  year: string;
  cpasmalUrl: string;
  links: {
    vf: Array<{ server: string; url: string }>;
    vostfr: Array<{ server: string; url: string }>;
  };
}

interface DarkinoResult {
  available: boolean;
  sources: NightflixSource[];
  darkinoId: string;
}

interface NightflixSource {
  src: string;
  m3u8: string;
  quality?: string;
  language?: string;
  sub?: string;
  label?: string;
}

type PlayerSourceType = 'primary' | 'vostfr' | 'videasy' | 'vidsrccc' | 'vidsrcsu' | 'vidsrcwtf1' | 'vidsrcwtf5' | 'multi' | 'omega' | 'darkino' | 'mp4' | 'coflix' | 'frembed' | 'custom' | 'nexus_hls' | 'nexus_file' | 'fstream' | 'wiflix' | 'j1f' | 'swiftflow' | 'viper' | 'vidmoly' | 'dropload' | 'adfree' | 'bravo' | 'kisskh' | number;

function formatPremidSourceDetail(...parts: Array<string | null | undefined>) {
  const normalizedParts = parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .filter((part, index, array) =>
      array.findIndex(entry => entry.toLowerCase() === part.toLowerCase()) === index
    );

  return normalizedParts.length > 0 ? normalizedParts.join(' - ') : undefined;
}

// Helper functions - Check custom links from MySQL API
// Config commune des appels catalogue en contexte de lecture, pilotée par la
// méthode d'extraction choisie : en méthode serveur `resolve=1` + clé VIP, en
// méthode extension/userscript ni l'un ni l'autre (extraction 100 % locale).
//
// Une fonction et non une constante : `checkMovieAvailability` vit au niveau
// module, hors du composant, et la clé VIP comme la méthode doivent être
// relues à chaque appel plutôt que figées au chargement.
const resolveRequest = () => serverResolveRequest();

const checkMovieAvailability = async (movieId: string) => {
  try {
    const customLinks: string[] = [];
    const mp4Links: { url: string; label?: string; language?: string; isVip?: boolean }[] = [];

    // Fetch custom links from MySQL API
    try {
      // `resolve=1` : le serveur résout les m3u8 des liens communautaires de ce
      // film (ils viennent de sa base, pas du client). Enregistré tout de suite,
      // la table `m3u8ByPlayer` serait perdue en aval.
      const response = await axios.get(`${MAIN_API}/api/links/movie/${movieId}`, resolveRequest());
      registerServerResolvedSources(response.data);

      if (response.data && response.data.success && response.data.data && response.data.data.links) {
        const rawLinks = response.data.data.links;
        console.log('Raw API links:', rawLinks);

        const uniqueUrls = new Set<string>();

        rawLinks.forEach((item: any) => {
          if (typeof item === 'string') {
            if (item.toLowerCase().endsWith('.mp4') && !uniqueUrls.has(item)) {
              uniqueUrls.add(item);
              mp4Links.push({
                url: item,
                label: "Viblix",
                language: 'Français',
                isVip: false
              });
            } else {
              customLinks.push(item);
            }
          } else if (typeof item === 'object' && item !== null && typeof item.url === 'string') {
            if (item.url.toLowerCase().endsWith('.mp4') && !uniqueUrls.has(item.url)) {
              uniqueUrls.add(item.url);
              mp4Links.push({
                url: item.url,
                label: item.label || "Viblix",
                language: item.language || 'Français',
                isVip: item.isVip || false
              });
            } else {
              customLinks.push(item.url);
            }
          }
        });

        console.log('Processed API links - customLinks:', customLinks, 'mp4Links:', mp4Links);
      }
    } catch (apiError) {
      console.error('Error fetching custom links from API:', apiError);
    }

    // Check Frembed availability
    try {
      const frembedResponse = await axios.get(`${getFrembedBase()}/api/public/v1/movies/${movieId}`, { timeout: 1000 });
      console.log(`Checking Frembed for ID ${movieId}:`, frembedResponse.data);
      const isFrembedAvailable = frembedResponse.data.status === 200 && frembedResponse.data.result?.totalItems > 0;

      return {
        isAvailable: true,
        customLinks: customLinks || [],
        frembedAvailable: isFrembedAvailable,
        mp4Links: mp4Links || []
      };
    } catch (frembedError) {
      console.error('Error checking Frembed availability:', frembedError);
      return {
        isAvailable: true,
        customLinks: customLinks || [],
        frembedAvailable: false,
        mp4Links: mp4Links || []
      };
    }
  } catch (error) {
    console.error('Error checking availability:', error);
    return {
      isAvailable: true,
      customLinks: [],
      frembedAvailable: false,
      mp4Links: []
    };
  }
};

const checkDarkinoAvailability = async (
  _movieTitle: string,
  _releaseDate: string,
  _movieId: string,
  _updateRetryMessage?: (message: string) => void,
  _retryCount = 0
): Promise<DarkinoResult | false> => {
  // Source Darkino/Nightflix retiree : endpoints api.movix.chat/api/search + /api/films/download desactives.
  return false;
};

// Helper to pick Supervideo from Omega
function getSupervideoFromOmega(omegaData: OmegaMovieResponse | null) {
  if (!omegaData || !omegaData.player_links) return null;
  return omegaData.player_links.find(
    (p: { player: string; link: string; is_hd: boolean; label?: string }) => p.player && p.player.toLowerCase().includes('supervideo')
  );
}
// Helper to pick Multi (lecteur6.com) from Coflix
function getMultiFromCoflix(coflixData: CoflixResponse | null) {
  if (!coflixData || !coflixData.player_links) return null;
  return coflixData.player_links.find(
    (p: { decoded_url: string; clone_url?: string; quality: string; language: string }) => getCoflixPreferredUrl(p).includes('lecteur6.com')
  );
}

const WatchMovie: React.FC = () => {
  const { tmdbid: encodedId } = useParams<{ tmdbid: string }>();

  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentProfile } = useProfile();

  const id = encodedId ? getTmdbId(encodedId) : null;
  const autoFallbackGuard = useMemo(() => createHlsAutoFallbackGuard(2), [id]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingText, setLoadingText] = useState(t('watch.loadingSources'));
  const [movieTitle, setMovieTitle] = useState<string>('');
  const [backdropPath, setBackdropPath] = useState<string | null>(null);
  const [posterPath, setPosterPath] = useState<string | null>(null);
  const [contentCert, setContentCert] = useState<string>('');
  const [isBlocked, setIsBlocked] = useState(false);

  // Source states
  const [selectedSource, setSelectedSource] = useState<PlayerSourceType | null>(null);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const [customSources, setCustomSources] = useState<string[]>([]);
  const [frembedAvailable, setFrembedAvailable] = useState(true);
  const [coflixData, setCoflixData] = useState<CoflixResponse | null>(null);
  const [, setSelectedPlayerLink] = useState<number>(0);
  const [omegaData, setOmegaData] = useState<OmegaMovieResponse | null>(null);
  const [, setSelectedOmegaPlayer] = useState<number>(0);
  const [darkinoAvailable, setDarkinoAvailable] = useState(false);
  const [darkinoSources, setDarkinoSources] = useState<any[]>([]);
  const [, setDarkinoId] = useState<string | null>(null);
  const [selectedDarkinoSource, setSelectedDarkinoSource] = useState<number>(0);
  const [mp4Sources, setMp4Sources] = useState<{ url: string; label?: string; language?: string; isVip?: boolean }[]>([]);
  const [selectedMp4Source, setSelectedMp4Source] = useState<number>(0);

  // SwiftFlux (MP4 direct du catalogue SwiftFlow). Trois états distincts :
  // ce qu'on sait exister (`entries`, sans URL), et ce qui a été débloqué
  // (`playback`, avec URL) — la porte d'entrée s'intercale entre les deux.
  const [swiftfluxEntries, setSwiftfluxEntries] = useState<SwiftfluxEntry[]>([]);
  const [swiftfluxPlayback, setSwiftfluxPlayback] = useState<SwiftfluxPlayback | null>(null);
  // La porte se pose par-dessus ce qui joue : tant qu'elle n'a rien résolu, la
  // source courante reste en place et visible derrière, et la refermer ne coûte
  // rien à l'utilisateur.
  const [swiftfluxGateOpen, setSwiftfluxGateOpen] = useState(false);
  const [watchProgress] = useState<number>(0);
  const [, setLoadingError] = useState<boolean>(false);
  const [nextMovie, setNextMovie] = useState<NextMovieType | null>(null);
  const [, setLoadingNextMovie] = useState<boolean>(false);

  // Nexus source states (Extracted)
  const [nexusHlsSources, setNexusHlsSources] = useState<SeekStreamingHlsSource[]>([]);
  const [nexusFileSources, setNexusFileSources] = useState<{ url: string; label: string }[]>([]);
  const [selectedNexusHlsSource, setSelectedNexusHlsSource] = useState<number>(0);
  const [selectedNexusFileSource, setSelectedNexusFileSource] = useState<number>(0);

  // FStream source states
  const [, setFstreamData] = useState<FStreamResponse | null>(null);
  const [fstreamSources, setFstreamSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedFstreamSource, setSelectedFstreamSource] = useState<number>(0);

  // Wiflix source states
  const [, setWiflixData] = useState<WiflixMovieResponse | null>(null);
  const [wiflixSources, setWiflixSources] = useState<{ url: string; label: string; category: string }[]>([]);

  const [selectedWiflixSource, setSelectedWiflixSource] = useState<number>(0);

  // J1F (1jour1film) source states
  const [, setJ1fData] = useState<J1fMovieResponse | null>(null);
  const [j1fSources, setJ1fSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedJ1fSource, setSelectedJ1fSource] = useState<number>(0);

  // SwiftFlow source states
  const [, setSwiftflowData] = useState<SwiftflowMovieResponse | null>(null);
  const [swiftflowSources, setSwiftflowSources] = useState<{ url: string; label: string; category: string }[]>([]);
  const [selectedSwiftflowSource, setSelectedSwiftflowSource] = useState<number>(0);

  // Viper source states
  const [, setViperData] = useState<ViperMovieResponse | null>(null);
  const [viperSources, setViperSources] = useState<{ url: string; label: string; quality: string; language: string }[]>([]);
  const [selectedViperSource, setSelectedViperSource] = useState<number>(0);

  // Loading states
  const [loadingDarkino, setLoadingDarkino] = useState(true);
  const [loadingCoflix, setLoadingCoflix] = useState(true);
  const [loadingOmega, setLoadingOmega] = useState(true);
  const [loadingFrembed, setLoadingFrembed] = useState(true);

  const [loadingFstream, setLoadingFstream] = useState(true);
  const [loadingWiflix, setLoadingWiflix] = useState(true);
  const [loadingJ1f, setLoadingJ1f] = useState(true);
  const [loadingSwiftflow, setLoadingSwiftflow] = useState(true);
  const [loadingViper, setLoadingViper] = useState(true);
  const [loadingExtractions, setLoadingExtractions] = useState(true); // Nouvel état pour les extractions
  const [, setVipRetryMessage] = useState<string | null>(null);
  const [onlyVostfrAvailable, setOnlyVostfrAvailable] = useState<boolean>(false);

  // KissKH resolution is movie-scoped. Abort plus generation checks keep a
  // late response from a previous route from replacing the current movie.
  const [kisskhSources, setKisskhSources] = useState<KisskhSource[]>([]);
  const [kisskhSubtitles, setKisskhSubtitles] = useState<KisskhSubtitleTrack[]>([]);
  const [loadingKisskh, setLoadingKisskh] = useState(true);
  const kisskhRequestGenerationRef = useRef(0);
  const kisskhRequestAbortRef = useRef<AbortController | null>(null);

  // PurStream (Bravo) HLS states
  const [purstreamSources, setPurstreamSources] = useState<{ url: string; label: string }[]>([]);
  const canUseBravo = isUserVip() || isExtensionAvailable();

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
    // Stabilité UX (M4) : pas de prefsVersion en deps — pin update les prefs +
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
  type OmegaPlayer = { player: string; link: string; is_hd: boolean; label?: string };
  type CoflixPlayer = { decoded_url: string; clone_url?: string; quality: string; language: string };
  const sortedOmega = useMemo<Array<OmegaPlayer & { type: string }>>(() => {
    const players: OmegaPlayer[] = omegaData?.player_links ?? [];
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
  }, [omegaData]);

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

  const currentSourceRef = useRef<string>('darkino');

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

  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [embedType, setEmbedType] = useState<string | null>(null);

  // Ajouter un état pour afficher le menu qualité embed
  const [showEmbedQuality, setShowEmbedQuality] = useState(false);

  useEffect(() => {
    if (!embedUrl) return;
    const normalizedEmbedUrl = normalizeUqloadEmbedUrl(embedUrl);
    if (normalizedEmbedUrl !== embedUrl) {
      setEmbedUrl(normalizedEmbedUrl);
    }
  }, [embedUrl]);

  useEffect(() => {
    let directSourceUrl = '';
    if (selectedSource === 'darkino') {
      directSourceUrl =
        darkinoSources[selectedDarkinoSource]?.m3u8
        || darkinoSources[0]?.m3u8
        || '';
    } else if (selectedSource === 'mp4') {
      directSourceUrl = videoSource || mp4Sources[selectedMp4Source]?.url || '';
    } else if (selectedSource === 'nexus_hls') {
      directSourceUrl =
        videoSource
        || nexusHlsSources[selectedNexusHlsSource]?.url
        || '';
    } else if (selectedSource === 'nexus_file') {
      directSourceUrl =
        videoSource
        || nexusFileSources[selectedNexusFileSource]?.url
        || '';
    } else if (selectedSource === 'bravo' || selectedSource === 'kisskh') {
      directSourceUrl = videoSource || '';
    }

    syncHlsActiveSource(
      autoFallbackGuard,
      currentActiveUrlRef,
      resolveRenderedWatchSource(selectedSource, directSourceUrl, embedUrl),
    );
  }, [
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
    videoSource,
  ]);

  const {
    showAdFreePopup,
    adType,
    shouldLoadIframe,
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept
  } = useAdFreePopup();
  const [adPopupTriggered, setAdPopupTriggered] = useState(false);
  const [adPopupBypass, setAdPopupBypass] = useState(false);

  // Ajout de l'état pour savoir si l'utilisateur a cliqué sur la pub
  const [hasClickedAd, setHasClickedAd] = useState(false);

  // Movix Wrapped 2026 - Track movie viewing time
  useWrappedTracker({
    mode: 'viewing',
    viewingData: id ? {
      contentType: 'movie',
      contentId: id,
    } : undefined,
    isActive: !isLoading && !!id,
  });

  useEffect(() => {
    kisskhRequestAbortRef.current?.abort();
    const kisskhController = new AbortController();
    const kisskhGeneration = kisskhRequestGenerationRef.current + 1;
    kisskhRequestGenerationRef.current = kisskhGeneration;
    kisskhRequestAbortRef.current = kisskhController;
    setKisskhSources([]);
    setKisskhSubtitles([]);
    setLoadingKisskh(true);

    if (!id) {
      setLoadingKisskh(false);
      return () => kisskhController.abort();
    }

    const resolveMovie = async () => {
      try {
        const resolution = await resolveKisskhMovie(Number(id), { signal: kisskhController.signal });
        if (
          kisskhController.signal.aborted
          || kisskhRequestGenerationRef.current !== kisskhGeneration
        ) {
          return;
        }
        setKisskhSources(resolution.sources);
        setKisskhSubtitles(resolution.subtitles);
      } catch (error) {
        if (
          kisskhController.signal.aborted
          || kisskhRequestGenerationRef.current !== kisskhGeneration
        ) {
          return;
        }
        if (error instanceof KisskhServiceError && error.code === 'retrieval_in_progress') {
          return;
        }
        // KissKH is additive; other provider sources remain usable on failure.
      } finally {
        if (
          !kisskhController.signal.aborted
          && kisskhRequestGenerationRef.current === kisskhGeneration
        ) {
          setLoadingKisskh(false);
        }
      }
    };

    void resolveMovie();
    return () => {
      kisskhController.abort();
      if (kisskhRequestAbortRef.current === kisskhController) {
        kisskhRequestAbortRef.current = null;
      }
    };
  }, [id]);

  useEffect(() => {
    // Fetch movie sources
    if (id) {

      // Call function directly instead of reference
      const getVideoSources = async () => {
        try {
          await fetchVideoSources();
          // Fetch next movie after sources to avoid dependency issues
          await fetchNextMovie();
        } catch (error) {
          setIsLoading(false);
        }
      };

      getVideoSources();
    } else {
      setIsLoading(false);
    }
  }, []); // Empty dependency array to run once

  // Function to update VIP retry message
  const updateVipRetryMessage = (message: string) => {
    console.log("Updating retry message:", message);
    setVipRetryMessage(message);
    setLoadingText(message);
  };

  // Reset VIP retry message when loading finishes
  useEffect(() => {
    console.log("Loading states changed:", {
      loadingDarkino,
      loadingCoflix,
      loadingOmega,
      loadingFrembed,
      loadingFstream,
      loadingWiflix,
      loadingViper
    });

    if (!loadingDarkino && !loadingCoflix && !loadingOmega && !loadingFrembed && !loadingFstream && !loadingWiflix && !loadingJ1f && !loadingSwiftflow && !loadingViper && !loadingExtractions) {
      setVipRetryMessage(null);
      setIsLoading(false);
    }
  }, [loadingDarkino, loadingCoflix, loadingOmega, loadingFrembed, loadingFstream, loadingWiflix, loadingJ1f, loadingSwiftflow, loadingViper, loadingExtractions]);

  // Fetch video sources
  const fetchVideoSources = async () => {
    if (!id) {
      return;
    }

    setVipRetryMessage(null);
    setIsLoading(true);
    setLoadingText(t('watch.loadingSources'));


    try {
      // Get movie details for title (needed for ad-free search and Darkino)
      const tmdbResponse = await axios.get(`https://api.themoviedb.org/3/movie/${id}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
      }).catch(error => {
        console.error('Error fetching TMDB data:', error);
        return { data: { title: '', backdrop_path: null, release_date: '' } };
      });

      setMovieTitle(tmdbResponse.data.title);
      setBackdropPath(tmdbResponse.data.backdrop_path);
      setPosterPath(tmdbResponse.data.poster_path);

      // Age restriction check
      const profileAge = currentProfile?.ageRestriction ?? 0;
      if (profileAge > 0) {
        try {
          const certResponse = await axios.get(`https://api.themoviedb.org/3/movie/${id}/release_dates`, {
            params: { api_key: TMDB_API_KEY },
          });
          const results = certResponse.data.results;
          let cert = '';
          const frRelease = results.find((r: any) => r.iso_3166_1 === 'FR');
          if (frRelease?.release_dates) {
            const theatrical = frRelease.release_dates.find((rd: any) => rd.type === 3 || rd.type === 2);
            if (theatrical?.certification) cert = theatrical.certification;
          }
          if (!cert) {
            const usRelease = results.find((r: any) => r.iso_3166_1 === 'US');
            if (usRelease?.release_dates) {
              const found = usRelease.release_dates.find((rd: any) => rd.certification !== '');
              if (found?.certification) cert = found.certification;
            }
          }
          if (cert && !isContentAllowed(cert, profileAge)) {
            setContentCert(cert);
            setIsBlocked(true);
            setIsLoading(false);
            return;
          }
        } catch (e) {
          console.log('Could not fetch certifications for age check');
        }
      }

      // Add movie to continueWatching (if history is enabled)
      if (localStorage.getItem('settings_disable_history') !== 'true') {
        const continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}');

        // Ensure structure exists
        if (!continueWatching.movies) continueWatching.movies = [];
        if (!continueWatching.tv) continueWatching.tv = [];

        const movieIdInt = parseInt(id);

        // Check if movie already exists (handle both old and new format)
        const existingIndex = continueWatching.movies.findIndex((item: any) => {
          const itemId = typeof item === 'number' ? item : item.id;
          return itemId === movieIdInt;
        });

        if (existingIndex !== -1) {
          // Remove existing entry to move it to the front
          continueWatching.movies.splice(existingIndex, 1);
        }

        // Add movie with timestamp at the beginning (no limit)
        continueWatching.movies.unshift({
          id: movieIdInt,
          lastAccessed: new Date().toISOString()
        });

        localStorage.setItem('continueWatching', JSON.stringify(continueWatching));
      }

      // Initialize loading states for individual sources
      setLoadingDarkino(true);
      setLoadingCoflix(true);
      setLoadingOmega(true);
      setLoadingFrembed(true);
      setLoadingFstream(true);
      setLoadingFstream(true);
      setLoadingWiflix(true);
      setLoadingViper(true);
      setLoadingExtractions(true);

      // =========== INITIATE ALL ASYNCHRONOUS SOURCE CHECKS (NON-BLOCKING) ===========
      const darkinoPromise = checkDarkinoAvailability(
        tmdbResponse.data.title,
        tmdbResponse.data.release_date,
        id,
        updateVipRetryMessage
      ).catch(error => {
        console.error('Error checking Darkino availability:', error);
        return false; // Return a default/error state
      }).finally(() => setLoadingDarkino(false));

      const availabilityPromise = checkMovieAvailability(id)
        .catch(error => {
          console.error('Error checking Firebase/Frembed availability:', error);
          return { customLinks: [], mp4Links: [], frembedAvailable: false }; // Default/error state
        }).finally(() => setLoadingFrembed(false));

      // `resolve=1` : le serveur résout lui-même les m3u8 de ce film. Réservé
      // à la lecture — la navigation ne doit pas déclencher d'extraction.
      const coflixPromise = axios.get(`${MAIN_API}/api/tmdb/movie/${id}`, resolveRequest())
        .then(response => response.data)
        .catch(error => {
          console.error('Error fetching Coflix sources:', error);
          return null;
        }).finally(() => setLoadingCoflix(false));

      const omegaPromise = (async () => {
        try {
          const imdbResponse = await axios.get(`https://api.themoviedb.org/3/movie/${id}/external_ids`, {
            params: { api_key: TMDB_API_KEY },
          });
          if (imdbResponse.data && imdbResponse.data.imdb_id) {
            const imdbId = imdbResponse.data.imdb_id;
            const omegaResponse = await axios.get(`${MAIN_API}/api/imdb/movie/${imdbId}`);
            if (omegaResponse.data && omegaResponse.data.player_links) {
              omegaResponse.data.player_links = omegaResponse.data.player_links.map((player: { player: string; link: string; is_hd: boolean }) => ({
                ...player,
                label: t('watch.noAds')
              }));
            }
            return omegaResponse.data;
          }
          return null;
        } catch (error) {
          console.error('Error fetching Omega sources:', error);
          return null;
        }
      })().finally(() => setLoadingOmega(false));



      // =========== CHECK PURSTREAM (BRAVO) SOURCE ==========
      const purstreamPromise = (async () => {
        try {
          const purstreamResponse = await axios.get(`${MAIN_API}/api/purstream/movie/${id}/stream`, {
            headers: { ...getVipHeaders() }
          });
          return purstreamResponse.data;
        } catch (error) {
          console.error('Error fetching PurStream movie sources:', error);
          return null;
        }
      })();

      // =========== CHECK FSTREAM SOURCE ==========
      const fstreamPromise = (async () => {
        try {
          // Méthode serveur : clé VIP + `resolve=1` (résolution serveur des
          // m3u8). Méthode extension/userscript : liens bruts, extraction locale.
          const fstreamResponse = await axios.get(`${MAIN_API}/api/fstream/movie/${id}`, resolveRequest());
          return fstreamResponse.data;
        } catch (error) {
          console.error('Error fetching FStream movie sources:', error);
          return null;
        }
      })().finally(() => setLoadingFstream(false));

      // =========== CHECK WIFLIX (LYNX) SOURCE ===========
      const wiflixPromise: Promise<WiflixMovieResponse | null> = axios.get(`${MAIN_API}/api/wiflix/movie/${id}`, resolveRequest())
        .then(response => response.data as WiflixMovieResponse)
        .catch(error => {
          console.error('Error fetching Wiflix/Lynx source:', error);
          return null;
        }).finally(() => setLoadingWiflix(false));

      // =========== CHECK J1F (1JOUR1FILM) SOURCE ===========
      const j1fPromise: Promise<J1fMovieResponse | null> = axios.get(`${MAIN_API}/api/j1f/movie/${id}`, resolveRequest())
        .then(response => response.data as J1fMovieResponse)
        .catch(error => {
          console.error('Error fetching 1jour1film source:', error);
          return null;
        }).finally(() => setLoadingJ1f(false));

      // =========== CHECK SWIFTFLOW SOURCE ===========
      const swiftflowPromise: Promise<SwiftflowMovieResponse | null> = axios.get(`${MAIN_API}/api/swiftflow/movie/${id}`, resolveRequest())
        .then(response => response.data as SwiftflowMovieResponse)
        .catch(error => {
          console.error('Error fetching SwiftFlow source:', error);
          return null;
        }).finally(() => setLoadingSwiftflow(false));

      // =========== CHECK VIPER (CPASMAL) SOURCE ===========
      const viperPromise: Promise<ViperMovieResponse | null> = axios.get(`${MAIN_API}/api/cpasmal/movie/${id}`, resolveRequest())
        .then(response => response.data as ViperMovieResponse)
        .catch(error => {
          console.error('Error fetching Viper/Cpasmal source:', error);
          return null;
        }).finally(() => setLoadingViper(false));

      // =========== AWAIT ALL SOURCE CHECKS TO COMPLETE ===========
      const [
        darkinoResult,
        availabilityResult,
        coflixResult,
        omegaResult,
        purstreamResult,
        fstreamResult,
        wiflixResult,
        viperResult,
        j1fResult,
        swiftflowResult
      ] = await Promise.all([
        darkinoPromise,
        availabilityPromise,
        coflixPromise,
        omegaPromise,
        purstreamPromise,
        fstreamPromise,
        wiflixPromise,
        viperPromise,
        j1fPromise,
        swiftflowPromise
      ]);

      // =========== TRAITEMENT DES RÉSULTATS SWIFTFLUX ===========
      // Même réponse que SwiftFlow : l'appel amont rend l'URL du MP4 en même
      // temps que de quoi construire l'iframe. Pas de requête supplémentaire.
      const swiftfluxResult = readSwiftflux(swiftflowResult);
      setSwiftfluxEntries(swiftfluxResult.entries);
      setSwiftfluxPlayback(null);

      // Mémorise les m3u8 que le serveur a résolues pour ces catalogues.
      // C'est la SEULE façon dont une m3u8 parvient au client : il n'existe
      // plus d'endpoint acceptant une URL à extraire.
      [
        coflixResult, omegaResult, purstreamResult, fstreamResult,
        wiflixResult, viperResult, j1fResult, swiftflowResult,
      ].forEach(registerServerResolvedSources);

      // =========== DÉBUT DES EXTRACTIONS (APRÈS LES REQUÊTES PRINCIPALES) ===========
      console.log('🔄 Début des extractions M3U8...');

      // =========== TRAITEMENT DES RÉSULTATS DE DARKINO ===========
      if (darkinoResult && typeof darkinoResult === 'object' && 'available' in darkinoResult && darkinoResult.available) {
        setDarkinoAvailable(true);
        // Pré-tri par priorité hoster (M4) — le state stocke déjà la liste
        // ordonnée selon le pin user, pour que `selectedDarkinoSource = 0`
        // joue le bon hoster ET que le fallback `+1` traverse l'ordre trié.
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
        setDarkinoId(darkinoResult.darkinoId);
      } else {
        setDarkinoAvailable(false);
        setDarkinoSources([]);
        setDarkinoId(null);
      }

      // =========== TRAITEMENT DES RÉSULTATS DE FIREBASE/FREMBED ===========
      const customLinks = availabilityResult.customLinks || [];
      const fetchedMp4Sources: { url: string; label?: string; language?: string; isVip?: boolean }[] = availabilityResult.mp4Links || [];
      const isFrembedAvailable = availabilityResult.frembedAvailable;

      setMp4Sources(fetchedMp4Sources);
      setCustomSources(customLinks);
      setFrembedAvailable(isFrembedAvailable);

      // =========== TRAITEMENT DES RÉSULTATS COFLIX ===========
      if (coflixResult) {
        setCoflixData(coflixResult);
      }

      // =========== TRAITEMENT DES RÉSULTATS OMEGA ===========
      if (omegaResult) {
        setOmegaData(omegaResult);

        // Extract m3u8 from supervideo and dropload players - Paralléliser
        const omegaExtractionPromises = [];

        const supervideo = getSupervideoFromOmega(omegaResult);
        if (supervideo) {
          omegaExtractionPromises.push(
            extractM3u8FromEmbed(supervideo, MAIN_API).then(result => ({
              type: 'supervideo',
              result,
              label: 'Supervideo HLS 720p'
            }))
          );
        }

        const dropload = omegaResult.player_links?.find((p: any) => p.player && p.player.toLowerCase().includes('dropload'));
        if (dropload) {
          omegaExtractionPromises.push(
            extractM3u8FromEmbed(dropload, MAIN_API).then(result => ({
              type: 'dropload',
              result,
              label: 'Dropload HLS 720p'
            }))
          );
        }

        if (omegaExtractionPromises.length > 0) {
          await Promise.all(omegaExtractionPromises);
        }
      }

      // ========== INITIALISATION DES CONTAINERS POUR SOURCES EXTRAITES ==========
      let finalHlsSources: SeekStreamingHlsSource[] = [];
      let finalFileSources: { url: string; label: string }[] = [];
      let localBravoSources: { url: string; label: string }[] = [];

      // ========== PURSTREAM (BRAVO) SOURCES (réservé VIP/extension) ==========
      if (purstreamResult && purstreamResult.sources && purstreamResult.sources.length > 0) {
        console.log('🎬 Processing PurStream (Bravo) result:', purstreamResult.sources.length, 'sources');
        const rawBravo = purstreamResult.sources
          .filter((s: { url: string; name: string; format: string }) => s.url)
          .map((s: { url: string; name: string; format: string }) => ({
            url: s.url,
            label: (s.name || 'HLS').replace(/^pur\s*\|\s*/i, '').replace(/\s*\|\s*/g, ' - '),
          }));
        // Pré-tri par priorité hoster (M4) avec fallback : si tous unknown,
        // on garde l'ordre brut (purstream c'est souvent un seul provider).
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
        console.log(`✅ PurStream (Bravo) sources set: ${localBravoSources.length}`);
      }

      // Add supervideo and dropload HLS sources if available (regardless of Nexus success)
      if (omegaResult) {
        console.log('🔍 Processing Omega result for supervideo/dropload extraction...');

        // Paralléliser les extractions Omega
        const omegaExtractionPromises = [];

        const supervideo = getSupervideoFromOmega(omegaResult);
        if (supervideo) {
          console.log('🎬 Found supervideo player:', supervideo);
          console.log('🔗 Supervideo URL to extract:', supervideo.link);
          console.log('🌐 API endpoint will be:', `${MAIN_API}/api/extract-supervideo?url=${encodeURIComponent(supervideo.link)}`);

          omegaExtractionPromises.push(
            extractM3u8FromEmbed(supervideo, MAIN_API).then(result => ({
              type: 'supervideo',
              result,
              label: 'Supervideo HLS 720p'
            }))
          );
        } else {
          console.log('❌ No supervideo player found in Omega result');
        }

        const dropload = omegaResult.player_links?.find((p: any) => p.player && p.player.toLowerCase().includes('dropload'));
        if (dropload) {
          console.log('🎬 Found dropload player:', dropload);
          omegaExtractionPromises.push(
            extractM3u8FromEmbed(dropload, MAIN_API).then(result => ({
              type: 'dropload',
              result,
              label: 'Dropload HLS 720p'
            }))
          );
        }

        // Add Doodstream extraction for Omega
        const doodstream = omegaResult.player_links?.find((p: any) => p.player && p.player.toLowerCase().includes('doodstream'));
        if (doodstream && isDoodStreamExtractionEnabled()) {
          console.log('🎬 Found doodstream player:', doodstream);
          omegaExtractionPromises.push(
            extractDoodStreamFile(doodstream.link).then(result => ({
              type: 'doodstream',
              result,
              label: 'DoodStream'
            }))
          );
        }

        if (omegaExtractionPromises.length > 0) {
          const omegaResults = await Promise.all(omegaExtractionPromises);
          omegaResults.forEach(({ type, result, label }) => {
            if (type === 'supervideo') {
              console.log('📡 Supervideo extraction result:', result);
              if (result?.success && result.hlsUrl) {
                finalHlsSources = [...finalHlsSources, { url: result.hlsUrl, label }];
                console.log(`✅ Added ${label} source (lower priority):`, result.hlsUrl);
              } else {
                console.warn('❌ Supervideo extraction failed or no HLS URL returned:', result);
              }
            } else if (type === 'dropload') {
              console.log('📡 Dropload extraction result:', result);
              if (result?.success && result.m3u8Url) {
                finalHlsSources = [...finalHlsSources, { url: result.m3u8Url, label }];
                console.log(`✅ Added ${label} source (lower priority):`, result.m3u8Url);
              }
            } else if (type === 'doodstream') {
              console.log('📡 DoodStream extraction result:', result);
              if (result?.success && result.m3u8Url) {
                finalFileSources = [...finalFileSources, { url: result.m3u8Url, label }];
                console.log(`✅ Added ${label} source:`, result.m3u8Url);
              }
            }
          });
        }
      }

      // Process Firebase dropload links for m3u8 extraction
        if (customLinks.length > 0) {
          console.log('🔍 Processing Firebase custom links for dropload extraction...');
          const droploadLinks = customLinks.filter(url => url.toLowerCase().includes('dropload'));

          // Paralléliser les extractions dropload Firebase
          if (droploadLinks.length > 0) {
            const droploadPromises = droploadLinks.map(async (droploadUrl) => {
              console.log('🎬 Processing Firebase dropload link:', droploadUrl);
              try {
                const droploadResult = await extractM3u8FromEmbed({
                  player: 'dropload',
                  link: droploadUrl
                }, MAIN_API);
                console.log('📡 Firebase Dropload extraction result:', droploadResult);
                if (droploadResult?.success && droploadResult.m3u8Url) {
                  return { url: droploadResult.m3u8Url, label: 'Dropload HLS 720p' };
                }
              } catch (error) {
                console.error('❌ Error extracting m3u8 from Firebase dropload link:', error);
              }
              return null;
            });

            const droploadResults = await Promise.all(droploadPromises);
            const validDroploadResults = droploadResults.filter(result => result !== null);
            finalHlsSources = [...finalHlsSources, ...validDroploadResults];
            console.log(`✅ Added ${validDroploadResults.length} Firebase Dropload HLS sources`);
          }
        }
      // Process Firebase custom links — passe d'extraction générique
      if (customLinks.length > 0) {
        const customPass = await runExtractionPass(
          customLinks
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
      if (coflixResult && Array.isArray(coflixResult.player_links) && coflixResult.player_links.length > 0) {
        const coflixPass = await runExtractionPass(
          coflixResult.player_links
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

      console.log('🎯 Final HLS sources after supervideo/dropload processing:', finalHlsSources);

      // =========== TRAITEMENT DES RÉSULTATS FSTREAM ===========
      let fstreamProcessedSources: { url: string; label: string; category: string }[] = [];
      const fstreamHlsSources: { url: string; label: string; category: string }[] = [];
      const fsvidSources: { url: string; label: string; category: string }[] = [];

      // Check if user is VIP or connected (utilise isUserVip pour inclure les utilisateurs connectés)
      const isVip = isUserVip();

      if (fstreamResult && fstreamResult.success && fstreamResult.players) {
        console.log('🎬 Processing FStream result:', fstreamResult);
        setFstreamData(fstreamResult);

        // Process all FStream categories with priority to fsvid sources
        const categories = ['VFQ', 'VFF', 'VOSTFR', 'Default'];
        const otherSources: { url: string; label: string; category: string }[] = [];

        categories.forEach(category => {
          const categoryPlayers = fstreamResult.players[category] || [];
          categoryPlayers.forEach((player: any) => {
            const source = {
              url: player.url,
              label: `${category} - ${player.player} ${player.quality}`,
              category: category,
              // Rempli par mainapi quand il a déjà résolu la source.
              m3u8Url: player.m3u8Url
            };

            // Séparer les sources fsvid et premium des autres sources
            const urlLower = player.url ? player.url.toLowerCase() : '';
            const playerLower = player.player ? player.player.toLowerCase() : '';

            // Ajouter fsvid si c'est détecté comme player FSvid, premium, ou si l'url contient fsvid
            if (urlLower.includes('fsvid') || playerLower === 'premium' || playerLower === 'fsvid') {
              fsvidSources.push(source); // Toujours garder pour l'extraction M3U8
            } else {
              otherSources.push(source);
            }
          });
        });

        // Pour l'affichage dans le menu : utiliser seulement les sources non-fsvid
        // Pour l'extraction M3U8 : utiliser toutes les sources (fsvid + autres) si VIP
        fstreamProcessedSources = [...otherSources];

        console.log('✅ FStream sources processed:', fstreamProcessedSources.length);
        console.log('🎯 FStream fsvid sources found:', fsvidSources.length);

        // =========== EXTRACTION M3U8 DES SOURCES FSTREAM ===========
        console.log('🔍 Extracting M3U8 from FStream sources...');

        // Paralléliser les extractions M3U8 pour vidzy et fsvid
        const fstreamExtractionPromises: Promise<{ type: string; result: M3u8Result | null; originalSource: { url: string; label: string; category: string } }>[] = [];

        // mainapi a pu résoudre la source côté serveur : dans ce cas on
        // réutilise sa m3u8 signée au lieu de relancer une extraction.
        // Renvoie null si rien n'a été pré-résolu.
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
          console.log(`🎬 Found ${vidzySources.length} vidzy sources, extracting M3U8...`);
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
          console.log(`🎬 Found ${fsvidSources.length} fsvid sources, extracting M3U8...`);
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
          console.log(`🎬 Found ${uqloadSources.length} uqload sources, extracting M3U8...`);
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
              fsvidHlsSources.push({
                url: result.m3u8Url,
                label: `${originalSource.category} - Fsvid HLS`,
                category: originalSource.category
              });
              console.log(`✅ Added Fsvid HLS source: ${result.m3u8Url}`);
            } else if (type === 'vidzy' && result?.success && result.m3u8Url) {
              vidzyHlsSources.push({
                url: result.m3u8Url,
                label: `${originalSource.category} - Vidzy HLS`,
                category: originalSource.category
              });
              console.log(`✅ Added Vidzy HLS source: ${result.m3u8Url}`);
            } else if (type === 'uqload' && result?.success && result.m3u8Url) {
              uqloadHlsSources.push({
                url: result.m3u8Url,
                label: `${originalSource.category} - Uqload HLS`,
                category: originalSource.category
              });
              console.log(`✅ Added Uqload HLS source: ${result.m3u8Url}`);
            }
          });

          // Ajouter fsvid en premier, puis vidzy, puis uqload
          fstreamHlsSources.push(...fsvidHlsSources, ...vidzyHlsSources, ...uqloadHlsSources);
        }

        console.log(`🎯 FStream HLS sources extracted: ${fstreamHlsSources.length}`);
      } else {
        setFstreamData(null);
        console.log('❌ No FStream sources available');
      }

      setFstreamSources(fstreamProcessedSources);
      console.log('🎯 [WatchMovie] FStream sources set:', fstreamProcessedSources.length, fstreamProcessedSources);

      // Ajouter les sources HLS FStream aux sources finales
      if (fstreamHlsSources.length > 0) {
        // Prioriser les sources VFF puis Default pour FStream HLS
        const fsvidVffSources = fstreamHlsSources.filter(s => s.category === 'VFF');
        const fsvidDefaultSources = fstreamHlsSources.filter(s => s.category === 'Default');
        const fsvidOtherSources = fstreamHlsSources.filter(s => s.category !== 'VFF' && s.category !== 'Default');

        const prioritizedFstreamHls = [...fsvidVffSources, ...fsvidDefaultSources, ...fsvidOtherSources];
        finalHlsSources = [...prioritizedFstreamHls, ...finalHlsSources];
        console.log(`🎯 Added ${fstreamHlsSources.length} FStream HLS sources to final sources`);
      }

      // =========== TRAITEMENT DES RÉSULTATS WIFLIX (LYNX) ===========
      let wiflixProcessedSources: { url: string; label: string; category: string }[] = [];

      if (wiflixResult && wiflixResult.success && wiflixResult.players) {
        console.log('🎬 Processing Wiflix/Lynx result:', wiflixResult);
        setWiflixData(wiflixResult);

        // Process Wiflix categories with priority to VF sources
        const categories = ['vf', 'vostfr'];
        const vfSources: { url: string; label: string; category: string }[] = [];
        const vostfrSources: { url: string; label: string; category: string }[] = [];

        categories.forEach(category => {
          const categoryPlayers = wiflixResult.players[category as keyof typeof wiflixResult.players] || [];
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

        console.log('✅ Wiflix/Lynx sources processed:', wiflixProcessedSources.length);
        console.log('🎯 Wiflix VF sources found:', vfSources.length);

        // =========== EXTRACTION M3U8 DEPUIS WIFLIX (passe générique) ===========
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
      } else {
        setWiflixData(null);
        console.log('❌ No Wiflix/Lynx sources available');
      }

      setWiflixSources(wiflixProcessedSources);
      console.log('🎯 [WatchMovie] Wiflix/Lynx sources set:', wiflixProcessedSources.length, wiflixProcessedSources);

      // =========== TRAITEMENT DES RÉSULTATS J1F (1JOUR1FILM) ===========
      let j1fProcessedSources: { url: string; label: string; category: string }[] = [];

      if (j1fResult && j1fResult.success && j1fResult.players) {
        console.log('🎬 Processing 1jour1film result:', j1fResult);
        setJ1fData(j1fResult);

        const categories = ['vf', 'vostfr'];
        const vfSources: { url: string; label: string; category: string }[] = [];
        const vostfrSources: { url: string; label: string; category: string }[] = [];

        categories.forEach(category => {
          const categoryPlayers = j1fResult.players[category as keyof typeof j1fResult.players] || [];
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
        console.log('✅ 1jour1film sources processed:', j1fProcessedSources.length);
      } else {
        setJ1fData(null);
        console.log('❌ No 1jour1film sources available');
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

      // =========== TRAITEMENT DES RÉSULTATS SWIFTFLOW ===========
      let swiftflowProcessedSources: { url: string; label: string; category: string }[] = [];

      if (swiftflowResult && swiftflowResult.success && swiftflowResult.players) {
        console.log('🎬 Processing SwiftFlow result:', swiftflowResult);
        setSwiftflowData(swiftflowResult);

        const categories = ['vf', 'vostfr'];
        const vfSources: { url: string; label: string; category: string }[] = [];
        const vostfrSources: { url: string; label: string; category: string }[] = [];

        categories.forEach(category => {
          const categoryPlayers = swiftflowResult.players[category as keyof typeof swiftflowResult.players] || [];
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
        console.log('✅ SwiftFlow sources processed:', swiftflowProcessedSources.length);
      } else {
        setSwiftflowData(null);
        console.log('❌ No SwiftFlow sources available');
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

      // =========== TRAITEMENT DES RÉSULTATS VIPER ===========
      const viperProcessedSources: { url: string; label: string; quality: string; language: string }[] = [];

      if (viperResult && viperResult.links) {
        console.log('🎬 Processing Viper/Cpasmal result:', viperResult);
        setViperData(viperResult);

        const vfSources = viperResult.links.vf || [];
        const vostfrSources = viperResult.links.vostfr || [];

        // Process VF
        vfSources.forEach((source, index) => {
          viperProcessedSources.push({
            url: source.url,
            label: `Viper VF - ${source.server} ${index + 1}`,
            quality: 'HD',
            language: 'VF'
          });
        });

        // Process VOSTFR
        vostfrSources.forEach((source, index) => {
          viperProcessedSources.push({
            url: source.url,
            label: `Viper VOSTFR - ${source.server} ${index + 1}`,
            quality: 'HD',
            language: 'VOSTFR'
          });
        });

        console.log('✅ Viper sources processed:', viperProcessedSources.length);
      } else {
        setViperData(null);
        console.log('❌ No Viper sources available');
      }
      setViperSources(viperProcessedSources);

      // =========== EXTRACTION M3U8 DEPUIS VIPER (passe générique) ===========
      // Remplace les anciens blocs voe / uqload / doodstream / seekstreaming
      // écrits à la main : `runExtractionPass` route chaque lien vers
      // l'extracteur correspondant, donc tout hoster supporté est couvert
      // d'office, y compris ceux ajoutés plus tard.
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

      // Pré-tri par priorité hoster (M4) — le state stocke la liste ordonnée
      // selon le pin user. selectedNexusHls/FileSource = 0 joue le top, et
      // l'onError fallback (+1) traverse aussi l'ordre trié.
      const prefsFinalHls = getSourcePriorityPrefs();
      const sortedFinalHls = sortHostersByPriority(
        finalHlsSources.map((s: any) => ({
          ...s,
          type: s.seekKind
            ? 'seekstreaming'
            : ((detectHoster(s.url || '', {
                patternOverrides: prefsFinalHls.patternOverrides,
                customHosters: prefsFinalHls.customHosters,
              }) ?? detectHoster(s.label || '', {
                patternOverrides: prefsFinalHls.patternOverrides,
                customHosters: prefsFinalHls.customHosters,
              })) ?? 'unknown'),
        })),
        { category: 'moviesTv', topLevel: 'nexus_hls' },
      );
      const sortedFinalFile = sortHostersByPriority(
        finalFileSources.map((s: any) => ({
          ...s,
          type: (detectHoster(s.url || '', {
            patternOverrides: prefsFinalHls.patternOverrides,
            customHosters: prefsFinalHls.customHosters,
          }) ?? detectHoster(s.label || '', {
            patternOverrides: prefsFinalHls.patternOverrides,
            customHosters: prefsFinalHls.customHosters,
          })) ?? 'unknown',
        })),
        { category: 'moviesTv', topLevel: 'nexus_hls' },
      );
      // Override les vars locales (utilisées par applyEmbedConfig juste après)
      finalHlsSources = sortedFinalHls as typeof finalHlsSources;
      finalFileSources = sortedFinalFile as typeof finalFileSources;
      // Set the final sources
      setNexusHlsSources(finalHlsSources);
      setNexusFileSources(finalFileSources);

      // =========== FIN DES EXTRACTIONS ===========
      console.log('✅ Extractions M3U8 terminées');
      setLoadingExtractions(false);

      // --- Determine Default Selected Source (priority-driven) ---
      // L'ordre est piloté par `pickAutoSelectedSource` qui lit les prefs utilisateur
      // (`sourcePriorityPrefs`). Par défaut (prefs vides) → ordre hardcodé historique,
      // 100% rétrocompat. Les cas spéciaux movie-id sont traités AVANT le picker.

      console.log('=== MOVIE SOURCE PRIORITY LOGIC ===');
      console.log('Final HLS sources (Nexus + FStream + extracted):', finalHlsSources.length);
      console.log('Final HLS sources details:', finalHlsSources);
      console.log('Final File sources (Nexus + extracted):', finalFileSources.length);
      console.log('Final File sources details:', finalFileSources);
      console.log('Darkino available:', darkinoResult && typeof darkinoResult === 'object' ? darkinoResult.available : false);
      console.log('Darkino sources count:', darkinoResult && typeof darkinoResult === 'object' ? darkinoResult.sources?.length : 0);
      console.log('FStream sources available:', fstreamProcessedSources.length);
      console.log('FStream HLS sources extracted:', fstreamHlsSources.length);
      console.log('Wiflix/Lynx sources available:', wiflixProcessedSources.length);
      console.log('Viper sources available:', viperProcessedSources.length);

      // Helper local : applique la config d'embed pour l'id choisi par le picker.
      // Close sur toutes les variables locales de fetchVideoSources (sources, résultats),
      // ce qui garde le coût faible et évite de faire ressortir tous ces états en props.
      // Retourne true si l'id a été géré avec succès, false sinon.
      const applyEmbedConfig = async (sourceId: TopLevelSourceId): Promise<boolean> => {
        switch (sourceId) {
          case 'nexus_hls': {
            // Tri par priorité hoster (M4) — applique le pin user (ex. uqload first).
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
            const firstSource = sortedHls[0];
            if (firstSource.label && (firstSource.label.includes('Vidzy HLS') || firstSource.label.includes('Fsvid HLS'))) {
              console.log('✅ Selecting FSTREAM HLS as primary source');
            } else {
              console.log('✅ Selecting NEXUS HLS as primary source');
            }
            console.log('🎯 Selected HLS URL:', firstSource.url);
            console.log('🏷️ Selected HLS Label:', firstSource.label);
            const idxNh = finalHlsSources.findIndex((s: any) => s.url === firstSource.url);
            setSelectedSource('nexus_hls');
            setSelectedNexusHlsSource(idxNh >= 0 ? idxNh : 0);
            setVideoSource(firstSource.url);
            currentSourceRef.current = 'nexus_hls';
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
            setOnlyVostfrAvailable(false);
            return true;
          }
          case 'bravo': {
            // Tri par priorité hoster (M4) ; conserve fallback "dernier élément" si tous unknown.
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
            setSelectedSource('mp4');
            setSelectedMp4Source(0);
            setVideoSource(fetchedMp4Sources[0].url);
            currentSourceRef.current = 'mp4';
            return true;
          }
          case 'swiftflux': {
            if (!swiftfluxResult.available) return false;
            // Aucune URL à poser : la porte d'entrée s'en charge et remplira
            // `swiftfluxPlayback` une fois la pub vue et le Turnstile validé.
            setSelectedSource('swiftflux');
            setVideoSource('');
            setEmbedUrl(null);
            setEmbedType(null);
            currentSourceRef.current = 'swiftflux';
            setOnlyVostfrAvailable(false);
            setSwiftfluxGateOpen(true);
            return true;
          }
          case 'darkino': {
            if (!darkinoResult || typeof darkinoResult !== 'object' || !('available' in darkinoResult) || !darkinoResult.available || !darkinoResult.sources.length) {
              return false;
            }
            // Tri par priorité hoster (M4) — applique le pin user.
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
            currentSourceRef.current = 'darkino';
            return true;
          }
          case 'fstream': {
            console.log('✅ Selecting FSTREAM as primary source');
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
            // Omega n'est dispo comme auto-select que si un lecteur "supervideo" existe
            // (ancien comportement). Si pas de supervideo → fallback sur la suite.
            const supervideo = omegaResult ? getSupervideoFromOmega(omegaResult) : null;
            if (!supervideo || !omegaResult) return false;
            setSelectedSource('omega');
            setSelectedOmegaPlayer(omegaResult.player_links.findIndex((p: { player: string; link: string; is_hd: boolean; label?: string }) => p === supervideo));
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
          case 'coflix': {
            // Coflix n'est dispo comme auto-select que si un lecteur "multi" existe
            // (ancien comportement via getMultiFromCoflix).
            const multi = coflixResult ? getMultiFromCoflix(coflixResult) : null;
            if (!multi || !coflixResult) return false;
            setSelectedSource('coflix');
            setSelectedPlayerLink(coflixResult.player_links.findIndex((p: { decoded_url: string; clone_url?: string; quality: string; language: string }) => p === multi));
            setEmbedUrl(getCoflixPreferredUrl(multi));
            setEmbedType('coflix');
            currentSourceRef.current = 'coflix';
            return true;
          }
          case 'custom': {
            if (!customLinks.length) return false;
            setSelectedSource('custom');
            setEmbedUrl(customLinks[0]);
            setEmbedType('custom');
            currentSourceRef.current = 'custom';
            return true;
          }
          case 'frembed': {
            if (!isFrembedAvailable) return false;
            setSelectedSource('frembed');
            setVideoSource(`${getFrembedBase()}/api/film.php?id=${id}`);
            setEmbedUrl(`${getFrembedBase()}/api/film.php?id=${id}`);
            setEmbedType('frembed');
            currentSourceRef.current = 'frembed';
            return true;
          }
          case 'viper': {
            if (!viperProcessedSources.length) return false;
            // Pré-tri langue + hoster pour que l'URL choisie respecte les
            // préférences user (VF vs VOSTFR, puis voe > vidmoly > …).
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
          // Les ids restants (vostfr, vox) ne sont pas auto-sélectionnables dans
          // le flux Movie (vostfr = fallback final géré ci-dessous,
          // vox = WatchTv uniquement).
          default:
            return false;
        }
      };

      // Special case for movie ID 1218925 - force custom source selection
      // (overrides any user priority, comportement préservé)
      // Garde-fou : si un lecteur Viblix (source `mp4`) existe, on ne force plus
      // `custom` — le forçage servait à combler l'absence de lecteur direct.
      if (id === '1218925' && fetchedMp4Sources.length === 0) {
        console.log('🎯 Special case: Movie ID 1218925 - selecting custom source');
        setSelectedSource('custom');
        setEmbedUrl('https://movix1.embedseek.com/#h6j8');
        setEmbedType('custom');
        currentSourceRef.current = 'custom';
        setOnlyVostfrAvailable(false);
      }
      // Special case for movie ID 1311031 - force custom source selection
      // (même garde-fou Viblix que ci-dessus)
      else if (id === '1311031' && fetchedMp4Sources.length === 0) {
        console.log('🎯 Special case: Movie ID 1311031 - selecting custom source');

        // Fetch custom links from API for this specific movie
        try {
          const customResponse = await axios.get(`${MAIN_API}/api/links/movie/${id}`);
          if (customResponse.data && customResponse.data.success && customResponse.data.data && customResponse.data.data.links) {
            const apiCustomLinks = customResponse.data.data.links;
            // Get the first custom link (index 0)
            const firstCustomLink = apiCustomLinks[0];
            const customUrl = typeof firstCustomLink === 'string' ? firstCustomLink : firstCustomLink.url;

            console.log('🎯 Using custom URL from API:', customUrl);
            setSelectedSource('custom');
            setEmbedUrl(customUrl);
            setEmbedType('custom');
            currentSourceRef.current = 'custom';
            setOnlyVostfrAvailable(false);
          } else {
            // Fallback to hardcoded URL if API fails
            console.log('⚠️ API failed, using fallback URL');
            setSelectedSource('custom');
            setEmbedUrl('https://movix1.embedseek.com/#ug3i');
            setEmbedType('custom');
            currentSourceRef.current = 'custom';
            setOnlyVostfrAvailable(false);
          }
        } catch (error) {
          console.error('Error fetching custom links for movie 1311031:', error);
          // Fallback to hardcoded URL if API fails
          setSelectedSource('custom');
          setEmbedUrl('https://movix1.embedseek.com/#ug3i');
          setEmbedType('custom');
          currentSourceRef.current = 'custom';
          setOnlyVostfrAvailable(false);
        }
      }
      else {
        // Priority-driven auto-select. Construit la liste d'availability à partir
        // des sources disponibles après toutes les extractions.
        // Note : 'vox' n'existe pas pour les films (WatchTv uniquement).
        // 'vostfr' reste marqué hasData:false car il n'a pas de fetch dédié côté
        // film (vostfr = fallback final géré plus bas).
        const availability: SourceAvailability[] = [
          { id: 'nexus_hls', hasData: finalHlsSources.length > 0 },
          { id: 'nexus_file', hasData: finalFileSources.length > 0 },
          { id: 'bravo', hasData: localBravoSources.length > 0 && canUseBravo },
          { id: 'mp4', hasData: fetchedMp4Sources.length > 0 },
          { id: 'darkino', hasData: !!(darkinoResult && typeof darkinoResult === 'object' && 'available' in darkinoResult && darkinoResult.available && darkinoResult.sources.length > 0) },
          { id: 'fstream', hasData: fstreamProcessedSources.length > 0 },
          { id: 'omega', hasData: !!(omegaResult && getSupervideoFromOmega(omegaResult)) },
          { id: 'wiflix', hasData: wiflixProcessedSources.length > 0 },
          { id: 'j1f', hasData: j1fProcessedSources.length > 0 },
          { id: 'swiftflow', hasData: swiftflowProcessedSources.length > 0 },
          { id: 'swiftflux', hasData: swiftfluxResult.available },
          { id: 'coflix', hasData: !!(coflixResult && getMultiFromCoflix(coflixResult)) },
          { id: 'viper', hasData: viperProcessedSources.length > 0 },
          { id: 'custom', hasData: customLinks.length > 0 },
          { id: 'frembed', hasData: isFrembedAvailable },
          // Sources sans fetch dédié côté film — placées après, désactivées via hasData: false
          { id: 'vox', hasData: false },
          { id: 'vostfr', hasData: false },
        ];

        // pickAutoSelectedSource retourne le 1er id activé dans l'ordre utilisateur
        // qui a `hasData: true`. Si applyEmbedConfig échoue (cas rare où la donnée
        // semble dispo mais est invalide), on marque le slot unavailable et on retry
        // pour retomber sur le candidat suivant.
        let applied = false;
        const availList: SourceAvailability[] = [...availability];
        // Max iterations = #sources, garde-fou contre boucle infinie.
        for (let i = 0; i < availList.length; i++) {
          const pick = pickAutoSelectedSource(availList);
          if (!pick) break;
          // eslint-disable-next-line no-await-in-loop
          if (await applyEmbedConfig(pick)) {
            applied = true;
            break;
          }
          // applyEmbedConfig a renvoyé false → retirer ce candidat et retry
          const idx = availList.findIndex((a) => a.id === pick);
          if (idx >= 0) availList[idx] = { ...availList[idx], hasData: false };
        }

        if (!applied) {
          // Aucune source dispo → fallback vostfr (ancien comportement fin de chain)
          setSelectedSource('vostfr');
          setOnlyVostfrAvailable(true);
          setLoadingError(false);
        }
      }

      // Fetch next movie after sources to avoid dependency issues
      try {
        await fetchNextMovie();
      } catch (error) {
        console.error('Error fetching next movie:', error);
      }

      // setIsLoading(false); // This will be handled by the useEffect watching individual loading states
    } catch (error) {
      console.error('Error in fetchVideoSources:', error);

      // Default to VOSTFR when no sources are available
      setSelectedSource('vostfr');
      setOnlyVostfrAvailable(true);
      setLoadingError(false);

      // Make sure to set all loading states to false in case of a top-level error
      setLoadingCoflix(false);
      setLoadingOmega(false);
      setLoadingDarkino(false);
      setLoadingFrembed(false);

      setLoadingFstream(false);
      setLoadingExtractions(false);
      setIsLoading(false);
    }
  };

  // Function to fetch next movie recommendation
  const fetchNextMovie = useCallback(async () => {
    if (!id) return;

    try {
      setLoadingNextMovie(true);
      const response = await axios.get(
        `https://api.themoviedb.org/3/movie/${id}/recommendations`,
        {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage(),
            page: 1
          }
        }
      );

      if (response.data.results && response.data.results.length > 0) {
        // Ne plus vérifier la disponibilité sur frembed, prendre directement le premier film recommandé
        const firstRecommendation = response.data.results[0];
        setNextMovie({
          id: firstRecommendation.id,
          title: firstRecommendation.title,
          overview: firstRecommendation.overview,
          release_date: firstRecommendation.release_date,
          vote_average: firstRecommendation.vote_average,
          poster_path: firstRecommendation.poster_path,
          runtime: 0 // Default value
        });
      }
    } catch (error) {
    } finally {
      setLoadingNextMovie(false);
    }
  }, [id]);


  // Function to handle next movie navigation
  const handleNextMovie = async (movieId: number) => {
    window.location.href = `/watch/movie/${movieId}`;
  };

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

  // Progress saving functionality removed

  useEffect(() => {
    // Renamed inner function to avoid confusion with any other handleSourceChange
    const processSourceSelectionFromMenu = (event: CustomEvent) => {
      const { type: rawType, url, origin, fromSrc } = event.detail;
      const type = typeof rawType === 'number' ? String(rawType) : rawType;
      const isAutomaticFallback =
        typeof origin === 'string' && origin.includes('auto-fallback');
      const isKisskhFallbackCompletion = origin === 'kisskh-fallback';

      // Reject stale auto-fallback events whose originating src no longer matches
      // the currently-active player URL. This prevents a late error handler from
      // a previously-selected player (e.g. darkino) reverting a user's manual
      // switch to another source (e.g. fsvid).
      if ((isAutomaticFallback || isKisskhFallbackCompletion) && typeof fromSrc === 'string' && fromSrc) {
        if (fromSrc !== currentActiveUrlRef.current) {
          console.log(
            `[WatchMovie] Ignoring stale auto-fallback sourceChange (from=${fromSrc.substring(0, 80)} current=${currentActiveUrlRef.current.substring(0, 80)})`
          );
          return;
        }
      }

      // SwiftFlux se sélectionne sans URL : elle n'existe pas encore côté
      // client à cet instant. On repasse par la porte d'entrée, qui la
      // demandera au serveur une fois la pub vue et le Turnstile validé.
      if (type === 'swiftflux') {
        if (!isAutomaticFallback) setLastPlayer('swiftflux');
        setShowEmbedQuality(false);
        // Déjà débloquée pour ce film : rien à redemander, on bascule.
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
            return resolveAcceptedWatchSource({ requestedSource: url });
          case 'fstream':
            return resolveAcceptedWatchSource({ requestedSource: url });
          default:
            return null;
        }
      })();

      if (!acceptedPlaybackUrl) return;

      if (acceptedPlaybackUrl) {
        syncHlsActiveSource(
          autoFallbackGuard,
          currentActiveUrlRef,
          acceptedPlaybackUrl,
        );
      }

      // M11 — track last manually-picked player for "remember last player".
      // Filtre les events auto-fallback (sélection involontaire) ; setLastPlayer
      // valide en interne contre TOP_LEVEL_SOURCE_IDS et ignore les ids hors-liste.
      if (
        !isAutomaticFallback
        && typeof type === 'string'
      ) {
        setLastPlayer(type === 'kisskh_main' ? 'kisskh' : type);
      }

      // When any source is picked from the menu, hide the "no content" message and the menu itself.
      setOnlyVostfrAvailable(false);
      setShowEmbedQuality(false);

      // Handle HLS source selections
      if (type === 'darkino' || type === 'mp4' || type === 'nexus_hls' || type === 'nexus_file' || type === 'bravo' || type === 'kisskh_main') {
        setEmbedUrl(null); // Hide iframe
        setEmbedType(null);
        currentSourceRef.current = type;

        if (type === 'darkino') {
          const index = darkinoSources.findIndex(s => s.m3u8 === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedDarkinoSource(index);
            setSelectedSource('darkino');
          } else if (darkinoSources.length > 0) { // Fallback to first darkino if specific URL not found
            setSelectedDarkinoSource(0);
            setSelectedSource('darkino');
          }
        } else if (type === 'mp4') {
          const index = mp4Sources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedMp4Source(index);
            setSelectedSource('mp4');
            setVideoSource(mp4Sources[index].url);
          } else if (mp4Sources.length > 0) { // Fallback to first mp4
            setSelectedMp4Source(0);
            setSelectedSource('mp4');
            setVideoSource(mp4Sources[0].url);
          }
        } else if (type === 'nexus_hls') {
          const index = nexusHlsSources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedNexusHlsSource(index);
            setSelectedSource('nexus_hls');
            setVideoSource(nexusHlsSources[index].url);
          } else if (nexusHlsSources.length > 0) { // Fallback to first nexus hls
            setSelectedNexusHlsSource(0);
            setSelectedSource('nexus_hls');
            setVideoSource(nexusHlsSources[0].url);
          }
        } else if (type === 'nexus_file') {
          const index = nexusFileSources.findIndex(s => s.url === acceptedPlaybackUrl);
          if (index !== -1) {
            setSelectedNexusFileSource(index);
            setSelectedSource('nexus_file');
            setVideoSource(nexusFileSources[index].url);
          } else if (nexusFileSources.length > 0) { // Fallback to first nexus file
            setSelectedNexusFileSource(0);
            setSelectedSource('nexus_file');
            setVideoSource(nexusFileSources[0].url);
          }
        } else if (type === 'bravo') {
          // Sélection d'une source Bravo (PurStream) depuis le menu déroulant
          console.log('🎬 [WatchMovie] Bravo source selected:', url);
          const chosenBravoUrl = acceptedPlaybackUrl;
          if (chosenBravoUrl) {
            setSelectedSource('bravo');
            setVideoSource(chosenBravoUrl);
            setEmbedUrl(null);
            setEmbedType(null);
            currentSourceRef.current = 'bravo';
            console.log(`✅ [WatchMovie] Playing Bravo via HLS: ${chosenBravoUrl}`);
          }
        } else if (type === 'kisskh_main' && acceptedPlaybackUrl) {
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
      else if (['frembed', 'custom', 'vostfr', 'omega', 'coflix', 'fstream', 'wiflix', 'j1f', 'swiftflow', 'viper'].includes(type)) {
        const finalEmbedUrl = acceptedPlaybackUrl!;
        setEmbedUrl(finalEmbedUrl);
        setEmbedType(type);
        setSelectedSource(type as PlayerSourceType); // Type assertion, as 'type' is a confirmed string literal
        setVideoSource(null); // Explicitly clear HLS video source
        currentSourceRef.current = type; // 'type' is a string here from the includes check

        // Handle FStream source selection
        if (type === 'fstream') {
          const index = sortedFstream.findIndex(s => s.url === url);
          if (index !== -1) {
            setSelectedFstreamSource(index);
          } else if (sortedFstream.length > 0) {
            setSelectedFstreamSource(0);
            setEmbedUrl(sortedFstream[0].url);
          }
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
            console.log(`✅ [WatchMovie] Playing Viper source #${index}: ${viperSources[index].label}`);
          } else if (viperSources.length > 0) {
            setSelectedViperSource(0);
            setEmbedUrl(viperSources[0].url);
          }
        }
      }
      // Handle dropdown toggles (no state change needed here for player, currentSourceRef remains)
      else if (typeof type === 'string' && type.endsWith('_main')) {
        // console.log(`[WatchMovie] Dropdown toggle ignored for player state: ${type}`);
      }
      // Handle unknown types (currentSourceRef remains unchanged or could be set to a default/null string if necessary)
      else {
        // console.warn(`[WatchMovie] Unknown source type received for player state: ${type}`);
      }
    };

    window.addEventListener('sourceChange', processSourceSelectionFromMenu as EventListener);
    return () => {
      window.removeEventListener('sourceChange', processSourceSelectionFromMenu as EventListener);
    };
  }, [
    // State values used in logic
    darkinoSources, mp4Sources, darkinoAvailable, nexusHlsSources, nexusFileSources, fstreamSources, wiflixSources, j1fSources, swiftflowSources, sortedFstream, sortedWiflix, sortedJ1f, sortedSwiftflow, viperSources, purstreamSources, kisskhSources, canUseBravo, swiftfluxPlayback,
    // State setters
    setOnlyVostfrAvailable, setShowEmbedQuality, setEmbedUrl, setEmbedType, setSwiftfluxGateOpen,
    setSelectedSource, setSelectedDarkinoSource, setSelectedMp4Source, setSelectedNexusHlsSource, setSelectedNexusFileSource, setSelectedFstreamSource, setSelectedWiflixSource, setSelectedViperSource, setVideoSource,
    // Refs (currentSourceRef.current is mutated, so the ref object itself is a dependency)
    currentSourceRef, autoFallbackGuard
  ]);

  useEffect(() => {
    // On ne fait rien si VIP activé
    if (import.meta.env.is_vip === 'true' || import.meta.env.is_vip === true || localStorage.getItem('is_vip') === 'true') {
      console.log('🚫 VIP activé - popup ads désactivé');
      return;
    }
    // On ne fait rien si déjà passé le popup ou si popup déjà affiché
    if (adPopupTriggered || adPopupBypass) {
      console.log('🚫 Popup déjà déclenché ou bypassé:', { adPopupTriggered, adPopupBypass });
      return;
    }

    console.log('🔍 États de chargement:', {
      loadingDarkino,
      loadingCoflix,
      loadingOmega,
      loadingFrembed,
      loadingFstream,
      loadingExtractions
    });

    // Quand tous les chargements sont terminés (y compris les extractions)
    if (!loadingDarkino && !loadingCoflix && !loadingOmega && !loadingFrembed && !loadingFstream && !loadingExtractions) {
      console.log('✅ Tous les chargements terminés - vérification des sources pour popup ads');
      console.log('📊 Sources disponibles:', {
        selectedSource,
        nexusHlsSources: nexusHlsSources.length,
        nexusFileSources: nexusFileSources.length,
        darkinoSources: darkinoSources.length,
        mp4Sources: mp4Sources.length,
        omegaData: omegaData?.player_links?.length || 0,
        coflixData: coflixData?.player_links?.length || 0,
        fstreamSources: fstreamSources.length,
        wiflixSources: wiflixSources.length,
        embedUrl
      });

      // NOUVEAU: Déclencher le popup pour TOUS les lecteurs dès qu'une source est sélectionnée
      if (selectedSource && !adPopupTriggered) {
        console.log('🎭 Déclenchement popup pour source:', selectedSource);

        // Vérifier s'il n'y a que des sources VO/VOSTFR disponibles
        const hasVfSources = darkinoSources.length > 0 || mp4Sources.length > 0 ||
          (omegaData?.player_links && omegaData.player_links.length > 0) ||
          (coflixData?.player_links && coflixData.player_links.length > 0) ||
          (fstreamSources.length > 0 && fstreamSources.some(source =>
            source.category === 'VF' || source.category === 'VFQ'
          )) ||
          (wiflixSources.length > 0 && wiflixSources.some(source =>
            source.category === 'VF' || source.category === 'VFQ'
          )) ||
          (j1fSources.length > 0 && j1fSources.some(source =>
            source.category === 'VF' || source.category === 'VFQ'
          )) ||
          (swiftflowSources.length > 0 && swiftflowSources.some(source =>
            source.category === 'VF' || source.category === 'VFQ'
          )) ||
          (viperSources.length > 0 && viperSources.some(source =>
            source.language === 'VF'
          ));

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
            playerType = 'darkino';
            break;
          case 'omega':
            playerType = 'omega';
            additionalInfo = { omegaData, isVoVostfrOnly };
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
          case 'frembed':
            playerType = 'frembed';
            break;
          default:
            // Pour les autres types (custom, embed URLs, etc.)
            if (embedUrl) {
              if (embedUrl.toLowerCase().includes('vidmoly')) {
                playerType = 'vidmoly';
              } else if (embedUrl.toLowerCase().includes('dropload')) {
                playerType = 'dropload';
              } else {
                playerType = 'adfree'; // Type générique pour les embeds
              }
            } else {
              playerType = 'adfree'; // Type par défaut
            }
            break;
        }

        console.log(`🎭 Popup déclenché pour ${playerType} (source: ${selectedSource})`);
        showPopupForPlayer(String(playerType), additionalInfo);
        setAdPopupTriggered(true);
        return;
      }

      console.log('⚠️ Aucune source sélectionnée ou popup déjà déclenché');
    } else {
      console.log('⏳ Chargements en cours - popup ads en attente');
    }
  }, [loadingDarkino, loadingCoflix, loadingOmega, loadingFrembed, loadingFstream, loadingWiflix, loadingExtractions, selectedSource, darkinoSources, mp4Sources, omegaData, coflixData, fstreamSources, wiflixSources, j1fSources, swiftflowSources, embedUrl, adPopupTriggered, adPopupBypass, showPopupForPlayer]);

  // Si on ferme le popup (croix) ET qu'on n'a PAS cliqué sur la pub, on bloque l'accès au lecteur
  useEffect(() => {
    if (!showAdFreePopup && adPopupTriggered && !shouldLoadIframe && !hasClickedAd) {
      setAdPopupBypass(true); // On bloque l'accès au lecteur
    }
  }, [showAdFreePopup, adPopupTriggered, shouldLoadIframe, hasClickedAd]);

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
          source?.label || (source ? `Source ${selectedMp4Source + 1}` : undefined),
          source?.language,
          source?.isVip ? 'VIP' : undefined,
        );
      }
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
    <div style={{ minHeight: 'calc(var(--vh, 1vh) * 100)', overflow: 'hidden' }} className="w-full bg-black overflow-hidden fixed inset-0">
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
        data-premid-title={movieTitle || undefined}
        data-premid-media-type="movie"
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
          <div className="text-white text-xl font-medium mt-6">{loadingText}</div>
        </div>
      ) : adPopupBypass ? (
        <div className="flex flex-col items-center justify-center h-full bg-black">
          <div className="text-white text-2xl font-bold mb-4">{t('watch.mustWatchAd')}</div>
          <div className="text-gray-400 text-lg">{t('watch.reloadToRetry')}</div>
        </div>
      ) : adPopupTriggered && !shouldLoadIframe && !hasClickedAd ? (
        <div className="flex flex-col items-center justify-center h-full bg-black">
          <div className="text-white text-2xl font-bold mb-4">{t('watch.loading')}</div>
          <div className="text-gray-400 text-lg">{t('watch.pleaseWait')}</div>
        </div>
      ) : onlyVostfrAvailable ? (
        <div className="h-full bg-black text-white flex flex-col items-center justify-center p-4">
          <div className="max-w-2xl w-full bg-gray-900/95 rounded-xl p-8 text-center shadow-2xl border border-gray-800 relative">
            <div className="mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-16 w-16 text-yellow-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-2xl font-bold text-white mb-2">{t('watch.contentNotFoundInSources')}</h2>
              <p className="text-gray-300 mb-6">
                {t('watch.movieNotFoundDesc')}
              </p>
              <p className="text-yellow-400 mb-6">
                <strong>{t('watch.importantInfo')}</strong> {t('watch.vostfrWarning')}
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => navigate(`/movie/${id}`)}
                  className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-all duration-200 shadow-lg"
                >
                  {t('watch.back')}
                </button>
                <button
                  onClick={() => { setShowEmbedQuality(true); setOnlyVostfrAvailable(true); }}
                  className="px-6 py-3 bg-red-800 hover:bg-red-700 text-white rounded-lg transition-all duration-200 shadow-lg"
                >
                  {t('watch.chooseVostfrPlayer')}
                </button>
              </div>
            </div>
          </div>
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'fstream' && fstreamSources.length > 0 && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          {/* Back to Info Button */}
          <button
            onClick={() => navigate(`/movie/${id}`)}
            className="fixed top-6 left-8 z-[9999] flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('watch.back')}
          </button>

          {/* Boutons en haut à droite */}
          <div className="fixed top-6 right-8 z-[10000] flex items-center gap-2">
            {/* Bouton Ouvrir dans une nouvelle page */}
            <button
              onClick={() => window.open(embedUrl || '', '_blank', 'noopener')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/90 border border-gray-600 hover:bg-gray-700/90 text-white font-medium text-sm transition-all duration-200"
              title={t('watch.openInNewPage')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            {/* Bouton Changer de source */}
            <button
              onClick={() => setShowEmbedQuality(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/90 border border-gray-700 hover:bg-gray-800/80 text-white font-medium text-sm transition-all duration-200"
            >
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
              <span className="hidden sm:inline">{t('watch.sources')}</span>
            </button>
          </div>

          {/* Iframe pour les sources FStream */}
          <iframe
            key={`iframe-fstream-${embedUrl || ''}`}
            src={embedUrl || ''}
            className="w-full h-full border-0"
            allowFullScreen
            referrerPolicy={(embedUrl || '').toLowerCase().includes('ezplayer') ? 'no-referrer' : 'strict-origin-when-cross-origin'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            sandbox={undefined}
          ></iframe>

          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'darkino' && darkinoSources.length > 0 && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`darkino-${selectedDarkinoSource}-${id}`}
            src={darkinoSources[selectedDarkinoSource]?.m3u8 || darkinoSources[0]?.m3u8 || ""}
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // If there's an error, try other sources
              if (selectedDarkinoSource < darkinoSources.length - 1) {
                const nextIndex = selectedDarkinoSource + 1;
                setSelectedDarkinoSource(nextIndex);
              } else {
                // All darkino sources failed, try mp4
                if (mp4Sources.length > 0) {
                  setSelectedSource('mp4');
                  setSelectedMp4Source(0);
                  setVideoSource(mp4Sources[0].url);
                } else {
                  // Fallback order: Supervideo (Omega), Multi (Coflix), Frembed, Movix (custom)
                  const supervideo = omegaData ? getSupervideoFromOmega(omegaData) : null;
                  if (supervideo && omegaData) {
                    setSelectedSource('omega');
                    setSelectedOmegaPlayer(omegaData.player_links.findIndex((p: { player: string; link: string; is_hd: boolean; label?: string }) => p === supervideo));
                    setEmbedUrl(supervideo.link);
                    setEmbedType('omega');
                  } else if (sortedWiflix.length > 0) {
                    console.log('✅ Selecting WIFLIX/LYNX as fallback source');
                    setSelectedSource('wiflix');
                    setSelectedWiflixSource(0);
                    setEmbedUrl(sortedWiflix[0].url);
                    setEmbedType('wiflix');
                    setEmbedType('wiflix');
                  } else if (viperSources.length > 0) {
                    setSelectedSource('viper' as any);
                    setSelectedViperSource(0);
                    setEmbedUrl(viperSources[0].url);
                    setEmbedType('viper');
                  } else {
                    const multi = coflixData ? getMultiFromCoflix(coflixData) : null;
                    if (multi && coflixData) {
                      setSelectedSource('coflix');
                      setSelectedPlayerLink(coflixData.player_links.findIndex((p: { decoded_url: string; clone_url?: string; quality: string; language: string }) => p === multi));
                      setEmbedUrl(getCoflixPreferredUrl(multi));
                      setEmbedType('coflix');
                    } else if (frembedAvailable) {
                      setSelectedSource('frembed');
                      setVideoSource(`${getFrembedBase()}/api/film.php?id=${id}`);
                      setEmbedUrl(`${getFrembedBase()}/api/film.php?id=${id}`);
                      setEmbedType('frembed');
                    } else if (customSources.length > 0) {
                      setSelectedSource('custom');
                      setEmbedUrl(customSources[0]);
                      setEmbedType('custom');
                    } else {
                      setSelectedSource('vostfr');
                      setEmbedUrl(`https://player.videasy.net/movie/${id}`);
                      setEmbedType('vostfr');
                    }
                  }
                }
              }
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}

            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'swiftflux' ? (
        // Une seule branche, résolue ou non : tant que la porte n'a rien rendu,
        // le lecteur est monté avec une source vide. C'est lui qu'on voit
        // derrière le voile, avec son menu des sources — pas un écran noir —
        // donc refermer la porte laisse de quoi choisir autre chose.
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`swiftflux-${id}-${swiftfluxPlayback?.url || 'pending'}`}
            src={swiftfluxPlayback?.url || ''}
            // Le CDN partenaire répond une 302 vers un autre domaine : en mode
            // CORS le navigateur refuse de la suivre.
            disableCrossOrigin
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // Source vide = porte pas encore franchie : l'erreur est attendue,
              // elle ne doit pas rouvrir la porte en boucle.
              if (!swiftfluxPlayback) return;
              // Le lien est à usage unique du point de vue de l'interface : on
              // repasse par la porte plutôt que de réessayer une URL périmée.
              setSwiftfluxPlayback(null);
              setSwiftfluxGateOpen(true);
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}
            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}
                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'mp4' && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`mp4-${selectedMp4Source}-${id}-${videoSource}`}
            src={videoSource || mp4Sources[selectedMp4Source]?.url || ""}
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // Try next MP4 source if available
              if (selectedMp4Source < mp4Sources.length - 1) {
                const nextIndex = selectedMp4Source + 1;
                setSelectedMp4Source(nextIndex);
                setVideoSource(mp4Sources[nextIndex].url);
              } else if (darkinoSources.length > 0) {
                setSelectedSource('darkino');
                setSelectedDarkinoSource(0);
              } else if (mp4Sources.length > 0) {
                setSelectedSource('mp4');
                setSelectedMp4Source(0);
                setVideoSource(mp4Sources[0].url);
              }
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}

            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : ((selectedSource === 'nexus_hls' && nexusHlsSources.length > 0) || (selectedSource === 'bravo' && purstreamSources.length > 0 && canUseBravo) || (selectedSource === 'kisskh' && kisskhSources.length > 0)) && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`nexus_hls-${selectedNexusHlsSource}-${id}-${videoSource}`}
            src={videoSource || nexusHlsSources[selectedNexusHlsSource]?.url || ""}
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // Try next Nexus HLS source if available
              if (selectedNexusHlsSource < nexusHlsSources.length - 1) {
                const nextIndex = selectedNexusHlsSource + 1;
                setSelectedNexusHlsSource(nextIndex);
                setVideoSource(nexusHlsSources[nextIndex].url);
              } else if (nexusFileSources.length > 0) {
                setSelectedSource('nexus_file');
                setSelectedNexusFileSource(0);
                setVideoSource(nexusFileSources[0].url);
              } else if (darkinoSources.length > 0) {
                setSelectedSource('darkino');
                setSelectedDarkinoSource(0);
              }
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}

            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'nexus_file' && nexusFileSources.length > 0 && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`nexus_file-${selectedNexusFileSource}-${id}-${videoSource}`}
            src={videoSource || nexusFileSources[selectedNexusFileSource]?.url || ""}
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // Try next Nexus File source if available
              if (selectedNexusFileSource < nexusFileSources.length - 1) {
                const nextIndex = selectedNexusFileSource + 1;
                setSelectedNexusFileSource(nextIndex);
                setVideoSource(nexusFileSources[nextIndex].url);
              } else if (nexusHlsSources.length > 0) {
                setSelectedSource('nexus_hls');
                setSelectedNexusHlsSource(0);
                setVideoSource(nexusHlsSources[0].url);
              } else if (darkinoSources.length > 0) {
                setSelectedSource('darkino');
                setSelectedDarkinoSource(0);
              }
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}

            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : selectedSource === 'darkino' && darkinoSources.length > 0 && (!adPopupTriggered || shouldLoadIframe || hasClickedAd) ? (
        <div className="w-full h-full flex items-center justify-center">
          <HLSPlayer
            priorityCategory="moviesTv"
            autoFallbackGuard={autoFallbackGuard}
            key={`darkino-${selectedDarkinoSource}-${id}`}
            src={darkinoSources[selectedDarkinoSource]?.m3u8 || darkinoSources[0]?.m3u8 || ""}
            className="w-full h-full"
            autoPlay={true}
            onError={() => {
              // Try next Darkino source if available
              if (selectedDarkinoSource < darkinoSources.length - 1) {
                const nextIndex = selectedDarkinoSource + 1;
                setSelectedDarkinoSource(nextIndex);
                setVideoSource(darkinoSources[nextIndex].m3u8);
              } else if (nexusFileSources.length > 0) {
                setSelectedSource('nexus_file');
                setSelectedNexusFileSource(0);
                setVideoSource(nexusFileSources[0].url);
              } else if (nexusHlsSources.length > 0) {
                setSelectedSource('nexus_hls');
                setSelectedNexusHlsSource(0);
                setVideoSource(nexusHlsSources[0].url);
              } else if (darkinoSources.length > 0) {
                setSelectedSource('darkino');
                setSelectedDarkinoSource(0);
              }
            }}
            nextMovie={nextMovie}
            onNextMovie={handleNextMovie}
            poster={posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined}
            backdrop={backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined}
            movieId={id || undefined}
            controls={true}
            nexusHlsSources={nexusHlsSources}
            nexusFileSources={nexusFileSources}
            purstreamSources={purstreamSources}
            darkinoSources={darkinoSources}
            mp4Sources={mp4Sources}
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
            kisskhSources={kisskhSources}
            kisskhSubtitles={kisskhSubtitles}
            loadingKisskh={loadingKisskh}

            title={movieTitle}
            initialTime={watchProgress}
          />
          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : embedUrl ? (
        <div className="w-full h-full flex flex-col items-center justify-center relative">
          {/* Back to Info Button */}
          <button
            onClick={() => navigate(`/movie/${id}`)}
            className="fixed top-6 left-8 z-[9999] flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('watch.back')}
          </button>

          {/* Boutons en haut à droite */}
          <div className="fixed top-6 right-8 z-[10000] flex items-center gap-2">
            {/* Bouton Ouvrir dans une nouvelle page */}
            <button
              onClick={() => window.open(embedUrl || '', '_blank', 'noopener')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/90 border border-gray-600 hover:bg-gray-700/90 text-white font-medium text-sm transition-all duration-200"
              title={t('watch.openInNewPage')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            {/* Bouton Changer de source */}
            <button
              onClick={() => setShowEmbedQuality(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/90 border border-gray-700 hover:bg-gray-800/80 text-white font-medium text-sm transition-all duration-200"
            >
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
              <span className="hidden sm:inline">{t('watch.sources')}</span>
            </button>
          </div>

          {/* Iframe pour les sources embed */}
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
              // Pour Coflix: jamais de sandbox pour les lecteurs multi
              if (embedType === 'coflix') {
                return undefined;
              }
              // Par défaut, pas de sandbox
              return undefined;
            })()}
          ></iframe>

          {/* Sources Menu Overlay */}
          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      ) : (
        // Show VO/VOSTFR when nothing else is available
        <div className="w-full h-full flex flex-col items-center justify-center relative">
          {/* Back to Info Button */}
          <button
            onClick={() => navigate(`/movie/${id}`)}
            className="fixed top-6 left-8 z-[9999] flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 hover:bg-black/90 text-white shadow-lg transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('watch.back')}
          </button>

          {/* Boutons en haut à droite */}
          <div className="fixed top-6 right-8 z-[10000] flex items-center gap-2">
            {/* Bouton Ouvrir dans une nouvelle page */}
            <button
              onClick={() => window.open(selectedSource === 'vostfr' ? `https://player.videasy.net/movie/${id}` : `${getFrembedBase()}/api/film.php?id=${id}`, '_blank', 'noopener')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/90 border border-gray-600 hover:bg-gray-700/90 text-white font-medium text-sm transition-all duration-200"
              title={t('watch.openInNewPage')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            {/* Bouton Changer de source */}
            <button
              onClick={() => setShowEmbedQuality(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/90 border border-gray-700 hover:bg-gray-800/80 text-white font-medium text-sm transition-all duration-200"
            >
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
              <span className="hidden sm:inline">{t('watch.sources')}</span>
            </button>
          </div>

          <iframe
            src={selectedSource === 'vostfr' ? `https://player.videasy.net/movie/${id}` : `${getFrembedBase()}/api/film.php?id=${id}`}
            className="w-full h-full border-0"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          ></iframe>

          <PlayerOverlayPortal>
          <AnimatePresence>
            {showEmbedQuality && (
              <motion.div
                key="embed-quality-menu"
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="fixed inset-0 z-[10000] bg-black/50 flex justify-end pointer-events-auto"
              >
                <div className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto z-[10000]">
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
                      src={''}
                      className="hidden"
                      movieId={id || undefined}
                      controls={false}
                      nexusHlsSources={nexusHlsSources}
                      nexusFileSources={nexusFileSources}
                      purstreamSources={purstreamSources}
                      darkinoSources={darkinoSources}
                      mp4Sources={mp4Sources}
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
                      kisskhSources={kisskhSources}
                      kisskhSubtitles={kisskhSubtitles}
                      loadingKisskh={loadingKisskh}

                      autoPlay={false}
                      onlyQualityMenu={true}
                      embedType={embedType || undefined}
                      embedUrl={embedUrl || undefined}
                      title={movieTitle}
                      initialTime={watchProgress}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          </PlayerOverlayPortal>
        </div>
      )}

      {/* Ad popup rendered as an overlay (not in the player/loading branch) so
          click-anywhere mode keeps the preloaded player visible behind the
          transparent catcher. Normal mode's dialog still covers the gated
          (black) loading state below it. */}
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
          request={{ kind: 'movie', tmdbId: id || '', index: 0 }}
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

export default WatchMovie;
