import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { Star, Calendar, Trash, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { encodeId } from '../utils/idEncoder';
import { useTmdbImages, prefetchTmdbImages } from '../hooks/useTmdbImages';
import { useEmblaScrollSuppress } from '../hooks/useEmblaScrollSuppress';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';
import './EmblaCarousel.css';

const POSTER_FALLBACK = `data:image/svg+xml,${encodeURIComponent('<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" fill="#444" font-size="36" font-family="sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>')}`;

// Stable frozen constant for non-history carousel items — prevents fresh object
// identity inside limitedItems.map() from defeating CarouselCard memo. — perf
const EMPTY_PROGRESS = Object.freeze({ percentage: 0, position: 0, duration: 0 });

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
  media_type: 'movie' | 'tv' | 'collection';
  genre_ids?: number[];
}

interface ContinueWatching {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  media_type: 'movie' | 'tv';
  progress?: number;
  lastWatched: string;
  overview?: string;
  backdrop_path?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  currentEpisode?: {
    season: number;
    episode: number;
  };
}

interface EmblaCarouselProps {
  title: string | React.ReactNode;
  items: Media[] | ContinueWatching[];
  mediaType: string;
  isHistory?: boolean;
  onRemoveItem?: (itemId: number, mediaType: string) => void;
  onRemoveAll?: () => void;
  showRanking?: boolean;
  priorityZIndex?: boolean; // Pour les sections qui doivent être au-dessus des autres
  onViewAll?: () => void; // Callback pour le bouton "Voir tous"
}

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  onError?: () => void;
  placeholder?: string;
  draggable?: boolean;
  priority?: boolean;
}

// Native lazy loading + async decode — décharge le decode du main thread
// pour éviter le jank pendant le scroll horizontal du carousel. width/height
// HTML attrs = hint au décodeur pour allouer un buffer correctement
// dimensionné + évite les CLS au mount.
const LazyImage: React.FC<LazyImageProps> = ({
  src,
  alt,
  className = '',
  style,
  onError,
  placeholder = 'data:image/svg+xml;utf8,<svg width="342" height="513" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 342 513" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="38" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>',
  draggable = false,
  priority = false
}) => {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => {
    setErrored(true);
    setLoaded(true);
    onError?.();
  }, [onError]);

  const roundedClass = className.includes('rounded')
    ? className.match(/rounded-\w+/)?.[0] || ''
    : '';

  return (
    <div className={`relative ${className}`} style={{
      width: '100%',
      height: '100%',
      ...style
    }}>
      <img
        src={errored ? placeholder : src}
        alt={alt}
        width={342}
        height={513}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        {...{ fetchpriority: priority ? 'high' : 'auto' }}
        onLoad={handleLoad}
        onError={handleError}
        draggable={draggable}
        className={`w-full h-full object-cover transition-opacity duration-300 ${roundedClass} ${loaded ? 'opacity-100' : 'opacity-0'}`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          ...style
        }}
      />
      {!loaded && (
        <div className="absolute inset-0 bg-gray-900" aria-hidden="true" />
      )}
    </div>
  );
};

// Memoized card — same visual language as SearchGridCard
const CarouselCard = React.memo<{
  item: Media | ContinueWatching;
  index: number;
  itemId: string;
  detailPath: string;
  priority: boolean;
  initialStarred: boolean;
  progressData: { percentage: number; position: number; duration: number };
  isHistory: boolean;
  showRanking: boolean;
  handleAuxOpen: (e: React.MouseEvent, path: string) => void;
  onRemoveItem?: (itemId: number, mediaType: string) => void;
}>(({
  item,
  index,
  detailPath,
  priority,
  initialStarred,
  progressData,
  isHistory,
  showRanking,
  handleAuxOpen,
  onRemoveItem,
}) => {
  const { t } = useTranslation();
  const [starred, setStarred] = useState(initialStarred);
  const title = item.title || item.name || '';
  const isCollection = (item as any).media_type === 'collection';

  // Plus de gate `shouldLoadImages` ni de `setState` per-card : le parent
  // EmblaCarousel pré-warme TOUS les /images JSON (+ pré-décode les posters)
  // à l'idle dès le mount du carousel. fetchAndCache + inflight map dans
  // useTmdbImages dédupent les éventuels conflits prefetch ↔ hook subscribe.
  // Résultat : 0 setState pendant scroll + cache hit synchrone au 1er render
  // pour les sessions suivantes.
  const imagesMediaType = !isCollection && (item.media_type === 'movie' || item.media_type === 'tv')
    ? item.media_type
    : undefined;
  const { logoUrl, posterUrl } = useTmdbImages(imagesMediaType, item.id);

  // Poster localisé si dispo (TMDB renvoie souvent une affiche FR différente
  // pour les sorties FR), sinon le poster_path par défaut du payload de liste.
  // Le swap natif <img src> arrive sans flash si l'URL ne change pas
  // (cas fréquent : la liste retourne déjà le poster FR si la requête liste
  // était en `language=fr-FR`).
  const posterSrc = posterUrl ?? `https://image.tmdb.org/t/p/w342${item.poster_path}`;

  const toggleWatchlist = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const key = isCollection ? 'watchlist_collections' : `watchlist_${item.media_type}`;
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const exists = list.some((m: any) => m.id === item.id);
    if (exists) {
      localStorage.setItem(key, JSON.stringify(list.filter((m: any) => m.id !== item.id)));
      setStarred(false);
      toast.success(`${title} ${t('lists.removedFromList')}`, { duration: 2000 });
    } else {
      const newItem = isCollection
        ? {
            id: item.id,
            name: item.name || title,
            poster_path: item.poster_path,
            backdrop_path: (item as any).backdrop_path,
            overview: item.overview,
            type: 'collection',
            addedAt: new Date().toISOString(),
          }
        : {
            id: item.id,
            type: item.media_type,
            title,
            poster_path: item.poster_path,
            addedAt: new Date().toISOString(),
          };
      list.unshift(newItem);
      localStorage.setItem(key, JSON.stringify(list));
      setStarred(true);
      toast.success(`${title} ${t('lists.addedToList')}`, { duration: 2000 });
    }
  }, [item, title, t, isCollection]);

  const year = (item as any).release_date || (item as any).first_air_date
    ? new Date((item as any).release_date || (item as any).first_air_date).getFullYear()
    : null;

  const typeLabel = item.media_type === 'tv'
    ? t('common.series')
    : item.media_type === 'collection'
      ? t('common.saga')
      : t('common.movie');

  return (
    <div className="embla-slide flex-none relative w-[144px] md:w-[192px]">
      <div
        style={{ animationDelay: `${Math.min(index * 0.03, 0.5)}s` }}
        className="relative group rounded-xl overflow-hidden bg-white/5 border border-white/10 hover:border-white/20 hover:scale-105 transform-gpu will-change-transform transition-transform duration-200 ease-out animate-card-enter"
      >
        {/* Type badge */}
        <span className="absolute top-2 left-2 z-10 px-2 py-1 rounded-lg bg-black/75 text-[10px] font-semibold uppercase tracking-wider text-white/80">
          {typeLabel}
        </span>

        {/* Episode badge for history TV items */}
        {isHistory && 'currentEpisode' in item && item.currentEpisode && item.media_type === 'tv' && (
          <span className="absolute top-9 left-2 z-10 px-2 py-1 rounded-lg bg-red-600 text-[10px] font-semibold tracking-wider text-white">
            S{item.currentEpisode.season}:E{item.currentEpisode.episode}
          </span>
        )}

        {/* Top-right action: remove (history) or watchlist (normal) — natif <button>
            avec title= pour le tooltip (zéro overhead vs Radix Tooltip qui mountait
            un portal par card sur hover). active:scale-* remplace whileTap. */}
        {isHistory && onRemoveItem ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemoveItem(item.id, item.media_type);
            }}
            title={t('common.deleteAll')}
            aria-label={t('common.deleteAll')}
            className="absolute top-2 right-2 z-20 p-2 rounded-full bg-red-600/95 hover:bg-red-600 active:scale-[0.85] text-white transition-[colors,transform] duration-150"
          >
            <Trash className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleWatchlist}
            title={starred ? t('profile.removeFromWatchlist') : t('profile.addToWatchlist')}
            aria-label={starred ? t('profile.removeFromWatchlist') : t('profile.addToWatchlist')}
            className={`absolute top-2 right-2 z-20 p-2 rounded-full active:scale-[0.7] transition-[opacity,background-color,transform] duration-200 md:opacity-0 md:group-hover:opacity-100 ${starred ? 'bg-yellow-500/40 border border-yellow-400/50' : 'bg-black/65 hover:bg-black/80'}`}
          >
            {/* initial={false} : pas de spring au mount (jusqu'à 30 cards par row révélée
                au scroll) ; le pop ne joue qu'au passage à starred via les keyframes */}
            <motion.div
              initial={false}
              animate={starred ? { scale: [0.3, 1], rotate: [-45, 0] } : { scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 15 }}
            >
              <Star
                className={`w-4 h-4 transition-colors duration-150 ${starred ? 'text-yellow-400' : 'text-white'}`}
                fill={starred ? 'currentColor' : 'none'}
              />
            </motion.div>
          </button>
        )}

        {/* Poster — w342 = 342×513 = 1.78× le display 192px CSS sur écran @1×.
            Suffisant pour la qualité visible sur écran @2× sans surdécoder.
            posterSrc = poster localisé FR>EN>any si useTmdbImages a résolu,
            sinon default poster_path du payload. */}
        <div className="w-full aspect-[2/3] relative">
          <LazyImage
            src={posterSrc}
            alt={title || t('common.poster')}
            className="rounded-xl w-full h-full"
            placeholder={POSTER_FALLBACK}
            priority={priority}
          />
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        {/* Hover content */}
        <div className="absolute bottom-0 left-0 right-0 p-3 md:opacity-0 md:group-hover:opacity-100 md:translate-y-2 md:group-hover:translate-y-0 transition-[opacity,transform] duration-300 pointer-events-none">
          {logoUrl ? (
            <div className="mb-1.5 h-7 flex items-end">
              <img
                src={logoUrl}
                alt={title}
                className="max-h-full max-w-full object-contain object-left drop-shadow-md"
                draggable={false}
                loading="lazy"
              />
            </div>
          ) : (
            <h3 className="text-sm font-bold text-white line-clamp-1 mb-1">
              {title}
            </h3>
          )}
          <div className="flex items-center gap-2 mb-1">
            {(item as any).vote_average ? (
              <div className="flex items-center gap-1">
                <Star className="w-3 h-3 text-yellow-400" />
                <span className="text-xs text-white/80">
                  {(item as any).vote_average.toFixed(1)}
                </span>
              </div>
            ) : null}
            {year && (
              <div className="flex items-center gap-1">
            <Calendar className="w-3 h-3 text-white opacity-60" />
                <span className="text-xs text-white/60">{year}</span>
              </div>
            )}
          </div>
          {item.overview && (
            <p className="text-xs text-white/50 line-clamp-3">
              {item.overview}
            </p>
          )}
        </div>

        {/* Progress bar for history items */}
        {isHistory && progressData.percentage > 0 && (
          <div className="absolute left-0 right-0 bottom-0 h-1 bg-black/50 overflow-hidden rounded-b-xl z-10">
            <div
              className="h-full bg-red-600"
              style={{ width: `${progressData.percentage}%` }}
            />
          </div>
        )}

        {/* Main clickable area */}
        <Link
          to={detailPath}
          onAuxClick={(e) => handleAuxOpen(e, detailPath)}
          className="absolute inset-0 z-[5]"
        >
          <span className="sr-only">{title}</span>
        </Link>
      </div>

      {/* Top 10 ranking number — outside the card wrapper to escape overflow-hidden.
          Réutilise posterSrc → même image que la card (SW cache chaud, 0 fetch
          supplémentaire) ET cohérence visuelle quand le poster localisé FR
          arrive. */}
      {showRanking && (
        <div
          className="ranking-number"
          style={{ backgroundImage: `url(${posterSrc})` }}
        >
          {index + 1}
        </div>
      )}
    </div>
  );
});

CarouselCard.displayName = 'CarouselCard';

const EmblaCarousel: React.FC<EmblaCarouselProps> = ({
  title,
  items,
  mediaType: _mediaType,
  isHistory = false,
  onRemoveItem,
  onRemoveAll,
  showRanking = false,
  priorityZIndex = false,
  onViewAll
}) => {
  const { t } = useTranslation();
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    dragFree: true,
    containScroll: 'keepSnaps',
    slidesToScroll: 1,
    skipSnaps: false,
    // P7 — 25 → 15 : snap plus rapide = moins de frames pendant lesquelles
    // le browser doit composer + react au scroll. Si le visuel devient trop
    // saccadé sur trackpad/molette, remonter à 20.
    duration: 15,
    startIndex: 0,
    loop: false,
    slides: '.embla-slide'
  });
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { items: allowedItems } = useAgeRestrictedContent(items);

  // Cache watchlists once using useMemo to avoid repeated localStorage access
  const watchlistMovies = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('watchlist_movie') || '[]'); } catch { return []; }
  }, []);

  const watchlistTV = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('watchlist_tv') || '[]'); } catch { return []; }
  }, []);

  const watchlistCollections = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('watchlist_collections') || '[]'); } catch { return []; }
  }, []);

  // Limite le nombre d'items pour éviter de surcharger le DOM (max 30 items par carousel)
  const limitedItems = useMemo(() => allowedItems.slice(0, 30), [allowedItems]);

  // Pré-warmer idle (P1 + P3) : dès le mount du carousel, on pré-décode toutes
  // les bitmaps poster (élimine le coût de décode synchrone pendant le scroll
  // horizontal — le 1er passage causait des frames perdues sur PC où 5-6 cards
  // entraient par frame) ET on pré-fetche tous les /images JSON de TMDB
  // (élimine le storm de fetches au moment où la card devient visible).
  //
  // requestIdleCallback : le browser yield si CPU busy, on n'interfère pas
  // avec le critical path. Concurrency=2 par carousel × 5 carousels Home = max
  // 10 décodes parallèles, bien sous la limite browser/réseau. Les fetches
  // sont protégés par le SW qui cap à 6 concurrent (cf. sw.js).
  //
  // Cleanup : `cancelled` flag stoppe la worker loop à la prochaine itération
  // (le décode/fetch en vol finit normalement, on ignore juste le résultat).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const cic = w.cancelIdleCallback ?? window.clearTimeout;

    let cancelled = false;
    const concurrency = 2;

    const worker = async (cursor: { i: number }) => {
      while (!cancelled) {
        const idx = cursor.i++;
        if (idx >= limitedItems.length) return;
        const item = limitedItems[idx];
        const tasks: Promise<unknown>[] = [];

        // P1 : pré-décode poster off-DOM. Le browser garde la bitmap en cache
        // image → quand le <img> mount dans la card, il pioche directement la
        // bitmap décodée, 0 décode pendant scroll.
        if (item.poster_path) {
          const url = `https://image.tmdb.org/t/p/w342${item.poster_path}`;
          const img = new Image();
          img.src = url;
          tasks.push(img.decode().catch(() => undefined));
        }

        // P3 : pré-fetch /images JSON via fetchAndCache (dédupé par inflight
        // map → 0 doublon avec les hooks `useTmdbImages` qui mounteraient en
        // même temps).
        if (item.media_type === 'movie' || item.media_type === 'tv') {
          tasks.push(prefetchTmdbImages(item.media_type, item.id).catch(() => undefined));
        }

        if (tasks.length > 0) await Promise.all(tasks);
      }
    };

    const handle = ric(() => {
      const cursor = { i: 0 };
      void Promise.all(Array.from({ length: concurrency }, () => worker(cursor)));
    }, { timeout: 2000 });

    return () => {
      cancelled = true;
      cic(handle);
    };
  }, [limitedItems]);

  // Pause l'animation `peephole-zoom` (CSS `.ranking-number`, cf.
  // EmblaCarousel.css) quand la row Top 10 est hors écran — sans ça les 10
  // digits animent `background-size` en boucle infinie 8s même hors
  // viewport, donc repaint continu. Gated sur `showRanking` (= mediaType
  // "top10" côté appelant) : les autres carousels n'ont pas de
  // `.ranking-number`, pas besoin d'observer. IntersectionObserver léger, un
  // seul par row, toggle juste une classe CSS (`.embla--offscreen`) — 0
  // impact sur le rendu visible pendant que la row est dans le viewport.
  useEffect(() => {
    if (!showRanking) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    const node = rowRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        node.classList.toggle('embla--offscreen', !entry.isIntersecting);
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [showRanking]);

  // `priority` cap statique : les N premières cards reçoivent
  // `loading="eager"` + `fetchpriority="high"` pour aider le LCP. Calculé une
  // fois au mount selon le viewport (= getStep + 2 buffer pour couvrir les
  // cards initiales partiellement visibles). Pas de mise à jour pendant scroll
  // → 0 re-render storm sur les 30 cards quand de nouveaux items entrent en
  // vue (le pre-decode P1 a déjà payé le coût décode hors critical path).
  const priorityCount = useMemo(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    if (w >= 1536) return 10; // 2K+
    if (w >= 1280) return 8;  // xl
    if (w >= 1024) return 7;  // lg
    if (w >= 768) return 6;   // md
    return 4;                 // sm/xs
  }, []);

  const checkIfScrollable = useCallback(() => {
    if (!emblaApi) return false;
    if (emblaApi.scrollSnapList().length <= 1) return false;
    const container = emblaApi.containerNode();
    if (container) {
      const scrollWidth = container.scrollWidth;
      const clientWidth = container.clientWidth;
      if (scrollWidth <= clientWidth + 5) {
        return false;
      }
    }
    return true;
  }, [emblaApi]);

  // Effect 2: track arrow-button state via 'select' + 'reInit' only.
  useEffect(() => {
    if (!emblaApi) return;
    const updateArrows = () => {
      try {
        const runUpdate = () => {
          if (!emblaApi) return;
          const isScrollable = checkIfScrollable();
          setCanScrollPrev(isScrollable && emblaApi.canScrollPrev());
          setCanScrollNext(isScrollable && emblaApi.canScrollNext());
        };
        runUpdate();
        requestAnimationFrame(runUpdate);
      } catch (_) {
        // no-op
      }
    };
    updateArrows();
    emblaApi.on('select', updateArrows);
    emblaApi.on('reInit', updateArrows);
    return () => {
      emblaApi.off('select', updateArrows);
      emblaApi.off('reInit', updateArrows);
    };
  }, [emblaApi, checkIfScrollable, limitedItems]);

  // Support molette horizontale (tilt wheel / trackpad) -> scroll du carousel
  useEffect(() => {
    if (!emblaApi) return;
    const rootNode = emblaApi.rootNode();
    if (!rootNode) return;

    let lastWheel = 0;
    const THROTTLE_MS = 90;

    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      if (absX <= absY || absX < 2) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel < THROTTLE_MS) return;
      lastWheel = now;
      if (e.deltaX > 0) emblaApi.scrollNext();
      else emblaApi.scrollPrev();
    };

    rootNode.addEventListener('wheel', onWheel, { passive: false });
    return () => rootNode.removeEventListener('wheel', onWheel);
  }, [emblaApi]);

  // Suppression hover pendant scroll horizontal du carousel (drag pointerUp lift,
  // settle pour wheel/scrollPrev/Next). Pose body.embla-scrolling -> CSS rule
  // `body.embla-scrolling .embla-slide { pointer-events: none }` (src/index.css)
  // empêche les hover flips quand les cards défilent sous le curseur.
  useEmblaScrollSuppress(emblaApi);

  const getStep = useCallback(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    if (w >= 1536) return 8; // 2K+
    if (w >= 1280) return 6; // xl
    if (w >= 1024) return 5; // lg
    if (w >= 768) return 4;  // md
    return 2;                // sm/xs
  }, []);

  const handlePrev = useCallback((e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!emblaApi) return;
    try {
      const current = emblaApi.selectedScrollSnap();
      const target = Math.max(0, current - getStep());
      emblaApi.scrollTo(target);
    } catch (_) {
      emblaApi.scrollPrev();
    }
  }, [emblaApi, getStep]);

  const handleNext = useCallback((e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!emblaApi) return;
    try {
      const current = emblaApi.selectedScrollSnap();
      const snaps = emblaApi.scrollSnapList().length;
      const target = Math.min(snaps - 1, current + getStep());
      emblaApi.scrollTo(target);
    } catch (_) {
      emblaApi.scrollNext();
    }
  }, [emblaApi, getStep]);

  // Open in new tab on middle-click
  const handleAuxOpen = useCallback((e: React.MouseEvent, path: string) => {
    // Middle mouse button is button === 1
    if ((e as React.MouseEvent).button === 1) {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.open(path, '_blank', 'noopener,noreferrer');
      } catch (_) {
        // Fallback without features string
        window.open(path, '_blank');
      }
    }
  }, []);

  // Function to get movie progress data - memoized
  const getMovieProgress = useCallback((movieId: number): { percentage: number, position?: number, duration?: number } => {
    try {
      const progressKey = `progress_${movieId}`;
      const savedData = localStorage.getItem(progressKey);

      if (savedData) {
        const progressData = JSON.parse(savedData);
        if (progressData.position && progressData.duration) {
          return {
            percentage: Math.min((progressData.position / progressData.duration) * 100, 100),
            position: progressData.position,
            duration: progressData.duration
          };
        }
      }
      return { percentage: 0 };
    } catch (error) {
      console.error('Error getting movie progress:', error);
      return { percentage: 0 };
    }
  }, []);

  // Function to get episode progress data - memoized
  const getEpisodeProgress = useCallback((showId: number, seasonNumber: number, episodeNumber: number): { percentage: number, position?: number, duration?: number } => {
    try {
      const progressKey = `progress_tv_${showId}_s${seasonNumber}_e${episodeNumber}`;
      const savedData = localStorage.getItem(progressKey);

      if (savedData) {
        const progressData = JSON.parse(savedData);
        if (progressData.position && progressData.duration) {
          return {
            percentage: Math.min((progressData.position / progressData.duration) * 100, 100),
            position: progressData.position,
            duration: progressData.duration
          };
        }
      }
      return { percentage: 0 };
    } catch (error) {
      console.error('Error getting episode progress:', error);
      return { percentage: 0 };
    }
  }, []);

  // Pre-compute a map de progression : 1 lecture localStorage par item au lieu
  // de 1× par item × par render. Recomputed seulement quand limitedItems change.
  // Garde une identité stable pour progressData → CarouselCard memo respecté.
  // Pour les items non-history, on retombe sur EMPTY_PROGRESS.
  const progressMap = useMemo(() => {
    const map = new Map<string, { percentage: number; position: number; duration: number }>();
    if (!isHistory) return map;
    for (const item of limitedItems) {
      if (!('currentEpisode' in item)) continue;
      const h = item as ContinueWatching;
      const itemKey = `${h.id}-${h.media_type}`;
      if (h.media_type === 'tv' && h.currentEpisode) {
        const ep = getEpisodeProgress(h.id, h.currentEpisode.season, h.currentEpisode.episode);
        map.set(itemKey, {
          percentage: ep.percentage,
          position: ep.position || 0,
          duration: ep.duration || 0,
        });
      } else if (h.media_type === 'movie') {
        const mv = getMovieProgress(h.id);
        map.set(itemKey, {
          percentage: mv.percentage,
          position: mv.position || 0,
          duration: mv.duration || 0,
        });
      }
    }
    return map;
  }, [limitedItems, isHistory, getEpisodeProgress, getMovieProgress]);

  if (limitedItems.length === 0) return null;

  return (
    <div ref={rowRef} className="mb-4 content-row-container -mx-3 md:-mx-4 group/carousel" style={{ position: 'relative' }}>
        <div className="flex justify-between items-center mb-2 px-4 md:px-6 relative">
          <div className="flex items-center gap-3">
            <h2 className="section-title">{title}</h2>
            {onViewAll && (
              <button
                onClick={onViewAll}
                className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-gray-300 hover:text-white bg-gray-800/50 hover:bg-gray-700/70 rounded-full transition-all duration-200 border border-gray-700/50 hover:border-gray-600"
              >
                <span>{t('common.viewAll')}</span>
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
          {isHistory && onRemoveAll && limitedItems.length > 0 && (
            <button
              onClick={onRemoveAll}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700/80 hover:bg-red-700 text-white text-xs font-medium rounded-full transition-colors"
              aria-label="Supprimer tout"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('common.deleteAll')}</span>
            </button>
          )}
        </div>

        <div className="relative w-full overflow-visible">
          <div className="overflow-visible" ref={emblaRef}>
            {/* `select-none` est ici et non sur toute la rangée : il n'existe
                que pour empêcher la sélection de texte pendant qu'on fait
                glisser le carrousel. Posé plus haut, il rendait aussi le titre
                de section et les boutons impossibles à sélectionner. */}
            <div
              className="flex gap-4 pr-4 md:pr-6 pl-4 md:pl-6 select-none"
              style={{ overflow: 'visible' }}
            >
              {limitedItems.map((item, index) => {
                const itemId = `carousel-${item.id}-${item.media_type}-${index}`;
                const detailPath = item.media_type === 'collection' ? `/collection/${item.id}` : `/${item.media_type}/${encodeId(item.id)}`;
                const initialStarred = (() => {
                  const list = (item as any).media_type === 'collection'
                    ? watchlistCollections
                    : item.media_type === 'movie'
                      ? watchlistMovies
                      : watchlistTV;
                  return Array.isArray(list) && list.some((media: any) => media.id === item.id);
                })();

                // Lookup mémoïsé : progressMap pré-calculée 1× par changement
                // d'items. Sur un re-render non lié (canScrollNext flip, hover),
                // on récupère ici la même référence d'objet → CarouselCard memo
                // respecté.
                const progressData = progressMap.get(`${item.id}-${item.media_type}`) ?? EMPTY_PROGRESS;

                return (
                  <CarouselCard
                    key={itemId}
                    item={item}
                    index={index}
                    itemId={itemId}
                    detailPath={detailPath}
                    priority={index < priorityCount}
                    initialStarred={initialStarred}
                    progressData={progressData}
                    isHistory={isHistory}
                    showRanking={showRanking}
                    handleAuxOpen={handleAuxOpen}
                    onRemoveItem={onRemoveItem}
                  />
                );
              })}
              {/* Spacer to ensure last card hover is fully visible */}
              <div className="flex-none w-8 md:w-24" aria-hidden="true" />
            </div>
          </div>
          {/* Boutons de navigation - verticaux noirs avec slide-in au hover */}
          <button
            type="button"
            aria-label={t('common.previous')}
            onClick={handlePrev}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={`hidden md:flex absolute left-6 md:left-8 top-1/2 z-[950]
                     w-12 h-32 rounded-2xl items-center justify-center text-white/90 hover:text-white
                     bg-gradient-to-b from-neutral-900/95 via-black/95 to-neutral-900/95
                     ring-1 ring-white/10 hover:ring-red-500/40
                     shadow-2xl shadow-black/70
                     transition-all duration-300 ease-out
                     -translate-y-1/2
                     opacity-0 -translate-x-2
                     group-hover/carousel:opacity-100 group-hover/carousel:translate-x-0
                     ${!canScrollPrev ? 'pointer-events-none !opacity-0' : 'pointer-events-auto'}`}
          >
            <ChevronLeft className="w-7 h-7" strokeWidth={2.25} />
          </button>
          <button
            type="button"
            aria-label={t('common.next')}
            onClick={handleNext}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={`hidden md:flex absolute right-6 md:right-8 top-1/2 z-[950]
                     w-12 h-32 rounded-2xl items-center justify-center text-white/90 hover:text-white
                     bg-gradient-to-b from-neutral-900/95 via-black/95 to-neutral-900/95
                     ring-1 ring-white/10 hover:ring-red-500/40
                     shadow-2xl shadow-black/70
                     transition-all duration-300 ease-out
                     -translate-y-1/2
                     opacity-0 translate-x-2
                     group-hover/carousel:opacity-100 group-hover/carousel:translate-x-0
                     ${!canScrollNext ? 'pointer-events-none !opacity-0' : 'pointer-events-auto'}`}
          >
            <ChevronRight className="w-7 h-7" strokeWidth={2.25} />
          </button>
        </div>
      </div>
  );
};

export default React.memo(EmblaCarousel);
