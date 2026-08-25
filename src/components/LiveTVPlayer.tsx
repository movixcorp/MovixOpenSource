import React, { useEffect, useRef, useState, useCallback } from 'react';
import type HlsType from 'hls.js';
import type * as DashjsType from 'dashjs';
import type MpegtsType from 'mpegts.js';

let HlsLib: typeof HlsType | null = null;
let DashjsLib: typeof DashjsType | null = null;
let MpegtsLib: typeof MpegtsType | null = null;

const loadHls = async (): Promise<typeof HlsType> => {
  if (HlsLib) return HlsLib;
  const mod = await import('hls.js');
  HlsLib = mod.default;
  return HlsLib;
};

const loadDashjs = async (): Promise<typeof DashjsType> => {
  if (DashjsLib) return DashjsLib;
  // dashjs is ESM — `import('dashjs')` resolves to the namespace which already
  // exposes `MediaPlayer` as a named export. No `.default` indirection needed.
  DashjsLib = await import('dashjs');
  return DashjsLib;
};

const loadMpegts = async (): Promise<typeof MpegtsType> => {
  if (MpegtsLib) return MpegtsLib;
  const mod = await import('mpegts.js');
  MpegtsLib = mod.default;
  return MpegtsLib;
};
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, Loader2, Volume1, Cast, Airplay, Settings, ArrowLeft, ExternalLink } from 'lucide-react';
import { isExtensionAvailable, fetchFromExtension } from '../utils/extensionProxy';
import { isLiveTvSourceEnabled, type LiveTvSourceKey } from '../utils/extractionPrefs';
import {
    getVavooFallbackAction,
    resolveVavooVariantStreams,
    type VavooChannelVariant,
} from '../utils/vavooChannelGroups';
import { isLowLatencyEnabled } from '../utils/lowLatencyPref';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getVipHeaders } from '../utils/vipUtils';
import {
    initializeCastApi,
    requestCastSession,
    loadMediaOnCast,
    prepareCastMediaInfo,
    isAirPlaySupported,
    initializeAirPlay,
    requestAirPlay,
    AirPlayState
} from '../utils/castUtils';

// Custom Loader that keeps top-level manifest requests on the proxy URL.
// Child playlists rewritten by proxiesembed already use stable proxied URLs;
// forcing them back to the root manifest can break live sequence tracking.
class ProxyLoader {
    // URL proxy complète (et signée) à réutiliser pour les rechargements de
    // manifeste. On ne la reconstruit jamais à partir de morceaux : le client
    // ne sait pas signer, et une URL non signée serait refusée par le proxy.
    static _manifestUrl: string = '';
    static _forceLevelReloads: boolean = false; // Direct live media playlist: keep level refreshes on the source proxy URL

    private delegate: any;

    constructor(config: any) {
        // ProxyLoader is only instantiated by HLS.js after `new Hls(...)` has run,
        // which only happens after `loadHls()` has resolved. So HlsLib is set here.
        const DefaultLoader = (HlsLib!.DefaultConfig as any).loader;
        this.delegate = new DefaultLoader(config);
    }

    get stats() { return this.delegate.stats; }
    get context() { return this.delegate.context; }

    destroy() { this.delegate.destroy(); }
    abort() { this.delegate.abort(); }

    load(context: any, config: any, callbacks: any) {
        const url: string = context.url;
        const isManifest = context.type === 'manifest';
        // A child playlist already rewritten by proxiesembed uses the path form
        // `${base}/proxy/<token>.m3u8`, distinct from the manifest/direct query form
        // `${base}/proxy?url=...`. Such children are stable, independently reloadable
        // URLs — never force them back to the master, otherwise a single-variant
        // master loops forever: master → variant → forced to master → variant → ...
        const isRewrittenChild = url.includes('/proxy/') && !url.includes('/proxy?url=');
        const isDirectLevelReload =
            context.type === 'level' && ProxyLoader._forceLevelReloads && !isRewrittenChild;

        if (isManifest || isDirectLevelReload) {
            // Keep only the top-level manifest anchored on the original proxy URL.
            // Level/audio playlists must preserve their own proxied URL returned by the proxy.
            const forceUrl = ProxyLoader._manifestUrl;
            if (forceUrl && url !== forceUrl) {
                console.log('[ProxyLoader] Manifest reload → forced through proxy (was:', url.substring(0, 80), ')');
                context.url = forceUrl;
            }
        }
        // Level/audio playlists and segments: keep the rewritten proxied URL as-is.

        this.delegate.load(context, config, callbacks);
    }
}

// Custom Loader for HLS.js to use Extension Proxy
class ExtensionLoader {
    context: any;
    config: any;
    stats: any;
    retryDelay: number;
    onProgress: any;

    constructor(config: any) {
        console.log("ExtensionLoader Instantiated");
        this.context = null;
        this.config = config;
        // Initialize stats with the structure HLS.js expects
        this.stats = {
            aborted: false,
            loaded: 0,
            retry: 0,
            total: 0,
            chunkCount: 0,
            bwEstimate: 0,
            loading: { start: 0, first: 0, end: 0 },
            parsing: { start: 0, end: 0 },
            buffering: { start: 0, first: 0, end: 0 }
        };
        this.retryDelay = 0;
        this.onProgress = null;
    }

    destroy() { }
    abort() {
        this.stats.aborted = true;
    }

    async load(context: any, _config: any, callbacks: any) {
        this.context = context;
        const { url } = context;

        // Log request
        console.log(`ExtensionLoader loading: ${url}`);

        // Record start time
        const startTime = performance.now();
        this.stats.loading.start = startTime;

        const EMPTY_RESPONSE_MAX_RETRIES = 12;
        const EMPTY_RESPONSE_RETRY_INTERVAL_MS = 500;

        try {
            const headers: any = {};
            // If it's a Vavoo stream, add headers
            if (url.includes('vavoo') || url.includes('sunshine')) {
                headers['User-Agent'] = 'VAVOO/2.6';
            }
            // If it's a Wiflix stream (lansdrud.space), add Origin and Referer
            if (url.includes('lansdrud.space')) {
                headers['Origin'] = 'https://witv.website';
                headers['Referer'] = 'https://witv.website/';
            }

            // Call extension with retries for empty 200 responses
            let response: any = null;
            let gotValidPayload = false;

            for (let attempt = 0; attempt < EMPTY_RESPONSE_MAX_RETRIES && !gotValidPayload; attempt++) {
                response = await fetchFromExtension('PROXY_HTTP', { url, headers });

                if (!response || response.error) {
                    throw new Error(response?.error || 'Extension fetch failed');
                }

                const encodedPayload = typeof response.data === 'string' ? response.data.trim() : '';
                const isEmpty200 = response.status === 200 && encodedPayload.length === 0;

                if (isEmpty200 && attempt < EMPTY_RESPONSE_MAX_RETRIES - 1) {
                    console.warn(`[ExtensionLoader] Empty 200 response, retry ${attempt + 1}/${EMPTY_RESPONSE_MAX_RETRIES} in ${EMPTY_RESPONSE_RETRY_INTERVAL_MS}ms for: ${url}`);
                    await new Promise(resolve => setTimeout(resolve, EMPTY_RESPONSE_RETRY_INTERVAL_MS));
                    continue;
                }

                if (isEmpty200) {
                    throw new Error('Proxy response is empty (200). Try again or use VLC.');
                }

                gotValidPayload = true;
            }

            // Decode Data (Base64) to ArrayBuffer
            const binaryString = atob(response.data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // HLS.js expects:
            // - string for playlists (.m3u8)
            // - ArrayBuffer for segments (.ts, .aac, etc.)
            const isPlaylist = url.endsWith('.m3u8') || url.includes('.m3u8?') || context.type === 'manifest' || context.type === 'level' || context.type === 'audio-track';

            let data: string | ArrayBuffer;
            if (isPlaylist) {
                // Convert to string for playlists
                data = binaryString;
                console.log(`ExtensionLoader loaded playlist (${binaryString.length} chars) for: ${url}`);
            } else {
                // Keep as ArrayBuffer for segments
                data = bytes.buffer;
                console.log(`ExtensionLoader loaded segment (${bytes.byteLength} bytes) for: ${url}`);
            }

            // Update stats
            const endTime = performance.now();
            this.stats.loading.first = startTime;
            this.stats.loading.end = endTime;
            this.stats.loaded = bytes.byteLength;
            this.stats.total = bytes.byteLength;

            console.log(`[ExtensionLoader] Response for ${url}:`, {
                status: response.status,
                finalUrl: response.finalUrl,
                dataLength: bytes.byteLength
            });

            if (response.finalUrl && response.finalUrl !== url) {
                console.log(`[ExtensionLoader] Redirect detected: ${url} -> ${response.finalUrl}`);
                // Explicitly update context url to help some players that might rely on it
                context.url = response.finalUrl;
            }

            callbacks.onSuccess(
                { url: response.finalUrl || url, data: data },
                this.stats,
                context,
                null
            );

        } catch (err: any) {
            console.error("ExtensionLoader Error:", err);
            callbacks.onError(
                { code: 0, text: err.message },
                context,
                null
            );
        }
    }
}

interface Stream {
    url: string;
    // Variante proxifiée et signée par mainapi, jointe d'office à chaque flux.
    // Le client ne peut pas la fabriquer lui-même : proxiesembed n'accepte que
    // des URLs signées par le backend.
    proxyUrl?: string;
    title: string;
    behaviorHints?: {
        notWebReady?: boolean;
        bingeGroup?: string;
    };
    _isEmbed?: boolean;
    _embedPath?: string;
    _directPlay?: boolean; // Play the raw URL as-is: no proxy, no extension loader (Vavoo)
    _vavooVariantId?: string;
    originalUrl?: string; // Original unproxied URL for extension use (Wiflix streams)
    referer?: string;
    userAgent?: string;
    _fctvReferer?: string; // FCTV native (free): player Referer for the extension to inject
    _fctvLocal?: { // FCTV native (free): resolve in-browser via the extension (IP-locked stream)
        matchId: string | number;
        streamId: string | number;
        siteType: string | number;
        sportType: string | number;
        apiBase: string;
    };
}

interface StreamRequestOptions {
    sourceIndex?: number;
}

interface LiveTVPlayerProps {
    channelId: string;
    channelName: string;
    channelPoster?: string;
    // Vavoo: every server/quality variant is resolved concurrently on open.
    vavooVariants?: VavooChannelVariant[];
    onClose: () => void;
}



// Check if URL has non-standard port (should be filtered out, except for known providers)
const hasNonStandardPort = (_url: string): boolean => {
    return false; // User requested to allow ALL URLs including HTTP and non-standard ports
    /*
    try {
        // ... (Disabled strict port filtering)
    } catch {
        return true; 
    }
    */
};

// Constante pour le serveur proxy embed
const VAVOO_USER_AGENT = 'VAVOO/2.6';
const VAVOO_VARIANT_TIMEOUT_MS = 12_000;

const buildProxyHeadersForStream = (stream?: Stream, forceVavooUserAgent = false): Record<string, string> => {
    const headers: Record<string, string> = {};
    const referer = stream?.referer;

    if (referer) {
        headers['Referer'] = referer;
        try {
            headers['Origin'] = new URL(referer).origin;
        } catch {
            // Ignore invalid referer values
        }
    }

    const userAgent = stream?.userAgent || (forceVavooUserAgent ? VAVOO_USER_AGENT : '');
    if (userAgent) {
        headers['User-Agent'] = userAgent;
    }

    return headers;
};

const mergeHeadersIntoProxyUrl = (url: string, headers: Record<string, string>): string => {
    if (!url.includes('/proxy?url=') || Object.keys(headers).length === 0) {
        return url;
    }

    try {
        const parsedUrl = new URL(url);
        const existingHeadersRaw = parsedUrl.searchParams.get('headers');
        const existingHeaders = existingHeadersRaw ? JSON.parse(existingHeadersRaw) : {};
        parsedUrl.searchParams.set('headers', JSON.stringify({ ...existingHeaders, ...headers }));
        return parsedUrl.toString();
    } catch {
        return url;
    }
};

const LiveTVPlayer: React.FC<LiveTVPlayerProps> = ({
    channelId,
    channelName,
    channelPoster,
    vavooVariants,
    onClose,
}) => {
    const { t } = useTranslation();
    // ... (refs and state)
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<HlsType | null>(null);
    const dashRef = useRef<any>(null);
    const mpegtsRef = useRef<any>(null); // Ref for mpegts player
    const controlsTimeoutRef = useRef<NodeJS.Timeout>();
    const hls404RetryRef = useRef(0);
    const hls458RetryRef = useRef(0);
    const levelParsingRetryRef = useRef(0);
    const currentCastUrlRef = useRef<string | null>(null);

    // Watchdog refs for stall detection & auto-recovery
    const watchdogRef = useRef<NodeJS.Timeout | null>(null);
    const lastTimeRef = useRef<number>(0);
    const stallCountRef = useRef<number>(0);
    const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const bufferAppendRetryRef = useRef<number>(0);
    const hlsRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const hlsRecoveryInFlightRef = useRef(false);
    const userPausedRef = useRef(false);
    const streamsRef = useRef<Stream[]>([]);
    const vavooResolutionPendingRef = useRef(false);
    const vavooResolutionOwnerRef = useRef<symbol | null>(null);
    const waitingForVavooStreamRef = useRef<{ errorMessage: string } | null>(null);

    const [streams, setStreams] = useState<Stream[]>([]);
    const [currentStreamIndex, setCurrentStreamIndex] = useState(0);
    const [isVavooResolving, setIsVavooResolving] = useState(false);

    useEffect(() => {
        streamsRef.current = streams;
    }, [streams]);

    // FCTV native (matches) is IP-locked: the token must be minted from the
    // user's IP. So free users resolve each server in the browser via the
    // extension/userscript (RESOLVE_FCTV), which also installs the Referer rule.
    // Stubs that can't be resolved (no extension) keep an empty url and get
    // filtered out below. Le repli « lecteur intégré » ayant été retiré, ces
    // utilisateurs voient « aucun flux disponible ».
    const resolveFctvStubs = useCallback(async (rawStreams: Stream[]): Promise<Stream[]> => {
        if (!Array.isArray(rawStreams) || !rawStreams.some((s) => s._fctvLocal)) return rawStreams;
        if (!isExtensionAvailable()) return rawStreams;
        return Promise.all(rawStreams.map(async (s) => {
            if (!s._fctvLocal) return s;
            try {
                const res = await fetchFromExtension<{ url?: string }>('RESOLVE_FCTV', {
                    ...s._fctvLocal,
                    referer: s._fctvReferer,
                });
                if (res?.url) return { ...s, url: res.url };
            } catch { /* keep stub -> filtered out */ }
            return s;
        }));
    }, []);

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isUserPaused, setIsUserPaused] = useState(false);
    const [volume, setVolume] = useState(() => {
        const savedVolume = localStorage.getItem('playerVolume');
        return savedVolume ? parseFloat(savedVolume) : 1;
    });
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [useProxy, setUseProxy] = useState(false);
    const [playerReinitKey, setPlayerReinitKey] = useState(0); // Increment to force player reinit


    // Cast states
    const [isCasting, setIsCasting] = useState(false);
    const [airplayState, setAirplayState] = useState<AirPlayState>({
        isAvailable: false,
        isConnected: false,
        isConnecting: false
    });

    const MAX_404_RETRIES = 12;
    const RETRY_INTERVAL_MS = 500;
    const MAX_458_RETRIES = 30;
    const RETRY_458_INTERVAL_MS = 500;
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const clearControlsTimeout = useCallback(() => {
        if (controlsTimeoutRef.current) {
            clearTimeout(controlsTimeoutRef.current);
            controlsTimeoutRef.current = undefined;
        }
    }, []);

    const clearHlsRecoveryTimeout = useCallback(() => {
        if (hlsRecoveryTimeoutRef.current) {
            clearTimeout(hlsRecoveryTimeoutRef.current);
            hlsRecoveryTimeoutRef.current = null;
        }
    }, []);

    const resetPauseState = useCallback(() => {
        userPausedRef.current = false;
        setIsUserPaused(false);
    }, []);

    const setPauseStateFromUserAction = useCallback((paused: boolean) => {
        userPausedRef.current = paused;
        setIsUserPaused(paused);
    }, []);

    const resetVideoElement = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        try {
            video.removeAttribute('src');
            video.load();
        } catch (err) {
            console.error('[LiveTV] Failed to reset video element:', err);
        }
    }, []);

    const getLiveResyncPosition = useCallback((instance: HlsType | null, video?: HTMLVideoElement | null) => {
        if (!instance) return null;

        const liveSyncPosition = instance.liveSyncPosition;
        if (typeof liveSyncPosition === 'number' && Number.isFinite(liveSyncPosition) && liveSyncPosition > 0) {
            return liveSyncPosition;
        }

        const latestLevelDetails = instance.latestLevelDetails as {
            edge?: number;
            targetduration?: number;
        } | null;

        const edge = latestLevelDetails?.edge;
        if (typeof edge === 'number' && Number.isFinite(edge) && edge > 0) {
            const targetDuration = latestLevelDetails?.targetduration;
            const safetyBackoff =
                typeof targetDuration === 'number' && Number.isFinite(targetDuration) && targetDuration > 0
                    ? Math.max(targetDuration * 1.5, 1)
                    : 3;
            return Math.max(edge - safetyBackoff, 0);
        }

        if (video && video.buffered.length > 0) {
            try {
                const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                if (Number.isFinite(bufferedEnd) && bufferedEnd > 0) {
                    return Math.max(bufferedEnd - 0.25, 0);
                }
            } catch {
                // Ignore buffered range read errors
            }
        }

        return null;
    }, []);

    const seekToLiveEdge = useCallback((instance: HlsType | null, video: HTMLVideoElement | null) => {
        if (!instance || !video) return false;

        const targetPosition = getLiveResyncPosition(instance, video);
        if (typeof targetPosition !== 'number' || !Number.isFinite(targetPosition) || targetPosition <= 0) {
            return false;
        }

        video.currentTime = targetPosition;
        return true;
    }, [getLiveResyncPosition]);

    const scheduleHlsReinit = useCallback((instance: HlsType | null, reason: string) => {
        if (!instance || hlsRef.current !== instance) return;
        if (hlsRecoveryInFlightRef.current) {
            console.log(`[HLS] ${reason}: recovery already in flight`);
            return;
        }

        hlsRecoveryInFlightRef.current = true;
        clearHlsRecoveryTimeout();
        resetPauseState();
        setIsLoading(true);

        hlsRecoveryTimeoutRef.current = setTimeout(() => {
            if (hlsRef.current !== instance) {
                hlsRecoveryInFlightRef.current = false;
                return;
            }

            console.log(`[HLS] Reinitializing player after ${reason}`);

            try {
                instance.stopLoad();
            } catch {
                // Ignore stopLoad errors on stale instances
            }

            try {
                instance.destroy();
            } catch (err) {
                console.error(`[HLS] Failed to destroy instance after ${reason}:`, err);
            }

            if (hlsRef.current === instance) {
                hlsRef.current = null;
            }

            resetVideoElement();
            hlsRecoveryInFlightRef.current = false;
            setPlayerReinitKey(prev => prev + 1);
        }, 120);
    }, [clearHlsRecoveryTimeout, resetPauseState, resetVideoElement]);

    const scheduleHlsLiveResync = useCallback((instance: HlsType | null, reason: string) => {
        if (!instance || hlsRef.current !== instance) return;
        if (hlsRecoveryInFlightRef.current) {
            console.log(`[HLS] ${reason}: recovery already in flight`);
            return;
        }

        hlsRecoveryInFlightRef.current = true;
        clearHlsRecoveryTimeout();
        resetPauseState();
        setIsLoading(true);

        hlsRecoveryTimeoutRef.current = setTimeout(() => {
            if (hlsRef.current !== instance) {
                hlsRecoveryInFlightRef.current = false;
                return;
            }

            const video = videoRef.current;
            console.log(`[HLS] Live resync after ${reason}`);

            try {
                try {
                    instance.stopLoad();
                } catch {
                    // Ignore stopLoad errors on stale instances
                }

                seekToLiveEdge(instance, video);
                instance.startLoad(-1, true);
                if (video) {
                    video.play().catch(() => { });
                }
                hlsRecoveryInFlightRef.current = false;
            } catch (err) {
                hlsRecoveryInFlightRef.current = false;
                console.error(`[HLS] Live resync failed after ${reason}:`, err);
                scheduleHlsReinit(instance, `${reason} live resync failure`);
            }
        }, 120);
    }, [clearHlsRecoveryTimeout, resetPauseState, scheduleHlsReinit, seekToLiveEdge]);

    // Initialize Cast APIs
    useEffect(() => {
        // The Cast SDK loads async from index.html — at mount time
        // chrome.cast.isAvailable is often still false. Initializing once and
        // giving up left the cast button permanently dead on first visits, so
        // hook __onGCastApiAvailable to retry when the SDK announces itself.
        let restoreCastCallback: (() => void) | undefined;
        if ((window as any).chrome?.cast?.isAvailable) {
            void initializeCastApi();
        } else {
            const previousCallback = (window as any).__onGCastApiAvailable;
            (window as any).__onGCastApiAvailable = (isAvailable: boolean) => {
                if (typeof previousCallback === 'function') {
                    previousCallback(isAvailable);
                }
                if (isAvailable) {
                    void initializeCastApi();
                }
            };
            restoreCastCallback = () => {
                (window as any).__onGCastApiAvailable = previousCallback;
            };
        }

        // Initialize AirPlay
        let airplayCleanup: (() => void) | undefined;
        if (videoRef.current && isAirPlaySupported()) {
            airplayCleanup = initializeAirPlay(videoRef.current, (state) => {
                setAirplayState(state);
            });
        }

        return () => {
            restoreCastCallback?.();
            airplayCleanup?.();
        };
    }, []);


    // API Base URL
    const API_BASE = import.meta.env.VITE_MAIN_API || 'http://localhost:25565';

    // Lock the background page scroll while the player is open (embed iframe or
    // video). Scroll inside the iframe still works — it's cross-origin and
    // unaffected by locking the host page's body/html overflow.
    useEffect(() => {
        const prevBodyOverflow = document.body.style.overflow;
        const prevHtmlOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        const lenis = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
        lenis?.stop();
        return () => {
            document.body.style.overflow = prevBodyOverflow;
            document.documentElement.style.overflow = prevHtmlOverflow;
            lenis?.start();
        };
    }, []);

    const fetchChannelPayload = useCallback(async (
        requestOptions: StreamRequestOptions = {},
        requestedChannelId = channelId,
        signal?: AbortSignal,
    ) => {
        const isNorthlive = requestedChannelId.startsWith('northlive');
        const isMatch = requestedChannelId.startsWith('match');
        const isVavoo = requestedChannelId.startsWith('vavoo');

        if (isExtensionAvailable() && !isNorthlive && !isMatch && !isVavoo) {
            const srcKey = requestedChannelId.split('_')[0] as LiveTvSourceKey;
            if (!isLiveTvSourceEnabled(srcKey)) {
                const disabledError = new Error(t('liveTV.sourceDisabledByUser', { source: srcKey })) as Error & { isDisabledByUser?: boolean };
                disabledError.isDisabledByUser = true;
                throw disabledError;
            }
            return await fetchFromExtension('GET_STREAM', {
                type: 'tv',
                id: requestedChannelId,
                sourceIndex: requestOptions.sourceIndex
            });
        }

        const requestUrl = new URL(`${API_BASE}/api/livetv/stream/tv/${requestedChannelId}`);
        if (Number.isInteger(requestOptions.sourceIndex) && requestOptions.sourceIndex! >= 0) {
            requestUrl.searchParams.set('sourceIndex', String(requestOptions.sourceIndex));
        }

        const response = await fetch(requestUrl.toString(), {
            headers: { ...getVipHeaders() },
            signal,
        });

        if (!response.ok) {
            const httpError = new Error(t('liveTV.cannotFetchStreams')) as Error & { status?: number };
            httpError.status = response.status;
            throw httpError;
        }

        return await response.json();
    }, [API_BASE, channelId, t]);

    const loadResolvedStreams = useCallback(async (
        requestOptions: StreamRequestOptions = {},
        signal?: AbortSignal,
    ) => {
        setIsLoading(true);
        setError(null);

        try {
            let loaded = false;

            if (channelId.startsWith('vavoo') && vavooVariants?.length) {
                const resolutionOwner = Symbol('vavoo-resolution');
                vavooResolutionOwnerRef.current = resolutionOwner;
                vavooResolutionPendingRef.current = true;
                setIsVavooResolving(true);
                let rawStreams: Stream[] = [];

                try {
                    rawStreams = await resolveVavooVariantStreams<Stream>(
                        vavooVariants,
                        (variantId, variantSignal) => fetchChannelPayload(requestOptions, variantId, variantSignal),
                        {
                            server: t('liveTV.server'),
                            standard: t('liveTV.vavooStandardQuality'),
                        },
                        {
                            onStreamsResolved: (resolvedStreams) => {
                                if (
                                    signal?.aborted
                                    || vavooResolutionOwnerRef.current !== resolutionOwner
                                ) return;
                                const validStreams = resolvedStreams.filter((stream) => (
                                    stream.url && !hasNonStandardPort(stream.url)
                                ));
                                if (validStreams.length === 0) return;

                                const currentStreams = streamsRef.current;
                                const knownStreams = new Set(currentStreams.map((stream) => (
                                    `${stream._vavooVariantId || ''}|${stream.url}`
                                )));
                                const additions = validStreams.filter((stream) => {
                                    const key = `${stream._vavooVariantId || ''}|${stream.url}`;
                                    if (knownStreams.has(key)) return false;
                                    knownStreams.add(key);
                                    return true;
                                });
                                if (additions.length === 0) return;

                                const nextStreams = [...currentStreams, ...additions];
                                streamsRef.current = nextStreams;
                                setStreams(nextStreams);
                            },
                            signal,
                            timeoutMs: VAVOO_VARIANT_TIMEOUT_MS,
                        },
                    );
                } finally {
                    if (vavooResolutionOwnerRef.current === resolutionOwner) {
                        vavooResolutionOwnerRef.current = null;
                        vavooResolutionPendingRef.current = false;
                        if (!signal?.aborted) setIsVavooResolving(false);
                    }
                }
                if (signal?.aborted) return;
                const validStreams = rawStreams.filter((stream) => (
                    stream.url && !hasNonStandardPort(stream.url)
                ));

                if (validStreams.length === 0) {
                    const emptyStreamsError = new Error(t('liveTV.noStreamsAvailable')) as Error & { isEmptyStreams?: boolean };
                    emptyStreamsError.isEmptyStreams = true;
                    throw emptyStreamsError;
                }

                loaded = true;
            }

            // Un 404 sur une chaîne veut souvent dire « le flux n'est pas
            // encore publié » — d'où les tentatives espacées. Sur un match
            // c'est autre chose : le backend vient d'interroger l'amont et
            // n'a trouvé aucun serveur. Insister n'apporte rien, on abrège.
            const maxAttempts = channelId.startsWith('match_') ? 3 : MAX_404_RETRIES;

            for (let attempt = 0; attempt < maxAttempts && !loaded; attempt++) {
                try {
                    const data = await fetchChannelPayload(requestOptions, channelId, signal);
                    const rawStreams = await resolveFctvStubs(data.streams || []);
                    if (signal?.aborted) return;
                    const validStreams = rawStreams.filter((stream: Stream) =>
                        stream.url && !hasNonStandardPort(stream.url)
                    );

                    if (validStreams.length === 0) {
                        const emptyStreamsError = new Error(t('liveTV.noStreamsAvailable')) as Error & { isEmptyStreams?: boolean };
                        emptyStreamsError.isEmptyStreams = true;
                        throw emptyStreamsError;
                    }

                    setStreams(validStreams);
                    setCurrentStreamIndex(0);
                    loaded = true;
                } catch (innerErr: any) {
                    if (signal?.aborted) return;

                    const status = innerErr?.status || innerErr?.response?.status;
                    const is404 = status === 404 || String(innerErr?.message || '').includes('(404)');
                    const isEmptyStreams = !!innerErr?.isEmptyStreams;
                    const is458 = status === 458;
                    // Tout le reste — 401, 403, 5xx, source désactivée — est
                    // définitif : on remonte l'erreur sans réessayer.
                    const isRetryable = is404 || isEmptyStreams || is458;

                    if (isRetryable && attempt < maxAttempts - 1) {
                        const delayMs = is458 ? RETRY_458_INTERVAL_MS : RETRY_INTERVAL_MS;
                        console.warn(`[LiveTV] Flux indisponible (${status || 'vide'}), retry ${attempt + 1}/${maxAttempts} dans ${delayMs}ms`);
                        await wait(delayMs);
                        continue;
                    }

                    throw innerErr;
                }
            }

            if (!loaded) {
                throw new Error(t('liveTV.cannotFetchStreams'));
            }
        } catch (err) {
            if (signal?.aborted) return;
            console.error('Error fetching streams:', err);
            setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
        } finally {
            if (!signal?.aborted) setIsLoading(false);
        }
    }, [MAX_404_RETRIES, RETRY_458_INTERVAL_MS, RETRY_INTERVAL_MS, channelId, fetchChannelPayload, t, vavooVariants]);

    // Fetch streams for the channel (utilise notre backend qui résout les URLs)
    useEffect(() => {
        const streamLoadController = new AbortController();
        const cancelStreamLoad = () => {
            vavooResolutionOwnerRef.current = null;
            vavooResolutionPendingRef.current = false;
            waitingForVavooStreamRef.current = null;
            streamLoadController.abort();
        };
        vavooResolutionOwnerRef.current = null;
        vavooResolutionPendingRef.current = false;
        waitingForVavooStreamRef.current = null;
        streamsRef.current = [];
        setStreams([]);
        setCurrentStreamIndex(0);
        setIsVavooResolving(false);
        setShowSettings(false);
        setIsPlaying(false);
        resetPauseState();
        currentCastUrlRef.current = null;

        void loadResolvedStreams({}, streamLoadController.signal);
        return cancelStreamLoad;

        const fetchStreams = async () => {
            setIsLoading(true);
            setError(null);

            try {
                // Utilise notre API backend qui résout automatiquement les URLs m3u8
                let data: any;
                let loaded = false;

                // northlive et Matches doivent toujours passer par l'API locale, même si l'extension est présente
                const isNorthlive = channelId.startsWith('northlive');
                const isMatch = channelId.startsWith('match');

                for (let attempt = 0; attempt < MAX_404_RETRIES && !loaded; attempt++) {
                    try {
                        if (isExtensionAvailable() && !isNorthlive && !isMatch) {
                            const srcKey2 = channelId.split('_')[0] as LiveTvSourceKey;
                            if (!isLiveTvSourceEnabled(srcKey2)) {
                                const disabledError = new Error(t('liveTV.sourceDisabledByUser', { source: srcKey2 })) as Error & { isDisabledByUser?: boolean };
                                disabledError.isDisabledByUser = true;
                                throw disabledError;
                            }
                            data = await fetchFromExtension('GET_STREAM', { type: 'tv', id: channelId });
                        } else {
                            const response = await fetch(`${API_BASE}/api/livetv/stream/tv/${channelId}`, {
                                headers: { ...getVipHeaders() }
                            });

                            if (!response.ok) {
                                const httpError = new Error(t('liveTV.cannotFetchStreams')) as Error & { status?: number };
                                httpError.status = response.status;
                                throw httpError;
                            }

                            data = await response.json();
                        }

                        // Streams are already pre-parsed by the backend (each source is a separate stream entry)
                        const rawStreams = await resolveFctvStubs(data.streams || []);
                        const validStreams = rawStreams.filter((stream: Stream) =>
                            stream.url && !hasNonStandardPort(stream.url)
                        );

                        if (validStreams.length === 0) {
                            const emptyStreamsError = new Error(t('liveTV.noStreamsAvailable')) as Error & { isEmptyStreams?: boolean };
                            emptyStreamsError.isEmptyStreams = true;
                            throw emptyStreamsError;
                        }

                        setStreams(validStreams);
                        setCurrentStreamIndex(0);
                        loaded = true;
                    } catch (innerErr: any) {
                        const status = innerErr?.status || innerErr?.response?.status;
                        const is404 = status === 404 || String(innerErr?.message || '').includes('(404)');
                        const isEmptyStreams = !!innerErr?.isEmptyStreams;

                        const is458 = status === 458;

                        if ((is404 || isEmptyStreams || is458) && attempt < MAX_404_RETRIES - 1) {
                            const delayMs = is458 ? RETRY_458_INTERVAL_MS : RETRY_INTERVAL_MS;
                            console.warn(`[LiveTV] Flux indisponible (${status || 'vide'}), retry ${attempt + 1}/${MAX_404_RETRIES} dans ${delayMs}ms`);
                            await wait(delayMs);
                            continue;
                        }

                        throw innerErr;
                    }
                }

                if (!loaded) {
                    throw new Error(t('liveTV.cannotFetchStreams'));
                }
            } catch (err) {
                console.error('Error fetching streams:', err);
                setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
            } finally {
                // Only stop loading here if we haven't already finished via cache
                setIsLoading(false);
            }
        };

        fetchStreams();
    }, [channelId, loadResolvedStreams, resetPauseState]);

    // Reset proxy when changing channel or stream
    useEffect(() => {
        setUseProxy(false);
    }, [channelId, currentStreamIndex]);

    const tryNextOrWaitForVavoo = useCallback((errorMessage: string): boolean => {
        const action = getVavooFallbackAction(
            currentStreamIndex,
            streamsRef.current.length,
            vavooResolutionPendingRef.current,
        );

        if (action === 'next') {
            waitingForVavooStreamRef.current = null;
            setError(null);
            setCurrentStreamIndex((previousIndex) => previousIndex + 1);
            return true;
        }
        if (action === 'wait') {
            waitingForVavooStreamRef.current = { errorMessage };
            setError(null);
            setIsLoading(true);
            return true;
        }
        return false;
    }, [currentStreamIndex]);

    useEffect(() => {
        const waitingFailure = waitingForVavooStreamRef.current;
        if (!waitingFailure) return;

        const action = getVavooFallbackAction(
            currentStreamIndex,
            streams.length,
            isVavooResolving,
        );
        if (action === 'next') {
            waitingForVavooStreamRef.current = null;
            setError(null);
            setCurrentStreamIndex((previousIndex) => previousIndex + 1);
        } else if (action === 'error') {
            waitingForVavooStreamRef.current = null;
            setError(waitingFailure.errorMessage);
            setIsLoading(false);
        }
    }, [currentStreamIndex, isVavooResolving, streams.length]);

    const playbackStream = streams[currentStreamIndex];

    // Déclaré ici, et pas au plus près du rendu : plusieurs effets plus bas
    // lisent `isEmbedStream` dans leur tableau de dépendances, évalué pendant
    // le rendu. Une déclaration tardive plaçait donc l'accès dans la zone
    // morte temporelle du `const` (ReferenceError au montage du lecteur).
    const activeStream = streams[currentStreamIndex];
    const hasActiveStream = !!activeStream;
    const isEmbedStream = !!activeStream?._isEmbed;
    const activeEmbedUrl = activeStream?.originalUrl || activeStream?.url || '';

    // Initialize Player (HLS or DASH)
    useEffect(() => {
        const currentStream = playbackStream;
        const streamUrl = currentStream?.url;

        if (!streamUrl) return;

        // If it's an embed, we don't need to initialize HLS/Dash/MPEGTS players
        if (currentStream._isEmbed) {
            currentCastUrlRef.current = currentStream.originalUrl || streamUrl;
            setIsLoading(false);
            setIsPlaying(true);
            resetPauseState();
            return;
        }

        if (!videoRef.current) return;
        const video = videoRef.current;

        clearHlsRecoveryTimeout();
        hlsRecoveryInFlightRef.current = false;
        bufferAppendRetryRef.current = 0;
        resetPauseState();

        // Cleanup previous instances
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
        if (dashRef.current) {
            dashRef.current.reset();
            dashRef.current = null;
        }
        if (mpegtsRef.current) {
            try {
                mpegtsRef.current.destroy();
            } catch (e) { console.error(e) }
            mpegtsRef.current = null;
        }

        setIsLoading(true);
        setShowControls(true);

        let cancelled = false;
        const isDash = streamUrl.endsWith('.mpd');

        // Check if we should force proxy (e.g. for HTTP streams or specific providers)
        const isFamilyRestream = streamUrl.includes('familyrestream.com');
        const isTF1Stream = streamUrl.includes('151.80.18.177');
        const isHttp = streamUrl.startsWith('http://');
        if (!streamUrl) return;

        // Direct-play streams (Vavoo source): play the raw URL as-is, never proxy
        // or route through the extension, even if the URL matches a proxy heuristic.
        const forceDirect = currentStream._directPlay === true;

        // Vavoo streams typically contain "sunshine" signature or require headers that need proxy (when no extension)
        const isVavooStream = !forceDirect && (streamUrl.includes('/sunshine/') ||
            currentStream.behaviorHints?.notWebReady === true);

        // Check if this is a Wiflix stream (has originalUrl from backend, or lansdrud.space/livetvde.net domain)
        const isWiflixStream = !!currentStream.originalUrl || streamUrl.includes('lansdrud.space') || streamUrl.includes('livetvde.net');

        // Check if URL is already proxied (to prevent double-proxying)
        const isAlreadyProxied = streamUrl.includes('proxiesembed') || streamUrl.includes('/proxy?url=');

        const extensionAvailable = isExtensionAvailable();
        const effectiveExtensionAvailable = extensionAvailable;

        const isPageHttps = window.location.protocol === 'https:';

        // Determine if extension will handle this stream (via Blob proxy)
        // Wiflix streams with extension should use originalUrl (unproxied) + ExtensionLoader
        const extensionHandlesStream = !forceDirect && effectiveExtensionAvailable && (isHttp || isVavooStream || isWiflixStream);

        // Force REMOTE proxy (proxiesembed) ONLY if:
        // 1. FamilyRestream/TF1 (always use remote proxy for these)
        // 2. User explicitly enabled proxy
        // 3. HTTP stream on HTTPS page AND extension NOT available (fallback to remote proxy)
        // 4. Vavoo stream AND extension NOT available (fallback to remote proxy for headers)
        // NOTE: If extension handles it, we DON'T need remote proxy.
        // NOTE: Wiflix streams are already proxied by the backend, don't double-proxy!
        // NOTE: If URL is already proxied, don't add another layer!

        const shouldForceProxy =
            !forceDirect && !isAlreadyProxied && !isWiflixStream && (
                isFamilyRestream ||
                isTF1Stream ||
                useProxy ||
                ((isHttp && isPageHttps) && !effectiveExtensionAvailable) ||
                (isVavooStream && !effectiveExtensionAvailable)
            );

        console.log("Proxy Logic:", {
            streamUrl,
            isVavooStream,
            isWiflixStream,
            isAlreadyProxied,
            isHttp,
            extensionAvailable,
            effectiveExtensionAvailable,
            extensionHandlesStream,
            shouldForceProxy
        });

        // URL proxifiée signée fournie d'office par mainapi avec le flux. Le
        // navigateur ne sait pas signer et il n'existe pas d'endpoint pour le
        // faire à sa place (ce serait un oracle de signature) : si le serveur
        // n'en a pas joint, la lecture reste directe.
        const signedProxyUrl = typeof currentStream.proxyUrl === 'string' ? currentStream.proxyUrl : '';

        // Construct final URL
        let finalUrl = mergeHeadersIntoProxyUrl(streamUrl, buildProxyHeadersForStream(currentStream, isVavooStream));

        // For Wiflix streams with extension: use originalUrl (raw m3u8) instead of proxied URL
        if (isWiflixStream && extensionAvailable && currentStream.originalUrl) {
            finalUrl = currentStream.originalUrl;
            console.log("Wiflix: Extension will handle raw stream:", finalUrl);
        } else if (shouldForceProxy && !extensionHandlesStream && signedProxyUrl) {
            // Only use remote proxy if extension is NOT handling it.
            // L'URL signée est utilisée telle quelle : la reconstruire côté
            // client produirait une URL non signée, donc refusée par le proxy.
            ProxyLoader._manifestUrl = signedProxyUrl;
            ProxyLoader._forceLevelReloads = false;

            finalUrl = signedProxyUrl;
            console.log("Using Remote Proxy (proxiesembed, signé):", finalUrl);
        } else if (extensionHandlesStream) {
            // Extension handles it - use raw URL (ExtensionLoader will fetch via blob)
            console.log("Extension will handle stream (Blob Proxy):", finalUrl);
        } else if (isAlreadyProxied) {
            // URL already proxied by backend/local proxy
            // Keep top-level manifest requests anchored on the original proxied URL.
            // Child playlists must keep the rewritten proxied URL returned by the proxy.
            ProxyLoader._manifestUrl = finalUrl; // Store the full proxy URL as-is, with merged headers if needed
            ProxyLoader._forceLevelReloads = false;
            console.log("Already proxied, manifest requests will stay on:", finalUrl);
        }

        // Keep cast URL aligned with the URL effectively used by the current server in the player.
        currentCastUrlRef.current = finalUrl;

        // Determine if this is an MPEG-TS stream (either direct or via proxy for known TS providers)
        // If it's proxied FamilyRestream, it will be served as MPEG-TS
        const isMpegTs = isFamilyRestream || 
                         finalUrl.endsWith('.ts') || 
                         (useProxy && finalUrl.includes('familyrestream.com'));

        console.log('Player selection:', { isMpegTs, isDash, finalUrl });

        // Lazy-load only the player lib actually needed for this stream type.
        (async () => {
        if (isMpegTs) {
            const mpegts = await loadMpegts();
            if (cancelled) return;
            if (mpegts.isSupported()) {
            console.log('Initializing MPEG-TS player for:', finalUrl);
            const player = mpegts.createPlayer({
                type: 'mpegts',  // could also be 'mse' type if content type is correct, but 'mpegts' is specific
                isLive: true,
                url: finalUrl,
                cors: true, // Important for proxy
            }, {
                enableWorker: true,
                lazyLoadMaxDuration: 3 * 60,
                seekType: 'range',
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 20,
                liveBufferLatencyMinRemain: 1.0,
                stashInitialSize: 1024 * 1024, // 1MB stash
            });

            mpegtsRef.current = player;
            player.attachMediaElement(video);
            player.load();
            try {
                player.play();
            } catch (e) {
                console.error('MPEG-TS Play Error:', e);
            }

            player.on(mpegts.Events.ERROR, (type: any, details: any) => {
                console.error('MPEG-TS Error', type, details);
                // Fallback logic could go here
                if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
                    setError(t('liveTV.networkErrorMpegTs'));
                    setIsLoading(false);
                } else if (type === mpegts.ErrorTypes.MEDIA_ERROR && details === 'MediaMSEError') {
                    // Specific handling for HEVC/Codec errors
                    setError(t('liveTV.codecNotSupported'));
                    setIsLoading(false);
                }
            });

            // Loading handling
            video.addEventListener('playing', () => setIsLoading(false), { once: true });
            }

        } else if (isDash) {
            const dashjs = await loadDashjs();
            if (cancelled) return;
            const { MediaPlayer } = dashjs;
            // Initialize Dash Player
            const player = MediaPlayer().create();
            dashRef.current = player;
            player.initialize(video, finalUrl, true);

            // Allow playing DASH in HTTP context if needed
            player.getProtectionController().setRobustnessLevel('SW_SECURE_CRYPTO');

            player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
                setIsLoading(false);
                video.play().catch(console.error);
            });

            player.on(MediaPlayer.events.ERROR, (e: any) => {
                console.error('DASH Error:', e);

                if (!tryNextOrWaitForVavoo(t('liveTV.playbackError'))) {
                    setError(t('liveTV.playbackError'));
                    setIsLoading(false);
                }
            });

        } else {
            const Hls = await loadHls();
            if (cancelled) return;
            if (Hls.isSupported()) {
            // Initialize HLS Player
            const hlsConfig: any = {
                enableWorker: true,
                lowLatencyMode: isLowLatencyEnabled('livetv'), // opt-in via Settings › Performance
                startPosition: -1, // Start at live edge instead of beginning
                backBufferLength: 30,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveDurationInfinity: true,
                liveBackBufferLength: 30,
                // Live sync: stay close to live edge
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 6,
                // Optimizations for unstable streams
                manifestLoadingTimeOut: 15000,
                manifestLoadingMaxRetry: Infinity,
                manifestLoadingRetryDelay: 500,
                manifestLoadingMaxRetryTimeout: 10000,
                levelLoadingTimeOut: 15000,
                levelLoadingMaxRetry: Infinity,
                levelLoadingRetryDelay: 500,
                levelLoadingMaxRetryTimeout: 10000,
                fragLoadingTimeOut: 20000,
                fragLoadingMaxRetry: Infinity,
                fragLoadingRetryDelay: 500,
                fragLoadingMaxRetryTimeout: 15000,
                // Auto-recover from stalls
                nudgeMaxRetry: 5,
                nudgeOffset: 0.2,
            };

            // Use ExtensionLoader for HTTP streams, Vavoo streams, or Wiflix streams when extension is available
            // This routes ALL network requests through the extension (blob proxy)
            const useExtensionLoader = !forceDirect && effectiveExtensionAvailable && (isHttp || isVavooStream || isWiflixStream);
            if (useExtensionLoader) {
                hlsConfig.loader = ExtensionLoader;
                console.log("HLS: Using ExtensionLoader (Blob Proxy) for HTTP/Vavoo/Wiflix stream");
            } else if ((shouldForceProxy && !extensionHandlesStream) || (isAlreadyProxied && streamUrl.includes('proxiesembed'))) {
                // Keep the top-level manifest on the proxy URL without overriding child playlist URLs.
                hlsConfig.loader = ProxyLoader;
                console.log("HLS: Using ProxyLoader (keep manifest requests on proxy URL)");
            } else {
                console.log("HLS: Using default loader");
            }

            const hls = new Hls(hlsConfig);

            hlsRef.current = hls;

            hls.loadSource(finalUrl);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                hls404RetryRef.current = 0;
                hls458RetryRef.current = 0;
                bufferAppendRetryRef.current = 0;
                levelParsingRetryRef.current = 0;
                hlsRecoveryInFlightRef.current = false;
                ProxyLoader._forceLevelReloads = hls.levels.length === 1 && !hls.audioTracks?.length;
                setIsLoading(false);
                resetPauseState();
                video.play().catch(console.error);
            });

            hls.on(Hls.Events.LEVEL_LOADED, (_, levelData) => {
                hls404RetryRef.current = 0;
                hls458RetryRef.current = 0;
                levelParsingRetryRef.current = 0;
                hlsRecoveryInFlightRef.current = false;
                ProxyLoader._forceLevelReloads =
                    hls.levels.length === 1 &&
                    !hls.audioTracks?.length &&
                    !!levelData?.details?.live;
            });

            hls.on(Hls.Events.ERROR, (_, data) => {
                console.error('HLS Error:', data);

                const status = data.response?.code;
                const details = String(data.details || '');
                const reason = String(data.reason || '').toLowerCase();
                const isLikelyEmpty200 =
                    status === 200 && (
                        details === 'manifestParsingError' ||
                        details === 'levelEmptyError' ||
                        reason.includes('empty') ||
                        reason.includes('no exten')
                    );

                // Auto-recover from buffer stalls (most common cause of "frozen after 1 min")
                if (details === 'bufferStalledError') {
                    console.log('[HLS] Buffer stalled, seeking to live sync position...');
                    if (seekToLiveEdge(hls, video) && video) {
                        resetPauseState();
                        video.play().catch(() => { });
                    } else {
                        try {
                            hls.startLoad(-1, true);
                        } catch (err) {
                            console.error('[HLS] Failed to restart load after buffer stall:', err);
                        }
                    }
                    return;
                }

                // Codec not supported (e.g. HEVC/H.265 on Firefox) — no recovery possible
                // Must be checked BEFORE generic fatal media error handler
                if (details === 'bufferAddCodecError') {
                    const codec = (data as any).mimeType || 'unknown';
                    console.error(`[HLS] Codec not supported by browser: ${codec}`);
                    hls.destroy();
                    hlsRef.current = null;
                    if (tryNextOrWaitForVavoo(t('liveTV.codecNotSupported'))) {
                        console.log('[HLS] Trying next server...');
                    } else {
                        setError(t('liveTV.codecNotSupported'));
                        setIsLoading(false);
                    }
                    return;
                }

                // Auto-recover from media errors (decode errors, buffer gaps)
                // Skip if it's a bufferAppendError (handled separately below)
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.fatal && details !== 'bufferAppendError') {
                    if (hlsRecoveryInFlightRef.current) {
                        console.log('[HLS] Fatal media error ignored because a recovery is already in flight');
                        return;
                    }

                    console.log('[HLS] Fatal media error, attempting recoverMediaError...');
                    hlsRecoveryInFlightRef.current = true;
                    setIsLoading(true);
                    resetPauseState();
                    setTimeout(() => {
                        if (hlsRef.current !== hls) {
                            hlsRecoveryInFlightRef.current = false;
                            return;
                        }

                        try {
                            hls.recoverMediaError();
                            hlsRecoveryInFlightRef.current = false;
                        } catch (err) {
                            hlsRecoveryInFlightRef.current = false;
                            console.error('[HLS] recoverMediaError failed:', err);
                            scheduleHlsReinit(hls, 'fatal media error');
                        }
                    }, 0);
                    return;
                }

                // Refus d'accès : réessayer ne sert à rien, ni maintenant ni
                // dans dix secondes. On passe au serveur suivant, ou on rend
                // la main. Sans ce cas, un 403 non fatal ne correspondait à
                // aucune branche et HLS.js repartait en boucle silencieuse.
                if (status === 401 || status === 403) {
                    console.warn(`[LiveTV] Accès refusé (${status}), abandon de ce serveur`);
                    hls.destroy();
                    hlsRef.current = null;
                    if (!tryNextOrWaitForVavoo(t('liveTV.playbackError'))) {
                        setError(t('liveTV.playbackError'));
                        setIsLoading(false);
                    }
                    return;
                }

                // 458 = proxy rate-limit/transitoire — retry agressif au chargement initial
                if (status === 458) {
                    if (hls458RetryRef.current < MAX_458_RETRIES) {
                        hls458RetryRef.current += 1;
                        const attempt = hls458RetryRef.current;
                        console.warn(`[LiveTV] 458 rate-limit, retry ${attempt}/${MAX_458_RETRIES} dans ${RETRY_458_INTERVAL_MS}ms`);
                        setTimeout(() => {
                            if (hlsRef.current !== hls) return;
                            try {
                                // Toutes les 10 tentatives, faire un full reinit du player
                                if (attempt % 10 === 0) {
                                    console.log(`[LiveTV] 458 reinit complète (tentative ${attempt})`);
                                    hls.destroy();
                                    hlsRef.current = null;
                                    setPlayerReinitKey(k => k + 1);
                                } else {
                                    // loadSource relance le manifest même après une erreur fatale
                                    // (stopLoad/startLoad ne fait rien après fatal)
                                    hls.loadSource(finalUrl);
                                }
                            } catch (e) {
                                console.error('[LiveTV] 458 retry failed:', e);
                            }
                        }, RETRY_458_INTERVAL_MS);
                        return;
                    }
                    // Budget épuisé. Le compteur n'est PAS remis à zéro : il
                    // l'était, et comme un 458 non fatal ne déclenchait aucune
                    // autre branche, l'erreur suivante repartait d'un budget
                    // neuf — la boucle ne s'arrêtait jamais.
                    console.warn(`[LiveTV] 458 persistant après ${MAX_458_RETRIES} tentatives, abandon de ce serveur`);
                    hls.destroy();
                    hlsRef.current = null;
                    if (!tryNextOrWaitForVavoo(t('liveTV.playbackError'))) {
                        setError(t('liveTV.playbackError'));
                        setIsLoading(false);
                    }
                    return;
                }

                // 404 ou réponse vide — retriable
                if (status === 404 || isLikelyEmpty200) {
                    if (hls404RetryRef.current < MAX_404_RETRIES) {
                        hls404RetryRef.current += 1;
                        const retryDelay = RETRY_INTERVAL_MS;
                        console.warn(`[LiveTV] HLS retry (${status || 'empty'}), ${hls404RetryRef.current}/${MAX_404_RETRIES} dans ${retryDelay}ms`);
                        setTimeout(() => {
                            if (hlsRef.current === hls) {
                                try {
                                    hls.stopLoad();
                                    hls.startLoad(-1);
                                } catch (e) {
                                    console.error('[LiveTV] Retry HLS failed:', e);
                                }
                            }
                        }, retryDelay);
                        return;
                    }
                    // Même raison qu'au-dessus : ne pas réarmer le compteur.
                    console.warn(`[LiveTV] 404 persistant après ${MAX_404_RETRIES} tentatives, abandon de ce serveur`);
                    hls.destroy();
                    hlsRef.current = null;
                    if (!tryNextOrWaitForVavoo(t('liveTV.playbackError'))) {
                        setError(t('liveTV.playbackError'));
                        setIsLoading(false);
                    }
                    return;
                }

                // levelParsingError (media sequence mismatch) — récupérable sur les live streams
                // Le proxy peut retourner un manifeste avec un numéro de séquence décalé
                if (data.details === 'levelParsingError' && data.fatal) {
                    levelParsingRetryRef.current += 1;
                    if (levelParsingRetryRef.current <= 2) {
                        console.log(`[HLS] levelParsingError (media sequence mismatch), live resync ${levelParsingRetryRef.current}/2...`);
                        scheduleHlsLiveResync(hls, 'levelParsingError');
                        return;
                    }
                    if (levelParsingRetryRef.current === 3) {
                        console.log('[HLS] levelParsingError persists after live resyncs, full reinit 1/1...');
                        scheduleHlsReinit(hls, 'levelParsingError');
                        return;
                    }
                    console.log('[HLS] levelParsingError persists after live resync + reinit, giving up');
                    levelParsingRetryRef.current = 0;
                    // Fall through to generic fatal handler
                }

                // bufferAppendError non-fatal (SourceBuffer removed mid-stream)
                if (data.details === 'bufferAppendError' && !data.fatal) {
                    const bufferError = (data.error || data.err) as { name?: string; message?: string } | undefined;
                    const errorName = String(bufferError?.name || '');
                    const errorMessage = String(bufferError?.message || '');
                    const sourceBufferRemoved =
                        errorName === 'HlsJsTrackRemovedError' ||
                        errorMessage.includes('SourceBuffer');

                    bufferAppendRetryRef.current += 1;
                    if (hlsRecoveryInFlightRef.current) {
                        console.log('[HLS] bufferAppendError ignored because a recovery is already in flight');
                        return;
                    }
                    // 3 recoveries failed → full destroy + reinit
                    if (sourceBufferRemoved || bufferAppendRetryRef.current >= 2) {
                        console.log(`[HLS] bufferAppendError -> full reinit (${bufferAppendRetryRef.current}/3)`);
                        scheduleHlsReinit(hls, sourceBufferRemoved ? 'bufferAppendError (track removed)' : 'bufferAppendError');
                        return;
                    }

                    console.log(`[HLS] bufferAppendError recovery attempt ${bufferAppendRetryRef.current}/3`);
                    hlsRecoveryInFlightRef.current = true;
                    setIsLoading(true);
                    resetPauseState();
                    setTimeout(() => {
                        if (hlsRef.current !== hls) {
                            hlsRecoveryInFlightRef.current = false;
                            return;
                        }

                        try {
                            hls.recoverMediaError();
                            hlsRecoveryInFlightRef.current = false;
                        } catch (err) {
                            hlsRecoveryInFlightRef.current = false;
                            console.error('[HLS] bufferAppendError recovery failed:', err);
                            scheduleHlsReinit(hls, 'bufferAppendError recover failure');
                        }
                    }, 0);
                    return;
                }

                // Détecter les erreurs de codec/buffer (navigateur non supporté ou accélération GPU désactivée)
                if (data.details === 'bufferAddCodecError' || (data.details === 'bufferAppendError' && data.fatal)) {
                    hls.destroy();
                    hlsRef.current = null;
                    if (!tryNextOrWaitForVavoo(t('liveTV.codecNotSupportedFull'))) {
                        setError(t('liveTV.codecNotSupportedFull'));
                        setIsLoading(false);
                    }
                    return;
                }

                // Non-fatal fragment loading errors: just let HLS.js retry, no action needed
                if (!data.fatal && (details === 'fragLoadError' || details === 'fragLoadTimeOut')) {
                    console.log('[HLS] Non-fatal frag error, HLS.js will auto-retry');
                    return;
                }

                if (data.fatal) {
                    hls.destroy();
                    hlsRef.current = null;
                    if (!tryNextOrWaitForVavoo(t('liveTV.playbackError'))) {
                        setError(t('liveTV.playbackError'));
                        setIsLoading(false);
                    }
                }
            });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari native HLS
                video.src = finalUrl;
                video.addEventListener('loadedmetadata', () => {
                    setIsLoading(false);
                    video.play().catch(console.error);
                });
            }
        }
        })();

        return () => {
            cancelled = true;
            // Reset watchdog state on stream change
            stallCountRef.current = 0;
            lastTimeRef.current = 0;
            clearHlsRecoveryTimeout();
            hlsRecoveryInFlightRef.current = false;

            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
            if (dashRef.current) {
                dashRef.current = null;
            }
            if (mpegtsRef.current) {
                try {
                    mpegtsRef.current.destroy();
                } catch (e) { console.error(e) }
                mpegtsRef.current = null;
            }

            resetVideoElement();
        };
    }, [channelId, clearHlsRecoveryTimeout, currentStreamIndex, playbackStream, playerReinitKey, resetPauseState, resetVideoElement, scheduleHlsLiveResync, scheduleHlsReinit, seekToLiveEdge, t, tryNextOrWaitForVavoo, useProxy]);

    // Video event handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handlePlay = () => {
            setIsPlaying(true);
            resetPauseState();
        };
        const handlePause = () => {
            setIsPlaying(false);
            setIsUserPaused(userPausedRef.current);
        };

        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);

        return () => {
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
        };
    }, [resetPauseState]);

    // Stall detection & auto-recovery watchdog
    useEffect(() => {
        const video = videoRef.current;
        if (!video || streams.length === 0) return;
        const currentStream = streams[currentStreamIndex];
        if (currentStream?._isEmbed) return;

        stallCountRef.current = 0;
        lastTimeRef.current = 0;

        // Attempt to recover playback when stalled
        const recoverPlayback = () => {
            if (!video) return;
            const hls = hlsRef.current;
            resetPauseState();

            // Strategy 1: If HLS, seek to live edge
            if (hls) {
                const targetLivePosition = getLiveResyncPosition(hls, video);
                if (typeof targetLivePosition === 'number' && Number.isFinite(targetLivePosition) && targetLivePosition > 0) {
                    console.log('[Watchdog] Seeking to live edge:', targetLivePosition);
                    video.currentTime = targetLivePosition;
                    video.play().catch(() => { });
                    return;
                }

                // Strategy 2: Stop and restart HLS loading
                console.log('[Watchdog] Restarting HLS load');
                try {
                    hls.stopLoad();
                    hls.startLoad(-1, true);
                    video.play().catch(() => { });
                } catch (e) {
                    console.error('[Watchdog] HLS restart failed:', e);
                }
                return;
            }

            // For mpegts or dash: just try to play
            video.play().catch(() => {});
        };

        // Handle video 'waiting' event (buffer underrun)
        const handleWaiting = () => {
            console.log('[LiveTV] Video waiting (buffering)...');
            setIsLoading(true);
        };

        // Handle video 'stalled' event (no data arriving)
        const handleStalled = () => {
            console.log('[LiveTV] Video stalled (no data)');
            // Give it 5s to recover on its own, then force recovery
            setTimeout(() => {
                if (video.readyState < 3 && !video.paused) {
                    console.log('[LiveTV] Still stalled after 5s, recovering...');
                    recoverPlayback();
                }
            }, 5000);
        };

        // Handle 'playing' event (recover from loading state)
        const handlePlaying = () => {
            setIsLoading(false);
            stallCountRef.current = 0;
        };

        // Handle 'canplay' (ready to play after buffering)
        const handleCanPlay = () => {
            setIsLoading(false);
            if (video.paused && !video.ended && !userPausedRef.current) {
                video.play().catch(() => {});
            }
        };

        video.addEventListener('waiting', handleWaiting);
        video.addEventListener('stalled', handleStalled);
        video.addEventListener('playing', handlePlaying);
        video.addEventListener('canplay', handleCanPlay);

        // Periodic watchdog: check every 5s if playback is actually advancing
        watchdogRef.current = setInterval(() => {
            if (video.paused || video.ended || !isPlaying) return;

            const currentTime = video.currentTime;
            if (lastTimeRef.current > 0 && Math.abs(currentTime - lastTimeRef.current) < 0.1) {
                stallCountRef.current += 1;
                console.warn(`[Watchdog] Playback frozen (${stallCountRef.current}/3), currentTime=${currentTime.toFixed(2)}`);

                if (stallCountRef.current >= 3) {
                    // 15s frozen → force recovery
                    console.log('[Watchdog] Triggering auto-recovery after 15s freeze');
                    stallCountRef.current = 0;
                    recoverPlayback();
                }
            } else {
                stallCountRef.current = 0;
            }
            lastTimeRef.current = currentTime;
        }, 5000);

        // Loading timeout: if still loading after 30s, try recovery
        if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = setTimeout(() => {
            if (isLoading && !error) {
                console.log('[Watchdog] Loading timeout (30s), attempting recovery...');
                recoverPlayback();
            }
        }, 30000);

        return () => {
            video.removeEventListener('waiting', handleWaiting);
            video.removeEventListener('stalled', handleStalled);
            video.removeEventListener('playing', handlePlaying);
            video.removeEventListener('canplay', handleCanPlay);
            if (watchdogRef.current) clearInterval(watchdogRef.current);
            if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
        };
    }, [currentStreamIndex, error, getLiveResyncPosition, isLoading, isPlaying, resetPauseState, streams]);

    // Volume control
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.volume = volume;
        }
        localStorage.setItem('playerVolume', volume.toString());
    }, [volume]);

    // Controls visibility
    const hideControlsTimeout = useCallback(() => {
        clearControlsTimeout();
        if (!isPlaying || showSettings || userPausedRef.current) return;

        const hideDelay = isFullscreen ? 2500 : 3000;
        controlsTimeoutRef.current = setTimeout(() => {
            if (isPlaying && !showSettings && !userPausedRef.current) {
                setShowControls(false);
            }
        }, hideDelay);
    }, [clearControlsTimeout, isFullscreen, isPlaying, showSettings]);

    useEffect(() => {
        if (showControls) {
            hideControlsTimeout();
        } else {
            clearControlsTimeout();
        }

        return () => {
            clearControlsTimeout();
        };
    }, [clearControlsTimeout, hideControlsTimeout, isFullscreen, isPlaying, isUserPaused, showControls, showSettings]);

    const handleMouseMove = useCallback((e?: Event | React.MouseEvent | PointerEvent) => {
        if (e && 'pointerType' in e && (e as PointerEvent).pointerType === 'touch') return;
        setShowControls(true);
        hideControlsTimeout();
    }, [hideControlsTimeout]);

    /**
     * Écouteurs natifs de mouvement de pointeur, en doublon des gestionnaires
     * React : sous Firefox/Wayland, les `mousemove` synthétisés ne remontent
     * pas au-dessus des calques du lecteur et l'interface ne se rappelait
     * qu'au clic.
     */
    useEffect(() => {
        if (isEmbedStream) return;
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
    }, [isEmbedStream, handleMouseMove]);

    // Tap on video area to toggle play/pause (essential for mobile)
    const handleVideoClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setShowControls(true);
        if (isLoading) return;
        if (!videoRef.current) return;
        if (videoRef.current.paused) {
            resetPauseState();
            videoRef.current.play().catch(console.error);
            hideControlsTimeout();
        } else {
            setPauseStateFromUserAction(true);
            clearControlsTimeout();
            videoRef.current.pause();
        }
    }, [clearControlsTimeout, hideControlsTimeout, isLoading, resetPauseState, setPauseStateFromUserAction]);

    // Fullscreen handling
    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
            setShowControls(true);
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    const toggleFullscreen = async () => {
        // Fallback pour iPhone (iOS)
        if (videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
            (videoRef.current as any).webkitEnterFullscreen();
            return;
        }

        if (!containerRef.current) return;

        if (!document.fullscreenElement) {
            await containerRef.current.requestFullscreen();
        } else {
            await document.exitFullscreen();
        }
    };

    const togglePlay = (e?: React.MouseEvent | React.TouchEvent) => {
        if (e) {
            e.stopPropagation();
        }

        setShowControls(true);

        if (!videoRef.current) return;
        if (videoRef.current.paused) {
            resetPauseState();
            videoRef.current.play().catch(console.error);
            hideControlsTimeout();
        } else {
            setPauseStateFromUserAction(true);
            clearControlsTimeout();
            videoRef.current.pause();
        }
    };

    const toggleMute = () => {
        if (volume > 0) {
            setVolume(0);
        } else {
            setVolume(1);
        }
    };

    const handleServerChange = (index: number) => {
        setCurrentStreamIndex(index);
        setShowSettings(false);
        setIsLoading(true);
        resetPauseState();
    };

    // Cast handlers
    const handleCast = async () => {
        const selectedStream = streams[currentStreamIndex];
        if (!selectedStream) return;

        // Embed pages (iframe players) can't be loaded by the Default Media
        // Receiver — it only plays direct media URLs. Tell the user instead
        // of sending a text/html contentId that fails silently on the TV.
        if (selectedStream._isEmbed) {
            toast.error(t('watch.someSourcesIncompatible'));
            return;
        }

        // Snapshot selected server at click time so async cast dialog can't drift to another server.
        const castUrl = currentCastUrlRef.current || selectedStream.url;
        const castTitle = selectedStream.title
            ? `${channelName} - ${selectedStream.title}`
            : channelName;

        try {
            const session = await requestCastSession();

            // Live channels must be declared streamType LIVE — BUFFERED makes
            // receivers treat the stream as seekable VOD, which breaks or stalls
            // playback on several Chromecast generations. castUrl already reflects
            // the URL the player is using for the current server.
            const mediaInfo = prepareCastMediaInfo(
                castUrl,
                castTitle,
                channelPoster,
                0,
                'LIVE'
            );
            await loadMediaOnCast(session, mediaInfo);

            setIsCasting(true);
        } catch (err) {
            console.error('Cast error:', err);
            // "cancel" = user closed the device picker — not an error worth surfacing.
            const code = (err as any)?.code;
            if (code !== 'cancel') {
                toast.error(t('watch.castError'));
            }
        }
    };

    const handleAirPlay = async () => {
        const video = videoRef.current;
        if (!video) return;
        try {
            // Picker first, synchronously inside the user gesture (transient
            // activation) — same ordering fix as HLSPlayer.startAirPlay.
            await requestAirPlay(video);

            // When playback runs through hls.js (MSE), the AirPlay target only
            // sees a blob: URL and renders nothing. Swap to Safari-native HLS
            // (same URL the engine was reading, proxied or not) so the device
            // streams the real manifest. mpegts/dash engines have no native
            // equivalent — leave them as-is, the system picker still offers
            // screen mirroring as a fallback.
            const nativeUrl = currentCastUrlRef.current;
            if (hlsRef.current && nativeUrl && isAirPlaySupported()) {
                console.log('[AirPlay] Swapping hls.js (MSE) to native HLS for AirPlay:', nativeUrl);
                hlsRef.current.destroy();
                hlsRef.current = null;
                video.src = nativeUrl;
                video.load();
                video.play().catch(() => { /* autoplay may need the AirPlay connect to settle */ });
            }
        } catch (err) {
            console.error('AirPlay error:', err);
        }
    };

    const clampVolume = (v: number) => Math.max(0, Math.min(1, Math.round(v * 100) / 100));

    // Keyboard shortcuts (e.code, pattern HLSPlayer)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    togglePlay();
                    handleMouseMove();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (videoRef.current) {
                        const newVol = clampVolume(videoRef.current.volume + 0.1);
                        videoRef.current.volume = newVol;
                        setVolume(newVol);
                        localStorage.setItem('playerVolume', newVol.toString());
                    }
                    handleMouseMove();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (videoRef.current) {
                        const newVol = clampVolume(videoRef.current.volume - 0.1);
                        videoRef.current.volume = newVol;
                        setVolume(newVol);
                        localStorage.setItem('playerVolume', newVol.toString());
                    }
                    handleMouseMove();
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
                    } else if (!document.fullscreenElement) {
                        onClose();
                    }
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [volume, onClose, showSettings, handleMouseMove]);

    const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
    const shouldShowPausedOverlay =
        hasActiveStream &&
        isUserPaused &&
        !isLoading &&
        !error &&
        !isEmbedStream;
    const playPauseButtonLabel = isPlaying ? t('watch.pause') : t('watch.play');
    const shouldHideCursor =
        !isEmbedStream &&
        isFullscreen &&
        isPlaying &&
        !showControls &&
        !showSettings &&
        !isUserPaused &&
        !isLoading &&
        !error;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={`fixed inset-0 z-[12000] flex items-center justify-center bg-black ${shouldHideCursor ? 'cursor-none' : ''}`}
            ref={containerRef}
            onPointerMove={isEmbedStream ? undefined : handleMouseMove}
            onMouseMove={isEmbedStream ? undefined : handleMouseMove}
            onClick={isEmbedStream ? undefined : handleMouseMove}
            onMouseLeave={isEmbedStream ? undefined : (() => {
                if (isPlaying && !showSettings && !isUserPaused) {
                    clearControlsTimeout();
                    setShowControls(false);
                }
            })}
        >
            {/* Close button */}
            <AnimatePresence>
                {!isEmbedStream && showControls && (
                    <motion.button
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute top-4 left-4 z-50 p-2 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
                    >
                        <X size={24} />
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Channel name */}
            <AnimatePresence>
                {!isEmbedStream && showControls && (
                    <motion.div
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="absolute top-4 inset-x-0 z-50 flex justify-center pointer-events-none"
                    >
                        <div className="px-4 py-2 bg-black/50 rounded-lg pointer-events-auto">
                            <h2 className="text-lg font-bold text-white whitespace-nowrap">{channelName}</h2>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Video or Iframe */}
            {isEmbedStream ? (
                <>
                    {/* Fullscreen iframe — fills the whole screen on PC and mobile */}
                    <iframe
                        src={activeEmbedUrl}
                        className="absolute inset-0 h-full w-full border-0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                    />

                    {/* Floating control bar overlaid on top of the iframe */}
                    {hasActiveStream && !error && (
                        <div
                            className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-6 sm:px-4"
                            style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
                        >
                            <button
                                onClick={onClose}
                                className="pointer-events-auto flex items-center gap-2 rounded-lg bg-black/50 px-3 py-2 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/70"
                            >
                                <ArrowLeft size={18} />
                                <span className="hidden sm:inline">{t('common.back')}</span>
                            </button>

                            <p className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-white/90">
                                {activeStream?.title || channelName}
                            </p>

                            <div className="pointer-events-auto flex items-center gap-1.5">
                                <button
                                    onClick={() => window.open(activeEmbedUrl, '_blank', 'noopener,noreferrer')}
                                    className="rounded-lg bg-black/50 p-2 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/70"
                                    title={t('watch.openInNewPage')}
                                >
                                    <ExternalLink size={18} />
                                </button>

                                {streams.length > 1 && (
                                    <button
                                        onClick={() => setShowSettings(true)}
                                        className="rounded-lg bg-black/50 p-2 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/70"
                                        title={t('watch.sources')}
                                    >
                                        <Settings size={18} />
                                    </button>
                                )}

                                <button
                                    onClick={() => { void toggleFullscreen(); }}
                                    className="rounded-lg bg-black/50 p-2 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/70"
                                    title={isFullscreen ? t('watchParty.exitFullscreen') : t('watchParty.fullscreen')}
                                >
                                    {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                                </button>
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <video
                    ref={videoRef}
                    className={`w-full h-full object-contain ${shouldHideCursor ? 'cursor-none' : ''}`}
                    poster={channelPoster}
                    playsInline
                    onClick={handleVideoClick}
                />
            )}

            {/* Center play button (large tap target for mobile) */}
            <AnimatePresence>
                {shouldShowPausedOverlay && (
                    <motion.div
                        key="livetv-pause-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 pointer-events-none"
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.88, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.92, y: 14 }}
                            transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                            className="pointer-events-auto flex flex-col items-center gap-3 rounded-[30px] border border-white/15 bg-black/80 px-6 py-5 shadow-2xl"
                        >
                            <div className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-red-300">
                                {t('watch.paused')}
                            </div>
                            <motion.button
                                onClick={(e) => { e.stopPropagation(); togglePlay(e); }}
                                whileHover={{ scale: 1.06 }}
                                whileTap={{ scale: 0.96 }}
                                transition={{ duration: 0.18, ease: 'easeOut' }}
                                className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-black shadow-[0_12px_40px_rgba(255,255,255,0.18)] transition-colors hover:bg-white/90 md:h-20 md:w-20"
                            >
                                <Play size={32} className="ml-1" fill="currentColor" />
                            </motion.button>
                            <p className="text-sm text-white/75">{channelName}</p>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Loading overlay */}
            <AnimatePresence>
                {isLoading && (
                    <motion.div
                        key="livetv-loading-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.92, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 6 }}
                            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                            className="rounded-[26px] border border-white/10 bg-black/80 px-6 py-5 shadow-2xl"
                        >
                            <Loader2 size={48} className="animate-spin text-red-500" />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Error overlay */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        key="livetv-error-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 backdrop-blur-[3px]"
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.94, y: 24 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.97, y: 12 }}
                            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                            className="flex w-full max-w-3xl flex-col items-center gap-4 rounded-3xl border border-white/10 bg-neutral-950/85 px-6 py-7 shadow-2xl"
                        >
                    <p className="text-white text-lg text-center px-4 max-w-lg">{error}</p>
                    <div className="flex gap-4">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg transition-colors"
                        >
                            {t('common.back')}
                        </button>
                        {streams[currentStreamIndex] && (error === t('liveTV.codecNotSupported') || error === t('liveTV.codecNotSupportedFull')) && (
                            <button
                                onClick={() => {
                                    /* Attempt to open in VLC via protocol handler or copy link */
                                    const url = streams[currentStreamIndex].url;
                                    // Try vlc:// protocol for desktops that support it
                                    window.location.href = `vlc://${url}`;

                                    // Also copy to clipboard as fallback
                                    navigator.clipboard.writeText(url).then(() => {
                                        toast.success(t('liveTV.linkCopiedVlc'));
                                    }).catch(() => {
                                        prompt(t('liveTV.copyLinkForVlc'), url);
                                    });
                                }}
                                className="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors flex items-center gap-2"
                            >
                                <Play size={16} /> {t('liveTV.openInVlc')}
                            </button>
                        )}
                    </div>

                    {/* Source Selector in Error Screen */}
                    {streams.length > 1 && (
                        <div className="flex flex-col items-center gap-2 mt-4">
                            <span className="text-gray-400 text-sm">{t('liveTV.changeSource')}</span>
                            <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                                {streams.map((stream, index) => (
                                    <button
                                        key={index}
                                        onClick={() => {
                                            setCurrentStreamIndex(index);
                                            setError(null);
                                            setIsLoading(true);
                                        }}
                                        className={`px-3 py-1 text-sm rounded border transition-colors ${
                                            index === currentStreamIndex 
                                                ? 'bg-red-600 border-red-600 text-white cursor-default' 
                                                : 'border-gray-600 text-gray-300 hover:bg-gray-700 hover:border-gray-500'
                                        }`}
                                    >
                                        {stream.title || `${t('watch.source')} ${index + 1}`}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Bottom gradient */}
            {!isEmbedStream && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: showControls ? 1 : 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                    className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent pointer-events-none"
                />
            )}

            {/* Controls — HLSPlayer pattern */}
            {!isEmbedStream && !error && hasActiveStream && (
                <motion.div
                    className={`absolute bottom-0 left-0 right-0 p-4 z-20 ${showControls ? 'pointer-events-auto' : 'pointer-events-none'}`}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                        opacity: showControls ? 1 : 0,
                        y: showControls ? 0 : 20
                    }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                >
                    <div className="flex items-center justify-between">
                        {/* Left controls */}
                        <div className="flex items-center gap-2">
                            {/* Play/Pause */}
                            {!streams[currentStreamIndex]?._isEmbed && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); togglePlay(e); }}
                                    title={playPauseButtonLabel}
                                    aria-label={playPauseButtonLabel}
                                    className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                                >
                                    <AnimatePresence mode="wait" initial={false}>
                                        <motion.span
                                            key={isPlaying ? 'pause' : 'play'}
                                            initial={{ opacity: 0, scale: 0.7, rotate: isPlaying ? -10 : 10 }}
                                            animate={{ opacity: 1, scale: 1, rotate: 0 }}
                                            exit={{ opacity: 0, scale: 0.7, rotate: isPlaying ? 10 : -10 }}
                                            transition={{ duration: 0.16, ease: 'easeOut' }}
                                            className="flex items-center justify-center"
                                        >
                                            {isPlaying ? <Pause size={24} /> : <Play size={24} className="ml-0.5" />}
                                        </motion.span>
                                    </AnimatePresence>
                                </button>
                            )}

                            {/* LIVE badge — clickable to jump to live */}
                            {!streams[currentStreamIndex]?._isEmbed && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (videoRef.current && hlsRef.current) {
                                            const jumpedToLive = seekToLiveEdge(hlsRef.current, videoRef.current);
                                            if (jumpedToLive) {
                                                videoRef.current.play().catch(() => { });
                                            }
                                        }
                                    }}
                                    className="flex items-center gap-1.5 px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs font-bold transition-colors cursor-pointer text-white"
                                    title={t('liveTV.backToLive')}
                                >
                                    <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                                    {t('liveTV.live')}
                                </button>
                            )}

                            {/* Volume — expanding slider (group/volume pattern) */}
                            {!streams[currentStreamIndex]?._isEmbed && (
                                <div className="relative group flex items-center h-[24px] ml-2">
                                    <div className="flex items-center group/volume h-full">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); toggleMute(); }}
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
                                                    value={volume}
                                                    onChange={(e) => { e.stopPropagation(); setVolume(parseFloat(e.target.value)); }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-full accent-red-600 appearance-none h-1 rounded-full cursor-pointer"
                                                    style={{
                                                        background: `linear-gradient(to right, #dc2626 ${volume * 100}%, rgba(255, 255, 255, 0.2) ${volume * 100}%)`
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right controls */}
                        <div className="flex items-center gap-2">
                            {/* Settings gear (server selector) — only if >1 server */}
                            {streams.length > 1 && (
                                <motion.div
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    transition={{ duration: 0.2, ease: "easeInOut" }}
                                >
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}
                                        className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                                    >
                                        <Settings size={24} className={`transition-transform duration-300 ${showSettings ? 'rotate-180' : ''}`} />
                                    </button>
                                </motion.div>
                            )}

                            {/* Cast button (Chromecast) - Always visible */}
                            <motion.div
                                animate={{ color: isCasting ? '#dc2626' : '#ffffff' }}
                                whileHover={{ scale: 1.1 }}
                                whileTap={{ scale: 0.9 }}
                                transition={{ duration: 0.2, ease: "easeInOut" }}
                            >
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleCast(); }}
                                    className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer"
                                    title={t('liveTV.castToChromecast')}
                                >
                                    <Cast size={24} />
                                </button>
                            </motion.div>

                            {/* AirPlay button */}
                            {airplayState.isAvailable && (
                                <motion.div
                                    animate={{ color: airplayState.isConnected ? '#dc2626' : '#ffffff' }}
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    transition={{ duration: 0.2, ease: "easeInOut" }}
                                >
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleAirPlay(); }}
                                        className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer"
                                        title={t('liveTV.castViaAirplay')}
                                    >
                                        <Airplay size={24} />
                                    </button>
                                </motion.div>
                            )}

                            {/* Fullscreen */}
                            <motion.div
                                whileHover={{ scale: 1.1 }}
                                whileTap={{ scale: 0.9 }}
                                transition={{ duration: 0.2, ease: "easeInOut" }}
                            >
                                <button
                                    onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
                                    className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white"
                                >
                                    {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
                                </button>
                            </motion.div>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Settings panel — slide-in right (server selector) */}
            <AnimatePresence>
                {showSettings && streams.length > 1 && (
                    <motion.div
                        key="settings-panel"
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 280 }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
                        style={{ height: '100%', position: 'absolute', top: 0, right: 0, bottom: 0, maxWidth: '90vw' }}
                        className="bg-black/95 z-[10002] flex flex-col border-l border-gray-800 shadow-xl"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                            <h3 className="text-white text-sm font-medium">
                                {t('liveTV.server')}
                            </h3>
                            <button
                                onClick={() => setShowSettings(false)}
                                className="p-1 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-gray-400 hover:text-white"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Server list */}
                        <div className="flex-1 overflow-y-auto p-2 space-y-4" data-lenis-prevent>
                            {streams.length > 1 && (
                                <div>
                                    <div className="space-y-1">
                            {streams.map((stream, index) => (
                                <button
                                    key={index}
                                    onClick={() => handleServerChange(index)}
                                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer flex items-center gap-2 ${
                                        index === currentStreamIndex ? 'bg-red-600/20 text-red-400' : 'text-gray-300 hover:bg-white/5'
                                    }`}
                                >
                                    {index === currentStreamIndex && (
                                        <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
                                    )}
                                    <span className={index === currentStreamIndex ? '' : 'ml-4'}>{stream.title || `${t('watch.source')} ${index + 1}`}</span>
                                    {index === currentStreamIndex && <span className="ml-auto text-red-400">✓</span>}
                                </button>
                            ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

export default LiveTVPlayer;
