import React, { useCallback, useEffect, useRef, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import type { EmblaOptionsType } from 'embla-carousel';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Play, Info, Star, Calendar, Pause } from 'lucide-react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { encodeId } from '../utils/idEncoder';
import ShinyText from './ui/shiny-text';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const AUTO_SLIDE_MS = 6000;

// Sur mobile, taper « Regarder » ratait une fois sur deux : Embla démarre son
// drag dès le premier `touchmove` et appelle `preventDefault()`, ce qui pousse
// Chrome/Safari à supprimer le `click` synthétisé. Un doigt qui glisse de 2-3px
// pendant le tap ne naviguait donc jamais. `watchDrag` sort les éléments
// interactifs du geste de drag : un tap dessus reste un vrai clic (on perd
// juste la possibilité de démarrer un swipe pile sur un bouton).
const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('a, button, [role="button"]');

// Objet figé au niveau module : `useEmblaCarousel` compare les options (les
// fonctions via leur source) et re-init si elles changent — un littéral inline
// recréé à chaque render déclencherait des reInit inutiles.
const HERO_EMBLA_OPTIONS: EmblaOptionsType = {
  loop: true,
  duration: 40,
  watchDrag: (_emblaApi, evt) => !isInteractiveTarget(evt.target),
};

// Detect weak hardware (TVs, low-end Android, etc.) and start the slider in
// pause + skip the GPU-heavy animations. Without this, the original was
// hot-loading 5×original-quality backdrops (~25MB) + animating ShinyText at
// 60fps + running an infinite CSS animation, which froze TV browsers.
const detectLowEndDevice = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const hc = navigator.hardwareConcurrency;
  const ua = navigator.userAgent || '';
  const isLowEnd = (typeof dm === 'number' && dm <= 2) || (typeof hc === 'number' && hc <= 2);
  const isTV = /Tizen|WebOS|SmartTV|GoogleTV|HbbTV|NetCast|VIDAA|AppleTV|AndroidTV|BRAVIA|Hisense|Aquos/i.test(ua);
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  // Settings → Performance → "Carrousels automatiques" or master Mode léger.
  // Either disables auto-rotation; user can still swipe/drag manually.
  let userDisabled = false;
  try {
    userDisabled = localStorage.getItem('settings_anim_carousel') === 'false'
      || localStorage.getItem('settings_light_mode') === 'on';
  } catch { /* localStorage unavailable (private mode, etc.) */ }
  return isLowEnd || isTV || reducedMotion || userDisabled;
};

interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  media_type: 'movie' | 'tv';
  genre_ids?: number[];
}

interface HeroSliderProps {
  items: Media[];
}

// Inner component holds the heavy logic (Embla, timers, image fetches). When
// the user disables the hero in Settings, the outer wrapper unmounts this
// entirely → 0 RAM, 0 CPU, no logo fetch, no images downloaded.
const HeroSliderInner: React.FC<HeroSliderProps> = ({ items }) => {
  const { t } = useTranslation();
  const [emblaRef, emblaApi] = useEmblaCarousel(HERO_EMBLA_OPTIONS);
  const autoSlideInterval = useRef<NodeJS.Timeout | null>(null);
  const [logoUrls, setLogoUrls] = useState<{ [key: number]: string | null }>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  // On weak hardware we boot in pause to avoid the freeze the user reported.
  const [isPaused, setIsPaused] = useState(detectLowEndDevice);
  const [isVisible, setIsVisible] = useState(true);
  const logoCache = useRef<{ [key: number]: string | null }>({});
  const progressStartRef = useRef<number>(performance.now());
  // Incrémenté à chaque redémarrage du cycle (changement de slide OU
  // interaction utilisateur). Sert de `key` à la barre de progression pour que
  // l'animation CSS et le timer JS repartent toujours ensemble.
  const [progressKey, setProgressKey] = useState(0);

  // Fetch logo URLs for all items with sessionStorage caching
  useEffect(() => {
    const fetchLogos = async () => {
      const storedCache = sessionStorage.getItem('movix_hero_logos');
      const storedTimestamp = sessionStorage.getItem('movix_hero_logos_timestamp');
      const oneDayMs = 24 * 60 * 60 * 1000;

      let sessionCache: { [key: number]: string | null } = {};
      if (storedCache && storedTimestamp && (Date.now() - parseInt(storedTimestamp)) < oneDayMs) {
        sessionCache = JSON.parse(storedCache);
        logoCache.current = { ...logoCache.current, ...sessionCache };
      }

      const urls: { [key: number]: string | null } = { ...logoCache.current };
      const missing = items.filter((item) => logoCache.current[item.id] === undefined);

      // Carry over already-cached entries directly.
      for (const item of items) {
        if (logoCache.current[item.id] !== undefined) {
          urls[item.id] = logoCache.current[item.id];
        }
      }

      if (missing.length === 0) {
        return;
      }

      // Previously these requests ran sequentially via `for…await`, blocking
      // the hero on the slowest/last logo. Run them in parallel — TMDB has
      // no per-key rate limit issue with ~5 concurrent images requests, and
      // logos render as soon as each fetch resolves. — perf
      const results = await Promise.allSettled(missing.map(async (item) => {
        const url = `https://api.themoviedb.org/3/${item.media_type}/${item.id}/images?api_key=${TMDB_API_KEY}`;
        const res = await axios.get(url);
        const logos = res.data.logos || [];
        const logo = logos.find((l: any) => l.iso_639_1 === 'fr')
          || logos.find((l: any) => l.iso_639_1 === 'en')
          || logos.find((l: any) => l.iso_639_1)
          || logos[0];

        // w500 is plenty for a hero logo (typical render ~110px tall) and
        // ~80% lighter than `original` which was crashing TVs on multi-MB PNGs.
        return logo && logo.file_path
          ? `https://image.tmdb.org/t/p/w500${logo.file_path}`
          : null;
      }));

      results.forEach((result, idx) => {
        const item = missing[idx];
        const logoUrl = result.status === 'fulfilled' ? result.value : null;
        urls[item.id] = logoUrl;
        logoCache.current[item.id] = logoUrl;
      });

      setLogoUrls(urls);
      sessionStorage.setItem('movix_hero_logos', JSON.stringify(logoCache.current));
      sessionStorage.setItem('movix_hero_logos_timestamp', Date.now().toString());
    };

    fetchLogos();
  }, [items]);

  // Track pause timing so unpause resumes from where we left off
  const pausedAtRef = useRef<number | null>(null);
  const isPausedRef = useRef(isPaused);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  const restartCycle = useCallback(() => {
    progressStartRef.current = performance.now();
    pausedAtRef.current = isPausedRef.current ? performance.now() : null;
    setProgressKey((k) => k + 1);
  }, []);

  // Track selected slide for UI state + reset progress on slide change
  // Only depends on emblaApi so the handler is NOT re-registered on pause toggle
  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => {
      restartCycle();
      setSelectedIndex(emblaApi.selectedScrollSnap());
    };
    onSelect();
    emblaApi.on('select', onSelect);
    return () => {
      emblaApi.off('select', onSelect);
    };
  }, [emblaApi, restartCycle]);

  // Pause when the hero scrolls off-screen — saves the auto-slide timer +
  // progress animation when the user is browsing further down the page.
  useEffect(() => {
    if (!emblaApi) return;
    const root = emblaApi.rootNode();
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsVisible(entry.intersectionRatio > 0);
      },
      { threshold: [0, 0.05] }
    );
    obs.observe(root);
    return () => obs.disconnect();
  }, [emblaApi]);

  // Auto-slide timer + progress bar — resumes cleanly after pause
  useEffect(() => {
    if (!emblaApi) return;

    const frozen = isPaused || !isVisible;
    if (frozen) {
      // Freeze: remember when we paused
      if (pausedAtRef.current === null) {
        pausedAtRef.current = performance.now();
      }
      if (autoSlideInterval.current) clearTimeout(autoSlideInterval.current);
      return;
    }

    // Resume or start: shift progressStart by pause duration
    if (pausedAtRef.current !== null) {
      const pauseDuration = performance.now() - pausedAtRef.current;
      progressStartRef.current += pauseDuration;
      pausedAtRef.current = null;
    }

    // Schedule next slide for the REMAINING time, not full interval
    const scheduleNext = () => {
      if (autoSlideInterval.current) clearTimeout(autoSlideInterval.current);
      const elapsed = performance.now() - progressStartRef.current;
      const remaining = Math.max(AUTO_SLIDE_MS - elapsed, 50);
      autoSlideInterval.current = setTimeout(() => emblaApi.scrollNext(), remaining);
    };
    scheduleNext();

    // Drag pause/resume via Embla pointer events
    const pauseOnPointer = () => {
      if (autoSlideInterval.current) clearTimeout(autoSlideInterval.current);
    };
    emblaApi.on('pointerDown', pauseOnPointer);
    emblaApi.on('pointerUp', scheduleNext);

    // Embla n'émet plus `pointerDown` quand le doigt se pose sur un bouton
    // (cf. `watchDrag`) : sans ça, la slide pouvait tourner pile pendant le tap
    // et le CTA disparaissait sous le doigt. On écoute donc le DOM directement
    // et on redonne un cycle complet après chaque interaction.
    const root = emblaApi.rootNode();
    const onPointerDownDom = () => {
      if (autoSlideInterval.current) clearTimeout(autoSlideInterval.current);
    };
    root?.addEventListener('pointerdown', onPointerDownDom, { passive: true });
    root?.addEventListener('pointerup', restartCycle, { passive: true });
    root?.addEventListener('pointercancel', restartCycle, { passive: true });

    return () => {
      if (autoSlideInterval.current) clearTimeout(autoSlideInterval.current);
      emblaApi.off('pointerDown', pauseOnPointer);
      emblaApi.off('pointerUp', scheduleNext);
      root?.removeEventListener('pointerdown', onPointerDownDom);
      root?.removeEventListener('pointerup', restartCycle);
      root?.removeEventListener('pointercancel', restartCycle);
    };
  }, [emblaApi, isPaused, isVisible, progressKey, restartCycle]);

  // Horizontal wheel support
  useEffect(() => {
    if (!emblaApi) return;
    const rootNode = emblaApi.rootNode();
    if (!rootNode) return;

    let lastWheel = 0;
    const THROTTLE_MS = 250;

    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      if (absX <= absY || absX < 2) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel < THROTTLE_MS) return;
      lastWheel = now;
      progressStartRef.current = performance.now();
      if (e.deltaX > 0) emblaApi.scrollNext();
      else emblaApi.scrollPrev();
    };

    rootNode.addEventListener('wheel', onWheel, { passive: false });
    return () => rootNode.removeEventListener('wheel', onWheel);
  }, [emblaApi]);

  const scrollTo = useCallback((idx: number) => {
    if (emblaApi) {
      restartCycle();
      emblaApi.scrollTo(idx);
    }
  }, [emblaApi, restartCycle]);

  const getYear = (item: Media) => {
    const date = item.release_date || item.first_air_date;
    return date ? new Date(date).getFullYear() : null;
  };

  const frozen = isPaused || !isVisible;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className="embla relative w-full select-none px-3 sm:px-6 md:px-12 lg:px-20 mx-auto max-w-[1920px]"
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <style>
        {`
          @keyframes hero-progress {
            from { transform: scaleX(0); }
            to   { transform: scaleX(1); }
          }
          .hero-progress-fill {
            transform-origin: left;
            animation: hero-progress var(--hero-duration, 6000ms) linear forwards;
          }
          .hero-progress-fill.is-paused {
            animation-play-state: paused;
          }
        `}
      </style>
      <div
        className="relative w-full rounded-2xl sm:rounded-3xl overflow-hidden border border-white/10 shadow-2xl min-h-[340px] sm:min-h-[400px] md:min-h-[480px]"
        style={{ height: 'min(55svh, 620px)' }}
      >
        <div className="embla__viewport h-full w-full overflow-hidden" ref={emblaRef}>
          <div className="embla__container flex h-full w-full">
            {items.map((item, idx) => {
              const logoUrl = logoUrls[item.id];
              const year = getYear(item);
              const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
              const isActive = idx === selectedIndex;

              return (
                <div
                  className="embla__slide h-full relative"
                  key={item.id}
                  style={{ userSelect: 'none', flex: '0 0 100%', minWidth: 0 }}
                >
                  {/* Backdrop — w1280 is ample for hero size and ~70% lighter
                      than `original` which was crashing TVs. Active slide
                      eager-loads, others are lazy. */}
                  <img
                    src={`https://image.tmdb.org/t/p/w1280${item.backdrop_path}`}
                    alt={item.title || item.name}
                    className="absolute inset-0 w-full h-full object-cover z-0"
                    style={{ objectPosition: 'center 30%' }}
                    draggable={false}
                    loading={isActive ? 'eager' : 'lazy'}
                    decoding="async"
                    {...{ fetchpriority: isActive ? 'high' : 'low' }}
                  />

                  {/* Smooth combined gradient — no harsh transitions */}
                  <div
                    className="absolute inset-0 z-10 pointer-events-none"
                    style={{
                      background: `
                        linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.15) 65%, transparent 100%),
                        linear-gradient(to right, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.35) 30%, rgba(0,0,0,0.05) 60%, transparent 100%)
                      `,
                    }}
                  />

                  {/* Content */}
                  <div className="absolute inset-0 flex items-end md:items-center z-20">
                    <div className="w-full md:max-w-2xl px-4 sm:px-6 md:px-12 pb-20 md:pb-16">
                      <AnimatePresence mode="wait">
                        {isActive && (
                          <motion.div
                            key={`content-${item.id}`}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.5, delay: 0.1 }}
                            className="space-y-3 sm:space-y-5"
                          >
                            {/* Badges — backdrop-blur removed (was a per-frame
                                filter pass on each); slightly more opaque
                                solid bg keeps legibility against any backdrop. */}
                            <div className="flex flex-wrap gap-1.5 sm:gap-2 items-center">
                              <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full bg-white/15 border border-white/20 text-white/90 text-[10px] sm:text-xs font-medium uppercase tracking-wider">
                                {item.media_type === 'movie' ? t('search.movieLabel') : t('search.serieLabel')}
                              </span>
                              {year && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full bg-white/10 border border-white/10 text-white/80 text-[10px] sm:text-xs font-medium">
                                  <Calendar className="w-3 h-3" />
                                  {year}
                                </span>
                              )}
                              {rating && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full bg-yellow-500/25 border border-yellow-500/30 text-yellow-300 text-[10px] sm:text-xs font-semibold">
                                  <Star className="w-3 h-3 fill-current" />
                                  {rating}
                                </span>
                              )}
                            </div>

                            {/* Title or logo */}
                            <div className="min-h-[56px] sm:min-h-[80px] md:min-h-[110px] flex items-end">
                              {logoUrl ? (
                                <img
                                  src={logoUrl}
                                  alt={item.title || item.name}
                                  className="block object-contain object-left w-auto h-auto max-w-full max-h-[64px] sm:max-h-[80px] md:max-h-[110px] min-h-[40px] md:min-h-[56px]"
                                  draggable={false}
                                  loading={isActive ? 'eager' : 'lazy'}
                                  decoding="async"
                                />
                              ) : (
                                <h1 className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-bold leading-tight line-clamp-2">
                                  <ShinyText
                                    text={item.title || item.name || ''}
                                    speed={4}
                                    color="#ffffff"
                                    shineColor="#ef4444"
                                    disabled={!isActive || frozen}
                                  />
                                </h1>
                              )}
                            </div>

                            {/* Overview */}
                            <p className="text-xs sm:text-sm md:text-base text-white/80 max-w-xl line-clamp-2 sm:line-clamp-3 leading-relaxed">
                              {item.overview}
                            </p>

                            {/* Buttons */}
                            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <Link
                                  to={`/${item.media_type}/${encodeId(item.id)}`}
                                  className="inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 text-white px-5 sm:px-6 md:px-7 py-3 sm:py-3 min-h-[48px] rounded-xl sm:rounded-2xl text-sm sm:text-base font-semibold transition-colors shadow-lg shadow-red-600/30 touch-manipulation"
                                >
                                  <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-current" />
                                  {t('home.hero.play')}
                                </Link>
                              </motion.div>
                              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <Link
                                  to={`/${item.media_type}/${encodeId(item.id)}`}
                                  className="inline-flex items-center justify-center gap-2 bg-white/15 hover:bg-white/25 text-white px-5 sm:px-6 md:px-7 py-3 sm:py-3 min-h-[48px] rounded-xl sm:rounded-2xl text-sm sm:text-base font-medium border border-white/20 transition-colors touch-manipulation"
                                >
                                  <Info className="w-4 h-4 sm:w-5 sm:h-5" />
                                  {t('home.hero.moreInfo')}
                                </Link>
                              </motion.div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom controls: dots + progress bar + pause */}
        <div className="absolute bottom-3 sm:bottom-4 md:bottom-6 left-0 right-0 z-30 flex items-center justify-center gap-4 px-3 sm:px-6 pointer-events-none">
          <div className="flex items-center gap-2 sm:gap-3 bg-black/60 border border-white/10 rounded-full px-3 sm:px-4 py-1.5 sm:py-2 pointer-events-auto">
            {/* Dots — le point ne mesure que 6px : le bouton l'entoure d'une zone
                tactile de 14x30px via un padding réabsorbé par une marge
                négative — le rendu visuel de la barre reste identique. */}
            <div className="flex items-center gap-1.5">
              {items.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => scrollTo(idx)}
                  aria-label={`Slide ${idx + 1}`}
                  className="group flex items-center justify-center px-1 -mx-1 py-3 -my-3 touch-manipulation"
                >
                  <span
                    className={`block transition-all rounded-full ${
                      idx === selectedIndex
                        ? 'w-8 h-1.5 bg-white'
                        : 'w-1.5 h-1.5 bg-white/40 group-hover:bg-white/60'
                    }`}
                  />
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="w-px h-4 bg-white/20" />

            {/* Progress bar */}
            <div className="w-12 sm:w-20 h-1 bg-white/15 rounded-full overflow-hidden">
              <div
                key={progressKey}
                className={`h-full w-full bg-red-500 rounded-full hero-progress-fill ${frozen ? 'is-paused' : ''}`}
                style={{ ['--hero-duration' as string]: `${AUTO_SLIDE_MS}ms` } as React.CSSProperties}
              />
            </div>

            {/* Pause toggle */}
            <button
              onClick={() => setIsPaused((p) => !p)}
              aria-label={isPaused ? 'Play' : 'Pause'}
              className="flex items-center justify-center p-2 -m-2 text-white/70 hover:text-white transition-colors touch-manipulation"
            >
              {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5 fill-current" />}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

// Outer wrapper — reads the visibility flag and unmounts the inner component
// entirely when the user disabled the hero in Settings. This is what saves
// the freeze: no inner = no Embla, no logo fetch, no images, no timers.
const HeroSlider: React.FC<HeroSliderProps> = ({ items }) => {
  const { items: allowedItems } = useAgeRestrictedContent(items);
  const [isHidden, setIsHidden] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('settings_hide_hero') === 'true';
  });

  useEffect(() => {
    const sync = () => setIsHidden(localStorage.getItem('settings_hide_hero') === 'true');
    window.addEventListener('storage', sync);
    window.addEventListener('hero_visibility_changed', sync as EventListener);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('hero_visibility_changed', sync as EventListener);
    };
  }, []);

  if (isHidden || allowedItems.length === 0) return null;
  return <HeroSliderInner items={allowedItems} />;
};

export default React.memo(HeroSlider);
