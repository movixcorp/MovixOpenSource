import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import '../styles/screensaver.css';
import { getTmdbLanguage } from '../i18n';
import { getOverlayPortalRoot } from '../utils/overlayPortal';


const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const IMG_BASE = 'https://image.tmdb.org/t/p';

interface ScreenSaverProps {
  isIdle: boolean;
  onWake: () => void;
}

interface BackdropItem {
  id: number;
  backdrop: string;
  title: string;
  year?: string;
  rating?: number;
}

// ─── Fetch trending backdrops from TMDB ─────────────────────────────────────

async function fetchBackdrops(): Promise<BackdropItem[]> {
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/trending/all/week`, {
      params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
    });
    return (res.data.results || [])
      .filter((r: any) => r.backdrop_path && (r.media_type === 'movie' || r.media_type === 'tv'))
      .slice(0, 20)
      .map((r: any) => ({
        id: r.id,
        backdrop: `${IMG_BASE}/original${r.backdrop_path}`,
        title: r.media_type === 'movie' ? r.title : r.name,
        year: (r.release_date || r.first_air_date || '').substring(0, 4) || undefined,
        rating: r.vote_average,
      }));
  } catch {
    return [];
  }
}

// ─── Get user's favorite posters for mosaic mode ────────────────────────────

function getUserFavoritePosters(): string[] {
  const posters: string[] = [];
  try {
    // Movies
    const favMovies = JSON.parse(localStorage.getItem('favorite_movies') || '[]');
    for (const m of favMovies) {
      if (m.poster_path) posters.push(`${IMG_BASE}/w342${m.poster_path}`);
    }
    // TV
    const favTv = JSON.parse(localStorage.getItem('favorites_tv') || '[]');
    for (const t of favTv) {
      if (t.poster_path) posters.push(`${IMG_BASE}/w342${t.poster_path}`);
    }
  } catch {}
  return posters.slice(0, 20);
}

// ─── ScreenSaver component ──────────────────────────────────────────────────

const ScreenSaver: React.FC<ScreenSaverProps> = ({ isIdle, onWake }) => {
  const { t, i18n } = useTranslation();
  const [backdrops, setBackdrops] = useState<BackdropItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [favoritePosters, setFavoritePosters] = useState<string[]>([]);
  const [showMosaic, setShowMosaic] = useState(false);
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [isWaking, setIsWaking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Settings from localStorage
  const mode = useMemo(() => {
    return localStorage.getItem('screensaver_mode') || 'backdrop';
  }, [isIdle]);

  // Load data when entering idle
  useEffect(() => {
    if (!isIdle) return;

    // Fetch trending backdrops
    fetchBackdrops().then((items) => {
      if (items.length > 0) {
        setBackdrops(items);
        setCurrentIndex(0);
      }
    });

    // Get user favorites for mosaic
    const posters = getUserFavoritePosters();
    setFavoritePosters(posters);
    setShowMosaic(mode === 'mosaic' && posters.length >= 4);
  }, [isIdle, mode]);

  // Carousel timer for backdrop mode
  useEffect(() => {
    if (!isIdle || showMosaic || backdrops.length === 0) return;

    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % backdrops.length);
    }, 8000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isIdle, showMosaic, backdrops.length]);

  // Clock
  useEffect(() => {
    if (!isIdle) return;

    const updateClock = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }));
      setDateStr(now.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' }));
    };

    updateClock();
    const clockInterval = setInterval(updateClock, 1000);
    return () => clearInterval(clockInterval);
  }, [isIdle]);

  // Dismiss on any interaction — with wake-up animation
  const handleDismiss = useCallback(() => {
    if (isWaking) return;
    setIsWaking(true);
    // Let the exit animation play before actually waking
    setTimeout(() => {
      onWake();
      setIsWaking(false);
    }, 600);
  }, [onWake, isWaking]);

  // Auto-focus overlay for keyboard events
  useEffect(() => {
    if (isIdle && overlayRef.current) {
      overlayRef.current.focus();
    }
  }, [isIdle]);

  // Global keydown listener as backup (overlay might lose focus)
  useEffect(() => {
    if (!isIdle) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      handleDismiss();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isIdle, handleDismiss]);

  const current = backdrops[currentIndex];

  const content = (
    <AnimatePresence>
      {isIdle && (
        <motion.div
          ref={overlayRef}
          className="screensaver-overlay"
          initial={{ opacity: 0 }}
          animate={isWaking
            ? { opacity: 0, scale: 1.05, filter: 'blur(10px)' }
            : { opacity: 1, scale: 1, filter: 'blur(0px)' }
          }
          exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)' }}
          transition={{ duration: isWaking ? 0.6 : 1.2, ease: 'easeOut' }}
          onClick={handleDismiss}
          onKeyDown={(e) => { e.preventDefault(); handleDismiss(); }}
          onTouchStart={(e) => { e.preventDefault(); handleDismiss(); }}
          onTouchEnd={(e) => { e.preventDefault(); handleDismiss(); }}
          tabIndex={0}
          style={{ outline: 'none' }}
        >
          {/* ─── Mosaic Mode ─── */}
          {showMosaic && (
            <>
              <div className="screensaver-mosaic">
                {favoritePosters.map((poster, i) => (
                  <motion.div
                    key={i}
                    className="screensaver-mosaic-item"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.08, duration: 0.6 }}
                  >
                    <img src={poster} alt="" loading="eager" />
                  </motion.div>
                ))}
              </div>
              <div className="screensaver-mosaic-overlay" />
            </>
          )}

          {/* ─── Backdrop Carousel Mode ─── */}
          {!showMosaic && backdrops.length > 0 && (
            <div className="screensaver-backdrop-container">
              <AnimatePresence mode="sync">
                <motion.div
                  key={currentIndex}
                  className="screensaver-backdrop"
                  initial={{ opacity: 0, scale: 1.08 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 2, ease: 'easeInOut' }}
                >
                  <img
                    src={current?.backdrop}
                    alt={current?.title}
                    loading="eager"
                  />
                </motion.div>
              </AnimatePresence>

              {/* Ken Burns slow zoom effect */}
              <div className="screensaver-kenburns" />

              {/* Bottom info */}
              {current && (
                <motion.div
                  className="screensaver-backdrop-info"
                  key={`info-${currentIndex}`}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 1, delay: 0.5 }}
                >
                  <div className="screensaver-backdrop-title">{current.title}</div>
                  <div className="screensaver-backdrop-meta">
                    {current.year && <span>{current.year}</span>}
                    {current.rating && current.rating > 0 && (
                      <span>★ {current.rating.toFixed(1)}</span>
                    )}
                  </div>
                </motion.div>
              )}

              {/* Progress dots */}
              <div className="screensaver-dots">
                {backdrops.slice(0, 10).map((_, i) => (
                  <div
                    key={i}
                    className={`screensaver-dot ${i === currentIndex % 10 ? 'active' : ''}`}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ─── Clock / Date ─── */}
          <motion.div
            className="screensaver-clock"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.3 }}
          >
            <div className="screensaver-time">{timeStr}</div>
            <div className="screensaver-date">{dateStr}</div>
          </motion.div>

          {/* ─── Dismiss hint ─── */}
          <motion.div
            className="screensaver-hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2, duration: 1 }}
          >
            {t('common.clickOrPressToReturn')}
          </motion.div>

          {/* Vignette overlay */}
          <div className="screensaver-vignette" />
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, getOverlayPortalRoot());
};

export default ScreenSaver;
