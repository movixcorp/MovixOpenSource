import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import {
  ArrowLeft, Settings, Shield, Monitor, Smartphone, Tablet,
  Copy, X, Snowflake, Activity, Trash2, Crown, Volume2,
  Database, Key, Lock, Palette, Eye, Download, Upload, Globe, AlertTriangle, History, CalendarClock, FlaskConical, Link2, MessageCircle, BellOff, Sparkles,
  Zap, RefreshCw, ChevronDown, ListOrdered, Gauge, Megaphone, Square, Captions
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

import { discordAuth } from '../services/discordAuth';
import { googleAuth } from '../services/googleAuth';
import {
  getExtractionPrefs,
  setExtractionPrefs,
  resetExtractionPrefs,
  subscribeToPrefsChanges,
  pushPrefsToExtension,
  M3U8_EXTRACTOR_KEYS,
  LIVETV_SOURCE_KEYS,
  EXTRACTION_METHOD_KEYS,
  type ExtractionPrefs,
  type M3u8ExtractorKey,
  type LiveTvSourceKey,
  type ExtractionMethod,
} from '../utils/extractionPrefs';
import { isExtensionAvailable, fetchFromExtension } from '../utils/extensionProxy';
import { isUserVip } from '../utils/authUtils';
import { unsubscribeFromPush } from '../services/pushNotificationService';
import { clearStoredAuthSession, getResolvedAccountContext, setPendingAuthLink } from '../utils/accountAuth';
import {
  formatStorageBytes,
  getAllLocalStorageEntries,
  getLocalStorageMetrics,
  getNonSyncableLocalStorageEntries,
  type NonSyncableLocalStorageEntry,
  type NonSyncableStorageReason,
  isSyncableStorageKey
} from '../utils/syncStorage';
import {
  areSoundEffectsEnabled,
  setSoundEffectsEnabled,
  SOUND_EFFECTS_CHANGED_EVENT
} from '../utils/soundSettings';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_LANGUAGES, changeLanguage, type SupportedLanguage } from '../i18n';
import { SourcePriorityPanel } from '../components/Settings/SourcePriorityPanel';
import {
  getRememberLastPlayer,
  setRememberLastPlayer,
  subscribeToLastPlayerChanges,
} from '../utils/lastPlayerPref';
import {
  getAdPopupMode,
  setAdPopupMode,
  subscribeToAdPopupModeChanges,
  type AdPopupMode,
} from '../utils/adPopupMode';
import {
  isAdultAdsEnabled,
  setAdultAdsEnabled,
  subscribeToAdultAdsChanges,
} from '../utils/adAdultMode';
import { isLowLatencyEnabled, setLowLatencyEnabled, type LowLatencyScope } from '../utils/lowLatencyPref';
import { BgColorPickerPanel } from '../components/Settings/BgColorPickerPanel';
import { useLightMode } from '../context/LightModeContext';
import { SettingsSearchBar } from '../components/Settings/SettingsSearchBar';
import { SubtitlePreview } from '../components/subtitles/SubtitlePreview';
import { SubtitleStyleControls } from '../components/subtitles/SubtitleStyleControls';
import { useSubtitlePreferences } from '../hooks/useSubtitlePreferences';
import {
  BG_ACCENT_PRESETS,
  BG_STORAGE_KEYS,
  type BgAccentKey,
  type BgAccentValue,
  notifyBgPrefsChanged,
} from '../utils/bgPreferences';
import {
  getSessionBrowserLabel,
  normalizeSessionDeviceInfo,
  type SessionDeviceInfo,
  type SessionDeviceType,
} from '../utils/sessionDevice';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

const API_URL = import.meta.env.VITE_MAIN_API;

// ─── Types ───────────────────────────────────────────────────────────────────

interface VipStatus {
  isVip: boolean;
  expiresAt?: string;
  features: string[];
}

interface UserSession {
  id: string;
  userId: string;
  createdAt: string;
  accessedAt: string;
  userAgent: string;
  deviceInfo?: SessionDeviceInfo;
}

type LinkProvider = 'discord' | 'google' | 'bip39';

interface LinkedAccountStatus {
  linked: boolean;
  providerUserId: string | null;
  linkedAt: string | null;
  updatedAt: string | null;
}

interface LinkedAccountsMeta {
  accountProvider: LinkProvider | null;
  authMethod: LinkProvider | null;
  canManageLinks: boolean;
  manageWithProvider: LinkProvider | null;
}

function isLinkProvider(value: string | null | undefined): value is LinkProvider {
  return value === 'discord' || value === 'google' || value === 'bip39';
}

interface ImportedMediaItem {
  id?: string | number;
  type?: string;
  title?: string;
  name?: string;
  poster_path?: string;
  episodeInfo?: unknown;
  addedAt?: string;
}

interface LocalStorageMetrics {
  totalBytes: number;
  syncableBytes: number;
  totalKeys: number;
  syncableKeys: number;
}

interface SyncServerStats {
  profileId: string;
  profileBytes: number;
  profileKeyCount: number;
  profileQuotaBytes: number;
  legacySyncBytes: number;
  legacySyncKeyCount: number;
  totalSyncBytes: number;
}

function getNonSyncReasonTranslationKey(reason: NonSyncableStorageReason) {
  switch (reason) {
    case 'blocked':
      return 'settings.nonSyncReasonBlocked';
    case 'invalid_format':
      return 'settings.nonSyncReasonInvalidFormat';
    case 'not_allowlisted':
    default:
      return 'settings.nonSyncReasonNotAllowlisted';
  }
}

// ─── Section IDs for sidebar navigation ──────────────────────────────────────

const SECTIONS = [
  { id: 'appearance', labelKey: 'settings.sections.appearance', icon: Palette },
  { id: 'subtitles', labelKey: 'settings.sections.subtitles', icon: Captions },
  { id: 'performance', labelKey: 'settings.sections.performance', icon: Gauge },
  { id: 'language', labelKey: 'settings.sections.language', icon: Globe },
  { id: 'vip', labelKey: 'settings.sections.vip', icon: Crown },
  { id: 'sessions', labelKey: 'settings.sections.sessions', icon: Monitor },
  { id: 'accounts', labelKey: 'settings.sections.accounts', icon: Link2 },
  { id: 'privacy', labelKey: 'settings.sections.privacy', icon: Shield },
  { id: 'source-priority', labelKey: 'settings.sections.sourcePriority', icon: ListOrdered },
  { id: 'intermission', labelKey: 'settings.sections.adPopup', icon: Megaphone },
  { id: 'extractions', labelKey: 'settings.sections.extractions', icon: Zap },
  { id: 'data', labelKey: 'settings.sections.data', icon: Database },
] as const;

// ─── Polled subcomponents ────────────────────────────────────────────────────
//
// Audit #9 : ces blocs sont extraits du SettingsPage (67 useStates) parce que
// leurs setInterval (5s pour storage, 10s pour cache extension) faisaient
// re-render TOUTE la page à chaque tick. Ici chaque tick re-render uniquement
// le leaf concerné. Pattern identique à la TimeRemaining de LiveTV (commit
// f57083a).

interface StorageMetricsBlockProps {
  serverSyncStats: SyncServerStats | null;
  isLoadingServerSyncStats: boolean;
  selectedProfileId: string | null;
  hasServerStorageContext: boolean;
  serverQuotaUsagePercent: number;
}

const StorageMetricsBlock: React.FC<StorageMetricsBlockProps> = ({
  serverSyncStats,
  isLoadingServerSyncStats,
  selectedProfileId,
  hasServerStorageContext,
  serverQuotaUsagePercent,
}) => {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<LocalStorageMetrics>(() => getLocalStorageMetrics());

  useEffect(() => {
    const refresh = () => setMetrics(getLocalStorageMetrics());
    refresh();

    window.addEventListener('storage', refresh);
    window.addEventListener('auth_changed', refresh);
    window.addEventListener('sync_storage_updated', refresh as EventListener);
    window.addEventListener('focus', refresh);

    const interval = window.setInterval(refresh, 5000);

    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('auth_changed', refresh);
      window.removeEventListener('sync_storage_updated', refresh as EventListener);
      window.removeEventListener('focus', refresh);
      window.clearInterval(interval);
    };
  }, []);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageLocalTotal')}</p>
          <p className="mt-2 text-2xl font-semibold text-white">{formatStorageBytes(metrics.totalBytes)}</p>
          <p className="mt-1 text-xs text-gray-500">{t('settings.storageKeys', { count: metrics.totalKeys })}</p>
        </div>

        <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageSyncable')}</p>
          <p className="mt-2 text-2xl font-semibold text-white">{formatStorageBytes(metrics.syncableBytes)}</p>
          <p className="mt-1 text-xs text-gray-500">{t('settings.storageKeys', { count: metrics.syncableKeys })}</p>
        </div>

        <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageServerProfile')}</p>
          <p className="mt-2 text-2xl font-semibold text-white">
            {isLoadingServerSyncStats
              ? t('common.loading')
              : serverSyncStats
                ? formatStorageBytes(serverSyncStats.profileBytes)
                : t('common.notAvailable')}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {serverSyncStats
              ? t('settings.storageKeys', { count: serverSyncStats.profileKeyCount })
              : hasServerStorageContext
                ? t('settings.storageServerHint')
                : t('settings.storageServerUnavailable')}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageProfileQuota')}</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {serverSyncStats
                  ? `${serverQuotaUsagePercent}%`
                  : '--'}
              </p>
            </div>
            {serverSyncStats && (
              <p className="text-right text-xs text-gray-500">
                {formatStorageBytes(serverSyncStats.profileBytes)} / {formatStorageBytes(serverSyncStats.profileQuotaBytes)}
              </p>
            )}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-800/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-lime-400 transition-colors duration-300"
              style={{ width: `${serverQuotaUsagePercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {selectedProfileId
              ? t('settings.storageSelectedProfile', { profileId: selectedProfileId })
              : t('settings.storageServerUnavailable')}
          </p>
        </div>
      </div>

      {serverSyncStats && serverSyncStats.legacySyncBytes > 0 && (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="font-medium text-amber-200">{t('settings.storageLegacyData')}</p>
          <p className="mt-1 text-xs text-amber-100/80">
            {formatStorageBytes(serverSyncStats.legacySyncBytes)} · {t('settings.storageKeys', { count: serverSyncStats.legacySyncKeyCount })}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-amber-100/75">
            {t('settings.storageLegacyDataDesc')}
          </p>
        </div>
      )}
    </>
  );
};

interface ExtensionCacheStatsBlockProps {
  extensionPresent: boolean;
}

const ExtensionCacheStatsBlock: React.FC<ExtensionCacheStatsBlockProps> = ({ extensionPresent }) => {
  const { t } = useTranslation();
  const [cacheStats, setCacheStats] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (!extensionPresent) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const cs = await fetchFromExtension<Record<string, number>>('GET_CACHE_STATS').catch(() => null);
        if (!cancelled) setCacheStats(cs);
      } catch {
        // silent
      }
    };
    refresh();
    const id = window.setInterval(refresh, 10000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [extensionPresent]);

  const handleClearCache = useCallback(async () => {
    if (!extensionPresent) return;
    try {
      await fetchFromExtension('CLEAR_EXTRACTION_CACHE', {});
      const refreshed = await fetchFromExtension<Record<string, number>>('GET_CACHE_STATS').catch(() => null);
      setCacheStats(refreshed);
    } catch (e) {
      console.warn('[extractions] clear cache failed', e);
    }
  }, [extensionPresent]);

  return (
    <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">{t('settings.extractions.cache.title')}</h3>
        <button
          onClick={handleClearCache}
          disabled={!extensionPresent}
          className="text-sm text-red-400 hover:text-red-300 disabled:text-gray-600 flex items-center gap-1.5"
        >
          <Trash2 className="w-4 h-4" /> {t('settings.extractions.cache.clearAll')}
        </button>
      </div>
      {!extensionPresent ? (
        <p className="text-sm text-gray-500">{t('settings.extractions.cache.notAvailable')}</p>
      ) : cacheStats && Object.keys(cacheStats).length > 0 ? (
        <div className="grid grid-cols-2 gap-2 text-sm">
          {Object.entries(cacheStats).map(([type, count]) => (
            <div key={type} className="flex justify-between py-1.5 border-b border-white/5">
              <span className="text-gray-300 capitalize">{type}</span>
              <span className="text-gray-500">
                {t('settings.extractions.cache.entriesOther', { count })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">{t('settings.extractions.cache.empty')}</p>
      )}
    </div>
  );
};

// ─── Settings Page ───────────────────────────────────────────────────────────

const SettingsPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();
  const { lightModeSetting, setLightModeSetting, isLightMode, prefs: animPrefs, effectivePrefs: animEffectivePrefs, setPref: setAnimPref } = useLightMode();
  const {
    preferences: subtitlePreferences,
    patchPreferences,
    previewPreferences,
    commitPreferences,
    resetAppearance,
  } = useSubtitlePreferences();
  // Active section tracking
  const [activeSection, setActiveSection] = useState<string>(() => {
    const hash = location.hash.replace('#', '');
    return hash || 'appearance';
  });
  // ─── Appearance settings state ───────────────────────────────────────────

  const [disableAutoScroll, setDisableAutoScroll] = useState(() => {
    return localStorage.getItem('settings_disable_auto_scroll') === 'true';
  });

  const [disableRouteScrollToTop, setDisableRouteScrollToTop] = useState(() => {
    return localStorage.getItem('settings_disable_route_scroll_to_top') === 'true';
  });

  const [smoothScrollEnabled, setSmoothScrollEnabled] = useState(() => {
    return localStorage.getItem('settings_smooth_scroll') !== 'false';
  });

  const [soundEffectsEnabled, setSoundEffectsEnabledState] = useState(() => {
    return areSoundEffectsEnabled();
  });

  const [isSnowfallActive, setIsSnowfallActive] = useState(() => {
    return sessionStorage.getItem('snowfall_active') === 'true';
  });

  // M11 — toggle "se souvenir du dernier lecteur choisi".
  const [rememberLastPlayer, setRememberLastPlayerState] = useState<boolean>(() => getRememberLastPlayer());
  useEffect(() => subscribeToLastPlayerChanges(() => setRememberLastPlayerState(getRememberLastPlayer())), []);
  const handleRememberLastPlayerToggle = () => {
    const next = !rememberLastPlayer;
    setRememberLastPlayerState(next);
    setRememberLastPlayer(next);
  };

  // Mode popup pub (normal / auto / click-anywhere).
  const [adPopupMode, setAdPopupModeState] = useState<AdPopupMode>(() => getAdPopupMode());
  useEffect(() => subscribeToAdPopupModeChanges(setAdPopupModeState), []);
  const handleAdPopupModeChange = (mode: AdPopupMode) => {
    setAdPopupModeState(mode);
    setAdPopupMode(mode);
  };

  // Toggle publicités +18.
  const [adultAds, setAdultAdsState] = useState<boolean>(() => isAdultAdsEnabled());
  useEffect(() => subscribeToAdultAdsChanges(setAdultAdsState), []);
  const handleAdultAdsToggle = () => {
    const next = !adultAds;
    setAdultAdsState(next);
    setAdultAdsEnabled(next);
  };

  const [bgMode, setBgMode] = useState<'combined' | 'static' | 'animated'>(() => {
    return (localStorage.getItem('settings_bg_mode') as 'combined' | 'static' | 'animated') || 'combined';
  });

  // ─── Customisation fond (couleur accent + taille des carrés) ─────────
  // Presets / helpers partagés dans `utils/bgPreferences.ts` (pour que
  // SquareBackground puisse aussi les lire quand `forceColor` est activé).
  const [bgAccent, setBgAccent] = useState<BgAccentValue>(() => {
    const v = localStorage.getItem(BG_STORAGE_KEYS.accent);
    if (v === 'custom') return 'custom';
    return v && v in BG_ACCENT_PRESETS ? (v as BgAccentKey) : 'red';
  });

  // Couleur custom : seule la valeur committée vit dans la SettingsPage. Le
  // draft (chaque pixel pendant le drag) est isolé dans `BgColorPickerPanel`
  // (memo) — sinon chaque pointermove re-render les 3440 lignes de cette
  // page, d'où le lag perçu. Le panel commit ~100ms après que l'user lâche.
  const [bgAccentCustomHex, setBgAccentCustomHex] = useState<string>(() => {
    return localStorage.getItem(BG_STORAGE_KEYS.customHex) || '#ef4444';
  });

  const [bgSquareSize, setBgSquareSize] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(BG_STORAGE_KEYS.squareSize) || '48', 10);
    return [32, 48, 64, 80].includes(v) ? v : 48;
  });

  const [bgForceColor, setBgForceColor] = useState<boolean>(() => {
    return localStorage.getItem(BG_STORAGE_KEYS.forceColor) === '1';
  });
  const [bgForceSquareSize, setBgForceSquareSize] = useState<boolean>(() => {
    return localStorage.getItem(BG_STORAGE_KEYS.forceSquareSize) === '1';
  });
  const [bgHaloEnabled, setBgHaloEnabled] = useState<boolean>(() => {
    return localStorage.getItem(BG_STORAGE_KEYS.haloEnabled) !== '0';
  });

  const handleBgAccentChange = (key: BgAccentValue) => {
    setBgAccent(key);
    localStorage.setItem(BG_STORAGE_KEYS.accent, key);
    notifyBgPrefsChanged();
  };

  // Appelé par BgColorPickerPanel APRÈS son propre debounce 100ms : ici on
   // commit direct. Mémorisé pour que la prop `onCommit` soit stable et que
   // `React.memo` du panel fasse son boulot.
  const handleBgAccentCustomChange = useCallback((hex: string) => {
    setBgAccentCustomHex(hex);
    localStorage.setItem(BG_STORAGE_KEYS.customHex, hex);
    setBgAccent((prev) => {
      if (prev !== 'custom') {
        localStorage.setItem(BG_STORAGE_KEYS.accent, 'custom');
        return 'custom';
      }
      return prev;
    });
    notifyBgPrefsChanged();
  }, []);

  const handleBgSquareSizeChange = (size: number) => {
    setBgSquareSize(size);
    localStorage.setItem(BG_STORAGE_KEYS.squareSize, String(size));
    notifyBgPrefsChanged();
  };

  const handleBgForceColorToggle = () => {
    const next = !bgForceColor;
    setBgForceColor(next);
    localStorage.setItem(BG_STORAGE_KEYS.forceColor, next ? '1' : '0');
    notifyBgPrefsChanged();
  };

  const handleBgHaloToggle = () => {
    const next = !bgHaloEnabled;
    setBgHaloEnabled(next);
    localStorage.setItem(BG_STORAGE_KEYS.haloEnabled, next ? '1' : '0');
    notifyBgPrefsChanged();
  };

  const handleBgForceSquareSizeToggle = () => {
    const next = !bgForceSquareSize;
    setBgForceSquareSize(next);
    localStorage.setItem(BG_STORAGE_KEYS.forceSquareSize, next ? '1' : '0');
    notifyBgPrefsChanged();
  };

  const [squareCornersEnabled, setSquareCornersEnabled] = useState<boolean>(() => {
    return localStorage.getItem('square_corners_enabled') === '1';
  });

  const handleSquareCornersToggle = () => {
    const next = !squareCornersEnabled;
    setSquareCornersEnabled(next);
    localStorage.setItem('square_corners_enabled', next ? '1' : '0');
    document.documentElement.classList.toggle('square-corners', next);
  };

  const [introEnabled, setIntroEnabled] = useState(() => {
    return localStorage.getItem('movix_intro_enabled') === 'true';
  });

  const [screensaverEnabled, setScreensaverEnabled] = useState(() => {
    return localStorage.getItem('screensaver_enabled') === 'true';
  });
  const [screensaverTimeout, setScreensaverTimeout] = useState(() => {
    return parseInt(localStorage.getItem('screensaver_timeout') || '60', 10);
  });
  const [screensaverMode, setScreensaverMode] = useState(() => {
    return localStorage.getItem('screensaver_mode') || 'backdrop';
  });

  // ─── VIP state ───────────────────────────────────────────────────────────

  const [vipStatus, setVipStatus] = useState<VipStatus>({ isVip: false, features: [] });
  const [premiumKey, setPremiumKey] = useState('');
  const [vipKeyError, setVipKeyError] = useState<string | null>(null);
  const [isActivatingKey, setIsActivatingKey] = useState(false);
  const [isVipKeyHovered, setIsVipKeyHovered] = useState(false);
  const { checkAccessCode, error: authError, lastAttempt } = useAuth();

  // ─── Sessions state ──────────────────────────────────────────────────────

  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // —— Linked accounts state ———————————————————————————————————————————————————————

  const [linkedAccounts, setLinkedAccounts] = useState<Record<LinkProvider, LinkedAccountStatus>>({
    discord: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
    google: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
    bip39: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
  });
  const [linkModal, setLinkModal] = useState<{ provider: LinkProvider; action: 'link' | 'unlink' } | null>(null);
  const [isClosingLinkModal, setIsClosingLinkModal] = useState(false);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [isSubmittingLinkAction, setIsSubmittingLinkAction] = useState(false);
  const [linkedAccountsMeta, setLinkedAccountsMeta] = useState<LinkedAccountsMeta>(() => {
    const account = getResolvedAccountContext();
    return {
      accountProvider: account.accountProvider,
      authMethod: account.authMethod,
      canManageLinks: Boolean(
        account.accountProvider &&
        account.authMethod &&
        account.accountProvider === account.authMethod
      ),
      manageWithProvider: account.accountProvider,
    };
  });

  // ─── Privacy state ───────────────────────────────────────────────────────

  const [dataCollection, setDataCollection] = useState(() => {
    return localStorage.getItem('privacy_data_collection') !== 'false';
  });

  const [historyDisabled, setHistoryDisabled] = useState(() => {
    return localStorage.getItem('settings_disable_history') === 'true';
  });
  const [commentsSectionHidden, setCommentsSectionHidden] = useState(() => {
    return localStorage.getItem('settings_hide_comments_section') === 'true';
  });
  const [heroHidden, setHeroHidden] = useState(() => {
    return localStorage.getItem('settings_hide_hero') === 'true';
  });
  const [streamingPlatformsHidden, setStreamingPlatformsHidden] = useState(() => {
    return localStorage.getItem('settings_hide_streaming_platforms') === 'true';
  });
  const [showHistoryConfirm, setShowHistoryConfirm] = useState(false);
  const [showDataCollectionConfirm, setShowDataCollectionConfirm] = useState(false);
  const [notificationsDisabled, setNotificationsDisabled] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [recommendationsDisabled, setRecommendationsDisabled] = useState(() => {
    return localStorage.getItem('settings_disable_recommendations') === 'true';
  });

  // ─── Data popups state ───────────────────────────────────────────────────

  const [showIdPopup, setShowIdPopup] = useState(false);
  const [isClosingIdPopup, setIsClosingIdPopup] = useState(false);
  const [accountIdInfo, setAccountIdInfo] = useState<{ id: string; provider: 'discord' | 'google' | 'bip39' | 'oauth' | 'unknown' } | null>(null);

  const [showLocalStoragePopup, setShowLocalStoragePopup] = useState(false);
  const [isClosingLocalStoragePopup, setIsClosingLocalStoragePopup] = useState(false);
  const [localStorageData, setLocalStorageData] = useState<string>('');
  const [showNonSyncablePopup, setShowNonSyncablePopup] = useState(false);
  const [isClosingNonSyncablePopup, setIsClosingNonSyncablePopup] = useState(false);
  const [nonSyncableEntries, setNonSyncableEntries] = useState<NonSyncableLocalStorageEntry[]>([]);

  const [showImportPopup, setShowImportPopup] = useState(false);
  const [isClosingImportPopup, setIsClosingImportPopup] = useState(false);
  const [importData, setImportData] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => localStorage.getItem('selected_profile_id'));
  const [storageMetrics, setStorageMetrics] = useState<LocalStorageMetrics>(() => getLocalStorageMetrics());
  const [serverSyncStats, setServerSyncStats] = useState<SyncServerStats | null>(null);
  const [isLoadingServerSyncStats, setIsLoadingServerSyncStats] = useState(false);

  // ─── Auth state ──────────────────────────────────────────────────────────

  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // ─── Extractions state ───────────────────────────────────────────────────
  const [extractionPrefs, setExtractionPrefsState] = useState<ExtractionPrefs>(() => getExtractionPrefs());
  const [cacheStats, setCacheStats] = useState<Record<string, number> | null>(null);
  const [extractionSessionStats, setExtractionSessionStats] = useState<{ extractions: number; corsFixed: number; cached: number; byType?: Record<string, number> } | null>(null);
  const [showResetExtractionsConfirm, setShowResetExtractionsConfirm] = useState(false);
  const [isClosingResetExtractionsConfirm, setIsClosingResetExtractionsConfirm] = useState(false);
  const [m3u8SectionExpanded, setM3u8SectionExpanded] = useState(false);
  const [livetvSectionExpanded, setLivetvSectionExpanded] = useState(false);
  const extensionPresent = isExtensionAvailable();

  const visibleSections = React.useMemo(() => {
    if (isAuthenticated) return SECTIONS;
    return SECTIONS.filter(s => !['sessions', 'accounts', 'privacy', 'data'].includes(s.id));
  }, [isAuthenticated]);

  // ─── Désactive Lenis sur la page Settings ───────────────────────────────
  //
  // Raison : la page Settings est lourde (90+ cards motion.div, 9 sections,
  // backdrops, gradients). Lenis force 60 frames de rendu par wheel-flick
  // synchronisés sur le main thread. Sur hardware sans accélération GPU,
  // chaque frame dépasse 16ms → stutter pendant le scroll.
  //
  // En mode natif, le browser bat les frames (compositor thread indépendant
  // du main thread). Scrolling reste "fluide" même si paints sont lents —
  // c'est exactement l'effet que l'user observe en draggant la scrollbar.
  //
  // À la sortie de SettingsPage on restore Lenis (les autres pages en
  // bénéficient).
  useEffect(() => {
    type LenisInstance = { destroy: () => void; stop: () => void; start: () => void };
    type WindowWithLenis = typeof window & { lenis?: LenisInstance };
    const w = window as WindowWithLenis;
    const prevLenis = w.lenis;
    if (prevLenis) {
      // Destroy supprime le wheel listener → native scroll prend la main.
      prevLenis.destroy();
      delete w.lenis;
    }
    return () => {
      // Re-init par le composant SmoothScroll qui écoute l'event.
      if (prevLenis && localStorage.getItem('settings_smooth_scroll') !== 'false') {
        window.dispatchEvent(new CustomEvent('settings_smooth_scroll_changed'));
      }
    };
  }, []);

  // ─── Check auth ──────────────────────────────────────────────────────────

  useEffect(() => {
    const checkAuth = () => {
      const auth = localStorage.getItem('auth');
      const discordAuth = localStorage.getItem('discord_auth');
      const googleAuth = localStorage.getItem('google_auth');
      const bip39Auth = localStorage.getItem('bip39_auth');
      const isAuth = discordAuth === 'true' || googleAuth === 'true' || bip39Auth === 'true' || !!auth;
      setIsAuthenticated(isAuth);
    };
    checkAuth();
    window.addEventListener('storage', checkAuth);
    window.addEventListener('auth_changed', checkAuth);
    return () => {
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('auth_changed', checkAuth);
    };
  }, []);

  useEffect(() => {
    const syncSoundEffectsPreference = () => {
      setSoundEffectsEnabledState(areSoundEffectsEnabled());
    };

    window.addEventListener('storage', syncSoundEffectsPreference);
    window.addEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundEffectsPreference as EventListener);

    return () => {
      window.removeEventListener('storage', syncSoundEffectsPreference);
      window.removeEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundEffectsPreference as EventListener);
    };
  }, []);

  const refreshStorageMetrics = useCallback(() => {
    setSelectedProfileId(localStorage.getItem('selected_profile_id'));
    setStorageMetrics(getLocalStorageMetrics());
  }, []);

  // Le 5s setInterval + ces listeners vivent maintenant dans <StorageMetricsBlock />.
  // SettingsPage garde sa propre copie de storageMetrics pour dériver
  // `nonSyncableKeyCount` / `nonSyncableBytes` (utilisés par le bouton et le
  // popup non-syncable). On rafraîchit uniquement sur événements réels (pas de
  // tick périodique) — sinon on re-rendrait toute la page (67 useStates) à
  // chaque tick, ce que l'extraction visait précisément à éviter.
  useEffect(() => {
    refreshStorageMetrics();

    const handleStorageMetricsRefresh = () => {
      refreshStorageMetrics();
    };

    window.addEventListener('storage', handleStorageMetricsRefresh);
    window.addEventListener('auth_changed', handleStorageMetricsRefresh);
    window.addEventListener('sync_storage_updated', handleStorageMetricsRefresh as EventListener);
    window.addEventListener('focus', handleStorageMetricsRefresh);

    return () => {
      window.removeEventListener('storage', handleStorageMetricsRefresh);
      window.removeEventListener('auth_changed', handleStorageMetricsRefresh);
      window.removeEventListener('sync_storage_updated', handleStorageMetricsRefresh as EventListener);
      window.removeEventListener('focus', handleStorageMetricsRefresh);
    };
  }, [refreshStorageMetrics]);

  const loadServerSyncStats = useCallback(async () => {
    const authToken = localStorage.getItem('auth_token');
    const profileId = localStorage.getItem('selected_profile_id');
    setSelectedProfileId(profileId);

    if (!isAuthenticated || !authToken || !profileId) {
      setServerSyncStats(null);
      setIsLoadingServerSyncStats(false);
      return;
    }

    try {
      setIsLoadingServerSyncStats(true);
      const response = await axios.get(`${API_URL}/api/sync/stats/${profileId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      setServerSyncStats(response.data?.stats || null);
    } catch (error) {
      console.error('Error loading sync stats:', error);
      setServerSyncStats(null);
    } finally {
      setIsLoadingServerSyncStats(false);
    }
  }, [isAuthenticated, selectedProfileId]);

  useEffect(() => {
    loadServerSyncStats();

    const handleSyncStatsRefresh = () => {
      loadServerSyncStats();
    };

    window.addEventListener('storage', handleSyncStatsRefresh);
    window.addEventListener('auth_changed', handleSyncStatsRefresh);
    window.addEventListener('sync_storage_updated', handleSyncStatsRefresh as EventListener);
    window.addEventListener('focus', handleSyncStatsRefresh);

    return () => {
      window.removeEventListener('storage', handleSyncStatsRefresh);
      window.removeEventListener('auth_changed', handleSyncStatsRefresh);
      window.removeEventListener('sync_storage_updated', handleSyncStatsRefresh as EventListener);
      window.removeEventListener('focus', handleSyncStatsRefresh);
    };
  }, [loadServerSyncStats]);

  // ─── Load VIP status ────────────────────────────────────────────────────

  useEffect(() => {
    const loadVipStatus = () => {
      const isVip = isUserVip();
      if (isVip) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') {
          expiration = accessCodeExpires;
        }
        setVipStatus({ isVip: true, expiresAt: expiration, features: [t('settings.noAds')] });
      } else {
        setVipStatus({ isVip: false, features: [] });
      }
    };
    loadVipStatus();
    window.addEventListener('storage', loadVipStatus);
    return () => window.removeEventListener('storage', loadVipStatus);
  }, [t]);

  // ─── Load sessions ──────────────────────────────────────────────────────

  const getUserInfo = () => {
    const account = getResolvedAccountContext();
    if (!account.userType || !account.userId) return null;
    return { type: account.userType, id: account.userId };
  };

  const loadSessions = useCallback(async () => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) return;
      const response = await axios.get(`${API_URL}/api/sessions`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      const items = response.data?.data?.items || [];
      setSessions(items);
      const storedSessionId = localStorage.getItem('session_id');
      setCurrentSessionId(storedSessionId);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        clearStoredAuthSession();
        sessionStorage.clear();
        window.location.href = '/';
        return;
      }
      console.error('Error loading sessions:', err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) loadSessions();
  }, [isAuthenticated, loadSessions]);

  const loadAccountLinks = useCallback(async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      setIsLoadingLinks(true);
      const response = await axios.get(`${API_URL}/api/auth/links`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data?.success && response.data.links) {
        setLinkedAccounts({
          discord: response.data.links.discord || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
          google: response.data.links.google || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
          bip39: response.data.links.bip39 || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
        });
        setLinkedAccountsMeta({
          accountProvider: isLinkProvider(response.data.account?.provider) ? response.data.account.provider : null,
          authMethod: isLinkProvider(response.data.account?.authMethod) ? response.data.account.authMethod : null,
          canManageLinks: response.data.account?.canManageLinks !== false,
          manageWithProvider: isLinkProvider(response.data.account?.manageWithProvider) ? response.data.account.manageWithProvider : null,
        });

        // Si le serveur signale que le pseudo viole la policy → déclenche la
        // modale bloquante (qui écoute `auth-changed`).
        if (response.data.requiresUsernameChange) {
          localStorage.setItem('requires_username_change', '1');
          window.dispatchEvent(new Event('auth-changed'));
        }
      }
    } catch (error) {
      console.error('Error loading account links:', error);
    } finally {
      setIsLoadingLinks(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadAccountLinks();
    }
  }, [isAuthenticated, loadAccountLinks]);

  // ─── Scroll Spy via IntersectionObserver ────────────────────────────────
  //
  // Ancien impl : `window.addEventListener('scroll')` qui fire ~60×/sec,
  // faisait 9 `getElementById` + `element.offsetTop` par frame. Avec
  // `content-visibility:auto` sur les sections, chaque `offsetTop` sur
  // une section skipped force un full layout → gros freeze pile au passage
  // d'une section à l'autre (problème reporté par l'utilisateur).
  //
  // IntersectionObserver : fire UNIQUEMENT aux transitions de visibilité,
  // aucun listener scroll, aucun reflow forcé. rootMargin définit une
  // "bande active" en haut du viewport : dès qu'une section y entre, elle
  // devient active.

  // Ref pour bloquer temporairement les updates d'activeSection pendant un
  // scroll programmatique (clic sidebar). Sinon : cliquer "Données" depuis
  // "Apparence" fait défiler tous les sections intermédiaires, chacune
  // triggerant l'IntersectionObserver → l'indicateur sidebar bascule par
  // chaque section d'affilée (cascade visuelle indésirable).
  const programmaticScrollLockRef = useRef(false);
  const scrollLockTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (visibleSections.length === 0) return;

    const sectionIds = visibleSections.map((s) => s.id);
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    let currentActive: string | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        // Ignore les callbacks pendant un scroll programmatique — l'activeSection
        // est déjà settée directement par scrollToSection, pas besoin de la
        // re-updater au passage des sections intermédiaires.
        if (programmaticScrollLockRef.current) return;

        const scrolledToBottom =
          window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 50;
        if (scrolledToBottom) {
          const last = sectionIds[sectionIds.length - 1];
          if (currentActive !== last) {
            currentActive = last;
            setActiveSection(last);
          }
          return;
        }

        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;

        const topmost = visible.reduce((best, e) =>
          !best || e.boundingClientRect.top < best.boundingClientRect.top ? e : best,
        visible[0]);

        const nextId = topmost.target.id;
        if (currentActive !== nextId) {
          currentActive = nextId;
          setActiveSection(nextId);
        }
      },
      {
        rootMargin: '-100px 0px -80% 0px',
        threshold: 0,
      },
    );

    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSections]);

  // ─── Lock body scroll on popups ──────────────────────────────────────────

  useEffect(() => {
    if (!showIdPopup && !showLocalStoragePopup && !showNonSyncablePopup && !showImportPopup && !linkModal && !showResetExtractionsConfirm) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const lenis = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
    if (lenis) lenis.stop();
    return () => {
      document.body.style.overflow = original;
      if (lenis) lenis.start();
    };
  }, [showIdPopup, showLocalStoragePopup, showNonSyncablePopup, showImportPopup, linkModal, showResetExtractionsConfirm]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleAutoScrollToggle = () => {
    const newValue = !disableAutoScroll;
    setDisableAutoScroll(newValue);
    localStorage.setItem('settings_disable_auto_scroll', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_auto_scroll_changed'));
  };

  const handleRouteScrollToTopToggle = () => {
    const newValue = !disableRouteScrollToTop;
    setDisableRouteScrollToTop(newValue);
    localStorage.setItem('settings_disable_route_scroll_to_top', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_route_scroll_changed'));
  };

  const handleSmoothScrollToggle = () => {
    const newValue = !smoothScrollEnabled;
    setSmoothScrollEnabled(newValue);
    localStorage.setItem('settings_smooth_scroll', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_smooth_scroll_changed'));
  };

  // ─── Intensité du scroll fluide (3 presets Lenis) ───────────────────────
  const [smoothScrollIntensity, setSmoothScrollIntensity] = useState<'standard' | 'fluid' | 'ultra'>(() => {
    const v = localStorage.getItem('settings_smooth_scroll_intensity');
    return v === 'fluid' || v === 'ultra' ? v : 'standard';
  });

  const handleSmoothScrollIntensityChange = (next: 'standard' | 'fluid' | 'ultra') => {
    setSmoothScrollIntensity(next);
    localStorage.setItem('settings_smooth_scroll_intensity', next);
    window.dispatchEvent(new CustomEvent('settings_smooth_scroll_intensity_changed'));
  };

  const handleSoundEffectsToggle = () => {
    const newValue = !soundEffectsEnabled;
    setSoundEffectsEnabledState(newValue);
    setSoundEffectsEnabled(newValue);
  };

  const handleSnowfallToggle = () => {
    const newValue = !isSnowfallActive;
    setIsSnowfallActive(newValue);
    sessionStorage.setItem('snowfall_active', String(newValue));
    window.dispatchEvent(new CustomEvent('snowfall_toggled'));
  };

  const handleBgModeChange = (newMode: 'combined' | 'static' | 'animated') => {
    setBgMode(newMode);
    localStorage.setItem('settings_bg_mode', newMode);
  };

  const handleIntroToggle = () => {
    const newValue = !introEnabled;
    setIntroEnabled(newValue);
    localStorage.setItem('movix_intro_enabled', String(newValue));
    if (newValue) {
      localStorage.removeItem('movix_intro_seen');
    }
    window.dispatchEvent(new Event('intro_settings_changed'));
  };

  const handleScreensaverToggle = () => {
    const newValue = !screensaverEnabled;
    setScreensaverEnabled(newValue);
    localStorage.setItem('screensaver_enabled', String(newValue));
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleScreensaverTimeoutChange = (seconds: number) => {
    setScreensaverTimeout(seconds);
    localStorage.setItem('screensaver_timeout', String(seconds));
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleScreensaverModeChange = (mode: string) => {
    setScreensaverMode(mode);
    localStorage.setItem('screensaver_mode', mode);
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleDataCollectionToggle = () => {
    if (dataCollection) {
      // Disabling → show confirmation
      setShowDataCollectionConfirm(true);
    } else {
      // Re-enabling
      setDataCollection(true);
      localStorage.setItem('privacy_data_collection', 'true');
    }
  };

  const confirmDisableDataCollection = async () => {
    setDataCollection(false);
    localStorage.setItem('privacy_data_collection', 'false');
    setRecommendationsDisabled(true);
    localStorage.setItem('settings_disable_recommendations', 'true');
    setShowDataCollectionConfirm(false);

    // Delete wrapped data on the backend
    try {
      const authToken = localStorage.getItem('auth_token');
      if (authToken) {
        await fetch(`${API_URL}/api/wrapped/data`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
      }
    } catch {
      // Silent fail — non-critical
    }
  };

  const handleHistoryToggle = () => {
    if (!historyDisabled) {
      // Enabling disable → show confirmation
      setShowHistoryConfirm(true);
    } else {
      // Re-enabling history
      setHistoryDisabled(false);
      localStorage.setItem('settings_disable_history', 'false');
    }
  };

  const handleCommentsSectionToggle = () => {
    const newValue = !commentsSectionHidden;
    setCommentsSectionHidden(newValue);
    localStorage.setItem('settings_hide_comments_section', String(newValue));
    window.dispatchEvent(new CustomEvent('comments_section_visibility_changed'));
  };

  const handleHeroToggle = () => {
    const newValue = !heroHidden;
    setHeroHidden(newValue);
    localStorage.setItem('settings_hide_hero', String(newValue));
    window.dispatchEvent(new CustomEvent('hero_visibility_changed'));
  };

  const handleStreamingPlatformsToggle = () => {
    const newValue = !streamingPlatformsHidden;
    setStreamingPlatformsHidden(newValue);
    localStorage.setItem('settings_hide_streaming_platforms', String(newValue));
    window.dispatchEvent(new CustomEvent('streaming_platforms_visibility_changed'));
  };

  // Streaming basse latence (LL-HLS) — opt-in par lecteur. S'applique à la
  // prochaine lecture (lu au montage du lecteur). Voir utils/lowLatencyPref.ts.
  const [lowLatencyMovies, setLowLatencyMovies] = useState<boolean>(() => isLowLatencyEnabled('movies'));
  const [lowLatencyLiveTv, setLowLatencyLiveTv] = useState<boolean>(() => isLowLatencyEnabled('livetv'));
  const handleLowLatencyToggle = (scope: LowLatencyScope) => {
    const next = !(scope === 'movies' ? lowLatencyMovies : lowLatencyLiveTv);
    setLowLatencyEnabled(scope, next);
    if (scope === 'movies') setLowLatencyMovies(next);
    else setLowLatencyLiveTv(next);
  };

  const handleRecommendationsToggle = () => {
    const newValue = !recommendationsDisabled;
    setRecommendationsDisabled(newValue);
    localStorage.setItem('settings_disable_recommendations', String(newValue));
  };

  const confirmDisableHistory = () => {
    setHistoryDisabled(true);
    localStorage.setItem('settings_disable_history', 'true');
    localStorage.removeItem('continueWatching');
    setShowHistoryConfirm(false);
  };

  useEffect(() => {
    const authToken = localStorage.getItem('auth_token');
    if (!authToken) return;
    fetch(`${API_URL}/api/comments/notifications/preferences`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.success) setNotificationsDisabled(data.notificationsDisabled);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return subscribeToPrefsChanges((next) => setExtractionPrefsState(next));
  }, []);

  // Le 10s setInterval qui pollait `cacheStats` vit maintenant dans
  // <ExtensionCacheStatsBlock />. Ici on garde un fetch one-shot au mount
  // pour `extractionSessionStats` + `cacheStats` (snapshot) qui alimentent le
  // panel m3u8 expandable (collapsed par défaut). Pas de polling : ces compteurs
  // sont des stats de session, ils n'évoluent pas pendant que l'user reste
  // sur la page Settings.
  useEffect(() => {
    if (!extensionPresent) return;
    let cancelled = false;
    (async () => {
      try {
        const [cs, st] = await Promise.all([
          fetchFromExtension<Record<string, number>>('GET_CACHE_STATS').catch(() => null),
          fetchFromExtension<{ extractions: number; corsFixed: number; cached: number; byType?: Record<string, number> }>('GET_STATS').catch(() => null),
        ]);
        if (!cancelled) {
          setCacheStats(cs);
          setExtractionSessionStats(st);
        }
      } catch {
        // silent
      }
    })();
    return () => { cancelled = true; };
  }, [extensionPresent]);

  const handleNotificationsToggle = async () => {
    const authToken = localStorage.getItem('auth_token');
    if (!authToken || notificationsLoading) return;
    setNotificationsLoading(true);
    const newValue = !notificationsDisabled;
    try {
      const res = await fetch(`${API_URL}/api/comments/notifications/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ notificationsDisabled: newValue }),
      });
      const data = await res.json();
      if (data?.success) {
        setNotificationsDisabled(data.notificationsDisabled);
        window.dispatchEvent(new CustomEvent('notifications_disabled_changed', { detail: data.notificationsDisabled }));
        // Désinscrire des push si notifications désactivées
        if (data.notificationsDisabled) {
          unsubscribeFromPush();
        }
      }
    } catch {
      // Silent fail
    } finally {
      setNotificationsLoading(false);
    }
  };

  const handleActivatePremiumKey = async () => {
    if (!premiumKey.trim()) return;
    if (lastAttempt) {
      const elapsed = Date.now() - lastAttempt;
      if (elapsed < 30000) {
        const remaining = Math.ceil((30000 - elapsed) / 1000);
        setVipKeyError(t('settings.waitBeforeRetry', { seconds: remaining }));
        return;
      }
    }
    setIsActivatingKey(true);
    setVipKeyError(null);
    try {
      const discordAuth = localStorage.getItem('discord_auth') === 'true';
      const googleAuth = localStorage.getItem('google_auth') === 'true';
      const alreadyAuthenticated = discordAuth || googleAuth;
      const success = await checkAccessCode(premiumKey.trim(), alreadyAuthenticated);
      if (success) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') expiration = accessCodeExpires;
        setVipStatus({ isVip: true, expiresAt: expiration, features: [t('settings.noAds')] });
        setPremiumKey('');
        setVipKeyError(null);
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('authStateChanged'));
      } else {
        setVipKeyError(authError || t('vip.invalidKey'));
      }
    } catch {
      setVipKeyError(t('vip.activationError'));
    } finally {
      setIsActivatingKey(false);
    }
  };

  const handleRemovePremiumKey = () => {
    localStorage.removeItem('is_vip');
    localStorage.removeItem('access_code');
    localStorage.removeItem('access_code_expires');
    setVipStatus({ isVip: false, features: [] });
    window.dispatchEvent(new Event('storage'));
  };

  const copyPremiumKey = () => {
    const accessCode = localStorage.getItem('access_code');
    if (accessCode) navigator.clipboard.writeText(accessCode);
  };

  const getProviderLabel = (provider: LinkProvider) => {
    if (provider === 'discord') return 'Discord';
    if (provider === 'google') return 'Google';
    return 'BIP39';
  };

  const openLinkModal = (provider: LinkProvider, action: 'link' | 'unlink') => {
    setIsClosingLinkModal(false);
    setLinkModal({ provider, action });
    setLinkActionError(null);
  };

  const closeLinkModal = () => {
    if (isSubmittingLinkAction) return;
    setIsClosingLinkModal(true);
    setTimeout(() => {
      setLinkModal(null);
      setIsClosingLinkModal(false);
      setLinkActionError(null);
    }, 220);
  };

  const handleConfirmLinkAction = async () => {
    if (!linkModal) return;

    const authToken = localStorage.getItem('auth_token');
    if (!authToken) {
      setLinkActionError('Session introuvable. Reconnectez-vous puis réessayez.');
      return;
    }

    setIsSubmittingLinkAction(true);
    setLinkActionError(null);

    try {
      if (linkModal.action === 'link') {
        if (linkModal.provider === 'google') {
          googleAuth.login({ mode: 'link', returnTo: '/settings#accounts' });
          return;
        }

        if (linkModal.provider === 'discord') {
          discordAuth.login({ mode: 'link', returnTo: '/settings#accounts' });
          return;
        }

        setPendingAuthLink('bip39', '/settings#accounts');
        closeLinkModal();
        window.setTimeout(() => {
          navigate('/link-bip39');
        }, 220);
        return;
      } else {
        const response = await axios.delete(`${API_URL}/api/auth/links/${linkModal.provider}`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Impossible de supprimer cette liaison');
        }
      }

      await loadAccountLinks();
      closeLinkModal();
    } catch (error: unknown) {
      const apiError = axios.isAxiosError(error)
        ? error.response?.data?.error
        : null;
      const message = error instanceof Error ? error.message : null;
      setLinkActionError(apiError || message || 'Une erreur est survenue');
    } finally {
      setIsSubmittingLinkAction(false);
    }
  };

  const deleteSession = async (sessionId: string) => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) return;
      const response = await axios.post(`${API_URL}/api/sessions/delete`, {
        sessionId
      }, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      if (response.data.success) {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (sessionId === currentSessionId) {
          clearStoredAuthSession();
          window.location.href = '/';
        }
      }
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  };

  // ─── Extraction handlers ─────────────────────────────────────────────────

  const handleUpdateExtractionPrefs = useCallback((next: ExtractionPrefs) => {
    setExtractionPrefsState(next);
    setExtractionPrefs(next);
    void pushPrefsToExtension(next);
  }, []);

  const handleToggleM3u8Extractor = useCallback((key: M3u8ExtractorKey, value: boolean) => {
    handleUpdateExtractionPrefs({
      ...extractionPrefs,
      m3u8: { ...extractionPrefs.m3u8, [key]: value },
    });
  }, [extractionPrefs, handleUpdateExtractionPrefs]);

  const handleToggleLiveTvSource = useCallback((key: LiveTvSourceKey, value: boolean) => {
    handleUpdateExtractionPrefs({
      ...extractionPrefs,
      livetv: { ...extractionPrefs.livetv, [key]: value },
    });
  }, [extractionPrefs, handleUpdateExtractionPrefs]);

  const handleSetExtractionMethod = useCallback((method: ExtractionMethod) => {
    if (extractionPrefs.method === method) return;
    handleUpdateExtractionPrefs({ ...extractionPrefs, method });
  }, [extractionPrefs, handleUpdateExtractionPrefs]);

  const handleToggleAllM3u8 = useCallback((value: boolean) => {
    const next = { ...extractionPrefs.m3u8 };
    M3U8_EXTRACTOR_KEYS.forEach((k) => { next[k] = value; });
    handleUpdateExtractionPrefs({ ...extractionPrefs, m3u8: next });
  }, [extractionPrefs, handleUpdateExtractionPrefs]);

  const handleToggleAllLiveTv = useCallback((value: boolean) => {
    const next = { ...extractionPrefs.livetv };
    LIVETV_SOURCE_KEYS.forEach((k) => { next[k] = value; });
    handleUpdateExtractionPrefs({ ...extractionPrefs, livetv: next });
  }, [extractionPrefs, handleUpdateExtractionPrefs]);

  // handleClearExtractionCache vit maintenant dans <ExtensionCacheStatsBlock />
  // (qui possède aussi son propre cacheStats state).

  const handleResetExtractions = useCallback(() => {
    setShowResetExtractionsConfirm(true);
  }, []);

  const handleCloseResetExtractionsConfirm = useCallback(() => {
    setIsClosingResetExtractionsConfirm(true);
    setTimeout(() => {
      setShowResetExtractionsConfirm(false);
      setIsClosingResetExtractionsConfirm(false);
    }, 300);
  }, []);

  const handleConfirmResetExtractions = useCallback(() => {
    resetExtractionPrefs();
    void pushPrefsToExtension();
    handleCloseResetExtractionsConfirm();
  }, [handleCloseResetExtractionsConfirm]);

  // Data handlers
  const openIdPopup = () => {
    const account = getResolvedAccountContext();
    if (!account.userId) return;

    const currentAccountProvider = linkedAccountsMeta.accountProvider || account.accountProvider;
    const provider: 'discord' | 'google' | 'bip39' | 'oauth' | 'unknown' =
      currentAccountProvider === 'discord' || currentAccountProvider === 'google' || currentAccountProvider === 'bip39'
        ? currentAccountProvider
        : account.userType === 'oauth'
          ? 'oauth'
          : 'unknown';

    setAccountIdInfo({
      id: account.userId,
      provider,
    });
    setShowIdPopup(true);
  };

  const handleCloseIdPopup = () => {
    setIsClosingIdPopup(true);
    setTimeout(() => { setShowIdPopup(false); setIsClosingIdPopup(false); }, 300);
  };

  const copyLocalStorage = () => {
    try {
      const localStorageString = JSON.stringify(getAllLocalStorageEntries(), null, 2);
      setLocalStorageData(localStorageString);
      setShowLocalStoragePopup(true);
    } catch (error) {
      console.error('Erreur lors de la copie du localStorage:', error);
    }
  };

  const handleCloseLocalStoragePopup = () => {
    setIsClosingLocalStoragePopup(true);
    setTimeout(() => { setShowLocalStoragePopup(false); setIsClosingLocalStoragePopup(false); }, 300);
  };

  const openNonSyncablePopup = () => {
    setNonSyncableEntries(getNonSyncableLocalStorageEntries());
    setShowNonSyncablePopup(true);
  };

  const handleCloseNonSyncablePopup = () => {
    setIsClosingNonSyncablePopup(true);
    setTimeout(() => {
      setShowNonSyncablePopup(false);
      setIsClosingNonSyncablePopup(false);
    }, 300);
  };

  const copyNonSyncableKeys = () => {
    const payload = JSON.stringify(
      nonSyncableEntries.map((entry) => ({
        key: entry.key,
        bytes: entry.bytes,
        reason: entry.reason,
      })),
      null,
      2
    );
    navigator.clipboard.writeText(payload);
  };

  const handleCloseImportPopup = () => {
    setIsClosingImportPopup(true);
    setTimeout(() => {
      setShowImportPopup(false);
      setIsClosingImportPopup(false);
      setImportData('');
      setImportError(null);
      setImportSuccess(null);
    }, 300);
  };

  const handleImportData = () => {
    if (!importData.trim()) { setImportError(t('settings.enterDataToImport')); return; }
    try {
      const data = JSON.parse(importData);
      let importedCount = 0;
      let filteredCount = 0;
      const errors: string[] = [];
      Object.entries(data).forEach(([key, value]) => {
        try {
          if (!isSyncableStorageKey(key)) {
            filteredCount++;
            return;
          }

          if (typeof value === 'string') {
            try {
              const parsedValue = JSON.parse(value);
              if (Array.isArray(parsedValue)) {
                const convertedArray = parsedValue.map((item: ImportedMediaItem) => {
                  if (item.episodeInfo) {
                    return { id: item.id, type: item.type, title: item.title || '', poster_path: item.poster_path || '', episodeInfo: item.episodeInfo, addedAt: item.addedAt || new Date().toISOString() };
                  } else {
                    return { id: item.id, type: item.type, title: item.title || item.name || '', poster_path: item.poster_path || '', addedAt: item.addedAt || new Date().toISOString() };
                  }
                });
                localStorage.setItem(key, JSON.stringify(convertedArray));
                importedCount++;
              } else {
                localStorage.setItem(key, JSON.stringify(parsedValue));
                importedCount++;
              }
            } catch {
              localStorage.setItem(key, value as string);
              importedCount++;
            }
          } else {
            localStorage.setItem(key, JSON.stringify(value));
            importedCount++;
          }
        } catch (itemError) {
          errors.push(`Erreur pour la clé "${key}": ${itemError}`);
        }
      });
      if (errors.length > 0 || filteredCount > 0) {
        setImportError(
          filteredCount > 0
            ? t('settings.importFiltered', { count: filteredCount })
            : t('settings.importPartial', { count: importedCount })
        );
      } else {
        setImportSuccess(t('settings.importSuccess', { count: importedCount }));
      }
      refreshStorageMetrics();
      window.dispatchEvent(new CustomEvent('sync_storage_updated'));
      setTimeout(() => window.location.reload(), 2000);
    } catch {
      setImportError(t('settings.importError'));
    }
  };

  // ─── Sidebar scroll-to handler ───────────────────────────────────────────

  /**
   * Scroll vers une section Settings depuis la sidebar.
   *
   * **Saut instantané par design** (changement 2026-04-24) :
   * Les animations programmatiques Lenis forcent une synchronisation entre
   * le RAF d'animation et le rendu main-thread — sur hardware faible ou
   * sans accélération GPU, chaque frame coûteuse du rendu décale la
   * frame suivante de l'animation → jank perçu, même avec
   * `content-visibility:auto` sur les sections.
   *
   * Le user a cliqué l'item sidebar → il VEUT cette section, il n'a pas
   * demandé une animation. On téléporte directement via Lenis `immediate`
   * (ou fallback native `behavior:auto`). Le scroll wheel garde son smooth
   * Lenis via l'intensité configurée dans Apparence.
   */
  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (!el) return;

    const isMobile = window.innerWidth < 1024;
    const topOffset = isMobile ? 112 : 96;
    const targetTop = Math.max(0, window.scrollY + el.getBoundingClientRect().top - topOffset);

    // Lenis est désactivé sur la page Settings (cf. useEffect plus haut)
    // donc on utilise le smooth scroll natif du browser — léger, compositor
    // thread, GPU-accéléré nativement, pas de RAF synchro main-thread.
    const smoothEnabled = localStorage.getItem('settings_smooth_scroll') !== 'false';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const willSmoothScroll = smoothEnabled && !reducedMotion;

    // Bloque l'IntersectionObserver pendant le scroll programmatique pour
    // empêcher l'indicateur sidebar de casacader par toutes les sections
    // intermédiaires. On set l'activeSection EN AVANCE (l'indicateur glisse
    // direct vers la cible via framer-motion layoutId).
    setActiveSection(sectionId);
    programmaticScrollLockRef.current = true;

    window.scrollTo({
      top: targetTop,
      behavior: willSmoothScroll ? 'smooth' : 'auto',
    });

    // Délock après le temps d'un smooth scroll (browser fait 500-700ms
    // typiquement pour un trajet Apparence → Données). Plus court pour un
    // scroll instantané.
    const unlockDelay = willSmoothScroll ? 900 : 50;
    // Si un précédent unlock est en cours, on l'annule pour redémarrer le délai.
    if (scrollLockTimerRef.current) clearTimeout(scrollLockTimerRef.current);
    scrollLockTimerRef.current = window.setTimeout(() => {
      programmaticScrollLockRef.current = false;
      scrollLockTimerRef.current = null;
    }, unlockDelay);
  }, []);

  useEffect(() => {
    const sectionId = location.hash.replace('#', '');
    if (!sectionId) return;
    const frame = window.requestAnimationFrame(() => scrollToSection(sectionId));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, scrollToSection]);

  const navigateToSearchTarget = (sectionId: string, target: HTMLElement) => {
    const highlightClasses = ['rounded-lg', 'ring-2', 'ring-red-500/70', 'ring-offset-4', 'ring-offset-[#0a0a0f]'];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setActiveSection(sectionId);
    programmaticScrollLockRef.current = true;
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.classList.add(...highlightClasses);
    window.setTimeout(() => target.classList.remove(...highlightClasses), 1400);
    window.setTimeout(() => {
      programmaticScrollLockRef.current = false;
    }, reducedMotion ? 50 : 900);
  };

  // ─── Render helpers ──────────────────────────────────────────────────────

  const renderToggle = (value: boolean, onToggle: () => void, color: string = 'red') => {
    const bgActive = color === 'blue' ? 'bg-blue-500' : color === 'purple' ? 'bg-purple-500' : color === 'green' ? 'bg-green-500' : color === 'indigo' ? 'bg-indigo-500' : 'bg-red-600';
    return (
      <button
        onClick={onToggle}
        className={`relative ml-4 w-14 h-8 rounded-full transition-colors duration-300 flex-shrink-0 ${value ? bgActive : 'bg-gray-600'}`}
      >
        <span
          className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow-md transform transition-transform duration-300 ${value ? 'translate-x-6' : 'translate-x-0'}`}
        />
      </button>
    );
  };

  const getDeviceIcon = (deviceType: SessionDeviceType) => {
    if (deviceType === 'mobile') return <Smartphone className="w-5 h-5" />;
    if (deviceType === 'tablet') return <Tablet className="w-5 h-5" />;
    return <Monitor className="w-5 h-5" />;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffMins < 1) return t('common.justNow');
    if (diffMins < 60) return t('common.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('common.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('common.daysAgo', { count: diffDays });
    return date.toLocaleDateString(i18n.language);
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const resolvedAccount = getResolvedAccountContext();
  const currentAccountProvider = linkedAccountsMeta.accountProvider || resolvedAccount.accountProvider;
  const currentAuthMethod = linkedAccountsMeta.authMethod || resolvedAccount.authMethod;
  const currentManagementProvider = linkedAccountsMeta.manageWithProvider || currentAccountProvider;
  const canManageLinkedAccounts = linkedAccountsMeta.canManageLinks;
  const currentAuthMethodLinked = currentAuthMethod ? linkedAccounts[currentAuthMethod].linked : false;
  const canShowAccountId = Boolean(resolvedAccount.userId);
  const nonSyncableKeyCount = Math.max(0, storageMetrics.totalKeys - storageMetrics.syncableKeys);
  const nonSyncableBytes = Math.max(0, storageMetrics.totalBytes - storageMetrics.syncableBytes);
  const serverQuotaUsagePercent = serverSyncStats?.profileQuotaBytes
    ? Math.min(100, Math.round((serverSyncStats.profileBytes / serverSyncStats.profileQuotaBytes) * 100))
    : 0;
  const hasServerStorageContext = Boolean(isAuthenticated && selectedProfileId);

  return (
    <div className="min-h-screen overflow-clip bg-black text-white">
      {/* Mobile Header */}
      <div className="lg:hidden flex items-center gap-4 border-b border-gray-800/60 bg-black p-4">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-gray-800/60 transition-colors text-gray-400 hover:text-white"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-red-600/20 to-orange-600/20 border border-red-500/20">
            <Settings className="w-5 h-5 text-red-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">{t('settings.title')}</h1>
        </div>
      </div>

      {/* Main layout */}
      <div className="w-full pb-8">
        <div className="lg:grid lg:grid-cols-[280px,minmax(0,1fr)] lg:gap-0">

          {/* ─── Fixed Sidebar ──────────────────────────────────────── */}
          <aside data-settings-sidebar className="hidden min-w-0 border-r border-white/[0.06] bg-black lg:block">
          <nav className="sticky top-20 flex h-[calc(100dvh-5rem)] min-h-0 flex-col overflow-hidden bg-black px-5 py-7">
            {/* Settings Header in Sidebar */}
            <div data-settings-sidebar-header className="mb-4 flex flex-none items-center gap-3 border-b border-gray-800/40 pb-5">
              <button
                onClick={() => navigate(-1)}
                className="p-2 rounded-lg hover:bg-gray-800/60 transition-colors text-gray-400 hover:text-white"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="p-2 rounded-xl bg-gradient-to-br from-red-600/20 to-orange-600/20 border border-red-500/20">
                <Settings className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-white">{t('settings.title')}</h1>
                <p className="text-xs text-gray-500">{t('settings.subtitle')}</p>
              </div>
            </div>

            <div data-settings-sidebar-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
            <ul className="space-y-1">
              {visibleSections.map(({ id, labelKey, icon: Icon }) => {
                const isActive = activeSection === id;
                return (
                  <li key={id}>
                    <button
                      onClick={() => scrollToSection(id)}
                      className={`relative w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors duration-200 border focus:outline-none ${isActive
                        ? 'text-red-400 border-transparent'
                        : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/40'
                        }`}
                    >
                      {/* Indicateur glissant vertical — framer layoutId anime
                          automatiquement le déplacement entre les items. Même
                          pattern que les Tabs de SourcePriorityPanel mais
                          vertical. */}
                      {isActive && (
                        <motion.div
                          layoutId="settings-sidebar-indicator"
                          className="absolute inset-0 bg-red-600/15 border border-red-500/20 rounded-xl shadow-sm shadow-red-600/5 pointer-events-none"
                          transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
                        />
                      )}
                      <Icon className={`relative z-10 w-4 h-4 flex-shrink-0 ${isActive ? 'text-red-400' : 'text-gray-500'}`} />
                      <span className="relative z-10">{t(labelKey)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            </div>

            {/* Back to profile link */}
            <div className="mt-4 flex-none border-t border-gray-800/40 pt-4">
              <Link
                to="/profile"
                className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800/40 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('nav.backToProfile')}
              </Link>
            </div>
          </nav>
          </aside>

          <main className="min-w-0 px-4 pt-6 sm:px-6 lg:px-8 lg:pt-8 xl:px-10">
          <SettingsSearchBar contentRootRef={contentRef} onNavigate={navigateToSearchTarget} />

          {/* ─── Mobile Section Tabs ────────────────────────────────── */}
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0a0a0f]/95 border-t border-gray-800/60 px-2 pb-[env(safe-area-inset-bottom)]">
            <div className="flex items-center justify-center gap-2 pt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-gray-500">
              <span className="h-px w-5 bg-gray-800/80" />
              <span>{t('settings.mobileTabsHint')}</span>
              <span className="h-px w-5 bg-gray-800/80" />
            </div>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-[#0a0a0f] to-transparent" />
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-[#0a0a0f] to-transparent" />
              <div className="overflow-x-auto scrollbar-hide touch-pan-x scroll-smooth">
                <div className="mx-auto flex w-max min-w-full justify-center gap-1 px-2 py-2">
                  {visibleSections.map(({ id, labelKey, icon: Icon }) => {
                    const isActive = activeSection === id;
                    return (
                      <button
                        key={id}
                        onClick={() => scrollToSection(id)}
                        className={`flex w-[92px] flex-shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-center transition-colors ${isActive ? 'text-red-400' : 'text-gray-500'
                          }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-[10px] font-medium whitespace-nowrap">{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ─── Scrollable Content ─────────────────────────────────── */}
          <div ref={contentRef} className="mx-auto mt-8 min-w-0 max-w-[1440px] space-y-12 pb-24 lg:pb-8">

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Apparence                                      */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="appearance" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-purple-600/20 to-pink-600/20 border border-purple-500/20">
                  <Palette className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.appearance')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.appearanceDesc')}</p>
                </div>
              </div>

              <div className="space-y-3">
                {/* Conserver la position entre les pages */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.025 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.keepScrollPositionBetweenPages')}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.keepScrollPositionBetweenPagesDesc')}
                    </p>
                  </div>
                  {renderToggle(disableRouteScrollToTop, handleRouteScrollToTopToggle)}
                </motion.div>

                {/* Conserver la position */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.keepScrollPosition')}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.keepScrollPositionDesc')}
                    </p>
                  </div>
                  {renderToggle(disableAutoScroll, handleAutoScrollToggle)}
                </motion.div>

                {/* Smooth scroll — sélecteur unifié 4 options
                    (Désactivé / Standard / Fluide / Ultra fluide). Le toggle
                    ON/OFF séparé d'avant a été fusionné dans ce sélecteur :
                    cliquer "Désactivé" coupe Lenis (scroll natif), les 3 autres
                    activent + choisissent l'intensité. */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors"
                >
                  <div className="flex flex-col gap-3">
                    <div>
                      <h4 className="font-medium text-white mb-0.5 text-sm">
                        {t('settings.smoothScrollIntensity', 'Intensité du scroll fluide')}
                      </h4>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.smoothScrollIntensityDesc', 'Contrôle l\'inertie du défilement. Plus fluide = plus de glisse mais réponse moins immédiate. Choisis « Désactivé » pour repasser au scroll natif (recommandé sur configs lentes).')}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {([
                        { id: 'off',      labelKey: 'settings.smoothScrollIntensity.off',      descKey: 'settings.smoothScrollIntensity.offDesc',      fallbackLabel: 'Désactivé',   fallbackDesc: 'Scroll natif du navigateur' },
                        { id: 'standard', labelKey: 'settings.smoothScrollIntensity.standard', descKey: 'settings.smoothScrollIntensity.standardDesc', fallbackLabel: 'Standard',    fallbackDesc: 'Inertie modérée, équilibrée' },
                        { id: 'fluid',    labelKey: 'settings.smoothScrollIntensity.fluid',    descKey: 'settings.smoothScrollIntensity.fluidDesc',    fallbackLabel: 'Fluide',      fallbackDesc: 'Glisse longue, défilement souple' },
                        { id: 'ultra',    labelKey: 'settings.smoothScrollIntensity.ultra',    descKey: 'settings.smoothScrollIntensity.ultraDesc',    fallbackLabel: 'Ultra fluide', fallbackDesc: 'Inertie maximale, effet premium' },
                      ] as const).map((opt) => {
                        const isOff = opt.id === 'off';
                        const active = isOff
                          ? !smoothScrollEnabled
                          : (smoothScrollEnabled && smoothScrollIntensity === opt.id);
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              if (isOff) {
                                if (smoothScrollEnabled) handleSmoothScrollToggle();
                              } else {
                                if (!smoothScrollEnabled) handleSmoothScrollToggle();
                                handleSmoothScrollIntensityChange(opt.id);
                              }
                            }}
                            className={`flex-1 min-w-[100px] p-3 rounded-xl text-left transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
                              active
                                ? (isOff
                                    ? 'bg-gray-600/15 border-gray-500/40 text-white'
                                    : 'bg-indigo-600/10 border-indigo-500/30 text-white')
                                : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                            }`}
                          >
                            <div className="text-xs font-semibold">{t(opt.labelKey, opt.fallbackLabel)}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{t(opt.descKey, opt.fallbackDesc)}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>

                {/* Bruitages */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.125 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Volume2 className="w-3.5 h-3.5 text-orange-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.soundEffects')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.soundEffectsDesc')}
                    </p>
                  </div>
                  {renderToggle(soundEffectsEnabled, handleSoundEffectsToggle)}
                </motion.div>

                {/* Section commentaires */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1375 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <MessageCircle className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.hideCommentsSection')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.hideCommentsSectionDesc')}
                    </p>
                  </div>
                  {renderToggle(commentsSectionHidden, handleCommentsSectionToggle, 'blue')}
                </motion.div>

                {/* Effet neige */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Snowflake className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.snowEffect')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.snowEffectDesc')}
                    </p>
                  </div>
                  {renderToggle(isSnowfallActive, handleSnowfallToggle, 'blue')}
                </motion.div>

                {/* Coins carrés */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.175 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Square className="w-3.5 h-3.5 text-purple-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.squareCorners', 'Coins carrés')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.squareCornersDesc', 'Supprime tous les coins arrondis de l\'interface (cartes, carrousels, boutons, avatars…).')}
                    </p>
                  </div>
                  {renderToggle(squareCornersEnabled, handleSquareCornersToggle, 'purple')}
                </motion.div>

                {/* Style de fond */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors"
                >
                  <div className="mb-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Activity className="w-3.5 h-3.5 text-red-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.backgroundStyle')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.backgroundStyleDesc')}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {([
                      { value: 'combined' as const, label: t('settings.bgCombined'), desc: t('settings.bgCombinedDesc') },
                      { value: 'static' as const, label: t('settings.bgStatic'), desc: t('settings.bgStaticDesc') },
                      { value: 'animated' as const, label: t('settings.bgAnimated'), desc: t('settings.bgAnimatedDesc') },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleBgModeChange(opt.value)}
                        className={`flex-1 min-w-[100px] p-3 rounded-xl text-left transition-colors border ${bgMode === opt.value
                          ? 'bg-red-600/10 border-red-500/30 text-white'
                          : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                        }`}
                      >
                        <div className="text-xs font-semibold">{opt.label}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                      </button>
                    ))}
                  </div>

                  {/* ─── Toggle Halo lumineux ─────────────────────────────
                      Désactive le dégradé radial qui suit le curseur. Visible
                      uniquement dans les modes "combiné" et "classique"
                      (le mode "interactif" n'a pas de halo). */}
                  <div className="mt-4 pt-4 border-t border-gray-700/40 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h5 className="font-medium text-white text-sm mb-0.5">
                        {t('settings.bgHalo')}
                      </h5>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.bgHaloDesc')}
                      </p>
                    </div>
                    {renderToggle(bgHaloEnabled, handleBgHaloToggle, 'indigo')}
                  </div>

                  {/* ─── Couleur accent du fond ─────────────────────────── */}
                  <div className="mt-4 pt-4 border-t border-gray-700/40">
                    <h5 className="font-medium text-white text-sm mb-0.5">
                      {t('settings.bgAccentColor', 'Couleur accent')}
                    </h5>
                    <p className="text-xs text-gray-500 leading-relaxed mb-3">
                      {t('settings.bgAccentColorDesc', 'Couleur des bordures et du halo au survol du fond.')}
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      {(Object.entries(BG_ACCENT_PRESETS) as Array<[BgAccentKey, typeof BG_ACCENT_PRESETS[BgAccentKey]]>).map(([key, preset]) => {
                        const active = bgAccent === key;
                        return (
                          <button
                            key={key}
                            onClick={() => handleBgAccentChange(key)}
                            className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-colors ${
                              active
                                ? 'bg-white/5 border-white/30'
                                : 'border-transparent hover:bg-white/5'
                            }`}
                            title={preset.label}
                            aria-label={preset.label}
                            aria-pressed={active}
                          >
                            <span
                              className={`w-8 h-8 rounded-full shadow-inner transition-transform ${active ? 'scale-110 ring-2 ring-white/40 ring-offset-2 ring-offset-[#0a0a0f]' : ''}`}
                              style={{ backgroundColor: preset.swatch }}
                            />
                            <span className={`text-[10px] ${active ? 'text-white' : 'text-gray-500'}`}>
                              {preset.label}
                            </span>
                          </button>
                        );
                      })}

                      {/* Swatch "Custom" — bascule sur le mode custom (le picker
                          react-colorful est toujours visible en dessous). */}
                      <button
                        type="button"
                        onClick={() => handleBgAccentChange('custom')}
                        className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-colors ${
                          bgAccent === 'custom'
                            ? 'bg-white/5 border-white/30'
                            : 'border-transparent hover:bg-white/5'
                        }`}
                        title={t('settings.bgAccentCustom', 'Personnalisée')}
                        aria-pressed={bgAccent === 'custom'}
                      >
                        <span
                          className={`w-8 h-8 rounded-full shadow-inner transition-transform ${bgAccent === 'custom' ? 'scale-110 ring-2 ring-white/40 ring-offset-2 ring-offset-[#0a0a0f]' : ''}`}
                          style={{
                            background: bgAccent === 'custom'
                              ? bgAccentCustomHex
                              : 'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #6366f1, #a855f7, #ec4899, #ef4444)',
                          }}
                        />
                        <span className={`text-[10px] ${bgAccent === 'custom' ? 'text-white' : 'text-gray-500'}`}>
                          {t('settings.bgAccentCustom', 'Custom')}
                        </span>
                      </button>
                    </div>

                    {/* Picker isolé dans son propre composant memo : le drag de
                        la pipette ne re-render plus SettingsPage (3440 lignes),
                        seulement BgColorPickerPanel. Commit ~100ms après l'arrêt. */}
                    <BgColorPickerPanel
                      committedHex={bgAccentCustomHex}
                      inputLabel={t('settings.bgAccentCustom', 'Custom')}
                      hint={t('settings.bgAccentCustomHint', 'Glissez la pipette pour ajuster, ou tapez l\'hex. La couleur est appliquée à cette page en preview.')}
                      onCommit={handleBgAccentCustomChange}
                    />

                    {/* Toggle : forcer cette couleur sur les autres pages */}
                    <div className="mt-4 flex items-center justify-between p-3 bg-gray-800/30 rounded-xl border border-gray-700/40">
                      <div className="flex-1 mr-4">
                        <h6 className="font-medium text-white text-xs mb-0.5">
                          {t('settings.bgForceColor', 'Forcer cette couleur partout')}
                        </h6>
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                          {t('settings.bgForceColorDesc', 'Applique la couleur choisie sur toutes les pages (sinon chaque page garde sa teinte par défaut).')}
                        </p>
                      </div>
                      {renderToggle(bgForceColor, handleBgForceColorToggle, 'indigo')}
                    </div>
                  </div>

                  {/* ─── Taille des carrés ─────────────────────────────── */}
                  <div className="mt-4 pt-4 border-t border-gray-700/40">
                    <h5 className="font-medium text-white text-sm mb-0.5">
                      {t('settings.bgSquareSize', 'Taille des carrés')}
                    </h5>
                    <p className="text-xs text-gray-500 leading-relaxed mb-3">
                      {t('settings.bgSquareSizeDesc', 'Densité de la grille : plus petit = plus de carrés.')}
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      {([
                        { value: 32, labelKey: 'settings.bgSizeSmall',  descKey: 'settings.bgSizeSmallDesc',  fallbackLabel: 'Dense',     fallbackDesc: 'Grille très dense, beaucoup de carrés' },
                        { value: 48, labelKey: 'settings.bgSizeMedium', descKey: 'settings.bgSizeMediumDesc', fallbackLabel: 'Moyen',     fallbackDesc: 'Densité équilibrée, par défaut' },
                        { value: 64, labelKey: 'settings.bgSizeLarge',  descKey: 'settings.bgSizeLargeDesc',  fallbackLabel: 'Aéré',      fallbackDesc: 'Carrés plus larges, moins denses' },
                        { value: 80, labelKey: 'settings.bgSizeXLarge', descKey: 'settings.bgSizeXLargeDesc', fallbackLabel: 'Très aéré', fallbackDesc: 'Carrés très larges, grille minimale' },
                      ] as const).map((opt) => {
                        const active = bgSquareSize === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => handleBgSquareSizeChange(opt.value)}
                            className={`flex-1 min-w-[100px] p-3 rounded-xl text-left transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
                              active
                                ? 'bg-indigo-600/10 border-indigo-500/30 text-white'
                                : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                            }`}
                          >
                            <div className="text-xs font-semibold">{t(opt.labelKey, opt.fallbackLabel)}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{t(opt.descKey, opt.fallbackDesc)}</div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Toggle : forcer cette taille sur les autres pages */}
                    <div className="mt-4 flex items-center justify-between p-3 bg-gray-800/30 rounded-xl border border-gray-700/40">
                      <div className="flex-1 mr-4">
                        <h6 className="font-medium text-white text-xs mb-0.5">
                          {t('settings.bgForceSquareSize', 'Forcer cette taille partout')}
                        </h6>
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                          {t('settings.bgForceSquareSizeDesc', 'Applique la taille choisie sur toutes les pages (sinon chaque page garde sa densité par défaut).')}
                        </p>
                      </div>
                      {renderToggle(bgForceSquareSize, handleBgForceSquareSizeToggle, 'indigo')}
                    </div>
                  </div>
                </motion.div>

                {/* Screensaver */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 mr-4">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Monitor className="w-3.5 h-3.5 text-purple-400" />
                        <h4 className="font-medium text-white text-sm">{t('settings.screensaver')}</h4>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.screensaverDesc')}
                      </p>
                    </div>
                    {renderToggle(screensaverEnabled, handleScreensaverToggle)}
                  </div>

                  <AnimatePresence>
                    {screensaverEnabled && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-4 space-y-4 pt-4 border-t border-gray-700/30">
                          <div>
                            <label className="text-xs font-medium text-gray-400 mb-2 block">
                              {t('settings.inactivityDelay')}
                            </label>
                            <div className="flex gap-2 flex-wrap">
                              {[
                                { value: 30, label: '30s' },
                                { value: 60, label: '1 min' },
                                { value: 120, label: '2 min' },
                                { value: 300, label: '5 min' },
                                { value: 600, label: '10 min' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => handleScreensaverTimeoutChange(opt.value)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${screensaverTimeout === opt.value
                                    ? 'bg-red-600 text-white shadow-lg shadow-red-600/20'
                                    : 'bg-gray-700/40 text-gray-400 hover:bg-gray-700 hover:text-white'
                                    }`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-gray-400 mb-2 block">
                              {t('settings.screensaverStyle')}
                            </label>
                            <div className="flex gap-2 flex-wrap">
                              {[
                                { value: 'backdrop', label: t('settings.cinematicCarousel'), desc: t('settings.cinematicCarouselDesc') },
                                { value: 'mosaic', label: t('settings.favoriteMosaic'), desc: t('settings.favoriteMosaicDesc') },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => handleScreensaverModeChange(opt.value)}
                                  className={`flex-1 min-w-[140px] p-3 rounded-xl text-left transition-colors border ${screensaverMode === opt.value
                                    ? 'bg-red-600/10 border-red-500/30 text-white'
                                    : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                                    }`}
                                >
                                  <div className="text-xs font-semibold">{opt.label}</div>
                                  <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                {/* Intro Breaking Bad */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 mr-4">
                      <div className="flex items-center gap-2 mb-0.5">
                        <FlaskConical className="w-3.5 h-3.5 text-green-400" />
                        <h4 className="font-medium text-white text-sm">{t('settings.introAnimation')}</h4>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.introAnimationDesc')}
                      </p>
                    </div>
                    {renderToggle(introEnabled, handleIntroToggle, 'green')}
                  </div>
                </motion.div>
              </div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Sous-titres                                    */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="subtitles" className="scroll-mt-36">
              <div data-settings-search-title className="mb-6 flex items-center gap-3">
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-600/15 p-2">
                  <Captions className="h-5 w-5 text-cyan-300" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.subtitles.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.subtitles.description')}</p>
                </div>
              </div>
              <div data-settings-subtitle-layout className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] xl:items-start">
                <div className="min-w-0 xl:col-start-2 xl:row-start-1 xl:sticky xl:top-36">
                  <div
                    data-settings-search-title
                    data-settings-search-keywords="aperçu,preview,position"
                    className="space-y-4 rounded-2xl border border-white/10 bg-gray-900/35 p-5"
                  >
                    <h3 className="font-semibold text-white">{t('settings.subtitles.preview')}</h3>
                    <SubtitlePreview preferences={subtitlePreferences} onChange={patchPreferences} />
                  </div>
                </div>
                <div className="min-w-0 xl:col-start-1 xl:row-start-1">
                  <SubtitleStyleControls
                    preferences={subtitlePreferences}
                    onChange={patchPreferences}
                    onPreviewChange={previewPreferences}
                    onCommitPreview={commitPreferences}
                    onReset={resetAppearance}
                    density="full"
                    showPreview={false}
                  />
                </div>
              </div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Performance                                    */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="performance" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-emerald-600/20 to-teal-600/20 border border-emerald-500/20">
                  <Gauge className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.sections.performance')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.performanceDesc')}</p>
                </div>
              </div>

              {/* Toggle "Masquer le bandeau d'accueil" — déplacé d'Apparence
                  vers Performance car couper le hero supprime images lourdes,
                  rotation auto et fetchs TMDB en plus de l'animation. */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group mb-3"
              >
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                    <h4 className="font-medium text-white text-sm">{t('settings.hideHero')}</h4>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    {t('settings.hideHeroDesc')}
                  </p>
                </div>
                {renderToggle(heroHidden, handleHeroToggle)}
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.075 }}
                className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group mb-3"
              >
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Monitor className="w-3.5 h-3.5 text-cyan-400" />
                    <h4 className="font-medium text-white text-sm">{t('settings.hideStreamingPlatforms')}</h4>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    {t('settings.hideStreamingPlatformsDesc')}
                  </p>
                </div>
                {renderToggle(streamingPlatformsHidden, handleStreamingPlatformsToggle)}
              </motion.div>

              {/* Streaming basse latence (LL-HLS) — opt-in, un toggle par lecteur. */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.075 }}
                className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 mb-3"
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  <h4 className="font-medium text-white text-sm">{t('settings.lowLatency')}</h4>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  {t('settings.lowLatencyDesc')}
                </p>

                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-100/80 leading-relaxed">
                    {t('settings.lowLatencyWarning')}
                  </p>
                </div>

                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/40">
                    <span className="font-medium text-white text-xs">{t('settings.lowLatencyMovies')}</span>
                    {renderToggle(lowLatencyMovies, () => handleLowLatencyToggle('movies'), 'green')}
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/40">
                    <span className="font-medium text-white text-xs">{t('settings.lowLatencyLiveTv')}</span>
                    {renderToggle(lowLatencyLiveTv, () => handleLowLatencyToggle('livetv'), 'green')}
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors"
              >
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <h4 className="font-medium text-white text-sm">{t('settings.lightMode')}</h4>
                      {lightModeSetting === 'auto' && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                          {isLightMode ? t('settings.lightModeAutoOn') : t('settings.lightModeAutoOff')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.lightModeDesc')}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {([
                      { id: 'auto', labelKey: 'settings.lightModeAuto', descKey: 'settings.lightModeAutoDesc', fallbackLabel: 'Auto',      fallbackDesc: 'Détecte automatiquement' },
                      { id: 'on',   labelKey: 'settings.lightModeOn',   descKey: 'settings.lightModeOnDesc',   fallbackLabel: 'Activé',    fallbackDesc: 'Toujours actif' },
                      { id: 'off',  labelKey: 'settings.lightModeOff',  descKey: 'settings.lightModeOffDesc',  fallbackLabel: 'Désactivé', fallbackDesc: 'Tous les effets' },
                    ] as const).map((opt) => {
                      const active = lightModeSetting === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setLightModeSetting(opt.id)}
                          className={`flex-1 min-w-[100px] p-3 rounded-xl text-left transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                            active
                              ? 'bg-emerald-600/10 border-emerald-500/30 text-white'
                              : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                          }`}
                        >
                          <div className="text-xs font-semibold">{t(opt.labelKey, opt.fallbackLabel)}</div>
                          <div className="text-[10px] text-gray-500 mt-0.5">{t(opt.descKey, opt.fallbackDesc)}</div>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-gray-600 leading-relaxed">
                    {t('settings.lightModeAutoHint')}
                  </p>
                </div>
              </motion.div>

              {/* Réglages granulaires d'animations.
                  Chaque toggle pose son propre attribut `data-no-*` sur <html>
                  via LightModeContext. Quand Mode léger est actif, toutes les
                  catégories sont forcées "désactivées" (effectivePrefs), mais
                  l'état persistant `prefs` est conservé → quand l'utilisateur
                  coupe Mode léger, il retrouve ses choix granulaires. */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="mt-3 p-4 bg-gray-800/20 rounded-xl border border-gray-700/30"
              >
                <div className="mb-3">
                  <h4 className="text-sm font-medium text-white mb-0.5">
                    {t('settings.animPrefsTitle')}
                  </h4>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    {isLightMode
                      ? t('settings.animPrefsHintLightModeOn')
                      : t('settings.animPrefsHint')}
                  </p>
                </div>

                <div className="space-y-2">
                  {([
                    { key: 'bgAnimations',      titleKey: 'settings.animBgTitle',       descKey: 'settings.animBgDesc' },
                    { key: 'loadingAnimations', titleKey: 'settings.animLoadingTitle',  descKey: 'settings.animLoadingDesc' },
                    { key: 'carouselAutoplay',  titleKey: 'settings.animCarouselTitle', descKey: 'settings.animCarouselDesc' },
                    { key: 'blurEffects',       titleKey: 'settings.animBlurTitle',     descKey: 'settings.animBlurDesc' },
                    { key: 'transitions',       titleKey: 'settings.animTransTitle',    descKey: 'settings.animTransDesc' },
                  ] as const).map((row) => {
                    const isOn = animEffectivePrefs[row.key];
                    const userOn = animPrefs[row.key];
                    const forcedByLightMode = isLightMode && !animEffectivePrefs[row.key];
                    return (
                      <div
                        key={row.key}
                        className={`flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/40 transition-colors ${
                          forcedByLightMode ? 'opacity-60' : 'hover:border-gray-600/50'
                        }`}
                      >
                        <div className="flex-1 mr-3 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span className="font-medium text-white text-xs">{t(row.titleKey)}</span>
                            {forcedByLightMode && (
                              <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300/80 border border-emerald-500/20">
                                {t('settings.animForcedByLightMode')}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 leading-relaxed">{t(row.descKey)}</p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isOn}
                          disabled={forcedByLightMode}
                          onClick={() => setAnimPref(row.key, !userOn)}
                          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                            isOn ? 'bg-emerald-500' : 'bg-gray-600'
                          } ${forcedByLightMode ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                          aria-label={t(row.titleKey)}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                              isOn ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Langue                                         */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="language" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-sky-600/20 to-blue-600/20 border border-sky-500/20">
                  <Globe className="w-5 h-5 text-sky-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.language')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.languageDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {AVAILABLE_LANGUAGES.map((lang) => {
                    const isActive = i18n.language === lang.code;
                    return (
                      <button
                        key={lang.code}
                        onClick={() => changeLanguage(lang.code as SupportedLanguage)}
                        className={`flex items-center gap-4 p-4 rounded-xl border transition-colors ${
                          isActive
                            ? 'bg-sky-600/15 border-sky-500/30 text-white shadow-sm shadow-sky-600/5'
                            : 'bg-gray-800/30 border-gray-700/40 text-gray-400 hover:bg-gray-800/50 hover:border-gray-600/50 hover:text-white'
                        }`}
                      >
                        <span className="text-2xl"><img src={lang.flagUrl} alt={lang.label} className="w-8 h-6 rounded-sm object-cover" /></span>
                        <div className="text-left">
                          <div className={`text-sm font-medium ${isActive ? 'text-sky-300' : 'text-white'}`}>{lang.label}</div>
                          <div className="text-xs text-gray-500">{lang.code.toUpperCase()}</div>
                        </div>
                        {isActive && (
                          <div className="ml-auto w-2 h-2 rounded-full bg-sky-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: VIP                                            */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="vip" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-yellow-600/20 to-amber-600/20 border border-yellow-500/20">
                  <Crown className="w-5 h-5 text-yellow-400" />
                </div>
                <div>
            <h2 className="text-xl font-semibold text-white">{t('vip.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.vipDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-gray-800/30 rounded-xl border border-gray-700/40 p-6"
              >
                {!vipStatus.isVip ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 p-4 bg-yellow-500/5 rounded-xl border border-yellow-500/10">
                      <Key className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-medium text-yellow-300">{t('settings.activateVipKey')}</h4>
                        <p className="text-xs text-gray-400 mt-1">{t('settings.activateVipKeyDesc')}</p>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row gap-3">
                      <input
                        className="flex h-11 w-full rounded-lg pr-3 pl-4 py-2 text-sm bg-gray-900/60 border border-gray-700/50 focus:border-yellow-500/50 focus:bg-gray-900/80 text-white placeholder:text-gray-600 outline-none transition-colors"
                        placeholder={t('settings.enterVipKey')}
                        value={premiumKey}
                        onChange={(e) => setPremiumKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleActivatePremiumKey()}
                      />
                      <button
                        className={`flex items-center justify-center font-medium h-11 text-sm px-6 rounded-lg bg-yellow-500 text-black hover:bg-yellow-400 transition-colors whitespace-nowrap flex-shrink-0 ${!premiumKey.trim() || isActivatingKey ? 'opacity-30 pointer-events-none' : ''
                          }`}
                        onClick={handleActivatePremiumKey}
                        disabled={!premiumKey.trim() || isActivatingKey}
                      >
                        {isActivatingKey ? t('settings.activating') : t('settings.activate')}
                      </button>
                    </div>
                    {vipKeyError && (
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-red-400 text-xs bg-red-500/10 p-3 rounded-lg border border-red-500/20"
                      >
                        {vipKeyError}
                      </motion.p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 p-4 bg-yellow-500/10 rounded-xl border border-yellow-500/20">
                      <Crown className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-semibold text-yellow-300">{t('settings.youAreVip')}</h4>
                        <p className="text-xs text-gray-400 mt-0.5">{t('settings.vipDescription')}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40">
                      <CalendarClock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                      <div>
                        <span className="text-xs text-gray-500">{t('settings.vipExpiresOn')}</span>
                        <p className="text-sm text-white font-medium">
                          {vipStatus.expiresAt
                            ? (() => {
                                const d = new Date(isNaN(Number(vipStatus.expiresAt)) ? vipStatus.expiresAt : Number(vipStatus.expiresAt));
                                return isNaN(d.getTime()) ? t('settings.vipNoExpiration') : d.toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' });
                              })()
                            : t('settings.vipNoExpiration')
                          }
                        </p>
                      </div>
                    </div>

                    <div
                      className="flex flex-col gap-2 border border-gray-700/40 rounded-xl px-4 pt-4 pb-3 cursor-pointer hover:border-gray-600/50 transition-colors"
                      onMouseEnter={() => setIsVipKeyHovered(true)}
                      onMouseLeave={() => setIsVipKeyHovered(false)}
                    >
                      <span className="text-xs text-gray-500">{t('settings.yourVipKey')}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-mono transition-opacity duration-200" style={{ opacity: isVipKeyHovered ? 0 : 1, display: isVipKeyHovered ? 'none' : 'block' }}>
                          {localStorage.getItem('access_code')?.replace(/./g, '•') || '••••••••••••'}
                        </span>
                        <span className="text-white text-sm font-mono transition-opacity duration-200" style={{ opacity: isVipKeyHovered ? 1 : 0, display: isVipKeyHovered ? 'block' : 'none' }}>
                          {localStorage.getItem('access_code') || ''}
                        </span>
                        <button onClick={copyPremiumKey} className="ml-auto p-1.5 rounded-lg hover:bg-gray-700/50 text-gray-500 hover:text-white transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <button
                      className="text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 px-4 py-2 rounded-lg transition-colors"
                      onClick={handleRemovePremiumKey}
                    >
                      {t('settings.removeVipKey')}
                    </button>
                  </div>
                )}
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Sessions                                       */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="sessions" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-green-600/20 to-emerald-600/20 border border-green-500/20">
                  <Monitor className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.activeSessions')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.sessionsDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                {(() => {
                  const userInfo = getUserInfo();
                  if (!isAuthenticated || !userInfo || !['oauth', 'bip39'].includes(userInfo.type)) {
                    return (
                      <div className="text-center py-12 bg-gray-800/20 rounded-xl border border-gray-700/30">
                        <div className="p-3 bg-gray-800/50 rounded-full w-14 h-14 mx-auto mb-4 flex items-center justify-center">
                          <Lock className="w-6 h-6 text-gray-500" />
                        </div>
                        <h3 className="text-sm font-medium text-gray-400 mb-1">{t('settings.sessionsNotAvailable')}</h3>
                        <p className="text-xs text-gray-600 max-w-sm mx-auto">
                          {t('settings.sessionsNotAvailableDesc')}
                        </p>
                      </div>
                    );
                  }

                  if (sessions.length === 0) {
                    return (
                      <div className="text-center py-12 bg-gray-800/20 rounded-xl border border-gray-700/30">
                        <div className="p-3 bg-gray-800/50 rounded-full w-14 h-14 mx-auto mb-4 flex items-center justify-center">
                          <Monitor className="w-6 h-6 text-gray-500" />
                        </div>
                        <h3 className="text-sm font-medium text-gray-400 mb-1">{t('settings.noActiveSessions')}</h3>
                        <p className="text-xs text-gray-600">{t('settings.noActiveSessionsDesc')}</p>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      <AnimatePresence>
                        {sessions.map((session) => {
                          const isCurrentSession = session.id === currentSessionId;
                          const deviceInfo = normalizeSessionDeviceInfo(session.deviceInfo);
                          const deviceDetails = [
                            deviceInfo.operatingSystem,
                            t(`settings.sessionDeviceTypes.${deviceInfo.deviceType}`),
                          ].filter(Boolean).join(' · ');
                          return (
                            <motion.div
                              key={session.id}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className={`bg-gray-800/30 rounded-xl p-4 border transition-colors ${isCurrentSession
                                ? 'border-green-500/30 bg-green-900/10'
                                : 'border-gray-700/40 hover:border-gray-600/50'
                                }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-4">
                                  <div className={`p-2.5 rounded-xl ${isCurrentSession ? 'bg-green-500/15 text-green-400' : 'bg-gray-700/40 text-gray-400'}`}>
                                    {getDeviceIcon(deviceInfo.deviceType)}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <h4 className="font-medium text-white text-sm">
                                        {getSessionBrowserLabel(deviceInfo, t('common.unknown'))}
                                      </h4>
                                      {isCurrentSession && (
                                        <span className="px-2 py-0.5 text-[10px] bg-green-500/15 text-green-400 rounded-full font-medium">
                                          {t('settings.currentSession')}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                                      <p>{deviceDetails}</p>
                                      <p>{t('settings.createdOn')} {new Date(session.createdAt).toLocaleDateString(i18n.language)} {t('common.at')} {new Date(session.createdAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</p>
                                      <p>{t('settings.lastActivity')}: {formatDate(session.accessedAt)}</p>
                                    </div>
                                  </div>
                                </div>
                                {!isCurrentSession && (
                                  <motion.button
                                    onClick={() => deleteSession(session.id)}
                                    className="p-2 hover:bg-red-500/15 rounded-lg transition-colors text-gray-500 hover:text-red-400"
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    title={t('auth.disconnectSession')}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </motion.button>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  );
                })()}
              </motion.div>
            </section>
            )}

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Confidentialité                                */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="accounts" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-600/20 to-blue-600/20 border border-indigo-500/20">
                  <Link2 className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.linkedAccountsTitle', 'Comptes liés')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.linkedAccountsDesc', 'Choisissez quels moyens de connexion doivent ouvrir ce compte Movix.')}</p>
                </div>
              </div>

              {(() => {
                const account = getResolvedAccountContext();
                const currentAccountProvider = linkedAccountsMeta.accountProvider || account.accountProvider;
                const accountProviderLabel = currentAccountProvider ? getProviderLabel(currentAccountProvider) : null;
                const authMethodLabel = currentAuthMethod ? getProviderLabel(currentAuthMethod) : null;

                if (!accountProviderLabel) return null;

                return (
                  <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3">
                    <p className="text-sm font-medium text-white">
                      {t('settings.linkedAccountsCurrentAccount', {
                        provider: accountProviderLabel,
                        defaultValue: `Compte actuel : ${accountProviderLabel}`,
                      })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-indigo-100/80">
                      {currentAuthMethod && currentAuthMethod !== currentAccountProvider
                        ? currentAuthMethodLinked
                          ? t('settings.linkedAccountsRedirectSummary', {
                            method: authMethodLabel,
                            provider: accountProviderLabel,
                            defaultValue: `Vous êtes connecté avec ${authMethodLabel}, mais Movix vous a redirigé vers ce compte ${accountProviderLabel}.`,
                          })
                          : t('settings.linkedAccountsSessionNoLongerLinkedSummary', {
                              method: authMethodLabel,
                              defaultValue: `Vous êtes connecté avec ${authMethodLabel} pour cette session, mais aucune redirection ${authMethodLabel} n'est active actuellement. Une prochaine connexion ${authMethodLabel} rouvrira son propre compte Movix.`,
                            })
                        : t('settings.linkedAccountsDirectSummary', {
                            provider: accountProviderLabel,
                            defaultValue: `Les connexions ${accountProviderLabel} arrivent déjà ici sans redirection.`,
                          })}
                    </p>
                  </div>
                );
              })()}

              {!canManageLinkedAccounts && currentManagementProvider && (
                <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <p className="text-xs leading-relaxed text-amber-100/90">
                    {t('settings.linkedAccountsManageHint', {
                      provider: getProviderLabel(currentManagementProvider),
                      defaultValue: `Pour modifier les liaisons de ce compte, reconnectez-vous avec ${getProviderLabel(currentManagementProvider)}.`,
                    })}
                  </p>
                </div>
              )}

              <div className="space-y-3">
                {(['discord', 'google', 'bip39'] as LinkProvider[]).map((provider, index) => {
                  const status = linkedAccounts[provider];
                  const providerLabel = getProviderLabel(provider);
                  const isCurrentMethod = currentAuthMethod === provider;
                  const isCurrentAccount = currentAccountProvider === provider;
                  const currentAuthLabel = currentAuthMethod ? getProviderLabel(currentAuthMethod) : providerLabel;
                  const isActionDisabled = isLoadingLinks || !canManageLinkedAccounts;
                  const accentClass =
                    provider === 'discord'
                      ? 'from-[#5865F2]/15 to-[#5865F2]/5 border-[#5865F2]/20'
                      : provider === 'google'
                        ? 'from-white/10 to-white/5 border-white/10'
                        : 'from-emerald-500/15 to-emerald-500/5 border-emerald-500/20';
                  const cardDescription = isCurrentAccount
                    ? isCurrentMethod
                      ? t('settings.linkedAccountsTargetDirectDescription', {
                          provider: providerLabel,
                          defaultValue: `C'est le compte Movix ${providerLabel} actuellement ouvert. Les connexions ${providerLabel} arrivent déjà ici sans redirection.`,
                        })
                      : t('settings.linkedAccountsTargetRedirectedDescription', {
                          provider: providerLabel,
                          method: currentAuthLabel,
                          defaultValue: `C'est le compte Movix ${providerLabel} actuellement ouvert. Vous êtes arrivé ici via ${currentAuthLabel}, car ce moyen est redirigé vers ce compte.`,
                        })
                    : status.linked
                      ? isCurrentMethod
                        ? t('settings.linkedAccountsCurrentMethodRedirectDescription', {
                            provider: providerLabel,
                            defaultValue: `Vous êtes connecté avec ${providerLabel}. Comme il est lié à ce compte, Movix vous a redirigé ici.`,
                          })
                        : t('settings.linkedAccountsLinkedDescription', {
                            provider: providerLabel,
                            defaultValue: `Quand vous vous connecterez avec ${providerLabel}, Movix vous redirigera vers ce compte.`,
                          })
                      : isCurrentMethod
                        ? t('settings.linkedAccountsCurrentMethodInactiveDescription', {
                            provider: providerLabel,
                            defaultValue: `Vous êtes connecté avec ${providerLabel} pour cette session, mais aucune redirection n'est active actuellement. Une prochaine connexion ${providerLabel} rouvrira son propre compte Movix.`,
                          })
                        : t('settings.linkedAccountsInactiveDescription', {
                          provider: providerLabel,
                          defaultValue: `Aucune redirection active. Vous pouvez lier ${providerLabel} à ce compte pour que les prochaines connexions arrivent ici.`,
                        });
                  const linkedProviderId = status.providerUserId
                    ? t('settings.linkedAccountsLinkedId', {
                        id: status.providerUserId,
                        defaultValue: `ID lié : ${status.providerUserId}`,
                      })
                    : null;

                  return (
                    <motion.div
                      key={provider}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * (index + 1) }}
                      className={`p-4 rounded-xl border bg-gradient-to-br ${accentClass}`}
                    >
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <h4 className="font-medium text-white text-sm">{providerLabel}</h4>
                            {isCurrentAccount && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/15 text-indigo-200 border border-indigo-500/20">
                                {t('settings.linkedAccountsTargetBadge', 'Compte actuel')}
                              </span>
                            )}
                            {status.linked && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-green-500/15 text-green-300 border border-green-500/20">
                                {t('settings.linkedAccountsActive', 'Redirection active')}
                              </span>
                            )}
                            {isCurrentMethod && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/20">
                                {t('settings.linkedAccountsCurrentMethod', 'Connexion actuelle')}
                              </span>
                            )}
                            {!isCurrentAccount && !status.linked && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-700/40 text-gray-400 border border-gray-700/50">
                                {t('settings.linkedAccountsInactive', 'Non lié')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 leading-relaxed">{cardDescription}</p>
                          {linkedProviderId && (
                            <p className="mt-2 break-all font-mono text-[11px] text-gray-500">
                              {linkedProviderId}
                            </p>
                          )}
                        </div>

                        {isCurrentAccount ? (
                          <div className="px-4 py-2.5 rounded-xl text-sm font-medium md:min-w-[180px] bg-gray-700/30 text-gray-500 border border-gray-700/40 text-center opacity-70">
                            {t('settings.linkedAccountsTargetButton', 'Compte actuel')}
                          </div>
                        ) : (
                        <button
                          onClick={() => openLinkModal(provider, status.linked ? 'unlink' : 'link')}
                          disabled={isActionDisabled}
                          className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-colors md:min-w-[180px] ${
                            status.linked
                              ? 'bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/15'
                              : 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 hover:bg-indigo-500/15'
                          } ${isActionDisabled ? 'opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
                        >
                          {status.linked
                            ? t('settings.unlinkAccountButton', 'Désactiver la redirection')
                            : t('settings.linkAccountButton', 'Lier à ce compte')}
                        </button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </section>
            )}

            {isAuthenticated && (
            <section id="privacy" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-blue-600/20 to-cyan-600/20 border border-blue-500/20">
                  <Shield className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.privacy')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.privacyDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <div className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors">
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Activity className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.analyticsCollection')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.analyticsCollectionDesc')}
                    </p>
                  </div>
                  {renderToggle(dataCollection, handleDataCollectionToggle, 'blue')}
                </div>

                <div className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors">
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <History className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.disableHistory')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.disableHistoryDesc')}
                    </p>
                  </div>
                  {renderToggle(historyDisabled, handleHistoryToggle, 'blue')}
                </div>

                {isAuthenticated && (
                  <div className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors">
                    <div className="flex-1 mr-4">
                      <div className="flex items-center gap-2 mb-0.5">
                        <BellOff className="w-3.5 h-3.5 text-blue-400" />
                        <h4 className="font-medium text-white text-sm">{t('settings.disableNotifications')}</h4>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.disableNotificationsDesc')}
                      </p>
                    </div>
                    {renderToggle(notificationsDisabled, handleNotificationsToggle, 'blue')}
                  </div>
                )}

                <div className={`flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 transition-colors ${!dataCollection ? 'opacity-50 pointer-events-none' : 'hover:border-gray-600/50'}`}>
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.personalizedRecommendations')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.personalizedRecommendationsDesc')}
                    </p>
                  </div>
                  {renderToggle(!recommendationsDisabled, handleRecommendationsToggle, 'blue')}
                </div>

              </motion.div>

              {/* Confirmation modal for disabling history */}
              <AnimatePresence>
                {showHistoryConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowHistoryConfirm(false)}
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, y: 20 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                          <AlertTriangle className="w-5 h-5 text-red-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-white">{t('settings.disableHistoryConfirmTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                        {t('settings.disableHistoryConfirmDesc')}
                      </p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowHistoryConfirm(false)}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableHistoryCancel')}
                        </button>
                        <button
                          onClick={confirmDisableHistory}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableHistoryConfirm')}
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Confirmation modal for disabling data collection */}
              <AnimatePresence>
                {showDataCollectionConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowDataCollectionConfirm(false)}
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, y: 20 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                          <AlertTriangle className="w-5 h-5 text-red-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-white">{t('settings.disableDataConfirmTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                        {t('settings.disableDataConfirmDesc')}
                      </p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowDataCollectionConfirm(false)}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableDataCancel')}
                        </button>
                        <button
                          onClick={confirmDisableDataCollection}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableDataConfirm')}
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
            )}

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Priorité des sources (Milestone 5)            */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="source-priority" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-600/20 to-violet-600/20 border border-indigo-500/20">
                  <ListOrdered className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.sourcePriority.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.sourcePriority.description')}</p>
                </div>
              </div>
              {/* M11 — Toggle "se souvenir du dernier lecteur choisi" */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center justify-between p-4 mb-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
              >
                <div className="flex-1 mr-4">
                  <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.sourcePriority.rememberLastPlayerTitle')}</h4>
                  <p className="text-xs text-gray-500 leading-relaxed">{t('settings.sourcePriority.rememberLastPlayerDesc')}</p>
                </div>
                {renderToggle(rememberLastPlayer, handleRememberLastPlayerToggle, 'indigo')}
              </motion.div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-5">
                <SourcePriorityPanel />
              </div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Popup pub                                      */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="intermission" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-amber-600/20 to-orange-600/20 border border-amber-500/20">
                  <Megaphone className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.adPopup.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.adPopup.description')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40"
              >
                <div className="mb-3">
                  <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.adPopup.modeTitle')}</h4>
                  <p className="text-xs text-gray-500 leading-relaxed">{t('settings.adPopup.modeDesc')}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {([
                    { id: 'normal',          labelKey: 'settings.adPopup.modes.normal.label',         descKey: 'settings.adPopup.modes.normal.desc' },
                    { id: 'auto',            labelKey: 'settings.adPopup.modes.auto.label',           descKey: 'settings.adPopup.modes.auto.desc' },
                    { id: 'click-anywhere',  labelKey: 'settings.adPopup.modes.clickAnywhere.label',  descKey: 'settings.adPopup.modes.clickAnywhere.desc' },
                  ] as const).map((opt) => {
                    const active = adPopupMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleAdPopupModeChange(opt.id)}
                        className={`flex-1 min-w-[140px] p-3 rounded-xl text-left transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 ${
                          active
                            ? 'bg-amber-600/10 border-amber-500/40 text-white'
                            : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                        }`}
                      >
                        <div className="text-xs font-semibold">{t(opt.labelKey)}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{t(opt.descKey)}</div>
                      </button>
                    );
                  })}
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="flex items-center justify-between p-4 mt-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-colors group"
              >
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2 mb-0.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    <h4 className="font-medium text-white text-sm">{t('settings.adPopup.adultTitle')}</h4>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{t('settings.adPopup.adultDesc')}</p>
                </div>
                {renderToggle(adultAds, handleAdultAdsToggle, 'red')}
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Extractions                                    */}
            {/* ════════════════════════════════════════════════════════ */}
            {/* M9 : data-settings-section="extractors" (en) alias of id=#extractions (fr)
                for the "Aller à Extracteurs" scroll from SourcePriorityPanel. */}
            <section id="extractions" data-settings-section="extractors" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-600/20 to-purple-600/20 border border-indigo-500/20">
                  <Zap className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.extractions.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.extractions.description')}</p>
                </div>
              </div>

              {!extensionPresent && (
                <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>{t('settings.extractions.extensionMissing')}</span>
                </div>
              )}

              {/* Méthode d'extraction (single select) */}
              <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="mb-3">
                  <h3 className="font-semibold text-white">{t('settings.extractions.method.title')}</h3>
                  <p className="text-xs text-gray-500 mt-1">{t('settings.extractions.method.description')}</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup">
                  {EXTRACTION_METHOD_KEYS.map((key) => {
                    const selected = extractionPrefs.method === key;
                    const available =
                      key === 'extension' ? !!(typeof window !== 'undefined' && window.hasMovixExtension) :
                      key === 'userscript' ? !!(typeof window !== 'undefined' && window.hasMovixUserscript) :
                      key === 'server' ? isUserVip() :
                      true;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => handleSetExtractionMethod(key)}
                        className={`text-left rounded-lg border p-3 transition-colors ${
                          selected
                            ? 'border-indigo-500 bg-indigo-500/15 ring-2 ring-indigo-500/40'
                            : 'border-white/10 bg-white/5 hover:bg-white/10'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`font-medium ${selected ? 'text-white' : 'text-gray-300'}`}>
                            {t(`settings.extractions.method.${key}`)}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
                              available ? 'bg-green-500/20 text-green-300' : 'bg-gray-500/20 text-gray-400'
                            }`}
                          >
                            {available ? t('settings.extractions.method.available') : t('settings.extractions.method.unavailable')}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          {t(`settings.extractions.method.${key}Desc`)}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* m3u8 extractors card */}
              <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="flex items-center justify-between mb-4">
                  <button
                    type="button"
                    onClick={() => setM3u8SectionExpanded((v) => !v)}
                    aria-expanded={m3u8SectionExpanded}
                    className="group flex items-center gap-2 -ml-1 px-1 py-0.5 rounded-md hover:bg-white/5 transition-colors"
                  >
                    <motion.span
                      animate={{ rotate: m3u8SectionExpanded ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="inline-flex"
                    >
                      <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors" />
                    </motion.span>
                    <h3 className="font-semibold text-white">{t('settings.extractions.m3u8.title')}</h3>
                    <span className="text-xs text-gray-500 font-normal ml-1">
                      ({M3U8_EXTRACTOR_KEYS.filter((k) => extractionPrefs.m3u8[k]).length}/{M3U8_EXTRACTOR_KEYS.length})
                    </span>
                  </button>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-400">{t('settings.extractions.m3u8.master')}</span>
                    {renderToggle(
                      M3U8_EXTRACTOR_KEYS.some((k) => extractionPrefs.m3u8[k]),
                      () => handleToggleAllM3u8(!M3U8_EXTRACTOR_KEYS.some((k) => extractionPrefs.m3u8[k])),
                      'indigo'
                    )}
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {m3u8SectionExpanded && (
                    <motion.div
                      key="m3u8-details"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="divide-y divide-white/5 border-t border-white/5 pt-1">
                        {M3U8_EXTRACTOR_KEYS.map((key) => {
                          const count = extractionSessionStats?.byType?.[key] ?? 0;
                          const cacheCount = cacheStats?.[key] ?? 0;
                          return (
                            <div key={key} className="flex items-center justify-between py-3">
                              <div>
                                <div className="font-medium text-white">{t(`settings.extractions.m3u8.${key}`)}</div>
                                {extensionPresent && (
                                  <div className="text-xs text-gray-500 mt-0.5">
                                    {t('settings.extractions.stats.sessionExtractionsOther', { count })}
                                    {cacheCount > 0 && ` · ${t('settings.extractions.cache.entriesOther', { count: cacheCount })}`}
                                  </div>
                                )}
                              </div>
                              {renderToggle(
                                extractionPrefs.m3u8[key],
                                () => handleToggleM3u8Extractor(key, !extractionPrefs.m3u8[key]),
                                'indigo'
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Live TV sources card */}
              <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="flex items-center justify-between mb-4">
                  <button
                    type="button"
                    onClick={() => setLivetvSectionExpanded((v) => !v)}
                    aria-expanded={livetvSectionExpanded}
                    className="group flex items-center gap-2 -ml-1 px-1 py-0.5 rounded-md hover:bg-white/5 transition-colors"
                  >
                    <motion.span
                      animate={{ rotate: livetvSectionExpanded ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="inline-flex"
                    >
                      <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors" />
                    </motion.span>
                    <h3 className="font-semibold text-white">{t('settings.extractions.livetv.title')}</h3>
                    <span className="text-xs text-gray-500 font-normal ml-1">
                      ({LIVETV_SOURCE_KEYS.filter((k) => extractionPrefs.livetv[k]).length}/{LIVETV_SOURCE_KEYS.length})
                    </span>
                  </button>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-400">{t('settings.extractions.livetv.master')}</span>
                    {renderToggle(
                      LIVETV_SOURCE_KEYS.some((k) => extractionPrefs.livetv[k]),
                      () => handleToggleAllLiveTv(!LIVETV_SOURCE_KEYS.some((k) => extractionPrefs.livetv[k])),
                      'indigo'
                    )}
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {livetvSectionExpanded && (
                    <motion.div
                      key="livetv-details"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="divide-y divide-white/5 border-t border-white/5 pt-1">
                        {LIVETV_SOURCE_KEYS.map((key) => (
                          <div key={key} className="flex items-center justify-between py-3">
                            <div className="font-medium text-white">{t(`settings.extractions.livetv.${key}`)}</div>
                            {renderToggle(
                              extractionPrefs.livetv[key],
                              () => handleToggleLiveTvSource(key, !extractionPrefs.livetv[key]),
                              'indigo'
                            )}
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Cache card (extracted to module-scope <ExtensionCacheStatsBlock /> — owns 10s poll) */}
              <ExtensionCacheStatsBlock extensionPresent={extensionPresent} />

              <button
                onClick={handleResetExtractions}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"
              >
                <RefreshCw className="w-4 h-4" /> {t('settings.extractions.reset')}
              </button>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Données                                        */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="data" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-orange-600/20 to-red-600/20 border border-orange-500/20">
                  <Database className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.data')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.dataDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <StorageMetricsBlock
                  serverSyncStats={serverSyncStats}
                  isLoadingServerSyncStats={isLoadingServerSyncStats}
                  selectedProfileId={selectedProfileId}
                  hasServerStorageContext={hasServerStorageContext}
                  serverQuotaUsagePercent={serverQuotaUsagePercent}
                />

                {/* Mon identifiant */}
                {isAuthenticated && canShowAccountId && (
                  <button
                    onClick={openIdPopup}
                    className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-colors text-left group"
                  >
                    <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                      <Eye className="w-4 h-4 text-gray-400" />
                    </div>
                    <div className="flex-1">
                      <h4 className="font-medium text-white text-sm">{t('settings.myId')}</h4>
                      <p className="text-xs text-gray-500">{t('settings.myIdDesc')}</p>
                    </div>
                    <Copy className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
                  </button>
                )}

                {/* Exporter données */}
                <button
                  onClick={copyLocalStorage}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-colors text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Download className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.exportData')}</h4>
                    <p className="text-xs text-gray-500">{t('settings.exportDataDesc')}</p>
                  </div>
                </button>

                {/* Importer données */}
                <button
                  onClick={openNonSyncablePopup}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-colors text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Lock className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.nonSyncableKeysTitle')}</h4>
                    <p className="text-xs text-gray-500">
                      {t('settings.nonSyncableKeysDesc', {
                        count: nonSyncableKeyCount,
                        size: formatStorageBytes(nonSyncableBytes),
                      })}
                    </p>
                  </div>
                </button>

                <button
                  onClick={() => setShowImportPopup(true)}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-colors text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Upload className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.importData')}</h4>
                    <p className="text-xs text-gray-500">{t('settings.importDataDesc')}</p>
                  </div>
                </button>
              </motion.div>
            </section>
            )}
          </div>
          </main>
        </div>
      </div>

      {/* ─── PORTALS: Popups ─────────────────────────────────────────── */}

      {linkModal && createPortal(
        <AnimatePresence mode="wait">
          {linkModal && !isClosingLinkModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) closeLinkModal(); }}
            >
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full border border-gray-800 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-start gap-4 mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">
                      {linkModal.action === 'link'
                        ? t('settings.linkedAccountsModalLinkTitle', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Lier ${getProviderLabel(linkModal.provider)} à ce compte ?`,
                          })
                        : t('settings.linkedAccountsModalUnlinkTitle', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Désactiver ${getProviderLabel(linkModal.provider)} pour ce compte ?`,
                          })}
                    </h3>
                    <p className="text-sm text-gray-400 mt-2 leading-relaxed">
                      {linkModal.action === 'link'
                        ? t('settings.linkedAccountsModalLinkDescription', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Quand vous vous connecterez avec ${getProviderLabel(linkModal.provider)}, Movix vous redirigera vers ce compte. Si vous désactivez plus tard cette liaison, ${getProviderLabel(linkModal.provider)} rouvrira son propre compte Movix.`,
                          })
                        : t('settings.linkedAccountsModalUnlinkDescription', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Si vous désactivez cette liaison, une future connexion avec ${getProviderLabel(linkModal.provider)} ne redirigera plus vers ce compte. Elle rouvrira le compte Movix propre à ${getProviderLabel(linkModal.provider)}.`,
                          })}
                    </p>
                  </div>
                  <button
                    onClick={closeLinkModal}
                    className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {linkActionError && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">
                    {linkActionError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closeLinkModal}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                    disabled={isSubmittingLinkAction}
                  >
                    {t('common.cancel', 'Annuler')}
                  </button>
                  <button
                    onClick={handleConfirmLinkAction}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                      linkModal.action === 'link'
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                        : 'bg-red-600 text-white hover:bg-red-500'
                    } ${isSubmittingLinkAction ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={isSubmittingLinkAction}
                  >
                    {isSubmittingLinkAction
                      ? t('settings.linkedAccountsSubmitting', 'Traitement...')
                      : linkModal.action === 'link'
                        ? t('settings.linkedAccountsConfirmLink', 'Confirmer la liaison')
                        : t('settings.linkedAccountsConfirmUnlink', 'Désactiver la liaison')}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* Reset Extractions Confirmation Popup */}
      {showResetExtractionsConfirm && createPortal(
        <AnimatePresence mode="wait">
          {showResetExtractionsConfirm && !isClosingResetExtractionsConfirm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseResetExtractionsConfirm(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-800 shadow-2xl"
                data-lenis-prevent
              >
                <div className="flex items-start gap-4 mb-5">
                  <div className="shrink-0 p-3 rounded-xl bg-gradient-to-br from-red-600/20 to-orange-600/20 border border-red-500/20">
                    <AlertTriangle className="w-6 h-6 text-red-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-bold text-white mb-1">
                      {t('settings.extractions.reset')}
                    </h3>
                    <p className="text-sm text-gray-400">
                      {t('settings.extractions.resetConfirm')}
                    </p>
                  </div>
                  <button
                    onClick={handleCloseResetExtractionsConfirm}
                    className="shrink-0 text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
                    aria-label={t('common.cancel')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center justify-end gap-2 pt-4 border-t border-white/5">
                  <button
                    onClick={handleCloseResetExtractionsConfirm}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleConfirmResetExtractions}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('common.confirm')}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* ID Popup */}
      {showIdPopup && createPortal(
        <AnimatePresence mode="wait">
          {showIdPopup && !isClosingIdPopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseIdPopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.accountId')}</h3>
                  <button onClick={handleCloseIdPopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <p className="text-sm text-gray-400 mb-4">{t('settings.accountIdNote')}</p>
                  <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                    {accountIdInfo?.provider && accountIdInfo.provider !== 'unknown' && (
                      <div className="text-xs text-gray-400 mb-1 capitalize">{t('settings.provider')}: {accountIdInfo.provider}</div>
                    )}
                    <div className="text-xs text-gray-400 mb-1">{t('admin.idLabel')}</div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm text-white break-all">{accountIdInfo?.id || ''}</span>
                      <button
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                        onClick={() => { if (accountIdInfo?.id) navigator.clipboard.writeText(accountIdInfo.id); }}
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {t('common.copy')}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseIdPopup}>
                      {t('common.understood')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* localStorage Popup */}
      {showLocalStoragePopup && createPortal(
        <AnimatePresence mode="wait">
          {showLocalStoragePopup && !isClosingLocalStoragePopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseLocalStoragePopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.localStorageData')}</h3>
                  <button onClick={handleCloseLocalStoragePopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4">
                    <p className="text-sm text-red-300 font-medium mb-2">{t('settings.sensitiveDataWarning')}</p>
                    <p className="text-sm text-red-200">{t('settings.sensitiveDataNote')}</p>
                  </div>
                  <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="text-xs text-gray-400">{t('settings.localStorageJson')}</div>
                      <button
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                        onClick={() => { if (localStorageData) navigator.clipboard.writeText(localStorageData); }}
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {t('settings.copyAll')}
                      </button>
                    </div>
                    <div
                      className="bg-gray-900/50 rounded-lg p-3 max-h-96 overflow-y-auto"
                      data-lenis-prevent
                      style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                    >
                      <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap break-all">{localStorageData}</pre>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseLocalStoragePopup}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {showNonSyncablePopup && createPortal(
        <AnimatePresence mode="wait">
          {showNonSyncablePopup && !isClosingNonSyncablePopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseNonSyncablePopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center gap-4 mb-6">
                  <div>
                    <h3 className="text-xl font-bold text-white">{t('settings.nonSyncableKeysTitle')}</h3>
                    <p className="mt-1 text-sm text-gray-400">
                      {t('settings.nonSyncableKeysPopupDesc', {
                        count: nonSyncableEntries.length,
                        size: formatStorageBytes(nonSyncableBytes),
                      })}
                    </p>
                  </div>
                  <button onClick={handleCloseNonSyncablePopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 mb-4">
                    <p className="text-sm text-amber-200 font-medium mb-2">{t('settings.nonSyncableKeysWhyTitle')}</p>
                    <p className="text-sm leading-relaxed text-amber-100/85">{t('settings.nonSyncableKeysWhyDesc')}</p>
                  </div>

                  {nonSyncableEntries.length === 0 ? (
                    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 text-sm text-gray-300">
                      {t('settings.nonSyncableKeysEmpty')}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-end">
                        <button
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                          onClick={copyNonSyncableKeys}
                        >
                          <Copy className="w-3.5 h-3.5" />
                          {t('settings.copyNonSyncableKeys')}
                        </button>
                      </div>

                      {nonSyncableEntries.map((entry) => (
                        <div
                          key={entry.key}
                          className="rounded-xl border border-gray-700 bg-gray-800/60 p-4"
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="font-mono text-sm text-white break-all">{entry.key}</p>
                              <p className="mt-1 text-xs text-gray-400">
                                {t(getNonSyncReasonTranslationKey(entry.reason))}
                              </p>
                            </div>
                            <p className="text-xs text-gray-500 sm:text-right">
                              {formatStorageBytes(entry.bytes)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseNonSyncablePopup}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}

      {/* Import Popup */}
      {showImportPopup && createPortal(
        <AnimatePresence mode="wait">
          {showImportPopup && !isClosingImportPopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseImportPopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.importDataTitle')}</h3>
                  <button onClick={handleCloseImportPopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-blue-900/30 border border-blue-500/50 rounded-lg p-4 mb-4">
                    <p className="text-sm text-blue-300 font-medium mb-2">{t('settings.importDataNote')}</p>
                    <p className="text-sm text-blue-200">{t('settings.importDataHint')}</p>
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">{t('settings.jsonToImport')}</label>
                    <textarea
                      value={importData}
                      onChange={(e) => setImportData(e.target.value)}
                      className="w-full h-64 bg-gray-800 border border-gray-700 rounded-lg p-4 text-white font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none outline-none"
                      placeholder='{"watched_tv_episodes": "...", "progress_14438": "..."}'
                    />
                  </div>
                  {importError && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4">
                      <p className="text-sm text-red-300">❌ {importError}</p>
                    </motion.div>
                  )}
                  {importSuccess && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-green-900/30 border border-green-500/50 rounded-lg p-4 mb-4">
                      <p className="text-sm text-green-300">✅ {importSuccess}</p>
                    </motion.div>
                  )}
                  <div className="flex justify-end gap-3">
                    <button className="px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-700 text-white transition-colors" onClick={handleCloseImportPopup}>
                      {t('common.cancel')}
                    </button>
                    <button
                      className={`px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors ${!importData.trim() ? 'opacity-30 pointer-events-none' : ''}`}
                      onClick={handleImportData}
                      disabled={!importData.trim()}
                    >
                      {t('settings.import')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot()
      )}
    </div>
  );
};

export default SettingsPage;
