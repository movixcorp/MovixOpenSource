import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLightMode } from '../context/LightModeContext';
import { ChevronRight, ExternalLink, Gauge, Loader2 } from 'lucide-react';
import ReactCountryFlag from 'react-country-flag';
import { Select, SelectTrigger, SelectContent, SelectItem } from '@/components/ui/select';
import CustomDropdown from './CustomDropdown';
import { computeFacets, filterTracks } from '../services/subtitles/index.ts';
import type { SubtitleFilters, SubtitleTrack } from '../services/subtitles/index.ts';
import { SubtitleStyleControls } from './subtitles/SubtitleStyleControls';
import SkipSegmentsPanel from './Settings/SkipSegmentsPanel';
import * as skipSegmentPrefs from '../utils/skipSegmentPrefs';
import { PinButton } from './ui/PinButton';
import { HLSQualitySelector } from './HLSQualitySelector';
import { HLSServerSelector } from './HLSServerSelector';
import { sortHostersByPriority } from '../utils/sourceAutoSelect';
import { groupSeekStreamingSources } from '../utils/seekStreamingCandidates';
import { detectHoster } from '../utils/hosterRegistry';
import {
  getSourcePriorityPrefs,
  subscribeToPriorityChanges,
  pinSource,
  unpinSource,
  pinHoster,
  unpinHoster,
} from '../utils/sourcePriorityPrefs';
import type {
  HosterId, PriorityCategory, TopLevelSourceId, LanguageId,
} from '../types/sourcePriority';
import type { KisskhSource, KisskhSubtitleTrack } from '../types/kisskh';
import type { SubtitlePreferencePatch, SubtitlePreferences } from '../utils/subtitlePreferences';
import {
  AUTOPLAY_SECONDS_MAX,
  PERCENTAGE_MAX,
  PERCENTAGE_MIN,
  TIME_BEFORE_END_MAX,
  TIME_BEFORE_END_MIN,
  type NextContentPrefs,
} from '../utils/nextContentPrefs';

/**
 * Milestone 4 — mapping des `source_main` types (labels internes du panneau
 * serveurs, ex. "fstream_main") vers leur `TopLevelSourceId` côté prefs.
 *
 * Les ids absents (`nexus_main`, `vostfr_main`, `frembed_main`, `adfree_main`)
 * ne sont pas épinglables depuis ce panneau : `nexus_main` est un agrégat de
 * `nexus_hls`+`nexus_file` (ambigu), les autres n'ont pas de bouton dédié
 * dans la rangée top-level ou représentent des cas spéciaux.
 */
const SOURCE_MAIN_TO_TOP_LEVEL: Record<string, TopLevelSourceId> = {
  darkino_main: 'darkino',
  fstream_main: 'fstream',
  wiflix_main: 'wiflix',
  j1f_main: 'j1f',
  swiftflow_main: 'swiftflow',
  swiftflux: 'swiftflux',
  omega_main: 'omega',
  multi_main: 'coflix', // multi = coflix (naming historique)
  viper_main: 'viper',
  vox_main: 'vox',
  kisskh_main: 'kisskh',
  bravo_main: 'bravo',
  vostfr_main: 'vostfr',
  frembed_main: 'frembed',
  mp4: 'mp4',
  custom: 'custom',
};

interface HLSPlayerSettingsPanelProps extends Record<string, any> {
  kisskhSources?: KisskhSource[];
  kisskhSubtitles?: KisskhSubtitleTrack[];
  loadingKisskh?: boolean;
  subtitlePreferences: SubtitlePreferences;
  patchSubtitlePreferences: (patch: SubtitlePreferencePatch) => void;
  previewSubtitlePreferences: (patch: SubtitlePreferencePatch) => void;
  commitSubtitlePreferences: () => void;
  resetSubtitleAppearance: () => void;
}

// Translation target language codes with their country codes for flags
const TRANSLATION_LANGS = [
  { code: 'fr', country: 'FR' }, { code: 'en', country: 'GB' }, { code: 'es', country: 'ES' },
  { code: 'de', country: 'DE' }, { code: 'it', country: 'IT' }, { code: 'pt', country: 'PT' },
  { code: 'ru', country: 'RU' }, { code: 'ja', country: 'JP' }, { code: 'ko', country: 'KR' },
  { code: 'zh', country: 'CN' }, { code: 'ar', country: 'SA' }, { code: 'hi', country: 'IN' },
  { code: 'tr', country: 'TR' }, { code: 'nl', country: 'NL' }, { code: 'pl', country: 'PL' },
  { code: 'uk', country: 'UA' }, { code: 'id', country: 'ID' }, { code: 'ms', country: 'MY' },
  { code: 'km', country: 'KH' }, { code: 'bg', country: 'BG' }, { code: 'cs', country: 'CZ' },
  { code: 'da', country: 'DK' }, { code: 'el', country: 'GR' }, { code: 'fi', country: 'FI' },
  { code: 'he', country: 'IL' }, { code: 'hu', country: 'HU' }, { code: 'no', country: 'NO' },
  { code: 'ro', country: 'RO' }, { code: 'sk', country: 'SK' }, { code: 'sv', country: 'SE' },
  { code: 'th', country: 'TH' }, { code: 'vi', country: 'VN' }, { code: 'bn', country: 'BD' },
  { code: 'ta', country: 'IN' }, { code: 'ur', country: 'PK' }, { code: 'fa', country: 'IR' },
  { code: 'sr', country: 'RS' }, { code: 'hr', country: 'HR' }, { code: 'sl', country: 'SI' },
  { code: 'lt', country: 'LT' }, { code: 'lv', country: 'LV' }, { code: 'et', country: 'EE' },
  { code: 'sw', country: 'KE' }, { code: 'af', country: 'ZA' }, { code: 'ca', country: 'ES' },
  { code: 'gl', country: 'ES' }, { code: 'is', country: 'IS' }, { code: 'ga', country: 'IE' },
  { code: 'mr', country: 'IN' }, { code: 'ne', country: 'NP' }, { code: 'pa', country: 'IN' },
  { code: 'te', country: 'IN' }, { code: 'ml', country: 'IN' }, { code: 'gu', country: 'IN' },
  { code: 'kn', country: 'IN' }, { code: 'my', country: 'MM' }, { code: 'am', country: 'ET' },
  { code: 'hy', country: 'AM' }, { code: 'ka', country: 'GE' }, { code: 'az', country: 'AZ' },
  { code: 'kk', country: 'KZ' }, { code: 'uz', country: 'UZ' }, { code: 'lo', country: 'LA' },
  { code: 'si', country: 'LK' },
] as const;

const HLSPlayerSettingsPanel = (props: HLSPlayerSettingsPanelProps) => {
  const { effectivePrefs } = useLightMode();
  const animationsDisabled = !effectivePrefs.transitions;

  const getTransition = useCallback((tObj: any) => {
    return animationsDisabled ? { duration: 0 } : tObj;
  }, [animationsDisabled]);

  const hoverProp = useCallback((hObj: any) => {
    return animationsDisabled ? undefined : hObj;
  }, [animationsDisabled]);

  const tapProp = useCallback((tObj: any) => {
    return animationsDisabled ? undefined : tObj;
  }, [animationsDisabled]);
  const {
    settingsMenuRef,
    settingsMenuWidth,
    audioTracks,
    qualities,
    qualityPreference,
    effectiveQualityHeight,
    handleQualityPreferenceChange,
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
    kisskhSources = [],
    loadingKisskh = false,
    purstreamSources,
    embedUrl,
    onlyQualityMenu,
    embedType,
    handleSourceChange,
    renderSourceQualityMeta,
    renderCopySourceButton,
    hlsQualityScan,
    runHlsQualityScan,
    showDarkinoMenu,
    showOmegaMenu,
    showCoflixMenu,
    showFstreamMenu,
    showWiflixMenu,
    showJ1fMenu,
    showSwiftflowMenu,
    showNexusMenu,
    showBravoMenu,
    showViperMenu,
    showVoxMenu,
    showVostfrMenu,
    omegaSources,
    coflixSources,
    fstreamSources,
    wiflixSources,
    j1fSources,
    swiftflowSources,
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
    externalTracks = [] as SubtitleTrack[],
    externalProviderErrors = [] as Array<{ provider: string; message: string }>,
    preferredSubtitleLang,
    externalLoading,
    translateSubsTo,
    setTranslateSubsTo,
    translationProgress,
    translationLang,
    translatedSubtitleHistory = [],
    activeTranslatedSubtitleId,
    activateTranslatedSubtitle,
    startSubtitleTranslation,
    cancelSubtitleTranslation,
    loadingSubtitle,
    loadExternalSubtitle,
    setLoadingSubtitle,
    selectedExternalSub,
    setCurrentSubtitle,
    setSubtitleContainerVisible,
    refreshActiveCues,
    subtitlePreferences,
    patchSubtitlePreferences,
    previewSubtitlePreferences,
    commitSubtitlePreferences,
    resetSubtitleAppearance,
    playbackSpeed,
    handlePlaybackSpeedChange,
    saveProgressEnabled,
    setSaveProgressEnabled,
    autoNextEpisodeEnabled,
    setAutoNextEpisodeEnabled,
    keepFullscreenOnEpisodeChange,
    setKeepFullscreenOnEpisodeChange,
    resumePlaybackOnEpisodeChange,
    setResumePlaybackOnEpisodeChange,
    nextPrefs,
    onNextPrefsChange,
    skipSettings,
    segmentProviderStatus,
    segmentProviderDetail,
    onSkipSettingsChange,
    onSegmentTypeChange,
    onSegmentColorChange,
    onProviderToggle,
    onProviderReorder,
    onSkipSettingsReset,
    onOpenSegmentStudio,
    communitySubmissionCount,
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
  } = props;

  const category: PriorityCategory = priorityCategory === 'anime' ? 'anime' : 'moviesTv';

  // Réglages de la proposition « À suivre ». `props` est typé `Record<string,
  // any>` : on renomme ici une bonne fois pour retrouver le type réel.
  const nextContent = nextPrefs as NextContentPrefs;
  const setNextContent = onNextPrefsChange as (patch: Partial<NextContentPrefs>) => void;

  /**
   * Le déclenchement « au générique » peut-il fonctionner ?
   *
   * Les séquences sont filtrées par les réglages de saut : couper le type
   * « générique » là-bas prive aussi ce déclencheur. Sans ce contrôle, la
   * bascule resterait sur « au générique » sans jamais rien faire.
   */
  const creditsSegmentsAvailable = Boolean(
    skipSettings && (
      skipSegmentPrefs.resolveSegmentMode(skipSettings, 'outro') !== 'off'
      || skipSegmentPrefs.resolveSegmentMode(skipSettings, 'credits') !== 'off'
    ),
  );

  const choiceClass = (active: boolean) =>
    `flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${active
      ? 'bg-red-600 text-white font-medium'
      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`;

  /** Remplissage rouge d'un curseur, comme les autres réglages du panneau. */
  const sliderFill = (value: number, min: number, max: number) => {
    const ratio = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return `linear-gradient(to right, #dc2626 0%, #dc2626 ${ratio}%, #374151 ${ratio}%, #374151 100%)`;
  };

  const [subtitleFilters, setSubtitleFilters] = useState<SubtitleFilters>({
    lang: 'all',
    source: 'all',
    query: '',
  });
  const [visibleResultCount, setVisibleResultCount] = useState(60);

  const subtitleFacets = useMemo(
    () => computeFacets(externalTracks, subtitleFilters),
    [externalTracks, subtitleFilters],
  );
  const filteredTracks = useMemo(
    () => filterTracks(externalTracks, subtitleFilters),
    [externalTracks, subtitleFilters],
  );

  // Defaut : la langue de l'interface (recue via `preferredSubtitleLang`,
  // deja calculee dans HLSPlayer.tsx a partir de i18n.language) si elle est
  // presente dans les resultats, sinon « toutes ». Ne s'applique qu'une fois
  // par jeu de resultats, pour ne pas ecraser un choix manuel de l'utilisateur.
  const defaultLangAppliedRef = useRef<string>('');
  useEffect(() => {
    const signature = `${externalTracks.length}:${externalTracks[0]?.id ?? ''}`;
    if (!externalTracks.length || defaultLangAppliedRef.current === signature) return;
    defaultLangAppliedRef.current = signature;

    const uiLang = preferredSubtitleLang || 'fr';
    const hasUiLang = externalTracks.some((track: SubtitleTrack) => track.lang === uiLang);
    // Reinitialise aussi source et query : sinon une puce de source qui n'existe
    // plus dans les nouvelles facettes reste "selectionnee" sans rien surligner,
    // et comme le compteur de langue applique le filtre de source, toutes les
    // langues tombent a zero (l'utilisateur croit qu'il n'y a pas de sous-titres).
    setSubtitleFilters(prev => ({
      ...prev, lang: hasUiLang ? uiLang : 'all', source: 'all', query: '',
    }));
    setVisibleResultCount(60);
  }, [externalTracks, preferredSubtitleLang]);

  // ===== Milestone 3 — sort hoster lists by user priority =====
  // Re-render when priority prefs change (e.g. user reorders in Settings).
  const [, setPrefsVersion] = useState(0);

  // ===== Milestone 4 — pinned source / hoster ids for PinButton UI =====
  // Ces états reflètent en live l'état épinglé dans les prefs et se mettent
  // à jour via `subscribeToPriorityChanges` (custom event + storage cross-onglets).
  // `pinnedSourceId` n'existe que pour `moviesTv` (langue côté anime → géré dans WatchAnime).
  const [pinnedSourceId, setPinnedSourceId] = useState<TopLevelSourceId | null>(
    () => getSourcePriorityPrefs().categories.moviesTv.pinnedSource?.id ?? null,
  );
  const [pinnedHosterId, setPinnedHosterId] = useState<HosterId | null>(
    () => getSourcePriorityPrefs().categories[
      priorityCategory === 'anime' ? 'anime' : 'moviesTv'
    ].pinnedHoster?.id ?? null,
  );

  useEffect(() => subscribeToPriorityChanges((p) => {
    setPrefsVersion((v) => v + 1);
    setPinnedSourceId(p.categories.moviesTv.pinnedSource?.id ?? null);
    setPinnedHosterId(p.categories[category].pinnedHoster?.id ?? null);
  }), [category]);

  /**
   * Enrichit chaque item avec son `type` (hoster détecté via URL) puis trie selon
   * la priorité utilisateur pour `category` + `topLevel` optionnel.
   *
   * `topLevel` permet d'utiliser un override d'ordre spécifique à une source
   * top-level (ex: ordre hoster custom pour fstream) si défini.
   */
  const enrichAndSort = useCallback(<T extends Record<string, unknown>>(
    list: T[],
    topLevel?: TopLevelSourceId | LanguageId,
  ): Array<T & { type: HosterId }> => {
    if (!list || list.length === 0) return [];
    const prefs = getSourcePriorityPrefs();
    const opts = {
      patternOverrides: prefs.patternOverrides,
      customHosters: prefs.customHosters,
    };
    const withType = list.map((item) => {
      const rec = item as Record<string, unknown>;
      const url = String(rec?.url ?? rec?.link ?? rec?.m3u8 ?? '');
      // Fallback label-based — pour les sources HLS extraites où l'URL m3u8
      // finale ne contient plus le nom du hoster (CDN nu) mais où le label
      // l'expose ("Uqload HD", "Vidmoly VF"…).
      const label = String(rec?.label ?? rec?.player ?? rec?.name ?? rec?.quality ?? '');
      const type = (detectHoster(url, opts) ?? detectHoster(label, opts)) ?? 'unknown';
      return { ...item, type } as T & { type: HosterId };
    });
    return sortHostersByPriority(withType, { category, topLevel });
  }, [category]);

  /**
   * Milestone 4 — détection rapide du hoster depuis une URL (pour les menus
   * qui n'utilisent pas `enrichAndSort`, ex. omega, coflix, fstream,
   * wiflix). Retourne null si pas un hoster connu → PinButton non affiché.
   * Le param `label` permet de retomber sur le nom du lecteur quand l'URL
   * finale est un CDN nu (cas darkino / nexus_hls extrait).
   */
  const detectHosterFromUrl = useCallback((url?: string | null, label?: string | null): HosterId | null => {
    const prefs = getSourcePriorityPrefs();
    const opts = {
      patternOverrides: prefs.patternOverrides,
      customHosters: prefs.customHosters,
    };
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

  /**
   * Milestone 4 — handler de toggle partagé entre toutes les lignes hoster.
   * Pin si différent de l'actuel, sinon unpin.
   */
  const toggleHosterPin = useCallback((hosterId: HosterId) => {
    if (pinnedHosterId === hosterId) {
      unpinHoster(category);
    } else {
      pinHoster(category, hosterId);
    }
  }, [pinnedHosterId, category]);

  /**
   * Milestone 4 — rend un PinButton pour une ligne hoster si le hoster est
   * détecté (type !== 'unknown'). Retourne null sinon → rien n'est rendu.
   */
  const renderHosterPin = useCallback((hosterId: HosterId | null | undefined) => {
    if (!hosterId || hosterId === 'unknown') return null;
    return (
      <PinButton
        isPinned={pinnedHosterId === hosterId}
        onToggle={() => toggleHosterPin(hosterId)}
        size={12}
        className="shrink-0"
      />
    );
  }, [pinnedHosterId, toggleHosterPin]);

  // ===== Snapshots triés (M4 stabilité UX) =====
  // On memoise le tri par liste source pour ne PAS réordonner visuellement
  // quand l'utilisateur clique pin (le clic met à jour les prefs et l'indicateur
  // `#1`, mais l'ordre affiché reste stable jusqu'au prochain refresh / changement
  // de la source list). Évite le "ça recharge" perçu lors du pin.
  // Deps volontairement limitées à la référence de la liste : prefsVersion N'EST PAS
  // dans les deps pour préserver la stabilité.
  const sortedDarkinoMemo = useMemo(
    () => enrichAndSort(darkinoSources ?? [], 'darkino'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [darkinoSources],
  );
  const sortedNexusHlsMemo = useMemo(
    () => enrichAndSort(nexusHlsSources ?? [], 'nexus_hls'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nexusHlsSources],
  );
  const seekStreamingNexusMemo = useMemo(
    () => sortedNexusHlsMemo.filter(source => (
      source.seekKind === 'cfNative' || source.seekKind === 'source'
    )),
    [sortedNexusHlsMemo],
  );
  const seekStreamingNexusGroupsMemo = useMemo(
    () => groupSeekStreamingSources(seekStreamingNexusMemo),
    [seekStreamingNexusMemo],
  );
  const otherNexusHlsMemo = useMemo(
    () => sortedNexusHlsMemo.filter(source => (
      source.seekKind !== 'cfNative' && source.seekKind !== 'source'
    )),
    [sortedNexusHlsMemo],
  );
  const sortedNexusFileMemo = useMemo(
    () => enrichAndSort(nexusFileSources ?? [], 'nexus_hls'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nexusFileSources],
  );
  const sortedViperMemo = useMemo(
    () => enrichAndSort(viperSources ?? [], 'viper'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viperSources],
  );
  const sortedVoxMemo = useMemo(
    () => enrichAndSort(voxSources ?? [], 'vox'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voxSources],
  );
  const sortedBravoMemo = useMemo(
    () => enrichAndSort(purstreamSources ?? [], 'bravo'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [purstreamSources],
  );

  return (
    <motion.div
      ref={settingsMenuRef}
      key="settings-panel"
      initial={{
        opacity: 0,
        width: 0
      }}
      animate={{
        opacity: 1,
        width: settingsMenuWidth || (audioTracks.length > 0 || subtitles.length > 0 ? 480 : 400)
      }}
      exit={{
        opacity: 0,
        width: 0
      }}
      transition={getTransition({
        duration: 0.3,
        ease: [0.25, 1, 0.5, 1]
      })}
      style={{
        height: '100%',
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        maxWidth: '90vw'
      }}
      className="bg-black/95 z-[10002] flex flex-col border-l border-gray-800 shadow-xl"
    >
            <div className="flex flex-col border-b border-gray-800 mb-4">
              <div className="flex justify-between items-center mb-3 px-4 pt-4">
                <h3 className="text-white font-medium text-lg">{t('watch.settingsTitle')}</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-white hover:text-red-600 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-x">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                  </svg>
                </button>
              </div>
              {/* Updated Tab Button Container with Horizontal Scrolling */}
              <div className="relative border-b border-gray-700/60">
                {/* Scroll Hint for Mobile */}
                <div className="md:hidden text-xs text-gray-400 text-center py-1 bg-gray-800/50">
                  {t('watch.swipeForMore')}
                </div>

                {/* Scrollable Tabs Container */}
                <div
                  ref={tabsContainerRef}
                  className="flex items-center px-2 space-x-1 overflow-x-auto scrollbar-hide scroll-smooth"
                  style={{
                    scrollbarWidth: 'none',
                    msOverflowStyle: 'none'
                  }}
                >
                  {/* Left Scroll Indicator */}
                  <div className="absolute left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-gray-900 to-transparent pointer-events-none z-10 md:hidden" />

                  {/* Right Scroll Indicator */}
                  <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-gray-900 to-transparent pointer-events-none z-10 md:hidden" />
                  {/* Only show Quality tab if not in anime HLS mode */}
                  {!(isAnime && tvShowId && src.includes('.m3u8')) && (
                    <motion.button
                      onClick={() => setSettingsTab('quality')}
                      className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'quality' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                        }`}
                      whileTap={tapProp({ scale: 0.97 })}
                    >
                      {t('watch.qualityTab')}
                      {settingsTab === 'quality' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                    </motion.button>
                  )}
                  <motion.button
                    onClick={() => setSettingsTab('format')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'format' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.formatTab')}
                    {settingsTab === 'format' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  <motion.button
                    onClick={() => setSettingsTab('speed')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'speed' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.speedTab')}
                    {settingsTab === 'speed' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  {/* Conditional rendering for HLS-specific tabs */}
                  {audioTracks.length > 0 && (
                    <motion.button
                      onClick={() => setSettingsTab('audio')}
                      className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'audio' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                        }`}
                      whileTap={tapProp({ scale: 0.97 })}
                    >
                      {t('watch.audioTab')}
                      {settingsTab === 'audio' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                    </motion.button>
                  )}
                  {/* Show subtitles tab for all content - it provides external subtitle search and style options */}
                  <motion.button
                    onClick={() => setSettingsTab('subtitles')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'subtitles' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.subtitlesTab')}
                    {settingsTab === 'subtitles' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  {/* Style tab for subtitle appearance - always visible as it can be useful for future subtitles */}
                  <motion.button
                    onClick={() => setSettingsTab('style')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'style' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.styleST')}
                    {settingsTab === 'style' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  {/* Add the Progression Tab button */}
                  <motion.button
                    onClick={() => setSettingsTab('progression')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'progression' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.progressionTab')}
                    {settingsTab === 'progression' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  {/* Audio Enhancer Tab */}
                  <motion.button
                    onClick={() => setSettingsTab('enhancer')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'enhancer' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.audioPlusTab')}
                    {settingsTab === 'enhancer' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                  {/* Video OLED Tab */}
                  <motion.button
                    onClick={() => setSettingsTab('oled')}
                    className={`relative py-2 px-3 text-sm font-medium rounded-t-md transition-colors duration-200 ease-out flex-shrink-0 min-w-max ${settingsTab === 'oled' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                      }`}
                    whileTap={tapProp({ scale: 0.97 })}
                  >
                    {t('watch.oledTab')}
                    {settingsTab === 'oled' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                  </motion.button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-x-hidden overflow-y-auto custom-scrollbar p-4" data-lenis-prevent>
              <AnimatePresence mode="wait">
                {settingsTab === 'quality' && (
                  <motion.div
                    key="quality"
                    ref={sourceMenuRef}
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2"
                    data-source-menu
                    onFocusCapture={handleSourceMenuFocusCapture}
                  >
                    <HLSQualitySelector
                      options={qualities}
                      preference={qualityPreference}
                      effectiveHeight={effectiveQualityHeight}
                      onSelect={handleQualityPreferenceChange}
                      title={t('watch.streamQuality')}
                      autoLabel={t('watch.qualityAuto')}
                      playingLabel={t('watch.qualityPlaying')}
                    />

                    {/* Sources HLS d'abord */}
                    {sourceGroups.map((group, groupIndex) => (
                      <div key={`group_${groupIndex}`} className="mb-6">
                        <div className="flex items-center justify-between gap-2 mb-2 px-2">
                          <h4 className="text-gray-400 text-xs uppercase tracking-wider">{group.title}</h4>
                          {group.type === 'hls' && (
                            hlsQualityScan?.status === 'running' ? (
                              <span className="flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {hlsQualityScan.done}/{hlsQualityScan.total}
                              </span>
                            ) : (
                              <button
                                onClick={runHlsQualityScan}
                                title={t('watch.qualityCheckTitle')}
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-800/70 hover:bg-gray-700 text-gray-300 hover:text-white whitespace-nowrap"
                              >
                                <Gauge className="w-3.5 h-3.5" />
                                {t('watch.qualityCheck')}
                              </button>
                            )
                          )}
                        </div>

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
                            isActive = (nexusHlsSources && nexusHlsSources.some(ns => ns.url === src)) ||
                              (nexusFileSources && nexusFileSources.some(ns => ns.url === src));
                          } else if (source.type === 'mp4') {
                            isActive = src === source.url; // Direct comparison for MP4
                          } else if (source.type === 'swiftflux') {
                            // `#` = pas encore débloquée, donc rien à comparer.
                            isActive = source.url !== '#' && src === source.url;
                          } else if (source.type === 'kisskh_main') {
                            isActive = kisskhSources.some((kisskhSource: KisskhSource) => (
                              kisskhSource.url === src && kisskhSource.id === source.id
                            ));
                          } else if (source.type === 'm3u8') { // Added check for AdFree M3U8
                            isActive = src === source.url;
                          } else if (source.type === 'viper_main') {
                            // Main Viper button is active if any viper source is active
                            isActive = viperSources.some(vs => vs.url === embedUrl);
                          } else if (source.type === 'vox_main') {
                            // Main Vox button is active if any vox source is active
                            isActive = voxSources.some(vs => vs.link === embedUrl);
                          } else if (source.type === 'bravo_main') {
                            isActive = purstreamSources.some(ps => ps.url === src);
                          } else {
                            // Existing logic for embed sources
                            isActive = !!source.isActive || (onlyQualityMenu && embedType === source.type && embedUrl === source.url);
                          }
                          // Milestone 4 — TopLevelSourceId mappé depuis le `source_main`
                          // pour les boutons de rangée top-level (Films/Séries uniquement).
                          // `nexus_main` est exclu (agrégat ambigu) et le pin ne s'affiche que
                          // pour la catégorie `moviesTv` (langue anime gérée dans WatchAnime).
                          const topLevelForPin: TopLevelSourceId | null = category === 'moviesTv'
                            ? (SOURCE_MAIN_TO_TOP_LEVEL[source.type] ?? null)
                            : null;
                          return (
                            <React.Fragment key={source.id}>
                              <div className="mb-2 flex items-stretch gap-2">
                                <button
                                  onClick={() => handleSourceChange(source.type, source.id, source.url)}
                                  disabled={source.type === 'kisskh_main' && loadingKisskh}
                                  className={`w-full flex-1 px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isActive ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                                    } ${onlyQualityMenu && embedType && embedUrl && source.type === embedType && source.url === embedUrl ? 'ring-2 ring-red-500 bg-gray-800/80' : ''} ${''
                                    }`}
                                >
                                  <div className="min-w-0 flex flex-1 flex-col">
                                    <span className={`${isActive ? 'text-red-600 font-medium' : 'text-white'} ${''
                                      }`}>
                                      {source.label}
                                      {topLevelForPin && pinnedSourceId === topLevelForPin && (
                                        <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                      )}
                                    </span>
                                    {group.type === 'hls' && (source.mediaType === 'mp4' || source.type === 'mp4' || source.type === 'm3u8') && renderSourceQualityMeta(source.url, isActive, source.quality, source.label)}
                                  </div>
                                  <div className="ml-3 flex items-center gap-2">
                                    {(source.type === 'darkino_main' || source.type === 'omega_main' || source.type === 'multi_main' || source.type === 'fstream_main' || source.type === 'wiflix_main' || source.type === 'j1f_main' || source.type === 'swiftflow_main' || source.type === 'nexus_main' || source.type === 'bravo_main' || source.type === 'viper_main' || source.type === 'vox_main') && (
                                      <ChevronRight className={`w-4 h-4 transition-transform ${(source.type === 'darkino_main' && showDarkinoMenu) ||
                                        (source.type === 'omega_main' && showOmegaMenu) ||
                                        (source.type === 'multi_main' && showCoflixMenu) ||
                                        (source.type === 'fstream_main' && showFstreamMenu) ||
                                        (source.type === 'wiflix_main' && showWiflixMenu) ||
                                        (source.type === 'j1f_main' && showJ1fMenu) ||
                                        (source.type === 'swiftflow_main' && showSwiftflowMenu) ||
                                        (source.type === 'nexus_main' && showNexusMenu) ||
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
                                      isPinned={pinnedSourceId === topLevelForPin}
                                      onToggle={() => (pinnedSourceId === topLevelForPin
                                        ? unpinSource()
                                        : pinSource(topLevelForPin))}
                                      size={14}
                                    />
                                  </div>
                                )}
                                {group.type === 'hls' && (source.mediaType === 'mp4' || source.type === 'mp4' || source.type === 'm3u8') && renderCopySourceButton(source.url)}
                              </div>
                              {/* Sous-menu Darkino */}
                              {source.type === 'darkino_main' && (
                                <AnimatePresence>
                                  {showDarkinoMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {sortedDarkinoMemo.map((darkiSource, index) => {
                                        // Updated isActive for individual Darkino sources
                                        const isDarkinoSourceActive = src === darkiSource.m3u8;
                                        return (
                                          <motion.div
                                            key={`darkino_${index}`}
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
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
                                                  {pinnedHosterId === darkiSource.type && darkiSource.type !== 'unknown' && (
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
                                            {renderHosterPin(darkiSource.type)}
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
                                      transition={getTransition({ duration: 0.2, ease: "easeOut" })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {seekStreamingNexusGroupsMemo.map((group, groupIndex) => (
                                        <HLSServerSelector
                                          key={`${group[0]?.seekGroupKey ?? 'legacy'}-${groupIndex}`}
                                          sources={group}
                                          currentUrl={src}
                                          onSelect={(nexusSource) => {
                                            const sourceIndex = nexusHlsSources.findIndex(
                                              (source: { url?: string }) => source.url === nexusSource.url,
                                            );
                                            handleSourceChange(
                                              'nexus_hls',
                                              `nexus_hls_${sourceIndex}`,
                                              nexusSource.url,
                                            );
                                          }}
                                          title={seekStreamingNexusGroupsMemo.length > 1
                                            ? t('watch.seekStreamingNumber', { number: groupIndex + 1 })
                                            : t('watch.seekStreaming')}
                                          serverTitle={t('watch.server')}
                                          getServerLabel={(number) => t('watch.serverNumber', { number })}
                                          headerAction={renderHosterPin(group[0]?.type)}
                                          renderSourceMeta={(source, active) => renderSourceQualityMeta(
                                            source.url,
                                            active,
                                            undefined,
                                            source.label,
                                          )}
                                          renderCopyAction={(source) => renderCopySourceButton(source.url)}
                                        />
                                      ))}

                                      {/* Other Nexus HLS Sources */}
                                      {nexusHlsSources && nexusHlsSources.length > 0 && otherNexusHlsMemo.map((nexusSource: any, index: number) => {
                                        const isNexusHlsActive = src === nexusSource.url;
                                        const sourceIndex = nexusHlsSources.findIndex(
                                          (source: { url?: string }) => source.url === nexusSource.url,
                                        );
                                        return (
                                          <motion.div
                                            key={`nexus_hls_${sourceIndex}`}
                                            initial={{ opacity: 0, x: -20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={getTransition({ duration: 0.2, delay: index * 0.03 })}
                                            className="mb-2 flex items-stretch gap-2"
                                          >
                                            <button
                                              onClick={() => handleSourceChange('nexus_hls', `nexus_hls_${sourceIndex}`, nexusSource.url || '')}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isNexusHlsActive ? 'bg-gray-800/80 border-l-2 border-red-600 pl-3' : 'bg-gray-900/40 text-gray-300'
                                                }`}
                                            >
                                              <div className="min-w-0 flex flex-1 flex-col">
                                                <span className={isNexusHlsActive ? 'text-red-600 font-medium' : 'text-white'}>
                                              🚀 {nexusSource.label || `Nexus HLS ${index + 1}`}
                                              {pinnedHosterId === nexusSource.type && nexusSource.type !== 'unknown' && (
                                                <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                              )}
                                            </span>
                                                {renderSourceQualityMeta(nexusSource.url, isNexusHlsActive, undefined, nexusSource.label || `Nexus HLS ${index + 1}`)}
                                              </div>
                                              {isNexusHlsActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                            </button>
                                            {renderHosterPin(nexusSource.type)}
                                            {renderCopySourceButton(nexusSource.url)}
                                          </motion.div>
                                        );
                                      })}

                                      {/* Nexus File Sources */}
                                      {nexusFileSources && nexusFileSources.length > 0 && sortedNexusFileMemo.map((nexusSource: any, index: number) => {
                                        const isNexusFileActive = src === nexusSource.url;
                                        return (
                                          <motion.div
                                            key={`nexus_file_${index}`}
                                            initial={{ opacity: 0, x: -20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={getTransition({ duration: 0.2, delay: index * 0.03 })}
                                            className="mb-2 flex items-stretch gap-2"
                                          >
                                            <button
                                              onClick={() => handleSourceChange('nexus_file', `nexus_file_${index}`, nexusSource.url || '')}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center ${isNexusFileActive ? 'bg-gray-800/80 border-l-2 border-red-600 pl-3' : 'bg-gray-900/40 text-gray-300'
                                                }`}
                                            >
                                              <div className="min-w-0 flex flex-1 flex-col">
                                                <span className={isNexusFileActive ? 'text-red-600 font-medium' : 'text-white'}>
                                              📁 {nexusSource.label || `Nexus File ${index + 1}`}
                                              {pinnedHosterId === nexusSource.type && nexusSource.type !== 'unknown' && (
                                                <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                              )}
                                            </span>
                                                {renderSourceQualityMeta(nexusSource.url, isNexusFileActive, undefined, nexusSource.label || `Nexus File ${index + 1}`)}
                                              </div>
                                              {isNexusFileActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                            </button>
                                            {renderHosterPin(nexusSource.type)}
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
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
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
                                        const hosterId = detectHosterFromUrl(omegaSource.link, omegaSource.player);
                                        return (
                                          <div key={`omega_${index}`} className="mb-2 flex items-stretch gap-2">
                                            <motion.button
                                              initial={{ opacity: 0 }}
                                              animate={{ opacity: 1 }}
                                              transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                              onClick={() => handleSourceChange('omega', `omega_${index}`, omegaSource.link || '')}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isEmbedActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                            >
                                              <span>
                                                {capitalizeFirstLetter(omegaSource.player || t('watch.playerN', { n: index + 1 }))}
                                                {hosterId && pinnedHosterId === hosterId && (
                                                  <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                )}
                                              </span>
                                              {(omegaSource.player?.toLowerCase().includes('supervideo') || omegaSource.player?.toLowerCase().includes('dropload')) && (
                                                <span className="text-xs text-gray-400">{t('watch.noAds')}</span>
                                              )}
                                              {isEmbedActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                            </motion.button>
                                            {renderHosterPin(hosterId)}
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
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {coflixSources && coflixSources.length > 0 && coflixSources.map((coflixSource: any, index: number) => {
                                        const coflixUrl = getCoflixPreferredUrl(coflixSource);
                                        const isCoflixActive = embedType === 'coflix' && embedUrl === coflixUrl;
                                        const hosterId = detectHosterFromUrl(coflixUrl, coflixSource.quality);
                                        return (
                                          <div key={`coflix_${index}`} className="mb-2 flex items-stretch gap-2">
                                            <motion.button
                                              initial={{ opacity: 0 }}
                                              animate={{ opacity: 1 }}
                                              transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                              onClick={() => handleSourceChange('coflix', `coflix_${index}`, coflixUrl)}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isCoflixActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                            >
                                              <span>
                                                {(coflixSource.quality || `Source ${index + 1}`).split('/')[0].trim() || `Source ${index + 1}`}
                                                {hosterId && pinnedHosterId === hosterId && (
                                                  <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                )}
                                              </span>
                                              <span className="text-xs text-gray-400">{coflixSource.language || t('watch.french')}</span>
                                              {isCoflixActive && <span className="ml-2 text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                            </motion.button>
                                            {renderHosterPin(hosterId)}
                                          </div>
                                        );
                                      })}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              )}
                              {source.type === 'fstream_main' && (
                                <AnimatePresence>
                                  {showFstreamMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {fstreamSources && fstreamSources.length > 0 && (() => {
                                        const sourcesByCategory = fstreamSources.reduce((acc: Record<string, any[]>, s: any) => {
                                          const category = s.category || 'Default';
                                          if (!acc[category]) acc[category] = [];
                                          acc[category].push(s);
                                          return acc;
                                        }, {} as Record<string, any[]>);
                                        const categoryOrder = [
                                          { key: 'VFQ', label: t('watch.frenchQuality'), flagCode: 'FR' },
                                          { key: 'VFF', label: t('watch.frenchFilm'), flagCode: 'FR' },
                                          { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                          { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' },
                                          { key: 'Default', label: t('watch.unknownLang'), emoji: '🌍' },
                                        ];
                                        return categoryOrder.map((cat) => {
                                          const categorySources = sourcesByCategory[cat.key];
                                          if (!categorySources || categorySources.length === 0) return null;
                                          return (
                                            <div key={`fstream_category_${cat.key}`} className="mb-3">
                                              <div className="flex items-center gap-2 mb-2 px-2">
                                                <span className="text-lg">{'flagCode' in cat && cat.flagCode ? <ReactCountryFlag countryCode={cat.flagCode as string} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /> : cat.emoji}</span>
                                                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{cat.label} ({categorySources.length})</span>
                                              </div>
                                              {categorySources.map((fstreamSource: any) => {
                                                const index = fstreamSources.findIndex((s: any) => s === fstreamSource);
                                                const isFstreamActive = embedType === 'fstream' && (embedUrl || '') === fstreamSource.decoded_url;
                                                const hosterId = detectHosterFromUrl(fstreamSource.decoded_url, fstreamSource.label);
                                                return (
                                                  <div key={`fstream_${index}`} className="mb-2 ml-4 flex items-stretch gap-2">
                                                    <motion.button
                                                      initial={{ opacity: 0 }}
                                                      animate={{ opacity: 1 }}
                                                      transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                                      onClick={() => handleSourceChange('fstream', `fstream_${index}`, fstreamSource.decoded_url || '')}
                                                      className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isFstreamActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                    >
                                                      <span>
                                                        {fstreamSource.label}
                                                        {hosterId && pinnedHosterId === hosterId && (
                                                          <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                        )}
                                                      </span>
                                                      <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-500">{fstreamSource.category}</span>
                                                        {isFstreamActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                      </div>
                                                    </motion.button>
                                                    {renderHosterPin(hosterId)}
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
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {wiflixSources && wiflixSources.length > 0 && (() => {
                                        const sourcesByCategory = wiflixSources.reduce((acc: Record<string, any[]>, s: any) => {
                                          const category = s.category || 'Default';
                                          if (!acc[category]) acc[category] = [];
                                          acc[category].push(s);
                                          return acc;
                                        }, {} as Record<string, any[]>);
                                        const categoryOrder = [
                                          { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                          { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' },
                                        ];
                                        return categoryOrder.map((cat) => {
                                          const categorySources = sourcesByCategory[cat.key];
                                          if (!categorySources || categorySources.length === 0) return null;
                                          return (
                                            <div key={`wiflix_category_${cat.key}`} className="mb-3">
                                              <div className="flex items-center gap-2 mb-2 px-2">
                                                <span className="text-lg"><ReactCountryFlag countryCode={cat.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /></span>
                                                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{cat.label} ({categorySources.length})</span>
                                              </div>
                                              {categorySources.map((wiflixSource: any) => {
                                                const index = wiflixSources.findIndex((s: any) => s === wiflixSource);
                                                const isWiflixActive = embedType === 'wiflix' && embedUrl === wiflixSource.url;
                                                const hosterId = detectHosterFromUrl(wiflixSource.url, wiflixSource.label);
                                                return (
                                                  <div key={`wiflix_${index}`} className="mb-2 ml-4 flex items-stretch gap-2">
                                                    <motion.button
                                                      initial={{ opacity: 0 }}
                                                      animate={{ opacity: 1 }}
                                                      transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                                      onClick={() => handleSourceChange('wiflix', `wiflix_${index}`, wiflixSource.url || '')}
                                                      className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isWiflixActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                    >
                                                      <span>
                                                        {wiflixSource.label}
                                                        {hosterId && pinnedHosterId === hosterId && (
                                                          <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                        )}
                                                      </span>
                                                      <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-500">{wiflixSource.category}</span>
                                                        {isWiflixActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                      </div>
                                                    </motion.button>
                                                    {renderHosterPin(hosterId)}
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
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {j1fSources && j1fSources.length > 0 && (() => {
                                        const sourcesByCategory = j1fSources.reduce((acc: Record<string, any[]>, s: any) => {
                                          const category = s.category || 'Default';
                                          if (!acc[category]) acc[category] = [];
                                          acc[category].push(s);
                                          return acc;
                                        }, {} as Record<string, any[]>);
                                        const categoryOrder = [
                                          { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                          { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' },
                                        ];
                                        return categoryOrder.map((cat) => {
                                          const categorySources = sourcesByCategory[cat.key];
                                          if (!categorySources || categorySources.length === 0) return null;
                                          return (
                                            <div key={`j1f_category_${cat.key}`} className="mb-3">
                                              <div className="flex items-center gap-2 mb-2 px-2">
                                                <span className="text-lg"><ReactCountryFlag countryCode={cat.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /></span>
                                                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{cat.label} ({categorySources.length})</span>
                                              </div>
                                              {categorySources.map((j1fSource: any) => {
                                                const index = j1fSources.findIndex((s: any) => s === j1fSource);
                                                const isJ1fActive = embedType === 'j1f' && embedUrl === j1fSource.url;
                                                const hosterId = detectHosterFromUrl(j1fSource.url, j1fSource.label);
                                                return (
                                                  <div key={`j1f_${index}`} className="mb-2 ml-4 flex items-stretch gap-2">
                                                    <motion.button
                                                      initial={{ opacity: 0 }}
                                                      animate={{ opacity: 1 }}
                                                      transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                                      onClick={() => handleSourceChange('j1f', `j1f_${index}`, j1fSource.url || '')}
                                                      className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isJ1fActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                    >
                                                      <span>
                                                        {j1fSource.label}
                                                        {hosterId && pinnedHosterId === hosterId && (
                                                          <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                        )}
                                                      </span>
                                                      <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-500">{j1fSource.category}</span>
                                                        {isJ1fActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                      </div>
                                                    </motion.button>
                                                    {renderHosterPin(hosterId)}
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
                              {/* Ajout du menu déroulant SwiftFlow */}
                              {source.type === 'swiftflow_main' && (
                                <AnimatePresence>
                                  {showSwiftflowMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {swiftflowSources && swiftflowSources.length > 0 && (() => {
                                        const sourcesByCategory = swiftflowSources.reduce((acc: Record<string, any[]>, s: any) => {
                                          const category = s.category || 'Default';
                                          if (!acc[category]) acc[category] = [];
                                          acc[category].push(s);
                                          return acc;
                                        }, {} as Record<string, any[]>);
                                        const categoryOrder = [
                                          { key: 'VF', label: t('watch.french'), flagCode: 'FR' },
                                          { key: 'VOSTFR', label: t('watch.voSubtitledFr'), flagCode: 'GB' },
                                        ];
                                        return categoryOrder.map((cat) => {
                                          const categorySources = sourcesByCategory[cat.key];
                                          if (!categorySources || categorySources.length === 0) return null;
                                          return (
                                            <div key={`swiftflow_category_${cat.key}`} className="mb-3">
                                              <div className="flex items-center gap-2 mb-2 px-2">
                                                <span className="text-lg"><ReactCountryFlag countryCode={cat.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /></span>
                                                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{cat.label} ({categorySources.length})</span>
                                              </div>
                                              {categorySources.map((swiftflowSource: any) => {
                                                const index = swiftflowSources.findIndex((s: any) => s === swiftflowSource);
                                                const isSwiftflowActive = embedType === 'swiftflow' && embedUrl === swiftflowSource.url;
                                                const hosterId = detectHosterFromUrl(swiftflowSource.url, swiftflowSource.label);
                                                return (
                                                  <div key={`swiftflow_${index}`} className="mb-2 ml-4 flex items-stretch gap-2">
                                                    <motion.button
                                                      initial={{ opacity: 0 }}
                                                      animate={{ opacity: 1 }}
                                                      transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                                      onClick={() => handleSourceChange('swiftflow', `swiftflow_${index}`, swiftflowSource.url || '')}
                                                      className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isSwiftflowActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                                    >
                                                      <span>
                                                        {swiftflowSource.label}
                                                        {hosterId && pinnedHosterId === hosterId && (
                                                          <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                        )}
                                                      </span>
                                                      <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-500">{swiftflowSource.category}</span>
                                                        {isSwiftflowActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                                      </div>
                                                    </motion.button>
                                                    {renderHosterPin(hosterId)}
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
                              {/* Ajout du menu déroulant Viper */}
                              {source.type === 'viper_main' && (
                                <AnimatePresence>
                                  {showViperMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {viperSources && viperSources.length > 0 && sortedViperMemo.map((viperSource: any, index: number) => {
                                        const isViperActive = embedType === 'viper' && embedUrl === viperSource.url;
                                        return (
                                          <div key={`viper_${index}`} className="mb-2 flex items-stretch gap-2">
                                            <motion.button
                                              initial={{ opacity: 0 }}
                                              animate={{ opacity: 1 }}
                                              transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                              onClick={() => handleSourceChange('viper', `viper_${index}`, viperSource.url || '')}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isViperActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                            >
                                              <span>
                                                {viperSource.label}
                                                {pinnedHosterId === viperSource.type && viperSource.type !== 'unknown' && (
                                                  <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                )}
                                              </span>
                                              <div className="flex items-center gap-2">
                                                <span className="text-xs text-gray-400">{viperSource.quality}</span>
                                                <span className="text-xs text-gray-500">{viperSource.language}</span>
                                                {isViperActive && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.inProgress')}</span>}
                                              </div>
                                            </motion.button>
                                            {renderHosterPin(viperSource.type)}
                                          </div>
                                        );
                                      })}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              )}

                              {/* Menu déroulant Vox */}
                              {source.type === 'vox_main' && (
                                <AnimatePresence>
                                  {showVoxMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                      animate={{ opacity: 1, scale: 1 }}
                                      exit={{ opacity: 0, scale: 0.95 }}
                                      transition={getTransition({ duration: 0.2, ease: "easeOut" })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {sortedVoxMemo.map((vSource, index) => {
                                        const isVoxSourceActive = embedType === 'vox' && embedUrl === vSource.link;
                                        return (
                                          <div key={`vox_embed_${index}`} className="mb-1 flex items-stretch gap-2">
                                            <motion.button
                                              initial={{ opacity: 0, x: -20 }}
                                              animate={{ opacity: 1, x: 0 }}
                                              transition={getTransition({ duration: 0.2, delay: index * 0.03 })}
                                              onClick={() => handleSourceChange('vox', index.toString(), vSource.link)}
                                              className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isVoxSourceActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                            >
                                              <div className="flex flex-col">
                                                <span className={isVoxSourceActive ? 'text-red-600 font-medium' : 'text-white'}>
                                                  {vSource.name}
                                                  {pinnedHosterId === vSource.type && vSource.type !== 'unknown' && (
                                                    <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                  )}
                                                </span>
                                              </div>
                                              {isVoxSourceActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                            </motion.button>
                                            {renderHosterPin(vSource.type)}
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
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {[
                                        { id: '111movies', label: '111Movies' },
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
                                          vostfrSource.id === '111movies' ? `https://111movies.net/movie/${movieId}` :
                                            vostfrSource.id === 'peachify' ? `https://peachify.top/embed/movie/${movieId}?sub=French&accent=dc2626` :
                                            vostfrSource.id === 'vidlink' ? `https://vidlink.pro/movie/${movieId}` :
                                              vostfrSource.id === 'vidsrccc' ? `https://vidsrc.io/embed/movie?tmdb=${movieId}` :
                                                vostfrSource.id === 'vostfr' ? `https://player.videasy.net/movie/${movieId}` :
                                                  `https://vidsrc.wtf/api/1/movie/?id=${movieId}` :
                                          (tvShowId != null && seasonNumber != null && episodeNumber != null) ?
                                            vostfrSource.id === '111movies' ? `https://111movies.net/tv/${tvShowId}/${seasonNumber}/${episodeNumber}` :
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
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
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
                              {/* Sous-menu Bravo (PurStream) */}
                              {source.type === 'bravo_main' && (
                                <AnimatePresence>
                                  {showBravoMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, scale: 0.95, transformOrigin: "top" }}
                                      animate={{ opacity: 1, scale: 1 }}
                                      exit={{ opacity: 0, scale: 0.95 }}
                                      transition={getTransition({ duration: 0.2, ease: "easeOut" })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {purstreamSources && purstreamSources.length > 0 ? (
                                        sortedBravoMemo.map((bravoSource, index) => {
                                          const isBravoActive = src === bravoSource.url;
                                          return (
                                            <motion.div
                                              key={`bravo_${index}`}
                                              initial={{ opacity: 0, x: -20 }}
                                              animate={{ opacity: 1, x: 0 }}
                                              transition={getTransition({ duration: 0.2, delay: index * 0.03 })}
                                              className="mb-1 ml-4 flex items-stretch gap-2"
                                            >
                                              <button
                                                onClick={() => handleSourceChange('bravo', `bravo_${index}`, bravoSource.url)}
                                                className={`w-full flex-1 px-4 py-2 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center bg-gray-900/40 text-gray-300 ${isBravoActive ? 'ring-2 ring-red-500 bg-gray-800/80' : ''}`}
                                              >
                                                <div className="min-w-0 flex flex-1 flex-col">
                                                  <span className={isBravoActive ? 'text-red-600 font-medium' : 'text-white'}>
                                                    {bravoSource.label}
                                                    {pinnedHosterId === bravoSource.type && bravoSource.type !== 'unknown' && (
                                                      <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                                    )}
                                                  </span>
                                                  {renderSourceQualityMeta(bravoSource.url, isBravoActive, undefined, bravoSource.label)}
                                                </div>
                                                {isBravoActive && <span className="text-xs px-2 py-0.5 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                              </button>
                                              {renderHosterPin(bravoSource.type)}
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
                              {/* Sous-menu Viper */}
                              {source.type === 'viper_main' && (
                                <AnimatePresence>
                                  {showViperMenu && (
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={getTransition({ duration: 0.15 })}
                                      className="ml-4 pl-2 border-l-2 border-gray-700 mb-2"
                                    >
                                      {sortedViperMemo.map((vSource, index) => {
                                        const isViperSourceActive = embedType === 'viper' && embedUrl === vSource.url && onlyQualityMenu === false;

                                        return (
                                          <div key={`viper_${index}`} className="mb-1 flex items-stretch gap-2">
                                            <motion.button
                                              initial={{ opacity: 0 }}
                                              animate={{ opacity: 1 }}
                                              transition={getTransition({ duration: 0.1, delay: index * 0.02 })}
                                              onClick={() => handleSourceChange('viper', index.toString(), vSource.url)}
                                              className={`w-full flex-1 px-3 py-2 text-xs text-left hover:bg-gray-800 rounded-md flex justify-between items-center ${isViperSourceActive ? 'bg-gray-800/80' : 'text-gray-300'
                                                }`}
                                            >
                                              <div className="flex flex-col">
                                                <span className={`${isViperSourceActive ? 'text-red-500 font-medium' : 'text-gray-300'}`}>
                                                  {vSource.label}
                                                  {pinnedHosterId === vSource.type && vSource.type !== 'unknown' && (
                                                    <span className="ml-2 text-[10px] text-amber-400 font-semibold">#1</span>
                                                  )}
                                                </span>
                                                <div className="flex gap-2">
                                                  {vSource.language && <span className="text-[10px] text-gray-500 uppercase">{vSource.language}</span>}
                                                  {vSource.quality && <span className="text-[10px] text-gray-500">{vSource.quality}</span>}
                                                </div>
                                              </div>
                                              {isViperSourceActive && <div className="w-2 h-2 rounded-full bg-red-500"></div>}
                                            </motion.button>
                                            {renderHosterPin(vSource.type)}
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
                  </motion.div>
                )}

                {settingsTab === 'format' && (
                  <motion.div
                    key="format"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2"
                  >
                    <button
                      onClick={() => {
                        setVideoAspectRatio('cover');
                        // setShowSettings(false); // REMOVED
                      }}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${videoAspectRatio === 'cover' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={videoAspectRatio === 'cover' ? 'text-red-600 font-medium' : 'text-white'}>{t('watch.formatFill')}</span>
                      <span className="text-xs text-gray-400">{t('watch.formatFillDesc')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setVideoAspectRatio('contain');
                        // setShowSettings(false); // REMOVED
                      }}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${videoAspectRatio === 'contain' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={videoAspectRatio === 'contain' ? 'text-red-600 font-medium' : 'text-white'}>{t('watch.formatFit')}</span>
                      <span className="text-xs text-gray-400">{t('watch.formatFitDesc')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setVideoAspectRatio('16:9');
                        // setShowSettings(false); // REMOVED
                      }}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${videoAspectRatio === '16:9' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={videoAspectRatio === '16:9' ? 'text-red-600 font-medium' : 'text-white'}>16:9</span>
                      <span className="text-xs text-gray-400">{t('watch.formatWide')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setVideoAspectRatio('4:3');
                        // setShowSettings(false); // REMOVED
                      }}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${videoAspectRatio === '4:3' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={videoAspectRatio === '4:3' ? 'text-red-600 font-medium' : 'text-white'}>4:3</span>
                      <span className="text-xs text-gray-400">{t('watch.formatStandard')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setVideoAspectRatio('original');
                        // setShowSettings(false); // REMOVED
                      }}
                      className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-800/50 rounded flex justify-between items-center ${videoAspectRatio === 'original' ? 'text-red-600' : 'text-white'
                        }`}
                    >
                      <span>{t('watch.originalFormat')}</span>
                      <span className="text-xs text-gray-400">{t('watch.formatSource')}</span>
                    </button>

                    {/* Zoom Reset Button */}
                    <div className="mt-4 pt-4 border-t border-gray-700">
                      <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-3 px-2">{t('watch.mobileZoom')}</h4>
                      <button
                        onClick={resetZoom}
                        disabled={!zoomState.isZoomed}
                        className={`w-full px-4 py-3 text-sm text-left rounded-lg mb-2 flex justify-between items-center transition-colors ${
                          zoomState.isZoomed 
                            ? 'bg-red-600/20 hover:bg-red-600/30 border border-red-600/50' 
                            : 'bg-gray-900/40 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        <span className={zoomState.isZoomed ? 'text-red-500 font-medium' : 'text-gray-500'}>
                          🔄 {t('watch.resetZoom')}
                        </span>
                        <span className={`text-xs ${zoomState.isZoomed ? 'text-red-400' : 'text-gray-600'}`}>
                          {zoomState.isZoomed ? `${Math.round(zoomState.scale * 100)}%` : '100%'}
                        </span>
                      </button>
                    </div>

                    {/* Volume Booster Section */}
                    <div className="mt-4 pt-4 border-t border-gray-700">
                      <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-3 px-2">{t('watch.volumeBooster')}</h4>
                      <div className="px-2">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white text-sm">{t('watch.boost', { value: Math.round(volumeBoost * 100) })}</span>
                          {volumeBoost > 1 && (
                            <button
                              onClick={resetVolumeBoost}
                              className="text-xs text-red-500 hover:text-red-400 transition-colors"
                            >
                              {t('watch.resetVolumeBoost')}
                            </button>
                          )}
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="3"
                          step="0.1"
                          value={volumeBoost}
                          onChange={(e) => handleVolumeBoostChange(parseFloat(e.target.value))}
                          className="w-full accent-red-600 appearance-none h-2 rounded-full cursor-pointer"
                          style={{
                            background: `linear-gradient(to right, #dc2626 ${((volumeBoost - 1) / 2) * 100}%, rgba(255, 255, 255, 0.2) ${((volumeBoost - 1) / 2) * 100}%)`
                          }}
                        />
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>100%</span>
                          <span>200%</span>
                          <span>300%</span>
                        </div>
                        {volumeBoost > 1.5 && (
                          <p className="text-xs text-yellow-500 mt-2">
                            ⚠️ {t('watch.highVolumeWarning')}
                          </p>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}

                {settingsTab === 'audio' && (
                  <motion.div
                    key="audio"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2"
                  >
                    {audioTracks.map((track) => (
                      <button
                        key={track.id}
                        onClick={() => handleAudioTrackChange(track.id)}
                        className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-800/50 rounded ${currentAudioTrack === track.id ? 'text-red-600' : 'text-white'
                          }`}
                      >
                        <div className="flex justify-between items-center">
                          <span>{track.name}</span>
                          <span className="text-xs text-gray-400">
                            {getLanguageName(track.language)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </motion.div>
                )}

                {settingsTab === 'subtitles' && (
                  <motion.div
                    key="subtitles"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2"
                  >
                    {/* Always show disable button */}
                    <div className="mb-4">
                      <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">{t('watch.subtitleControl')}</h4>
                      <button
                        onClick={() => handleSubtitleChange('off')}
                        className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-800/50 rounded mb-2 ${currentSubtitle === 'off' ? 'bg-gray-800 border-l-4 border-red-600 pl-3 text-red-600 font-medium' : 'text-white'
                          }`}
                      >
                        <div className="flex justify-between items-center">
                          <span>{t('watch.disableAllSubtitles')}</span>
                          {currentSubtitle === 'off' && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                        </div>
                      </button>
                    </div>

                    {/* Internal subtitles section */}
                    {subtitles.length > 0 ? (
                      <div className="mb-4">
                        <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">{t('watch.builtInSubtitles')}</h4>
                        {subtitles.map((track, idx) => {
                          // Key on idx, not language: two tracks can share a language
                          // (e.g. "Français (forced)" + "Français"), and a language-based
                          // id collides so both rows would show "Actif" and only the first
                          // would ever be selectable.
                          const id = `internal:${idx}`;
                          return (
                            <button
                              key={id}
                              onClick={() => handleSubtitleChange(id)}
                              className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-800/50 rounded mb-2 ${currentSubtitle === id ? 'bg-gray-800 border-l-4 border-red-600 pl-3 text-red-600 font-medium' : 'text-white'
                                }`}
                            >
                              <div className="flex justify-between items-center">
                                <span>{track.label}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-gray-400">{getLanguageName(track.language || 'unknown')}</span>
                                  {currentSubtitle === id && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mb-4 p-3 bg-gray-800/40 rounded-lg border border-gray-700/50">
                        <div className="flex items-start space-x-3">
                          <div className="text-blue-400 text-lg">ℹ️</div>
                          <div className="flex-1">
                            <h4 className="text-sm text-white font-medium mb-1">{t('watch.noBuiltInSubtitles')}</h4>
                            <p className="text-xs text-gray-300 mb-2">
                              {t('watch.noBuiltInSubtitlesDesc')}
                            </p>
                            <p className="text-xs text-gray-400">
                              {t('watch.useExternalSubtitlesSection')}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* External subtitles section */}
                    <div className="mt-4 border-t border-gray-800 pt-3">
                      <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">{t('watch.externalSubtitles')}</h4>
                      <div className="px-2">
                        {/* Show info about what type of content is supported */}
                        {tvShowId && seasonNumber && episodeNumber ? (
                          <div className="text-xs text-blue-400 mb-2 px-2 py-1 bg-blue-900/20 rounded">
                            {t('watch.tvShowSeasonEp', { season: seasonNumber, episode: episodeNumber })}
                          </div>
                        ) : movieId ? (
                          <div className="text-xs text-green-400 mb-2 px-2 py-1 bg-green-900/20 rounded">
                            {t('watch.filmLabel')}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 mb-2 px-2 py-1 bg-gray-800/40 rounded">
                            {t('watch.selectContentForSubs')}
                          </div>
                        )}

                        {externalProviderErrors.map((error: { provider: string; message: string }) => (
                          <div key={error.provider} className="text-xs text-amber-400 mb-2 px-2 py-1 bg-amber-900/20 rounded">
                            {t('watch.sourceUnavailable', { provider: error.provider })}
                          </div>
                        ))}

                        {externalLoading ? (
                          <div className="text-xs text-gray-400 px-2 py-2">{t('watch.searchingSubtitles')}</div>
                        ) : externalTracks.length === 0 ? (
                          // Contenu non selectionne : le message ci-dessus (watch.selectContentForSubs)
                          // couvre deja ce cas, pas besoin d'enchainer avec "aucun sous-titre disponible".
                          // seasonNumber/episodeNumber peuvent valoir 0 (episodes speciaux) -> `!= null`.
                          ((tvShowId != null && seasonNumber != null && episodeNumber != null) || movieId != null) && (
                            <div className="text-xs text-gray-400 px-2 py-2">{t('watch.noExternalSubtitlesAvailable')}</div>
                          )
                        ) : (
                          <>
                            {/* Filtre langue */}
                            <div className="mb-2">
                              <label className="text-xs text-gray-300 block mb-1">{t('watch.chooseLanguage')}</label>
                              <Select
                                value={subtitleFilters.lang}
                                onValueChange={(val) => {
                                  setSubtitleFilters(prev => ({ ...prev, lang: val }));
                                  setVisibleResultCount(60);
                                }}
                              >
                                <SelectTrigger>
                                  <span className="flex items-center gap-2 truncate">
                                    {subtitleFilters.lang === 'all'
                                      ? t('watch.filterAllLanguages')
                                      : getLanguageName?.(subtitleFilters.lang)}
                                  </span>
                                </SelectTrigger>
                                <SelectContent>
                                  {subtitleFacets.languages.map(option => (
                                    <SelectItem key={option.value} value={option.value}>
                                      <span className="flex items-center gap-2">
                                        {option.value === 'all'
                                          ? t('watch.filterAllLanguages')
                                          : getLanguageName?.(option.value)}
                                        <span className="text-gray-500 text-xs">({option.count})</span>
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* Filtre source */}
                            <div className="mb-2">
                              <label className="text-xs text-gray-300 block mb-1">{t('watch.filterBySource')}</label>
                              <div className="flex flex-wrap gap-1.5">
                                {subtitleFacets.sources.map(option => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                      setSubtitleFilters(prev => ({ ...prev, source: option.value }));
                                      setVisibleResultCount(60);
                                    }}
                                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                                      subtitleFilters.source === option.value
                                        ? 'bg-red-800/60 border-red-600 text-white'
                                        : 'bg-gray-900/40 border-gray-700/60 text-gray-300 hover:bg-gray-800/60'
                                    }`}
                                  >
                                    {option.value === 'all' ? t('watch.filterAllSources') : option.value}
                                    <span className="ml-1 text-gray-400">{option.count}</span>
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Recherche libre */}
                            <div className="mb-2">
                              <input
                                type="text"
                                value={subtitleFilters.query}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setSubtitleFilters(prev => ({ ...prev, query: next }));
                                  setVisibleResultCount(60);
                                }}
                                placeholder={t('watch.searchByRelease')}
                                className="w-full px-3 py-2 text-sm bg-gray-900/60 border border-gray-700/60 rounded text-white placeholder:text-white/30 focus:outline-none focus:border-red-600"
                              />
                            </div>

                            {/* Resultats */}
                            <div className="flex items-center justify-between mb-2">
                              <h5 className="text-sm text-white">{t('watch.subtitleResults')}</h5>
                              <span className="text-xs text-gray-400">
                                {t('watch.resultsCount', { count: filteredTracks.length })}
                              </span>
                            </div>

                            {filteredTracks.length === 0 ? (
                              <div className="text-xs text-gray-400 px-2 py-1">{t('watch.noResultsForFilters')}</div>
                            ) : (
                              <div className="space-y-2 pr-2">
                                {filteredTracks.slice(0, visibleResultCount).map(track => (
                                  <button
                                    key={track.id}
                                    onClick={() => loadExternalSubtitle(track)}
                                    className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-800/50 rounded flex justify-between items-center ${
                                      selectedExternalSub?.id === track.id
                                        ? 'bg-red-800/60 ring-1 ring-red-600'
                                        : 'bg-gray-900/40 text-white'
                                    }`}
                                  >
                                    <div className="min-w-0 flex-1 pr-3">
                                      <div className="font-medium text-white whitespace-normal break-words [overflow-wrap:anywhere]">
                                        {track.label}
                                      </div>
                                      <div className="text-xs text-gray-400 flex items-center gap-2 mt-0.5">
                                        <span>{getLanguageName?.(track.lang) || track.lang}</span>
                                        <span>•</span>
                                        <span>{track.format}</span>
                                        <span className="px-1.5 py-0.5 rounded bg-gray-800/80 text-gray-300">
                                          {track.source}
                                        </span>
                                      </div>
                                    </div>
                                    {track.downloads != null && (
                                      <div className="text-xs text-gray-300 shrink-0">{track.downloads} DL</div>
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}

                            {filteredTracks.length > visibleResultCount && (
                              <button
                                type="button"
                                onClick={() => setVisibleResultCount(count => count + 60)}
                                className="mt-2 w-full px-3 py-2 text-sm text-white bg-gray-900/60 hover:bg-gray-800 rounded-lg border border-gray-700/60 transition-colors"
                              >
                                {t('watch.showMoreResults')}
                              </button>
                            )}
                          </>
                        )}

                        {loadingSubtitle && (
                          <div className="text-xs text-gray-400 px-2 py-1">{t('watch.loadingSubtitle')}</div>
                        )}
                      </div>
                    </div>

                    {/* Subtitle translation */}
                    <div className="mb-4">
                      <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">{t('watch.translateSubtitles')}</h4>
                      <div className="mb-2">
                        <label className="text-xs text-gray-300 block mb-1">{t('watch.translateTo')}</label>
                        <Select
                          value={translateSubsTo || ''}
                          onValueChange={(val) => setTranslateSubsTo(val || null)}
                        >
                          <SelectTrigger>
                            {translateSubsTo && TRANSLATION_LANGS.find(l => l.code === translateSubsTo) ? (
                              <span className="flex items-center gap-2 truncate">
                                <ReactCountryFlag
                                  countryCode={TRANSLATION_LANGS.find(l => l.code === translateSubsTo)!.country}
                                  svg
                                  style={{ width: 18, height: 18, borderRadius: '3px' }}
                                />
                                {t(`watch.translationLanguages.${translateSubsTo}`)}
                              </span>
                            ) : (
                              <span className="truncate">{t('watch.noTranslation')}</span>
                            )}
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">
                              {t('watch.noTranslation')}
                            </SelectItem>
                            {TRANSLATION_LANGS.map((lang) => (
                              <SelectItem key={lang.code} value={lang.code}>
                                <span className="flex items-center gap-2">
                                  <ReactCountryFlag
                                    countryCode={lang.country}
                                    svg
                                    style={{ width: 18, height: 18, borderRadius: '3px' }}
                                  />
                                  {t(`watch.translationLanguages.${lang.code}`)}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Translate / Cancel button */}
                      {translateSubsTo && !translationProgress && (
                        <button
                          onClick={startSubtitleTranslation}
                          className="w-full mt-2 px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded transition-colors"
                        >
                          {t('watch.translateButton')}
                        </button>
                      )}

                      {/* Progress bar */}
                      {translationProgress && (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-center justify-between text-xs text-gray-300">
                            <span>{t('watch.translating')}</span>
                            <span>{translationProgress.done}/{translationProgress.total}</span>
                          </div>
                          <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-red-600 rounded-full transition-all duration-300"
                              style={{ width: `${(translationProgress.done / translationProgress.total) * 100}%` }}
                            />
                          </div>
                          <button
                            onClick={cancelSubtitleTranslation}
                            className="w-full px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors"
                          >
                            {t('watch.cancelTranslation')}
                          </button>
                        </div>
                      )}

                      {/* Active translation indicator */}
                      {translationLang && !translationProgress && (
                        <div className="mt-2 flex items-center justify-between text-xs text-green-400 px-2 py-1.5 bg-green-900/20 rounded">
                          <span>{t('watch.translationActive')}</span>
                          <button
                            onClick={cancelSubtitleTranslation}
                            className="text-gray-400 hover:text-white ml-2"
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>

                    {translatedSubtitleHistory.length > 0 && (
                      <div className="mb-4 border-t border-gray-800 pt-3">
                        <h4 className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-2">
                          {t('watch.translatedSubtitles')}
                        </h4>
                        <div className="space-y-2">
                          {translatedSubtitleHistory.map((entry: any) => {
                            const isActive = activeTranslatedSubtitleId === entry.id;
                            return (
                              <button
                                type="button"
                                key={entry.id}
                                onClick={() => activateTranslatedSubtitle(entry.id)}
                                className={`w-full px-3 py-2.5 text-left rounded-lg transition-colors ${isActive
                                  ? 'bg-red-950/50 ring-1 ring-red-600/80'
                                  : 'bg-gray-900/40 hover:bg-gray-800/70'}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2 text-sm text-white">
                                      <span>{getLanguageName(entry.sourceLanguage)}</span>
                                      <span className="text-gray-500" aria-hidden="true">→</span>
                                      <span>{getLanguageName(entry.targetLanguage)}</span>
                                    </div>
                                    <div className="mt-1 text-xs text-gray-400 whitespace-normal break-words [overflow-wrap:anywhere]">
                                      {entry.sourceLabel}
                                    </div>
                                  </div>
                                  {isActive && (
                                    <span className="shrink-0 text-xs px-2 py-1 bg-red-600 text-white rounded-full">
                                      {t('watch.active')}
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
                {settingsTab === 'style' && (
                  <motion.div
                    key="style"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="w-full pr-2 space-y-4"
                  >
                    <a
                      href="/settings#subtitles"
                      onClick={() => setShowSettings(false)}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-400/15"
                    >
                      <span>{t('watch.moreSubtitleSettings')}</span>
                      <ExternalLink className="h-4 w-4 shrink-0" />
                    </a>
                    <SubtitleStyleControls
                      preferences={subtitlePreferences}
                      onChange={patchSubtitlePreferences}
                      onPreviewChange={previewSubtitlePreferences}
                      onCommitPreview={commitSubtitlePreferences}
                      onReset={resetSubtitleAppearance}
                      density="compact"
                    />
                  </motion.div>
                )}

                {settingsTab === 'speed' && (
                  <motion.div
                    key="speed"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2"
                  >
                    <button
                      onClick={() => handlePlaybackSpeedChange(0.25)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 0.25 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 0.25 ? 'text-red-600 font-medium' : 'text-white'}>0.25×</span>
                      {playbackSpeed === 0.25 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(0.5)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 0.5 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 0.5 ? 'text-red-600 font-medium' : 'text-white'}>0.5×</span>
                      {playbackSpeed === 0.5 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(0.75)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 0.75 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 0.75 ? 'text-red-600 font-medium' : 'text-white'}>0.75×</span>
                      {playbackSpeed === 0.75 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(1)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 1 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 1 ? 'text-red-600 font-medium' : 'text-white'}>{t('watch.normalSpeedLabel')}</span>
                      {playbackSpeed === 1 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(1.25)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 1.25 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 1.25 ? 'text-red-600 font-medium' : 'text-white'}>1.25×</span>
                      {playbackSpeed === 1.25 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(1.5)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 1.5 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 1.5 ? 'text-red-600 font-medium' : 'text-white'}>1.5×</span>
                      {playbackSpeed === 1.5 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(1.75)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 1.75 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 1.75 ? 'text-red-600 font-medium' : 'text-white'}>1.75×</span>
                      {playbackSpeed === 1.75 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                    <button
                      onClick={() => handlePlaybackSpeedChange(2)}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${playbackSpeed === 2 ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'
                        }`}
                    >
                      <span className={playbackSpeed === 2 ? 'text-red-600 font-medium' : 'text-white'}>2×</span>
                      {playbackSpeed === 2 && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>
                  </motion.div>
                )}

                {/* Progression Tab Content */}
                {settingsTab === 'progression' && (
                  <motion.div
                    key="progression"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="w-full pr-2 space-y-4"
                  >
                    {/* Toggle Save Progress */}
                    <div className="mb-3">
                      <h3 className="text-base font-semibold text-white mb-2">{t('watch.autoSave')}</h3>
                      <button
                        onClick={() => setSaveProgressEnabled(!saveProgressEnabled)}
                        className={`w-full px-4 py-3 text-sm text-left rounded-lg flex justify-between items-center transition-colors ${saveProgressEnabled ? 'bg-green-600/30 hover:bg-green-600/40 text-green-300' : 'bg-red-600/30 hover:bg-red-600/40 text-red-300'
                          }`}
                      >
                        <span>{saveProgressEnabled ? t('watch.enabled') : t('watch.disabled')}</span>
                        <div className={`w-10 h-5 flex items-center rounded-full p-1 transition-colors ${saveProgressEnabled ? 'bg-green-500' : 'bg-gray-600'}`}>
                          <motion.div
                            className="w-3.5 h-3.5 bg-white rounded-full shadow-md"
                            layout
                            transition={getTransition({ type: "spring", stiffness: 700, damping: 30 })}
                            style={{ marginLeft: saveProgressEnabled ? 'auto' : '0px' }}
                          />
                        </div>
                      </button>
                      <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.saveProgressDesc')}</p>
                    </div>

                    {/* Toggle Auto Next Episode */}
                    <div className="mb-3 pt-4 border-t border-gray-700/60">
                      <h3 className="text-base font-semibold text-white mb-2">{t('watch.autoNextEpisode')}</h3>
                      <button
                        onClick={() => setAutoNextEpisodeEnabled(!autoNextEpisodeEnabled)}
                        className={`w-full px-4 py-3 text-sm text-left rounded-lg flex justify-between items-center transition-colors ${autoNextEpisodeEnabled ? 'bg-green-600/30 hover:bg-green-600/40 text-green-300' : 'bg-red-600/30 hover:bg-red-600/40 text-red-300'
                          }`}
                      >
                        <span>{autoNextEpisodeEnabled ? t('watch.enabled') : t('watch.disabled')}</span>
                        <div className={`w-10 h-5 flex items-center rounded-full p-1 transition-colors ${autoNextEpisodeEnabled ? 'bg-green-500' : 'bg-gray-600'}`}>
                          <motion.div
                            className="w-3.5 h-3.5 bg-white rounded-full shadow-md"
                            layout
                            transition={getTransition({ type: "spring", stiffness: 700, damping: 30 })}
                            style={{ marginLeft: autoNextEpisodeEnabled ? 'auto' : '0px' }}
                          />
                        </div>
                      </button>
                      <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.autoNextEpisodeDesc')}</p>
                    </div>

                    {/* Toggle Keep Fullscreen On Episode Change (séries / animes uniquement) */}
                    {(tvShowId || isAnime) && (
                      <div className="mb-3 pt-4 border-t border-gray-700/60">
                        <h3 className="text-base font-semibold text-white mb-2">{t('watch.keepFullscreen')}</h3>
                        <button
                          onClick={() => setKeepFullscreenOnEpisodeChange(!keepFullscreenOnEpisodeChange)}
                          className={`w-full px-4 py-3 text-sm text-left rounded-lg flex justify-between items-center transition-colors ${keepFullscreenOnEpisodeChange ? 'bg-green-600/30 hover:bg-green-600/40 text-green-300' : 'bg-red-600/30 hover:bg-red-600/40 text-red-300'
                            }`}
                        >
                          <span>{keepFullscreenOnEpisodeChange ? t('watch.enabled') : t('watch.disabled')}</span>
                          <div className={`w-10 h-5 flex items-center rounded-full p-1 transition-colors ${keepFullscreenOnEpisodeChange ? 'bg-green-500' : 'bg-gray-600'}`}>
                            <motion.div
                              className="w-3.5 h-3.5 bg-white rounded-full shadow-md"
                              layout
                              transition={getTransition({ type: "spring", stiffness: 700, damping: 30 })}
                              style={{ marginLeft: keepFullscreenOnEpisodeChange ? 'auto' : '0px' }}
                            />
                          </div>
                        </button>
                        <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.keepFullscreenDesc')}</p>
                      </div>
                    )}

                    {/* Toggle Resume Playback On Episode Change (séries / animes uniquement) */}
                    {(tvShowId || isAnime) && (
                      <div className="mb-3 pt-4 border-t border-gray-700/60">
                        <h3 className="text-base font-semibold text-white mb-2">{t('watch.resumePlayback')}</h3>
                        <button
                          onClick={() => setResumePlaybackOnEpisodeChange(!resumePlaybackOnEpisodeChange)}
                          className={`w-full px-4 py-3 text-sm text-left rounded-lg flex justify-between items-center transition-colors ${resumePlaybackOnEpisodeChange ? 'bg-green-600/30 hover:bg-green-600/40 text-green-300' : 'bg-red-600/30 hover:bg-red-600/40 text-red-300'
                            }`}
                        >
                          <span>{resumePlaybackOnEpisodeChange ? t('watch.enabled') : t('watch.disabled')}</span>
                          <div className={`w-10 h-5 flex items-center rounded-full p-1 transition-colors ${resumePlaybackOnEpisodeChange ? 'bg-green-500' : 'bg-gray-600'}`}>
                            <motion.div
                              className="w-3.5 h-3.5 bg-white rounded-full shadow-md"
                              layout
                              transition={getTransition({ type: "spring", stiffness: 700, damping: 30 })}
                              style={{ marginLeft: resumePlaybackOnEpisodeChange ? 'auto' : '0px' }}
                            />
                          </div>
                        </button>
                        <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.resumePlaybackDesc')}</p>
                      </div>
                    )}

                    {/* Proposition « À suivre » : forme, déclenchement, décompte */}
                    <div className="mb-3 pt-4 border-t border-gray-700/60">
                      <h3 className="text-base font-semibold text-white mb-2">{t('watch.nextContentPopup')}</h3>

                      {/* Forme */}
                      <div className="mb-3">
                        <p className="text-xs text-gray-400 mb-2">{t('watch.nextContentDisplay')}</p>
                        <div className="flex gap-2">
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ display: 'panel' })}
                            className={choiceClass(nextContent.display === 'panel')}
                          >
                            {t('watch.displayPanel')}
                          </motion.button>
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ display: 'card' })}
                            className={choiceClass(nextContent.display === 'card')}
                          >
                            {t('watch.displayCard')}
                          </motion.button>
                        </div>
                        <p className="text-xs text-gray-400 mt-1 px-1">
                          {nextContent.display === 'panel' ? t('watch.displayPanelDesc') : t('watch.displayCardDesc')}
                        </p>
                      </div>

                      {/* Déclenchement */}
                      <div className="mb-3">
                        <p className="text-xs text-gray-400 mb-2">{t('watch.nextContentTrigger')}</p>
                        <div className="flex gap-2">
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ trigger: 'segment' })}
                            className={choiceClass(nextContent.trigger === 'segment')}
                          >
                            {t('watch.triggerSegment')}
                          </motion.button>
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ trigger: 'threshold' })}
                            className={choiceClass(nextContent.trigger === 'threshold')}
                          >
                            {t('watch.triggerThreshold')}
                          </motion.button>
                        </div>
                        <p className="text-xs text-gray-400 mt-1 px-1">
                          {nextContent.trigger === 'segment'
                            ? t('watch.triggerSegmentDesc')
                            : t('watch.triggerThresholdDesc')}
                        </p>
                        {nextContent.trigger === 'segment' && !creditsSegmentsAvailable && (
                          <p className="text-xs text-amber-300 mt-1 px-1">
                            {t('watch.triggerSegmentUnavailable')}
                          </p>
                        )}
                      </div>

                      {/* Seuil : réglage principal, ou repli du déclenchement au générique */}
                      <div className="mb-3">
                        <p className="text-xs text-gray-400 mb-2">
                          {nextContent.trigger === 'segment' ? t('watch.thresholdFallback') : t('watch.showPopup')}
                        </p>
                        <div className="flex gap-2">
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ thresholdMode: 'percentage' })}
                            className={choiceClass(nextContent.thresholdMode === 'percentage')}
                          >
                            {t('watch.percentage')}
                          </motion.button>
                          <motion.button
                            whileTap={tapProp({ scale: 0.98 })}
                            onClick={() => setNextContent({ thresholdMode: 'timeBeforeEnd' })}
                            className={choiceClass(nextContent.thresholdMode === 'timeBeforeEnd')}
                          >
                            {t('watch.timeBeforeEnd')}
                          </motion.button>
                        </div>
                      </div>

                      {/* Les deux valeurs sont mémorisées séparément : passer d'un
                          mode à l'autre ne transforme plus « 5 min » en « 300 % ». */}
                      {nextContent.thresholdMode === 'percentage' ? (
                        <div className="mb-3">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-sm text-gray-300">
                              {t('watch.atPercentOfVideo', { value: nextContent.percentage.toFixed(0) })}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={PERCENTAGE_MIN}
                            max={PERCENTAGE_MAX}
                            step="1"
                            value={nextContent.percentage}
                            onChange={(e) => setNextContent({ percentage: parseFloat(e.target.value) })}
                            className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-600"
                            style={{ background: sliderFill(nextContent.percentage, PERCENTAGE_MIN, PERCENTAGE_MAX) }}
                          />
                          <div className="flex justify-between text-xs text-gray-400 mt-1">
                            <span>{PERCENTAGE_MIN}%</span>
                            <span>75%</span>
                            <span>{PERCENTAGE_MAX}%</span>
                          </div>
                        </div>
                      ) : (
                        <div className="mb-3">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-sm text-gray-300">
                              {nextContent.timeBeforeEnd >= 60
                                ? t('watch.minutesBeforeEnd', {
                                  min: Math.floor(nextContent.timeBeforeEnd / 60),
                                  sec: nextContent.timeBeforeEnd % 60 > 0 ? `${nextContent.timeBeforeEnd % 60}s` : '',
                                })
                                : t('watch.secondsBeforeEnd', { sec: nextContent.timeBeforeEnd })}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={TIME_BEFORE_END_MIN}
                            max={TIME_BEFORE_END_MAX}
                            step="10"
                            value={nextContent.timeBeforeEnd}
                            onChange={(e) => setNextContent({ timeBeforeEnd: parseFloat(e.target.value) })}
                            className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-600"
                            style={{ background: sliderFill(nextContent.timeBeforeEnd, TIME_BEFORE_END_MIN, TIME_BEFORE_END_MAX) }}
                          />
                          <div className="flex justify-between text-xs text-gray-400 mt-1">
                            <span>{t('watch.subtitleDelayPreset30Seconds')}</span>
                            <span>{t('watch.subtitleDelayPreset2Minutes30')}</span>
                            <span>{t('watch.subtitleDelayPreset5Minutes')}</span>
                          </div>
                        </div>
                      )}

                      {/* Enchaînement automatique */}
                      <div className="mb-3">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs text-gray-400">{t('watch.autoplayCountdown')}</span>
                          <span className="text-sm text-gray-300">
                            {nextContent.autoplaySeconds === 0
                              ? t('watch.autoplayOff')
                              : t('watch.autoplayAfter', { sec: nextContent.autoplaySeconds })}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={AUTOPLAY_SECONDS_MAX}
                          step="1"
                          value={nextContent.autoplaySeconds}
                          onChange={(e) => setNextContent({ autoplaySeconds: parseFloat(e.target.value) })}
                          className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-600"
                          style={{ background: sliderFill(nextContent.autoplaySeconds, 0, AUTOPLAY_SECONDS_MAX) }}
                        />
                        <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.autoplayCountdownDesc')}</p>
                      </div>

                      <p className="text-xs text-gray-400 px-1">
                        {t('watch.configureNextContent')}
                      </p>
                    </div>

                    {skipSettings && (
                      <div className="pt-4 border-t border-gray-700/60">
                        <SkipSegmentsPanel
                          settings={skipSettings}
                          providerStatus={segmentProviderStatus}
                          providerDetail={segmentProviderDetail}
                          onSettingsChange={onSkipSettingsChange}
                          onSegmentTypeChange={onSegmentTypeChange}
                          onSegmentColorChange={onSegmentColorChange}
                          onProviderToggle={onProviderToggle}
                          onProviderReorder={onProviderReorder}
                          onReset={onSkipSettingsReset}
                          onOpenStudio={onOpenSegmentStudio}
                          communityCount={communitySubmissionCount ?? 0}
                        />
                      </div>
                    )}

                    {/* Reset Current Progress */}
                    <div className="mb-3 pt-4 border-t border-gray-700/60">
                      <h3 className="text-base font-semibold text-white mb-2">{t('watch.reset')}</h3>
                      <button
                        onClick={resetCurrentProgress}
                        className="w-full px-4 py-3 text-sm text-center rounded-lg bg-red-800/80 hover:bg-red-700/90 text-red-100 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-black/50"
                      >
                        {t('watch.resetProgress')}
                      </button>
                      <p className="text-xs text-gray-400 mt-1 px-1">{t('watch.resetProgressDesc')}</p>
                    </div>

                  </motion.div>
                )}

                {/* Audio Enhancer Tab Content */}
                {settingsTab === 'enhancer' && (
                  <motion.div
                    key="enhancer"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2 space-y-3"
                  >
                    <div className="mb-2">
                      <h3 className="text-base font-semibold text-white mb-1">{t('watch.audioEnhancerTitle')}</h3>
                      <p className="text-xs text-gray-400 mb-3">{t('watch.audioEnhancerDesc')}</p>
                    </div>

                    {/* Off */}
                    <button
                      onClick={() => handleAudioEnhancerChange('off')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${audioEnhancerMode === 'off' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={audioEnhancerMode === 'off' ? 'text-red-500 font-medium' : 'text-white'}>{t('watch.audioOff')}</span>
                        <span className="text-xs text-gray-500">{t('watch.audioOffDesc')}</span>
                      </div>
                      {audioEnhancerMode === 'off' && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Cinema */}
                    <button
                      onClick={() => handleAudioEnhancerChange('cinema')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${audioEnhancerMode === 'cinema' ? 'bg-gray-800 border-l-4 border-purple-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={audioEnhancerMode === 'cinema' ? 'text-purple-400 font-medium' : 'text-white'}>{t('watch.audioCinema')}</span>
                        <span className="text-xs text-gray-500">{t('watch.audioCinemaDesc')}</span>
                      </div>
                      {audioEnhancerMode === 'cinema' && <span className="text-xs px-2 py-1 bg-purple-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Music */}
                    <button
                      onClick={() => handleAudioEnhancerChange('music')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${audioEnhancerMode === 'music' ? 'bg-gray-800 border-l-4 border-blue-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={audioEnhancerMode === 'music' ? 'text-blue-400 font-medium' : 'text-white'}>{t('watch.audioMusic')}</span>
                        <span className="text-xs text-gray-500">{t('watch.audioMusicDesc')}</span>
                      </div>
                      {audioEnhancerMode === 'music' && <span className="text-xs px-2 py-1 bg-blue-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Dialogue */}
                    <button
                      onClick={() => handleAudioEnhancerChange('dialogue')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${audioEnhancerMode === 'dialogue' ? 'bg-gray-800 border-l-4 border-green-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={audioEnhancerMode === 'dialogue' ? 'text-green-400 font-medium' : 'text-white'}>{t('watch.audioDialogue')}</span>
                        <span className="text-xs text-gray-500">{t('watch.audioDialogueDesc')}</span>
                      </div>
                      {audioEnhancerMode === 'dialogue' && <span className="text-xs px-2 py-1 bg-green-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Custom */}
                    <button
                      onClick={() => handleAudioEnhancerChange('custom')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${audioEnhancerMode === 'custom' ? 'bg-gray-800 border-l-4 border-orange-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={audioEnhancerMode === 'custom' ? 'text-orange-400 font-medium' : 'text-white'}>{t('watch.audioCustom')}</span>
                        <span className="text-xs text-gray-500">{t('watch.audioCustomDesc')}</span>
                      </div>
                      {audioEnhancerMode === 'custom' && <span className="text-xs px-2 py-1 bg-orange-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Custom Audio Sliders */}
                    {audioEnhancerMode === 'custom' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-3 p-4 bg-gray-900/80 rounded-xl border border-orange-600/30 space-y-4"
                      >
                        <h4 className="text-sm font-semibold text-orange-400 mb-2">{t('watch.equalizer')}</h4>

                        {/* Bass Gain */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.bassGain')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.bassGain > 0 ? '+' : ''}{customAudio.bassGain} dB</span>
                          </div>
                          <input type="range" min="-10" max="15" step="0.5" value={customAudio.bassGain}
                            onChange={(e) => handleCustomAudioChange('bassGain', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.bassGain + 10) / 25) * 100}%, #374151 ${((customAudio.bassGain + 10) / 25) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Bass Frequency */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.bassFreq')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.bassFreq} Hz</span>
                          </div>
                          <input type="range" min="60" max="400" step="10" value={customAudio.bassFreq}
                            onChange={(e) => handleCustomAudioChange('bassFreq', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.bassFreq - 60) / 340) * 100}%, #374151 ${((customAudio.bassFreq - 60) / 340) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Mid Gain */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.midGain')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.midGain > 0 ? '+' : ''}{customAudio.midGain} dB</span>
                          </div>
                          <input type="range" min="-10" max="15" step="0.5" value={customAudio.midGain}
                            onChange={(e) => handleCustomAudioChange('midGain', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.midGain + 10) / 25) * 100}%, #374151 ${((customAudio.midGain + 10) / 25) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Mid Frequency */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.midFreq')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.midFreq} Hz</span>
                          </div>
                          <input type="range" min="500" max="5000" step="100" value={customAudio.midFreq}
                            onChange={(e) => handleCustomAudioChange('midFreq', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.midFreq - 500) / 4500) * 100}%, #374151 ${((customAudio.midFreq - 500) / 4500) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Mid Q */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.midQ')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.midQ.toFixed(1)}</span>
                          </div>
                          <input type="range" min="0.1" max="5" step="0.1" value={customAudio.midQ}
                            onChange={(e) => handleCustomAudioChange('midQ', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.midQ - 0.1) / 4.9) * 100}%, #374151 ${((customAudio.midQ - 0.1) / 4.9) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Treble Gain */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.trebleGain')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.trebleGain > 0 ? '+' : ''}{customAudio.trebleGain} dB</span>
                          </div>
                          <input type="range" min="-10" max="15" step="0.5" value={customAudio.trebleGain}
                            onChange={(e) => handleCustomAudioChange('trebleGain', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.trebleGain + 10) / 25) * 100}%, #374151 ${((customAudio.trebleGain + 10) / 25) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Treble Frequency */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.trebleFreq')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.trebleFreq} Hz</span>
                          </div>
                          <input type="range" min="3000" max="16000" step="500" value={customAudio.trebleFreq}
                            onChange={(e) => handleCustomAudioChange('trebleFreq', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.trebleFreq - 3000) / 13000) * 100}%, #374151 ${((customAudio.trebleFreq - 3000) / 13000) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        <h4 className="text-sm font-semibold text-orange-400 mt-4 mb-2 pt-3 border-t border-gray-700/50">{t('watch.compressorTitle')}</h4>

                        {/* Compressor Threshold */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.thresholdLabel')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.compThreshold} dB</span>
                          </div>
                          <input type="range" min="-50" max="0" step="1" value={customAudio.compThreshold}
                            onChange={(e) => handleCustomAudioChange('compThreshold', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.compThreshold + 50) / 50) * 100}%, #374151 ${((customAudio.compThreshold + 50) / 50) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Compressor Ratio */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.ratioLabel')}</span>
                            <span className="text-xs text-orange-400 font-mono">{customAudio.compRatio}:1</span>
                          </div>
                          <input type="range" min="1" max="20" step="0.5" value={customAudio.compRatio}
                            onChange={(e) => handleCustomAudioChange('compRatio', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.compRatio - 1) / 19) * 100}%, #374151 ${((customAudio.compRatio - 1) / 19) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Compressor Attack */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.attackLabel')}</span>
                            <span className="text-xs text-orange-400 font-mono">{(customAudio.compAttack * 1000).toFixed(0)} ms</span>
                          </div>
                          <input type="range" min="0" max="0.1" step="0.001" value={customAudio.compAttack}
                            onChange={(e) => handleCustomAudioChange('compAttack', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${(customAudio.compAttack / 0.1) * 100}%, #374151 ${(customAudio.compAttack / 0.1) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Compressor Release */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.releaseLabel')}</span>
                            <span className="text-xs text-orange-400 font-mono">{(customAudio.compRelease * 1000).toFixed(0)} ms</span>
                          </div>
                          <input type="range" min="0.01" max="1" step="0.01" value={customAudio.compRelease}
                            onChange={(e) => handleCustomAudioChange('compRelease', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            style={{ background: `linear-gradient(to right, #ea580c 0%, #ea580c ${((customAudio.compRelease - 0.01) / 0.99) * 100}%, #374151 ${((customAudio.compRelease - 0.01) / 0.99) * 100}%, #374151 100%)` }}
                          />
                        </div>

                        {/* Reset custom audio */}
                        <button
                          onClick={() => {
                            const defaults = { bassGain: 0, bassFreq: 200, midGain: 0, midFreq: 2000, midQ: 1, trebleGain: 0, trebleFreq: 6000, compThreshold: 0, compRatio: 1, compKnee: 40, compAttack: 0, compRelease: 0.25 };
                            setCustomAudio(defaults);
                            localStorage.setItem('playerCustomAudio', JSON.stringify(defaults));
                            applyAudioEnhancerPreset('custom', defaults);
                          }}
                          className="w-full mt-2 px-3 py-2 text-xs text-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors border border-gray-700/50"
                        >
                          {t('watch.resetValues')}
                        </button>
                      </motion.div>
                    )}

                    {/* Info */}
                    <div className="mt-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
                      <p className="text-xs text-gray-400">
                        {t('watch.audioEnhancerInfo')}
                      </p>
                    </div>
                  </motion.div>
                )}

                {/* Video OLED Tab Content */}
                {settingsTab === 'oled' && (
                  <motion.div
                    key="oled"
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -50 }}
                    transition={getTransition({ duration: 0.25 })}
                    className="pr-2 space-y-3"
                  >
                    <div className="mb-2">
                      <h3 className="text-base font-semibold text-white mb-1">{t('watch.oledTitle')}</h3>
                      <p className="text-xs text-gray-400 mb-3">{t('watch.oledDesc')}</p>
                    </div>

                    {/* Off */}
                    <button
                      onClick={() => handleVideoOledChange('off')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${videoOledMode === 'off' ? 'bg-gray-800 border-l-4 border-red-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={videoOledMode === 'off' ? 'text-red-500 font-medium' : 'text-white'}>{t('watch.oledOff')}</span>
                        <span className="text-xs text-gray-500">{t('watch.oledOffDesc')}</span>
                      </div>
                      {videoOledMode === 'off' && <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Natural OLED */}
                    <button
                      onClick={() => handleVideoOledChange('natural')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${videoOledMode === 'natural' ? 'bg-gray-800 border-l-4 border-emerald-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={videoOledMode === 'natural' ? 'text-emerald-400 font-medium' : 'text-white'}>{t('watch.oledNatural')}</span>
                        <span className="text-xs text-gray-500">{t('watch.oledNaturalDesc')}</span>
                      </div>
                      {videoOledMode === 'natural' && <span className="text-xs px-2 py-1 bg-emerald-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Cinema OLED */}
                    <button
                      onClick={() => handleVideoOledChange('cinema')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${videoOledMode === 'cinema' ? 'bg-gray-800 border-l-4 border-amber-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={videoOledMode === 'cinema' ? 'text-amber-400 font-medium' : 'text-white'}>{t('watch.oledCinema')}</span>
                        <span className="text-xs text-gray-500">{t('watch.oledCinemaDesc')}</span>
                      </div>
                      {videoOledMode === 'cinema' && <span className="text-xs px-2 py-1 bg-amber-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Vivid OLED */}
                    <button
                      onClick={() => handleVideoOledChange('vivid')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${videoOledMode === 'vivid' ? 'bg-gray-800 border-l-4 border-pink-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={videoOledMode === 'vivid' ? 'text-pink-400 font-medium' : 'text-white'}>{t('watch.oledVivid')}</span>
                        <span className="text-xs text-gray-500">{t('watch.oledVividDesc')}</span>
                      </div>
                      {videoOledMode === 'vivid' && <span className="text-xs px-2 py-1 bg-pink-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Custom OLED */}
                    <button
                      onClick={() => handleVideoOledChange('custom')}
                      className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg flex justify-between items-center transition-colors ${videoOledMode === 'custom' ? 'bg-gray-800 border-l-4 border-cyan-600 pl-3' : 'bg-gray-900/60 text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className={videoOledMode === 'custom' ? 'text-cyan-400 font-medium' : 'text-white'}>{t('watch.oledCustom')}</span>
                        <span className="text-xs text-gray-500">{t('watch.oledCustomDesc')}</span>
                      </div>
                      {videoOledMode === 'custom' && <span className="text-xs px-2 py-1 bg-cyan-600 text-white rounded-full">{t('watch.active')}</span>}
                    </button>

                    {/* Custom OLED Sliders */}
                    {videoOledMode === 'custom' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-3 p-4 bg-gray-900/80 rounded-xl border border-cyan-600/30 space-y-4"
                      >
                        {/* Contrast */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.contrastLabel')}</span>
                            <span className="text-xs text-cyan-400 font-mono">{(customOled.contrast ?? 1).toFixed(2)}</span>
                          </div>
                          <input type="range" min="0.5" max="2" step="0.01" value={customOled.contrast ?? 1}
                            onChange={(e) => handleCustomOledChange('contrast', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            style={{ background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(((customOled.contrast ?? 1) - 0.5) / 1.5) * 100}%, #374151 ${(((customOled.contrast ?? 1) - 0.5) / 1.5) * 100}%, #374151 100%)` }}
                          />
                          <div className="flex justify-between text-[10px] text-gray-500 mt-0.5"><span>0.50</span><span>1.00</span><span>2.00</span></div>
                        </div>

                        {/* Saturation */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.saturationLabel')}</span>
                            <span className="text-xs text-cyan-400 font-mono">{(customOled.saturate ?? 1).toFixed(2)}</span>
                          </div>
                          <input type="range" min="0" max="3" step="0.01" value={customOled.saturate ?? 1}
                            onChange={(e) => handleCustomOledChange('saturate', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            style={{ background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${((customOled.saturate ?? 1) / 3) * 100}%, #374151 ${((customOled.saturate ?? 1) / 3) * 100}%, #374151 100%)` }}
                          />
                          <div className="flex justify-between text-[10px] text-gray-500 mt-0.5"><span>{t('watch.bwLabel')}</span><span>{t('watch.normalLabel')}</span><span>3.00</span></div>
                        </div>

                        {/* Brightness */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.brightnessLabel')}</span>
                            <span className="text-xs text-cyan-400 font-mono">{(customOled.brightness ?? 1).toFixed(2)}</span>
                          </div>
                          <input type="range" min="0.3" max="1.8" step="0.01" value={customOled.brightness ?? 1}
                            onChange={(e) => handleCustomOledChange('brightness', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            style={{ background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(((customOled.brightness ?? 1) - 0.3) / 1.5) * 100}%, #374151 ${(((customOled.brightness ?? 1) - 0.3) / 1.5) * 100}%, #374151 100%)` }}
                          />
                          <div className="flex justify-between text-[10px] text-gray-500 mt-0.5"><span>{t('watch.darkLabel')}</span><span>{t('watch.normalLabel')}</span><span>{t('watch.brightLabel')}</span></div>
                        </div>

                        {/* Sepia */}
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-gray-300">{t('watch.sepiaLabel')}</span>
                            <span className="text-xs text-cyan-400 font-mono">{(customOled.sepia ?? 0).toFixed(2)}</span>
                          </div>
                          <input type="range" min="0" max="1" step="0.01" value={customOled.sepia ?? 0}
                            onChange={(e) => handleCustomOledChange('sepia', parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            style={{ background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(customOled.sepia ?? 0) * 100}%, #374151 ${(customOled.sepia ?? 0) * 100}%, #374151 100%)` }}
                          />
                          <div className="flex justify-between text-[10px] text-gray-500 mt-0.5"><span>0</span><span>0.50</span><span>1.00</span></div>
                        </div>

                        {/* Reset custom OLED */}
                        <button
                          onClick={() => {
                            const defaults = { contrast: 1, saturate: 1, brightness: 1, sepia: 0 };
                            setCustomOled(defaults);
                            localStorage.setItem('playerCustomOled', JSON.stringify(defaults));
                          }}
                          className="w-full mt-2 px-3 py-2 text-xs text-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors border border-gray-700/50"
                        >
                          {t('watch.resetValues')}
                        </button>
                      </motion.div>
                    )}

                    {/* Preview indicator */}
                    {videoOledMode !== 'off' && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-4 p-3 bg-gradient-to-r from-gray-800/80 to-gray-900/80 rounded-lg border border-gray-700/50"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <div className={`w-2 h-2 rounded-full animate-pulse ${videoOledMode === 'natural' ? 'bg-emerald-500' : videoOledMode === 'cinema' ? 'bg-amber-500' : videoOledMode === 'custom' ? 'bg-cyan-500' : 'bg-pink-500'}`} />
                          <span className="text-xs font-medium text-white">{t('watch.activeFilter')}</span>
                        </div>
                        <p className="text-xs text-gray-400 font-mono">
                          {getVideoOledFilter()}
                        </p>
                      </motion.div>
                    )}

                    {/* Info */}
                    <div className="mt-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
                      <p className="text-xs text-gray-400">
                        {t('watch.oledInfo')}
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
    </motion.div>
  );
};

export default React.memo(HLSPlayerSettingsPanel);
