import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Snowfall from 'react-snowfall';
import { useLocation, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Film, Search, Menu, X, Star, Tv2, Users, Clapperboard, Bell, Tv, Lightbulb, Network, List, Radio, Unlock, ChevronDown, ExternalLink, LayoutGrid, Settings, Dices, Sparkles, HelpCircle, Github, CalendarDays } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ProfileMenu from './ProfileMenu';
import NotificationsPopup from './NotificationsPopup';
import { getUnreadNotificationsCount, getNotificationsDisabled } from '../services/apiNotificationService';
import { encodeId } from '../utils/idEncoder';

import { useSearch } from '../context/SearchContext';
import { isUserVip } from '../utils/authUtils';
import { checkVipStatus } from '../utils/vipUtils';
import { useTranslation } from 'react-i18next';
import { SquareBackground } from './ui/square-background';
import { APRIL_FOOLS_ADMIN_PATH, isAprilFoolsAdminEnabled } from '../utils/aprilFools';
import { getOverlayPortalRoot } from '../utils/overlayPortal';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

// Couleurs pour les cards du mega menu
const cardColors: Record<string, { bg: string; text: string; border: string }> = {
  purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20' },
  green: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20' },
  blue: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20' },
  orange: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/20' },
  indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/20' },
  pink: { bg: 'bg-pink-500/10', text: 'text-pink-400', border: 'border-pink-500/20' },
  red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20' },
  sky: { bg: 'bg-sky-500/10', text: 'text-sky-400', border: 'border-sky-500/20' },
  yellow: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/20' },
  gray: { bg: 'bg-white/5', text: 'text-gray-400', border: 'border-white/10' },
};

interface ExploreItem {
  name: string;
  path: string;
  icon: React.ReactNode;
  color: string;
  desc: string;
  external?: boolean;
}

interface ExploreGroup {
  title: string;
  items: ExploreItem[];
}

const Header: React.FC = () => {
  const { t } = useTranslation();
  const [isExploreOpen, setIsExploreOpen] = useState(false);
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isSnowfallActive, setIsSnowfallActive] = useState(() => {
    return sessionStorage.getItem('snowfall_active') === 'true';
  });
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  useEffect(() => {
    sessionStorage.setItem('snowfall_active', String(isSnowfallActive));
  }, [isSnowfallActive]);

  useEffect(() => {
    const handleSnowfallToggle = () => {
      setIsSnowfallActive(sessionStorage.getItem('snowfall_active') === 'true');
    };
    window.addEventListener('snowfall_toggled', handleSnowfallToggle);
    return () => window.removeEventListener('snowfall_toggled', handleSnowfallToggle);
  }, []);

  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsDisabled, setNotificationsDisabled] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isVip, setIsVip] = useState(false);

  const [headerQuery, setHeaderQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const exploreRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const location = useLocation();
  const navigate = useNavigate();
  const isAprilFoolsAdminVisible = isAprilFoolsAdminEnabled(location.search);

  const {
    autocompleteSuggestions,
    loadingAutocomplete,
    fetchAutocompleteSuggestions,
    clearAutocompleteSuggestions
  } = useSearch();
  const { items: ageFilteredAutocomplete } = useAgeRestrictedContent(autocompleteSuggestions);

  // 4 items principaux visibles dans le header
  const mainNavItems = useMemo(() => [
    { name: t('nav.movies'), path: '/movies', icon: <Clapperboard size={16} />, isActive: location.pathname === '/movies' },
    { name: t('nav.tvShows'), path: '/tv-shows', icon: <Tv2 size={16} />, isActive: location.pathname === '/tv-shows' },
    { name: t('nav.anime'), path: '/anime', icon: <Sparkles size={16} />, isActive: location.pathname === '/anime' },
    { name: t('nav.search'), path: '/search', icon: <Search size={16} />, isActive: location.pathname === '/search' },
  ], [t, location.pathname]);

  // Groupes du mega menu — rangés par intention plutôt que par type de contenu :
  // ce que je cherche à voir / avec qui / ce qui passe maintenant / le reste.
  const exploreGroups: ExploreGroup[] = useMemo(() => [
    {
      // Trouver quoi regarder, du plus dirigé au plus sérendipitaire.
      title: t('nav.groupDiscover'),
      items: [
        { name: t('nav.collections'), path: '/collections', icon: <Film size={20} />, color: 'purple', desc: t('nav.collectionsDesc') },
        { name: t('nav.top10'), path: '/top10', icon: <Star size={20} />, color: 'yellow', desc: t('nav.top10Desc') },
        { name: t('nav.suggestions'), path: '/suggestion', icon: <Sparkles size={20} />, color: 'pink', desc: t('nav.suggestionsDesc') },
        { name: t('nav.roulette'), path: '/roulette', icon: <Dices size={20} />, color: 'red', desc: t('roulette.navDesc') },
        { name: t('nav.cinegraph'), path: '/cinegraph', icon: <Network size={20} />, color: 'blue', desc: t('nav.cinegraphDesc') },
      ]
    },
    {
      // Tout ce qui implique d'autres utilisateurs — Watch Party compris.
      title: t('nav.groupCommunity'),
      items: [
        { name: t('nav.watchParty'), path: '/watchparty/list', icon: <Users size={20} />, color: 'orange', desc: t('nav.watchPartyDesc') },
        { name: t('nav.sharedLists'), path: '/list-catalog', icon: <List size={20} />, color: 'indigo', desc: t('nav.sharedListsDesc') },
        { name: t('nav.greenlight'), path: '/wishboard', icon: <Lightbulb size={20} />, color: 'green', desc: t('nav.greenlightDesc') },
      ]
    },
    {
      // Ce qui passe en ce moment, puis ce qui arrive bientôt.
      title: t('nav.groupLive'),
      items: [
        { name: t('nav.liveTV'), path: '/live-tv', icon: <Tv size={20} />, color: 'red', desc: t('nav.liveTVDesc') },
        ...(isVip ? [{ name: t('nav.francetv'), path: '/ftv', icon: <Radio size={20} />, color: 'sky' as const, desc: t('nav.francetvDesc') }] : []),
        { name: t('nav.calendar'), path: '/calendar', icon: <CalendarDays size={20} />, color: 'green', desc: t('nav.calendarDesc') },
      ]
    },
    {
      // Outils du compte d'abord, liens externes en dernier.
      title: t('nav.groupTools'),
      items: [
        ...(isVip ? [{ name: t('nav.debrid'), path: '/debrid', icon: <Unlock size={20} />, color: 'yellow' as const, desc: t('nav.debridDesc') }] : []),
        { name: t('nav.settings'), path: '/settings', icon: <Settings size={20} />, color: 'gray', desc: t('nav.settingsDesc') },
        { name: t('nav.helpHub'), path: '/help', icon: <HelpCircle size={20} />, color: 'indigo', desc: t('nav.helpHubDesc') },
        { name: t('nav.github'), path: 'https://github.com/movixcorp/MovixOpenSource', icon: <Github size={20} />, color: 'gray', desc: t('nav.githubDesc'), external: true },
        { name: t('footer.ourUrls'), path: 'https://movix.online', icon: <ExternalLink size={20} />, color: 'gray', desc: t('nav.officialLinksDesc'), external: true },
      ]
    },
  ].filter(g => g.items.length > 0), [t, isVip]);

  // Auth
  useEffect(() => {
    let mounted = true;

    const checkAuth = () => {
      const auth = localStorage.getItem('auth');
      const discordAuth = localStorage.getItem('discord_auth');
      const googleAuth = localStorage.getItem('google_auth');
      const bip39Auth = localStorage.getItem('bip39_auth');
      const isVipUser = isUserVip();
      const isAuth = discordAuth === 'true' || googleAuth === 'true' || bip39Auth === 'true' || !!auth;
      setIsAuthenticated(isAuth);
      setIsVip(isVipUser);
    };
    checkAuth();
    window.addEventListener('storage', checkAuth);
    window.addEventListener('vipStatusChanged', checkAuth);

    if (localStorage.getItem('access_code')) {
      void checkVipStatus().then(() => {
        if (mounted) checkAuth();
      });
    }

    return () => {
      mounted = false;
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('vipStatusChanged', checkAuth);
    };
  }, []);

  // Notifications
  const refreshUnreadCount = useCallback(async () => {
    if (!isAuthenticated) { setUnreadCount(0); return; }
    try {
      const count = await getUnreadNotificationsCount();
      setUnreadCount(count);
    } catch {
      setUnreadCount(0);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      refreshUnreadCount();
      getNotificationsDisabled().then(setNotificationsDisabled);
      const interval = setInterval(refreshUnreadCount, 30000);
      return () => clearInterval(interval);
    } else {
      setUnreadCount(0);
      setNotificationsDisabled(false);
    }
  }, [refreshUnreadCount, isAuthenticated]);

  useEffect(() => {
    const handler = (e: Event) => {
      setNotificationsDisabled((e as CustomEvent).detail);
    };
    window.addEventListener('notifications_disabled_changed', handler);
    return () => window.removeEventListener('notifications_disabled_changed', handler);
  }, []);

  // Click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(event.target as Node) && searchInputRef.current && !searchInputRef.current.contains(event.target as Node)) {
        setShowAutocomplete(false);
      }
      if (showNotifications && notificationsRef.current) {
        const target = event.target as HTMLElement;
        if (target.closest('[data-notification-button]') || target.closest('[data-notifications-popup]')) return;
        if (!notificationsRef.current.contains(target)) setShowNotifications(false);
      }
      // Fermer mega menu desktop au clic extérieur
      if (isExploreOpen && exploreRef.current) {
        const target = event.target as HTMLElement;
        if (!exploreRef.current.contains(target) && !target.closest('[data-explore-trigger]')) {
          setIsExploreOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotifications, isExploreOpen]);

  // Overlay du menu fullscreen mobile : c'est lui le scroller (cf. le JSX).
  const exploreOverlayRef = useRef<HTMLDivElement>(null);

  // Bloquer le scroll (html + body + Lenis) quand le menu fullscreen est ouvert.
  // body en position:fixed avec top:-scrollY (technique body-scroll-lock) :
  // iOS ignore overflow:hidden sur body, et un fixed sans top compensé fait
  // sauter la page en haut derrière le menu + perd la position au retour.
  useEffect(() => {
    const isMobile = window.innerWidth < 1024;
    if (!(isExploreOpen && isMobile)) return;

    const lenis = (window as any).lenis;
    const scrollY = window.scrollY;
    const lockedPath = window.location.pathname;

    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    if (lenis) {
      lenis.destroy();
      // Sans ce delete, window.lenis pointe vers une instance détruite : le
      // test !window.lenis à la fermeture ne passe jamais et le smooth scroll
      // n'est jamais réinitialisé pour les utilisateurs qui l'ont activé.
      delete (window as any).lenis;
    }

    // Anti-chaînage iOS/WKWebView, sans preventDefault. Quand un geste démarre
    // pile sur un bord du scroller (scrollTop 0, ou fond atteint), WebKit
    // décide dès le premier touchmove de transférer le pan à l'ancêtre — ici
    // le document verrouillé ou l'UIScrollView du WKWebView — et le geste
    // entier est consommé sans rien faire : « des fois on ne peut pas
    // scroller ». On décolle donc le scroller du bord d'un pixel avant que la
    // décision soit prise.
    //
    // La version précédente preventDefault-ait ces gestes : c'était pire, un
    // simple tremblement de 1px vers le bas en haut de liste tuait le geste
    // entier puisque WebKit ne réévalue pas sa décision ensuite.
    const overlay = exploreOverlayRef.current;
    const nudgeOffEdges = () => {
      const el = exploreOverlayRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 2) return; // rien à faire défiler : le chaînage est sans effet
      if (el.scrollTop <= 0) el.scrollTop = 1;
      else if (el.scrollTop >= max) el.scrollTop = max - 1;
    };
    nudgeOffEdges();
    overlay?.addEventListener('touchstart', nudgeOffEdges, { passive: true });

    return () => {
      overlay?.removeEventListener('touchstart', nudgeOffEdges);
      document.documentElement.style.overflow = '';
      document.documentElement.style.overscrollBehavior = '';
      document.body.style.overflow = '';
      document.body.style.overscrollBehavior = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      // Restaure la position uniquement si on est resté sur la même page :
      // une navigation via un lien du menu doit laisser le scroll-to-top de
      // la nouvelle route gagner.
      if (window.location.pathname === lockedPath) {
        window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' as ScrollBehavior });
      }
      if (!(window as any).lenis) {
        window.dispatchEvent(new CustomEvent('settings_smooth_scroll_changed'));
      }
    };
  }, [isExploreOpen]);

  // Reset on navigation
  useEffect(() => {
    clearAutocompleteSuggestions();
    setShowAutocomplete(false);
    setIsExploreOpen(false);
    setIsMobileSearchOpen(false);
    setShowNotifications(false);
    if (location.pathname !== '/search') setHeaderQuery('');
  }, [location.pathname]);

  // Autocomplete dropdown position
  const prevDropdownPosRef = useRef<{ top: number; left: number } | null>(null);
  const dropdownRafIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!showAutocomplete) return;
    const activeInput = isMobileSearchOpen ? mobileSearchInputRef.current : searchInputRef.current;
    if (!activeInput) return;
    const calcPos = () => {
      const inputRect = activeInput.getBoundingClientRect();
      const dropdownWidth = Math.min(400, window.innerWidth * 0.92);
      let left = inputRect.left + inputRect.width / 2 - dropdownWidth / 2;
      const margin = 8;
      if (left + dropdownWidth > window.innerWidth - margin) left = window.innerWidth - margin - dropdownWidth;
      if (left < margin) left = margin;
      const top = inputRect.bottom + 8;
      if (dropdownRafIdRef.current != null) cancelAnimationFrame(dropdownRafIdRef.current);
      dropdownRafIdRef.current = requestAnimationFrame(() => {
        dropdownRafIdRef.current = null;
        const prev = prevDropdownPosRef.current;
        if (prev && prev.top === top && prev.left === left) return;
        prevDropdownPosRef.current = { top, left };
        setDropdownStyle({ position: 'fixed', top, left, width: dropdownWidth });
      });
    };
    calcPos();
    window.addEventListener('resize', calcPos);
    window.addEventListener('scroll', calcPos, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', calcPos);
      window.removeEventListener('scroll', calcPos, { capture: true } as EventListenerOptions);
      if (dropdownRafIdRef.current != null) {
        cancelAnimationFrame(dropdownRafIdRef.current);
        dropdownRafIdRef.current = null;
      }
    };
  // autocompleteSuggestions intentionally excluded — body doesn't reference it;
  // including it churns listener registration on every keystroke
  }, [showAutocomplete, isMobileSearchOpen]);

  // Focus mobile search input when opened
  useEffect(() => {
    if (isMobileSearchOpen && mobileSearchInputRef.current) {
      mobileSearchInputRef.current.focus();
    }
  }, [isMobileSearchOpen]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHeaderQuery(value);
    if (value.length >= 2) {
      fetchAutocompleteSuggestions(value);
      setShowAutocomplete(true);
    } else {
      clearAutocompleteSuggestions();
      setShowAutocomplete(false);
    }
  };

  const handleSelectAutocomplete = (item: any) => {
    clearAutocompleteSuggestions();
    setShowAutocomplete(false);
    setHeaderQuery('');
    setIsMobileSearchOpen(false);
    navigate(`/${item.media_type}/${encodeId(item.id)}`);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (headerQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(headerQuery)}`);
      setHeaderQuery('');
      setIsMobileSearchOpen(false);
    }
  };

  const renderExploreCard = (item: ExploreItem) => {
    const colors = cardColors[item.color] || cardColors.gray;
    const content = (
      <div className={`flex flex-col items-center text-center p-5 rounded-2xl border ${colors.border} bg-white/[0.04] active:bg-white/[0.08] transition-all duration-200 cursor-pointer h-full`}>
        <div className={`w-14 h-14 rounded-2xl ${colors.bg} ${colors.text} flex items-center justify-center mb-3 border ${colors.border}`}>
          {item.icon}
        </div>
        <span className="text-white text-sm font-semibold mb-1">{item.name}</span>
        <span className="text-white/50 text-xs leading-tight">{item.desc}</span>
      </div>
    );

    if (item.external) {
      return (
        <a key={item.path} href={item.path} target="_blank" rel="noopener noreferrer" onClick={() => setIsExploreOpen(false)}>
          {content}
        </a>
      );
    }
    return (
      <Link key={item.path} to={item.path} onClick={() => setIsExploreOpen(false)}>
        {content}
      </Link>
    );
  };

  // Toutes les items pour le fullscreen mobile
  const allExploreItems = exploreGroups.flatMap(g => g.items);

  return (
    <>
      {/* max-lg:pointer-events-none quand le menu fullscreen est ouvert : le
          header (z-11000) reste au-dessus de l'overlay (z-10999) pour montrer
          la croix — sans ça, tout geste de scroll qui démarre dans la bande
          des ~64px du header est avalé par lui et le menu ne bouge pas. Le
          bouton burger/croix garde pointer-events-auto pour rester cliquable. */}
      <header className={`!fixed inset-x-0 top-0 w-full z-[11000] transition-all duration-300 ${isExploreOpen ? 'max-lg:pointer-events-none' : ''}`}>
        <div className="absolute inset-0 pointer-events-none z-0 bg-gradient-to-b from-black/90 via-black/70 to-transparent" aria-hidden="true" />
        <div className="relative z-10">
          <div className="max-w-[1400px] 2xl:max-w-[1600px] mx-auto">
            <div className="flex items-center h-16 px-4 md:px-6 lg:px-8 gap-3 md:gap-5">

              {/* Logo */}
              <Link
                to="/"
                className="text-2xl md:text-3xl font-extrabold flex items-center hover:scale-105 transition-transform duration-300 flex-shrink-0"
                onClick={(e) => {
                  if (location.pathname === '/') {
                    e.preventDefault();
                    const lenis = (window as any).lenis;
                    if (lenis) {
                      lenis.scrollTo(0, { duration: 1.2 });
                    } else {
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                  }
                }}
              >
                <span className="text-red-600 tracking-wider">MOVIX</span>
              </Link>

              {/* Desktop Nav: 3 items principaux + Explorer */}
              <nav className="hidden lg:flex items-center gap-1">
                {mainNavItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200 ${
                      item.isActive
                        ? 'text-white bg-white/10 font-medium'
                        : 'text-gray-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {item.icon}
                    <span>{item.name}</span>
                  </Link>
                ))}

                {isAprilFoolsAdminVisible && (
                  <Link
                    to={APRIL_FOOLS_ADMIN_PATH}
                    className={`ml-1 flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm transition-all duration-200 ${
                      location.pathname === APRIL_FOOLS_ADMIN_PATH
                        ? 'border-amber-300/35 bg-amber-300/15 text-white'
                        : 'border-amber-300/20 bg-amber-300/10 text-amber-100 hover:border-amber-300/35 hover:bg-amber-300/15 hover:text-white'
                    }`}
                  >
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300/60" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-200" />
                    </span>
                    <Settings size={15} />
                    <span>{t('aprilAdmin.navLabel')}</span>
                  </Link>
                )}

                {/* Bouton Explorer */}
                <button
                  data-explore-trigger
                  onClick={() => setIsExploreOpen(!isExploreOpen)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200 border ${
                    isExploreOpen
                      ? 'text-white bg-white/10 border-white/20'
                      : 'text-gray-400 hover:text-white border-white/10 hover:border-white/20 hover:bg-white/5'
                  }`}
                >
                  <LayoutGrid size={15} />
                  <span>{t('nav.explore')}</span>
                  <ChevronDown size={14} className={`transition-transform duration-200 ${isExploreOpen ? 'rotate-180' : ''}`} />
                </button>
              </nav>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Desktop Search */}
              <div className="hidden md:block relative w-[14rem] lg:w-[15rem] xl:w-[20rem] 2xl:w-[22rem]">
                <form onSubmit={handleSearchSubmit} className="relative">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={headerQuery}
                    onChange={handleQueryChange}
                    placeholder={t('header.searchPlaceholder')}
                    className="w-full py-2 pl-9 pr-3 bg-white/5 text-white rounded-xl border border-white/10 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 focus:bg-white/10 placeholder-gray-500 text-sm transition-all"
                  />
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  {headerQuery && (
                    <button
                      type="button"
                      onClick={() => { setHeaderQuery(''); clearAutocompleteSuggestions(); setShowAutocomplete(false); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  )}
                </form>
              </div>

              {/* Right section */}
              <div className="flex items-center gap-1 sm:gap-1.5">
                {isAprilFoolsAdminVisible && (
                  <Link
                    to={APRIL_FOOLS_ADMIN_PATH}
                    aria-label={t('aprilAdmin.mobileAriaLabel')}
                    className={`relative flex items-center justify-center rounded-xl border p-2 transition-colors lg:hidden ${
                      location.pathname === APRIL_FOOLS_ADMIN_PATH
                        ? 'border-amber-300/35 bg-amber-300/15 text-white'
                        : 'border-amber-300/20 bg-amber-300/10 text-amber-100 hover:border-amber-300/35 hover:bg-amber-300/15 hover:text-white'
                    }`}
                  >
                    <Settings size={18} />
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-200 shadow-[0_0_10px_rgba(253,230,138,0.85)]" />
                  </Link>
                )}

                {/* Mobile search icon */}
                <motion.button
                  className="md:hidden p-2 text-gray-400 hover:text-white transition-colors"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setIsMobileSearchOpen(true)}
                >
                  <Search size={20} />
                </motion.button>

                {/* Notifications */}
                {isAuthenticated && !notificationsDisabled && (
                  <div className="relative" ref={notificationsRef}>
                    <motion.button
                      data-notification-button
                      className="relative flex items-center justify-center p-2 text-gray-400 hover:text-white transition-colors"
                      whileTap={{ scale: 0.9 }}
                      onClick={() => setShowNotifications(!showNotifications)}
                    >
                      <Bell size={20} />
                      {unreadCount > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[10px] rounded-full h-4 min-w-4 flex items-center justify-center px-1 font-bold">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </motion.button>
                    <AnimatePresence>
                      {showNotifications && (
                        <div className="fixed right-4 sm:right-6 top-16 z-50">
                          <NotificationsPopup
                            onClose={() => setShowNotifications(false)}
                            onNotificationUpdate={refreshUnreadCount}
                          />
                        </div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Profile */}
                <div className="flex items-center cursor-pointer relative shrink-0">
                  <ProfileMenu />
                </div>

                {/* Mobile/Tablet: Burger → ouvre fullscreen explore */}
                <motion.button
                  className="lg:hidden p-1.5 text-gray-400 hover:text-white transition-colors pointer-events-auto"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setIsExploreOpen(!isExploreOpen)}
                  data-explore-trigger
                >
                  {isExploreOpen ? <X size={22} /> : <Menu size={22} />}
                </motion.button>
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Mega Menu Dropdown */}
        <AnimatePresence>
          {isExploreOpen && (
            <motion.div
              ref={exploreRef}
              className="hidden lg:block absolute top-full left-0 right-0 z-[11001]"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="max-w-[1400px] 2xl:max-w-[1600px] mx-auto px-8 pt-3 pb-2">
                <SquareBackground
                  squareSize={40}
                  borderColor="rgba(239, 68, 68, 0.08)"
                  className="border border-white/10 rounded-2xl shadow-2xl shadow-black/50 bg-black"
                >
                  <div className="p-8">
                    <div className="grid grid-cols-4 gap-10">
                      {exploreGroups.map((group) => (
                        <div key={group.title}>
                          <h4 className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-4 px-1">{group.title}</h4>
                          <div className="flex flex-col gap-3">
                            {group.items.map((item) => {
                              const colors = cardColors[item.color] || cardColors.gray;
                              const inner = (
                                <div className={`flex items-center gap-4 px-5 py-5 rounded-xl border ${colors.border} bg-white/[0.03] hover:${colors.bg} hover:scale-[1.02] transition-all duration-200 cursor-pointer`}>
                                  <div className={`w-12 h-12 rounded-xl ${colors.bg} ${colors.text} flex items-center justify-center flex-shrink-0 border ${colors.border}`}>
                                    {item.icon}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-white text-sm font-medium">{item.name}</div>
                                    <div className="text-white/40 text-xs truncate">{item.desc}</div>
                                  </div>
                                </div>
                              );
                              if (item.external) {
                                return <a key={item.path} href={item.path} target="_blank" rel="noopener noreferrer" onClick={() => setIsExploreOpen(false)}>{inner}</a>;
                              }
                              return <Link key={item.path} to={item.path} onClick={() => setIsExploreOpen(false)}>{inner}</Link>;
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </SquareBackground>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Fullscreen Explore Menu (Mobile/Tablet) */}
      {/* Porté dans la racine de surcouches (enfant direct de <body>) plutôt
          que rendu sur place. Sur place, la chaîne d'ancêtres du menu est
          #movix-fullscreen-host (`relative overflow-clip`) → #root
          (`overflow-x: clip`) → body (`position: relative; overflow-x: clip`).
          C'est la configuration connue pour casser `position: fixed` sur iOS
          WebKit : l'overlay est clippé ou mal dimensionné de façon
          intermittente selon l'état de la barre d'outils, et son scroller
          interne se retrouve avec scrollHeight == clientHeight — le menu
          s'affiche mais ne défile plus. Le portail sort des deux `clip`
          intérieurs et rend le dimensionnement de nouveau relatif au viewport. */}
      {createPortal(
        <AnimatePresence>
          {isExploreOpen && (
            // L'overlay EST le scroller. L'ancienne structure empilait
            // fixed inset-0 → SquareBackground (`overflow-hidden`, h-full) →
            // wrapper h-full → scroller h-full : quatre maillons de
            // height:100% dont WebKit résout parfois un maillon en `auto`, ce
            // qui rendait le scroller aussi haut que son contenu (donc plus
            // rien à faire défiler). Sans chaîne, plus de maillon à casser.
            // Opacity seule : une transform sur un ancêtre du scroller pendant
            // le mount laisse parfois sa région tactile obsolète dans l'arbre
            // de scroll asynchrone de WebKit.
            <motion.div
              ref={exploreOverlayRef}
              data-lenis-prevent
              className="lg:hidden fixed inset-0 z-[10999] overflow-y-auto bg-black"
              style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              {/* Décor en couche `fixed` derrière le contenu : il ne défile pas
                  et n'entre plus dans la chaîne de hauteur du scroller. */}
              <SquareBackground
                squareSize={48}
                borderColor="rgba(239, 68, 68, 0.2)"
                className="fixed inset-0 bg-black pointer-events-none"
              >
                {/* Glow effects — radial-gradient au lieu de blur-[100px].
                    Le blur 100px sur un 400×400 coûte ~3-5ms/frame en composit GPU
                    tant que le menu est ouvert (coût ∝ rayon²). Le radial-gradient
                    donne visuellement le même halo doux sans toucher au filter
                    pipeline → ~0ms. */}
                <div
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] pointer-events-none"
                  style={{
                    background:
                      'radial-gradient(circle, rgba(220, 38, 38, 0.18) 0%, rgba(220, 38, 38, 0.08) 35%, transparent 70%)',
                  }}
                />
                <div className="absolute bottom-0 left-0 right-0 h-[200px] bg-gradient-to-t from-red-950/15 to-transparent pointer-events-none" />
              </SquareBackground>

              <div className="relative">
                {/* Spacer pour le header */}
                <div className="h-20" />

                {/* Slide d'entrée ici (et pas sur l'overlay) : cf. commentaire
                    au-dessus du motion.div overlay. */}
                <motion.div
                  className="px-5 pb-12 pt-2"
                  initial={{ y: 40 }}
                  animate={{ y: 0 }}
                  exit={{ y: 40 }}
                  transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                >
                  {/* Items principaux en haut */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
                    {mainNavItems.map((item) => (
                      <Link
                        key={item.path}
                        to={item.path}
                        onClick={() => setIsExploreOpen(false)}
                        className={`flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-medium transition-all border whitespace-nowrap ${
                          item.isActive
                            ? 'bg-red-600/20 border-red-500/30 text-white'
                            : 'bg-white/[0.06] border-white/[0.08] text-gray-300 active:bg-white/10'
                        }`}
                      >
                        {item.icon}
                        <span>{item.name}</span>
                      </Link>
                    ))}
                  </div>

                  {/* Grille de cards */}
                  <div className="grid grid-cols-2 gap-4">
                    {allExploreItems.map((item) => renderExploreCard(item))}
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        getOverlayPortalRoot(),
      )}

      {/* Mobile Search Overlay */}
      <AnimatePresence>
        {isMobileSearchOpen && (
          <motion.div
            className="md:hidden fixed inset-x-0 top-0 z-[11002] bg-black/95 p-4"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
          >
            <form onSubmit={handleSearchSubmit} className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  ref={mobileSearchInputRef}
                  type="text"
                  value={headerQuery}
                  onChange={handleQueryChange}
                  placeholder={t('header.searchPlaceholder')}
                  className="w-full py-3 pl-10 pr-4 bg-white/10 text-white rounded-xl border border-white/15 focus:outline-none focus:border-red-500/50 placeholder-gray-500 text-sm"
                />
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              </div>
              <button
                type="button"
                onClick={() => { setIsMobileSearchOpen(false); setHeaderQuery(''); clearAutocompleteSuggestions(); setShowAutocomplete(false); }}
                className="p-2 text-gray-400 hover:text-white"
              >
                <X size={22} />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Autocomplete dropdown (shared between desktop & mobile search) */}
      <AnimatePresence>
        {showAutocomplete && ageFilteredAutocomplete.length > 0 && (
          <motion.div
            ref={autocompleteRef}
            className="bg-black/95 border border-white/15 rounded-xl shadow-2xl z-[12000] overflow-hidden"
            style={dropdownStyle}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="py-2">
              {loadingAutocomplete ? (
                <div className="flex justify-center items-center py-4">
                  <div className="w-5 h-5 border-2 border-gray-600 border-t-red-600 rounded-full animate-spin" />
                </div>
              ) : (
                <ul>
                  {ageFilteredAutocomplete.map((item: any) => (
                    <li key={item.id} className="px-2">
                      <button
                        className="w-full flex items-center py-2 px-3 hover:bg-white/5 rounded-lg transition-colors"
                        onClick={() => handleSelectAutocomplete(item)}
                      >
                        <div className="flex-shrink-0 w-10 h-15 rounded overflow-hidden mr-3">
                          {item.poster_path ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w92${item.poster_path}`}
                              alt={item.title || item.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                              <Film size={20} className="text-gray-500" />
                            </div>
                          )}
                        </div>
                        <div className="text-left flex-1 min-w-0">
                          <div className="font-medium text-white text-sm line-clamp-1">{item.title || item.name}</div>
                          <div className="text-xs text-gray-400 flex items-center">
                            <span className="capitalize">{item.media_type === 'movie' ? t('nav.movies') : t('nav.tvShows')}</span>
                            {item.vote_average > 0 && (
                              <>
                                <span className="mx-1.5">•</span>
                                <span className="flex items-center">
                                  <Star size={12} className="text-yellow-500 mr-0.5" />
                                  {item.vote_average.toFixed(1)}
                                </span>
                              </>
                            )}
                            {(item.release_date || item.first_air_date) && (
                              <>
                                <span className="mx-1.5">•</span>
                                <span>{new Date(item.release_date || item.first_air_date).getFullYear()}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                  <li className="mt-1 pt-1 border-t border-white/10">
                    <Link
                      to={`/search?q=${encodeURIComponent(headerQuery)}`}
                      className="block w-full text-center py-2 text-sm text-gray-400 hover:text-white"
                      onClick={() => { setShowAutocomplete(false); setHeaderQuery(''); setIsMobileSearchOpen(false); }}
                    >
                      {t('search.seeAllResults')}
                    </Link>
                  </li>
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spacer */}
      <div className="w-full h-0" aria-hidden="true" />

      {isSnowfallActive && (
        <Snowfall
          style={{
            position: 'fixed',
            width: '100vw',
            height: '100vh',
            zIndex: 2147483647,
            pointerEvents: 'none',
          }}
        />
      )}
    </>
  );
};

export default Header;
