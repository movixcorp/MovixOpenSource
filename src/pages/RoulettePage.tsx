import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Dices, Star, Calendar, RotateCcw, Info, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import { motion, AnimatePresence, useAnimation } from 'framer-motion';
import type confettiType from 'canvas-confetti';
import { toast } from 'sonner';

let confettiLib: typeof confettiType | null = null;
const loadConfetti = async (): Promise<typeof confettiType> => {
  if (confettiLib) return confettiLib;
  const mod = await import('canvas-confetti');
  confettiLib = mod.default;
  return confettiLib;
};
import SEO from '../components/SEO';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import CustomDropdown from '../components/CustomDropdown';
import CustomSlider from '../components/CustomSlider';
import { SearchGridCard } from '../components/SearchCard';
import { encodeId } from '../utils/idEncoder';
import { getTmdbLanguage } from '../i18n';
import { getLanguages } from '../data/languages';
import { areSoundEffectsEnabled } from '../utils/soundSettings';
import { filterContentByAge } from '../utils/contentAgeFilter';
import { useProfile } from '../context/ProfileContext';
import { resolveTmdbKeywordId } from '../utils/tmdbKeywords';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// ─── Sound effects via Web Audio API (no external files) ────────────────────
const audioCtxRef = { current: null as AudioContext | null };
const getAudioCtx = () => {
  if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
  return audioCtxRef.current;
};

const playTick = (pitch = 800, volume = 0.08) => {
  if (!areSoundEffectsEnabled()) return;

  try {
    const ctx = getAudioCtx();
    // Short percussive click — like a roulette wheel peg
    const bufferSize = ctx.sampleRate * 0.015; // 15ms
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      // Noise burst shaped by fast decay
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 8);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter to make it sound like a click, not static
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = pitch;
    filter.Q.value = 5;

    const gain = ctx.createGain();
    gain.gain.value = volume;

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
  } catch { /* silent fail */ }
};

const playWinSound = () => {
  if (!areSoundEffectsEnabled()) return;

  try {
    const ctx = getAudioCtx();
    // Rising arpeggio
    [0, 100, 200, 350].forEach((delay, i) => {
      setTimeout(() => {
        if (!areSoundEffectsEnabled()) return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i < 3 ? 'triangle' : 'sine';
        osc.frequency.value = [523, 659, 784, 1047][i]; // C5 E5 G5 C6
        gain.gain.value = 0.12;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }, delay);
    });
  } catch { /* silent fail */ }
};

const POSTER_FALLBACK = `data:image/svg+xml,${encodeURIComponent('<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" fill="#444" font-size="28" font-family="sans-serif" text-anchor="middle" dy=".3em">?</text></svg>')}`;

const GENRES = [
  { id: 28, key: 'action' }, { id: 12, key: 'adventure' }, { id: 16, key: 'animation' },
  { id: 35, key: 'comedy' }, { id: 80, key: 'crime' }, { id: 99, key: 'documentary' },
  { id: 18, key: 'drama' }, { id: 10751, key: 'family' }, { id: 14, key: 'fantasy' },
  { id: 27, key: 'horror' }, { id: 9648, key: 'mystery' }, { id: 10749, key: 'romance' },
  { id: 878, key: 'scifi' }, { id: 53, key: 'thriller' }, { id: 10752, key: 'war' },
];

const PROVIDERS = [
  { id: 8, name: 'Netflix' }, { id: 119, name: 'Prime Video' }, { id: 337, name: 'Disney+' },
  { id: 531, name: 'Paramount+' }, { id: 350, name: 'Apple TV+' }, { id: 384, name: 'HBO Max' },
];

interface RouletteItem {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  vote_average: number;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  media_type: 'movie' | 'tv';
  adult?: boolean;
  is_anime?: boolean;
}

type RouletteMediaFilter = 'all' | 'movie' | 'tv' | 'anime';

const getRouletteItemKey = (item: Pick<RouletteItem, 'id' | 'media_type'>) =>
  `${item.media_type}:${item.id}`;

// ─── Confetti (canvas-confetti) ──────────────────────────────────────────────
const fireConfetti = async () => {
  const confetti = await loadConfetti();
  const end = Date.now() + 2500;
  const colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

  const frame = () => {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.6 },
      colors,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.6 },
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  frame();
};

// ─── Spinning reel component ────────────────────────────────────────────────
const CARD_WIDTH = 160;
const CARD_GAP = 12;
const CARD_TOTAL = CARD_WIDTH + CARD_GAP;

const SpinningReel: React.FC<{
  items: RouletteItem[];
  spinning: boolean;
  winnerIndex: number;
  onFinished: () => void;
  skipSignal: number;
}> = ({ items, spinning, winnerIndex, onFinished, skipSignal }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef(0);

  // Measure container width
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) setContainerWidth(containerRef.current.offsetWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Build a long repeated strip so the reel loops visually
  const repeatedItems = [...items, ...items, ...items, ...items, ...items];

  useEffect(() => {
    if (!spinning || items.length === 0) return;

    const landPos = (items.length * 3 + winnerIndex) * CARD_TOTAL;
    const duration = 4500;
    let lastTickIndex = -1;

    startTimeRef.current = performance.now();
    setOffset(0);

    const animate = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      const currentOffset = landPos * eased;

      // Tick sound when passing each poster
      const currentCardIndex = Math.floor(currentOffset / CARD_TOTAL);
      if (currentCardIndex !== lastTickIndex) {
        lastTickIndex = currentCardIndex;
        // Higher pitch + lower volume as it slows down
        const speed = 1 - progress;
        if (speed > 0.02) playTick(600 + speed * 400, 0.04 + speed * 0.06);
      }

      if (progress < 1) {
        setOffset(currentOffset);
        animRef.current = requestAnimationFrame(animate);
      } else {
        setOffset(landPos);
        playWinSound();
        onFinished();
      }
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [spinning, winnerIndex, items.length]);

  // Skip: snap to result immediately
  useEffect(() => {
    if (skipSignal > 0 && spinning) {
      cancelAnimationFrame(animRef.current);
      const landPos = (items.length * 3 + winnerIndex) * CARD_TOTAL;
      setOffset(landPos);
      playWinSound();
      onFinished();
    }
  }, [skipSignal]);

  // Reset offset when not spinning and no items
  useEffect(() => {
    if (!spinning && items.length === 0) setOffset(0);
  }, [items.length, spinning]);

  const POSTER_HEIGHT = 240;
  const CONTAINER_HEIGHT = POSTER_HEIGHT + 32; // poster + padding

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm" style={{ height: CONTAINER_HEIGHT }}>
      {/* Center marker */}
      <div className="absolute left-1/2 top-2 bottom-2 z-20 pointer-events-none border-2 border-red-500 rounded-xl shadow-[0_0_30px_rgba(239,68,68,0.3)]"
        style={{ width: CARD_WIDTH + 8, transform: 'translateX(-50%)' }} />
      {/* Gradient fades */}
      <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-black to-transparent z-10 pointer-events-none" />
      <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-black to-transparent z-10 pointer-events-none" />

      {/* Reel strip */}
      <div
        className="flex items-center"
        style={{
          height: CONTAINER_HEIGHT,
          transform: `translateX(${(containerWidth / 2) - (CARD_WIDTH / 2) - offset}px)`,
          willChange: 'transform',
          gap: CARD_GAP,
        }}
      >
        {repeatedItems.map((item, i) => (
          <div key={`${item.id}-${i}`} className="flex-shrink-0 rounded-xl overflow-hidden" style={{ width: CARD_WIDTH, height: POSTER_HEIGHT }}>
            <img
              src={item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : POSTER_FALLBACK}
              alt={item.title || item.name || ''}
              className="w-full h-full object-cover rounded-xl"
              onError={(e) => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = POSTER_FALLBACK; }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Slot machine (fullscreen x10 mode) ─────────────────────────────────────

const SLOT_VISIBLE_ROWS = 3;

const VerticalReel: React.FC<{
  items: RouletteItem[];
  winnerIndex: number;
  totalDuration: number;
  posterW: number;
  posterH: number;
  gap: number;
  onFinished: () => void;
}> = ({ items, winnerIndex, totalDuration, posterW, posterH, gap, onFinished }) => {
  const [offset, setOffset] = useState(0);
  const animRef = useRef<number>(0);
  const finishedRef = useRef(false);

  const cardTotal = posterH + gap;
  const visibleHeight = SLOT_VISIBLE_ROWS * cardTotal;
  const repeatedItems = [...items, ...items, ...items, ...items, ...items];
  const landPos = (items.length * 3 + winnerIndex) * cardTotal;

  useEffect(() => {
    const startTime = performance.now();
    let lastTickIndex = -1;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / totalDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      const currentOffset = landPos * eased;

      const currentCardIndex = Math.floor(currentOffset / cardTotal);
      if (currentCardIndex !== lastTickIndex) {
        lastTickIndex = currentCardIndex;
        const speed = 1 - progress;
        if (speed > 0.05) playTick(500 + speed * 500, 0.015 + speed * 0.025);
      }

      if (progress < 1) {
        setOffset(currentOffset);
        animRef.current = requestAnimationFrame(animate);
      } else {
        setOffset(landPos);
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinished();
        }
      }
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-white/10 bg-black/60 backdrop-blur-sm"
      style={{ width: posterW + 12, height: visibleHeight }}
    >
      <div
        className="absolute left-1 right-1 z-20 pointer-events-none border-2 border-red-500 rounded-lg shadow-[0_0_20px_rgba(239,68,68,0.4)]"
        style={{ height: posterH + 6, top: (visibleHeight - posterH - 6) / 2 }}
      />
      <div className="absolute left-0 right-0 top-0 h-16 bg-gradient-to-b from-black via-black/70 to-transparent z-10 pointer-events-none" />
      <div className="absolute left-0 right-0 bottom-0 h-16 bg-gradient-to-t from-black via-black/70 to-transparent z-10 pointer-events-none" />

      <div
        className="flex flex-col items-center px-1.5"
        style={{
          transform: `translateY(${visibleHeight / 2 - posterH / 2 - offset}px)`,
          willChange: 'transform',
          gap,
        }}
      >
        {repeatedItems.map((item, i) => (
          <div
            key={`${item.id}-${i}`}
            className="flex-shrink-0 rounded-lg overflow-hidden"
            style={{ width: posterW, height: posterH }}
          >
            <img
              src={item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : POSTER_FALLBACK}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).onerror = null;
                (e.target as HTMLImageElement).src = POSTER_FALLBACK;
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const SLOT_REEL_COUNT = 5;

const InlineSlotMachine: React.FC<{
  pool: RouletteItem[];
  onComplete: (winners: RouletteItem[]) => void;
  skipAllSignal: number;
}> = ({ pool, onComplete, skipAllSignal }) => {
  const { t } = useTranslation();
  const [round, setRound] = useState(1);
  const [finishedCount, setFinishedCount] = useState(0);
  // The first-round winners are needed only when round two completes. Keeping
  // them in a ref prevents the result render from cancelling the timer that
  // starts the second round.
  const round1WinnersRef = useRef<RouletteItem[]>([]);
  const hideTimerRef = useRef<number | null>(null);
  const nextTimerRef = useRef<number | null>(null);
  const completeTimerRef = useRef<number | null>(null);
  const completedRef = useRef(false);

  // Dimensions adaptatives — calcul synchrone pour éviter le décalage au premier rendu
  const computeDims = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal : 5 rouleaux + gaps + padding (12px par rouleau)
    const gapPx = vw < 640 ? 8 : 12;
    const maxFromW = Math.floor((Math.min(vw - 32, 1280) - gapPx * 4) / 5 - 14);

    // Vertical : 3 rangées dans ~45% du viewport max
    const maxFromH = Math.floor((vh * 0.45) / 3.1);

    let posterW = Math.min(maxFromW, Math.floor(maxFromH / 1.5), 110);
    posterW = Math.max(posterW, 40);
    const posterH = Math.floor(posterW * 1.5);
    const gap = posterW < 55 ? 3 : posterW < 80 ? 4 : 6;

    return { posterW, posterH, gap };
  }, []);

  const [dims, setDims] = useState(computeDims);
  useEffect(() => {
    const update = () => setDims(computeDims());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [computeDims]);

  // Pré-calculer les gagnants des 2 tours (10 résultats uniques)
  const [roundsData] = useState(() => {
    const usedItemKeys = new Set<string>();
    return [0, 1].map(() =>
      Array.from({ length: SLOT_REEL_COUNT }, () => {
        const available = pool
          .map((item, idx) => ({ item, idx }))
          .filter(({ item }) => !usedItemKeys.has(getRouletteItemKey(item)));
        const selected = available[Math.floor(Math.random() * available.length)];

        usedItemKeys.add(getRouletteItemKey(selected.item));
        return { winnerIndex: selected.idx, item: selected.item };
      })
    );
  });

  const currentData = roundsData[round - 1];
  const durations = [2000, 2500, 3000, 3500, 4000];

  const handleReelFinished = useCallback(() => {
    setFinishedCount(c => {
      const next = c + 1;
      if (next === SLOT_REEL_COUNT) {
        playWinSound();
      }
      return next;
    });
  }, []);

  const [done, setDone] = useState(false);
  const [round1Winners, setRound1Winners] = useState<RouletteItem[]>([]);
  const [round2Winners, setRound2Winners] = useState<RouletteItem[]>([]);
  const [reelsHidden, setReelsHidden] = useState(false);
  const allRoundWinners = roundsData.flatMap((slotRound) => slotRound.map((entry) => entry.item));

  const clearPendingTimers = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (nextTimerRef.current !== null) {
      window.clearTimeout(nextTimerRef.current);
      nextTimerRef.current = null;
    }
    if (completeTimerRef.current !== null) {
      window.clearTimeout(completeTimerRef.current);
      completeTimerRef.current = null;
    }
  }, []);

  // Quand un tour se termine : collecter les gagnants et lancer le suivant
  useEffect(() => {
    if (finishedCount < SLOT_REEL_COUNT) return;
    const roundWinners = roundsData[round - 1].map(r => r.item);

    if (round === 1) {
      // Laisser les rouleaux visibles 800ms pour que l'utilisateur voie les résultats
      hideTimerRef.current = window.setTimeout(() => {
        setReelsHidden(true);
        setRound1Winners(roundWinners);
        round1WinnersRef.current = roundWinners;
      }, 800);
      nextTimerRef.current = window.setTimeout(() => {
        setRound(2);
        setFinishedCount(0);
        setReelsHidden(false);
      }, 1500);
      return clearPendingTimers;
    } else {
      hideTimerRef.current = window.setTimeout(() => {
        setReelsHidden(true);
        setRound2Winners(roundWinners);
        setDone(true);
        completeTimerRef.current = window.setTimeout(() => {
          if (completedRef.current) return;
          completedRef.current = true;
          onComplete([...round1WinnersRef.current, ...roundWinners]);
        }, 400);
      }, 800);
      return clearPendingTimers;
    }
  }, [clearPendingTimers, finishedCount, onComplete, round, roundsData]);

  useEffect(() => {
    if (skipAllSignal === 0 || completedRef.current) return;

    clearPendingTimers();
    completedRef.current = true;
    setRound(2);
    setFinishedCount(0);
    round1WinnersRef.current = roundsData[0].map((entry) => entry.item);
    setRound1Winners(round1WinnersRef.current);
    setRound2Winners(roundsData[1].map((entry) => entry.item));
    setReelsHidden(true);
    setDone(true);
    playWinSound();
    onComplete(allRoundWinners);
  }, [allRoundWinners, clearPendingTimers, onComplete, roundsData, skipAllSignal]);

  useEffect(() => {
    return () => {
      clearPendingTimers();
    };
  }, [clearPendingTimers]);

  const isRound1Done = round1Winners.length > 0;
  const isRound2Done = round2Winners.length > 0;
  const reelsVisible = !done && !reelsHidden;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="mb-4"
    >
      {/* Indicateur de tour */}
      {reelsVisible && (
        <div className="flex items-center justify-center gap-3 mb-3">
          <Dices className="w-5 h-5 text-red-500 animate-spin" />
          <span className="text-sm font-semibold text-white/70">
            {t('roulette.roundProgress', { round })}
          </span>
          <div className="flex gap-1.5">
            <div className={`w-2 h-2 rounded-full transition-colors ${isRound1Done ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            <div className={`w-2 h-2 rounded-full transition-colors ${round === 2 ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
          </div>
        </div>
      )}

      {/* Rouleaux actifs — masqués dès qu'un tour se termine */}
      {reelsVisible && (
        <div className="flex justify-center items-start gap-2 sm:gap-3">
          {currentData.map((reel, i) => (
            <VerticalReel
              key={`${round}-${i}`}
              items={pool}
              winnerIndex={reel.winnerIndex}
              totalDuration={durations[i]}
              posterW={dims.posterW}
              posterH={dims.posterH}
              gap={dims.gap}
              onFinished={handleReelFinished}
            />
          ))}
        </div>
      )}

      {/* Résultats des tours */}
      {isRound1Done && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4"
        >
          <p className="text-xs font-semibold text-white/40 uppercase tracking-wider text-center mb-2">{t('roulette.roundNumber', { round: 1 })}</p>
          <div className="flex justify-center gap-2 sm:gap-3">
            {round1Winners.map((item, i) => (
              <motion.div
                key={`r1-${item.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                className="relative overflow-hidden rounded-lg border-2 border-red-500/50"
                style={{ width: dims.posterW, height: dims.posterH, flexShrink: 0 }}
              >
                <img
                  src={item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : POSTER_FALLBACK}
                  alt={item.title || item.name || ''}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-1 py-1">
                  <p className="text-[10px] text-white/80 text-center truncate leading-tight">{item.title || item.name}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}

      {isRound2Done && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-3"
        >
          <p className="text-xs font-semibold text-white/40 uppercase tracking-wider text-center mb-2">{t('roulette.roundNumber', { round: 2 })}</p>
          <div className="flex justify-center gap-2 sm:gap-3">
            {round2Winners.map((item, i) => (
              <motion.div
                key={`r2-${item.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                className="relative overflow-hidden rounded-lg border-2 border-red-500/50"
                style={{ width: dims.posterW, height: dims.posterH, flexShrink: 0 }}
              >
                <img
                  src={item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : POSTER_FALLBACK}
                  alt={item.title || item.name || ''}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-1 py-1">
                  <p className="text-[10px] text-white/80 text-center truncate leading-tight">{item.title || item.name}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
};

// ─── Main page ──────────────────────────────────────────────────────────────
const RoulettePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { currentProfile } = useProfile();
  const profileAgeRestriction = currentProfile?.ageRestriction || 0;

  // Filters
  const [mediaFilter, setMediaFilter] = useState<RouletteMediaFilter>('all');
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [minRating, setMinRating] = useState(0);
  const [localMinRating, setLocalMinRating] = useState(0);
  const [yearMin, setYearMin] = useState('');
  const [yearMax, setYearMax] = useState('');
  const [selectedLangs, setSelectedLangs] = useState<string[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(true);

  // Reel state
  const [pool, setPool] = useState<RouletteItem[]>([]);
  const [spinning, setSpinning] = useState(false);
  const [winnerIndex, setWinnerIndex] = useState(0);
  const [winner, setWinner] = useState<RouletteItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSpun, setHasSpun] = useState(false);

  // Multi-spin
  const [spinCount, setSpinCount] = useState(1);
  const [allWinners, setAllWinners] = useState<RouletteItem[]>([]);
  const resultsGridRef = useRef<HTMLDivElement>(null);
  const [skipSignal, setSkipSignal] = useState(0);
  const [slotSkipSignal, setSlotSkipSignal] = useState(0);
  const [slotMachineActive, setSlotMachineActive] = useState(false);

  // Watchlist
  const [starred, setStarred] = useState(false);
  const winnerCardRef = useRef<HTMLDivElement>(null);

  const languageOptions = getLanguages(i18n.language).map(l => ({ value: l.value, label: l.label }));
  const genreOptions = GENRES.map(g => ({ value: String(g.id), label: t(`genres.id_${g.id}`, { defaultValue: g.key }) }));
  const providerOptions = PROVIDERS.map(p => ({ value: String(p.id), label: p.name }));

  // Multi-select helpers
  const toggleMulti = (arr: string[], val: string, setter: (v: string[]) => void) => {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]);
  };
  const getLabel = (options: { value: string; label: string }[], val: string) =>
    options.find(o => o.value === val)?.label || val;

  const currentYear = new Date().getFullYear();
  const yearOptions = [
    { value: '', label: t('roulette.noLimit') },
    ...Array.from({ length: 50 }, (_, i) => {
      const y = currentYear - i;
      return { value: String(y), label: String(y) };
    }),
  ];

  // Fetch pool from TMDB
  const fetchPool = useCallback(async () => {
    setLoading(true);
    try {
      const isAnimeFilter = mediaFilter === 'anime';
      const types: ('movie' | 'tv')[] = mediaFilter === 'all'
        ? ['movie', 'tv']
        : isAnimeFilter
          ? ['tv']
          : [mediaFilter];
      const today = new Date().toISOString().split('T')[0];
      const allResults: RouletteItem[] = [];
      const tmdbLanguage = getTmdbLanguage();
      const animeKeywordId = isAnimeFilter
        ? await resolveTmdbKeywordId('anime', tmdbLanguage)
        : null;

      for (const type of types) {
        // Fetch 3 random pages for variety
        const randomPages = Array.from({ length: 3 }, () => Math.floor(Math.random() * 20) + 1);

        const requests = randomPages.map(page => {
          const params: Record<string, any> = {
            api_key: TMDB_API_KEY,
            language: tmdbLanguage,
            page,
            sort_by: 'popularity.desc',
            include_adult: false,
            'vote_count.gte': 50,
          };
          if (type === 'movie') params['primary_release_date.lte'] = today;
          else params['first_air_date.lte'] = today;
          if (isAnimeFilter) {
            // Le genre Animation seul inclut aussi les productions occidentales.
            // Le mot-clé TMDB « anime » resserre le résultat quand il est connu.
            params.with_genres = Array.from(new Set(['16', ...selectedGenres])).join(',');
            if (animeKeywordId) params.with_keywords = String(animeKeywordId);
          } else if (selectedGenres.length > 0) {
            params.with_genres = selectedGenres.join(',');
          }
          if (minRating > 0) params['vote_average.gte'] = minRating;
          if (yearMin) {
            if (type === 'movie') params['primary_release_date.gte'] = `${yearMin}-01-01`;
            else params['first_air_date.gte'] = `${yearMin}-01-01`;
          }
          if (yearMax) {
            if (type === 'movie') params['primary_release_date.lte'] = `${yearMax}-12-31`;
            else params['first_air_date.lte'] = `${yearMax}-12-31`;
          }
          if (selectedLangs.length > 0) params.with_original_language = selectedLangs.join('|');
          if (selectedProviders.length > 0) {
            params.with_watch_providers = selectedProviders.join('|');
            params.watch_region = 'FR';
          }

          return axios.get(`https://api.themoviedb.org/3/discover/${type}`, { params });
        });

        const responses = await Promise.all(requests);
        responses.forEach(res => {
          const items = res.data.results
            .filter((item: any) => item.poster_path && item.overview)
            .map((item: any) => ({ ...item, media_type: type, is_anime: isAnimeFilter }));
          allResults.push(...items);
        });
      }

      // Deduplicate and shuffle
      const unique = Array.from(
        new Map(allResults.map(item => [getRouletteItemKey(item), item])).values()
      );
      const shuffled = unique.sort(() => Math.random() - 0.5);
      const allowedItems = await filterContentByAge(shuffled, profileAgeRestriction);

      if (allowedItems.length === 0) {
        toast.error(t('roulette.noResults'));
        setLoading(false);
        return null;
      }

      setPool(allowedItems.slice(0, 30)); // Keep 30 for the reel
      return allowedItems;
    } catch (err) {
      console.error('Roulette fetch error:', err);
      toast.error(t('roulette.fetchError'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [mediaFilter, selectedGenres, minRating, yearMin, yearMax, selectedLangs, selectedProviders, profileAgeRestriction, t]);

  const spinsLeftRef = useRef(0);
  const poolRef = useRef<RouletteItem[]>([]);
  const usedItemKeysRef = useRef<Set<string>>(new Set());

  // Pick a random index that hasn't been used yet
  const pickUniqueIndex = (items: RouletteItem[]): number | null => {
    const available = items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !usedItemKeysRef.current.has(getRouletteItemKey(item)));

    if (available.length === 0) {
      return null;
    }
    return available[Math.floor(Math.random() * available.length)].idx;
  };

  const spin = async () => {
    if (spinning || loading) return;

    setWinner(null);
    setAllWinners([]);
    setSlotMachineActive(false);
    setSlotSkipSignal(0);
    spinsLeftRef.current = 0;
    usedItemKeysRef.current = new Set();

    const result = await fetchPool();
    if (!result || result.length === 0) return;

    const items = result.slice(0, 30);
    if (items.length < spinCount) {
      toast.error(t('roulette.notEnoughUniqueResults', { count: spinCount }));
      return;
    }

    setHasSpun(true);
    setPool(items);
    poolRef.current = items;

    // Mode machine à sous pour x10
    if (spinCount === 10) {
      setSlotMachineActive(true);
      return;
    }

    spinsLeftRef.current = spinCount - 1;

    const idx = pickUniqueIndex(items);
    if (idx === null) return;
    usedItemKeysRef.current.add(getRouletteItemKey(items[idx]));
    setWinnerIndex(idx);
    setSpinning(true);
  };

  const respin = () => {
    if (spinning || poolRef.current.length === 0) return;

    const idx = pickUniqueIndex(poolRef.current);
    if (idx === null) {
      toast.info(t('roulette.noUniqueResults'));
      return;
    }

    setWinner(null);
    usedItemKeysRef.current.add(getRouletteItemKey(poolRef.current[idx]));
    setWinnerIndex(idx);
    setSpinning(true);
  };

  const skipAll = () => {
    if (slotMachineRunning && spinCount === 10) {
      setSlotSkipSignal(s => s + 1);
      return;
    }

    if (!spinning && spinsLeftRef.current === 0) return;
    const items = poolRef.current;
    if (items.length === 0) return;

    // Collect all remaining winners instantly
    const remaining: RouletteItem[] = [];

    // Current spin winner (if still spinning, the reel skip will handle it via skipSignal)
    const currentW = items[winnerIndex];
    if (currentW) remaining.push(currentW);

    // All remaining spins
    while (spinsLeftRef.current > 0) {
      spinsLeftRef.current--;
      const idx = pickUniqueIndex(items);
      if (idx === null) break;
      usedItemKeysRef.current.add(getRouletteItemKey(items[idx]));
      remaining.push(items[idx]);
    }

    // Stop animation
    setSpinning(false);
    setSkipSignal(s => s + 1);

    // Set all results
    const all = [...allWinners, ...remaining];
    setAllWinners(all);
    const lastWinner = remaining[remaining.length - 1];
    setWinner(spinCount <= 1 ? lastWinner : null);
    fireConfetti();
    playWinSound();

    if (lastWinner) {
      const key = `watchlist_${lastWinner.media_type}`;
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      setStarred(list.some((m: any) => m.id === lastWinner.id));
    }

    setTimeout(() => {
      if (spinCount > 1) {
        resultsGridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        winnerCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150);
  };

  const onReelFinished = () => {
    setSpinning(false);
    const w = poolRef.current[winnerIndex];

    if (spinsLeftRef.current > 0) {
      setAllWinners(prev => [...prev, w]);
      spinsLeftRef.current--;

      setTimeout(() => {
        const idx = pickUniqueIndex(poolRef.current);
        if (idx === null) {
          toast.info(t('roulette.noUniqueResults'));
          return;
        }
        usedItemKeysRef.current.add(getRouletteItemKey(poolRef.current[idx]));
        setWinnerIndex(idx);
        setSpinning(true);
      }, 600);
      return;
    }

    // Last spin (or single spin)
    const finalWinners = spinCount > 1 ? [...allWinners, w] : [];
    if (spinCount > 1) setAllWinners(finalWinners);

    setWinner(w);
    fireConfetti();

    if (w) {
      const key = `watchlist_${w.media_type}`;
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      setStarred(list.some((m: any) => m.id === w.id));
    }

    setTimeout(() => {
      if (spinCount > 1) {
        resultsGridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        winnerCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150);
  };

  const onSlotMachineComplete = (winners: RouletteItem[]) => {
    // Garder slotMachineActive = true pour que les 2 tours restent visibles
    setAllWinners(winners);
    fireConfetti();
    setTimeout(() => {
      resultsGridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 500);
  };

  const slotMachineRunning = slotMachineActive && allWinners.length === 0;

  const toggleWatchlist = () => {
    if (!winner) return;
    const key = `watchlist_${winner.media_type}`;
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const title = winner.title || winner.name || '';
    if (starred) {
      localStorage.setItem(key, JSON.stringify(list.filter((m: any) => m.id !== winner.id)));
      setStarred(false);
      toast.success(`${title} ${t('lists.removedFromList')}`);
    } else {
      list.push({ id: winner.id, type: winner.media_type, title, poster_path: winner.poster_path, addedAt: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(list));
      setStarred(true);
      toast.success(`${title} ${t('lists.addedToList')}`);
    }
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
      <motion.div className="min-h-screen pt-24 pb-16 px-4 md:px-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        <SEO title={t('roulette.title')} description={t('roulette.description')} />

        <div className="max-w-screen-xl mx-auto">
          {/* Header */}
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-8">
            <div className="flex items-center justify-center gap-3 mb-2">
              <Dices className="w-8 h-8 text-red-500" />
              <h1 className="text-3xl md:text-4xl font-bold">
                <ShinyText text={t('roulette.title')} speed={4} />
              </h1>
              <Dices className="w-8 h-8 text-red-500" />
            </div>
            <p className="text-white/50 text-sm">{t('roulette.subtitle')}</p>
          </motion.div>

          {/* Filters toggle */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mb-6">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`mx-auto flex items-center gap-2 px-5 py-2.5 rounded-2xl transition-all ${showFilters
                ? 'bg-red-600 border border-red-500 hover:bg-red-500'
                : 'bg-white/5 backdrop-blur-md border border-white/10 hover:border-red-500/40 hover:bg-red-500/10'}`}
            >
              <Sparkles className="w-4 h-4" />
              <span className="text-sm font-medium">{t('roulette.filters')}</span>
              {showFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </motion.div>

          {/* Filters panel */}
          <AnimatePresence>
            {showFilters && (
              <motion.div
                className="mb-8 p-5 rounded-2xl bg-white/5 backdrop-blur-md border border-white/10"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
              >
                {/* Media type toggle */}
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex justify-center gap-2 mb-5">
                  {(['all', 'movie', 'tv', 'anime'] as const).map(type => (
                    <motion.button
                      key={type}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setMediaFilter(type)}
                      className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${mediaFilter === type
                        ? 'bg-red-600 text-white'
                        : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}
                    >
                      {type === 'all'
                        ? t('roulette.all')
                        : type === 'movie'
                          ? t('filter.movies')
                          : type === 'anime'
                            ? t('roulette.animes')
                            : t('filter.series')}
                    </motion.button>
                  ))}
                </motion.div>

                {/* Filter grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {/* Genres — multi-select */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.genre')}</label>
                    <CustomDropdown
                      options={genreOptions.filter(o => !selectedGenres.includes(o.value))}
                      value=""
                      onChange={(val) => { if (val) toggleMulti(selectedGenres, val, setSelectedGenres); }}
                      placeholder={selectedGenres.length ? `${selectedGenres.length} ${t('roulette.selected')}` : t('roulette.allGenres')}
                      searchable={false}
                    />
                    {selectedGenres.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {selectedGenres.map(id => (
                          <motion.button key={id} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                            onClick={() => toggleMulti(selectedGenres, id, setSelectedGenres)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-xs hover:bg-red-500/30 transition-colors">
                            {getLabel(genreOptions, id)} <X className="w-3 h-3" />
                          </motion.button>
                        ))}
                      </div>
                    )}
                  </motion.div>

                  {/* Min rating */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.minRating')}</label>
                    <div className="flex items-center gap-3">
                      <CustomSlider min={0} max={10} step={0.5} value={localMinRating}
                        onChange={setLocalMinRating}
                        onCommit={(val) => { setLocalMinRating(val); setMinRating(val); }}
                        className="flex-grow" />
                      <span className="min-w-[3rem] px-2 py-1 bg-white/5 border border-white/10 rounded-xl text-center font-mono text-sm">
                        {localMinRating.toFixed(1)}
                      </span>
                    </div>
                  </motion.div>

                  {/* Languages — multi-select */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.language')}</label>
                    <CustomDropdown
                      options={languageOptions.filter(o => !selectedLangs.includes(o.value))}
                      value=""
                      onChange={(val) => { if (val) toggleMulti(selectedLangs, val, setSelectedLangs); }}
                      placeholder={selectedLangs.length ? `${selectedLangs.length} ${t('roulette.selected')}` : t('search.allLanguages')}
                    />
                    {selectedLangs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {selectedLangs.map(code => (
                          <motion.button key={code} initial={{ scale: 0 }} animate={{ scale: 1 }}
                            onClick={() => toggleMulti(selectedLangs, code, setSelectedLangs)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/30 transition-colors">
                            {getLabel(languageOptions, code)} <X className="w-3 h-3" />
                          </motion.button>
                        ))}
                      </div>
                    )}
                  </motion.div>

                  {/* Year min */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.yearMin')}</label>
                    <CustomDropdown options={yearOptions} value={yearMin} onChange={setYearMin} searchable={false} />
                  </motion.div>

                  {/* Year max */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.yearMax')}</label>
                    <CustomDropdown options={yearOptions} value={yearMax} onChange={setYearMax} searchable={false} />
                  </motion.div>

                  {/* Providers — multi-select */}
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                    <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('roulette.provider')}</label>
                    <CustomDropdown
                      options={providerOptions.filter(o => !selectedProviders.includes(o.value))}
                      value=""
                      onChange={(val) => { if (val) toggleMulti(selectedProviders, val, setSelectedProviders); }}
                      placeholder={selectedProviders.length ? `${selectedProviders.length} ${t('roulette.selected')}` : t('roulette.allProviders')}
                      searchable={false}
                    />
                    {selectedProviders.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {selectedProviders.map(id => (
                          <motion.button key={id} initial={{ scale: 0 }} animate={{ scale: 1 }}
                            onClick={() => toggleMulti(selectedProviders, id, setSelectedProviders)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs hover:bg-purple-500/30 transition-colors">
                            {getLabel(providerOptions, id)} <X className="w-3 h-3" />
                          </motion.button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Spin controls */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-8">
            {/* Spin count selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40 uppercase tracking-wider">{t('roulette.spins')}</span>
              <div className="flex items-center rounded-xl bg-white/5 border border-white/10 overflow-hidden">
                {[1, 3, 5, 10].map(n => (
                  <button
                    key={n}
                    onClick={() => setSpinCount(n)}
                    className={`px-3 py-2 text-sm font-medium transition-all ${spinCount === n
                      ? 'bg-red-600 text-white'
                      : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                  >
                    {n}x
                  </button>
                ))}
              </div>
            </div>

            {/* Spin button */}
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.9 }}
              onClick={spin}
              disabled={spinning || loading || slotMachineRunning}
              className="relative px-10 py-4 rounded-2xl bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white font-bold text-lg shadow-lg shadow-red-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-3"
            >
              {loading ? (
                <><motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}><Dices className="w-6 h-6" /></motion.div>{t('roulette.loading')}</>
              ) : spinning || slotMachineRunning ? (
                <><motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.5, ease: 'linear' }}><Dices className="w-6 h-6" /></motion.div>{t('roulette.spinning')} {spinsLeftRef.current > 0 ? `(${spinCount - spinsLeftRef.current}/${spinCount})` : ''}</>
              ) : (
                <><Dices className="w-6 h-6" />{hasSpun ? t('roulette.spinAgain') : t('roulette.spin')}{spinCount > 1 ? ` (${spinCount}x)` : ''}</>
              )}
            </motion.button>
          </motion.div>

          {/* Reel normal ou Machine à sous */}
          {pool.length > 0 && !slotMachineActive && (
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }} className="mb-2">
              <SpinningReel items={pool} spinning={spinning} winnerIndex={winnerIndex} onFinished={onReelFinished} skipSignal={skipSignal} />
            </motion.div>
          )}
          {slotMachineActive && pool.length > 0 && (
            <InlineSlotMachine pool={pool} onComplete={onSlotMachineComplete} skipAllSignal={slotSkipSignal} />
          )}

          {/* Skip buttons */}
          <AnimatePresence>
            {spinning && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex justify-center gap-3 mb-6">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setSkipSignal(s => s + 1)}
                  className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-white/50 hover:text-white text-sm transition-all flex items-center gap-2"
                >
                  <ChevronDown className="w-4 h-4" />
                  {t('roulette.skip')}
                </motion.button>
                {spinCount > 1 && (
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={skipAll}
                    className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-red-500/20 hover:border-red-500/30 text-white/50 hover:text-white text-sm transition-all flex items-center gap-2"
                  >
                    <ChevronDown className="w-4 h-4" />
                    <ChevronDown className="w-4 h-4 -ml-3" />
                    {t('roulette.skipAll')}
                  </motion.button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {slotMachineRunning && spinCount === 10 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex justify-center gap-3 mb-6">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={skipAll}
                  className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-red-500/20 hover:border-red-500/30 text-white/50 hover:text-white text-sm transition-all flex items-center gap-2"
                >
                  <ChevronDown className="w-4 h-4" />
                  <ChevronDown className="w-4 h-4 -ml-3" />
                  {t('roulette.skipAll')}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Winner card */}
          <AnimatePresence>
            {winner && !spinning && spinCount <= 1 && (
              <motion.div
                ref={winnerCardRef}
                initial={{ opacity: 0, y: 30, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 30, scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                className="max-w-2xl mx-auto p-6 rounded-2xl bg-white/5 backdrop-blur-md border border-white/10"
              >
                <div className="flex gap-5">
                  {/* Poster */}
                  <div className="flex-shrink-0">
                    <img
                      src={winner.poster_path ? `https://image.tmdb.org/t/p/w342${winner.poster_path}` : POSTER_FALLBACK}
                      alt={winner.title || winner.name}
                      className="w-32 sm:w-40 rounded-xl shadow-lg"
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    <h2 className="text-xl sm:text-2xl font-bold text-white mb-2 line-clamp-2">
                      {winner.title || winner.name}
                    </h2>

                    <div className="flex items-center gap-3 text-sm text-white/50 mb-3">
                      <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 text-yellow-400" fill="currentColor" />
                        <span className="text-white/80">{winner.vote_average?.toFixed(1)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                    <Calendar className="w-4 h-4 text-white opacity-30" />
                        <span>{new Date(winner.release_date || winner.first_air_date || '').getFullYear() || 'N/A'}</span>
                      </div>
                      <span className="px-2 py-0.5 rounded-lg bg-white/5 border border-white/10 text-[11px] uppercase font-semibold">
                        {winner.is_anime
                          ? t('roulette.animes')
                          : winner.media_type === 'movie'
                            ? t('filter.movies')
                            : t('filter.series')}
                      </span>
                    </div>

                    <p className="text-sm text-white/50 line-clamp-3 mb-4">
                      {winner.overview || t('roulette.noDescription')}
                    </p>

                    <div className="flex items-center gap-3 mt-auto">
                      <Link to={`/${winner.media_type}/${encodeId(winner.id)}`}>
                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-medium transition-colors">
                          <Info className="w-4 h-4" /> {t('roulette.viewDetails')}
                        </motion.button>
                      </Link>

                      <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={toggleWatchlist}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all ${starred
                          ? 'bg-yellow-500/10 border border-yellow-400/20 text-yellow-400'
                          : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'}`}>
                        <motion.div key={starred ? 'on' : 'off'} initial={{ scale: 0.3, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 15 }}>
                          <Star className="w-4 h-4" fill={starred ? 'currentColor' : 'none'} />
                        </motion.div>
                      </motion.button>

                      <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={respin}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all">
                        <RotateCcw className="w-4 h-4" /> {t('roulette.spinAgain')}
                      </motion.button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Multi-spin results grid — visible even during spinning */}
          <div ref={resultsGridRef} />
          <AnimatePresence>
            {allWinners.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-8 mb-8"
              >
                <h3 className="text-lg font-semibold text-white/70 mb-4 text-center">
                  {t('roulette.allResults')} ({allWinners.length}{spinCount > 1 && spinning ? `/${spinCount}` : ''})
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                  {allWinners.map((item, i) => (
                    <SearchGridCard
                      key={`${item.id}-${i}`}
                      item={{
                        id: item.id,
                        title: item.title,
                        name: item.name,
                        media_type: item.media_type,
                        poster_path: item.poster_path || '',
                        backdrop_path: item.backdrop_path,
                        release_date: item.release_date,
                        first_air_date: item.first_air_date,
                        vote_average: item.vote_average,
                        overview: item.overview,
                      }}
                      index={i}
                      movieLabel={t('filter.movies')}
                      serieLabel={mediaFilter === 'anime' ? t('roulette.animes') : t('filter.series')}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Empty state */}
          {!hasSpun && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-center py-12">
              <motion.div animate={{ rotate: [0, 10, -10, 0] }} transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}>
          <Dices className="w-16 h-16 text-white opacity-10 mx-auto mb-4" />
              </motion.div>
              <p className="text-white/30 text-sm">{t('roulette.hint')}</p>
            </motion.div>
          )}
        </div>
      </motion.div>
    </SquareBackground>
  );
};

export default RoulettePage;
