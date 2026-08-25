import 'bootstrap-icons/font/bootstrap-icons.min.css';
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react';
import ReactCountryFlag from 'react-country-flag';
import { motion, AnimatePresence } from 'framer-motion';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Tv, Loader2, Radio, Search, Crown, Puzzle, ChevronDown, Lock, Globe, Wifi, Star, Smartphone } from 'lucide-react';
import { toast } from 'sonner';


import { useSearchParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import { isExtensionAvailable, fetchFromExtension } from '../utils/extensionProxy';
import { isLiveTvSourceEnabled, subscribeToPrefsChanges, type LiveTvSourceKey } from '../utils/extractionPrefs';
import LiveTVPlayer from '../components/LiveTVPlayer';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import AdFreePlayerAds from '../components/AdFreePlayerAds';
import { isUserVip } from '../utils/authUtils';
import { getVipHeaders } from '../utils/vipUtils';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { groupVavooChannels, type VavooChannelVariant } from '../utils/vavooChannelGroups';

interface Catalog {
  type: string;
  id: string;
  name: string;
  extra?: Array<{
    name: string;
    isRequired: boolean;
    options: string[];
  }>;
}

interface Channel {
  id: string;
  type: string;
  name: string;
  poster: string;
  genres?: string[];
  // Match-specific fields
  _timestamp?: number;
  _timeText?: string;
  _competition?: string;
  _isLive?: boolean;
  _status?: 'live' | 'upcoming';
  _countryCode?: string;
  _sport?: string;
  _sportKey?: string;
  _score?: string;
  _emoji?: string;
  _serverCount?: number;
  _homeTeam?: string;
  _awayTeam?: string;
  _homeLogo?: string;
  _awayLogo?: string;
  _leagueLogo?: string;
  _country?: string;
  _countryLogo?: string;
  _pageUrl?: string;
  _servers?: Array<{
    id: number;
    name: string;
    siteType?: number;
    sportType?: number;
  }>;
  _vavooVariants?: VavooChannelVariant[];
}

interface IptvCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

interface IptvStream {
  stream_id: number;
  name: string;
  stream_icon: string | null;
  epg_channel_id: string | null;
  category_id: string;
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

interface FavoriteIptvCategory {
  id: string;
  name: string;
  addedAt: string;
}

const LIVE_TV_FAVORITES_STORAGE_KEY = 'live_tv_favorite_channels';
const LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY = 'live_tv_favorite_iptv_categories';

const buildLiveTvFavoriteKey = (source: string, id: string | number): string => `${source}:${String(id)}`;

const readLiveTvFavorites = (): LiveTVFavorite[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIVE_TV_FAVORITES_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readFavoriteIptvCategories = (): FavoriteIptvCategory[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Catégorie emojis pour les afficher dans les tabs
const categoryEmojis: { [key: string]: string } = {
  // Sports FCTV — doit rester aligné sur FCTV_SPORTS (API/Mainapi/liveTvRoutes.js)
  'matches_all': '🏅',
  'matches_football': '⚽',
  'matches_basketball': '🏀',
  'matches_tennis': '🎾',
  'matches_baseball': '⚾',
  'matches_cricket': '🏏',
  'matches_motorsport': '🏎️',
  'matches_rugby': '🏉',
  'matches_american_football': '🏈',
  'matches_aussie_rules': '🏉',
  'matches_hockey': '🏒',
  'matches_badminton': '🏸',
  'matches_volleyball': '🏐',
  'matches_fighting': '🥊',
  'matches_cycling': '🚴',
  'matches_handball': '🤾',
  'matches_others': '🏟️',

  // Linkzy (FREE source)
  'linkzy_generaliste': '📺',
  'linkzy_sport': '⚽',
  'linkzy_cinema': '🎬',

};

// Vavoo country groups → ISO 3166-1 alpha-2 code for <ReactCountryFlag> (unicode
// flag emojis don't render on Windows, so we draw SVG flags instead). Groups with
// no single country (All, Balkans) fall back to a Globe icon in getCatalogIcon.
const vavooGroupCountry: { [key: string]: string } = {
  'vavoo_france': 'FR',
  'vavoo_france-sport': 'FR',
  'vavoo_united-kingdom': 'GB',
  'vavoo_germany': 'DE',
  'vavoo_italy': 'IT',
  'vavoo_spain': 'ES',
  'vavoo_portugal': 'PT',
  'vavoo_netherlands': 'NL',
  'vavoo_poland': 'PL',
  'vavoo_romania': 'RO',
  'vavoo_bulgaria': 'BG',
  'vavoo_croatia': 'HR',
  'vavoo_albania': 'AL',
  'vavoo_turkey': 'TR',
  'vavoo_arabia': 'SA',
  'vavoo_russia': 'RU',
};

// Source display names for dropdown
const sourceDisplayNames: { [key: string]: string } = {
  'northlive': 'Northlive',
  'vavoo': 'Vavoo',
  'fctv': 'FCTV33',
  'iptv': 'liveTV.iptvWebSource',
};

// Get source key from catalog ID
const getSourceKey = (catalogId: string): string => {
  if (catalogId.startsWith('northlive_')) return 'northlive';
  if (catalogId.startsWith('vavoo_')) return 'vavoo';
  if (catalogId.startsWith('matches_')) return 'fctv';
  return 'other';
};

// Format time remaining for upcoming matches with HH:MM:SS format
//
// `isPast` — l'heure annoncée est dépassée. On ne dit pas « en cours » pour
// autant : c'est le statut renvoyé par l'amont qui fait foi, et une entrée
// comme « DAZN Transfer by Fabrizio Romano » garde une heure passée tout en
// étant annoncée « à venir ». L'appelant décide quoi afficher.
const formatTimeRemaining = (timestamp: number, t: (key: string, params?: Record<string, unknown>) => string): { text: string; isImminent: boolean; isPast: boolean } => {
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) return { text: '', isImminent: false, isPast: true };

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  // If less than 5 minutes, show HH:MM:SS format and mark as imminent (clickable)
  if (totalSeconds < 300) {
    return {
      text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
      isImminent: true,
      isPast: false,
    };
  }

  // Otherwise show relative time
  if (days > 0) {
    return { text: t('liveTV.inDays', { days, hours }), isImminent: false, isPast: false };
  } else if (hours > 0) {
    return { text: t('liveTV.inHours', { hours, minutes }), isImminent: false, isPast: false };
  } else if (minutes > 0) {
    return { text: t('liveTV.inMinutes', { minutes }), isImminent: false, isPast: false };
  } else {
    return { text: t('liveTV.imminent'), isImminent: true, isPast: false };
  }
};

interface FavoriteChannelButtonProps {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const FavoriteChannelButton: React.FC<FavoriteChannelButtonProps> = ({ active, activeLabel, inactiveLabel, onToggle }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <motion.button
        type="button"
        onClick={onToggle}
        whileTap={{ scale: 0.7 }}
        className={cn(
          'absolute top-2 right-2 z-20 p-2 rounded-full backdrop-blur-sm transition-all duration-200 md:opacity-0 md:group-hover:opacity-100',
          active
            ? 'bg-yellow-500/20 border border-yellow-400/30'
            : 'bg-black/40 hover:bg-black/60'
        )}
      >
        <motion.div
          key={active ? 'on' : 'off'}
          initial={{ scale: 0.3, rotate: -45 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 15 }}
        >
          <Star
            className={cn('w-4 h-4 transition-colors duration-150', active ? 'text-yellow-400' : 'text-white')}
            fill={active ? 'currentColor' : 'none'}
          />
        </motion.div>
      </motion.button>
    </TooltipTrigger>
    <TooltipContent>{active ? activeLabel : inactiveLabel}</TooltipContent>
  </Tooltip>
);

interface FavoriteInlineButtonProps {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  iconClassName?: string;
}

const FavoriteInlineButton: React.FC<FavoriteInlineButtonProps> = ({
  active,
  activeLabel,
  inactiveLabel,
  onToggle,
  className,
  iconClassName,
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <motion.button
        type="button"
        onClick={onToggle}
        whileTap={{ scale: 0.72 }}
        className={cn(
          'flex items-center justify-center rounded-full transition-all duration-200',
          active
            ? 'bg-yellow-500/15 text-yellow-400'
            : 'bg-white/[0.04] text-white/35 hover:bg-white/[0.08] hover:text-white/70',
          className
        )}
      >
        <motion.div
          key={active ? 'on' : 'off'}
          initial={{ scale: 0.3, rotate: -45 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 15 }}
        >
          <Star
            className={cn('w-3.5 h-3.5 transition-colors duration-150', iconClassName)}
            fill={active ? 'currentColor' : 'none'}
          />
        </motion.div>
      </motion.button>
    </TooltipTrigger>
    <TooltipContent>{active ? activeLabel : inactiveLabel}</TooltipContent>
  </Tooltip>
);

const LiveTVSectionDivider: React.FC<{ title: string; count: number }> = ({ title, count }) => (
  <div className="flex items-center gap-3 my-5">
    <div className="h-px flex-1 bg-white/10" />
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03]">
      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/65">{title}</span>
      <span className="text-[11px] tabular-nums text-white/30">{count}</span>
    </div>
    <div className="h-px flex-1 bg-white/10" />
  </div>
);

// Tailwind-aligned breakpoints for the IPTV grid. Mirrors the className
// `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6`.
const IPTV_GRID_GAP_PX = 12;
const useResponsiveIptvColumns = () => {
  const compute = () => {
    if (typeof window === 'undefined') return 2;
    const w = window.innerWidth;
    if (w >= 1280) return 6;
    if (w >= 1024) return 5;
    if (w >= 768) return 4;
    if (w >= 640) return 3;
    return 2;
  };
  const [columns, setColumns] = useState(compute);
  useEffect(() => {
    const handler = () => setColumns(compute());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return columns;
};

// Window-scrolled virtualizer for IPTV regular grid. Renders only visible
// rows; without this, a category like France (~3000 streams) creates ~45k DOM
// nodes and crashes the tab. — perf
const VirtualizedIptvGrid = <T,>({
  items,
  columns,
  getKey,
  renderItem,
}: {
  items: T[];
  columns: number;
  getKey: (item: T, index: number) => React.Key;
  renderItem: (item: T, index: number) => React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);

  useLayoutEffect(() => {
    if (containerRef.current) {
      offsetRef.current = containerRef.current.getBoundingClientRect().top + window.scrollY;
    }
  });

  const rowCount = Math.ceil(items.length / Math.max(columns, 1));
  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => 220,
    overscan: 4,
    scrollMargin: offsetRef.current,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: `${virtualizer.getTotalSize()}px`, width: '100%' }}
    >
      {virtualItems.map((virtualRow) => {
        const startIdx = virtualRow.index * columns;
        const rowItems = items.slice(startIdx, startIdx + columns);
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap: `${IPTV_GRID_GAP_PX}px`,
              paddingBottom: `${IPTV_GRID_GAP_PX}px`,
            }}
          >
            {rowItems.map((item, colIdx) => (
              <React.Fragment key={getKey(item, startIdx + colIdx)}>
                {renderItem(item, startIdx + colIdx)}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
};

// Live-updating "time until kickoff" label, isolated from the parent LiveTV
// component so a 1s tick re-renders only this leaf instead of the whole
// channel grid (potentially hundreds of motion.div cards). Replaces a global
// `setInterval(() => setCountdownUpdate(n => n + 1), 1000)` + `void
// countdownUpdate;` trick that forced LiveTV to re-render every second. — perf
type TimeRemainingT = (key: string, params?: Record<string, unknown>) => string;
const TimeRemaining = memo(({ timestamp, t }: { timestamp: number; t: TimeRemainingT }) => {
  const [, force] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled) return;
      const diff = timestamp - Date.now();
      const seconds = Math.floor(diff / 1000);
      // 1s ticks are only useful while we display HH:MM:SS (within ~5min of
      // kickoff, see formatTimeRemaining). Otherwise the relative label
      // changes at minute resolution at best — use a 30s tick.
      const next = seconds < 300 ? 1000 : 30000;
      timer = setTimeout(() => {
        force((n) => n + 1);
        schedule();
      }, next);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [timestamp]);

  const result = formatTimeRemaining(timestamp, t);
  // Heure dépassée sans que l'amont ait basculé la rencontre en direct : il
  // n'y a plus de compte à rebours à montrer, et prétendre « en cours »
  // serait faux. L'appelant affiche l'horaire à la place.
  if (result.isPast) return null;
  return (
    <p className={cn('text-[10px] font-mono font-bold mt-1', result.isImminent ? 'text-emerald-400' : 'text-amber-400/70')}>
      {result.text}
    </p>
  );
});
TimeRemaining.displayName = 'TimeRemaining';

const LiveTV: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState<string>('');
  const [selectedSource, setSelectedSource] = useState<string>('northlive'); // Default: free source (no extension/VIP)
  const [loadingCatalogs, setLoadingCatalogs] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Countdown ticking is now per-card via the <TimeRemaining/> component above.

  // IPTV Web states
  const [iptvCategories, setIptvCategories] = useState<IptvCategory[]>([]);
  const [iptvStreams, setIptvStreams] = useState<IptvStream[]>([]);
  const [selectedIptvCategory, setSelectedIptvCategory] = useState<string>('');
  const [iptvCategorySearch, setIptvCategorySearch] = useState('');
  const [loadingIptvCategories, setLoadingIptvCategories] = useState(false);
  const [loadingIptvStreams, setLoadingIptvStreams] = useState(false);
  const [iptvCategoryDropdownOpen, setIptvCategoryDropdownOpen] = useState(false);
  const iptvDropdownRef = useRef<HTMLDivElement>(null);
  const [favoriteChannels, setFavoriteChannels] = useState<LiveTVFavorite[]>(() => readLiveTvFavorites());
  const [favoriteIptvCategories, setFavoriteIptvCategories] = useState<FavoriteIptvCategory[]>(() => readFavoriteIptvCategories());
  const [, setPrefsVersion] = useState(0);
  useEffect(() => subscribeToPrefsChanges(() => setPrefsVersion((v) => v + 1)), []);
  const [launchTarget, setLaunchTarget] = useState<{
    source: string;
    targetId: string;
    kind: 'channel' | 'iptv';
    name?: string;
    poster?: string | null;
    catalogId?: string;
    categoryId?: string;
  } | null>(null);
  const lastLaunchSelectionKeyRef = useRef<string | null>(null);
  const activeLaunchKeyRef = useRef<string | null>(null);

  // Close IPTV dropdown on outside click
  useEffect(() => {
    if (!iptvCategoryDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (iptvDropdownRef.current && !iptvDropdownRef.current.contains(e.target as Node)) {
        setIptvCategoryDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [iptvCategoryDropdownOpen]);

  // Filter catalogs by selected source
  const filteredCatalogs = catalogs.filter((catalog) => {
    const srcKey = getSourceKey(catalog.id);
    if (srcKey !== selectedSource) return false;
    return isLiveTvSourceEnabled(srcKey as LiveTvSourceKey);
  });

  // Get unique sources from catalogs
  const availableSources = [...new Set(catalogs.map(c => getSourceKey(c.id)))]
    .filter(s => s !== 'other')
    .filter(s => isLiveTvSourceEnabled(s as LiveTvSourceKey));

  // Access model:
  // - northlive is FREE (iframe embed, no extension/VIP) — always accessible.
  // - iptv is VIP-only.
  // - every other source needs full access (VIP OR extension).
  const isVip = isUserVip();
  const hasExtension = isExtensionAvailable();
  const hasFullAccess = isVip || hasExtension;

  const isSourceFree = (source: string) => source === 'northlive' || source === 'vavoo';
  const isSourceAccessible = (source: string) =>
    isSourceFree(source) ? true : source === 'iptv' ? isVip : hasFullAccess;
  const hasAccess = isSourceAccessible(selectedSource);

  const groupedChannels = useMemo(
    () => selectedSource === 'vavoo' ? groupVavooChannels(channels) : channels,
    [channels, selectedSource]
  );

  const filteredChannels = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase();

    return groupedChannels.filter((channel) => {
      // Exclure les chaînes désactivées (nom contenant # au début et à la fin)
      const name = channel.name.trim();
      if (name.startsWith('#') && name.endsWith('#')) return false;
      if (!normalizedSearch) return true;

      return name.toLocaleLowerCase().includes(normalizedSearch)
        || channel._vavooVariants?.some((variant) => (
          variant.originalName.toLocaleLowerCase().includes(normalizedSearch)
        ));
    });
  }, [groupedChannels, searchQuery]);

  const favoriteChannelKeys = useMemo(
    () => new Set(favoriteChannels.map((favorite) => favorite.key)),
    [favoriteChannels]
  );

  const favoriteIptvCategoryIds = useMemo(
    () => new Set(favoriteIptvCategories.map((category) => category.id)),
    [favoriteIptvCategories]
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIVE_TV_FAVORITES_STORAGE_KEY) {
        setFavoriteChannels(readLiveTvFavorites());
      }
      if (event.key === LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY) {
        setFavoriteIptvCategories(readFavoriteIptvCategories());
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const source = searchParams.get('source')?.trim();
    const targetId = searchParams.get('targetId')?.trim();
    const kind = searchParams.get('kind');

    if (!source || !targetId || (kind !== 'channel' && kind !== 'iptv')) {
      return;
    }

    const storedFavorite = readLiveTvFavorites().find((favorite) => (
      favorite.source === source
      && favorite.id === targetId
      && favorite.kind === kind
    ));

    setLaunchTarget({
      source,
      targetId,
      kind,
      name: storedFavorite?.name,
      poster: storedFavorite?.poster ?? null,
      catalogId: searchParams.get('catalogId')?.trim() || storedFavorite?.catalogId,
      categoryId: searchParams.get('categoryId')?.trim() || storedFavorite?.categoryId,
    });

    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const persistFavoriteChannels = useCallback((nextFavorites: LiveTVFavorite[]) => {
    setFavoriteChannels(nextFavorites);
    try {
      localStorage.setItem(LIVE_TV_FAVORITES_STORAGE_KEY, JSON.stringify(nextFavorites));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const persistFavoriteIptvCategories = useCallback((nextFavorites: FavoriteIptvCategory[]) => {
    setFavoriteIptvCategories(nextFavorites);
    try {
      localStorage.setItem(LIVE_TV_IPTV_CATEGORY_FAVORITES_STORAGE_KEY, JSON.stringify(nextFavorites));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const isFavoriteChannel = useCallback((source: string, id: string | number) => {
    return favoriteChannelKeys.has(buildLiveTvFavoriteKey(source, id));
  }, [favoriteChannelKeys]);

  const getFavoriteVariantId = useCallback((source: string, channel: Channel): string | null => {
    const channelIds = channel._vavooVariants?.map((variant) => variant.id) || [channel.id];
    return channelIds.find((id) => favoriteChannelKeys.has(buildLiveTvFavoriteKey(source, id))) || null;
  }, [favoriteChannelKeys]);

  const isFavoriteDisplayChannel = useCallback((source: string, channel: Channel): boolean => (
    getFavoriteVariantId(source, channel) !== null
  ), [getFavoriteVariantId]);

  const toggleFavoriteChannel = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    payload: {
      source: string;
      id: string | number;
      name: string;
      poster?: string | null;
      kind: 'channel' | 'iptv';
      catalogId?: string;
      categoryId?: string;
    }
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const favoriteKey = buildLiveTvFavoriteKey(payload.source, payload.id);
    const exists = favoriteChannelKeys.has(favoriteKey);

    if (exists) {
      const nextFavorites = favoriteChannels.filter((favorite) => favorite.key !== favoriteKey);
      persistFavoriteChannels(nextFavorites);
      toast.success(`${payload.name} ${t('liveTV.removedFromFavoritesToast')}`, { duration: 2000 });
      return;
    }

    const nextFavorites = [
      ...favoriteChannels,
      {
        key: favoriteKey,
        source: payload.source,
        id: String(payload.id),
        name: payload.name,
        poster: payload.poster ?? null,
        addedAt: new Date().toISOString(),
        kind: payload.kind,
        catalogId: payload.catalogId,
        categoryId: payload.categoryId,
      }
    ];

    persistFavoriteChannels(nextFavorites);
    toast.success(`${payload.name} ${t('liveTV.addedToFavoritesToast')}`, { duration: 2000 });
  }, [favoriteChannelKeys, favoriteChannels, persistFavoriteChannels, t]);

  const isFavoriteIptvCategory = useCallback((categoryId: string) => {
    return favoriteIptvCategoryIds.has(categoryId);
  }, [favoriteIptvCategoryIds]);

  const toggleFavoriteIptvCategory = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    category: Pick<IptvCategory, 'category_id' | 'category_name'>
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const exists = favoriteIptvCategoryIds.has(category.category_id);

    if (exists) {
      const nextFavorites = favoriteIptvCategories.filter((favorite) => favorite.id !== category.category_id);
      persistFavoriteIptvCategories(nextFavorites);
      toast.success(`${category.category_name} ${t('liveTV.removedCategoryFromFavoritesToast')}`, { duration: 2000 });
      return;
    }

    const nextFavorites = [
      ...favoriteIptvCategories,
      {
        id: category.category_id,
        name: category.category_name,
        addedAt: new Date().toISOString(),
      }
    ];

    persistFavoriteIptvCategories(nextFavorites);
    toast.success(`${category.category_name} ${t('liveTV.addedCategoryToFavoritesToast')}`, { duration: 2000 });
  }, [favoriteIptvCategoryIds, favoriteIptvCategories, persistFavoriteIptvCategories, t]);

  // Player state
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);

  // Gérer le bouton retour pour fermer le player
  useEffect(() => {
    if (selectedChannel) {
      window.history.pushState({ playerOpen: true }, '');

      const handlePopState = () => {
        setSelectedChannel(null);
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [selectedChannel]);

  // Movix Wrapped 2026 - Track Live TV viewing time (only when channel is open)
  useWrappedTracker({
    mode: 'viewing',
    viewingData: selectedChannel ? {
      contentType: 'live-tv',
      contentId: selectedChannel.id,
      contentTitle: selectedChannel.name,
    } : undefined,
    isActive: !!selectedChannel,
  });

  // API Base URL (utilise notre backend)
  const API_BASE = import.meta.env.VITE_MAIN_API || 'http://localhost:25565';

  // The previous setInterval(1s) at this position bumped countdownUpdate state
  // to force the entire LiveTV grid (sometimes hundreds of motion.div cards)
  // to re-render every second just to refresh the time-remaining labels. The
  // tick now lives inside <TimeRemaining/>, scoped to one leaf per card. — perf

  const fetchCatalogChannelsById = useCallback(async (catalogId: string): Promise<Channel[]> => {
    const srcKey = getSourceKey(catalogId) as LiveTvSourceKey;
    if (!isLiveTvSourceEnabled(srcKey)) {
      return [];
    }
    let data;

    // northlive and vavoo are served only by our API (the extension doesn't know them).
    if (isExtensionAvailable() && !catalogId.startsWith('northlive_') && !catalogId.startsWith('vavoo_')) {
      data = await fetchFromExtension('GET_CATALOG', { type: 'tv', id: catalogId });
    } else {
      const response = await fetch(`${API_BASE}/api/livetv/catalog/tv/${catalogId}`);
      if (!response.ok) {
        throw new Error(t('liveTV.loadChannelsError'));
      }
      data = await response.json();
    }

    return Array.isArray(data?.metas) ? data.metas : [];
  }, [API_BASE, t]);

  // Fetch catalogs from manifest
  useEffect(() => {
    const fetchManifest = async () => {
      try {
        setLoadingCatalogs(true);
        // 1. Toujours récupérer le manifest local (qui contient Linkzy)
        let localCatalogs: Catalog[] = [];
        try {
          const response = await fetch(`${API_BASE}/api/livetv/manifest`);
          if (response.ok) {
            const result = await response.json();
            localCatalogs = result.catalogs || [];
          }
        } catch (e) {
          console.error("Erreur manifest local", e);
        }

        // 2. Si extension, récupérer le manifest extension
        let extensionCatalogs: Catalog[] = [];
        if (isExtensionAvailable()) {
          console.log("Using Movix Extension");
          try {
            const result = await fetchFromExtension<{ catalogs?: Catalog[] }>('GET_MANIFEST');
            extensionCatalogs = result.catalogs || [];
          } catch (e) {
            console.error("Erreur manifest extension", e);
          }
        }

        // 3. Fusionner les catalogues
        const catalogsMap = new Map<string, Catalog>();
        localCatalogs.forEach(c => catalogsMap.set(c.id, c));
        extensionCatalogs.forEach(c => catalogsMap.set(c.id, c));
        
        const filteredCatalogs = Array.from(catalogsMap.values());

        if (filteredCatalogs.length === 0) {
           throw new Error(t('liveTV.loadCategoriesError'));
        }

        setCatalogs(filteredCatalogs);

        // Auto-select source and catalog. northlive (free) wins for everyone so
        // the page works with no extension/VIP; else the first available catalog.
        if (filteredCatalogs.length > 0) {
          const preferred =
            filteredCatalogs.find(c => getSourceKey(c.id) === 'northlive') ||
            filteredCatalogs[0];
          setSelectedCatalog(preferred.id);
          setSelectedSource(getSourceKey(preferred.id));
        }
      } catch (err) {
        console.error('Error fetching manifest:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
      } finally {
        setLoadingCatalogs(false);
      }
    };

    fetchManifest();
  }, [hasFullAccess]);

  useEffect(() => {
    if (!launchTarget || catalogs.length === 0) return;

    const launchSelectionKey = `${launchTarget.source}:${launchTarget.targetId}:${launchTarget.kind}:${launchTarget.catalogId || ''}:${launchTarget.categoryId || ''}`;
    if (launchSelectionKey === lastLaunchSelectionKeyRef.current) {
      return;
    }

    const sourceAccessible = isSourceAccessible(launchTarget.source);
    if (!sourceAccessible) {
      return;
    }

    if (launchTarget.source === 'iptv') {
      setSelectedSource('iptv');
      setSelectedCatalog('');
      setChannels([]);
      if (launchTarget.categoryId) {
        setSelectedIptvCategory(launchTarget.categoryId);
      }
      lastLaunchSelectionKeyRef.current = launchSelectionKey;
      return;
    }

    const sourceCatalogs = catalogs.filter((catalog) => getSourceKey(catalog.id) === launchTarget.source);
    const preferredCatalog = sourceCatalogs.find((catalog) => catalog.id === launchTarget.catalogId) || sourceCatalogs[0];

    if (!preferredCatalog) {
      return;
    }

    setSelectedSource(launchTarget.source);
    setSelectedCatalog(preferredCatalog.id);
    setSelectedIptvCategory('');
    lastLaunchSelectionKeyRef.current = launchSelectionKey;
  }, [catalogs, hasFullAccess, isVip, launchTarget]);

  // Fetch channels when catalog changes
  useEffect(() => {
    if (!selectedCatalog || !hasAccess) return;

    const fetchChannels = async () => {
      try {
        setLoadingChannels(true);
        setError(null);
        let data;

        if (isExtensionAvailable() && !selectedCatalog.startsWith('northlive_') && !selectedCatalog.startsWith('vavoo_')) {
          data = await fetchFromExtension('GET_CATALOG', { type: 'tv', id: selectedCatalog });
        } else {
          const response = await fetch(`${API_BASE}/api/livetv/catalog/tv/${selectedCatalog}`);
          if (!response.ok) {
            throw new Error(t('liveTV.loadChannelsError'));
          }
          data = await response.json();
        }

        setChannels(data.metas || []);
      } catch (err) {
        console.error('Error fetching channels:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
        setChannels([]);
      } finally {
        setLoadingChannels(false);
      }
    };

    fetchChannels();
  }, [selectedCatalog, hasAccess]);

  // Fetch IPTV categories when IPTV source is selected
  useEffect(() => {
    if (selectedSource !== 'iptv' || !isVip) return;
    if (iptvCategories.length > 0) return; // already loaded

    const fetchIptvCategories = async () => {
      try {
        setLoadingIptvCategories(true);
        const response = await fetch(`${API_BASE}/api/livetv/iptv/categories`, {
          headers: { ...getVipHeaders() }
        });
        if (!response.ok) throw new Error(t('liveTV.loadCategoriesError'));
        const data = await response.json();
        setIptvCategories(data.categories || []);
      } catch (err) {
        console.error('Error fetching IPTV categories:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
      } finally {
        setLoadingIptvCategories(false);
      }
    };

    fetchIptvCategories();
  }, [selectedSource, isVip]);

  // Fetch IPTV streams when category changes
  useEffect(() => {
    if (selectedSource !== 'iptv' || !selectedIptvCategory || !isVip) return;

    const fetchIptvStreams = async () => {
      try {
        setLoadingIptvStreams(true);
        setIptvStreams([]);
        const response = await fetch(`${API_BASE}/api/livetv/iptv/streams/${selectedIptvCategory}`, {
          headers: { ...getVipHeaders() }
        });
        if (!response.ok) throw new Error(t('liveTV.loadChannelsError'));
        const data = await response.json();
        setIptvStreams(data.streams || []);
      } catch (err) {
        console.error('Error fetching IPTV streams:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
        setIptvStreams([]);
      } finally {
        setLoadingIptvStreams(false);
      }
    };

    fetchIptvStreams();
  }, [selectedIptvCategory, isVip]);

  // Ad Popup state
  const [showAd, setShowAd] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);

  const isTimedEventChannel = (channel: Channel) => channel.id.startsWith('match_');

  // Imminent = le coup d'envoi est dans moins de cinq minutes. Le test ne
  // portait que sur la borne haute : une heure déjà passée donnait un écart
  // négatif, donc « imminent » pour l'éternité.
  const isImminentEventChannel = (channel: Channel) => {
    if (!channel._timestamp) return false;
    const diff = channel._timestamp - Date.now();
    return diff > 0 && diff < 300000;
  };

  // Une rencontre n'est cliquable que si l'amont annonce au moins un serveur.
  // « En direct » ne suffisait pas : un match live sans serveur renvoyait un
  // 404 (« Flux match introuvable ») que le lecteur s'obstinait à retenter.
  const isPlayableEventChannel = (channel: Channel) =>
    !isTimedEventChannel(channel) || (channel._serverCount || 0) > 0;

  const displayedChannels = filteredChannels;

  const favoriteDisplayedChannels = useMemo(
    () => displayedChannels.filter((channel) => isFavoriteDisplayChannel(selectedSource, channel)),
    [displayedChannels, isFavoriteDisplayChannel, selectedSource]
  );

  const regularDisplayedChannels = useMemo(
    () => displayedChannels.filter((channel) => !isFavoriteDisplayChannel(selectedSource, channel)),
    [displayedChannels, isFavoriteDisplayChannel, selectedSource]
  );

  const handleChannelClick = useCallback((channel: Channel) => {
    if (!isPlayableEventChannel(channel)) {
      return;
    }

    // Les VIPs n'ont pas de publicité
    if (isVip) {
      setSelectedChannel(channel);
      return;
    }

    const credits = parseInt(sessionStorage.getItem('livetv_ad_credits') || '0');
    if (credits > 0) {
      sessionStorage.setItem('livetv_ad_credits', (credits - 1).toString());
      setSelectedChannel(channel);
    } else {
      setPendingChannel(channel);
      setShowAd(true);
    }
  }, [isVip]);

  const handleIptvChannelClick = async (stream: IptvStream) => {
    try {
      const response = await fetch(`${API_BASE}/api/livetv/iptv/stream-url/${stream.stream_id}`, {
        headers: { ...getVipHeaders() }
      });
      if (!response.ok) throw new Error(t('liveTV.streamFetchError'));
      const data = await response.json();
      const streamUrl = data.streams?.[0]?.url;
      if (streamUrl) {
        // Créer un Channel virtuel pour le LiveTVPlayer
        setSelectedChannel({
          id: `iptv_${stream.stream_id}`,
          type: 'tv',
          name: stream.name,
          poster: stream.stream_icon || '',
        });
      }
    } catch (err) {
      console.error('Error getting IPTV stream URL:', err);
      setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
    }
  };

  const openIptvFavoriteById = useCallback(async (
    streamId: string | number,
    options?: { name?: string; poster?: string | null }
  ) => {
    try {
      const response = await fetch(`${API_BASE}/api/livetv/iptv/stream-url/${streamId}`, {
        headers: { ...getVipHeaders() }
      });
      if (!response.ok) throw new Error(t('liveTV.streamFetchError'));
      const data = await response.json();
      const streamUrl = data.streams?.[0]?.url;
      if (streamUrl) {
        setSelectedChannel({
          id: `iptv_${streamId}`,
          type: 'tv',
          name: options?.name || t('liveTV.iptvWebSource'),
          poster: options?.poster || '',
        });
      }
    } catch (err) {
      console.error('Error getting IPTV stream URL:', err);
      setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
    }
  }, [API_BASE, t]);

  const handleAdAccept = () => {
    // Le user a regardé la pub, on lui donne 2 crédits
    // On consomme immédiatement 1 crédit pour la chaîne actuelle, donc il en reste 1
    sessionStorage.setItem('livetv_ad_credits', '1');
    setShowAd(false);
    if (pendingChannel) {
      setSelectedChannel(pendingChannel);
      setPendingChannel(null);
    }
  };

  const handleClosePlayer = () => {
    window.history.back();
  };

  const handleCloseAd = () => {
    setShowAd(false);
    setPendingChannel(null);
  };

  const resolveLaunchChannelTarget = useCallback(async (target: NonNullable<typeof launchTarget>) => {
    const sourceCatalogs = catalogs.filter((catalog) => getSourceKey(catalog.id) === target.source);
    if (sourceCatalogs.length === 0) {
      return null;
    }

    const prioritizedCatalogIds = [
      target.catalogId,
      selectedCatalog,
      ...sourceCatalogs.map((catalog) => catalog.id),
    ].filter((catalogId, index, array): catalogId is string => Boolean(catalogId) && array.indexOf(catalogId) === index);

    for (const catalogId of prioritizedCatalogIds) {
      let catalogChannels: Channel[] = [];

      if (catalogId === selectedCatalog && getSourceKey(selectedCatalog) === target.source && channels.length > 0) {
        catalogChannels = channels;
      } else {
        try {
          catalogChannels = await fetchCatalogChannelsById(catalogId);
        } catch (error) {
          console.error(`Error resolving Live TV favorite for catalog ${catalogId}:`, error);
          continue;
        }
      }

      const matchedChannel = catalogChannels.find((channel) => String(channel.id) === target.targetId);
      if (matchedChannel) {
        return {
          catalogId,
          catalogChannels,
          channel: matchedChannel,
        };
      }
    }

    return null;
  }, [catalogs, channels, fetchCatalogChannelsById, selectedCatalog]);

  useEffect(() => {
    if (!launchTarget) return;

    const launchKey = `${launchTarget.source}:${launchTarget.targetId}:${launchTarget.kind}:${launchTarget.catalogId || ''}:${launchTarget.categoryId || ''}`;
    if (activeLaunchKeyRef.current === launchKey) {
      return;
    }

    const sourceAccessible = isSourceAccessible(launchTarget.source);

    if (!sourceAccessible) {
      setLaunchTarget(null);
      return;
    }

    activeLaunchKeyRef.current = launchKey;
    let cancelled = false;

    const run = async () => {
      try {
        if (launchTarget.kind === 'iptv') {
          if (launchTarget.categoryId && launchTarget.categoryId !== selectedIptvCategory) {
            setSelectedIptvCategory(launchTarget.categoryId);
          }

          await openIptvFavoriteById(launchTarget.targetId, {
            name: launchTarget.name,
            poster: launchTarget.poster,
          });

          if (!cancelled) {
            setLaunchTarget(null);
          }
          return;
        }

        const resolved = await resolveLaunchChannelTarget(launchTarget);
        if (cancelled) return;

        if (resolved) {
          setSelectedSource(launchTarget.source);
          if (selectedCatalog !== resolved.catalogId) {
            setSelectedCatalog(resolved.catalogId);
          }
          setChannels(resolved.catalogChannels);
          handleChannelClick(resolved.channel);
        }

        setLaunchTarget(null);
      } finally {
        if (!cancelled && activeLaunchKeyRef.current === launchKey) {
          activeLaunchKeyRef.current = null;
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (activeLaunchKeyRef.current === launchKey) {
        activeLaunchKeyRef.current = null;
      }
    };
  }, [
    handleChannelClick,
    hasFullAccess,
    isVip,
    launchTarget,
    openIptvFavoriteById,
    resolveLaunchChannelTarget,
    selectedCatalog,
    selectedIptvCategory,
  ]);

  // Helper pour formater le nom du catalogue proprement
  const formatCatalogName = (catalog: Catalog) => {

    // Vavoo categories are country/region groups (proper nouns) — keep them
    // verbatim (the generic keyword translation below would mangle e.g.
    // "France Sport" → "Sport"). The emoji comes from categoryEmojis.
    if (catalog.id === 'vavoo_all') return t('common.all');
    if (catalog.id.startsWith('vavoo_')) return catalog.name;

    // Idem pour les sports FCTV : le backend renvoie déjà « Football »,
    // « Sports de combat »… et la traduction par mots-clés ci-dessous les
    // écraserait tous en « Sport ».
    if (catalog.id.startsWith('matches_')) return catalog.name;

    let name = catalog.name;

    // 1. Enlever les préfixes de source connus
    const prefixes = ['Linkzy', 'FCTV'];
    for (const prefix of prefixes) {
      if (name.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) {
        name = name.slice(prefix.length + 1);
      }
    }

    // 2. Enlever les emojis du nom (car on affiche déjà une icône)
    name = name.replace(/([✀-➿]|[-]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();

    // 3. Translate known category keywords
    const lowerName = name.toLowerCase();
    if (lowerName.includes('g\u00e9n\u00e9raliste') || lowerName.includes('generalist')) return t('liveTV.catGeneraliste');
    if (lowerName.includes('cin\u00e9ma') || lowerName.includes('cinema') || lowerName.includes('film')) return t('liveTV.catCinema');
    if (lowerName.includes('sport') || lowerName.includes('foot')) return t('liveTV.catSport');
    if (lowerName.includes('documentaire') || lowerName.includes('docu')) return t('liveTV.catDocumentaire');
    if (lowerName.includes('enfant') || lowerName.includes('kid')) return t('liveTV.catEnfants');
    if (lowerName.includes('info') || lowerName.includes('news') || lowerName.includes('actualit')) return t('liveTV.catInfo');
    if (lowerName.includes('musique') || lowerName.includes('music')) return t('liveTV.catMusique');
    if (lowerName.includes('france')) return t('liveTV.catFrance');
    if (lowerName.includes('international')) return t('liveTV.catInternational');
    if (lowerName.includes('g\u00e9n\u00e9ral') || lowerName.includes('general')) return t('liveTV.catGeneral');

    return name || catalog.name;
  };

  // Helper pour obtenir l'emoji du catalogue (priorité: map > nom > inférence > défaut)
  const getCatalogEmoji = (catalog: Catalog) => {
    // 1. Check predefined map
    if (categoryEmojis[catalog.id]) return categoryEmojis[catalog.id];

    // 2. Try to find emoji in the ORIGINAL name
    const emojiMatch = catalog.name.match(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/);
    if (emojiMatch) return emojiMatch[0];

    // 3. Infer from ID or Name keywords
    const lowerId = catalog.id.toLowerCase();
    const lowerName = catalog.name.toLowerCase();
    
    if (lowerId.includes('sport') || lowerName.includes('sport') || lowerName.includes('foot')) return '⚽';
    if (lowerId.includes('movie') || lowerId.includes('film') || lowerId.includes('cinema') || lowerName.includes('film') || lowerName.includes('ciné')) return '🎬';
    if (lowerId.includes('news') || lowerId.includes('info') || lowerName.includes('info')) return '📰';
    if (lowerId.includes('kid') || lowerId.includes('enfant') || lowerName.includes('enfant')) return '👶';
    if (lowerId.includes('music') || lowerId.includes('musi')) return '🎵';
    if (lowerId.includes('docu') || lowerName.includes('docu')) return '🌍';
    if (lowerId.includes('general') || lowerName.includes('general')) return '📺';

    return '📺';
  };

  // Catalog icon: vavoo country groups render a flag via react-country-flag.
  const getCatalogIcon = (catalog: Catalog): React.ReactNode => {
    if (catalog.id.startsWith('vavoo_')) {
      const code = vavooGroupCountry[catalog.id];
      if (code) {
        return (
          <ReactCountryFlag
            countryCode={code}
            svg
            style={{ width: '1.15em', height: '1.15em', borderRadius: '2px' }}
            aria-label={code}
          />
        );
      }
      return <Globe className="w-3.5 h-3.5" />; // All, Balkans — no single country
    }
    return <span className="text-base">{getCatalogEmoji(catalog)}</span>;
  };

  // Source icons mapping
  const sourceIcons: Record<string, React.ReactNode> = {
    'vavoo': <Radio className="w-3.5 h-3.5" />,
    'fctv': <span className="text-sm leading-none">⚽</span>,
    'iptv': <i className="bi bi-globe text-sm" />,
  };

  // All sources for pill tabs (inject IPTV if VIP)
  const allSources = useMemo(() => {
    const sources = [...availableSources];
    if (isVip && !sources.includes('iptv')) sources.push('iptv');
    return sources;
  }, [availableSources, isVip]);

  const handleSourceChange = (newSource: string) => {
    if (!isSourceAccessible(newSource)) return;

    setSelectedSource(newSource);
    if (newSource === 'iptv') {
      setSelectedCatalog('');
      setChannels([]);
    } else {
      const firstCatalog = catalogs.find(c => getSourceKey(c.id) === newSource);
      if (firstCatalog) setSelectedCatalog(firstCatalog.id);
    }
  };

  // Skeleton loader component
  const ChannelSkeleton = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-video rounded-xl bg-white/5" />
          <div className="mt-2 h-3 w-3/4 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );

  // Filtered IPTV streams for search
  const filteredIptvStreams = useMemo(
    () => {
      const normalizedSearchQuery = searchQuery.trim().toLowerCase();

      return iptvStreams.filter((stream) => {
        if (stream.name.includes('#')) {
          return false;
        }

        return normalizedSearchQuery.length === 0 || stream.name.toLowerCase().includes(normalizedSearchQuery);
      });
    },
    [iptvStreams, searchQuery]
  );

  const selectedIptvCategoryName = useMemo(() => {
    if (!selectedIptvCategory) return '';
    return (
      iptvCategories.find((category) => category.category_id === selectedIptvCategory)?.category_name
      || favoriteIptvCategories.find((category) => category.id === selectedIptvCategory)?.name
      || ''
    );
  }, [favoriteIptvCategories, iptvCategories, selectedIptvCategory]);

  const favoriteIptvCategoryShortcuts = useMemo(() => {
    const categoriesMap = new Map(iptvCategories.map((category) => [category.category_id, category]));
    return favoriteIptvCategories.map((favorite) => {
      const liveCategory = categoriesMap.get(favorite.id);
      return liveCategory || {
        category_id: favorite.id,
        category_name: favorite.name,
        parent_id: 0,
      };
    });
  }, [favoriteIptvCategories, iptvCategories]);

  const normalizedIptvCategorySearch = iptvCategorySearch.trim().toLowerCase();

  const filteredFavoriteIptvCategories = useMemo(
    () => favoriteIptvCategoryShortcuts.filter((category) => (
      normalizedIptvCategorySearch.length === 0
      || category.category_name.toLowerCase().includes(normalizedIptvCategorySearch)
    )),
    [favoriteIptvCategoryShortcuts, normalizedIptvCategorySearch]
  );

  const filteredRegularIptvCategories = useMemo(
    () => iptvCategories.filter((category) => (
      !favoriteIptvCategoryIds.has(category.category_id)
      && (
        normalizedIptvCategorySearch.length === 0
        || category.category_name.toLowerCase().includes(normalizedIptvCategorySearch)
      )
    )),
    [favoriteIptvCategoryIds, iptvCategories, normalizedIptvCategorySearch]
  );

  const favoriteIptvStreams = useMemo(
    () => filteredIptvStreams.filter((stream) => isFavoriteChannel('iptv', stream.stream_id)),
    [filteredIptvStreams, isFavoriteChannel]
  );

  const regularIptvStreams = useMemo(
    () => filteredIptvStreams.filter((stream) => !isFavoriteChannel('iptv', stream.stream_id)),
    [filteredIptvStreams, isFavoriteChannel]
  );

  const iptvColumns = useResponsiveIptvColumns();

  const channelGridClassName =
    'grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';

  // No per-card framer-motion — at ~3000 cards (e.g. France IPTV category) the
  // animation pipeline + DOM overwhelmed the tab. Plain div + CSS opacity
  // transition on hover is the budget. — perf
  const renderIptvCard = (stream: IptvStream, _index: number) => {
    const isFavorite = isFavoriteChannel('iptv', stream.stream_id);

    return (
      <div
        key={stream.stream_id}
        onClick={() => handleIptvChannelClick(stream)}
        className="group cursor-pointer"
      >
        <div className="relative aspect-video rounded-xl overflow-hidden bg-white/[0.02] border border-white/[0.04] group-hover:border-white/10 transition-all duration-300 group-hover:bg-white/[0.04]">
          <FavoriteChannelButton
            active={isFavorite}
            activeLabel={t('liveTV.removeFromFavorites')}
            inactiveLabel={t('liveTV.addToFavorites')}
            onToggle={(event) => toggleFavoriteChannel(event, {
              source: 'iptv',
              id: stream.stream_id,
              name: stream.name,
              poster: stream.stream_icon,
              kind: 'iptv',
              categoryId: selectedIptvCategory || stream.category_id,
            })}
          />
          {stream.stream_icon ? (
            <img
              src={stream.stream_icon}
              alt={stream.name}
              className="w-full h-full object-contain p-4"
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).parentElement!.querySelector('.iptv-fallback')?.classList.remove('hidden');
              }}
            />
          ) : null}
          <div className={cn('iptv-fallback w-full h-full flex flex-col items-center justify-center gap-1.5 p-3', stream.stream_icon ? 'hidden absolute inset-0' : '')}>
            <Tv className="w-6 h-6 text-white opacity-10" />
            <span className="text-[10px] text-white/30 line-clamp-2 text-center leading-tight">{stream.name}</span>
          </div>
          <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 bg-red-500 rounded text-[9px] font-bold tracking-wide uppercase">
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            {t('liveTV.liveTag')}
          </div>
          <div className="absolute inset-x-0 bottom-0 p-2 pt-6 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-[11px] font-medium text-white/90 truncate">{stream.name}</p>
          </div>
        </div>
      </div>
    );
  };

  const renderIptvCategoryOption = (category: IptvCategory) => {
    const active = selectedIptvCategory === category.category_id;
    const favorite = isFavoriteIptvCategory(category.category_id);

    return (
      <div
        key={category.category_id}
        className={cn(
          'group mx-1 flex items-center rounded-xl border pr-1 transition-colors',
          active
            ? 'bg-red-500/10 border-red-500/20'
            : 'border-transparent hover:bg-white/[0.04] hover:border-white/[0.05]'
        )}
      >
        <button
          type="button"
          onClick={() => {
            setSelectedIptvCategory(category.category_id);
            setIptvCategoryDropdownOpen(false);
            setIptvCategorySearch('');
          }}
          className="flex min-w-0 flex-1 items-center px-3 py-2 text-left text-sm"
        >
          <span className={cn('truncate pr-2', active ? 'text-red-400' : 'text-white/70 group-hover:text-white/90')}>
            {category.category_name}
          </span>
        </button>
        <FavoriteInlineButton
          active={favorite}
          activeLabel={t('liveTV.removeCategoryFromFavorites')}
          inactiveLabel={t('liveTV.addCategoryToFavorites')}
          onToggle={(event) => toggleFavoriteIptvCategory(event, category)}
          className="ml-auto h-7 w-7 shrink-0"
          iconClassName="w-3.5 h-3.5"
        />
      </div>
    );
  };

  const renderChannelCard = (channel: Channel, index: number) => {
    const isMatch = selectedCatalog.startsWith('matches_');
    const isNorthlive = selectedCatalog.startsWith('northlive_');
    const isVavoo = selectedCatalog.startsWith('vavoo_');
    const vavooServers = Array.from(new Set(
      channel._vavooVariants?.map((variant) => variant.server).filter(Boolean) || []
    ));
    const isEventCard = isMatch;
    // Northlive remains name-only; VAVOO displays its enriched poster when present.
    // Les matchs suivent la même règle : ni affiche, ni logo de ligue ou
    // d'équipe — juste l'emoji du sport, comme les cartes northlive.
    const isNoImage = isEventCard || isNorthlive;
    const isMatchLive = Boolean(channel._isLive);
    // timeRemaining display is rendered via <TimeRemaining/> below.
    const isClickableMatch = !isEventCard || isPlayableEventChannel(channel);
    const favoriteVariantId = getFavoriteVariantId(selectedSource, channel);
    const isFavorite = favoriteVariantId !== null;
    // Le libellé suit le statut réel de la rencontre, pas le fait qu'elle soit
    // cliquable : un match programmé pour demain mais pourvu d'un serveur
    // s'affichait « imminent », et « en cours » par-dessus le marché.
    const eventStatusLabel = !isEventCard
      ? t('liveTV.liveTag')
      : isMatchLive
        ? t('liveTV.liveTag')
        : isImminentEventChannel(channel)
          ? t('liveTV.imminentTag')
          : t('liveTV.upcomingTag');


    return (
      <motion.div
        key={channel.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: Math.min(index * 0.015, 0.3) }}
        onClick={() => handleChannelClick(channel)}
        className={cn('group', isEventCard && !isClickableMatch ? 'cursor-not-allowed' : 'cursor-pointer')}
      >
        <div className={cn(
          'relative rounded-xl overflow-hidden border transition-all duration-300',
          isNoImage ? 'aspect-video' : 'aspect-[2/3]',
          isEventCard && !isClickableMatch
            ? 'bg-white/[0.015] border-white/[0.03] opacity-50'
            : 'bg-white/[0.02] border-white/[0.04] group-hover:border-white/10 group-hover:bg-white/[0.04]'
        )}>
          <FavoriteChannelButton
            active={isFavorite}
            activeLabel={t('liveTV.removeFromFavorites')}
            inactiveLabel={t('liveTV.addToFavorites')}
            onToggle={(event) => toggleFavoriteChannel(event, {
              source: selectedSource,
              id: favoriteVariantId || channel.id,
              name: channel.name,
              poster: channel.poster,
              kind: 'channel',
              catalogId: selectedCatalog,
            })}
          />
          {!isNoImage && channel.poster ? (
            <img src={channel.poster} alt={channel.name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className={cn(
              'w-full h-full flex flex-col items-center justify-center gap-1 p-3 text-center',
              isEventCard && isClickableMatch ? 'bg-gradient-to-br from-emerald-950/40 to-transparent' : ''
            )}>
              {isEventCard ? (
                <>
                  <span className="text-base mb-0.5 opacity-60">{channel._emoji || '⚽'}</span>
                  <h3 className="text-xs font-medium text-white/60 line-clamp-2 leading-tight">
                    {channel.name}
                  </h3>
                  {isMatchLive ? (
                    channel._score ? (
                      <p className="text-[10px] font-medium text-emerald-400/80">{channel._score}</p>
                    ) : null
                  ) : (
                    <>
                      {/* Compte à rebours tant que le coup d'envoi est devant
                          nous ; sinon <TimeRemaining/> ne rend rien et
                          l'horaire prend le relais. */}
                      {channel._timestamp ? <TimeRemaining timestamp={channel._timestamp} t={t} /> : null}
                      {(!channel._timestamp || channel._timestamp <= Date.now()) && channel._timeText ? (
                        <p className="text-[10px] font-medium text-amber-400/70">{channel._timeText}</p>
                      ) : null}
                    </>
                  )}
                </>
              ) : (
                <>
                   <Tv className="w-6 h-6 mb-1 text-white opacity-10" />
                   <h3 className="text-xs font-medium text-white/60 line-clamp-2 leading-tight">{channel.name}</h3>
                   {isVavoo && channel._vavooVariants && channel._vavooVariants.length > 1 && vavooServers.length > 0 && (
                     <div className="mt-1.5 flex max-w-full items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[9px] font-medium text-white/35">
                       <Wifi className="h-3 w-3 shrink-0" />
                       <span className="truncate">
                         {t('liveTV.vavooServers')}: {vavooServers.join(' · ')}
                       </span>
                     </div>
                   )}
                 </>
               )}
            </div>
          )}

          {!isNoImage && (
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          )}

          <div className={cn(
            'absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase',
            isEventCard
              ? isClickableMatch ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/40'
              : 'bg-red-500 text-white'
          )}>
            <span className={cn('w-1.5 h-1.5 rounded-full', isEventCard && !isClickableMatch ? 'bg-white/30' : 'bg-white animate-pulse')} />
            {eventStatusLabel}
          </div>

          {!isNoImage && (
            <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/80 to-transparent">
              <h3 className="text-xs font-medium text-white truncate">{channel.name}</h3>
            </div>
          )}
        </div>
      </motion.div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white pt-20">

      {/* ── HEADER ── */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="mb-6"
        >
          <div className="flex flex-col gap-5">
            {/* Title row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="p-2.5 bg-red-500/10 rounded-xl border border-red-500/20">
                    <Tv className="w-6 h-6 text-red-500" />
                  </div>
                  <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                    {t('liveTV.title')}
                  </h1>
                  <p className="text-white/40 text-xs sm:text-sm mt-0.5">{t('liveTV.watchFavoriteChannels')}</p>
                </div>
              </div>

              {/* Search */}
              <div className="relative w-48 sm:w-64 md:w-80">
                <Input
                  type="text"
                  placeholder={t('liveTV.searchChannel')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 text-sm bg-white/[0.04] border-white/[0.06]"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white opacity-30 w-4 h-4" />
              </div>
            </div>

            {/* ── STREAM DISCLAIMER ── */}
            <div className="flex items-start gap-2.5 px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-xl">
                    <Wifi className="w-4 h-4 text-white opacity-[0.35] shrink-0 mt-0.5" />
              <p className="text-white/45 text-xs sm:text-sm leading-snug">{t('liveTV.streamDisclaimer')}</p>
            </div>

            {/* ── SOURCE PILL TABS ── */}
            {!loadingCatalogs && allSources.length > 0 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
                {allSources.map((source) => {
                  const isLocked = !isSourceAccessible(source);
                  const isActive = selectedSource === source;
                  const label = sourceDisplayNames[source]?.startsWith('liveTV.') ? t(sourceDisplayNames[source]) : (sourceDisplayNames[source] || source);

                  return (
                    <motion.button
                      key={source}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => !isLocked && handleSourceChange(source)}
                      className={cn(
                        'relative flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 border shrink-0',
                        isActive
                          ? 'bg-red-500/15 text-red-400 border-red-500/30 shadow-sm shadow-red-500/10'
                          : isLocked
                            ? 'bg-white/[0.02] text-white/25 border-white/[0.04] cursor-not-allowed'
                            : 'bg-white/[0.03] text-white/60 border-white/[0.06] hover:bg-white/[0.06] hover:text-white/90 hover:border-white/10'
                      )}
                    >
                      {sourceIcons[source]}
                      {label}
                      {isLocked && <Lock className="w-3 h-3 ml-0.5 text-white opacity-20" />}
                      {source === 'iptv' && !isLocked && (
                        <Badge variant="premium" className="text-[9px] px-1.5 py-0 ml-0.5">{t('common.vip')}</Badge>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            )}

            {/* ── FREE MODE NOTICE (other players need VIP / extension / mobile app) ── */}
            {!loadingCatalogs && !hasFullAccess && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-3 px-4 py-3 bg-gradient-to-r from-amber-500/[0.06] to-transparent border border-amber-500/10 rounded-xl sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Crown className="w-4 h-4 text-amber-400 shrink-0" />
                  <p className="text-amber-300/80 text-xs sm:text-sm">{t('liveTV.freeModeOtherSources')}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link to="/vip">
                    <Button size="sm" className="h-7 gap-1.5 border border-amber-500/20 bg-amber-500/20 px-3 text-xs text-amber-300 hover:bg-amber-500/30">
                      <Crown className="w-3.5 h-3.5" />
                      {t('common.vip')}
                    </Button>
                  </Link>
                  <Link to="/extension">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 border-emerald-500/20 px-3 text-xs text-emerald-400 hover:bg-emerald-500/5">
                      <Puzzle className="w-3.5 h-3.5" />
                      {t('common.extension')}
                    </Button>
                  </Link>
                  <Link to="/app">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 border-white/15 px-3 text-xs text-white/70 hover:bg-white/5">
                      <Smartphone className="w-3.5 h-3.5" />
                      {t('liveTV.mobileApp')}
                    </Button>
                  </Link>
                </div>
              </motion.div>
            )}

          </div>
        </motion.div>

        {/* ── CATEGORY BAR + IPTV DROPDOWN ── */}
        {!loadingCatalogs && hasAccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
            className="mb-6"
          >
            {selectedSource === 'iptv' ? (
              /* IPTV searchable category dropdown */
              <div className="w-full max-w-xl space-y-3">
                {favoriteIptvCategoryShortcuts.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-white/30">
                        {t('liveTV.favoriteCategories')}
                      </span>
                      <div className="h-px flex-1 bg-white/[0.08]" />
                    </div>
                    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                      {favoriteIptvCategoryShortcuts.map((category) => {
                        const active = selectedIptvCategory === category.category_id;

                        return (
                          <div
                            key={category.category_id}
                            className={cn(
                              'group flex shrink-0 items-center gap-1 rounded-full border pr-1 transition-all duration-200',
                              active
                                ? 'bg-yellow-500/10 border-yellow-500/30'
                                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/10'
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => setSelectedIptvCategory(category.category_id)}
                              className="flex items-center gap-2 px-3 py-1.5 text-sm"
                            >
                              <Star className="w-3.5 h-3.5 text-yellow-400" fill="currentColor" />
                              <span className={cn('max-w-52 truncate', active ? 'text-white' : 'text-white/75 group-hover:text-white/95')}>
                                {category.category_name}
                              </span>
                            </button>
                            <FavoriteInlineButton
                              active={true}
                              activeLabel={t('liveTV.removeCategoryFromFavorites')}
                              inactiveLabel={t('liveTV.addCategoryToFavorites')}
                              onToggle={(event) => toggleFavoriteIptvCategory(event, category)}
                              className="h-7 w-7 shrink-0 bg-yellow-500/15 text-yellow-400"
                              iconClassName="w-3.5 h-3.5"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="relative w-full sm:w-96" ref={iptvDropdownRef}>
                  {loadingIptvCategories ? (
                    <div className="flex items-center gap-3 h-10 px-4 bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/40 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('common.loading')}
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => setIptvCategoryDropdownOpen(!iptvCategoryDropdownOpen)}
                        className={cn(
                          'flex items-center gap-3 w-full h-10 px-4 rounded-lg text-sm transition-all duration-200 border',
                          iptvCategoryDropdownOpen
                            ? 'bg-white/[0.06] border-red-500/30 ring-1 ring-red-500/10'
                            : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/10'
                        )}
                      >
                        <i className="bi bi-globe text-red-400 shrink-0" />
                        <span className="truncate flex-1 text-left text-white/80">
                          {selectedIptvCategoryName || t('liveTV.chooseCategory')}
                        </span>
                        <span className="text-white/25 text-xs tabular-nums shrink-0">{iptvCategories.length}</span>
                        <ChevronDown className={cn('w-4 h-4 text-white opacity-30 shrink-0 transition-transform duration-200', iptvCategoryDropdownOpen && 'rotate-180')} />
                      </button>

                      <AnimatePresence>
                        {iptvCategoryDropdownOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.15 }}
                            className="absolute z-50 mt-1.5 w-full bg-[#141416] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/60 overflow-hidden"
                            data-lenis-prevent
                          >
                            <div className="p-2 border-b border-white/[0.06]">
                              <div className="relative">
                                <Input
                                  type="text"
                                  placeholder={t('common.searchPlaceholder')}
                                  value={iptvCategorySearch}
                                  onChange={(e) => setIptvCategorySearch(e.target.value)}
                                  className="pl-8 h-8 text-xs bg-white/[0.04] border-white/[0.06]"
                                  autoFocus
                                />
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-30" />
                              </div>
                            </div>
                            <div className="overflow-y-auto max-h-64 py-1" data-lenis-prevent>
                              {filteredFavoriteIptvCategories.length > 0 && (
                                <div className="px-3 pb-1 pt-2">
                                  <p className="text-[10px] uppercase tracking-[0.18em] text-white/25">
                                    {t('liveTV.favoriteCategories')}
                                  </p>
                                </div>
                              )}
                              {filteredFavoriteIptvCategories.map((category) => renderIptvCategoryOption(category))}

                              {filteredFavoriteIptvCategories.length > 0 && filteredRegularIptvCategories.length > 0 && (
                                <div className="px-3 py-2">
                                  <div className="h-px bg-white/[0.06]" />
                                </div>
                              )}

                              {filteredRegularIptvCategories.length > 0 && (
                                <div className="px-3 pb-1 pt-1">
                                  <p className="text-[10px] uppercase tracking-[0.18em] text-white/20">
                                    {t('liveTV.otherCategories')}
                                  </p>
                                </div>
                              )}
                              {filteredRegularIptvCategories.map((category) => renderIptvCategoryOption(category))}

                              {filteredFavoriteIptvCategories.length === 0 && filteredRegularIptvCategories.length === 0 && (
                                <p className="text-white/25 text-xs text-center py-6">{t('common.noResults')}</p>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}
                </div>
              </div>
            ) : filteredCatalogs.length > 1 ? (
              /* Regular category chips */
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                {filteredCatalogs.map((catalog) => {
                  const active = selectedCatalog === catalog.id;
                  return (
                    <button
                      key={catalog.id}
                      onClick={() => setSelectedCatalog(catalog.id)}
                      className={cn(
                        'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-all duration-200 border shrink-0',
                        active
                          ? 'bg-white/10 text-white border-white/15 font-medium'
                          : 'bg-white/[0.02] text-white/50 border-transparent hover:bg-white/[0.05] hover:text-white/70'
                      )}
                    >
                      {getCatalogIcon(catalog)}
                      {formatCatalogName(catalog)}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </motion.div>
        )}

        {/* ── LOADING STATE ── */}
        {loadingCatalogs && <ChannelSkeleton />}

        {/* ── ERROR STATE ── */}
        {error && !loadingCatalogs && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="p-4 rounded-2xl bg-red-500/[0.06] border border-red-500/10">
              <Wifi className="w-8 h-8 text-red-400 opacity-60" />
            </div>
            <p className="text-white/50 text-sm max-w-xs text-center">{error}</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="text-xs">
              {t('liveTV.retry')}
            </Button>
          </motion.div>
        )}

        {/* ── NO ACCESS ── */}
        {!loadingCatalogs && !hasAccess && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-28 gap-6"
          >
            <div className="relative">
              <div className="p-6 bg-white/[0.02] rounded-3xl border border-white/[0.06]">
                <Tv className="w-14 h-14 text-white opacity-15" />
              </div>
              <div className="absolute -bottom-1 -right-1 p-1.5 bg-amber-500/20 rounded-lg border border-amber-500/20">
                <Lock className="w-3.5 h-3.5 text-amber-400" />
              </div>
            </div>
            <div className="text-center space-y-2 max-w-sm">
              <h2 className="text-lg font-semibold text-white">{t('liveTV.accessRequired')}</h2>
              <p className="text-white/40 text-sm leading-relaxed">{t('liveTV.accessRequiredDesc')}</p>
            </div>
            <div className="flex gap-2.5">
              <Link to="/extension">
                <Button variant="outline" size="sm" className="border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/5 gap-1.5 text-xs">
                  <Puzzle className="w-3.5 h-3.5" />
                  {t('common.extension')}
                </Button>
              </Link>
              <Link to="/vip">
                <Button size="sm" className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white border-0 gap-1.5 text-xs shadow-lg shadow-amber-900/20">
                  <Crown className="w-3.5 h-3.5" />
                  {t('common.vip')}
                </Button>
              </Link>
            </div>
          </motion.div>
        )}

        {/* ── IPTV GRID ── */}
        {!loadingCatalogs && hasAccess && selectedSource === 'iptv' && (
          <div className="pb-12">
            {loadingIptvStreams ? (
              <ChannelSkeleton />
            ) : !selectedIptvCategory ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <p className="text-3xl font-bold text-white/10 tabular-nums">{iptvCategories.length}</p>
                <div className="p-5 bg-white/[0.02] rounded-2xl border border-white/[0.04]">
                  <i className="bi bi-globe text-4xl text-white/10" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white/60 text-sm font-medium">{t('liveTV.selectCategoryPrompt')}</p>
                  <p className="text-white/25 text-xs">{t('liveTV.availableCategories', { count: iptvCategories.length })}</p>
                </div>
              </div>
            ) : filteredIptvStreams.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Radio className="w-10 h-10 text-white opacity-10" />
                <p className="text-white/40 text-sm">
                  {searchQuery ? t('liveTV.noChannelMatch') : t('liveTV.noChannelInCategory')}
                </p>
              </div>
            ) : (
              <motion.div
                key={selectedIptvCategory}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                {favoriteIptvStreams.length > 0 && (
                  <div className="space-y-3">
                    <LiveTVSectionDivider title={t('liveTV.favorites')} count={favoriteIptvStreams.length} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                      {favoriteIptvStreams.map((stream, index) => renderIptvCard(stream, index))}
                    </div>
                  </div>
                )}

                {regularIptvStreams.length > 0 && (
                  <div className="space-y-3">
                    {favoriteIptvStreams.length > 0 && (
                      <LiveTVSectionDivider title={t('liveTV.otherChannels')} count={regularIptvStreams.length} />
                    )}
                    <VirtualizedIptvGrid
                      items={regularIptvStreams}
                      columns={iptvColumns}
                      getKey={(stream) => stream.stream_id}
                      renderItem={(stream, index) => renderIptvCard(stream, favoriteIptvStreams.length + index)}
                    />
                  </div>
                )}
              </motion.div>
            )}
          </div>
        )}

        {/* ── CHANNELS GRID (non-IPTV) ── */}
        {!loadingCatalogs && hasAccess && selectedSource !== 'iptv' && (
          <div className="pb-12">
            {loadingChannels ? (
              <ChannelSkeleton />
            ) : favoriteDisplayedChannels.length === 0 && regularDisplayedChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Radio className="w-10 h-10 text-white opacity-10" />
                <p className="text-white/40 text-sm">
                  {searchQuery ? t('liveTV.noChannelMatch') : t('liveTV.noChannelInCategory')}
                </p>
              </div>
            ) : (
              <motion.div
                key={selectedCatalog}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                <>
                    {favoriteDisplayedChannels.length > 0 && (
                      <div className="space-y-3">
                        <LiveTVSectionDivider title={t('liveTV.favorites')} count={favoriteDisplayedChannels.length} />
                        <div className={channelGridClassName}>
                          {favoriteDisplayedChannels.map((channel, index) => renderChannelCard(channel, index))}
                        </div>
                      </div>
                    )}

                    {regularDisplayedChannels.length > 0 && (
                      <div className="space-y-3">
                        {favoriteDisplayedChannels.length > 0 && (
                          <LiveTVSectionDivider title={t('liveTV.otherChannels')} count={regularDisplayedChannels.length} />
                        )}
                        {selectedSource === 'vavoo' ? (
                          /* Vavoo groups (esp. "All") can be thousands of channels —
                             virtualize like the IPTV grid to avoid a DOM blow-up. */
                          <VirtualizedIptvGrid
                            items={regularDisplayedChannels}
                            columns={iptvColumns}
                            getKey={(channel) => channel.id}
                            renderItem={(channel, index) => renderChannelCard(channel, index)}
                          />
                        ) : (
                          <div className={channelGridClassName}>
                            {regularDisplayedChannels.map((channel, index) => renderChannelCard(channel, favoriteDisplayedChannels.length + index))}
                          </div>
                        )}
                      </div>
                    )}
                </>
              </motion.div>
            )}
          </div>
        )}
      </div>

      {/* ── PLAYER MODAL ── */}
      <AnimatePresence>
        {selectedChannel && (
          <LiveTVPlayer
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            channelPoster={selectedChannel.poster}
            vavooVariants={selectedChannel._vavooVariants}
            onClose={handleClosePlayer}
          />
        )}
      </AnimatePresence>

      {/* ── AD POPUP ── */}
      {showAd && (
        <AdFreePlayerAds
          onClose={handleCloseAd}
          onAccept={handleAdAccept}
          variant="livetv"
        />
      )}
    </div>
  );
};

export default LiveTV;
