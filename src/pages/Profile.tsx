
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { X, Camera, Info, Film, Heart, Eye, List, Trash2 as TrashIcon, Bell, BellRing, Clock, Edit3, Monitor, Smartphone, Tablet, Copy, Settings, Shield, Activity, Play, Snowflake, Share2, Link2, Loader2, Globe, GripVertical } from 'lucide-react';
import { Plus, Trash2, ArrowLeft, Calendar, Edit2, MoreVertical, Pencil } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../context/AuthContext';
import { useProfile } from '../context/ProfileContext';
import { broadcastAuthChange, clearStoredAuthSession, getResolvedAccountContext } from '../utils/accountAuth';
import { isUserVip } from '../utils/authUtils';
import NewListModal from '../components/NewListModal';
import AvatarSelector from '../components/AvatarSelector';
import FilterSystem, { type FilterItemType, type FilterOptions } from '../components/FilterSystem';
import CustomDropdown from '../components/CustomDropdown';
import { useOptimizedFilter } from '../hooks/useOptimizedFilter';
import AgeRestrictedMedia from '../components/AgeRestrictedMedia';

import { AlertService } from '../services/alertService';
import { EpisodeAlert, NotifyBeforeDays } from '../types/alerts';
import { encodeId } from '../utils/idEncoder';
import { getTmdbLanguage } from '../i18n';
import {
  getSessionBrowserLabel,
  normalizeSessionDeviceInfo,
  type SessionDeviceInfo,
  type SessionDeviceType,
} from '../utils/sessionDevice';
import {
  SHARED_LIST_FAVORITES_STORAGE_KEY,
  readSharedListFavorites,
  type SharedListFavorite,
} from '../utils/sharedListFavorites';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';
import { useTurnstileBypass } from '@/hooks/useTurnstileBypass';
import { ADMIN_BYPASS_TOKEN } from '@/utils/turnstileBypass';

// Get API URL from environment variable
const API_URL = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const TMDB_POSTER_BASE_URL = 'https://image.tmdb.org/t/p/w500';
const LIVE_TV_FAVORITES_STORAGE_KEY = 'live_tv_favorite_channels';
const LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY = 'live_tv_favorite_iptv_categories';

// Track shows for which we've already fetched metadata
const metadataCache = new Map();

type ProfileMediaItemType = 'movie' | 'tv' | 'collection';
type ProfileExtraFavoriteType = 'shared-list' | 'live-tv';
type ProfileItemType = ProfileMediaItemType | ProfileExtraFavoriteType;

interface WatchItem {
  id: number | string;
  type: ProfileItemType;
  title: string;
  name?: string; // Pour les collections qui utilisent 'name' au lieu de 'title'
  poster_path: string;
  searchText?: string;
  episodeInfo?: {
    season: number;
    episode: number;
  };
  addedAt: string;
  // Propriétés spécifiques aux collections
  backdrop_path?: string | null;
  overview?: string;
  shareCode?: string;
  username?: string;
  itemCount?: number;
  isVip?: boolean;
  source?: string;
  liveTvKind?: 'channel' | 'iptv';
  liveTvTargetId?: string;
  liveTvCatalogId?: string;
  liveTvCategoryId?: string;
}

interface UserProfile {
  username: string;
  avatar: string;
  vipExpiresAt?: string;
}

interface CustomList {
  id: number;
  name: string;
  items: {
    id: number;
    type: 'movie' | 'tv' | 'collection';
    title: string;
    name?: string; // Pour les collections qui utilisent 'name' au lieu de 'title'
    poster_path: string;
    addedAt: string;
    // Propriétés spécifiques aux collections
    backdrop_path?: string | null;
    overview?: string;
  }[];
}



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

interface DragHandleProps {
  ref: (node: HTMLElement | null) => void;
  listeners: Record<string, Function> | undefined;
  attributes: Record<string, any>;
}

interface LiveTVFavorite {
  key: string;
  source: string;
  id: string;
  name: string;
  poster?: string | null;
  addedAt: string;
  kind: 'channel' | 'iptv';
  catalogId?: string;
  categoryId?: string;
}

const PROFILE_IMPORT_PRESERVED_ARRAY_KEYS = new Set([
  SHARED_LIST_FAVORITES_STORAGE_KEY,
  LIVE_TV_FAVORITES_STORAGE_KEY,
  LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY,
]);

const readStoredArray = <T,>(key: string): T[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

// Bulk-read the localStorage keys backing the watchlist/favorites/watched lists
// in one pass. Avoids repeated JSON.parse hits when several lists are loaded
// back-to-back (e.g. profile mount: watchlist + favorites + watched).
const readWatchlistFamily = () => {
  const safeArray = <T,>(key: string): T[] => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    watchlist_movie: safeArray<WatchItem>('watchlist_movie'),
    watchlist_tv: safeArray<WatchItem>('watchlist_tv'),
    watchlist_collections: safeArray<WatchItem>('watchlist_collections'),
    watchlist_tv_episodes: safeArray<WatchItem>('watchlist_tv_episodes'),
    favorite_movie: safeArray<WatchItem>('favorite_movie'),
    favorites_tv: safeArray<WatchItem>('favorites_tv'),
    favorite_collections: safeArray<WatchItem>('favorite_collections'),
    watched_movie: safeArray<WatchItem>('watched_movie'),
    watched_tv: safeArray<WatchItem>('watched_tv'),
    watched_collections: safeArray<WatchItem>('watched_collections'),
    watched_tv_episodes: safeArray<WatchItem>('watched_tv_episodes'),
  };
};

const isLiveTVFavorite = (value: unknown): value is LiveTVFavorite => {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<LiveTVFavorite>;
  return (
    typeof candidate.key === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.addedAt === 'string' &&
    (candidate.kind === 'channel' || candidate.kind === 'iptv')
  );
};

const readLiveTvFavorites = (): LiveTVFavorite[] => {
  return readStoredArray<unknown>(LIVE_TV_FAVORITES_STORAGE_KEY).filter(isLiveTVFavorite);
};

const isTmdbWatchItem = (item: WatchItem): item is WatchItem & { id: number; type: ProfileMediaItemType } => {
  return (
    typeof item.id === 'number' &&
    (item.type === 'movie' || item.type === 'tv' || item.type === 'collection')
  );
};

const isTvWatchItem = (item: WatchItem): item is WatchItem & { id: number; type: 'tv' } => {
  return typeof item.id === 'number' && item.type === 'tv';
};

const getWatchItemKey = (item: Pick<WatchItem, 'id' | 'type'>) => `${item.type}-${String(item.id)}`;

const resolveWatchItemPosterSrc = (item: Pick<WatchItem, 'poster_path'>) => {
  if (!item.poster_path) return '';
  if (/^https?:\/\//i.test(item.poster_path)) {
    return item.poster_path;
  }
  return `${TMDB_POSTER_BASE_URL}${item.poster_path}`;
};

function SortableListCard({ id, children }: { id: string; children: React.ReactNode | ((handleProps: DragHandleProps) => React.ReactNode) }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {typeof children === 'function'
        ? children({ ref: setActivatorNodeRef, listeners, attributes })
        : children}
    </div>
  );
}

function SortableMediaItem({ id, children }: { id: string; children: React.ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="absolute bottom-2 right-2 z-30 p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      >
        <GripVertical className="w-4 h-4 text-white opacity-70" />
      </div>
      {children}
    </div>
  );
}

const Profile: React.FC = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentProfile: activeProfile, updateProfile: updateActiveProfile } = useProfile();
  const [activeTab, setActiveTab] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get('tab') || 'watchlist';
  });
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [favorites, setFavorites] = useState<WatchItem[]>([]);
  const [watched, setWatched] = useState<WatchItem[]>([]);
  const [customLists, setCustomLists] = useState<CustomList[]>([]);
  const [showNewListModal, setShowNewListModal] = useState(false);
  const [selectedList, setSelectedList] = useState<CustomList | null>(null);
  const [renamingListId, setRenamingListId] = useState<number | null>(null);
  const [renamingListName, setRenamingListName] = useState('');
  const [activeListDragId, setActiveListDragId] = useState<string | null>(null);
  const [activeItemDragId, setActiveItemDragId] = useState<string | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<any>(null);
  const [collectionMovies, setCollectionMovies] = useState<any[]>([]);
  const [loadingCollectionMovies, setLoadingCollectionMovies] = useState(false);
  const [selectedListCollections, setSelectedListCollections] = useState<any[]>([]);
  const [loadingListCollections, setLoadingListCollections] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile>({
    username: '',
    avatar: ''
  });
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [showIdPopup, setShowIdPopup] = useState(false);
  const [isClosingIdPopup, setIsClosingIdPopup] = useState(false);
  const [accountIdInfo, setAccountIdInfo] = useState<{ id: string; provider: 'discord' | 'google' | 'bip39' | 'oauth' | 'unknown' } | null>(null);
  const [showLocalStoragePopup, setShowLocalStoragePopup] = useState(false);
  const [isClosingLocalStoragePopup, setIsClosingLocalStoragePopup] = useState(false);
  const [localStorageData, setLocalStorageData] = useState<string>('');
  const [showImportPopup, setShowImportPopup] = useState(false);
  const [isClosingImportPopup, setIsClosingImportPopup] = useState(false);
  const [importData, setImportData] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [isVipKeyHovered, setIsVipKeyHovered] = useState(false);


  const [vipStatus, setVipStatus] = useState<VipStatus>({
    isVip: false,
    features: []
  });

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [expandedTvShowId, setExpandedTvShowId] = useState<number | null>(null);
  const [detailedTvShowEpisodes, setDetailedTvShowEpisodes] = useState<{ watched: Record<string, boolean>, watchlist: Record<string, boolean>, isFullSeriesWatched: boolean, isFullSeriesInWatchlist: boolean } | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(new Set());
  const [alerts, setAlerts] = useState<EpisodeAlert[]>([]);
  const [editingAlert, setEditingAlert] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<NotifyBeforeDays>(1);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [premiumKey, setPremiumKey] = useState('');
  const [vipKeyError, setVipKeyError] = useState<string | null>(null);
  const [isActivatingKey, setIsActivatingKey] = useState(false);
  const { checkAccessCode, error: authError, lastAttempt } = useAuth();

  // === Shared Lists ===
  const [sharedListsStatus, setSharedListsStatus] = useState<Record<string, { shareCode: string; sharedAt: number; isPublicInCatalog: boolean }>>({});
  const [sharingListId, setSharingListId] = useState<number | null>(null);

  // Turnstile managed (pour le partage de listes)
  const [shareTurnstileToken, setShareTurnstileToken] = useState('');
  const shareTurnstileRef = useRef<HTMLDivElement>(null);
  const shareTurnstileWidgetId = useRef<string | null>(null);
  // Dispense admin : pas de challenge du tout. Voir `utils/turnstileBypass.ts`.
  const shareTurnstileBypass = useTurnstileBypass();

  // Paramètres utilisateur
  const [disableAutoScroll, setDisableAutoScroll] = useState(() => {
    return localStorage.getItem('settings_disable_auto_scroll') === 'true';
  });

  // State for Smooth Scroll (enabled by default)
  const [smoothScrollEnabled, setSmoothScrollEnabled] = useState(() => {
    return localStorage.getItem('settings_smooth_scroll') !== 'false';
  });

  // State for Snowfall
  const [isSnowfallActive, setIsSnowfallActive] = useState(() => {
    return sessionStorage.getItem('snowfall_active') === 'true';
  });

  // Screensaver settings
  const [screensaverEnabled, setScreensaverEnabled] = useState(() => {
    return localStorage.getItem('screensaver_enabled') === 'true';
  });
  const [screensaverTimeout, setScreensaverTimeout] = useState(() => {
    return parseInt(localStorage.getItem('screensaver_timeout') || '60', 10);
  });
  const [screensaverMode, setScreensaverMode] = useState(() => {
    return localStorage.getItem('screensaver_mode') || 'backdrop';
  });

  // Privacy Settings States
  const [dataCollection, setDataCollection] = useState(() => {
    return localStorage.getItem('privacy_data_collection') !== 'false'; // Default true
  });

  // Hooks de filtrage optimisés pour chaque liste
  const watchlistFilter = useOptimizedFilter({ items: watchlist });
  const favoritesFilter = useOptimizedFilter({ items: favorites });
  const watchedFilter = useOptimizedFilter({ items: watched });

  // Sync newUsername with active profile name
  useEffect(() => {
    if (activeProfile?.name && !isEditingUsername) {
      setNewUsername(activeProfile.name);
    }
  }, [activeProfile?.name]);

  // État pour les séries en cours de visionnage
  const [inProgress, setInProgress] = useState<WatchItem[]>([]);
  const [loadingInProgress, setLoadingInProgress] = useState(false);
  const [inProgressCount, setInProgressCount] = useState(0);
  const inProgressFilter = useOptimizedFilter({ items: inProgress });

  const handleMainFiltersChange = useCallback((filters: FilterOptions) => {
    if (activeTab === 'watchlist') {
      watchlistFilter.updateFilters(filters);
    } else if (activeTab === 'favorites') {
      favoritesFilter.updateFilters(filters);
    } else if (activeTab === 'watched') {
      watchedFilter.updateFilters(filters);
    } else if (activeTab === 'in-progress') {
      inProgressFilter.updateFilters(filters);
    }
  }, [
    activeTab,
    watchlistFilter.updateFilters,
    favoritesFilter.updateFilters,
    watchedFilter.updateFilters,
    inProgressFilter.updateFilters
  ]);

  const totalItemsForActiveTab = useMemo(() => {
    if (activeTab === 'watchlist') return watchlist.length;
    if (activeTab === 'favorites') return favorites.length;
    if (activeTab === 'watched') return watched.length;
    return inProgress.length;
  }, [activeTab, watchlist.length, favorites.length, watched.length, inProgress.length]);

  const filteredItemsForActiveTab = useMemo(() => {
    if (activeTab === 'watchlist') return watchlistFilter.stats.filtered;
    if (activeTab === 'favorites') return favoritesFilter.stats.filtered;
    if (activeTab === 'watched') return watchedFilter.stats.filtered;
    return inProgressFilter.stats.filtered;
  }, [
    activeTab,
    watchlistFilter.stats.filtered,
    favoritesFilter.stats.filtered,
    watchedFilter.stats.filtered,
    inProgressFilter.stats.filtered
  ]);

  const isSortingForActiveTab = useMemo(() => {
    if (activeTab === 'watchlist') return watchlistFilter.isSorting;
    if (activeTab === 'favorites') return favoritesFilter.isSorting;
    if (activeTab === 'watched') return watchedFilter.isSorting;
    return inProgressFilter.isSorting;
  }, [
    activeTab,
    watchlistFilter.isSorting,
    favoritesFilter.isSorting,
    watchedFilter.isSorting,
    inProgressFilter.isSorting
  ]);

  const availableTypeFiltersForActiveTab = useMemo<FilterItemType[]>(() => {
    const sourceItems =
      activeTab === 'watchlist' ? watchlist :
      activeTab === 'favorites' ? favorites :
      activeTab === 'watched' ? watched :
      activeTab === 'in-progress' ? inProgress :
      [];

    const orderedTypes: FilterItemType[] = ['all', 'movie', 'tv', 'collection', 'shared-list', 'live-tv'];
    return orderedTypes.filter((type) => type === 'all' || sourceItems.some((item) => item.type === type));
  }, [activeTab, watchlist, favorites, watched, inProgress]);

  // Lock body scroll when account ID popup is open
  useEffect(() => {
    if (!showIdPopup) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [showIdPopup]);

  // Lock body scroll when localStorage popup is open
  useEffect(() => {
    if (!showLocalStoragePopup) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [showLocalStoragePopup]);

  // Lock body scroll when import popup is open
  useEffect(() => {
    if (!showImportPopup) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [showImportPopup]);

  // Removed: sync-to-server logic for profile changes

  useEffect(() => {
    const checkAuth = () => {
      const authStr = localStorage.getItem('auth');
      const discordAuth = localStorage.getItem('discord_auth') === 'true';
      const googleAuth = localStorage.getItem('google_auth') === 'true';
      const bip39Auth = localStorage.getItem('bip39_auth') === 'true';

      let found = false;

      const processAuth = (authData: any) => {
        if (authData && authData.userProfile) {
          setIsAuthenticated(true);
          setUserProfile(authData.userProfile);
          found = true;
        }
      };

      // Check for BIP39 and access_code auth first
      if (authStr) {
        try {
          const auth = JSON.parse(authStr);
          const provider = auth.userProfile?.provider;

          if ((provider === 'bip39' && bip39Auth) || provider === 'access_code') {
            processAuth(auth);
          }
        } catch (error) {
          console.error('Erreur lors de la vérification de l\'authentification:', error);
        }
      }

      // Check for Discord auth - prioritize auth object if it exists and has Discord data
      if (!found && discordAuth) {
        let discordProfile = null;

        // First check if auth object has Discord profile data
        if (authStr) {
          try {
            const auth = JSON.parse(authStr);
            if (auth.userProfile && !auth.userProfile.provider) {
              // This might be a Discord profile stored in auth object
              const discordUserRaw = localStorage.getItem('discord_user');
              if (discordUserRaw) {
                const discordUser = JSON.parse(discordUserRaw);
                // Verify this auth profile corresponds to the Discord user
                if (discordUser.id && auth.userProfile.username) {
                  discordProfile = auth.userProfile;
                }
              }
            }
          } catch (error) {
            console.error('Erreur lors de la vérification de l\'auth Discord:', error);
          }
        }

        // If no profile from auth object, use discord_user directly
        if (!discordProfile) {
          const discordUserRaw = localStorage.getItem('discord_user');
          if (discordUserRaw) {
            try {
              const discordUser = JSON.parse(discordUserRaw);
              discordProfile = {
                username: discordUser.username,
                avatar: discordUser.avatar
              };
            } catch (error) {
              setIsAuthenticated(false);
              return;
            }
          }
        }

        if (discordProfile) {
          setIsAuthenticated(true);
          setUserProfile(discordProfile);
          found = true;
        }
      }

      // Check for Google auth - prioritize auth object if it exists and has Google data
      if (!found && googleAuth) {
        let googleProfile = null;

        // First check if auth object has Google profile data
        if (authStr) {
          try {
            const auth = JSON.parse(authStr);
            if (auth.userProfile && !auth.userProfile.provider) {
              // This might be a Google profile stored in auth object
              const googleUserRaw = localStorage.getItem('google_user');
              if (googleUserRaw) {
                const googleUser = JSON.parse(googleUserRaw);
                // Verify this auth profile corresponds to the Google user
                if (googleUser.id && auth.userProfile.username) {
                  googleProfile = auth.userProfile;
                }
              }
            }
          } catch (error) {
            console.error('Erreur lors de la vérification de l\'auth Google:', error);
          }
        }

        // If no profile from auth object, use google_user directly
        if (!googleProfile) {
          const googleUserRaw = localStorage.getItem('google_user');
          if (googleUserRaw) {
            try {
              const googleUser = JSON.parse(googleUserRaw);
              googleProfile = {
                username: googleUser.name,
                avatar: googleUser.picture
              };
            } catch (error) {
              setIsAuthenticated(false);
              return;
            }
          }
        }

        if (googleProfile) {
          setIsAuthenticated(true);
          setUserProfile(googleProfile);
          found = true;
        }
      }

      // Fallback to auth object for any other cases
      if (!found && authStr) {
        try {
          const auth = JSON.parse(authStr);
          processAuth(auth);
        } catch { }
      }

      if (!found) {
        if (bip39Auth && !authStr) {
          // Waiting for auth object from sync, do nothing.
        } else {
          setIsAuthenticated(false);
        }
      }
    };

    checkAuth();
    window.addEventListener('storage', checkAuth);
    window.addEventListener('auth_changed', checkAuth);

    return () => {
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('auth_changed', checkAuth);
    };
  }, [isEditingUsername]);
  // One-time cleanup: remove legacy per-item *_status keys (e.g., movie_123_status, tv_456_status)
  useEffect(() => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('movie_') || key.startsWith('tv_')) && key.endsWith('_status')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.error('Erreur lors du nettoyage des clés *_status du localStorage:', e);
    }
  }, []);


  // Function to fetch TV show metadata for items with missing info
  const fetchTVShowMetadata = async (showId: number) => {
    // If we already have this show's metadata cached, no need to fetch again
    if (metadataCache.has(showId)) {
      return metadataCache.get(showId);
    }

    try {
      const response = await fetch(
        `https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch TV show data');
      }

      const data = await response.json();

      const metadata = {
        title: data.name,
        poster_path: data.poster_path
      };

      // Cache the result for future use
      metadataCache.set(showId, metadata);
      return metadata;

    } catch (error) {
      console.error('Error fetching TV show metadata:', error);
      return null;
    }
  };

  // Function to enrich items with missing metadata
  const enrichItemsWithMetadata = async (items: WatchItem[]) => {
    setLoadingMetadata(true);

    const itemsToFetch = items.filter(
      (item): item is WatchItem & { id: number; type: 'tv' } =>
        isTvWatchItem(item) && (!item.title || !item.poster_path)
    );

    if (itemsToFetch.length === 0) {
      setLoadingMetadata(false);
      return items;
    }

    const promises = itemsToFetch.map(async (item) => {
      const metadata = await fetchTVShowMetadata(item.id);
      if (metadata) {
        return {
          ...item,
          title: metadata.title || 'Unknown Title',
          poster_path: metadata.poster_path || '/placeholder.jpg'
        };
      }
      return item;
    });

    const updatedItems = await Promise.all(promises);

    // Create a map of updated items by ID for easy lookup
    const updatedItemMap = new Map(
      updatedItems.map(item => [item.id, item])
    );

    // Replace items with their updated versions if available
    const enrichedItems = items.map(item => {
      if ((!item.title || !item.poster_path) && updatedItemMap.has(item.id)) {
        return updatedItemMap.get(item.id)!;
      }
      return item;
    });

    setLoadingMetadata(false);
    return enrichedItems;
  };

  const loadWatchItems = async (type: 'watchlist' | 'favorites' | 'watched') => {
    // Bulk-read all six base keys (movie/tv/collections × watchlist/favorites/watched)
    // plus the two `*_tv_episodes` legacy buckets in a single sweep. Each call to
    // loadWatchItems then plucks the right slice instead of doing per-key
    // JSON.parse round-trips.
    const family = readWatchlistFamily();

    let movieItems: WatchItem[];
    let tvItems: WatchItem[];
    let collectionItems: WatchItem[];
    if (type === 'favorites') {
      // Handle the inconsistency in storage keys for favorites
      movieItems = family.favorite_movie;       // Films stored with singular 'favorite'
      tvItems = family.favorites_tv;            // Series stored with plural 'favorites'
      collectionItems = family.favorite_collections; // Collections stored with plural 'favorites'
    } else if (type === 'watchlist') {
      movieItems = family.watchlist_movie;
      tvItems = family.watchlist_tv;
      collectionItems = family.watchlist_collections;
    } else {
      movieItems = family.watched_movie;
      tvItems = family.watched_tv;
      collectionItems = family.watched_collections;
    }

    let allItems: WatchItem[] = [...movieItems, ...tvItems, ...collectionItems];
    const tvShowIdsInMainList = new Set(tvItems.map(item => item.id));

    if (type === 'favorites') {
      const sharedListItems: WatchItem[] = readSharedListFavorites().map((favorite: SharedListFavorite) => ({
        id: favorite.shareCode,
        type: 'shared-list',
        title: favorite.listName,
        poster_path: favorite.avatar || '',
        addedAt: favorite.addedAt,
        shareCode: favorite.shareCode,
        username: favorite.username,
        itemCount: favorite.itemCount,
        isVip: favorite.isVip,
        searchText: `${favorite.listName} ${favorite.username} ${favorite.shareCode}`,
      }));

      const liveTvItems: WatchItem[] = readLiveTvFavorites().map((favorite) => ({
        id: favorite.key,
        type: 'live-tv',
        title: favorite.name,
        poster_path: favorite.poster || '',
        addedAt: favorite.addedAt,
        source: favorite.source,
        liveTvKind: favorite.kind,
        liveTvTargetId: favorite.id,
        liveTvCatalogId: favorite.catalogId,
        liveTvCategoryId: favorite.categoryId,
        searchText: `${favorite.name} ${favorite.source} ${favorite.kind}`,
      }));

      allItems = [...allItems, ...sharedListItems, ...liveTvItems];
    }

    if (type === 'watched' || type === 'watchlist') {
      // Handle legacy `*_tv_episodes` format (already read in bulk above)
      const legacyEpisodes = type === 'watched'
        ? family.watched_tv_episodes
        : family.watchlist_tv_episodes;

      const showsFromLegacy = new Map<number, WatchItem>();
      legacyEpisodes.forEach(ep => {
        if (!tvShowIdsInMainList.has(ep.id)) {
          if (!showsFromLegacy.has(ep.id) || new Date(ep.addedAt) > new Date(showsFromLegacy.get(ep.id)!.addedAt)) {
            showsFromLegacy.set(ep.id, {
              id: ep.id,
              type: 'tv',
              title: ep.title || '',
              poster_path: ep.poster_path || '',
              addedAt: ep.addedAt,
            });
          }
        }
      });

      // Handle `*_episodes_tv_{id}` format
      Object.keys(localStorage)
        .filter(key => key.startsWith(`${type}_episodes_tv_`))
        .forEach(key => {
          const showId = parseInt(key.replace(`${type}_episodes_tv_`, ''));
          if (!tvShowIdsInMainList.has(showId) && !showsFromLegacy.has(showId)) {
            const episodes = JSON.parse(localStorage.getItem(key) || '{}');
            if (Object.keys(episodes).length > 0) {
              showsFromLegacy.set(showId, {
                id: showId,
                type: 'tv' as const,
                title: '', // Will be fetched later
                poster_path: '', // Will be fetched later
                addedAt: new Date(0).toISOString(), // Placeholder
              });
            }
          }
        });

      allItems = [...allItems, ...Array.from(showsFromLegacy.values())];
    }

    const uniqueItems = Array.from(new Map(allItems.map(item => [getWatchItemKey(item), item])).values());
    uniqueItems.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());

    if (type === 'watched' || type === 'watchlist' || type === 'favorites') {
      const tmdbItems = uniqueItems.filter(isTmdbWatchItem);
      const enrichedTmdbItems = await enrichItemsWithMetadata(tmdbItems);
      const enrichedTmdbMap = new Map(enrichedTmdbItems.map((item) => [getWatchItemKey(item), item]));
      return uniqueItems.map((item) => enrichedTmdbMap.get(getWatchItemKey(item)) ?? item);
    }

    return uniqueItems;
  };

  // Fonction pour charger les détails d'une collection
  const loadCollectionDetails = async (collectionId: number) => {
    setLoadingCollectionMovies(true);
    try {
      const response = await fetch(
        `https://api.themoviedb.org/3/collection/${collectionId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );

      if (response.ok) {
        const collectionData = await response.json();
        setSelectedCollection(collectionData);
        setCollectionMovies(collectionData.parts || []);
      } else {
        console.error('Erreur lors du chargement de la collection:', response.status);
        setCollectionMovies([]);
      }
    } catch (error) {
      console.error('Erreur lors du chargement de la collection:', error);
      setCollectionMovies([]);
    } finally {
      setLoadingCollectionMovies(false);
    }
  };

  // Fonction pour ouvrir une collection
  const openCollection = (collection: any) => {
    setSelectedCollection(collection);
    loadCollectionDetails(collection.id);
  };

  // Fonction pour retirer un film/série de la liste
  const removeFromListCollection = (movieId: number) => {
    if (!selectedList) return;

    const updatedItems = selectedList.items.filter(item => {
      if (item.type === 'collection') {
        // Pour les collections, on ne peut pas supprimer un film individuel
        return true;
      } else {
        // Pour les films/séries individuels, on peut les supprimer
        return item.id !== movieId;
      }
    });

    const updatedList = {
      ...selectedList,
      items: updatedItems
    };

    // Mettre à jour la liste dans le state et localStorage
    const updatedLists = customLists.map(list =>
      list.id === selectedList.id ? updatedList : list
    );

    setCustomLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));

    // Recharger la vue des collections si nécessaire
    if (selectedListCollections.length > 0) {
      loadListCollections(updatedList);
    }
  };

  // Fonction pour retirer une collection entière de la liste
  const removeCollectionFromList = (collectionId: number) => {
    if (!selectedList) return;

    const updatedItems = selectedList.items.filter(item => item.id !== collectionId);

    const updatedList = {
      ...selectedList,
      items: updatedItems
    };

    // Mettre à jour la liste dans le state et localStorage
    const updatedLists = customLists.map(list =>
      list.id === selectedList.id ? updatedList : list
    );

    setCustomLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));

    // Recharger la vue des collections si nécessaire
    if (selectedListCollections.length > 0) {
      loadListCollections(updatedList);
    }
  };

  // Fonction pour charger toutes les collections d'une liste
  const loadListCollections = async (list: CustomList) => {
    setLoadingListCollections(true);
    setSelectedListName(list.name);
    try {
      const collections = list.items.filter(item => item.type === 'collection');
      const individualItems = list.items.filter(item => item.type !== 'collection');
      const allMovies: any[] = [];

      // Charger les films des collections
      for (const collection of collections) {
        try {
          const response = await fetch(
            `https://api.themoviedb.org/3/collection/${collection.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
          );

          if (response.ok) {
            const collectionData = await response.json();
            const movies = (collectionData.parts || []).map((movie: any) => ({
              ...movie,
              collectionName: collection.title,
              collectionId: collection.id,
              isFromCollection: true
            }));
            allMovies.push(...movies);
          }
        } catch (error) {
          console.error(`Erreur lors du chargement de la collection ${collection.id}:`, error);
        }
      }

      // Ajouter les films et séries individuels
      for (const item of individualItems) {
        if (item.type === 'movie') {
          try {
            const response = await fetch(
              `https://api.themoviedb.org/3/movie/${item.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
            );

            if (response.ok) {
              const movieData = await response.json();
              allMovies.push({
                ...movieData,
                collectionName: t('profilePage.collectionNames.individualMovie'),
                collectionId: null,
                isFromCollection: false,
                individualItem: true
              });
            }
          } catch (error) {
            console.error(`Erreur lors du chargement du film ${item.id}:`, error);
          }
        } else if (item.type === 'tv') {
          try {
            const response = await fetch(
              `https://api.themoviedb.org/3/tv/${item.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
            );

            if (response.ok) {
              const tvData = await response.json();
              allMovies.push({
                ...tvData,
                collectionName: t('profilePage.collectionNames.individualSeries'),
                collectionId: null,
                isFromCollection: false,
                individualItem: true,
                type: 'tv',
                title: tvData.name,
                release_date: tvData.first_air_date
              });
            }
          } catch (error) {
            console.error(`Erreur lors du chargement de la série ${item.id}:`, error);
          }
        }
      }

      setSelectedListCollections(allMovies);
    } catch (error) {
      console.error('Erreur lors du chargement des collections:', error);
      setSelectedListCollections([]);
    } finally {
      setLoadingListCollections(false);
    }
  };

  // Fonction pour ouvrir une liste de collections
  const openListCollections = (list: CustomList) => {
    const hasCollections = list.items.some(item => item.type === 'collection');
    if (hasCollections) {
      loadListCollections(list);
    } else {
      setSelectedList(list);
    }
  };

  // État pour stocker le nom de la liste sélectionnée
  const [selectedListName, setSelectedListName] = useState<string>('');



  // Helper function to check if a TV show is fully watched
  const isTVShowFullyWatched = async (showId: number): Promise<boolean> => {
    try {
      // Get watched episodes for this show
      const watchedEpisodesKey = `watched_episodes_tv_${showId}`;
      const watchedEpisodesData = localStorage.getItem(watchedEpisodesKey);

      if (!watchedEpisodesData) return false;

      const watchedEpisodes = JSON.parse(watchedEpisodesData);
      const watchedEpisodesCount = Object.keys(watchedEpisodes).length;

      // Fetch TV show details from TMDB to get total episode count
      const response = await fetch(
        `https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );

      if (response.ok) {
        const tvShowData = await response.json();
        const totalEpisodes = tvShowData.number_of_episodes || 0;

        // Return true if all episodes are watched
        return totalEpisodes > 0 && watchedEpisodesCount >= totalEpisodes;
      }
    } catch (error) {
      console.error(`Erreur lors de la vérification si la série ${showId} est entièrement vue:`, error);
    }

    return false;
  };

  // Helper function to group episodes by season
  const groupEpisodesBySeason = (episodes: Record<string, boolean>) => {
    const seasons: Record<number, string[]> = {};
    const ungrouped: string[] = [];

    Object.keys(episodes).forEach(epKey => {
      const match = epKey.match(/S(\d+)E(\d+)/i);
      if (match) {
        const season = parseInt(match[1]);

        if (!seasons[season]) {
          seasons[season] = [];
        }

        // Add episode to season array
        seasons[season].push(epKey);
      } else {
        // Handle non-standard episode keys
        ungrouped.push(epKey);
      }
    });

    // Sort episodes within each season
    Object.keys(seasons).forEach(season => {
      seasons[parseInt(season)].sort((a, b) => {
        const matchA = a.match(/S\d+E(\d+)/i);
        const matchB = b.match(/S\d+E(\d+)/i);
        return matchA && matchB ? parseInt(matchA[1]) - parseInt(matchB[1]) : 0;
      });
    });

    // Sort seasons numerically
    const sortedSeasons: Record<number, string[]> = {};
    Object.keys(seasons)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach(season => {
        sortedSeasons[season] = seasons[season];
      });

    // Add ungrouped episodes if any
    if (ungrouped.length > 0) {
      sortedSeasons[-1] = ungrouped; // Use -1 for ungrouped episodes
    }

    return sortedSeasons;
  };

  // Helper function to check if a show is an anime
  const isAnimeShow = (showId: number): boolean => {
    // Check legacy format: watched_tv_episodes
    const legacyEpisodesKey = 'watched_tv_episodes';
    const legacyEpisodes = JSON.parse(localStorage.getItem(legacyEpisodesKey) || '[]');
    if (legacyEpisodes.some((ep: any) => ep.id === showId)) {
      return true;
    }

    // Check if it's in the anime cache (anime-sama)
    const animeCacheKeys = Object.keys(localStorage).filter(key =>
      key.includes('anime-sama') && key.includes(showId.toString())
    );
    if (animeCacheKeys.length > 0) {
      return true;
    }

    // Check if the show has anime-like episode patterns (e.g., very high episode numbers)
    const watchedEpisodesKey = `watched_episodes_tv_${showId}`;
    const watchedEpisodesData = localStorage.getItem(watchedEpisodesKey);
    if (watchedEpisodesData) {
      const watchedEpisodes = JSON.parse(watchedEpisodesData);
      const episodeKeys = Object.keys(watchedEpisodes);

      // If episodes have very high numbers (like anime), consider it an anime
      const hasHighEpisodeNumbers = episodeKeys.some(epKey => {
        const match = epKey.match(/S\d+E(\d+)/i);
        if (match) {
          const episodeNum = parseInt(match[1]);
          return episodeNum > 50; // Anime often have many episodes
        }
        return false;
      });

      if (hasHighEpisodeNumbers) {
        return true;
      }
    }

    return false;
  };

  // Helper function to toggle season expansion
  const toggleSeasonExpansion = (showId: number, season: number) => {
    const seasonKey = `${showId}-${season}`;
    setExpandedSeasons(prev => {
      const newSet = new Set(prev);
      if (newSet.has(seasonKey)) {
        newSet.delete(seasonKey);
      } else {
        newSet.add(seasonKey);
      }
      return newSet;
    });
  };

  // Helper function to check if a season is expanded
  const isSeasonExpanded = (showId: number, season: number): boolean => {
    const seasonKey = `${showId}-${season}`;
    return expandedSeasons.has(seasonKey);
  };

  // Function to check progress and automatically mark items as watched
  const checkProgressAndMarkWatched = useCallback(async () => {
    try {
      const watchedMovies = JSON.parse(localStorage.getItem('watched_movie') || '[]');
      const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');
      const continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}');

      let hasUpdates = false;

      // Check movie progress
      if (continueWatching.movies && Array.isArray(continueWatching.movies)) {
        for (const movieItem of continueWatching.movies) {
          // Handle both old format (array of IDs) and new format (array of objects)
          const movieId = typeof movieItem === 'object' ? movieItem.id : movieItem;

          // Skip if already marked as watched
          if (watchedMovies.some((item: any) => item.id === movieId)) continue;

          const progressKey = `progress_${movieId}`;
          const savedProgress = localStorage.getItem(progressKey);

          if (savedProgress) {
            try {
              const progressData = JSON.parse(savedProgress);
              if (progressData.position && progressData.duration) {
                const progressPercent = (progressData.position / progressData.duration) * 100;

                if (progressPercent > 85) {
                  // Fetch movie metadata from TMDB
                  try {
                    const response = await fetch(
                      `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
                    );

                    if (response.ok) {
                      const movieData = await response.json();
                      const watchedItem = {
                        id: movieId,
                        type: 'movie' as const,
                        title: movieData.title || t('profilePage.collectionNames.unknownMovie'),
                        poster_path: movieData.poster_path || '',
                        addedAt: new Date().toISOString()
                      };

                      watchedMovies.unshift(watchedItem);
                      hasUpdates = true;
                      console.log(`Film automatiquement marqué comme vu: ${movieData.title} (${progressPercent.toFixed(1)}%)`);
                    }
                  } catch (error) {
                    console.error(`Erreur lors de la récupération des métadonnées du film ${movieId}:`, error);
                  }
                }
              }
            } catch (error) {
              console.error(`Erreur lors de l'analyse de la progression du film ${movieId}:`, error);
            }
          }
        }
      }

      // Check TV show progress from continueWatching
      if (continueWatching.tv && Array.isArray(continueWatching.tv)) {
        for (const tvShow of continueWatching.tv) {
          if (!tvShow.id || !tvShow.currentEpisode) continue;

          // Skip if already marked as watched
          if (watchedTv.some((item: any) => item.id === tvShow.id)) continue;

          const { season, episode } = tvShow.currentEpisode;
          const progressKey = `progress_tv_${tvShow.id}_s${season}_e${episode}`;
          const savedProgress = localStorage.getItem(progressKey);

          if (savedProgress) {
            try {
              const progressData = JSON.parse(savedProgress);
              if (progressData.position && progressData.duration) {
                const progressPercent = (progressData.position / progressData.duration) * 100;

                if (progressPercent > 85) {
                  // Instead of marking the whole series as watched, mark the specific episode
                  try {
                    const episodeStorageKey = `watched_episodes_tv_${tvShow.id}`;
                    const existing = JSON.parse(localStorage.getItem(episodeStorageKey) || '{}');
                    const storageEpisodeKey = `S${season}E${episode}`;
                    existing[storageEpisodeKey] = true;
                    localStorage.setItem(episodeStorageKey, JSON.stringify(existing));
                    console.log(`Épisode automatiquement marqué comme vu: show=${tvShow.id} ${storageEpisodeKey} (${progressPercent.toFixed(1)}%)`);
                    hasUpdates = true;
                  } catch (error) {
                    console.error(`Erreur lors de la sauvegarde de l'épisode vu pour la série ${tvShow.id}:`, error);
                  }
                }
              }
            } catch (error) {
              console.error(`Erreur lors de l'analyse de la progression de la série ${tvShow.id}:`, error);
            }
          }
        }
      }

      // NEW: Check ALL TV episode progress keys in localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('progress_tv_')) {
          // Parse the key to extract showId, season, and episode
          const match = key.match(/progress_tv_(\d+)_s(\d+)_e(\d+)/);
          if (match) {
            const [, showId, season, episode] = match;
            const showIdNum = parseInt(showId);
            const seasonNum = parseInt(season);
            const episodeNum = parseInt(episode);

            // Check if this episode is already marked as watched
            const episodeStorageKey = `watched_episodes_tv_${showIdNum}`;
            const existingWatched = JSON.parse(localStorage.getItem(episodeStorageKey) || '{}');
            const storageEpisodeKey = `S${seasonNum}E${episodeNum}`;

            if (!existingWatched[storageEpisodeKey]) {
              const savedProgress = localStorage.getItem(key);
              if (savedProgress) {
                try {
                  const progressData = JSON.parse(savedProgress);
                  if (progressData.position && progressData.duration) {
                    const progressPercent = (progressData.position / progressData.duration) * 100;

                    if (progressPercent > 85) {
                      // Mark this episode as watched
                      existingWatched[storageEpisodeKey] = true;
                      localStorage.setItem(episodeStorageKey, JSON.stringify(existingWatched));
                      console.log(`Épisode automatiquement marqué comme vu: show=${showIdNum} ${storageEpisodeKey} (${progressPercent.toFixed(1)}%)`);
                      hasUpdates = true;
                    }
                  }
                } catch (error) {
                  console.error(`Erreur lors de l'analyse de la progression de l'épisode ${key}:`, error);
                }
              }
            }
          }
        }
      }

      // Update localStorage if there were changes
      if (hasUpdates) {
        localStorage.setItem('watched_movie', JSON.stringify(watchedMovies));
        localStorage.setItem('watched_tv', JSON.stringify(watchedTv));
      }

      // NEW: Check and update "full series watched" status for TV shows
      await checkAndUpdateFullSeriesWatchedStatus();

      return hasUpdates;
    } catch (error) {
      console.error('Erreur lors de la vérification automatique de la progression:', error);
      return false;
    }
  }, []);

  // Function to check and update "full series watched" status
  const checkAndUpdateFullSeriesWatchedStatus = async () => {
    try {
      // Get all TV shows that have episode tracking
      const tvShowsWithEpisodes = new Set<number>();

      // Scan localStorage for all TV episode progress keys
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('progress_tv_')) {
          const match = key.match(/progress_tv_(\d+)_s\d+_e\d+/);
          if (match) {
            tvShowsWithEpisodes.add(parseInt(match[1]));
          }
        }
      }

      // Also check for shows with watched episodes
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('watched_episodes_tv_')) {
          const match = key.match(/watched_episodes_tv_(\d+)/);
          if (match) {
            tvShowsWithEpisodes.add(parseInt(match[1]));
          }
        }
      }

      // Check each TV show
      for (const showId of tvShowsWithEpisodes) {
        try {
          // Use the helper function to check if the show is fully watched
          const isFullyWatched = await isTVShowFullyWatched(showId);

          if (isFullyWatched) {
            // Get TV show details from TMDB for metadata
            const response = await fetch(
              `https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
            );

            if (response.ok) {
              const tvShowData = await response.json();
              const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');

              // Check if not already in watched_tv
              if (!watchedTv.some((item: any) => item.id === showId)) {
                const watchedItem = {
                  id: showId,
                  type: 'tv' as const,
                  title: tvShowData.name || t('profilePage.collectionNames.unknownSeries'),
                  poster_path: tvShowData.poster_path || '',
                  addedAt: new Date().toISOString()
                };

                watchedTv.unshift(watchedItem);
                localStorage.setItem('watched_tv', JSON.stringify(watchedTv));
                console.log(`Série entière marquée comme vue: ${tvShowData.name}`);
              }
            }
          }
        } catch (error) {
          console.error(`Erreur lors de la vérification du statut de la série ${showId}:`, error);
        }
      }
    } catch (error) {
      console.error('Erreur lors de la vérification du statut des séries entières:', error);
    }
  };

  // Fonction pour charger les séries en cours de visionnage
  const loadInProgressItems = async () => {
    setLoadingInProgress(true);
    try {
      const inProgressItems: WatchItem[] = [];
      const processedShows = new Set<number>();

      // Trouver toutes les séries avec des épisodes regardés
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('watched_episodes_tv_')) {
          const match = key.match(/watched_episodes_tv_(\d+)/);
          if (match) {
            const showId = parseInt(match[1]);
            if (processedShows.has(showId)) continue;
            processedShows.add(showId);

            try {
              // Récupérer les épisodes regardés
              const watchedEpisodesData = localStorage.getItem(key);
              if (!watchedEpisodesData) continue;

              const watchedEpisodes = JSON.parse(watchedEpisodesData);
              const watchedCount = Object.keys(watchedEpisodes).length;

              if (watchedCount === 0) continue;

              // Vérifier si la série est dans watched_tv (= terminée)
              const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');
              const isCompleted = watchedTv.some((item: any) => item.id === showId);

              if (isCompleted) continue; // Ne pas ajouter les séries terminées

              // Récupérer les infos de la série depuis TMDB
              const response = await fetch(
                `https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
              );

              if (response.ok) {
                const tvShowData = await response.json();
                const totalEpisodes = tvShowData.number_of_episodes || 0;

                // Si toutes les épisodes sont vues, ne pas inclure (sera dans "Vus")
                if (watchedCount >= totalEpisodes && totalEpisodes > 0) continue;

                // Trouver le dernier épisode regardé
                const episodeKeys = Object.keys(watchedEpisodes);
                let lastSeason = 1;
                let lastEpisode = 1;

                episodeKeys.forEach(epKey => {
                  const epMatch = epKey.match(/S(\d+)E(\d+)/i);
                  if (epMatch) {
                    const s = parseInt(epMatch[1]);
                    const e = parseInt(epMatch[2]);
                    if (s > lastSeason || (s === lastSeason && e > lastEpisode)) {
                      lastSeason = s;
                      lastEpisode = e;
                    }
                  }
                });

                inProgressItems.push({
                  id: showId,
                  type: 'tv' as const,
                  title: tvShowData.name || t('profilePage.collectionNames.unknownSeries'),
                  poster_path: tvShowData.poster_path || '',
                  addedAt: new Date().toISOString(),
                  episodeInfo: {
                    season: lastSeason,
                    episode: lastEpisode
                  },
                  backdrop_path: tvShowData.backdrop_path,
                  overview: tvShowData.overview
                });
              }
            } catch (error) {
              console.error(`Erreur lors du chargement de la série ${showId}:`, error);
            }
          }
        }
      }

      // Trier par date d'ajout (les plus récents en premier)
      inProgressItems.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());

      setInProgress(inProgressItems);
      setInProgressCount(inProgressItems.length);
    } catch (error) {
      console.error('Erreur lors du chargement des séries en cours:', error);
    } finally {
      setLoadingInProgress(false);
    }
  };

  // Fast count of in-progress shows from localStorage (no TMDB fetch)
  const countInProgressFast = () => {
    const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');
    const completedIds = new Set(watchedTv.map((item: any) => item.id));
    let count = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('watched_episodes_tv_')) {
        const match = key.match(/watched_episodes_tv_(\d+)/);
        if (match) {
          const showId = parseInt(match[1]);
          if (completedIds.has(showId)) continue;
          const data = localStorage.getItem(key);
          if (data) {
            try {
              const episodes = JSON.parse(data);
              if (Object.keys(episodes).length > 0) count++;
            } catch { /* ignore */ }
          }
        }
      }
    }
    return count;
  };

  const loadAlerts = () => {
    const allAlerts = AlertService.getAllAlerts();
    const alertsList = Object.values(allAlerts).sort((a, b) =>
      new Date(a.airDate).getTime() - new Date(b.airDate).getTime()
    );
    setAlerts(alertsList);
  };

  // Get user info for API calls
  const getUserInfo = () => {
    const account = getResolvedAccountContext();
    if (!account.userType || !account.userId) return null;
    return { type: account.userType, id: account.userId };
  };

  // Load user sessions
  const loadSessions = useCallback(async () => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) {
        return; // Sessions only for Discord, Google, and BIP39 users
      }

      const response = await axios.get(`${API_URL}/api/sessions`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });

      const items = response.data?.data?.items || [];
      setSessions(items);

      // Set current session ID from localStorage (used to mark "Session actuelle")
      const storedSessionId = localStorage.getItem('session_id');
      setCurrentSessionId(storedSessionId);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        try {
          clearStoredAuthSession();
          broadcastAuthChange();
        } catch { }
        try { sessionStorage.clear(); } catch { }
        window.location.href = '/';
        return;
      }
      console.error('Error loading sessions:', err);
    }
  }, []);

  // Delete a session
  const deleteSession = async (sessionId: string) => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) {
        return;
      }

      const response = await axios.post(`${API_URL}/api/sessions/delete`, {
        sessionId: sessionId
      }, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}`
        }
      });

      if (response.data.success) {
        // Remove session from state
        setSessions(prev => prev.filter(s => s.id !== sessionId));

        // If this was the current session, logout
        if (sessionId === currentSessionId) {
          handleLogout();
        }
      }
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  };

  const handleLogout = () => {
    // Use the centralized helpers so the auth-key list stays in sync with
    // every other logout path (ProfileMenu, 401 interceptor, OAuth flows).
    // The previous hand-rolled list drifted: it missed `requires_username_change`
    // (in AUTH_KEYS) and removed `selected_profile_id` (intentionally NOT in
    // AUTH_KEYS per the accountAuth.ts comment — preserved across logout so
    // the user lands on the same profile after re-auth on mirror domains).
    try {
      clearStoredAuthSession();
      broadcastAuthChange();
    } catch { /* noop */ }
    window.location.href = '/';
  };

  const handleDeleteAlert = (alertId: string) => {
    if (AlertService.removeAlert(alertId)) {
      setAlerts(prev => prev.filter(alert => alert.id !== alertId));
    }
  };

  const handleEditAlert = (alertId: string, currentDays: NotifyBeforeDays) => {
    setEditingAlert(alertId);
    setSelectedDays(currentDays);
  };

  const handleSaveEdit = (alertId: string) => {
    const alert = alerts.find(a => a.id === alertId);
    if (alert && AlertService.updateAlert(alert.showId, alert.season, alert.episode, selectedDays)) {
      setAlerts(prev => prev.map(a =>
        a.id === alertId ? { ...a, notifyBeforeDays: selectedDays } : a
      ));
      setEditingAlert(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingAlert(null);
  };

  const formatAirDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const formattedDate = date.toLocaleDateString(i18n.language, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    if (diffDays < 0) {
      return { text: formattedDate, status: 'passed', daysText: t('profilePage.dates.alreadyReleased') };
    } else if (diffDays === 0) {
      return { text: formattedDate, status: 'today', daysText: t('profilePage.dates.today') };
    } else if (diffDays === 1) {
      return { text: formattedDate, status: 'soon', daysText: t('profilePage.dates.tomorrow') };
    } else {
      return { text: formattedDate, status: 'upcoming', daysText: t('profilePage.dates.inDays', { count: diffDays }) };
    }
  };

  const getNotificationText = (days: NotifyBeforeDays) => {
    if (days === 0) return t('profilePage.notifications.sameDay');
    return t('profilePage.notifications.daysBefore', { count: days });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'passed':
        return 'text-gray-500';
      case 'today':
        return 'text-green-500';
      case 'soon':
        return 'text-yellow-500';
      case 'upcoming':
        return 'text-blue-500';
      default:
        return 'text-gray-400';
    }
  };

  const renderAlerts = () => {
    if (alerts.length === 0) {
      return (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-16"
        >
          <div className="p-4 bg-gray-800/50 rounded-full w-20 h-20 mx-auto mb-6 flex items-center justify-center">
            <BellRing className="w-10 h-10 text-gray-500" />
          </div>
          <h2 className="text-xl font-semibold mb-2">{t('profilePage.alerts.noAlerts')}</h2>
          <p className="text-gray-400 mb-6">
            {t('profilePage.alerts.noAlertsDesc')}
          </p>
          <Link
            to="/tv-shows"
            className="inline-flex items-center gap-2 px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl font-medium transition-colors"
          >
            <Bell className="w-4 h-4" />
            {t('profilePage.alerts.browseSeries')}
          </Link>
        </motion.div>
      );
    }

    return (
      <div className="space-y-4">
        <AnimatePresence>
          {alerts.map((alert, index) => {
            const dateInfo = formatAirDate(alert.airDate);
            const isEditing = editingAlert === alert.id;

            return (
              <motion.div
                key={alert.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ delay: index * 0.1 }}
                className="bg-gray-900/50 border border-gray-700 rounded-2xl p-6 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Show Info */}
                    <div className="mb-4">
                      <Link
                        to={`/tv/${alert.showId}`}
                        className="text-xl font-bold text-white hover:text-yellow-500 transition-colors"
                      >
                        {alert.showName}
                      </Link>
                      <div className="text-gray-300 mt-1">
                        {t('profilePage.alerts.seasonEpisode', { season: alert.season, episode: alert.episode })}
                        {alert.episodeName && ` - ${alert.episodeName}`}
                      </div>
                    </div>

                    {/* Date Info */}
                    <div className="flex items-center gap-4 mb-4 text-sm">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-400">{t('profilePage.alerts.releasesOn')}</span>
                        <span className={getStatusColor(dateInfo.status)}>
                          {dateInfo.text}
                        </span>
                      </div>
                      <div className={`px-2 py-1 rounded-full text-xs font-medium ${dateInfo.status === 'passed' ? 'bg-gray-600/50 text-gray-400' :
                        dateInfo.status === 'today' ? 'bg-green-600/50 text-green-400' :
                          dateInfo.status === 'soon' ? 'bg-yellow-600/50 text-yellow-400' :
                            'bg-blue-600/50 text-blue-400'
                        }`}>
                        {dateInfo.daysText}
                      </div>
                    </div>

                    {/* Notification Settings */}
                    <div className="flex items-center gap-2 text-sm">
                      <Clock className="w-4 h-4 text-gray-400" />
                      <span className="text-gray-400">{t('profilePage.alerts.alertLabel')}</span>
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <CustomDropdown
                            options={[
                              { value: '0', label: t('profilePage.notifications.sameDay') },
                              { value: '1', label: t('profilePage.notifications.daysBefore', { count: 1 }) },
                              { value: '2', label: t('profilePage.notifications.daysBefore', { count: 2 }) },
                              { value: '3', label: t('profilePage.notifications.daysBefore', { count: 3 }) },
                              { value: '4', label: t('profilePage.notifications.daysBefore', { count: 4 }) },
                              { value: '5', label: t('profilePage.notifications.daysBefore', { count: 5 }) },
                              { value: '6', label: t('profilePage.notifications.daysBefore', { count: 6 }) },
                              { value: '7', label: t('profilePage.notifications.daysBefore', { count: 7 }) }
                            ]}
                            value={selectedDays.toString()}
                            onChange={(value) => setSelectedDays(Number(value) as NotifyBeforeDays)}
                            className="min-w-[140px]"
                            position="bottom"
                          />
                          <button
                            onClick={() => handleSaveEdit(alert.id)}
                            className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs transition-colors"
                          >
                            {t('profilePage.alerts.save')}
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-xs transition-colors"
                          >
                            {t('profilePage.alerts.cancel')}
                          </button>
                        </div>
                      ) : (
                        <span className="text-yellow-500 font-medium">
                          {getNotificationText(alert.notifyBeforeDays)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  {!isEditing && (
                    <div className="flex items-center gap-2">
                      <motion.button
                        onClick={() => handleEditAlert(alert.id, alert.notifyBeforeDays)}
                        className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-yellow-500"
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        title={t('profilePage.alerts.editAlert')}
                      >
                        <Edit3 className="w-4 h-4" />
                      </motion.button>
                      <motion.button
                        onClick={() => handleDeleteAlert(alert.id)}
                        className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-red-500"
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        title={t('profilePage.alerts.deleteAlert')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </motion.button>
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    );
  };

  // Render sessions interface
  const renderSessions = () => {
    const userInfo = getUserInfo();

    // Only show sessions for Discord, Google, and BIP39 users
    if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) {
      return (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-16"
        >
          <div className="p-4 bg-gray-800/50 rounded-full w-20 h-20 mx-auto mb-6 flex items-center justify-center">
            <Monitor className="w-10 h-10 text-gray-500" />
          </div>
          <h3 className="text-xl font-semibold text-gray-300 mb-2">{t('profilePage.sessions_ui.notAvailable')}</h3>
          <p className="text-gray-500 max-w-lg mx-auto">
            {t('profilePage.sessions_ui.notAvailableDesc')}
          </p>
        </motion.div>
      );
    }

    if (sessions.length === 0) {
      return (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-16"
        >
          <div className="p-4 bg-gray-800/50 rounded-full w-20 h-20 mx-auto mb-6 flex items-center justify-center">
            <Monitor className="w-10 h-10 text-gray-500" />
          </div>
          <h3 className="text-xl font-semibold text-gray-300 mb-2">{t('profilePage.sessions_ui.noActiveSessions')}</h3>
          <p className="text-gray-500 max-w-lg mx-auto">
            {t('profilePage.sessions_ui.noActiveSessionsDesc')}
          </p>
        </motion.div>
      );
    }

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

      if (diffMins < 1) return t('profilePage.sessions.justNow');
      if (diffMins < 60) return t('profilePage.sessions.minutesAgo', { count: diffMins });
      if (diffHours < 24) return t('profilePage.sessions.hoursAgo', { count: diffHours });
      if (diffDays < 7) return t('profilePage.sessions.daysAgo', { count: diffDays });
      return date.toLocaleDateString(i18n.language);
    };

    return (
      <div className="space-y-4">
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
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className={`bg-gray-800/50  rounded-xl p-4 border transition-colors ${isCurrentSession
                  ? 'border-green-500/50 bg-green-900/20'
                  : 'border-gray-700/50 hover:border-gray-600/50'
                  }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className={`p-2 rounded-lg ${isCurrentSession ? 'bg-green-500/20 text-green-400' : 'bg-gray-700/50 text-gray-400'
                      }`}>
                      {getDeviceIcon(deviceInfo.deviceType)}
                    </div>

                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <h4 className="font-medium text-white">
                          {getSessionBrowserLabel(deviceInfo, t('profilePage.sessions.browser'))}
                        </h4>
                        {isCurrentSession && (
                          <span className="px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded-full">
                            {t('profilePage.sessions.currentSession')}
                          </span>
                        )}
                      </div>

                      <div className="text-sm text-gray-400 space-y-1">
                        <p>{deviceDetails}</p>
                        <p>{t('profilePage.sessions.createdOn', { date: new Date(session.createdAt).toLocaleDateString(i18n.language), time: new Date(session.createdAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) })}</p>
                        <p>{t('profilePage.sessions.lastActivity', { time: formatDate(session.accessedAt) })}</p>
                      </div>
                    </div>
                  </div>

                  {!isCurrentSession && (
                    <motion.button
                      onClick={() => deleteSession(session.id)}
                      className="p-2 hover:bg-red-500/20 rounded-lg transition-colors text-gray-400 hover:text-red-400"
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      title={t('profilePage.sessions.disconnectSession')}
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
  };

  useEffect(() => {
    const loadAllItems = async () => {
      // Check progress and mark items as watched before loading
      const hasUpdates = await checkProgressAndMarkWatched();

      setWatchlist(await loadWatchItems('watchlist'));
      setFavorites(await loadWatchItems('favorites'));
      setWatched(await loadWatchItems('watched'));
      setInProgressCount(countInProgressFast());
      loadAlerts();
      loadSessions();

      const savedLists = localStorage.getItem('custom_lists');
      if (savedLists) {
        const lists = JSON.parse(savedLists);

        // Enrichir les listes avec le nombre de films des collections
        const enrichedLists = await Promise.all(lists.map(async (list: CustomList) => {
          const enrichedItems = await Promise.all(list.items.map(async (item) => {
            if (item.type === 'collection') {
              try {
                const response = await fetch(
                  `https://api.themoviedb.org/3/collection/${item.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
                );
                if (response.ok) {
                  const collectionData = await response.json();
                  return {
                    ...item,
                    movieCount: collectionData.parts?.length || 0
                  };
                }
              } catch (error) {
                console.error(`Erreur lors du chargement des détails de la collection ${item.id}:`, error);
              }
            }
            return item;
          }));

          return {
            ...list,
            items: enrichedItems
          };
        }));

        setCustomLists(enrichedLists);
      }



      const auth = localStorage.getItem('auth');
      if (auth) {
        const { userProfile, expiresAt } = JSON.parse(auth);
        setUserProfile(userProfile);
        let expiration = userProfile.vipExpiresAt || expiresAt;
        if (expiration === 'never') expiration = undefined;
      }

      // Check VIP status from localStorage
      const isVip = isUserVip();
      if (isVip) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') {
          expiration = accessCodeExpires;
        }
        setVipStatus({
          isVip: true,
          expiresAt: expiration,
          features: [
            t('profilePage.vip.noAds')
          ]
        });
      }

      // Show notification if items were automatically marked as watched
      if (hasUpdates) {
        console.log('Des films/séries ont été automatiquement marqués comme vus en fonction de votre progression.');
      }
    };

    loadAllItems();
  }, [checkProgressAndMarkWatched, isEditingUsername]);

  useEffect(() => {
    const favoriteKeys = new Set([
      'favorite_movie',
      'favorites_tv',
      'favorite_collections',
      SHARED_LIST_FAVORITES_STORAGE_KEY,
      LIVE_TV_FAVORITES_STORAGE_KEY,
    ]);

    const refreshFavorites = async () => {
      setFavorites(await loadWatchItems('favorites'));
    };

    const handleStorageLikeUpdate = (event?: StorageEvent) => {
      if (event?.key && !favoriteKeys.has(event.key)) {
        return;
      }
      void refreshFavorites();
    };

    window.addEventListener('storage', handleStorageLikeUpdate);
    window.addEventListener('sync_storage_updated', handleStorageLikeUpdate as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageLikeUpdate);
      window.removeEventListener('sync_storage_updated', handleStorageLikeUpdate as EventListener);
    };
  }, []);

  // Listen for VIP status changes
  useEffect(() => {
    const handleVipStatusChange = () => {
      const isVip = isUserVip();
      if (isVip) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') {
          expiration = accessCodeExpires;
        }
        setVipStatus({
          isVip: true,
          expiresAt: expiration,
          features: [
            t('profilePage.vip.noAds')
          ]
        });
      } else {
        setVipStatus({
          isVip: false,
          features: []
        });
      }
    };

    // Listen for storage events (changes from other tabs)
    window.addEventListener('storage', handleVipStatusChange);

    return () => {
      window.removeEventListener('storage', handleVipStatusChange);
    };
  }, []);

  // Update cooldown timer automatically — only ticks while a cooldown error
  // is actually being displayed. Previously the 1s interval ran whenever
  // `lastAttempt` was set even when no error was visible (e.g. user opened
  // a successful key once, lastAttempt persisted, no error to update), and
  // every tick re-rendered all 4500 lines of Profile (61 useStates). — perf
  useEffect(() => {
    if (!lastAttempt) return;
    const cooldownPrefix = t('profilePage.vip.waitBeforeRetry', { seconds: '0' }).split('0')[0];
    const isShowingCooldown = vipKeyError && cooldownPrefix && vipKeyError.startsWith(cooldownPrefix);
    if (!isShowingCooldown) return;

    const updateCooldown = () => {
      const elapsed = Date.now() - lastAttempt;
      if (elapsed < 30000) {
        const remaining = Math.ceil((30000 - elapsed) / 1000);
        setVipKeyError(t('profilePage.vip.waitBeforeRetry', { seconds: remaining }));
      } else {
        // Cooldown terminé, effacer l'erreur de cooldown
        setVipKeyError(null);
      }
    };

    updateCooldown();
    const interval = setInterval(updateCooldown, 1000);

    return () => clearInterval(interval);
  }, [lastAttempt, vipKeyError, t]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    if (tabParam) {
      setActiveTab(tabParam);
    }
  }, [location.search]);

  // Load sessions when switching to sessions tab
  useEffect(() => {
    if (activeTab === 'sessions') {
      loadSessions();
    }
  }, [activeTab, loadSessions]);

  // Load in-progress items when switching to in-progress tab
  useEffect(() => {
    if (activeTab === 'in-progress') {
      loadInProgressItems();
    }
  }, [activeTab]);

  // Memoized so the tab bar (which renders motion.button per tab with
  // whileHover/transitions) doesn't reconcile all 6 entries on every Profile
  // render. With 61 useStates in this component, almost every interaction
  // triggers a re-render of this block. — perf
  const tabs = useMemo(() => [
    { id: 'watchlist', label: t('profilePage.tabs.watchlist'), count: watchlist.length, icon: <Film className="w-4 h-4" /> },
    { id: 'favorites', label: t('profilePage.tabs.favorites'), count: favorites.length, icon: <Heart className="w-4 h-4" /> },
    { id: 'watched', label: t('profilePage.tabs.watched'), count: watched.length, icon: <Eye className="w-4 h-4" /> },
    { id: 'in-progress', label: t('profilePage.tabs.inProgress'), count: inProgressCount, icon: <Clock className="w-4 h-4" /> },
    { id: 'alerts', label: t('profilePage.tabs.alerts'), count: alerts.length, icon: <Bell className="w-4 h-4" /> },
    { id: 'custom-lists', label: t('profilePage.tabs.customLists'), count: customLists.length, icon: <List className="w-4 h-4" /> }
  ], [t, watchlist.length, favorites.length, watched.length, inProgressCount, alerts.length, customLists.length]);

  const handleAvatarSelect = async (avatarUrl: string) => {
    // Les URLs dans avatars.ts sont déjà au bon format
    const directUrl = avatarUrl;

    // Get current auth object or create a new one
    const auth = JSON.parse(localStorage.getItem('auth') || '{}');
    const currentProfile = userProfile || {};

    const updatedProfile = {
      ...auth.userProfile,
      ...currentProfile,
      avatar: directUrl,
      lastModified: new Date().toISOString()
    };

    // Always update the auth object to maintain consistency
    localStorage.setItem('auth', JSON.stringify({
      ...auth,
      userProfile: updatedProfile
    }));

    // Update discord_user if it exists to keep sync with Header
    const discordAuth = localStorage.getItem('discord_auth');
    if (discordAuth === 'true') {
      const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
      discordUser.avatar = directUrl;
      localStorage.setItem('discord_user', JSON.stringify(discordUser));
    }

    // Update google_user if it exists
    const googleAuth = localStorage.getItem('google_auth');
    if (googleAuth === 'true') {
      const googleUser = JSON.parse(localStorage.getItem('google_user') || '{}');
      googleUser.picture = directUrl;
      localStorage.setItem('google_user', JSON.stringify(googleUser));
    }

    setUserProfile({
      ...userProfile,
      avatar: directUrl
    });
    setShowAvatarModal(false);

    // Update the active profile in ProfileContext
    if (activeProfile) {
      updateActiveProfile(activeProfile.id, { avatar: directUrl });
    }

    // Force a window storage event to notify other components
    window.dispatchEvent(new Event('profile_updated'));
    window.dispatchEvent(new Event('storage'));
  };

  const handleUsernameUpdate = async () => {
    if (newUsername.trim()) {
      // Get current auth object or create a new one
      const auth = JSON.parse(localStorage.getItem('auth') || '{}');
      const currentProfile = userProfile || {};

      const updatedProfile = {
        ...auth.userProfile,
        ...currentProfile,
        username: newUsername.trim(),
        lastModified: new Date().toISOString()
      };

      // Always update the auth object to maintain consistency
      localStorage.setItem('auth', JSON.stringify({
        ...auth,
        userProfile: updatedProfile
      }));

      // Update discord_user if it exists
      const discordAuth = localStorage.getItem('discord_auth');
      if (discordAuth === 'true') {
        const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
        discordUser.username = newUsername.trim();
        localStorage.setItem('discord_user', JSON.stringify(discordUser));
      }

      // Update google_user if it exists
      const googleAuth = localStorage.getItem('google_auth');
      if (googleAuth === 'true') {
        const googleUser = JSON.parse(localStorage.getItem('google_user') || '{}');
        googleUser.name = newUsername.trim();
        localStorage.setItem('google_user', JSON.stringify(googleUser));
      }

      setUserProfile({
        ...userProfile,
        username: newUsername.trim()
      });
      setIsEditingUsername(false);

      // Update the active profile in ProfileContext
      if (activeProfile) {
        updateActiveProfile(activeProfile.id, { name: newUsername.trim() });
      }

      // Force a window storage event to notify other components
      window.dispatchEvent(new Event('profile_updated'));
      window.dispatchEvent(new Event('storage'));
    }
  };

  // Functions for VIP key management
  const handleActivatePremiumKey = async () => {
    if (!premiumKey.trim()) return;

    // Vérifier le cooldown avant de procéder
    if (lastAttempt) {
      const elapsed = Date.now() - lastAttempt;
      if (elapsed < 30000) {
        const remaining = Math.ceil((30000 - elapsed) / 1000);
        setVipKeyError(`Veuillez attendre ${remaining} secondes avant de réessayer`);
        return;
      }
    }

    setIsActivatingKey(true);
    setVipKeyError(null);

    try {
      // Vérifier si l'utilisateur est déjà connecté via Discord ou Google
      const discordAuth = localStorage.getItem('discord_auth') === 'true';
      const googleAuth = localStorage.getItem('google_auth') === 'true';
      const alreadyAuthenticated = discordAuth || googleAuth;

      // Utiliser la fonction checkAccessCode du contexte d'authentification
      const success = await checkAccessCode(premiumKey.trim(), alreadyAuthenticated);

      if (success) {
        // La fonction checkAccessCode gère déjà la mise à jour du localStorage
        // Mettre à jour le statut VIP local
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') {
          expiration = accessCodeExpires;
        }

        setVipStatus({
          isVip: true,
          expiresAt: expiration,
          features: [t('profilePage.vip.noAds')]
        });

        // Clear the input and error
        setPremiumKey('');
        setVipKeyError(null);

        // Notify other components
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('authStateChanged'));

        console.log('Clé VIP activée avec succès');
      } else {
        // Utiliser l'erreur du contexte d'authentification ou un message par défaut
        setVipKeyError(authError || t('profilePage.vip.invalidKey'));
      }
    } catch (error) {
      console.error('Erreur lors de l\'activation de la clé VIP:', error);
      setVipKeyError(t('profilePage.vip.activationError'));
    } finally {
      setIsActivatingKey(false);
    }
  };

  const handleRemovePremiumKey = () => {
    localStorage.removeItem('is_vip');
    localStorage.removeItem('access_code');
    localStorage.removeItem('access_code_expires');

    // Update VIP status
    setVipStatus({
      isVip: false,
      features: []
    });

    // Notify other components
    window.dispatchEvent(new Event('storage'));

    console.log('Clé premium supprimée');
  };

  const copyPremiumKey = () => {
    const accessCode = localStorage.getItem('access_code');
    if (accessCode) {
      navigator.clipboard.writeText(accessCode);
      console.log('Clé copiée dans le presse-papiers');
    }
  };

  // Fonction pour gérer le changement du paramètre de scroll automatique
  const handleAutoScrollToggle = () => {
    const newValue = !disableAutoScroll;
    setDisableAutoScroll(newValue);
    localStorage.setItem('settings_disable_auto_scroll', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_auto_scroll_changed'));
  };

  // Function to toggle Smooth Scroll
  const handleSmoothScrollToggle = () => {
    const newValue = !smoothScrollEnabled;
    setSmoothScrollEnabled(newValue);
    localStorage.setItem('settings_smooth_scroll', newValue.toString());
    // Dispatch custom event to notify SmoothScroll component immediately
    window.dispatchEvent(new CustomEvent('settings_smooth_scroll_changed'));
  };

  // Function to toggle Snowfall
  const handleSnowfallToggle = () => {
    const newValue = !isSnowfallActive;
    setIsSnowfallActive(newValue);
    sessionStorage.setItem('snowfall_active', String(newValue));
    window.dispatchEvent(new CustomEvent('snowfall_toggled'));
  };

  // Screensaver handlers
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

  const copyLocalStorage = () => {
    try {
      const localStorageObj: { [key: string]: string } = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          localStorageObj[key] = localStorage.getItem(key) || '';
        }
      }
      const localStorageString = JSON.stringify(localStorageObj, null, 2);
      setLocalStorageData(localStorageString);
      setShowLocalStoragePopup(true);
    } catch (error) {
      console.error('Erreur lors de la copie du localStorage:', error);
    }
  };

  const handleCloseIdPopup = () => {
    setIsClosingIdPopup(true);
    setTimeout(() => {
      setShowIdPopup(false);
      setIsClosingIdPopup(false);
    }, 300);
  };

  const handleCloseLocalStoragePopup = () => {
    setIsClosingLocalStoragePopup(true);
    setTimeout(() => {
      setShowLocalStoragePopup(false);
      setIsClosingLocalStoragePopup(false);
    }, 300);
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
    if (!importData.trim()) {
      setImportError(t('profilePage.import.enterData'));
      return;
    }

    try {
      // Parse the JSON data
      const data = JSON.parse(importData);
      let importedCount = 0;
      const errors: string[] = [];

      // Process each key-value pair
      Object.entries(data).forEach(([key, value]) => {
        try {
          if (typeof value === 'string') {
            // Try to parse as JSON first
            try {
              const parsedValue = JSON.parse(value);

              if (Array.isArray(parsedValue)) {
                if (PROFILE_IMPORT_PRESERVED_ARRAY_KEYS.has(key)) {
                  localStorage.setItem(key, JSON.stringify(parsedValue));
                  importedCount++;
                  return;
                }

                // Convert the array to our format
                const convertedArray = parsedValue.map((item: any) => {
                  if (item.episodeInfo) {
                    // This is an episode item, convert to our format
                    return {
                      id: item.id,
                      type: item.type,
                      title: item.title || '',
                      poster_path: item.poster_path || '',
                      episodeInfo: item.episodeInfo,
                      addedAt: item.addedAt || new Date().toISOString()
                    };
                  } else {
                    // Regular item
                    return {
                      id: item.id,
                      type: item.type,
                      title: item.title || item.name || '',
                      poster_path: item.poster_path || '',
                      addedAt: item.addedAt || new Date().toISOString()
                    };
                  }
                });

                // Store in localStorage
                localStorage.setItem(key, JSON.stringify(convertedArray));
                importedCount++;
              } else {
                // Single object or other value (like progress data)
                localStorage.setItem(key, JSON.stringify(parsedValue));
                importedCount++;
              }
            } catch (parseError) {
              // If JSON.parse fails, it's a regular string value
              localStorage.setItem(key, value);
              importedCount++;
            }
          } else {
            // Direct value (object, array, etc.)
            localStorage.setItem(key, JSON.stringify(value));
            importedCount++;
          }
        } catch (itemError) {
          errors.push(`Erreur lors du traitement de la clé "${key}": ${itemError}`);
        }
      });

      if (errors.length > 0) {
        setImportError(`Importation partielle réussie. ${importedCount} clés importées. Erreurs: ${errors.join(', ')}`);
      } else {
        setImportSuccess(`Importation réussie ! ${importedCount} clés ont été importées.`);
      }

      // Reload the profile data to reflect changes
      setTimeout(() => {
        window.location.reload();
      }, 2000);

    } catch (error) {
      setImportError(`Erreur lors de l'analyse des données JSON: ${error}`);
    }
  };







  const handleDataCollectionToggle = () => {
    const newValue = !dataCollection;
    setDataCollection(newValue);
    localStorage.setItem('privacy_data_collection', String(newValue));
  };

  const renderProfileHeader = () => (
    <div className="relative mb-12 overflow-hidden rounded-3xl shadow-2xl shadow-black/30">
      {/* Background with enhanced gradients */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-red-600/20 via-gray-900/90 to-gray-900  z-0"></div>
      </div>

      <div className="relative z-10 p-4 sm:p-6">
        <motion.div
          className="flex flex-col md:flex-row items-center gap-4 sm:gap-6 md:gap-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Enhanced Avatar Section */}
          <motion.div
            className="relative group"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <div className="avatar-border absolute inset-0 rounded-full w-24 h-24 sm:w-32 sm:h-32 md:w-40 md:h-40 animate-border-pulse"></div>
            <motion.div
              className="w-24 h-24 sm:w-32 sm:h-32 md:w-40 md:h-40 rounded-full overflow-hidden transition-colors border-2 border-red-600/70 shadow-lg shadow-red-600/20"
              whileHover={{ scale: 1.05 }}
            >
              <img
                src={activeProfile?.avatar || userProfile.avatar || 'https://via.placeholder.com/150'}
                alt={t('header.profile')}
                className="w-full h-full object-cover transform transition-transform duration-300 hover:scale-110 filter group-hover:brightness-110"
              />
              {/* Overlay effect on hover */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            </motion.div>

            {/* Camera button with glass effect */}
            <motion.button
              whileHover={{ scale: 1.1, rotate: 5 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setShowAvatarModal(true)}
              className="absolute bottom-1 right-1 p-2 sm:p-3 bg-red-600/90 rounded-full text-white hover:bg-red-700 transition-colors shadow-lg shadow-red-600/30 hover:shadow-red-600/50 border border-red-500/30"
            >
              <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
            </motion.button>
          </motion.div>

          {/* User Info Section with enhanced styling */}
          <div className="flex flex-col items-center md:items-start gap-3 sm:gap-4 md:gap-5 flex-1 w-full">
            <div className="w-full">
              {isEditingUsername ? (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col sm:flex-row items-center gap-3 w-full bg-gray-800/50 p-3 rounded-xl border border-gray-700/50"
                >
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="bg-gray-800/70 text-white px-4 py-2 rounded-xl w-full md:w-auto focus:ring-2 focus:ring-red-500 outline-none transition-colors border border-gray-700"
                    autoFocus
                    placeholder={t('profilePage.header.usernamePlaceholder')}
                    maxLength={32}
                  />
                  <div className="flex gap-2 mt-3 sm:mt-0 w-full sm:w-auto">
                    <button
                      onClick={handleUsernameUpdate}
                      className="bg-green-600 text-white px-4 py-2 rounded-xl flex-1 sm:flex-none hover:bg-green-700 transition-colors font-medium"
                    >
                      {t('profilePage.header.save')}
                    </button>
                    <button
                      onClick={() => setIsEditingUsername(false)}
                      className="bg-gray-600 text-white px-4 py-2 rounded-xl flex-1 sm:flex-none hover:bg-gray-700 transition-colors font-medium"
                    >
                      {t('profilePage.header.cancel')}
                    </button>
                  </div>
                </motion.div>
              ) : (
                <div className="flex flex-col items-center md:items-start gap-3 group w-full">
                  {/* Username and edit button row */}
                  <div className="flex items-center gap-2 justify-center md:justify-start w-full">
                    <h2
                      className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent transition-colors text-center md:text-left"
                    >
                      {activeProfile?.name || userProfile.username}
                    </h2>
                    <button
                      onClick={() => setIsEditingUsername(true)}
                      className="text-gray-400 hover:text-white bg-gray-800/50 p-2 rounded-full hover:bg-gray-700/70 transition-colors flex-shrink-0"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>




            {/* Stats Section with glass effect cards */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="w-full stats-container grid grid-cols-3 gap-2 sm:gap-4 py-3 sm:py-5 px-2 sm:px-4 bg-gray-800/40 rounded-xl border border-gray-700/50 shadow-lg transition-colors"
            >
              <motion.div
                className="stat-item flex flex-col items-center p-2 sm:p-4 rounded-xl bg-gray-700/40 hover:bg-gray-700/60 transition-colors border border-gray-700/30"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.99 }}
              >
                <motion.span
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400 }}
                  className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-400 to-red-600 bg-clip-text text-transparent"
                >
                  {watchlist.length}
                </motion.span>
                <span className="text-[10px] sm:text-xs md:text-sm text-gray-400 mt-1">{t('profilePage.stats.watchlist')}</span>
              </motion.div>

              <motion.div
                className="stat-item flex flex-col items-center p-2 sm:p-4 rounded-xl bg-gray-700/40 hover:bg-gray-700/60 transition-colors border border-gray-700/30"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.99 }}
              >
                <motion.span
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, delay: 0.1 }}
                  className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-400 to-red-600 bg-clip-text text-transparent"
                >
                  {favorites.length}
                </motion.span>
                <span className="text-[10px] sm:text-xs md:text-sm text-gray-400 mt-1">{t('profilePage.stats.favorites')}</span>
              </motion.div>

              <motion.div
                className="stat-item flex flex-col items-center p-2 sm:p-4 rounded-xl bg-gray-700/40 hover:bg-gray-700/60 transition-colors border border-gray-700/30"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.99 }}
              >
                <motion.span
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, delay: 0.2 }}
                  className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-400 to-red-600 bg-clip-text text-transparent"
                >
                  {watched.length}
                </motion.span>
                <span className="text-[10px] sm:text-xs md:text-sm text-gray-400 mt-1">{t('profilePage.stats.watched')}</span>
              </motion.div>
            </motion.div>



          </div>
        </motion.div>
      </div>
    </div>
  );



  const filteredMainItems = useMemo(() => {
    if (activeTab === 'watchlist') return watchlistFilter.filteredItems;
    if (activeTab === 'favorites') return favoritesFilter.filteredItems;
    if (activeTab === 'watched') return watchedFilter.filteredItems;
    return [];
  }, [
    activeTab,
    watchlistFilter.filteredItems,
    favoritesFilter.filteredItems,
    watchedFilter.filteredItems
  ]);

  const getWatchItemPath = useCallback((item: WatchItem) => {
    if (item.type === 'shared-list') {
      return `/list/${encodeURIComponent(item.shareCode || String(item.id))}`;
    }

    if (item.type === 'live-tv') {
      const source = item.source?.trim();
      const targetId = item.liveTvTargetId?.trim();

      if (!source || !targetId || !item.liveTvKind) {
        return '/live-tv';
      }

      const params = new URLSearchParams({
        source,
        targetId,
        kind: item.liveTvKind,
      });

      if (item.liveTvCatalogId) {
        params.set('catalogId', item.liveTvCatalogId);
      }

      if (item.liveTvCategoryId) {
        params.set('categoryId', item.liveTvCategoryId);
      }

      return `/live-tv?${params.toString()}`;
    }

    if (item.type === 'collection' && typeof item.id === 'number') {
      return `/collection/${item.id}`;
    }

    if (item.type === 'movie' && typeof item.id === 'number') {
      return `/movie/${encodeId(item.id)}`;
    }

    if (item.type === 'tv' && typeof item.id === 'number') {
      return `/tv/${encodeId(item.id)}`;
    }

    return '/';
  }, []);

  const getWatchItemTypeLabel = useCallback((item: WatchItem) => {
    if (item.type === 'movie') return t('profilePage.media.movie');
    if (item.type === 'tv') return t('profilePage.media.series');
    if (item.type === 'collection') return t('profilePage.media.collection');
    if (item.type === 'shared-list') return t('profilePage.media.sharedList');
    return t('profilePage.media.liveTV');
  }, [t]);

  const getWatchItemBadgeClassName = useCallback((item: WatchItem) => {
    if (item.type === 'movie') return 'bg-blue-600 text-white';
    if (item.type === 'tv') return 'bg-green-600 text-white';
    if (item.type === 'collection') return 'bg-purple-600 text-white';
    if (item.type === 'shared-list') return 'bg-amber-500 text-black';
    return 'bg-cyan-500 text-black';
  }, []);

  const getWatchItemSubtitle = useCallback((item: WatchItem) => {
    if (item.type === 'shared-list') {
      const details: string[] = [];
      if (item.username) {
        details.push(`@${item.username}`);
      }
      if (typeof item.itemCount === 'number') {
        details.push(t('lists.itemCount', { count: item.itemCount }));
      }
      return details.join(' • ');
    }

    if (item.type === 'live-tv') {
      return item.source === 'iptv' ? t('liveTV.iptvWebSource') : t('nav.liveTV');
    }

    return '';
  }, [t]);

  const groupedMainItems = useMemo(() => {
    return filteredMainItems.reduce((acc: { [key: string]: WatchItem[] }, item) => {
      if (isTvWatchItem(item)) {
        const key = `tv-${item.id}`;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(item);
      } else {
        const key = getWatchItemKey(item);
        acc[key] = [item];
      }
      return acc;
    }, {});
  }, [filteredMainItems]);

  // Memoize the per-season grouping for the currently-expanded TV show.
  // Previously this ran inside two IIFEs nested in the .map over groupedItems,
  // re-bucketing every episode key on every Profile render — O(items × episodes).
  // Only the expanded show contributes data, so a single memo keyed on
  // detailedTvShowEpisodes is enough.
  const groupedExpandedSeasons = useMemo(() => {
    if (!detailedTvShowEpisodes) {
      return { watched: {} as Record<number, string[]>, watchlist: {} as Record<number, string[]> };
    }
    return {
      watched: groupEpisodesBySeason(detailedTvShowEpisodes.watched),
      watchlist: groupEpisodesBySeason(detailedTvShowEpisodes.watchlist),
    };
  }, [detailedTvShowEpisodes]);

  const removeFromMainList = useCallback((
    itemId: number | string,
    itemType: WatchItem['type'],
    listType: 'watchlist' | 'favorites' | 'watched'
  ) => {
    let key: string;
    if (listType === 'favorites') {
      if (itemType === 'movie') {
        key = 'favorite_movie';
      } else if (itemType === 'tv') {
        key = 'favorites_tv';
      } else if (itemType === 'shared-list') {
        key = SHARED_LIST_FAVORITES_STORAGE_KEY;
      } else if (itemType === 'live-tv') {
        key = LIVE_TV_FAVORITES_STORAGE_KEY;
      } else {
        key = 'favorite_collections';
      }
    } else if (itemType === 'collection') {
      key = `${listType}_collections`;
    } else {
      key = `${listType}_${itemType}`;
    }

    const listItems = JSON.parse(localStorage.getItem(key) || '[]');
    const updatedItems = listItems.filter((item: any) => {
      if (itemType === 'shared-list') {
        return item.shareCode !== itemId;
      }
      if (itemType === 'live-tv') {
        return item.key !== itemId;
      }
      return item.id !== itemId;
    });
    localStorage.setItem(key, JSON.stringify(updatedItems));

    if (itemType === 'tv' && (listType === 'watched' || listType === 'watchlist')) {
      const episodesArrayKey = `${listType}_tv_episodes`;
      const episodesArray = JSON.parse(localStorage.getItem(episodesArrayKey) || '[]');
      const updatedEpisodesArray = episodesArray.filter((ep: WatchItem) => ep.id !== itemId);
      localStorage.setItem(episodesArrayKey, JSON.stringify(updatedEpisodesArray));
      localStorage.removeItem(`${listType}_episodes_tv_${itemId}`);
    }

    const updateState = (setter: React.Dispatch<React.SetStateAction<WatchItem[]>>) => {
      setter((prev) => prev.filter((item) => !(item.id === itemId && item.type === itemType)));
    };

    if (listType === 'watchlist') {
      updateState(setWatchlist);
    } else if (listType === 'favorites') {
      updateState(setFavorites);
    } else {
      updateState(setWatched);
    }
  }, []);

  const renderContent = () => {
    if (activeTab === 'custom-lists') {
      return renderCustomLists();
    }

    if (activeTab === 'alerts') {
      console.log('Rendering alerts tab, alerts count:', alerts.length);
      try {
        const result = renderAlerts();
        console.log('renderAlerts result:', result);
        return result;
      } catch (error) {
        console.error('Error in renderAlerts:', error);
        return <div>{t('profilePage.alerts.errorLoading')}</div>;
      }
    }

    // Utiliser les éléments filtrés selon l'onglet actif
    const items = filteredMainItems;

    // If no items, show empty state message
    if (items.length === 0) {
      return renderEmptyState(activeTab);
    }

    // Show loading state if we're fetching metadata
    if (loadingMetadata && activeTab === 'watched') {
      return (
        <div className="flex justify-center items-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-600"></div>
          <span className="ml-3 text-gray-300">{t('profilePage.media.loadingMetadata')}</span>
        </div>
      );
    }

    const groupedItems = groupedMainItems;

    const removeFromList = removeFromMainList;

    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 p-4 relative z-0">
        {Object.entries(groupedItems).map(([key, items]) => {
          const item = items[0]; // Assuming items[0] is the representative item for the group
          const cardPath = getWatchItemPath(item);
          const badgeClassName = getWatchItemBadgeClassName(item);
          const typeLabel = getWatchItemTypeLabel(item);
          const subtitle = getWatchItemSubtitle(item);
          const posterSrc = resolveWatchItemPosterSrc(item);
          const isExpandedTvCard = isTvWatchItem(item) && expandedTvShowId === item.id && detailedTvShowEpisodes;

          const handleCardClick = () => {
            if (isTvWatchItem(item)) {
              if (expandedTvShowId === item.id) {
                // Si la série est déjà étendue, naviguer vers sa page détails
                navigate(cardPath);
              } else {
                setExpandedTvShowId(item.id);
                setExpandedSeasons(new Set()); // Reset expanded seasons for new show
                fetchTvShowEpisodeDetails(item.id);
              }
            } else {
              navigate(cardPath);
            }
          };

          const formatEpisodeKey = (epKey: string) => {
            const match = epKey.match(/S(\d+)E(\d+)/i);
            if (match && match[1] && match[2]) {
              return t('profilePage.episodes.formatEpisode', { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) });
            }
            return epKey;
          };

          const removeEpisodeStatus = (tvShowId: number, episodeKey: string, listType: 'watched' | 'watchlist') => {
            const storageKey = `${listType}_episodes_tv_${tvShowId}`;
            try {
              // Convertir la clé au format utilisé dans localStorage (S1E1)
              // episodeKey est au format "s1e1" ici
              const match = episodeKey.match(/s(\d+)e(\d+)/i);
              const storageEpisodeKey = match ? `S${match[1]}E${match[2]}` : episodeKey;

              const episodeData = JSON.parse(localStorage.getItem(storageKey) || '{}');
              delete episodeData[storageEpisodeKey];
              localStorage.setItem(storageKey, JSON.stringify(episodeData));

              // Update local state to reflect removal
              setDetailedTvShowEpisodes(prev => {
                if (!prev) return null;
                const updatedList = { ...prev[listType] };
                delete updatedList[episodeKey]; // Note: ici on utilise la clé minuscule pour l'état
                return {
                  ...prev,
                  [listType]: updatedList
                };
              });
            } catch (error) {
              console.error(`Error removing episode ${episodeKey} from ${listType} localStorage:`, error);
            }
          };

          return (
            <div key={key} className="flex flex-col">
              <div
                className="relative group bg-gray-900/70 rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition-colors border border-gray-800/50 cursor-pointer"
                onClick={handleCardClick} // Add click handler here
              >
                {/* Badge de type (film/série/collection) et bouton de suppression mobile toujours visible */}
                <div className="absolute top-0 left-0 right-0 flex justify-between items-start p-2 z-10">
                  <span className={`text-xs py-1 px-2 rounded font-medium ${badgeClassName}`}>
                    {typeLabel}
                  </span>
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent card click when deleting
                      removeFromList(item.id, item.type, activeTab as 'watchlist' | 'favorites' | 'watched');
                    }}
                    className="bg-gradient-to-r from-red-600 to-red-700 text-white p-1.5 md:p-2 rounded-full md:opacity-0 md:group-hover:opacity-100 transition-colors hover:from-red-700 hover:to-red-800 shadow-lg"
                    aria-label={t('profilePage.media.delete')}
                  >
                    <X className="w-3.5 h-3.5 md:w-4 md:h-4" />
                  </motion.button>
                </div>

                {/* Image and Overlay - Removed Link wrapping this part */}
                <div className="aspect-[2/3] relative overflow-hidden">
                  {posterSrc ? (
                    <img
                      src={posterSrc}
                      alt={item.title}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                        event.currentTarget.parentElement?.querySelector<HTMLElement>('[data-profile-card-fallback]')?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <div
                    data-profile-card-fallback
                    className={`absolute inset-0 ${posterSrc ? 'hidden' : ''} bg-gradient-to-br from-gray-800 via-gray-900 to-black flex flex-col items-center justify-center p-4 text-center`}
                  >
                    {item.type === 'shared-list' ? (
                      <Share2 className="w-10 h-10 text-amber-300 mb-3" />
                    ) : item.type === 'live-tv' ? (
                      <Monitor className="w-10 h-10 text-cyan-300 mb-3" />
                    ) : item.type === 'collection' ? (
                      <List className="w-10 h-10 text-purple-300 mb-3" />
                    ) : item.type === 'tv' ? (
                      <Monitor className="w-10 h-10 text-green-300 mb-3" />
                    ) : (
                      <Film className="w-10 h-10 text-blue-300 mb-3" />
                    )}
                    <span className="text-white/85 text-xs font-medium line-clamp-3">
                      {item.type === 'collection' ? item.name || item.title : item.title}
                    </span>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <div className="absolute top-2 left-2">
                      <span className={`text-xs py-1 px-2 rounded font-medium ${badgeClassName}`}>
                        {typeLabel}
                      </span>
                    </div>
                    <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                      {/* Title now acts as a link */}
                      <Link
                        to={cardPath}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        <h3 className="text-white font-bold text-sm mb-1 line-clamp-2">
                          {item.type === 'collection' ? item.name || item.title : item.title}
                        </h3>
                      </Link>
                      {subtitle && (
                        <p className="text-[11px] text-white/70 line-clamp-2">
                          {subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Episode Subsection - Only for TV shows */}
              {isExpandedTvCard && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-gray-800/50 p-3 rounded-b-lg mt-0.5 text-xs" // Adjusted styling
                >
                  {activeTab === 'watched' && (
                    <>
                      {!isAnimeShow(item.id) && detailedTvShowEpisodes.isFullSeriesWatched ? (
                        <div className="flex items-center justify-center py-3">
                          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600/20 text-green-300 font-medium">
                            <Eye size={16} />
                            <span>{t('profilePage.episodes.watchedEntireSeries')}</span>
                          </div>
                        </div>
                      ) : Object.keys(detailedTvShowEpisodes.watched).length > 0 ? (
                        <div className="mb-2">
                          <h4 className="font-semibold text-gray-300 mb-1">{t('profilePage.episodes.episodesWatched')}</h4>
                          {(() => {
                            const seasons = groupedExpandedSeasons.watched;
                            return Object.keys(seasons).map(seasonNum => {
                              const season = parseInt(seasonNum);
                              const episodes = seasons[season];

                              // Handle ungrouped episodes (season -1)
                              if (season === -1) {
                                return (
                                  <div key="ungrouped" className="mb-3">
                                    <button
                                      onClick={() => toggleSeasonExpansion(item.id, -1)}
                                      className="flex items-center justify-between w-full text-left hover:bg-gray-700/30 rounded-lg p-2 transition-colors duration-200"
                                    >
                                      <h5 className="text-gray-300 font-medium text-xs uppercase tracking-wide">
                                        {t('profilePage.episodes.otherEpisodes', { count: episodes.length })}
                                      </h5>
                                      <motion.div
                                        animate={{ rotate: isSeasonExpanded(item.id, -1) ? 90 : 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="text-gray-400"
                                      >
                                        <ArrowLeft className="w-3 h-3" />
                                      </motion.div>
                                    </button>

                                    {isSeasonExpanded(item.id, -1) && (
                                      <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="mt-2 ml-3"
                                      >
                                        <ul className="space-y-1">
                                          {episodes.map(epKey => (
                                            <li key={`watched-${epKey}`} className="text-gray-400 flex justify-between items-center group">
                                              <span className="text-xs">{epKey}</span>
                                              <button
                                                onClick={() => removeEpisodeStatus(item.id, epKey, 'watched')}
                                                className="p-1 rounded-md hover:bg-red-700/30 text-gray-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 ml-2"
                                                aria-label={t('profilePage.episodes.removeFromWatched')}
                                              >
                                                <TrashIcon size={14} />
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      </motion.div>
                                    )}
                                  </div>
                                );
                              }

                              return (
                                <div key={`season-${season}`} className="mb-3">
                                  <button
                                    onClick={() => toggleSeasonExpansion(item.id, season)}
                                    className="flex items-center justify-between w-full text-left hover:bg-gray-700/30 rounded-lg p-2 transition-colors duration-200"
                                  >
                                    <h5 className="text-gray-300 font-medium text-xs uppercase tracking-wide">
                                      {t('profilePage.episodes.seasonEpisodes', { season, count: episodes.length })}
                                    </h5>
                                    <motion.div
                                      animate={{ rotate: isSeasonExpanded(item.id, season) ? 90 : 0 }}
                                      transition={{ duration: 0.2 }}
                                      className="text-gray-400"
                                    >
                                      <ArrowLeft className="w-3 h-3" />
                                    </motion.div>
                                  </button>

                                  {isSeasonExpanded(item.id, season) && (
                                    <motion.div
                                      initial={{ opacity: 0, height: 0 }}
                                      animate={{ opacity: 1, height: 'auto' }}
                                      exit={{ opacity: 0, height: 0 }}
                                      transition={{ duration: 0.2 }}
                                      className="mt-2 ml-3"
                                    >
                                      <ul className="space-y-1">
                                        {episodes.map(epKey => (
                                          <li key={`watched-${epKey}`} className="text-gray-400 flex justify-between items-center group">
                                            <span className="text-xs">{formatEpisodeKey(epKey)}</span>
                                            <button
                                              onClick={() => removeEpisodeStatus(item.id, epKey, 'watched')}
                                              className="p-1 rounded-md hover:bg-red-700/30 text-gray-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 ml-2"
                                              aria-label={t('profilePage.episodes.removeFromWatched')}
                                            >
                                              <TrashIcon size={14} />
                                            </button>
                                          </li>
                                        ))}
                                      </ul>
                                    </motion.div>
                                  )}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      ) : (
                        <p className="text-gray-500 italic">{t('profilePage.episodes.noEpisodeWatched')}</p>
                      )}
                    </>
                  )}

                  {activeTab === 'watchlist' && (
                    <>
                      {!isAnimeShow(item.id) && detailedTvShowEpisodes.isFullSeriesInWatchlist ? (
                        <div className="flex items-center justify-center py-3">
                          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600/20 text-blue-300 font-medium">
                            <List size={16} />
                            <span>{t('profilePage.episodes.entireSeriesInWatchlist')}</span>
                          </div>
                        </div>
                      ) : Object.keys(detailedTvShowEpisodes.watchlist).length > 0 ? (
                        <div>
                          <h4 className="font-semibold text-gray-300 mb-1">{t('profilePage.episodes.episodesInWatchlist')}</h4>
                          {(() => {
                            const seasons = groupedExpandedSeasons.watchlist;
                            return Object.keys(seasons).map(seasonNum => {
                              const season = parseInt(seasonNum);
                              const episodes = seasons[season];

                              // Handle ungrouped episodes (season -1)
                              if (season === -1) {
                                return (
                                  <div key="ungrouped" className="mb-3">
                                    <button
                                      onClick={() => toggleSeasonExpansion(item.id, -1)}
                                      className="flex items-center justify-between w-full text-left hover:bg-gray-700/30 rounded-lg p-2 transition-colors duration-200"
                                    >
                                      <h5 className="text-gray-300 font-medium text-xs uppercase tracking-wide">
                                        {t('profilePage.episodes.otherEpisodes', { count: episodes.length })}
                                      </h5>
                                      <motion.div
                                        animate={{ rotate: isSeasonExpanded(item.id, -1) ? 90 : 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="text-gray-400"
                                      >
                                        <ArrowLeft className="w-3 h-3" />
                                      </motion.div>
                                    </button>

                                    {isSeasonExpanded(item.id, -1) && (
                                      <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="mt-2 ml-3"
                                      >
                                        <ul className="space-y-1">
                                          {episodes.map(epKey => (
                                            <li key={`watchlist-${epKey}`} className="text-gray-400 flex justify-between items-center group">
                                              <span className="text-xs">{epKey}</span>
                                              <button
                                                onClick={() => removeEpisodeStatus(item.id, epKey, 'watchlist')}
                                                className="p-1 rounded-md hover:bg-red-700/30 text-gray-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 ml-2"
                                                aria-label={t('profilePage.episodes.removeFromWatchlist')}
                                              >
                                                <TrashIcon size={14} />
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      </motion.div>
                                    )}
                                  </div>
                                );
                              }

                              return (
                                <div key={`season-${season}`} className="mb-3">
                                  <button
                                    onClick={() => toggleSeasonExpansion(item.id, season)}
                                    className="flex items-center justify-between w-full text-left hover:bg-gray-700/30 rounded-lg p-2 transition-colors duration-200"
                                  >
                                    <h5 className="text-gray-300 font-medium text-xs uppercase tracking-wide">
                                      {t('profilePage.episodes.seasonEpisodes', { season, count: episodes.length })}
                                    </h5>
                                    <motion.div
                                      animate={{ rotate: isSeasonExpanded(item.id, season) ? 90 : 0 }}
                                      transition={{ duration: 0.2 }}
                                      className="text-gray-400"
                                    >
                                      <ArrowLeft className="w-3 h-3" />
                                    </motion.div>
                                  </button>

                                  {isSeasonExpanded(item.id, season) && (
                                    <motion.div
                                      initial={{ opacity: 0, height: 0 }}
                                      animate={{ opacity: 1, height: 'auto' }}
                                      exit={{ opacity: 0, height: 0 }}
                                      transition={{ duration: 0.2 }}
                                      className="mt-2 ml-3"
                                    >
                                      <ul className="space-y-1">
                                        {episodes.map(epKey => (
                                          <li key={`watchlist-${epKey}`} className="text-gray-400 flex justify-between items-center group">
                                            <span className="text-xs">{formatEpisodeKey(epKey)}</span>
                                            <button
                                              onClick={() => removeEpisodeStatus(item.id, epKey, 'watchlist')}
                                              className="p-1 rounded-md hover:bg-red-700/30 text-gray-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 ml-2"
                                              aria-label={t('profilePage.episodes.removeFromWatchlist')}
                                            >
                                              <TrashIcon size={14} />
                                            </button>
                                          </li>
                                        ))}
                                      </ul>
                                    </motion.div>
                                  )}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      ) : (
                        <p className="text-gray-500 italic">{t('profilePage.episodes.noEpisodeInWatchlist')}</p>
                      )}
                    </>
                  )}

                  {activeTab === 'favorites' && (
                    <p className="text-gray-500 italic">{t('profilePage.episodes.favoritesApplyToSeries')}</p>
                  )}
                </motion.div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Render in-progress (en cours) section
  const renderInProgress = () => {
    if (loadingInProgress) {
      return (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-blue-500"></div>
        </div>
      );
    }

    if (inProgress.length === 0) {
      return renderEmptyState('in-progress');
    }

    const itemsToDisplay = inProgressFilter.filteredItems;

    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 px-2 md:px-4 relative z-0">
        {itemsToDisplay.map(item => (
          <AgeRestrictedMedia key={`in-progress-${item.id}`} item={{ ...item, media_type: 'tv' }}>
          <div
            key={`in-progress-${item.id}`}
            className="relative group bg-gray-900/70 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-colors border border-gray-800/50"
          >
            <Link to={`/tv/${item.id}`}>
              <div className="aspect-[2/3] relative overflow-hidden">
                <img
                  src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                  alt={item.title}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-colors">
                  <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                    <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">{item.title}</h3>
                    {item.episodeInfo && (
                      <p className="text-blue-400 text-xs font-medium mb-2">
                        S{item.episodeInfo.season} E{item.episodeInfo.episode}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1 text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                        <Play className="w-3 h-3" />
                        {t('profilePage.progress.continue')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </Link>

            {/* Badge En Cours */}
            <div className="absolute top-2 left-2 z-10">
              <span className="flex items-center gap-1 text-xs py-1 px-2 rounded font-medium bg-blue-600 text-white">
                <Clock className="w-3 h-3" />
                {t('profilePage.progress.inProgressBadge')}
              </span>
            </div>

            {/* Episode Info Badge */}
            {item.episodeInfo && (
              <div className="absolute top-2 right-2 z-10">
                <span className="text-xs py-1 px-2 rounded font-medium bg-gray-800/80 text-white">
                  S{item.episodeInfo.season}E{item.episodeInfo.episode}
                </span>
              </div>
            )}
          </div>
          </AgeRestrictedMedia>
        ))}
      </div>
    );
  };

  const handleDeleteList = (listId: number) => {
    const updatedLists = customLists.filter(list => list.id !== listId);
    setCustomLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
    if (selectedList && selectedList.id === listId) {
      setSelectedList(null);
    }
  };

  const handleRenameList = (listId: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const updatedLists = customLists.map(list =>
      list.id === listId ? { ...list, name: trimmed } : list
    );
    setCustomLists(updatedLists);
    if (selectedList && selectedList.id === listId) {
      setSelectedList({ ...selectedList, name: trimmed });
    }
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
    setRenamingListId(null);
    setRenamingListName('');
  };

  const startRenaming = (listId: number, currentName: string) => {
    setRenamingListId(listId);
    setRenamingListName(currentName);
  };

  const cancelRenaming = () => {
    setRenamingListId(null);
    setRenamingListName('');
  };

  // === Drag & Drop ===
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleListDragStart = (event: DragStartEvent) => {
    setActiveListDragId(String(event.active.id));
  };

  const handleListDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveListDragId(null);
    if (!over || active.id === over.id) return;
    const oldIndex = customLists.findIndex(l => String(l.id) === String(active.id));
    const newIndex = customLists.findIndex(l => String(l.id) === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(customLists, oldIndex, newIndex);
    setCustomLists(reordered);
    localStorage.setItem('custom_lists', JSON.stringify(reordered));
  };

  const handleListDragCancel = () => {
    setActiveListDragId(null);
  };

  const handleItemDragStart = (event: DragStartEvent) => {
    setActiveItemDragId(String(event.active.id));
  };

  const handleItemDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveItemDragId(null);
    if (!selectedList || !over || active.id === over.id) return;
    const items = selectedList.items;
    const oldIndex = items.findIndex(i => `${i.type}-${i.id}` === String(active.id));
    const newIndex = items.findIndex(i => `${i.type}-${i.id}` === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedItems = arrayMove(items, oldIndex, newIndex);
    const updatedList = { ...selectedList, items: reorderedItems };
    setSelectedList(updatedList);
    const updatedLists = customLists.map(l =>
      l.id === selectedList.id ? updatedList : l
    );
    setCustomLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
  };

  const handleItemDragCancel = () => {
    setActiveItemDragId(null);
  };

  const handleCreateList = (name: string) => {
    const newList = {
      id: Date.now(),
      name,
      items: []
    };

    const updatedLists = [...customLists, newList];
    setCustomLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
    setShowNewListModal(false);
  };

  const handleRemoveFromList = (listId: number, itemId: number) => {
    const updatedLists = customLists.map(list => {
      if (list.id === listId) {
        return {
          ...list,
          items: list.items.filter(item => item.id !== itemId)
        };
      }
      return list;
    });

    setCustomLists(updatedLists);
    setSelectedList(updatedLists.find(list => list.id === listId) || null);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
  };

  // === Turnstile managed pour le partage ===
  useEffect(() => {
    if (shareTurnstileBypass === 'bypass') {
      setShareTurnstileToken(ADMIN_BYPASS_TOKEN);
      return;
    }
    // Statut encore inconnu : on n'affiche rien plutôt qu'un challenge à
    // retirer juste après.
    if (shareTurnstileBypass === 'unknown') return;
    if (!TURNSTILE_SITE_KEY || !selectedList) return;

    // Nettoyer l'ancien widget
    if (shareTurnstileWidgetId.current && window.turnstile) {
      try { window.turnstile.remove(shareTurnstileWidgetId.current); } catch { /* ignore */ }
      shareTurnstileWidgetId.current = null;
      setShareTurnstileToken('');
    }

    const doRender = () => {
      if (!shareTurnstileRef.current || shareTurnstileWidgetId.current) return;
      if (window.turnstile) {
        shareTurnstileWidgetId.current = window.turnstile.render(shareTurnstileRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          callback: (token: string) => setShareTurnstileToken(token),
          'expired-callback': () => setShareTurnstileToken(''),
          'error-callback': () => setShareTurnstileToken(''),
        });
      }
    };

    // Petit délai pour que le DOM soit prêt après le render React
    const timer = setTimeout(() => {
      if (window.turnstile) {
        doRender();
      } else {
        const interval = setInterval(() => {
          if (window.turnstile) {
            clearInterval(interval);
            doRender();
          }
        }, 200);
        setTimeout(() => clearInterval(interval), 10000);
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      if (shareTurnstileWidgetId.current && window.turnstile) {
        try { window.turnstile.remove(shareTurnstileWidgetId.current); } catch { /* ignore */ }
        shareTurnstileWidgetId.current = null;
        setShareTurnstileToken('');
      }
    };
  }, [selectedList, shareTurnstileBypass]);

  const resetShareTurnstile = useCallback(() => {
    // Un dispensé n'a rien à réinitialiser : effacer le marqueur rebloquerait
    // le partage suivant.
    if (shareTurnstileBypass !== 'challenge') return;

    setShareTurnstileToken('');
    if (shareTurnstileWidgetId.current && window.turnstile) {
      window.turnstile.reset(shareTurnstileWidgetId.current);
    }
  }, [shareTurnstileBypass]);

  // === Share list functions ===
  const getProfileId = (): string | null => {
    return localStorage.getItem('selected_profile_id');
  };

  const loadSharedListsStatus = useCallback(async () => {
    try {
      const profileId = getProfileId();
      const token = localStorage.getItem('auth_token');
      if (!profileId || !token) return;

      const response = await axios.get(`${API_URL}/api/shared-lists/share/status`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { profileId }
      });

      if (response.data?.shared) {
        setSharedListsStatus(response.data.shared);
      }
    } catch (err) {
      console.error('Erreur chargement statut partage:', err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && activeTab === 'custom-lists') {
      loadSharedListsStatus();
    }
  }, [isAuthenticated, activeTab, loadSharedListsStatus]);

  const handleShareList = async (listId: number, publishToCatalog: boolean) => {
    try {
      const profileId = getProfileId();
      const token = localStorage.getItem('auth_token');
      if (!profileId || !token) return;
      if (TURNSTILE_SITE_KEY && !shareTurnstileToken) return;

      setSharingListId(listId);

      const response = await axios.post(`${API_URL}/api/shared-lists/share`, {
        profileId,
        listId: String(listId),
        publishToCatalog,
        turnstileToken: shareTurnstileToken
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // Reset Turnstile pour le prochain partage
      resetShareTurnstile();

      if (response.data?.shareCode) {
        const shareCode = response.data.shareCode;
        setSharedListsStatus(prev => ({
          ...prev,
          [String(listId)]: {
            shareCode,
            sharedAt: Date.now(),
            isPublicInCatalog: !!response.data?.isPublicInCatalog
          }
        }));

        // Copier le lien automatiquement
        const shareUrl = `${window.location.origin}/list/${shareCode}`;
        await navigator.clipboard.writeText(shareUrl);
        toast.success(t('profilePage.sharing.copied'));
      }
    } catch (err) {
      console.error('Erreur partage liste:', err);
    } finally {
      setSharingListId(null);
    }
  };

  const handleUnshareList = async (listId: number) => {
    try {
      const profileId = getProfileId();
      const token = localStorage.getItem('auth_token');
      if (!profileId || !token) return;

      setSharingListId(listId);

      await axios.delete(`${API_URL}/api/shared-lists/share`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { profileId, listId: String(listId) }
      });

      setSharedListsStatus(prev => {
        const updated = { ...prev };
        delete updated[String(listId)];
        return updated;
      });
    } catch (err) {
      console.error('Erreur suppression partage:', err);
    } finally {
      setSharingListId(null);
    }
  };

  const handleCopyShareLink = async (shareCode: string) => {
    const shareUrl = `${window.location.origin}/list/${shareCode}`;
    await navigator.clipboard.writeText(shareUrl);
    toast.success(t('profilePage.sharing.copied'));
  };

  // Render empty state message for different sections
  const renderEmptyState = (section: string) => {
    let icon = <Film className="w-16 h-16 text-red-500 opacity-50 mb-4" />;
    let title = t('profilePage.emptyStates.watchlistEmpty');
    let message = t('profilePage.emptyStates.watchlistEmptyDesc');
    let actionText = t('profilePage.emptyStates.exploreCatalog');
    let actionLink = "/";

    if (section === 'favorites') {
      icon = <Heart className="w-16 h-16 text-red-500 opacity-50 mb-4" />;
      title = t('profilePage.emptyStates.noFavorites');
      message = t('profilePage.emptyStates.noFavoritesDesc');
    } else if (section === 'watched') {
      icon = <Eye className="w-16 h-16 text-red-500 opacity-50 mb-4" />;
      title = t('profilePage.emptyStates.historyEmpty');
      message = t('profilePage.emptyStates.historyEmptyDesc');
    } else if (section === 'in-progress') {
      icon = <Clock className="w-16 h-16 text-blue-500 opacity-50 mb-4" />;
      title = t('profilePage.emptyStates.noSeriesInProgress');
      message = t('profilePage.emptyStates.noSeriesInProgressDesc');
      actionText = t('profilePage.emptyStates.browseSeries');
      actionLink = "/tv-shows";
    } else if (section === 'alerts') {
      icon = <Bell className="w-16 h-16 text-yellow-500 opacity-50 mb-4" />;
      title = t('profilePage.emptyStates.noAlerts');
      message = t('profilePage.emptyStates.noAlertsDesc');
      actionText = t('profilePage.emptyStates.browseSeries');
      actionLink = "/tv-shows";
    }

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-900/50  rounded-2xl border border-gray-800/50 shadow-inner"
      >
        {icon}
        <h3 className="text-xl md:text-2xl font-bold text-white mb-2">{title}</h3>
        <p className="text-gray-400 max-w-md mb-6">{message}</p>
        <Link
          to={actionLink}
          className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-xl hover:from-red-700 hover:to-red-800 transition-colors shadow-lg hover:shadow-red-600/20 flex items-center gap-2"
        >
          {actionText}
        </Link>
      </motion.div>
    );
  };

  const renderCustomLists = () => {
    if (selectedListCollections.length > 0) {
      return (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-center">
            <div className="flex flex-wrap items-center gap-3 md:gap-4">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setSelectedListCollections([])}
                className="text-gray-300 hover:text-white bg-gray-800/70 p-2 rounded-full"
              >
                <ArrowLeft className="w-5 h-5" />
              </motion.button>
              <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                {selectedListName}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  if (selectedList) {
                    const collections = selectedList.items.filter(item => item.type === 'collection');
                    if (collections.length > 0) {
                      // Retirer la première collection (ou on pourrait ajouter un menu pour choisir)
                      removeCollectionFromList(collections[0].id);
                    }
                  }
                }}
                className="flex items-center gap-2 text-white bg-gradient-to-r from-orange-600 to-orange-700 hover:from-orange-700 hover:to-orange-800 px-3 py-2 rounded-lg transition-colors shadow-md"
                title={t('profilePage.collectionView.removeCollectionTitle')}
              >
                <Trash2 className="w-4 h-4" />
                <span className="text-xs">{t('profilePage.collectionView.removeCollection')}</span>
              </motion.button>
            </div>
          </div>

          {loadingListCollections ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-purple-500"></div>
            </div>
          ) : selectedListCollections.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-900/50  rounded-2xl border border-gray-800/50 shadow-inner"
            >
              <Film className="w-16 h-16 text-purple-500 opacity-50 mb-4" />
              <h3 className="text-xl md:text-2xl font-bold text-white mb-2">{t('profilePage.collectionView.noMovieFound')}</h3>
              <p className="text-gray-400 max-w-md mb-6">{t('profilePage.collectionView.noMovieFoundDesc')}</p>
            </motion.div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 px-2 md:px-4 relative z-0">
              {selectedListCollections.map((movie, index) => (
                <AgeRestrictedMedia
                  key={`${movie.collectionId}-${movie.id}`}
                  item={{ ...movie, media_type: movie.media_type === 'tv' || movie.type === 'tv' ? 'tv' : 'movie' }}
                >
                <motion.div
                  key={`${movie.collectionId}-${movie.id}`}
                  whileHover={{
                    scale: 1.05,
                    transition: { duration: 0.2 }
                  }}
                  className="relative group bg-gray-900/70 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-colors border border-gray-800/50"
                >
                  <Link to={movie.individualItem && (movie.media_type === 'tv' || movie.type === 'tv') ? `/tv/${movie.id}` : `/movie/${movie.id}`}>
                    <div className="aspect-[2/3] relative overflow-hidden">
                      <img
                        src={`https://image.tmdb.org/t/p/original${movie.poster_path}`}
                        alt={movie.title}
                        className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-colors">
                        <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                          <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">{movie.title}</h3>
                          <div className="flex flex-col gap-1">
                            {movie.release_date && (
                              <p className="text-gray-300 text-xs">
                                {new Date(movie.release_date).getFullYear()}
                              </p>
                            )}
                            <p className={`text-xs font-medium ${movie.isFromCollection ? 'text-purple-400' :
                              movie.individualItem && (movie.media_type === 'tv' || movie.type === 'tv') ? 'text-green-400' : 'text-blue-400'
                              }`}>
                              {movie.collectionName}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Link>

                  {/* Badge de type */}
                  <div className="absolute top-2 left-2 z-10">
                    <span className={`text-xs py-1 px-2 rounded font-medium ${movie.individualItem && (movie.media_type === 'tv' || movie.type === 'tv') ? 'bg-green-600 text-white' : 'bg-blue-600 text-white'
                      }`}>
                      {movie.individualItem && (movie.media_type === 'tv' || movie.type === 'tv') ? t('profilePage.media.series') : t('profilePage.media.movie')}
                    </span>
                  </div>

                  {/* Numéro du film */}
                  <div className="absolute top-2 right-2 z-10">
                    <span className="text-xs py-1 px-2 rounded font-medium bg-purple-600 text-white">
                      #{index + 1}
                    </span>
                  </div>

                  {/* Badge de collection */}
                  <div className="absolute bottom-2 left-2 z-10">
                    <span className={`text-xs py-1 px-2 rounded font-medium  ${movie.isFromCollection
                      ? 'bg-purple-600/80 text-white'
                      : movie.individualItem && (movie.media_type === 'tv' || movie.type === 'tv')
                        ? 'bg-green-600/80 text-white'
                        : 'bg-blue-600/80 text-white'
                      }`}>
                      {movie.collectionName}
                    </span>
                  </div>

                  {/* Bouton de suppression pour les films/séries individuels */}
                  {movie.individualItem && (
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        removeFromListCollection(movie.id);
                      }}
                      className="absolute top-12 right-2 bg-gradient-to-r from-red-600 to-red-700 text-white p-2 rounded-full md:opacity-0 md:group-hover:opacity-100 transition-colors hover:from-red-700 hover:to-red-800 shadow-lg z-20"
                      title={t('profilePage.collectionView.removeFromList')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </motion.button>
                  )}
                </motion.div>
                </AgeRestrictedMedia>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (selectedCollection) {
      return (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setSelectedCollection(null)}
                className="text-gray-300 hover:text-white bg-gray-800/70 p-2 rounded-full"
              >
                <ArrowLeft className="w-5 h-5" />
              </motion.button>
              <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                {selectedCollection.name}
              </h2>
            </div>
            <Link
              to={`/collection/${selectedCollection.id}`}
              className="flex items-center gap-2 text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 px-3 py-2 rounded-lg transition-colors shadow-md"
            >
              <Info className="w-4 h-4" />
              <span className="text-xs">{t('profilePage.collectionView.viewCollection')}</span>
            </Link>
          </div>

          {loadingCollectionMovies ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-purple-500"></div>
            </div>
          ) : collectionMovies.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-900/50  rounded-2xl border border-gray-800/50 shadow-inner"
            >
              <Film className="w-16 h-16 text-purple-500 opacity-50 mb-4" />
              <h3 className="text-xl md:text-2xl font-bold text-white mb-2">{t('profilePage.collectionView.noMovieFound')}</h3>
              <p className="text-gray-400 max-w-md mb-6">{t('profilePage.collectionView.noMovieFoundDesc')}</p>
            </motion.div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 px-2 md:px-4 relative z-0">
              {collectionMovies.map((movie, index) => (
                <AgeRestrictedMedia key={movie.id} item={{ ...movie, media_type: 'movie' }}>
                <motion.div
                  key={movie.id}
                  whileHover={{
                    scale: 1.05,
                    transition: { duration: 0.2 }
                  }}
                  className="relative group bg-gray-900/70 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-colors border border-gray-800/50"
                >
                  <Link to={`/movie/${movie.id}`}>
                    <div className="aspect-[2/3] relative overflow-hidden">
                      <img
                        src={`https://image.tmdb.org/t/p/original${movie.poster_path}`}
                        alt={movie.title}
                        className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-colors">
                        <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                          <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">{movie.title}</h3>
                          {movie.release_date && (
                            <p className="text-gray-300 text-xs">
                              {new Date(movie.release_date).getFullYear()}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </Link>

                  {/* Badge de type */}
                  <div className="absolute top-2 left-2 z-10">
                    <span className="text-xs py-1 px-2 rounded font-medium bg-blue-600 text-white">
                      {t('profilePage.media.movie')}
                    </span>
                  </div>

                  {/* Numéro du film dans la collection */}
                  <div className="absolute top-2 right-2 z-10">
                    <span className="text-xs py-1 px-2 rounded font-medium bg-purple-600 text-white">
                      #{index + 1}
                    </span>
                  </div>
                </motion.div>
                </AgeRestrictedMedia>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (selectedList) {
      const shareInfo = sharedListsStatus[String(selectedList.id)];
      const isShared = !!shareInfo;
      const isCurrentlySharing = sharingListId === selectedList.id;

      return (
        <div className="space-y-6">
          <div className="flex flex-col gap-3 md:flex-row md:justify-between md:items-center">
            <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setSelectedList(null)}
                className="text-gray-300 hover:text-white bg-gray-800/70 p-2 rounded-full"
              >
                <ArrowLeft className="w-5 h-5" />
              </motion.button>
              {renamingListId === selectedList.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleRenameList(selectedList.id, renamingListName);
                  }}
                  className="flex-1 max-w-xs"
                >
                  <Input
                    value={renamingListName}
                    onChange={(e) => setRenamingListName(e.target.value)}
                    onBlur={() => {
                      if (renamingListName.trim()) {
                        handleRenameList(selectedList.id, renamingListName);
                      } else {
                        cancelRenaming();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') cancelRenaming();
                    }}
                    autoFocus
                    className="h-9 text-lg sm:text-xl md:text-2xl font-bold"
                    placeholder={t('profilePage.customLists.listNamePlaceholder')}
                  />
                </form>
              ) : (
                <h2
                  className="text-lg sm:text-xl md:text-2xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent cursor-text hover:from-red-400 hover:to-red-300 transition-all"
                  onClick={() => startRenaming(selectedList.id, selectedList.name)}
                  title={t('profilePage.customLists.clickToRename')}
                >
                  {selectedList.name}
                </h2>
              )}
              {isShared && (
                <span className="flex items-center gap-1 text-xs py-1 px-2 rounded-full font-medium bg-purple-600/20 text-purple-400 border border-purple-500/30">
                  <Share2 className="w-3 h-3" />
                  {shareInfo.isPublicInCatalog ? t('profilePage.sharing.publicCatalog') : t('profilePage.sharing.sharedByCode')}
                </span>
              )}
            </div>
            <div className="w-full md:w-auto flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
              {/* Widget Turnstile pour le partage — masqué pour les dispensés */}
              {TURNSTILE_SITE_KEY && shareTurnstileBypass === 'challenge' && (
                <div className="w-full flex justify-center sm:justify-start overflow-hidden [&>iframe]:max-w-full [&>div]:max-w-full" style={{ maxWidth: '100%' }}>
                  <div ref={shareTurnstileRef} className="origin-left scale-[0.85] sm:scale-100" />
                </div>
              )}
              {/* Bouton partager / copier lien / visibilité / retirer partage */}
              {isShared ? (
                <div className="w-full md:w-auto flex flex-col sm:flex-row sm:flex-wrap gap-2">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleCopyShareLink(shareInfo.shareCode)}
                    className="w-full sm:w-auto justify-center flex items-center gap-2 px-3 py-2 rounded-lg transition-colors shadow-md bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white"
                  >
                    <Link2 className="w-4 h-4" /><span className="text-xs">{t('profilePage.sharing.copyLink')}</span>
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleShareList(selectedList.id, !shareInfo.isPublicInCatalog)}
                    disabled={isCurrentlySharing || (!!TURNSTILE_SITE_KEY && !shareTurnstileToken)}
                    className="w-full sm:w-auto justify-center flex items-center gap-2 text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 px-3 py-2 rounded-lg transition-colors shadow-md disabled:opacity-50"
                  >
                    {isCurrentlySharing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Globe className="w-4 h-4" />
                        <span className="text-xs">{shareInfo.isPublicInCatalog ? t('profilePage.sharing.switchToPrivate') : t('profilePage.sharing.publishToCatalog')}</span>
                      </>
                    )}
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleUnshareList(selectedList.id)}
                    disabled={isCurrentlySharing}
                    className="w-full sm:w-auto justify-center flex items-center gap-2 text-white bg-gradient-to-r from-gray-600 to-gray-700 hover:from-gray-700 hover:to-gray-800 px-3 py-2 rounded-lg transition-colors shadow-md disabled:opacity-50"
                  >
                    {isCurrentlySharing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Share2 className="w-4 h-4" /><span className="text-xs">{t('profilePage.sharing.removeSharing')}</span></>
                    )}
                  </motion.button>
                </div>
              ) : (
                <div className="w-full md:w-auto flex flex-col sm:flex-row sm:flex-wrap gap-2">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleShareList(selectedList.id, false)}
                    disabled={isCurrentlySharing || (!!TURNSTILE_SITE_KEY && !shareTurnstileToken)}
                    className="w-full sm:w-auto justify-center flex items-center gap-2 text-white bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 px-3 py-2 rounded-lg transition-colors shadow-md disabled:opacity-50"
                  >
                    {isCurrentlySharing ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /><span className="text-xs">{t('profilePage.sharing.sharingInProgress')}</span></>
                    ) : (
                      <><Share2 className="w-4 h-4" /><span className="text-xs">{t('profilePage.sharing.shareByCode')}</span></>
                    )}
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleShareList(selectedList.id, true)}
                    disabled={isCurrentlySharing || (!!TURNSTILE_SITE_KEY && !shareTurnstileToken)}
                    className="w-full sm:w-auto justify-center flex items-center gap-2 text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 px-3 py-2 rounded-lg transition-colors shadow-md disabled:opacity-50"
                  >
                    {isCurrentlySharing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Globe className="w-4 h-4" /><span className="text-xs">{t('profilePage.sharing.publishToCatalog')}</span></>
                    )}
                  </motion.button>
                </div>
              )}
              <button
                onClick={() => handleDeleteList(selectedList.id)}
                className="w-full sm:w-auto justify-center flex items-center gap-2 text-white bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 px-3 py-2 rounded-lg transition-colors shadow-md"
              >
                <Trash2 className="w-4 h-4" />
                <span className="text-xs">{t('profilePage.sharing.delete')}</span>
              </button>
            </div>
          </div>

          {selectedList.items.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-900/50  rounded-2xl border border-gray-800/50 shadow-inner"
            >
              <List className="w-16 h-16 text-red-500 opacity-50 mb-4" />
              <h3 className="text-xl md:text-2xl font-bold text-white mb-2">{t('profilePage.sharing.listEmpty')}</h3>
              <p className="text-gray-400 max-w-md mb-6">{t('profilePage.sharing.listEmptyDesc')}</p>
            </motion.div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleItemDragStart}
              onDragEnd={handleItemDragEnd}
              onDragCancel={handleItemDragCancel}
            >
              <SortableContext
                items={selectedList.items.map(i => `${i.type}-${i.id}`)}
                strategy={rectSortingStrategy}
              >
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 px-2 md:px-4 relative z-0">
                  {selectedList.items.map(item => (
                    <AgeRestrictedMedia key={`${item.type}-${item.id}`} item={item}>
                    <SortableMediaItem id={`${item.type}-${item.id}`}>
                      <motion.div
                        whileHover={activeItemDragId ? undefined : {
                          scale: 1.05,
                          transition: { duration: 0.2 }
                        }}
                        className="relative group bg-gray-900/70 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-colors border border-gray-800/50"
                      >
                        {item.type === 'collection' ? (
                          <div
                            className="aspect-[2/3] relative overflow-hidden cursor-pointer"
                            onClick={() => openCollection(item)}
                          >
                            <img
                              src={`https://image.tmdb.org/t/p/original${item.poster_path}`}
                              alt={item.title}
                              className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                            />
                            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-colors">
                              <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                                <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">{item.title}</h3>
                                <div className="flex items-center gap-2">
                                  <Film className="w-4 h-4 text-purple-400" />
                                  <span className="text-purple-400 text-xs">
                                    {t('profilePage.customLists.filmCount', { count: (item as any).movieCount || 0 })}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <Link to={`/${item.type}/${item.id}`}>
                            <div className="aspect-[2/3] relative overflow-hidden">
                              <img
                                src={`https://image.tmdb.org/t/p/original${item.poster_path}`}
                                alt={item.title}
                                className="w-full h-full object-cover transform transition-transform duration-300 group-hover:scale-110"
                              />
                              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-colors">
                                <div className="absolute bottom-0 left-0 right-0 p-4 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                                  <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">{item.title}</h3>
                                </div>
                              </div>
                            </div>
                          </Link>
                        )}

                        {/* Badge de type */}
                        <div className="absolute top-2 left-2 z-10">
                          <span className={`text-xs py-1 px-2 rounded font-medium ${item.type === 'movie' ? 'bg-blue-600 text-white' :
                            item.type === 'tv' ? 'bg-green-600 text-white' :
                              'bg-purple-600 text-white'
                            }`}>
                            {item.type === 'movie' ? t('profilePage.media.movie') :
                              item.type === 'tv' ? t('profilePage.media.series') : t('profilePage.media.collection')}
                          </span>
                        </div>

                        <motion.button
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveFromList(selectedList.id, item.id);
                          }}
                          className="absolute top-2 right-2 bg-gradient-to-r from-red-600 to-red-700 text-white p-2 rounded-full md:opacity-0 md:group-hover:opacity-100 transition-colors hover:from-red-700 hover:to-red-800 shadow-lg z-20"
                        >
                          <Trash2 className="w-4 h-4" />
                        </motion.button>
                      </motion.div>
                    </SortableMediaItem>
                    </AgeRestrictedMedia>
                  ))}
                </div>
              </SortableContext>
              <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
                {activeItemDragId ? (() => {
                  const item = selectedList.items.find(i => `${i.type}-${i.id}` === activeItemDragId);
                  if (!item) return null;
                  return (
                    <div className="aspect-[2/3] w-28 sm:w-32 rounded-xl overflow-hidden shadow-2xl shadow-black/50 border-2 border-red-500/50 rotate-2 scale-105">
                      <img
                        src={`https://image.tmdb.org/t/p/w300${item.poster_path}`}
                        alt={item.title}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                        <p className="text-white text-xs font-medium truncate">{item.title}</p>
                      </div>
                    </div>
                  );
                })() : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
          <h2 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">{t('profilePage.customLists.title')}</h2>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <Link
              to="/list-catalog"
              className="flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white px-4 py-2.5 rounded-xl hover:from-indigo-700 hover:to-indigo-800 transition-colors shadow-lg text-sm"
            >
              <Globe className="w-4 h-4" />
              {t('profilePage.customLists.listCatalog')}
            </Link>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowNewListModal(true)}
              className="flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-red-700 text-white px-4 py-2.5 rounded-xl hover:from-red-700 hover:to-red-800 transition-colors shadow-lg hover:shadow-red-600/20 text-sm"
            >
              <Plus className="w-4 h-4" />
              {t('profilePage.customLists.createList')}
            </motion.button>
          </div>
        </div>

        {customLists.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-900/50  rounded-2xl border border-gray-800/50 shadow-inner"
          >
            <List className="w-16 h-16 text-red-500 opacity-50 mb-4" />
            <h3 className="text-xl md:text-2xl font-bold text-white mb-2">{t('profilePage.customLists.noCustomLists')}</h3>
            <p className="text-gray-400 max-w-md mb-6">{t('profilePage.customLists.noCustomListsDesc')}</p>
            <button
              onClick={() => setShowNewListModal(true)}
              className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-xl hover:from-red-700 hover:to-red-800 transition-colors shadow-lg hover:shadow-red-600/20 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {t('profilePage.customLists.createFirstList')}
            </button>
          </motion.div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleListDragStart}
            onDragEnd={handleListDragEnd}
            onDragCancel={handleListDragCancel}
          >
            <SortableContext
              items={customLists.map(l => String(l.id))}
              strategy={rectSortingStrategy}
            >
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 px-2 md:px-4 relative z-0">
            {customLists.map(list => (
              <SortableListCard key={list.id} id={String(list.id)}>
              {(dragHandleProps: DragHandleProps) => (
              <motion.div
                className="bg-gray-900/70 p-5 rounded-xl hover:bg-gray-800/80 transition-colors border border-gray-800/50 shadow-lg hover:shadow-xl"
                whileHover={activeListDragId ? undefined : { scale: 1.02 }}
                onClick={() => {
                  if (renamingListId !== list.id && !activeListDragId) {
                    openListCollections(list);
                  }
                }}
              >
                <div className="flex justify-between items-start mb-3">
                  <div className="flex items-center gap-2 min-w-0 flex-1 mr-2 mt-1">
                    {renamingListId === list.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRenameList(list.id, renamingListName);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1"
                      >
                        <Input
                          value={renamingListName}
                          onChange={(e) => setRenamingListName(e.target.value)}
                          onBlur={() => {
                            if (renamingListName.trim()) {
                              handleRenameList(list.id, renamingListName);
                            } else {
                              cancelRenaming();
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              cancelRenaming();
                            }
                          }}
                          autoFocus
                          className="h-8 bg-gray-800 border-gray-700 text-white text-lg font-bold"
                        />
                      </form>
                    ) : (
                      <h3
                        className="font-bold text-lg text-white truncate cursor-text hover:text-red-400 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRenaming(list.id, list.name);
                        }}
                        title={t('profilePage.customLists.clickToRename')}
                      >
                        {list.name}
                      </h3>
                    )}
                    {sharedListsStatus[String(list.id)] && (
                      <span className="flex-shrink-0 flex items-center gap-1 text-[10px] py-0.5 px-1.5 rounded-full font-medium bg-purple-600/20 text-purple-400 border border-purple-500/30">
                        <Share2 className="w-2.5 h-2.5" />
                        {sharedListsStatus[String(list.id)].isPublicInCatalog ? t('profilePage.customLists.catalogLabel') : t('profilePage.customLists.codeLabel')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-center gap-1 flex-shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="p-1.5 rounded-lg hover:bg-gray-700/60 transition-colors text-gray-400 hover:text-white"
                        >
                          <MoreVertical className="w-5 h-5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-gray-900 border-gray-700 min-w-[180px]">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            startRenaming(list.id, list.name);
                          }}
                          className="text-gray-200 focus:bg-gray-800 focus:text-white cursor-pointer"
                        >
                          <Pencil className="w-4 h-4 mr-2" />
                          {t('profilePage.customLists.rename')}
                        </DropdownMenuItem>
                        {sharedListsStatus[String(list.id)] ? (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyShareLink(sharedListsStatus[String(list.id)].shareCode);
                            }}
                            className="text-gray-200 focus:bg-gray-800 focus:text-white cursor-pointer"
                          >
                            <Link2 className="w-4 h-4 mr-2" />
                            {t('profilePage.sharing.copyLink')}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleShareList(list.id, false);
                            }}
                            disabled={sharingListId === list.id || (!!TURNSTILE_SITE_KEY && !shareTurnstileToken)}
                            className="text-gray-200 focus:bg-gray-800 focus:text-white cursor-pointer"
                          >
                            {sharingListId === list.id ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                {t('profilePage.sharing.sharingInProgress')}
                              </>
                            ) : (
                              <>
                                <Share2 className="w-4 h-4 mr-2" />
                                {t('profilePage.sharing.shareByCode')}
                              </>
                            )}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator className="bg-gray-700" />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteList(list.id);
                          }}
                          className="text-red-400 focus:bg-red-950/50 focus:text-red-300 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          {t('profilePage.sharing.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div
                      ref={dragHandleProps.ref}
                      {...dragHandleProps.attributes}
                      {...dragHandleProps.listeners}
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 rounded-lg hover:bg-gray-700/60 transition-colors text-gray-400 hover:text-white cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                    >
                      <GripVertical className="w-5 h-5" />
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">
                    {(() => {
                      const totalItems = list.items.reduce((total, item) => {
                        if (item.type === 'collection') {
                          return total + ((item as any).movieCount || 0);
                        }
                        return total + 1;
                      }, 0);
                      return t('profilePage.customLists.itemCount', { count: totalItems });
                    })()}
                  </p>
                  {list.items.some(item => item.type === 'collection') && (
                    <div className="flex items-center gap-1 text-purple-400 text-xs">
                      <Film className="w-3 h-3" />
                      <span>Collections</span>
                    </div>
                  )}
                </div>
              </motion.div>
              )}
              </SortableListCard>
            ))}
          </div>
            </SortableContext>
            <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
              {activeListDragId ? (() => {
                const list = customLists.find(l => String(l.id) === activeListDragId);
                if (!list) return null;
                return (
                  <div className="bg-gray-900 p-4 sm:p-5 rounded-xl border-2 border-red-500/50 shadow-2xl shadow-red-500/20 rotate-1 scale-105 w-full max-w-[85vw] sm:max-w-sm">
                    <h3 className="font-bold text-base sm:text-lg text-white">{list.name}</h3>
                    <p className="text-xs sm:text-sm text-gray-400 mt-1">
                      {t('profilePage.customLists.itemCount', { count: list.items.length })}
                    </p>
                  </div>
                );
              })() : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    );
  };

  const fetchTvShowEpisodeDetails = async (tvShowId: number) => {
    try {
      const watchedEpisodes: Record<string, boolean> = {};
      const watchlistEpisodes: Record<string, boolean> = {};

      // Function to process different storage formats
      const processEpisodes = (listType: 'watched' | 'watchlist') => {
        const targetEpisodes = listType === 'watched' ? watchedEpisodes : watchlistEpisodes;

        // 1. New format: `*_episodes_tv_{id}`
        const newFormatKey = `${listType}_episodes_tv_${tvShowId}`;
        const newFormatData = localStorage.getItem(newFormatKey);
        if (newFormatData) {
          Object.assign(targetEpisodes, JSON.parse(newFormatData));
        }

        // 2. Legacy format: `*_tv_episodes`
        const legacyFormatKey = `${listType}_tv_episodes`;
        const legacyFormatData = localStorage.getItem(legacyFormatKey);
        if (legacyFormatData) {
          const legacyEpisodes = JSON.parse(legacyFormatData) as WatchItem[];
          legacyEpisodes.forEach(ep => {
            if (ep.id === tvShowId && ep.episodeInfo) {
              const { season, episode } = ep.episodeInfo;
              targetEpisodes[`S${season}E${episode}`] = true;
            }
          });
        }
      };

      processEpisodes('watched');
      processEpisodes('watchlist');

      const watchedTv = JSON.parse(localStorage.getItem('watched_tv') || '[]');
      const watchlistTv = JSON.parse(localStorage.getItem('watchlist_tv') || '[]');

      // Check if full series is marked as watched/watchlist
      const isFullSeriesWatched = watchedTv.some((item: any) => item.id === tvShowId);
      const isFullSeriesInWatchlist = watchlistTv.some((item: any) => item.id === tvShowId);

      // NEW: Check if all episodes are watched by comparing with TMDB data
      let isAllEpisodesWatched = false;

      try {
        // Use the helper function to check if the show is fully watched
        isAllEpisodesWatched = await isTVShowFullyWatched(tvShowId);

        if (isAllEpisodesWatched) {
          console.log(`Série ${tvShowId}: Tous les épisodes ont été vus`);
        }
      } catch (error) {
        console.error(`Erreur lors de la vérification si la série ${tvShowId} est entièrement vue:`, error);
        // Fallback: use the old logic if check fails
        isAllEpisodesWatched = isFullSeriesWatched;
      }

      setDetailedTvShowEpisodes({
        watched: watchedEpisodes,
        watchlist: watchlistEpisodes,
        isFullSeriesWatched: isFullSeriesWatched || isAllEpisodesWatched,
        isFullSeriesInWatchlist
      });
    } catch (error) {
      console.error("Error fetching TV show episode details from localStorage:", error);
      setDetailedTvShowEpisodes({
        watched: {},
        watchlist: {},
        isFullSeriesWatched: false,
        isFullSeriesInWatchlist: false
      });
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 mt-20 pb-32 md:pb-8 min-h-screen bg-black/90 transition-all duration-500 shadow-xl relative z-0">
      {!isAuthenticated ? (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 p-10 bg-gray-900/70 rounded-2xl border border-gray-800/50 shadow-xl ">
          <Info className="w-16 h-16 text-red-500 mb-2" />
          <h2 className="text-2xl md:text-3xl font-bold text-center bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">{t('profilePage.auth.loginRequired')}</h2>
          <p className="text-gray-400 text-center max-w-md mb-2">{t('profilePage.auth.loginRequiredDesc')}</p>
          <Link
            to="/login"
            className="bg-gradient-to-r from-red-600 to-red-700 text-white px-8 py-4 rounded-xl hover:from-red-700 hover:to-red-800 transition-colors shadow-lg hover:shadow-red-600/20 text-lg font-medium"
          >
            {t('profilePage.auth.login')}
          </Link>
        </div>
      ) : (
        <>
          {renderProfileHeader()}
          <div className="flex flex-col space-y-6 mb-24 md:mb-0">
            <div className="flex overflow-x-auto pb-1 md:pb-2 gap-2 sm:gap-4 md:gap-6 lg:gap-8 scrollbar-none border-b border-gray-800/50 -mx-2 px-2">
              {tabs.map(tab => (
                <div key={tab.id} className="relative flex-shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      setActiveTab(tab.id);
                      navigate(`/profile?tab=${tab.id}`);
                    }}
                    className={`flex items-center justify-center gap-1 sm:gap-2 py-2 sm:py-3 px-1 sm:px-2 min-w-[70px] sm:min-w-[100px] transition-colors font-medium text-xs sm:text-sm md:text-base focus:outline-none focus:ring-0 relative group
                      ${activeTab === tab.id
                        ? 'text-white'
                        : 'text-gray-400 hover:text-white'
                      }
                    `}
                  >
                    <span className={`${activeTab === tab.id ? 'text-red-500' : 'text-gray-500 group-hover:text-red-500'} transition-colors duration-300`}>{tab.icon}</span>
                    <span className="whitespace-nowrap">{tab.label}</span>
                    <span className="ml-0.5 sm:ml-1 px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs rounded-full bg-gray-800 text-gray-300">{tab.count}</span>

                    {/* Barre d'indicateur sous l'onglet actif */}
                    {activeTab === tab.id && (
                      <motion.span
                        className="absolute bottom-0 left-0 w-full h-1 bg-red-600"
                        layoutId="activeTabIndicator"
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                      />
                    )}

                    {/* Effet de survol avec une barre blanche qui s'élargit (seulement sur les onglets inactifs) */}
                    {activeTab !== tab.id && (
                      <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-white group-hover:w-full transition-colors origin-left"></span>
                    )}
                  </motion.button>
                </div>
              ))}
            </div>
            {/* Contenu des onglets avec animation améliorée */}
            <div className="min-h-[50vh] relative">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -30 }}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
                className="relative w-full"
              >
                {/* Système de filtrage pour les listes principales */}
                {(activeTab === 'watchlist' || activeTab === 'favorites' || activeTab === 'watched' || activeTab === 'in-progress') && (
                  <FilterSystem
                    onFiltersChange={handleMainFiltersChange}
                    totalItems={totalItemsForActiveTab}
                    filteredItems={filteredItemsForActiveTab}
                    isSorting={isSortingForActiveTab}
                    availableTypeFilters={availableTypeFiltersForActiveTab}
                  />
                )}

                {activeTab === 'watchlist' && renderContent()}
                {activeTab === 'favorites' && renderContent()}
                {activeTab === 'watched' && renderContent()}
                {activeTab === 'in-progress' && renderInProgress()}
                {activeTab === 'alerts' && renderAlerts()}
                {activeTab === 'custom-lists' && renderCustomLists()}
                {activeTab === 'sessions' && renderSessions()}
              </motion.div>
            </div>
          </div>

          {showNewListModal && (
            <NewListModal
              onClose={() => setShowNewListModal(false)}
              onCreateList={handleCreateList}
            />
          )}
          {/* Popup affichant l'identifiant de compte - affichage via portail */}
          {
            showIdPopup && createPortal((
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
                      className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-hidden"
                    >
                      {/* Header */}
                      <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold text-white">{t('profilePage.accountPopup.title')}</h3>
                        <button
                          onClick={handleCloseIdPopup}
                          className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>

                      {/* Content */}
                      <div className="overflow-y-auto max-h-[70vh]">
                        <p className="text-sm text-gray-400 mb-4">
                          {t('profilePage.accountPopup.description')}
                        </p>

                        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                          {accountIdInfo?.provider && accountIdInfo.provider !== 'unknown' && (
                            <div className="text-xs text-gray-400 mb-1 capitalize">{t('profilePage.accountPopup.provider')} {accountIdInfo.provider}</div>
                          )}
                          <div className="text-xs text-gray-400 mb-1">{t('profilePage.accountPopup.id')}</div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-sm text-white break-all">{accountIdInfo?.id || ''}</span>
                            <button
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                              onClick={() => { if (accountIdInfo?.id) navigator.clipboard.writeText(accountIdInfo.id); }}
                            >
                              <Copy className="w-3.5 h-3.5" />
                              {t('profilePage.accountPopup.copy')}
                            </button>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <button
                            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
                            onClick={handleCloseIdPopup}
                          >
                            {t('profilePage.accountPopup.understood')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            ), getOverlayPortalRoot())
          }

          {/* Popup affichant le localStorage - affichage via portail */}
          {
            showLocalStoragePopup && createPortal((
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
                      className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden"
                    >
                      {/* Header */}
                      <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold text-white">{t('profilePage.localStoragePopup.title')}</h3>
                        <button
                          onClick={handleCloseLocalStoragePopup}
                          className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>

                      {/* Content */}
                      <div className="overflow-y-auto max-h-[70vh]">
                        <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4">
                          <p className="text-sm text-red-300 font-medium mb-2">
                            ⚠️ {t('profilePage.localStoragePopup.warning')}
                          </p>
                          <p className="text-sm text-red-200">
                            {t('profilePage.localStoragePopup.warningDesc')}
                          </p>
                        </div>

                        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="text-xs text-gray-400">{t('profilePage.localStoragePopup.jsonLabel')}</div>
                            <button
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                              onClick={() => { if (localStorageData) navigator.clipboard.writeText(localStorageData); }}
                            >
                              <Copy className="w-3.5 h-3.5" />
                              {t('profilePage.localStoragePopup.copyAll')}
                            </button>
                          </div>
                          <div className="bg-gray-900/50 rounded-lg p-3 max-h-96 overflow-y-auto">
                            <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap break-all">
                              {localStorageData}
                            </pre>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <button
                            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
                            onClick={handleCloseLocalStoragePopup}
                          >
                            {t('profilePage.localStoragePopup.close')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            ), getOverlayPortalRoot())
          }

          {/* Popup d'importation de données - affichage via portail */}
          {
            showImportPopup && createPortal((
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
                      className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden"
                    >
                      {/* Header */}
                      <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold text-white">{t('profilePage.import.title')}</h3>
                        <button
                          onClick={handleCloseImportPopup}
                          className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>

                      {/* Content */}
                      <div className="overflow-y-auto max-h-[70vh]">
                        <div className="bg-blue-900/30 border border-blue-500/50 rounded-lg p-4 mb-4">
                          <p className="text-sm text-blue-300 font-medium mb-2">
                            📥 {t('profilePage.import.importHeading')}
                          </p>
                          <p className="text-sm text-blue-200">
                            {t('profilePage.import.importDesc')}
                          </p>
                        </div>

                        <div className="mb-4">
                          <label className="block text-sm font-medium text-gray-300 mb-2">
                            {t('profilePage.import.jsonLabel')}
                          </label>
                          <textarea
                            value={importData}
                            onChange={(e) => setImportData(e.target.value)}
                            className="w-full h-64 bg-gray-800 border border-gray-700 rounded-lg p-4 text-white font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                            placeholder={`{
  "watched_tv_episodes": "[{\\"id\\":154524,\\"type\\":\\"tv\\",\\"title\\":\\"Urusei Yatsura\\",\\"poster_path\\":\\"/8umfDfSpBs277MsXuezi2zEy6Mc.jpg\\",\\"episodeInfo\\":{\\"season\\":1,\\"episode\\":1},\\"addedAt\\":\\"2025-07-07T18:30:52.595Z\\"}]",
  "progress_14438": "{\\"position\\":67.999348,\\"timestamp\\":\\"2025-08-10T23:50:49.347Z\\",\\"duration\\":7099.882999999983}",
  "playerSaveProgressPref": "true",
  "progress_tv_70610_s1_e1": "{\\"position\\":68.720705,\\"timestamp\\":\\"2025-08-13T20:02:13.755Z\\",\\"duration\\":1565.1600000000003}"
}`}
                          />
                        </div>

                        {importError && (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4"
                          >
                            <p className="text-sm text-red-300">
                              ❌ {importError}
                            </p>
                          </motion.div>
                        )}

                        {importSuccess && (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="bg-green-900/30 border border-green-500/50 rounded-lg p-4 mb-4"
                          >
                            <p className="text-sm text-green-300">
                              ✅ {importSuccess}
                            </p>
                          </motion.div>
                        )}

                        <div className="flex justify-end gap-3">
                          <button
                            className="px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-700 text-white transition-colors"
                            onClick={handleCloseImportPopup}
                          >
                            {t('profilePage.import.cancel')}
                          </button>
                          <button
                            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                            onClick={handleImportData}
                            disabled={!importData.trim()}
                          >
                            {t('profilePage.import.importBtn')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            ), getOverlayPortalRoot())
          }

          {showAvatarModal && (
            <AvatarSelector
              isOpen={showAvatarModal}
              onClose={() => setShowAvatarModal(false)}
              onAvatarSelect={handleAvatarSelect}
              currentAvatar={activeProfile?.avatar || userProfile.avatar}
            />
          )}
        </>
      )}
    </div >
  );
};

export default Profile;
