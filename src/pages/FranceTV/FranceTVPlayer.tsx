import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, AlertCircle, Crown, Settings, Volume2, VolumeX, Volume1, Play, Pause, Maximize, Minimize, Rewind, FastForward, PictureInPicture, X } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { isUserVip } from '../../utils/authUtils';
import { getVipHeaders } from '../../utils/vipUtils';
import { PROXIES_EMBED_API } from '../../config/runtime';
import type HlsType from 'hls.js';
import type * as ShakaType from 'shaka-player';

let HlsLib: typeof HlsType | null = null;
let ShakaLib: typeof ShakaType | null = null;

const loadHls = async (): Promise<typeof HlsType> => {
  if (HlsLib) return HlsLib;
  const mod = await import('hls.js');
  HlsLib = mod.default;
  return HlsLib;
};

const loadShaka = async (): Promise<typeof ShakaType> => {
  if (ShakaLib) return ShakaLib;
  const mod = await import('shaka-player');
  // shaka-player is a CJS module; Vite/Rollup synthesizes a `default` namespace
  // for it. The previous code used `import shaka from 'shaka-player'` (default),
  // which is what mod.default returns here.
  const dflt = (mod as { default?: typeof ShakaType }).default;
  ShakaLib = dflt ?? (mod as unknown as typeof ShakaType);
  return ShakaLib;
};

// ─── Types ──────────────────────────────────────────────────────────────────────

interface DrmExtractResult {
  manifest_url: string;
  all_manifests: [string, string | null][];
  proxied_manifest_url: string;
  manifest_type: 'hls' | 'dash' | 'smooth' | 'unknown';
  keys: string[];
  key_errors: string[];
  pssh: string[];
  is_hls_aes: boolean;
  title: string;
}

interface QualityOption {
  label: string;
  value: string;
  height?: number;
}

interface AudioOption {
  label: string;
  value: string;
}

interface SubOption {
  label: string;
  value: string;
}

// ─── Language names ─────────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  fr: 'Français', en: 'English', de: 'Deutsch', es: 'Español', it: 'Italiano',
  pt: 'Português', nl: 'Nederlands', ja: '日本語', ko: '한국어', zh: '中文',
  ar: 'العربية', ru: 'Русский', pl: 'Polski', qaa: 'Audiodescription',
  qad: 'Audiodescription', qsm: 'Sous-titres malentendants', und: 'Non défini',
};

function langLabel(code: string | undefined): string {
  if (!code) return '';
  const c = code.toLowerCase().split('-')[0];
  return LANG_NAMES[c] || code;
}

// ─── Component ──────────────────────────────────────────────────────────────────

const FranceTVPlayer: React.FC = () => {
  const { encoded } = useParams<{ encoded: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const shakaRef = useRef<ShakaType.Player | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // Track options
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [selectedQuality, setSelectedQuality] = useState<string>('auto');
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<string>('');
  const [subtitles, setSubtitles] = useState<SubOption[]>([]);
  const [selectedSub, setSelectedSub] = useState<string>('off');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'quality' | 'audio' | 'subtitles' | 'speed'>('quality');
  const [isPipActive, setIsPipActive] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const isVip = isUserVip();

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  // ─── Playback Utilities ────────────────────────────────────────────────

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const newMuted = !isMuted;
    video.muted = newMuted;
    setIsMuted(newMuted);
    if (!newMuted && video.volume === 0) {
      video.volume = 0.5;
      setVolume(0.5);
    }
  }, [isMuted]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  }, []);

  const safeAutoplay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
    } catch {
      // Autoplay blocked — mute and retry, user can unmute via controls
      video.muted = true;
      try { await video.play(); } catch { /* still blocked, user will click play */ }
    }
  }, []);

  // ─── Player Initialization ─────────────────────────────────────────────

  const initHlsPlayer = useCallback(async (manifestUrl: string) => {
    if (!videoRef.current) return;

    const Hls = await loadHls();
    if (!videoRef.current) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ debug: false, enableWorker: true });
      hlsRef.current = hls;

      hls.loadSource(manifestUrl);
      hls.attachMedia(videoRef.current);

      hls.on(Hls.Events.MANIFEST_PARSED, (_: any, data: any) => {
        const quals: QualityOption[] = [{ label: 'Auto', value: '-1' }];
        data.levels.forEach((lv: any, i: number) => {
          const label = lv.height
            ? `${lv.height}p${lv.bitrate ? ` (${Math.round(lv.bitrate / 1000)} kbps)` : ''}`
            : t('francetv.levelLabel', { index: i });
          quals.push({ label, value: String(i), height: lv.height });
        });
        setQualities(quals);

        if (hls.audioTracks && hls.audioTracks.length > 1) {
          const audios: AudioOption[] = hls.audioTracks.map((track: any, i: number) => ({
            label: `${track.name || langLabel(track.lang) || t('francetv.trackLabel', { index: i })}${track.lang ? ` [${track.lang}]` : ''}`,
            value: String(i),
          }));
          setAudioTracks(audios);
          const defaultIdx = hls.audioTracks.findIndex((track: any) => track.default);
          if (defaultIdx >= 0) setSelectedAudio(String(defaultIdx));
        }

        if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
          const subs: SubOption[] = [{ label: t('francetv.subtitlesDisabled'), value: 'off' }];
          hls.subtitleTracks.forEach((t_: any, i: number) => {
            subs.push({
              label: `${t_.name || langLabel(t_.lang) || t('francetv.subtitleLabel', { index: i })}${t_.lang ? ` [${t_.lang}]` : ''}`,
              value: String(i),
            });
          });
          setSubtitles(subs);
        }

        setLoading(false);
        safeAutoplay();
      });

      hls.on(Hls.Events.ERROR, (_: any, data: any) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => hls.startLoad(), 2000);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError(t('francetv.hlsFatalError', { details: data.details }));
          }
        }
      });
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = manifestUrl;
      videoRef.current.addEventListener('loadedmetadata', () => {
        setLoading(false);
        safeAutoplay();
      });
    } else {
      setError(t('francetv.hlsNotSupported'));
    }
  }, [safeAutoplay]);

  const initShakaPlayer = useCallback(async (manifestUrl: string, keys: string[]) => {
    if (!videoRef.current) return;

    const shaka = await loadShaka();
    if (!videoRef.current) return;

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      setError(t('francetv.dashNotSupported'));
      return;
    }

    const player = new shaka.Player();
    shakaRef.current = player;

    await player.attach(videoRef.current);

    if (keys.length > 0) {
      const clearKeys: Record<string, string> = {};
      keys.forEach(k => {
        const [kid, key] = k.split(':');
        if (kid && key) clearKeys[kid] = key;
      });
      if (Object.keys(clearKeys).length > 0) {
        player.configure({ drm: { clearKeys } });
      }
    }

    player.addEventListener('error', (event: any) => {
      console.error('Shaka error:', event.detail);
      if (event.detail.code === 6003) {
        console.warn('Shaka 6003 (MediaSource op failed) — non-fatal, ignoring');
        return;
      }
      setError(t('francetv.dashError', { message: event.detail.message }));
    });

    try {
      await player.load(manifestUrl);
      populateShakaControls(player);
      setLoading(false);
      safeAutoplay();
    } catch (e: any) {
      console.error('Shaka load error:', e);
      if (e.code === 6003) {
        console.warn('Retrying load after 6003...');
        try {
          await player.attach(videoRef.current!);
          await player.load(manifestUrl);
          populateShakaControls(player);
          setLoading(false);
          safeAutoplay();
          return;
        } catch (retryErr: any) {
          console.error('Shaka retry also failed:', retryErr);
        }
      }
      setError(t('francetv.manifestLoadError', { message: e.message }));
    }
  }, [safeAutoplay]);

  const populateShakaControls = useCallback((player: ShakaType.Player) => {
    const variants = player.getVariantTracks();
    const textTracks = player.getTextTracks();

    const seen = new Set<string>();
    const quals: QualityOption[] = [{ label: 'Auto', value: 'auto' }];
    const qualVariants: any[] = [];

    variants.forEach((v: any) => {
      const key = `${v.height || 0}_${v.videoBandwidth}`;
      if (v.height && !seen.has(key)) {
        seen.add(key);
        qualVariants.push(v);
      }
    });
    qualVariants.sort((a: any, b: any) => (a.height || 0) - (b.height || 0));
    qualVariants.forEach((q: any) => {
      const bw = q.videoBandwidth || q.bandwidth || 0;
      quals.push({
        label: `${q.height}p${bw ? ` — ${Math.round(bw / 1000)} kbps` : ''}`,
        value: JSON.stringify({ height: q.height, videoBandwidth: q.videoBandwidth }),
        height: q.height,
      });
    });
    setQualities(quals);

    const audioLangs = new Set<string>();
    const audioList: AudioOption[] = [];
    variants.forEach((v: any) => {
      const key = `${v.language || 'und'}_${v.audioId || 0}`;
      if (!audioLangs.has(key)) {
        audioLangs.add(key);
        const name = v.label || langLabel(v.language) || v.language || t('francetv.trackLabel', { index: 0 });
        audioList.push({
          label: `${name}${v.language ? ` [${v.language}]` : ''}`,
          value: JSON.stringify({ language: v.language, audioId: v.audioId }),
        });
      }
    });
    if (audioList.length > 1) setAudioTracks(audioList);

    if (textTracks.length > 0) {
      const subs: SubOption[] = [{ label: t('francetv.subtitlesDisabled'), value: 'off' }];
      textTracks.forEach((t_: any, i: number) => {
        const name = t_.label || langLabel(t_.language) || t_.language || t('francetv.subtitleLabel', { index: i });
        subs.push({
          label: `${name}${t_.language ? ` [${t_.language}]` : ''}`,
          value: String(i),
        });
      });
      setSubtitles(subs);
    }
  }, []);

  // ─── Control handlers ─────────────────────────────────────────────────

  const handleQualityChange = useCallback((value: string) => {
    setSelectedQuality(value);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = parseInt(value);
    } else if (shakaRef.current) {
      const player = shakaRef.current;
      if (value === 'auto') {
        player.configure({ abr: { enabled: true } });
      } else {
        player.configure({ abr: { enabled: false } });
        const chosen = JSON.parse(value);
        const variants = player.getVariantTracks();
        const active = variants.find((v: any) => v.active);
        const match = variants.find((v: any) =>
          v.height === chosen.height && v.videoBandwidth === chosen.videoBandwidth &&
          (!active || v.language === active.language)
        ) || variants.find((v: any) =>
          v.height === chosen.height && v.videoBandwidth === chosen.videoBandwidth
        );
        if (match) player.selectVariantTrack(match, true);
      }
    }
    setShowSettings(false);
  }, []);

  const handleAudioChange = useCallback((value: string) => {
    setSelectedAudio(value);
    if (hlsRef.current) {
      const idx = parseInt(value);
      if (idx >= 0) hlsRef.current.audioTrack = idx;
    } else if (shakaRef.current) {
      const chosen = JSON.parse(value);
      (shakaRef.current as any).selectAudioLanguage(chosen.language);
    }
    setShowSettings(false);
  }, []);

  const handleSubChange = useCallback((value: string) => {
    setSelectedSub(value);
    if (hlsRef.current) {
      if (value === 'off') {
        hlsRef.current.subtitleTrack = -1;
        hlsRef.current.subtitleDisplay = false;
      } else {
        hlsRef.current.subtitleTrack = parseInt(value);
        hlsRef.current.subtitleDisplay = true;
      }
    } else if (shakaRef.current) {
      const player = shakaRef.current as any;
      if (value === 'off') {
        if (typeof player.setTextTrackVisibility === 'function') {
          player.setTextTrackVisibility(false);
        } else if (typeof player.setTextDisplayVisibility === 'function') {
          player.setTextDisplayVisibility(false);
        }
      } else {
        const tracks = player.getTextTracks();
        const idx = parseInt(value);
        if (tracks[idx]) {
          player.selectTextTrack(tracks[idx]);
          if (typeof player.setTextTrackVisibility === 'function') {
            player.setTextTrackVisibility(true);
          } else if (typeof player.setTextDisplayVisibility === 'function') {
            player.setTextDisplayVisibility(true);
          }
        }
      }
    }
    setShowSettings(false);
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else {
        await video.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch {
      // PiP not supported or failed
    }
  }, []);

  const handleSpeedChange = useCallback((speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setPlaybackSpeed(speed);
    setShowSettings(false);
  }, []);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [duration]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const val = parseFloat(e.target.value);
    video.volume = val;
    setVolume(val);
    setIsMuted(val === 0);
    video.muted = val === 0;
  }, []);

  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying && !showSettings) setShowControls(false);
    }, 5000);
  }, [isPlaying, showSettings]);

  const handleMouseMove = useCallback((e?: Event | React.MouseEvent | PointerEvent) => {
    if (e && 'pointerType' in e && (e as PointerEvent).pointerType === 'touch') return;
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Native listener binding for pointer & mouse movement in FranceTVPlayer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onUserPointerActivity = (e: Event) => {
      handleMouseMove(e);
    };

    const events = ['pointermove', 'mousemove', 'pointerenter', 'mouseenter'];

    events.forEach(eventName => {
      container.addEventListener(eventName, onUserPointerActivity, { passive: true });
    });

    const handleDocumentPointerMove = (e: Event) => {
      if (document.fullscreenElement || container.contains(e.target as Node)) {
        onUserPointerActivity(e);
      }
    };

    document.addEventListener('pointermove', handleDocumentPointerMove, { passive: true });
    document.addEventListener('mousemove', handleDocumentPointerMove, { passive: true });

    return () => {
      events.forEach(eventName => {
        container.removeEventListener(eventName, onUserPointerActivity);
      });
      document.removeEventListener('pointermove', handleDocumentPointerMove);
      document.removeEventListener('mousemove', handleDocumentPointerMove);
    };
  }, [handleMouseMove]);

  const handleMouseLeave = useCallback(() => {
    if (isPlaying) {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 1000);
    }
  }, [isPlaying]);

  // ─── Lock body scroll (like WatchTv) ────────────────────────────────────

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

  // ─── Cleanup ────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, []);

  // ─── Video event listeners ─────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => { setIsPlaying(false); setShowControls(true); };
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => setDuration(video.duration || 0);
    const onEnded = () => { setIsPlaying(false); setShowControls(true); };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted || video.volume === 0);
    };
    const onLeavePip = () => setIsPipActive(false);
    const onEnterPip = () => setIsPipActive(true);

    const clampVolume = (v: number) => Math.max(0, Math.min(1, Math.round(v * 100) / 100));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlayPause();
          resetControlsTimeout();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekBy(-10);
          resetControlsTimeout();
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekBy(10);
          resetControlsTimeout();
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const newVol = clampVolume(video.volume + 0.1);
            video.volume = newVol;
            setVolume(newVol);
          }
          resetControlsTimeout();
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const newVol = clampVolume(video.volume - 0.1);
            video.volume = newVol;
            setVolume(newVol);
          }
          resetControlsTimeout();
          break;
        case 'Equal':
          e.preventDefault();
          {
            const faster = Math.min(2, playbackSpeed + 0.25);
            video.playbackRate = faster;
            setPlaybackSpeed(faster);
          }
          break;
        case 'Minus':
          e.preventDefault();
          {
            const slower = Math.max(0.25, playbackSpeed - 0.25);
            video.playbackRate = slower;
            setPlaybackSpeed(slower);
          }
          break;
        case 'Digit0':
        case 'Numpad0':
          e.preventDefault();
          video.playbackRate = 1;
          setPlaybackSpeed(1);
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
        case 'Escape':
          if (showSettings) {
            setShowSettings(false);
          }
          break;
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    video.addEventListener('enterpictureinpicture', onEnterPip);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [togglePlayPause, seekBy, toggleFullscreen, toggleMute, resetControlsTimeout, playbackSpeed, showSettings]);

  // ─── Fullscreen ─────────────────────────────────────────────────────────

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ─── Extract & Play ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!encoded || !isVip) return;

    let cancelled = false;

    const extract = async () => {
      setLoading(true);
      setExtracting(true);
      setError(null);

      try {
        const decodedUrl = decodeURIComponent(atob(encoded));
        const vipHeaders = getVipHeaders();

        const res = await fetch(`${PROXIES_EMBED_API}/drm/extract?url=${encodeURIComponent(decodedUrl)}`, {
          headers: { ...vipHeaders },
        });

        if (cancelled) return;

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || t('francetv.errorGeneric', { status: res.status }));
        }

        const data: DrmExtractResult = await res.json();
        if (cancelled) return;

        setTitle(data.title || '');
        setExtracting(false);

        const rawManifest = data.proxied_manifest_url || data.manifest_url;
        const manifestUrl = rawManifest.startsWith('/') ? `${PROXIES_EMBED_API}${rawManifest}` : rawManifest;
        const manifestType = data.manifest_type;
        const keys = data.keys || [];

        if (manifestType === 'hls') {
          initHlsPlayer(manifestUrl);
        } else if (manifestType === 'dash') {
          await initShakaPlayer(manifestUrl, keys);
        } else {
          if (videoRef.current) {
            videoRef.current.src = manifestUrl;
            safeAutoplay();
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || t('francetv.extractionError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    extract();

    return () => {
      cancelled = true;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (shakaRef.current) { shakaRef.current.destroy().catch(() => {}); shakaRef.current = null; }
    };
  }, [encoded, isVip]);

  // ─── HLS.js Player ─────────────────────────────────────────────────────

  // ─── Helpers ────────────────────────────────────────────────────────────

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ─── VIP gate ─────────────────────────────────────────────────────────

  if (!isVip) {
    return (
      <div className="fixed inset-0 bg-[#0a0a0f] flex items-center justify-center px-4 z-50">
        <div className="text-center max-w-md">
          <Crown className="w-16 h-16 text-amber-400 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">{t('francetv.vipRequiredTitle')}</h2>
          <p className="text-zinc-400 mb-6">{t('francetv.vipRequiredDesc')}</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => navigate(-1)}
              className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white transition-colors cursor-pointer">
              {t('common.back')}
            </button>
            <button onClick={() => navigate('/vip')}
              className="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 rounded-xl text-black font-semibold transition-colors cursor-pointer">
              {t('francetv.becomeVip')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render (fullscreen like WatchTv) ───────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{ minHeight: 'calc(var(--vh, 1vh) * 100)', overflow: 'hidden' }}
      className="w-full bg-black text-white overflow-hidden fixed inset-0 z-40"
      onPointerMove={handleMouseMove}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Video element — fills entire screen */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="absolute inset-0 w-full h-full object-contain bg-black"
        onClick={togglePlayPause}
        onDoubleClick={toggleFullscreen}
      />

      {/* Loading overlay */}
      {(loading || extracting) && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70">
          <div className="loading-container" style={{ '--uib-size': '35px', '--uib-color': 'white', '--uib-speed': '1s', '--uib-stroke': '3.5px' } as React.CSSProperties}>
            <div className="loading-bar" />
            <div className="loading-bar" />
            <div className="loading-bar" />
            <div className="loading-bar" />
          </div>
          <style dangerouslySetInnerHTML={{ __html: `
            .loading-container { display:flex; align-items:center; justify-content:space-between; width:var(--uib-size); height:calc(var(--uib-size)*0.9); }
            .loading-bar { width:var(--uib-stroke); height:100%; background-color:var(--uib-color); border-radius:calc(var(--uib-stroke)/2); }
            .loading-bar:nth-child(1) { animation:grow var(--uib-speed) ease-in-out calc(var(--uib-speed)*-0.45) infinite; }
            .loading-bar:nth-child(2) { animation:grow var(--uib-speed) ease-in-out calc(var(--uib-speed)*-0.3) infinite; }
            .loading-bar:nth-child(3) { animation:grow var(--uib-speed) ease-in-out calc(var(--uib-speed)*-0.15) infinite; }
            .loading-bar:nth-child(4) { animation:grow var(--uib-speed) ease-in-out infinite; }
            @keyframes grow { 0%,100% { transform:scaleY(0.3); } 50% { transform:scaleY(1); } }
          `}} />
          <p className="text-white/70 text-sm font-medium mt-6">
            {extracting ? t('francetv.extractingStream') : t('francetv.loadingGeneric')}
          </p>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 px-4">
          <AlertCircle className="w-14 h-14 text-red-400 mb-4" />
          <p className="text-red-400 text-center mb-6 max-w-lg text-sm">{error}</p>
          <button onClick={() => navigate(-1)}
            className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white transition-colors cursor-pointer">
            {t('common.back')}
          </button>
        </div>
      )}

      {/* Top bar — back button + PiP + Settings (always visible when controls shown) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showControls ? 1 : 0 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent pt-3 pb-12 px-4"
      >
        <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
          </button>
          <div className="flex items-center gap-0.5 sm:gap-1">
            {/* PiP */}
            <motion.div
              animate={{
                scale: isPipActive ? 0.85 : 1,
                color: isPipActive ? '#dc2626' : '#ffffff'
              }}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
            >
              <button
                onClick={togglePip}
                className="p-1.5 sm:p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer"
              >
                <PictureInPicture className="w-5 h-5 sm:w-[22px] sm:h-[22px]" />
              </button>
            </motion.div>
            {/* Settings gear */}
            {(qualities.length > 1 || audioTracks.length > 1 || subtitles.length > 1) && (
              <motion.div
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
              >
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="p-1.5 sm:p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                >
                  <Settings className={`w-5 h-5 sm:w-[22px] sm:h-[22px] transition-transform duration-300 ${showSettings ? 'rotate-180' : ''}`} />
                </button>
              </motion.div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Bottom gradient */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showControls ? 1 : 0 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent pointer-events-none"
      />

      {/* Controls bar — HLSPlayer pattern */}
      <motion.div
        className="absolute bottom-0 left-0 right-0 p-4 z-20"
        initial={{ opacity: 0, y: 20 }}
        animate={{
          opacity: showControls ? 1 : 0,
          y: showControls ? 0 : 20
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <div className="max-w-screen-2xl mx-auto">
          {/* Time display — above progress bar */}
          <div className="flex items-center justify-between mb-1 px-0.5">
            <span className="text-white/70 text-xs md:text-sm font-mono select-none">
              {formatTime(currentTime)}
            </span>
            <span className="text-white/70 text-xs md:text-sm font-mono select-none">
              {formatTime(duration)}
            </span>
          </div>

          {/* Progress bar */}
          <div
            className="group relative h-1.5 bg-white/20 rounded-full cursor-pointer mb-3 hover:h-2.5 transition-all duration-150"
            onClick={handleProgressClick}
          >
            {/* Progress (red) */}
            <div
              className="absolute inset-y-0 left-0 bg-red-600 rounded-full"
              style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
            {/* Handle */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-red-600 rounded-full -ml-2 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
              style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0' }}
            />
          </div>

          {/* Controls row */}
          <div className="flex items-center justify-between">
            {/* Left controls */}
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <button
                onClick={togglePlayPause}
                className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
              >
                {isPlaying ? <Pause size={24} /> : <Play size={24} />}
              </button>

              {/* Rewind 10s */}
              <button
                onClick={() => seekBy(-10)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                title="-10s"
              >
                <Rewind size={20} />
              </button>

              {/* Forward 10s */}
              <button
                onClick={() => seekBy(10)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                title="+10s"
              >
                <FastForward size={20} />
              </button>

              {/* Volume — expanding slider (group/volume pattern) */}
              <div className="relative group flex items-center h-[24px] ml-1">
                <div className="flex items-center group/volume h-full">
                  <button
                    onClick={toggleMute}
                    className="text-white hover:text-gray-300 transition-colors flex items-center justify-center h-full cursor-pointer"
                  >
                    <VolumeIcon size={24} />
                  </button>

                  <div className="overflow-hidden transition-all duration-200 flex items-center h-full w-0 group-hover/volume:w-[112px] ml-0 group-hover/volume:ml-2">
                    <div className="w-[100px] mx-[6px] flex items-center h-full">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={isMuted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className="w-full accent-red-600 appearance-none h-1 rounded-full cursor-pointer"
                        style={{
                          background: `linear-gradient(to right, #dc2626 ${(isMuted ? 0 : volume) * 100}%, rgba(255, 255, 255, 0.2) ${(isMuted ? 0 : volume) * 100}%)`
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2">
              {/* Fullscreen */}
              <motion.div
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
              >
                <button
                  onClick={toggleFullscreen}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                >
                  {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
                </button>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Settings panel — slide-in right (HLSPlayer pattern) */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            key="settings-panel"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 320 }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
            style={{ height: '100%', position: 'absolute', top: 0, right: 0, bottom: 0, maxWidth: '90vw' }}
            className="bg-black/95 z-[10002] flex flex-col border-l border-gray-800 shadow-xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h3 className="text-white text-sm font-medium">{t('francetv.qualityTab')}</h3>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-gray-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tabs with red underline (layoutId) */}
            <div className="flex border-b border-gray-800 px-2">
              {qualities.length > 1 && (
                <motion.button
                  onClick={() => setSettingsTab('quality')}
                  className={`relative py-2 px-3 text-sm font-medium transition-colors cursor-pointer ${settingsTab === 'quality' ? 'text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  whileTap={{ scale: 0.97 }}
                >
                  {t('francetv.qualityTab')}
                  {settingsTab === 'quality' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                </motion.button>
              )}
              {audioTracks.length > 1 && (
                <motion.button
                  onClick={() => setSettingsTab('audio')}
                  className={`relative py-2 px-3 text-sm font-medium transition-colors cursor-pointer ${settingsTab === 'audio' ? 'text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  whileTap={{ scale: 0.97 }}
                >
                  Audio
                  {settingsTab === 'audio' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                </motion.button>
              )}
              {subtitles.length > 1 && (
                <motion.button
                  onClick={() => setSettingsTab('subtitles')}
                  className={`relative py-2 px-3 text-sm font-medium transition-colors cursor-pointer ${settingsTab === 'subtitles' ? 'text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  whileTap={{ scale: 0.97 }}
                >
                  {t('francetv.subtitlesTab')}
                  {settingsTab === 'subtitles' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                </motion.button>
              )}
              <motion.button
                onClick={() => setSettingsTab('speed')}
                className={`relative py-2 px-3 text-sm font-medium transition-colors cursor-pointer ${settingsTab === 'speed' ? 'text-white' : 'text-gray-400 hover:text-gray-200'}`}
                whileTap={{ scale: 0.97 }}
              >
                {t('watch.speedTab', 'Vitesse')}
                {settingsTab === 'speed' && <motion.div layoutId="activeSettingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
              </motion.button>
            </div>

            {/* Options list */}
            <div className="flex-1 overflow-y-auto p-2" data-lenis-prevent>
              <AnimatePresence mode="wait">
                {settingsTab === 'quality' && (
                  <motion.div key="quality" initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -50 }} transition={{ duration: 0.25 }}>
                    {qualities.map(q => (
                      <button
                        key={q.value}
                        onClick={() => handleQualityChange(q.value)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                          selectedQuality === q.value ? 'bg-red-600/20 text-red-400' : 'text-gray-300 hover:bg-white/5'
                        }`}
                      >
                        {q.label}
                        {selectedQuality === q.value && <span className="float-right text-red-400">✓</span>}
                      </button>
                    ))}
                  </motion.div>
                )}
                {settingsTab === 'audio' && (
                  <motion.div key="audio" initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -50 }} transition={{ duration: 0.25 }}>
                    {audioTracks.map(a => (
                      <button
                        key={a.value}
                        onClick={() => handleAudioChange(a.value)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                          selectedAudio === a.value ? 'bg-red-600/20 text-red-400' : 'text-gray-300 hover:bg-white/5'
                        }`}
                      >
                        {a.label}
                        {selectedAudio === a.value && <span className="float-right text-red-400">✓</span>}
                      </button>
                    ))}
                  </motion.div>
                )}
                {settingsTab === 'subtitles' && (
                  <motion.div key="subtitles" initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -50 }} transition={{ duration: 0.25 }}>
                    {subtitles.map(s => (
                      <button
                        key={s.value}
                        onClick={() => handleSubChange(s.value)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                          selectedSub === s.value ? 'bg-red-600/20 text-red-400' : 'text-gray-300 hover:bg-white/5'
                        }`}
                      >
                        {s.label}
                        {selectedSub === s.value && <span className="float-right text-red-400">✓</span>}
                      </button>
                    ))}
                  </motion.div>
                )}
                {settingsTab === 'speed' && (
                  <motion.div key="speed" initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -50 }} transition={{ duration: 0.25 }}>
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => (
                      <button
                        key={speed}
                        onClick={() => handleSpeedChange(speed)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                          playbackSpeed === speed ? 'bg-red-600/20 text-red-400' : 'text-gray-300 hover:bg-white/5'
                        }`}
                      >
                        {speed === 1 ? t('watch.normalLabel') : `${speed}x`}
                        {playbackSpeed === speed && <span className="float-right text-red-400">✓</span>}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default FranceTVPlayer;
