import React, { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import io, { Socket } from 'socket.io-client';
import { Copy, Share2, MessageSquare, Users, X, Send, Clipboard, Check, AlertTriangle, Loader2, Trash2, UserX, Maximize, Minimize, Hand, Clock, CheckCircle2, XCircle, RefreshCw, Settings, Info } from 'lucide-react';
import ChangeMediaModal from '../components/ChangeMediaModal';
import EmojiAutocomplete from '../components/EmojiAutocomplete';
import ReactMarkdown, { type Components } from 'react-markdown';
import { useSafeRemarkGfm } from '../utils/markdownPlugins';
import remarkEmoji from 'remark-emoji';
import { useTranslation } from 'react-i18next';
import HLSPlayer, { HLSPlayerRef } from '../components/HLSPlayer';
import { SocketState, ChatMessage, Participant, PlaybackState, WatchPartyRoom as RoomInfo, getShareLink, ControlRequest, ControlState, PauseTimer, ParticipantSyncStatus, ScheduledPlaybackEvent, SyncMode, SyncProbeResult, getRoomToken, storeRoomToken, clearRoomToken } from '../utils/watchparty';
import { FloatingReactionsContainer, REACTION_EMOJIS, extractReactionEmojis } from '../components/FloatingReaction';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import { WATCHPARTY_API } from '../config/runtime';
import WatchPartySyncInfoModal from '../components/WatchPartySyncInfoModal';
import { CLASSIC_HOST_INTERVAL_MS, LocalPlayerSnapshot, SYNC_PRO_HOST_INTERVAL_MS, WatchPartySyncWorkerOutput } from '../utils/watchpartySync';

const MAIN_API = WATCHPARTY_API;
const getHostPositionUpdateInterval = (mode: SyncMode) =>
  mode === 'pro' ? SYNC_PRO_HOST_INTERVAL_MS : CLASSIC_HOST_INTERVAL_MS;

interface LocationState {
  nickname?: string;
  roomCode?: string;
  token?: string;
}

interface PauseVoteState {
  requestedBy: string;
  requestedByNickname: string;
  requestedDuration: number;
  endTime: number;
  totalParticipants: number;
}

// Memoized HLSPlayer
const MemoizedHLSPlayer = memo(HLSPlayer, (prevProps, nextProps) => {
  // Custom comparison logic
  return (
    prevProps.src === nextProps.src &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.controls === nextProps.controls &&
    // `crossOrigin` se pose au montage de l'élément vidéo : si ce drapeau
    // change sans que `src` bouge, le comparateur figerait l'ancienne valeur et
    // la source qui redirige repartirait en mode CORS.
    prevProps.disableCrossOrigin === nextProps.disableCrossOrigin &&
    (Math.abs((prevProps.initialTime || 0) - (nextProps.initialTime || 0)) < 1.0) // More precise for initialTime
  );
});

// Helper components for loading/error states
const LoadingSpinner: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-screen bg-black flex items-center justify-center">
    <div className="text-white text-center">
      <Loader2 className="w-16 h-16 text-red-600 animate-spin mx-auto mb-4" />
      <p>{message}</p>
    </div>
  </div>
);

const ErrorDisplay: React.FC<{ message: string | null; onRetry?: () => void }> = ({ message, onRetry }) => {
  const { t } = useTranslation();
  return (
  <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-4">
    <div className="bg-white/5 border border-white/10 p-8 rounded-xl shadow-lg max-w-md w-full text-center backdrop-blur-sm">
      <AlertTriangle size={48} className="text-red-500 mx-auto mb-4" />
      <h2 className="text-2xl font-bold mb-4">{t('watchParty.errorTitle')}</h2>
      <p className="mb-6 text-gray-300">{message || t('watchParty.unknownError')}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded-lg font-medium mr-2"
        >
          {t('watchParty.retryBtn')}
        </button>
      )}
      <button
        onClick={() => window.location.href = '/'}
        className="px-6 py-3 bg-white/10 hover:bg-white/20 rounded-lg font-medium"
      >
        {t('common.backToHome')}
      </button>
    </div>
  </div>
  );
};

// Markdown component map for chat messages. Hoisted out of WatchPartyRoom so
// the 16 inline arrow functions aren't recreated on every root re-render
// (which happens on every chat tick / socket event / chat textarea keystroke). — perf
const CHAT_MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-0.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <pre className="bg-black/30 rounded p-1.5 my-1 overflow-x-auto text-xs"><code>{children}</code></pre>
    ) : (
      <code className="bg-white/10 text-red-300 px-1 py-0.5 rounded text-[0.85em] font-mono">{children}</code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  a: ({ href, children }) => {
    // Block javascript: and data: URLs to prevent XSS
    if (href && !/^https?:\/\//i.test(href)) return <span className="text-blue-400">{children}</span>;
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">{children}</a>;
  },
  ul: ({ children }) => <ul className="list-disc list-inside ml-1 my-0.5 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside ml-1 my-0.5 text-sm">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-white/20 pl-2 my-0.5 text-white/50 italic text-sm">{children}</blockquote>,
  del: ({ children }) => <del className="line-through text-white/40">{children}</del>,
  img: () => null,
  h1: ({ children }) => <p className="font-bold text-white">{children}</p>,
  h2: ({ children }) => <p className="font-bold text-white">{children}</p>,
  h3: ({ children }) => <p className="font-bold text-white">{children}</p>,
};

// Per-message renderer hoisted to module scope and memoized so the chat list
// doesn't re-render every existing bubble whenever the parent setStates (which
// happens on every chat tick / playback heartbeat / resize jitter). — perf
interface ChatMessageItemProps {
  message: ChatMessage;
  isOwnMessage: boolean;
  isHostMessage: boolean;
  isMutedSender: boolean;
  isCurrentUserHost: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onToggleMute: (senderId: string) => void;
  onDeleteMessage: (messageId: string) => void;
}

const ChatMessageItem = React.memo<ChatMessageItemProps>(
  ({ message, isOwnMessage, isHostMessage, isMutedSender, isCurrentUserHost, t, onToggleMute, onDeleteMessage }) => {
    const safeRemarkGfm = useSafeRemarkGfm();
    const remarkPlugins = useMemo(
      () => (safeRemarkGfm ? [safeRemarkGfm, remarkEmoji] : [remarkEmoji]),
      [safeRemarkGfm],
    );
    return (
      <div
        className={`flex flex-col ${message.type === 'system'
          ? 'items-center'
          : isOwnMessage ? 'items-end' : 'items-start'
          }`}
      >
        <div
          className={`px-3 py-2 rounded-xl max-w-[85%] relative group ${message.type === 'system'
            ? 'bg-white/5 text-white/50 text-xs text-center border border-white/5'
            : isOwnMessage
              ? 'bg-red-600/80 text-white shadow-lg shadow-red-500/10'
              : 'bg-white/[0.08] text-white/90 border border-white/5'
            }`}
        >
          {/* Moderation controls on hover */}
          {message.type === 'chat' && !isOwnMessage && (
            <div className="absolute -right-1 -top-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
              <button
                onClick={() => onToggleMute(message.senderId)}
                className="p-1 bg-gray-800 rounded-full text-orange-400 hover:text-orange-300 hover:bg-gray-700"
                title={isMutedSender ? t('watchParty.unmute') : t('watchParty.mute')}
              >
                {isMutedSender ? <MessageSquare size={12} /> : <X size={12} />}
              </button>
              {isCurrentUserHost && (
                <button
                  onClick={() => onDeleteMessage(message.id)}
                  className="p-1 bg-gray-800 rounded-full text-red-400 hover:text-red-300 hover:bg-gray-700"
                  title={t('watchParty.deleteMessage')}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}

          {message.type !== 'system' && (
            <div className="flex justify-between items-center mb-0.5">
              <span className={`text-xs font-medium opacity-90 ${isHostMessage ? 'text-yellow-300' : 'text-blue-300'
                }`}>
                {message.senderNickname}
                {isHostMessage && ` ${t('watchParty.hostTag')}`}
              </span>
            </div>
          )}

          <div className={`text-sm break-words ${message.type === 'system' ? 'italic' : ''}`}>
            {message.type === 'system' ? message.text : (
              <ReactMarkdown remarkPlugins={remarkPlugins} components={CHAT_MD_COMPONENTS}>
                {message.text}
              </ReactMarkdown>
            )}
          </div>

          {message.type !== 'system' && (
            <span className="text-[10px] text-white/30 block text-right mt-1">
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.text === next.message.text &&
    prev.message.timestamp === next.message.timestamp &&
    prev.message.type === next.message.type &&
    prev.isOwnMessage === next.isOwnMessage &&
    prev.isHostMessage === next.isHostMessage &&
    prev.isMutedSender === next.isMutedSender &&
    prev.isCurrentUserHost === next.isCurrentUserHost &&
    prev.t === next.t &&
    prev.onToggleMute === next.onToggleMute &&
    prev.onDeleteMessage === next.onDeleteMessage
);
ChatMessageItem.displayName = 'ChatMessageItem';

const WatchPartyRoom: React.FC = () => {
  const { t } = useTranslation();
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as LocationState || {};
  const safeRemarkGfm = useSafeRemarkGfm();
  const previewRemarkPlugins = useMemo(
    () => (safeRemarkGfm ? [safeRemarkGfm, remarkEmoji] : [remarkEmoji]),
    [safeRemarkGfm],
  );

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'watchparty' },
  });

  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [currentMediaSrc, setCurrentMediaSrc] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<SocketState>(SocketState.DISCONNECTED);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  // Debounced mirror of newMessage. Used by the live ReactMarkdown preview so
  // remark/rehype don't re-parse on every keystroke. The textarea itself stays
  // controlled by `newMessage` for instant typing feedback. — perf
  const [debouncedNewMessage, setDebouncedNewMessage] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [masterPlaybackState, setMasterPlaybackState] = useState<PlaybackState | null>(null);
  const [localPlayerVisualState, setLocalPlayerVisualState] = useState<{ isPlaying: boolean; position: number }>({
    isPlaying: false,
    position: 0,
  });
  const [userId, setUserId] = useState<string>('');
  const [isCurrentUserHost, setIsCurrentUserHost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(true);
  const [showParticipantsPanel, setShowParticipantsPanel] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [deletedMessages, setDeletedMessages] = useState<Set<string>>(new Set());
  const [mutedUsers, setMutedUsers] = useState<Set<string>>(new Set());
  const [isPageFullscreen, setIsPageFullscreen] = useState(false);

  // New feature states
  const [controlMode, setControlMode] = useState<'host-only' | 'democratic'>('host-only');
  const [coHosts, setCoHosts] = useState<string[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ControlRequest[]>([]);
  const [pauseTimer, setPauseTimer] = useState<PauseTimer | null>(null);
  const [pauseCountdown, setPauseCountdown] = useState<number>(0);
  const [floatingReactions, setFloatingReactions] = useState<Array<{ id: string; emoji: string }>>([]);
  const [showPauseTimerModal, setShowPauseTimerModal] = useState(false);
  const [showChangeMediaModal, setShowChangeMediaModal] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showSyncInfoModal, setShowSyncInfoModal] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [syncMode, setSyncMode] = useState<SyncMode>('classic');
  const [syncStatus, setSyncStatus] = useState<ParticipantSyncStatus | 'classic' | 'calibrating'>('classic');
  const [chatWidth, setChatWidth] = useState(380);
  const chatWidthRef = useRef(380);
  const resizeRafIdRef = useRef<number | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [hasRequestedControl, setHasRequestedControl] = useState(false);
  const [reactionCooldown, setReactionCooldown] = useState(false);

  // Vote system state
  const [activeVote, setActiveVote] = useState<PauseVoteState | null>(null);
  const [voteProgress, setVoteProgress] = useState<{ yesVotes: number; noVotes: number; totalVotes: number }>({ yesVotes: 0, noVotes: 0, totalVotes: 0 });
  const [hasVoted, setHasVoted] = useState(false);
  const [voteCountdown, setVoteCountdown] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<HLSPlayerRef>(null); // Ref for HLSPlayer imperative handles
  const videoElementForEventRef = useRef<HTMLVideoElement | null>(null); // Separate ref for direct event attachment if needed by HLSPlayer
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastPlaybackEventTimeRef = useRef<number>(0);
  const lastPlaybackEventTypeRef = useRef<string | null>(null);
  const lastSeekSourceTimeRef = useRef<number>(0); // Stores the position *before* a host seek
  const initialFetchDoneRef = useRef(false);
  const continuousSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const attemptReconnectRef = useRef<NodeJS.Timeout | null>(null);
  const lastKnownMainMediaIdentity = useRef<string | null>(null); // Ref to track main media identity
  const isSyncingRef = useRef(false); // Guard contre les boucles de feedback play/pause
  const syncWorkerRef = useRef<Worker | null>(null);
  const syncModeRef = useRef<SyncMode>('classic');
  const masterPlaybackStateRef = useRef<PlaybackState | null>(null);
  const syncProbeSequenceRef = useRef(0);
  const syncProbeTimersRef = useRef<number[]>([]);
  const localSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const canControlPlayback = isCurrentUserHost || coHosts.includes(userId) || controlMode === 'democratic';

  // Memoize bravoSources/mp4Sources so MemoizedHLSPlayer (which receives them
  // as props) gets stable references. Previously these `.filter()` chains ran
  // in the render body of WatchPartyRoom — and every chat message setStates
  // the root, so HLS player was being re-handed fresh array identities on
  // every chat tick even though the underlying source list was unchanged. — perf
  const bravoSources = useMemo(() => {
    if (roomInfo?.media?.bravoSources?.length) return roomInfo.media.bravoSources;
    return (roomInfo?.media?.mp4Sources || []).filter((source) => {
      const label = source.label?.toLowerCase() || '';
      return label.includes('bravo') || source.url === roomInfo?.media?.currentBravoSource?.url;
    });
  }, [roomInfo?.media?.bravoSources, roomInfo?.media?.mp4Sources, roomInfo?.media?.currentBravoSource?.url]);

  const mp4Sources = useMemo(() => {
    return (roomInfo?.media?.mp4Sources || []).filter((source) => {
      const isBravoByUrl = bravoSources.some((bravoSource) => bravoSource.url === source.url);
      const label = source.label?.toLowerCase() || '';
      return !isBravoByUrl && !label.includes('bravo');
    });
  }, [roomInfo?.media?.mp4Sources, bravoSources]);

  // SwiftFlux passe par un CDN qui redirige vers un autre domaine : en mode CORS
  // le navigateur refuse de suivre la 302. On ne retire `crossOrigin` que quand
  // c'est bien cette source qui joue — les autres en dépendent pour le booster
  // de volume et l'égaliseur.
  const activeSourceFollowsRedirect = useMemo(
    () => mp4Sources.some((source) => source.followsRedirect && source.url === currentMediaSrc),
    [mp4Sources, currentMediaSrc],
  );

  // Moved an effect hook for source changes up to avoid conditional rendering issues.
  useEffect(() => {
    const handleSourceSelected = (event: Event) => {
      const customEvent = event as CustomEvent<{ type: string; id: string; url: string }>;
      if (customEvent.detail && customEvent.detail.url && customEvent.detail.url !== '#') {
        console.log('[WatchPartyRoom] HLSPlayer source changed locally:', customEvent.detail);
        setCurrentMediaSrc(customEvent.detail.url);
      }
    };

    window.addEventListener('sourceChange', handleSourceSelected);
    return () => {
      window.removeEventListener('sourceChange', handleSourceSelected);
    };
  }, []); // Empty dependency array: runs once on mount, cleans up on unmount.

  // Effect to initialize currentMediaSrc and update it if the main room media changes
  useEffect(() => {
    const mainMedia = roomInfo?.media;
    if (mainMedia?.src) {
      // Create a unique identifier for the current main media item
      const currentMediaIdentity = mainMedia.mediaId
        ? `${mainMedia.mediaType}-${mainMedia.mediaId}${mainMedia.seasonNumber ? `-s${mainMedia.seasonNumber}` : ''}${mainMedia.episodeNumber ? `-e${mainMedia.episodeNumber}` : ''}`
        : mainMedia.src; // Fallback to src if no better ID, though mediaId should ideally exist for TV/movies

      if (currentMediaSrc === null || lastKnownMainMediaIdentity.current !== currentMediaIdentity) {
        // Initialize currentMediaSrc if it's null (first time for this media item)
        // OR if the underlying main media item has changed (e.g., new episode, new movie)

        // Use the specific Bravo source if available, then Nexus source, otherwise fall back to main src
        const initialSrc = mainMedia.currentBravoSource?.url ||
          mainMedia.currentNexusSource?.url ||
          mainMedia.src;
        setCurrentMediaSrc(initialSrc);
        lastKnownMainMediaIdentity.current = currentMediaIdentity;

        console.log('[WatchPartyRoom] Initializing media source:', {
          mainSrc: mainMedia.src,
          bravoSource: mainMedia.currentBravoSource,
          nexusSource: mainMedia.currentNexusSource,
          finalSrc: initialSrc
        });
      }
    }
  }, [roomInfo]); // Only depends on roomInfo. User's local changes to currentMediaSrc won't cause this to revert their choice for the *same* media item.

  useEffect(() => {
    if (roomInfo && userId) {
      setIsCurrentUserHost(roomInfo.hostId === userId);
    }
  }, [roomInfo, userId]);

  // Keep chatWidthRef in sync so the resize-handle rAF closure can compare
  // the latest committed chatWidth without recreating the mousemove listener. — perf
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);

  // Debounce the markdown preview so ReactMarkdown doesn't re-parse on every
  // keystroke (remark-gfm + remark-emoji + the full Components map are expensive). — perf
  useEffect(() => {
    const id = setTimeout(() => setDebouncedNewMessage(newMessage), 150);
    return () => clearTimeout(id);
  }, [newMessage]);

  const applySyncCommand = useCallback((command: Extract<WatchPartySyncWorkerOutput, { type: 'command' }>) => {
    if (!playerRef.current) return;

    if (canControlPlayback) {
      if (command.action === 'setPlaybackRate' || command.action === 'resetPlaybackRate') {
        playerRef.current.setPlaybackRate(1);
      }
      return;
    }

    if (command.action === 'setPlaybackRate' && typeof command.value === 'number') {
      playerRef.current.setPlaybackRate(command.value);
      return;
    }

    if (command.action === 'resetPlaybackRate') {
      playerRef.current.setPlaybackRate(1);
      return;
    }

    isSyncingRef.current = true;

    if (command.action === 'seek' && typeof command.value === 'number') {
      playerRef.current.seek(command.value);
      setTimeout(() => { isSyncingRef.current = false; }, 180);
      return;
    }

    if (command.action === 'pause') {
      playerRef.current.pause();
      setTimeout(() => { isSyncingRef.current = false; }, 120);
      return;
    }

    playerRef.current.play()
      .catch((playError) => console.error('[WatchPartyRoom] Sync Pro play command failed:', playError))
      .finally(() => {
        setTimeout(() => { isSyncingRef.current = false; }, 120);
      });
  }, [canControlPlayback]);

  const handleSyncWorkerMessage = useCallback((payload: WatchPartySyncWorkerOutput) => {
    if (payload.type === 'status') {
      setSyncStatus(payload.status);
      return;
    }

    if (payload.type === 'command') {
      applySyncCommand(payload);
    }
  }, [applySyncCommand]);

  const clearSyncProbeTimers = useCallback(() => {
    syncProbeTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    syncProbeTimersRef.current = [];
  }, []);

  const commitLocalMasterPlaybackState = useCallback((nextState: PlaybackState) => {
    setMasterPlaybackState(nextState);
    masterPlaybackStateRef.current = nextState;

    if (syncModeRef.current === 'pro') {
      syncWorkerRef.current?.postMessage({
        type: 'master-state',
        state: nextState
      });
    }
  }, []);

  const startSyncCalibration = useCallback(() => {
    clearSyncProbeTimers();

    if (syncModeRef.current !== 'pro' || socketState !== SocketState.CONNECTED || !socketRef.current) {
      return;
    }

    setSyncStatus('calibrating');

    for (let probeIndex = 0; probeIndex < 5; probeIndex += 1) {
      const timerId = window.setTimeout(() => {
        if (!socketRef.current || syncModeRef.current !== 'pro') return;

        socketRef.current.emit('sync:probe', {
          probeId: `${roomId || 'watchparty'}-${Date.now()}-${syncProbeSequenceRef.current++}`,
          clientSentAt: Date.now()
        });
      }, probeIndex * 250);

      syncProbeTimersRef.current.push(timerId);
    }
  }, [clearSyncProbeTimers, roomId, socketState]);

  const postLocalPlayerSnapshot = useCallback(() => {
    if (!syncWorkerRef.current || !playerRef.current || syncModeRef.current !== 'pro' || canControlPlayback) {
      return;
    }

    const snapshot: LocalPlayerSnapshot = {
      now: Date.now(),
      currentTime: playerRef.current.getCurrentTime(),
      isPlaying: !playerRef.current.isPaused(),
      playbackRate: playerRef.current.getPlaybackRate()
    };

    syncWorkerRef.current.postMessage({
      type: 'local-state',
      state: snapshot
    });
  }, [canControlPlayback]);

  useEffect(() => {
    const syncWorker = new Worker(new URL('../workers/watchpartySync.worker.ts', import.meta.url), { type: 'module' });
    syncWorkerRef.current = syncWorker;
    syncWorker.onmessage = (event: MessageEvent<WatchPartySyncWorkerOutput>) => {
      handleSyncWorkerMessage(event.data);
    };
    syncWorker.postMessage({
      type: 'init',
      mode: syncModeRef.current,
      state: masterPlaybackStateRef.current
    });

    return () => {
      clearSyncProbeTimers();
      syncWorker.terminate();
      syncWorkerRef.current = null;
    };
  }, [clearSyncProbeTimers, handleSyncWorkerMessage]);

  useEffect(() => {
    syncModeRef.current = syncMode;
    syncWorkerRef.current?.postMessage({ type: 'set-mode', mode: syncMode });

    if (syncMode === 'classic') {
      setSyncStatus('classic');
      playerRef.current?.setPlaybackRate(1);
      return;
    }

    if (canControlPlayback) {
      setSyncStatus('perfect');
      playerRef.current?.setPlaybackRate(1);
    }
  }, [canControlPlayback, syncMode]);

  useEffect(() => {
    if (syncMode !== 'pro' || socketState !== SocketState.CONNECTED) {
      clearSyncProbeTimers();
      return;
    }

    startSyncCalibration();
    return clearSyncProbeTimers;
  }, [clearSyncProbeTimers, socketState, startSyncCalibration, syncMode]);

  useEffect(() => {
    if (localSyncIntervalRef.current) {
      clearInterval(localSyncIntervalRef.current);
      localSyncIntervalRef.current = null;
    }

    if (syncMode !== 'pro' || socketState !== SocketState.CONNECTED || canControlPlayback) {
      return;
    }

    localSyncIntervalRef.current = setInterval(() => {
      postLocalPlayerSnapshot();
    }, SYNC_PRO_HOST_INTERVAL_MS);

    return () => {
      if (localSyncIntervalRef.current) {
        clearInterval(localSyncIntervalRef.current);
        localSyncIntervalRef.current = null;
      }
    };
  }, [canControlPlayback, postLocalPlayerSnapshot, socketState, syncMode]);

  // Effect to manage host's continuous position broadcasting
  useEffect(() => {
    // Only hosts need to continuously broadcast position
    // In democratic mode, we disable continuous broadcasting to avoid overwriting guest actions with host's local state
    if (!isCurrentUserHost || !socketRef.current || socketState !== SocketState.CONNECTED || controlMode === 'democratic') {
      if (continuousSyncIntervalRef.current) {
        clearInterval(continuousSyncIntervalRef.current);
        continuousSyncIntervalRef.current = null;
      }
      return;
    }

    console.log('[WatchPartyRoom] Setting up continuous host position broadcasting.');

    // Set up periodic position broadcasting for the host
    continuousSyncIntervalRef.current = setInterval(() => {
      if (playerRef.current && socketRef.current) {
        try {
          const currentTime = playerRef.current.getCurrentTime();
          // Use the actual paused state from the video element
          const isPlaying = !playerRef.current.isPaused();

          // Even if handleTimeUpdate is active, we want a guaranteed update frequency here
          socketRef.current.emit('playback:update', {
            isPlaying: isPlaying,
            position: currentTime,
            reason: 'heartbeat'
          });
        } catch (err) {
          console.error('[WatchPartyRoom] Error in continuous sync interval:', err);
        }
      }
    }, getHostPositionUpdateInterval(syncMode));

    return () => {
      if (continuousSyncIntervalRef.current) {
        clearInterval(continuousSyncIntervalRef.current);
        continuousSyncIntervalRef.current = null;
      }
    };
  }, [isCurrentUserHost, socketState, controlMode, syncMode]);

  const connectSocket = useCallback(async () => {
    if (!roomId) return;
    const mounted = true;
    initialFetchDoneRef.current = false;
    setError(null); // Clear previous errors on new connection attempt
    setSocketState(SocketState.CONNECTING);

    // Le serveur exige un token de room (délivré par /create ou /join) pour lire
    // les détails de la room et pour ouvrir la socket. Il arrive via l'état de
    // navigation, ou depuis sessionStorage après un rafraîchissement.
    const token = locationState.token || getRoomToken(roomId);
    if (!token) {
      setError(t('watchParty.accessTokenMissing'));
      setSocketState(SocketState.ERROR);
      return;
    }
    if (locationState.token) storeRoomToken(roomId, locationState.token);

    try {
      const savedNickname = localStorage.getItem('watchPartyNickname');
      const nickname = locationState.nickname || savedNickname || `Guest${Math.floor(Math.random() * 1000)}`;

      const roomDetailsResponse = await axios.get(`${MAIN_API}/api/watchparty/room/${roomId}`, {
        headers: { 'x-watchparty-token': token }
      });
      if (!mounted) return;
      const fetchedRoomInfo = roomDetailsResponse.data.room as RoomInfo;
      setRoomInfo(fetchedRoomInfo);
      setChatEnabled(fetchedRoomInfo.chatEnabled ?? true);
      setSyncMode(fetchedRoomInfo.syncMode || 'classic');
      setControlMode(fetchedRoomInfo.controlMode || 'host-only');
      setCoHosts(fetchedRoomInfo.coHosts || []);
      // Initializing currentMediaSrc is now handled by the dedicated useEffect above
      initialFetchDoneRef.current = true;

      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      const socket = io(`${MAIN_API}/watchparty`, {
        query: { roomId, nickname, token },
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
        timeout: 5000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        if (!mounted) return;
        if (attemptReconnectRef.current) {
          clearTimeout(attemptReconnectRef.current);
          attemptReconnectRef.current = null;
        }
        setSocketState(SocketState.CONNECTED);
        if (socket.id) {
          setUserId(socket.id);
        } else {
          console.error("Socket ID is undefined after connect!");
          setError(t('watchParty.identificationError'));
        }
        console.log('Socket connected. Requesting current playback state...');
        socket.emit('playback:getState');
      });

      socket.on('connect_error', (err) => {
        if (!mounted) return;
        console.error('Socket connection error:', err);
        setError(t('watchParty.connectionError', { message: err.message }));
        setSocketState(SocketState.ERROR);
        // Automatic reconnection by socket.io will be attempted based on options.
      });

      socket.on('disconnect', (reason) => {
        if (!mounted) return;
        setSocketState(SocketState.DISCONNECTED);
        console.log('Socket disconnected:', reason);
        if (reason === 'io server disconnect') {
          setError(t('watchParty.disconnectedByServer'));
        } else if (reason === 'transport close' || reason === 'ping timeout') {
          setError(t('watchParty.connectionLost'));
          // Socket.IO will attempt to reconnect based on `reconnectionAttempts`.
          // If all attempts fail, it won't emit further `connect_error` or `disconnect` for a while.
          // We might need a manual retry button if it stays disconnected.
          if (!attemptReconnectRef.current) { // Simple guard against multiple timeouts
            attemptReconnectRef.current = setTimeout(() => {
              if (mounted && socketState !== SocketState.CONNECTED) {
                console.log("Reconnection timeout, suggesting manual retry.");
                setError(t('watchParty.reconnectionFailedRetry'));
              }
            }, 15000); // 15 seconds before suggesting manual retry
          }
        }
      });

      socket.on('error', (err) => { // Generic socket error
        if (!mounted) return;
        console.error('Generic socket error event:', err);
        // Avoid overriding specific disconnect/connect_error messages unless it's a new error
        if (!error) {
          setError(err.message || t('watchParty.serverCommError'));
          setSocketState(SocketState.ERROR);
        }
      });

      socket.on('room:info', (updatedRoomInfo: RoomInfo) => {
        if (!mounted) return;
        setRoomInfo(updatedRoomInfo);
        setChatEnabled(updatedRoomInfo.chatEnabled ?? true);
        setSyncMode(updatedRoomInfo.syncMode || 'classic');
      });

      socket.on('room:chatToggled', ({ enabled }: { enabled: boolean }) => {
        if (!mounted) return;
        setChatEnabled(enabled);
      });

      socket.on('media:updated', (newMedia: RoomInfo['media']) => {
        if (!mounted) return;
        console.log('[WatchPartyRoom] Media changed by host:', newMedia?.title);
        setRoomInfo(prev => prev ? { ...prev, media: newMedia } : prev);
        // Reset player to new source
        if (playerRef.current) {
          playerRef.current.seekTo(0);
        }
      });

      socket.on('room:participants', (roomParticipants: Participant[]) => {
        if (!mounted) return;
        setParticipants(roomParticipants);
      });

      socket.on('playback:state', (newState: PlaybackState) => {
        if (!mounted) return;

        console.log(`[WatchPartyRoom] Received 'playback:state' event. Data:`, JSON.stringify(newState)); // Enhanced log

        if (!newState || typeof newState.isPlaying === 'undefined' || typeof newState.position === 'undefined') {
          console.error('[WatchPartyRoom] Received invalid or incomplete playback state:', newState);
          return;
        }

        // Store the actual player state BEFORE updating local state
        const wasActuallyPaused = playerRef.current ? playerRef.current.isPaused() : true;
        const currentVideoTime = playerRef.current ? playerRef.current.getCurrentTime() : 0;

        setMasterPlaybackState(newState);
        masterPlaybackStateRef.current = newState;
        console.log('[WatchPartyRoom] masterPlaybackState has been set.'); // New log

        setLocalPlayerVisualState({
          isPlaying: newState.isPlaying,
          position: newState.position,
        });
        console.log('[WatchPartyRoom] localPlayerVisualState has been set.'); // New log

        if (syncModeRef.current === 'pro') {
          syncWorkerRef.current?.postMessage({
            type: 'master-state',
            state: newState
          });
          return;
        }

        if (playerRef.current) {
          const F_THRESHOLD = 1.5; // Sync threshold in seconds

          console.log(`[WatchPartyRoom] PlayerRef current time: ${currentVideoTime.toFixed(2)}, Server position: ${newState.position.toFixed(2)}, wasActuallyPaused: ${wasActuallyPaused}`); // New log

          if (Math.abs(currentVideoTime - newState.position) > F_THRESHOLD) {
            if (isCurrentUserHost && Math.abs(lastSeekSourceTimeRef.current - newState.position) < 0.5 && newState.updatedBy === userId) {
              console.log('[WatchPartyRoom] Host: Ignoring self-initiated seek update to prevent loop.');
            } else {
              console.log(`[WatchPartyRoom] Syncing player position: local=${currentVideoTime.toFixed(2)}, server=${newState.position.toFixed(2)}`);
              isSyncingRef.current = true;
              playerRef.current.seek(newState.position);
              setTimeout(() => { isSyncingRef.current = false; }, 200);
            }
          }

          // Sync play/pause state based on actual player state, not React state
          // isSyncingRef empêche les callbacks DOM de ré-émettre pendant la sync
          if (newState.isPlaying && wasActuallyPaused) {
            console.log('[WatchPartyRoom] Server wants to play, local is paused. Calling play().');
            isSyncingRef.current = true;
            playerRef.current.play()
              .catch(e => console.error("[WatchPartyRoom] Error playing on sync:", e))
              .finally(() => { setTimeout(() => { isSyncingRef.current = false; }, 100); });
          } else if (!newState.isPlaying && !wasActuallyPaused) {
            console.log('[WatchPartyRoom] Server wants to pause, local is playing. Calling pause().');
            isSyncingRef.current = true;
            playerRef.current.pause();
            setTimeout(() => { isSyncingRef.current = false; }, 100);
          }
        } else {
          console.warn('[WatchPartyRoom] playerRef.current is null when trying to sync playback state.');
        }
      });

      socket.on('playback:schedule', (event: ScheduledPlaybackEvent) => {
        if (!mounted || syncModeRef.current !== 'pro') return;

        syncWorkerRef.current?.postMessage({
          type: 'schedule',
          event
        });
      });

      socket.on('sync:modeChanged', ({ mode }: { mode: SyncMode }) => {
        if (!mounted) return;
        setSyncMode(mode);
      });

      socket.on('sync:probeResult', (probeResult: SyncProbeResult) => {
        if (!mounted || syncModeRef.current !== 'pro') return;

        syncWorkerRef.current?.postMessage({
          type: 'probe-result',
          result: {
            ...probeResult,
            clientReceivedAt: Date.now()
          }
        });
      });

      socket.on('room:chat', (message: ChatMessage) => {
        if (!mounted) return;
        // Skip adding deleted messages
        if (message.deleted) return;
        setMessages(prevMessages => {
          if (prevMessages.some(m => m.id === message.id)) return prevMessages;
          return [...prevMessages, message];
        });
      });

      // Control state listeners (must be set up early to catch initial state)
      socket.on('control:state', (state: ControlState) => {
        if (!mounted) return;
        console.log('[WatchPartyRoom] Received control:state:', state);
        setControlMode(state.controlMode);
        setCoHosts(state.coHosts);
        setPendingRequests(state.pendingRequests);
      });

      socket.on('control:approved', () => {
        if (!mounted) return;
        console.log('[WatchPartyRoom] Control approved - user is now co-host');
        setHasRequestedControl(false);
      });

      socket.on('control:denied', () => {
        if (!mounted) return;
        setHasRequestedControl(false);
      });

      socket.on('control:revoked', () => {
        if (!mounted) return;
        console.log('[WatchPartyRoom] Control revoked - user is no longer co-host');
      });

      socket.on('room:closed', (reason: string) => {
        if (!mounted) return;
        setError(t('watchParty.partyEnded', { reason }));
        setSocketState(SocketState.DISCONNECTED);
        if (socketRef.current) socketRef.current.disconnect();
        setTimeout(() => navigate('/'), 5000);
      });

    } catch (err: unknown) {
      if (!mounted) return;
      console.error('Connection setup error:', err);
      // Token expiré ou révoqué (kick, redémarrage serveur) : on le jette pour
      // que l'utilisateur repasse par l'écran de code plutôt que de boucler.
      if (axios.isAxiosError(err) && err.response?.status === 403) {
        clearRoomToken(roomId);
        setError(t('watchParty.accessTokenInvalid'));
        setSocketState(SocketState.ERROR);
        initialFetchDoneRef.current = true;
        return;
      }
      const errorMessage = err instanceof Error ? err.message : t('watchParty.unableToJoinRoom');
      setError(errorMessage);
      setSocketState(SocketState.ERROR);
      initialFetchDoneRef.current = true; // Mark fetch as done even if erroring to allow error display
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, locationState.nickname, locationState.token, navigate]); // Removed userId and isCurrentUserHost to avoid re-triggering connection on their change

  useEffect(() => {
    connectSocket(); // Initial connection attempt
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (attemptReconnectRef.current) {
        clearTimeout(attemptReconnectRef.current);
      }
    };
  }, [connectSocket]); // connectSocket is now stable due to useCallback

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Player event handlers (passed to HLSPlayer)
  const handlePlayerPlay = useCallback(() => {
    // Ignorer les événements déclenchés par la sync serveur (anti-boucle)
    if (isSyncingRef.current) {
      console.log('[WatchPartyRoom] PLAY event ignored (syncing from server)');
      return;
    }

    console.log('Event: onPlayerPlay');

    // Throttle events
    const now = Date.now();
    if (now - lastPlaybackEventTimeRef.current < 500 && lastPlaybackEventTypeRef.current === 'play') {
      console.log('[WatchPartyRoom] Throttling duplicate PLAY event');
      return;
    }
    lastPlaybackEventTimeRef.current = now;
    lastPlaybackEventTypeRef.current = 'play';

    // Users with control (host, co-host, or democratic mode) broadcast play events
    const userCanControl = isCurrentUserHost || coHosts.includes(userId) || controlMode === 'democratic';
    console.log(`[WatchPartyRoom] PLAY check: userId=${userId}, isHost=${isCurrentUserHost}, coHosts=[${coHosts.join(',')}], mode=${controlMode}, userCanControl=${userCanControl}`);
    if (userCanControl && socketRef.current && playerRef.current) {
      setLocalPlayerVisualState(prev => ({ ...prev, isPlaying: true }));
      const currentTime = playerRef.current.getCurrentTime();
      commitLocalMasterPlaybackState({
        isPlaying: true,
        position: currentTime,
        updatedAt: now,
        updatedBy: userId || null
      });
      socketRef.current.emit('playback:update', {
        isPlaying: true,
        position: currentTime,
        reason: 'play'
      });
      console.log(`[WatchPartyRoom] User broadcasting PLAY at ${currentTime.toFixed(2)}`);
    } else if (!userCanControl && masterPlaybackState && !masterPlaybackState.isPlaying && playerRef.current) {
      // Guest sans contrôle : réverter immédiatement à l'état serveur
      console.log('[WatchPartyRoom] Guest sans contrôle a tenté play. Réversion à l\'état serveur (pause).');
      isSyncingRef.current = true;
      playerRef.current.pause();
      setTimeout(() => { isSyncingRef.current = false; }, 100);
    } else {
      setLocalPlayerVisualState(prev => ({ ...prev, isPlaying: true }));
    }
  }, [commitLocalMasterPlaybackState, isCurrentUserHost, coHosts, userId, controlMode, masterPlaybackState]);

  const handlePlayerPause = useCallback(() => {
    // Ignorer les événements déclenchés par la sync serveur (anti-boucle)
    if (isSyncingRef.current) {
      console.log('[WatchPartyRoom] PAUSE event ignored (syncing from server)');
      return;
    }

    console.log('Event: onPlayerPause');

    // Throttle events
    const now = Date.now();
    if (now - lastPlaybackEventTimeRef.current < 500 && lastPlaybackEventTypeRef.current === 'pause') {
      console.log('[WatchPartyRoom] Throttling duplicate PAUSE event');
      return;
    }
    lastPlaybackEventTimeRef.current = now;
    lastPlaybackEventTypeRef.current = 'pause';

    // Users with control (host, co-host, or democratic mode) broadcast pause events
    const userCanControl = isCurrentUserHost || coHosts.includes(userId) || controlMode === 'democratic';
    console.log(`[WatchPartyRoom] PAUSE check: userId=${userId}, isHost=${isCurrentUserHost}, coHosts=[${coHosts.join(',')}], mode=${controlMode}, userCanControl=${userCanControl}`);
    if (userCanControl && socketRef.current && playerRef.current) {
      setLocalPlayerVisualState(prev => ({ ...prev, isPlaying: false }));
      const currentTime = playerRef.current.getCurrentTime();
      commitLocalMasterPlaybackState({
        isPlaying: false,
        position: currentTime,
        updatedAt: now,
        updatedBy: userId || null
      });
      socketRef.current.emit('playback:update', {
        isPlaying: false,
        position: currentTime,
        reason: 'pause'
      });
      console.log(`[WatchPartyRoom] User broadcasting PAUSE at ${currentTime.toFixed(2)}`);
    } else if (!userCanControl && masterPlaybackState && masterPlaybackState.isPlaying && playerRef.current) {
      // Guest sans contrôle : réverter immédiatement à l'état serveur
      console.log('[WatchPartyRoom] Guest sans contrôle a tenté pause. Réversion à l\'état serveur (play).');
      isSyncingRef.current = true;
      playerRef.current.play()
        .catch(e => console.error("[WatchPartyRoom] Error reverting to play:", e))
        .finally(() => { setTimeout(() => { isSyncingRef.current = false; }, 100); });
    } else {
      setLocalPlayerVisualState(prev => ({ ...prev, isPlaying: false }));
    }
  }, [commitLocalMasterPlaybackState, isCurrentUserHost, coHosts, userId, controlMode, masterPlaybackState]);

  const handlePlayerTimeUpdate = useCallback((currentTime: number) => {
    // Mettre à jour la position locale sans forcer isPlaying (respecter l'état réel du player)
    setLocalPlayerVisualState(prev => ({ ...prev, position: currentTime }));

    // Host updates via the continuous interval now, removing direct updates from here
    // This simplifies this handler and avoids potential conflicts with the interval
  }, []);

  const handlePlayerSeeked = useCallback(() => {
    // Ignorer les événements déclenchés par la sync serveur (anti-boucle)
    if (isSyncingRef.current) {
      console.log('[WatchPartyRoom] SEEK event ignored (syncing from server)');
      return;
    }

    console.log('Event: onPlayerSeeked');

    // Throttle events
    const now = Date.now();
    if (now - lastPlaybackEventTimeRef.current < 500 && lastPlaybackEventTypeRef.current === 'seek') {
      console.log('[WatchPartyRoom] Throttling duplicate SEEK event');
      return;
    }
    lastPlaybackEventTimeRef.current = now;
    lastPlaybackEventTypeRef.current = 'seek';

    if (!playerRef.current) return;

    const newPosition = playerRef.current.getCurrentTime();
    const isPlaying = !playerRef.current.isPaused();

    // Users with control (host, co-host, or democratic mode) can seek
    const userCanControl = isCurrentUserHost || coHosts.includes(userId) || controlMode === 'democratic';
    if (userCanControl && socketRef.current) {
      lastSeekSourceTimeRef.current = newPosition; // Store seek position
      setLocalPlayerVisualState(prev => ({
        ...prev,
        position: newPosition,
        isPlaying: isPlaying
      }));
      commitLocalMasterPlaybackState({
        isPlaying,
        position: newPosition,
        updatedAt: now,
        updatedBy: userId || null
      });

      socketRef.current.emit('playback:update', {
        isPlaying: isPlaying,
        position: newPosition,
        reason: 'seek'
      });
      console.log(`[WatchPartyRoom] User broadcasting SEEK to ${newPosition.toFixed(2)}`);
    } else if (!userCanControl && masterPlaybackState) {
      // Only revert for users who DON'T have control
      if (Math.abs(newPosition - masterPlaybackState.position) > 1.0) {
        console.log(`[WatchPartyRoom] Participant tried to seek. Reverting to ${masterPlaybackState.position.toFixed(2)}`);
        playerRef.current.seek(masterPlaybackState.position);
      }
    }
  }, [commitLocalMasterPlaybackState, isCurrentUserHost, coHosts, userId, controlMode, masterPlaybackState]);

  const handlePlayerEnded = useCallback(() => {
    console.log('Event: onPlayerEnded');
    const duration = playerRef.current?.getDuration() || 0;
    setLocalPlayerVisualState({ isPlaying: false, position: duration });

    if (isCurrentUserHost && socketRef.current && playerRef.current) {
      commitLocalMasterPlaybackState({
        isPlaying: false,
        position: duration,
        updatedAt: Date.now(),
        updatedBy: userId || null
      });
      socketRef.current.emit('playback:update', {
        isPlaying: false,
        position: duration, // Send end position (duration)
        reason: 'ended'
      });
      console.log(`[WatchPartyRoom] Host broadcasting END at ${duration.toFixed(2)}`);
    }
  }, [commitLocalMasterPlaybackState, isCurrentUserHost, userId]);



  const handleCopyInviteLink = () => {
    if (!roomInfo?.code) return;
    const shareLink = getShareLink(roomInfo.code);
    navigator.clipboard.writeText(shareLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    });
  };

  const leaveRoom = () => {
    if (socketRef.current) socketRef.current.disconnect();
    navigate('/');
  };

  // Fullscreen functionality
  const togglePageFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsPageFullscreen(true);
      }).catch(err => {
        console.error('Erreur lors de l\'activation du plein écran:', err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsPageFullscreen(false);
      }).catch(err => {
        console.error('Erreur lors de la sortie du plein écran:', err);
      });
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsPageFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // Add listener for message deletion events
  useEffect(() => {
    if (socketRef.current) {
      socketRef.current.on('message:deleted', (data: { messageId: string }) => {
        setDeletedMessages(prev => {
          const newSet = new Set(prev);
          newSet.add(data.messageId);
          return newSet;
        });

        // Also update the messages array to mark deleted messages
        setMessages(prevMessages =>
          prevMessages.map(msg =>
            msg.id === data.messageId
              ? { ...msg, deleted: true }
              : msg
          )
        );
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('message:deleted');
      }
    };
  }, [socketRef.current]);

  // Add listener for being kicked
  useEffect(() => {
    if (socketRef.current) {
      socketRef.current.on('room:kicked', () => {
        setError(t('watchParty.kickedByHost'));
        setSocketState(SocketState.ERROR);
        // Le serveur a révoqué le token : inutile de le garder côté client.
        if (roomId) clearRoomToken(roomId);
        if (socketRef.current) socketRef.current.disconnect();
        setTimeout(() => navigate('/'), 5000);
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('room:kicked');
      }
    };
  }, [socketRef.current, navigate, roomId]);

  // useCallback so ChatMessageItem (memoized) doesn't see a fresh function on every
  // root re-render — keeps the per-message memo bail-out effective. — perf
  const handleDeleteMessage = useCallback((messageId: string) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('message:delete', { messageId });
    }
  }, [isCurrentUserHost, socketState]);

  const handleKickParticipant = (participantId: string) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('participant:kick', { participantId });
    }
  };

  // ===== NEW FEATURE HANDLERS =====

  const syncStatusLabel =
    syncMode === 'classic'
      ? t('watchParty.syncStatusClassic')
      : syncStatus === 'calibrating'
        ? t('watchParty.syncStatusCalibrating')
        : syncStatus === 'perfect'
          ? t('watchParty.syncStatusPerfect')
          : syncStatus === 'adjusting'
            ? t('watchParty.syncStatusAdjusting')
            : t('watchParty.syncStatusUnstable');

  const syncStatusClasses =
    syncMode === 'classic'
      ? 'bg-white/10 text-white/70 border-white/10'
      : syncStatus === 'perfect'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
        : syncStatus === 'adjusting' || syncStatus === 'calibrating'
          ? 'bg-amber-500/15 text-amber-300 border-amber-500/20'
          : 'bg-red-500/15 text-red-300 border-red-500/20';

  // Debug log for control permissions
  console.log(`[Control] userId: ${userId}, isHost: ${isCurrentUserHost}, coHosts: [${coHosts.join(', ')}], controlMode: ${controlMode}, canControl: ${canControlPlayback}`);

  // Request control (for non-hosts)
  const handleRequestControl = () => {
    if (socketRef.current && socketState === SocketState.CONNECTED && !canControlPlayback) {
      socketRef.current.emit('control:request');
      setHasRequestedControl(true);
    }
  };

  // Approve control request (host only)
  const handleApproveControl = (participantId: string) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('control:approve', { participantId });
    }
  };

  // Deny control request (host only)
  const handleDenyControl = (participantId: string) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('control:deny', { participantId });
    }
  };

  // Revoke control from co-host (host only)
  const handleRevokeControl = (participantId: string) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('control:revoke', { participantId });
    }
  };

  // Toggle control mode (host only)
  const handleToggleControlMode = () => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      const newMode = controlMode === 'host-only' ? 'democratic' : 'host-only';
      socketRef.current.emit('control:setMode', { mode: newMode });
    }
  };

  const handleSetSyncMode = (nextMode: SyncMode) => {
    if (socketRef.current && isCurrentUserHost && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('sync:setMode', { mode: nextMode });
    }
  };

  // Change media (host only)
  const handleChangeMedia = (media: { title: string; poster: string; mediaType: 'movie' | 'tv'; mediaId: string; seasonNumber?: number; episodeNumber?: number }) => {
    if (!socketRef.current || !isCurrentUserHost || socketState !== SocketState.CONNECTED) return;
    socketRef.current.emit('media:change', {
      src: '',
      title: media.title,
      poster: media.poster,
      mediaType: media.mediaType,
      mediaId: media.mediaId,
      seasonNumber: media.seasonNumber || 0,
      episodeNumber: media.episodeNumber || 0,
      nightflixSources: [],
      nexusSources: [],
      mp4Sources: [],
      captions: [],
    });
    setShowChangeMediaModal(false);
  };

  // Start pause timer (host/co-host only)
  const handleStartPauseTimer = (duration: number) => {
    if (socketRef.current && canControlPlayback && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('pause:start', { duration });
      setShowPauseTimerModal(false);
    }
  };

  // Cancel pause timer (host/co-host only)
  const handleCancelPauseTimer = () => {
    if (socketRef.current && canControlPlayback && socketState === SocketState.CONNECTED) {
      socketRef.current.emit('pause:cancel');
    }
  };

  // Send emoji reaction with 1 second cooldown
  const handleSendReaction = (emoji: string) => {
    if (socketRef.current && socketState === SocketState.CONNECTED && !reactionCooldown) {
      socketRef.current.emit('reaction:send', { emoji });
      setReactionCooldown(true);
      setTimeout(() => setReactionCooldown(false), 1000); // 1 second cooldown
    }
  };

  // Remove floating reaction after animation
  const handleReactionComplete = (id: string) => {
    setFloatingReactions(prev => prev.filter(r => r.id !== id));
  };

  // ===== VOTE SYSTEM HANDLERS =====

  // Request vote for pause (for guests)
  const handleRequestPauseVote = (duration: number) => {
    if (socketRef.current && socketState === SocketState.CONNECTED && !canControlPlayback) {
      socketRef.current.emit('vote:request', { duration });
      setShowPauseTimerModal(false);
    }
  };

  // Cast vote
  const handleCastVote = (vote: boolean) => {
    if (socketRef.current && socketState === SocketState.CONNECTED && activeVote && !hasVoted) {
      socketRef.current.emit('vote:cast', { vote });
      setHasVoted(true);
    }
  };

  // Vote socket listeners
  useEffect(() => {
    if (socketRef.current) {
      socketRef.current.on('vote:started', (data: PauseVoteState) => {
        setActiveVote(data);
        setVoteProgress({ yesVotes: 0, noVotes: 0, totalVotes: 0 });
        setHasVoted(false);
      });

      socketRef.current.on('vote:update', (data: { yesVotes: number; noVotes: number; totalVotes: number }) => {
        setVoteProgress(data);
      });

      socketRef.current.on('vote:ended', () => {
        setActiveVote(null);
        setVoteProgress({ yesVotes: 0, noVotes: 0, totalVotes: 0 });
        setHasVoted(false);
        setVoteCountdown(0);
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('vote:started');
        socketRef.current.off('vote:update');
        socketRef.current.off('vote:ended');
      }
    };
  }, [socketRef.current]);

  // Vote countdown effect
  useEffect(() => {
    if (!activeVote) {
      setVoteCountdown(0);
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((activeVote.endTime - Date.now()) / 1000));
      setVoteCountdown(remaining);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [activeVote]);

  // ===== NEW FEATURE SOCKET LISTENERS =====

  // Control state listener


  // Reaction listener
  useEffect(() => {
    if (socketRef.current) {
      socketRef.current.on('reaction:received', (reaction: { id: string; emoji: string }) => {
        setFloatingReactions(prev => [...prev, { id: reaction.id, emoji: reaction.emoji }]);
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('reaction:received');
      }
    };
  }, [socketRef.current]);

  // Pause timer listeners
  useEffect(() => {
    if (socketRef.current) {
      socketRef.current.on('pause:timerStarted', (timer: PauseTimer) => {
        setPauseTimer(timer);
      });

      socketRef.current.on('pause:timerCancelled', () => {
        setPauseTimer(null);
        setPauseCountdown(0);
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('pause:timerStarted');
        socketRef.current.off('pause:timerCancelled');
      }
    };
  }, [socketRef.current]);

  // Pause timer countdown — use duration from server, count locally
  const pauseStartRef = useRef<number>(0);
  useEffect(() => {
    if (!pauseTimer) {
      setPauseCountdown(0);
      return;
    }

    // Record local start time when timer begins
    pauseStartRef.current = Date.now();
    const durationMs = pauseTimer.duration * 1000;

    const updateCountdown = () => {
      const elapsed = Date.now() - pauseStartRef.current;
      const remaining = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
      setPauseCountdown(remaining);

      // Server handles auto-resume, we just clear the UI
      if (remaining <= 0) {
        setPauseTimer(null);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 200);
    return () => clearInterval(interval);
  }, [pauseTimer]);

  // Mute/unmute a user (local only)
  // useCallback so ChatMessageItem (memoized) keeps a stable reference. — perf
  const toggleMuteUser = useCallback((userId: string) => {
    setMutedUsers(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  // chatMdComponents lives at module scope (CHAT_MD_COMPONENTS) so we don't
  // recreate the entire components map (16 inline arrow functions) on every
  // root re-render, which happens on every chat tick / socket event. — perf

  // Auto-detect emojis in chat and send reactions
  const sendChatMessageWithReactions = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !socketRef.current || socketState !== SocketState.CONNECTED) return;

    // Check for reaction emojis in message
    const emojis = extractReactionEmojis(newMessage);
    emojis.forEach(emoji => {
      handleSendReaction(emoji);
    });

    socketRef.current.emit('chat:message', { text: newMessage });
    setNewMessage('');
  };

  // Loading and Error States Rendering
  if (!initialFetchDoneRef.current && socketState === SocketState.CONNECTING) {
    return <LoadingSpinner message={t('watchParty.loadingRoomInfo')} />;
  }

  if (error && socketState === SocketState.ERROR) {
    // Allow retry only if the error is not a room closure type error
    const canRetry = !error.toLowerCase().includes("terminée") && !error.toLowerCase().includes("closed");
    return <ErrorDisplay message={error} onRetry={canRetry ? connectSocket : undefined} />;
  }

  if (!roomInfo) { // Should ideally be covered by initialFetchDone or error state
    return <LoadingSpinner message={t('watchParty.fetchingRoomDetails')} />;
  }

  if (socketState !== SocketState.CONNECTED && !masterPlaybackState) {
    return <LoadingSpinner message={t('watchParty.connectingToServer', { state: socketState })} />;
  }

  if (!roomInfo.media?.title || !masterPlaybackState) {
    return <LoadingSpinner message={!roomInfo.media?.title ? t('watchParty.mediaSourceNotAvailable') : t('watchParty.waitingForPlayback')} />;
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-black text-white overflow-hidden">
      <div
        hidden
        data-premid-party-context=""
        data-premid-party-title={roomInfo.media?.title || undefined}
        data-premid-party-media-type={roomInfo.media?.mediaType || undefined}
        data-premid-party-season={roomInfo.media?.seasonNumber != null ? String(roomInfo.media.seasonNumber) : undefined}
        data-premid-party-episode={roomInfo.media?.episodeNumber != null ? String(roomInfo.media.episodeNumber) : undefined}
        data-premid-party-poster={roomInfo.media?.poster || undefined}
        data-premid-party-participants={String(participants.length)}
      />
      {/* Floating Emoji Reactions - Fixed position for fullscreen support */}
      <FloatingReactionsContainer
        reactions={floatingReactions}
        onReactionComplete={handleReactionComplete}
      />
      {/* Header - keep height minimal but visible */}
      <div className="bg-black/50 backdrop-blur-md border-b border-white/10 py-2 px-3 md:py-3 md:px-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center min-w-0">
          <h1 className="text-lg md:text-xl font-bold truncate max-w-[180px] md:max-w-full" title={roomInfo.media?.title}>{roomInfo.media?.title}</h1>
          {isCurrentUserHost && (
            <span className="ml-2 px-2 py-0.5 bg-green-600 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 inline-flex items-center justify-center">
              {t('watchParty.hostRole')}
            </span>
          )}
          {!isCurrentUserHost && coHosts.includes(userId) && (
            <span className="ml-2 px-2 py-0.5 bg-blue-600 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 inline-flex items-center justify-center">
              {t('watchParty.coHostRole')}
            </span>
          )}
          {controlMode === 'democratic' && (
            <span className="hidden sm:inline-flex ml-2 px-2 py-0.5 bg-purple-600 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 items-center justify-center">
              🎮 {t('watchParty.democraticShort')}
            </span>
          )}
          <span className={`hidden sm:inline-flex ml-2 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${syncStatusClasses}`}>
            {syncMode === 'pro' ? 'Sync Pro' : t('watchParty.syncModeClassic')} {' | '} {syncStatusLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">

          {/* Request control button (for non-hosts in host-only mode) */}
          {!canControlPlayback && controlMode === 'host-only' && !hasRequestedControl && (
            <button
              onClick={handleRequestControl}
              className="p-1.5 bg-yellow-600 hover:bg-yellow-700 rounded-md"
              title={t('watchParty.requestControl')}
            >
              <Hand size={16} />
            </button>
          )}
          {hasRequestedControl && (
            <span className="px-2 py-1 bg-yellow-600/50 rounded-md text-xs animate-pulse">
              {t('watchParty.waitingEllipsis')}
            </span>
          )}

          <div className="hidden md:flex items-center">
            <span className="text-sm mr-2 text-white/70">{t('watchParty.code')}: <span className="font-mono font-bold text-white">{roomInfo.code}</span></span>
            <button onClick={handleCopyInviteLink} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-md" title={t('watchParty.copyInviteLink')}>
              {linkCopied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
            </button>
          </div>

          {/* Settings button */}
          <button
            onClick={() => setShowSettingsPanel(true)}
            className="p-1.5 bg-white/10 hover:bg-white/20 rounded-md"
            title={t('watchParty.settings')}
          >
            <Settings size={18} />
          </button>
          <button onClick={() => setShowParticipantsPanel(true)} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-md relative">
            <Users size={18} />
            {participants.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-xs h-5 w-5 flex items-center justify-center rounded-full border-2 border-black">
                {participants.length}
              </span>
            )}
          </button>
          <button onClick={() => setShowChatPanel(!showChatPanel)} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-md md:hidden">
            <MessageSquare size={18} />
          </button>
          <button onClick={togglePageFullscreen} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-md" title={isPageFullscreen ? t('watchParty.exitFullscreen') : t('watchParty.fullscreen')}>
            {isPageFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
          <button onClick={leaveRoom} className="p-1.5 bg-red-600 hover:bg-red-700 rounded-md" title={t('watchParty.quitLabel')}>
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Main Content - use flex-grow-1 to take all available height */}
      <div className="flex flex-1 h-0 overflow-hidden relative">
        {/* Player container - always ensure it has minimum height on mobile */}
        <div
          className={`flex-1 relative transition-all duration-300 ease-in-out min-h-[40dvh] sm:min-h-0 ${showChatPanel ? 'mb-[40dvh] md:mb-0' : ''}`}
          style={{ marginRight: showChatPanel && typeof window !== 'undefined' && window.innerWidth >= 768 ? chatWidth : undefined }}
        >
          <div className="absolute inset-0 p-1 sm:p-2 lg:p-4">
            <div className="h-full w-full relative rounded-lg overflow-hidden shadow-lg bg-black">
              {currentMediaSrc && roomInfo && masterPlaybackState ? (
                <MemoizedHLSPlayer
                  ref={playerRef}
                  videoRef={videoElementForEventRef}
                  src={currentMediaSrc}
                  poster={roomInfo.media?.poster}
                  controls={true}
                  className="w-full h-full object-contain rounded-lg"
                  initialTime={localPlayerVisualState.position}
                  isPlaying={localPlayerVisualState.isPlaying}
                  isWatchPartyGuest={!canControlPlayback || pauseCountdown > 0}
                  darkinoSources={roomInfo.media?.nightflixSources?.map(nfSource => ({
                    m3u8: nfSource.src,
                    quality: nfSource.quality,
                    language: nfSource.language,
                    label: nfSource.label
                  })) || []}
                  nexusHlsSources={roomInfo.media?.nexusSources?.filter(nexusSource => nexusSource.type === 'hls').map(nexusSource => ({
                    url: nexusSource.url,
                    label: nexusSource.label
                  })) || []}
                  nexusFileSources={roomInfo.media?.nexusSources?.filter(nexusSource => nexusSource.type === 'file').map(nexusSource => ({
                    url: nexusSource.url,
                    label: nexusSource.label
                  })) || []}
                  purstreamSources={bravoSources}
                  mp4Sources={mp4Sources}
                  disableCrossOrigin={activeSourceFollowsRedirect}
                  onPlayerPlay={handlePlayerPlay}
                  onPlayerPause={handlePlayerPause}
                  onPlayerTimeUpdate={handlePlayerTimeUpdate}
                  onPlayerSeeked={handlePlayerSeeked}
                  onPlayerEnded={handlePlayerEnded}
                  movieId={roomInfo.media?.mediaType === 'movie' ? roomInfo.media?.mediaId : undefined}
                  tvShowId={roomInfo.media?.mediaType === 'tv' ? roomInfo.media?.mediaId : undefined}
                  seasonNumber={roomInfo.media?.seasonNumber}
                  episodeNumber={roomInfo.media?.episodeNumber}
                  title={roomInfo.media?.title}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  {!currentMediaSrc ? t('watchParty.loadingMediaSource') :
                    !roomInfo?.media.src ? t('watchParty.mediaSourceNotAvailable') :
                      t('watchParty.waitingForPlaybackState')}
                </div>
              )}


              {pauseCountdown > 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-[9990]" style={{ pointerEvents: 'auto' }}>
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-center"
                  >
                    <div className="text-6xl md:text-8xl font-bold text-white mb-4">{pauseCountdown}</div>
                    <p className="text-xl text-gray-300 mb-4">⏸️ {t('watchParty.pauseInProgress')}</p>
                    {canControlPlayback && (
                      <button
                        onClick={handleCancelPauseTimer}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white"
                      >
                        {t('watchParty.cancelPause')}
                      </button>
                    )}
                  </motion.div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Chat Panel - fixed on mobile, side panel on desktop */}
        <AnimatePresence>
          {showChatPanel && participants.length > 0 && (
            <motion.div
              key="chat-panel"
              initial={{ x: 350, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 350, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="z-10 bg-black/90 backdrop-blur-md flex flex-col shadow-lg fixed bottom-0 left-0 right-0 w-full h-[40dvh] max-h-[40dvh] md:absolute md:top-0 md:right-0 md:bottom-0 md:left-auto md:h-full md:max-h-none md:border-l md:border-white/10 md:w-auto"
              style={{ width: typeof window !== 'undefined' && window.innerWidth >= 768 ? chatWidth : undefined }}
            >
              {/* Resize handle (desktop only) */}
              <div
                className="hidden md:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-red-500/30 active:bg-red-500/50 transition-colors z-20"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = chatWidth;
                  const onMove = (ev: MouseEvent) => {
                    const delta = startX - ev.clientX;
                    const newWidth = Math.max(280, Math.min(600, startW + delta));
                    // Bail-out: skip rAF schedule if width hasn't changed since last
                    // committed value. Avoids re-rendering the entire 1700-line tree
                    // on idle horizontal mouse jitter. — perf
                    if (newWidth === chatWidthRef.current) return;
                    if (resizeRafIdRef.current !== null) cancelAnimationFrame(resizeRafIdRef.current);
                    resizeRafIdRef.current = requestAnimationFrame(() => {
                      resizeRafIdRef.current = null;
                      setChatWidth(newWidth);
                    });
                  };
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (resizeRafIdRef.current !== null) {
                      cancelAnimationFrame(resizeRafIdRef.current);
                      resizeRafIdRef.current = null;
                    }
                  };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              />
              <div className="p-3 border-b border-white/10 flex items-center justify-between shrink-0">
                <h3 className="font-semibold">{t('watchParty.chat')} ({messages.filter(m => m.type === 'chat').length})</h3>
                <button onClick={() => setShowChatPanel(false)} className="p-1 hover:bg-white/10 rounded-md">
                  <X size={18} />
                </button>
              </div>

              {/* Twitch-style Vote Banner */}
              <AnimatePresence>
                {activeVote && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-b border-gray-700 overflow-hidden"
                  >
                    <div className="p-3 bg-white/5 border-b border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-purple-300 uppercase tracking-wide">🗳️ {t('watchParty.voteLabel')}</span>
                        <span className="text-xs text-orange-400 font-bold">⏱️ {voteCountdown}s</span>
                      </div>
                      <p className="text-sm text-gray-200 mb-3">
                        <span className="text-yellow-400 font-semibold">{activeVote.requestedByNickname}</span> {t('watchParty.requestsPauseOf', { nickname: '', duration: activeVote.requestedDuration })}
                      </p>

                      {/* Vote progress bar */}
                      <div className="flex gap-1 mb-2 h-2 rounded overflow-hidden bg-gray-700">
                        <div
                          className="bg-green-500 transition-all duration-300"
                          style={{ width: `${activeVote.totalParticipants > 0 ? (voteProgress.yesVotes / activeVote.totalParticipants) * 100 : 0}%` }}
                        />
                        <div
                          className="bg-red-500 transition-all duration-300"
                          style={{ width: `${activeVote.totalParticipants > 0 ? (voteProgress.noVotes / activeVote.totalParticipants) * 100 : 0}%` }}
                        />
                      </div>

                      {/* Vote counts */}
                      <div className="flex justify-between text-xs text-gray-400 mb-3">
                        <span className="text-green-400">✓ {voteProgress.yesVotes}</span>
                        <span>{voteProgress.totalVotes}/{activeVote.totalParticipants} {t('watchParty.votesLabel')}</span>
                        <span className="text-red-400">✗ {voteProgress.noVotes}</span>
                      </div>

                      {/* Vote buttons */}
                      {!hasVoted ? (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleCastVote(true)}
                            className="flex-1 py-2 bg-green-600 hover:bg-green-700 rounded-lg font-semibold text-sm transition-colors"
                          >
                            ✓ {t('watchParty.voteYes')}
                          </button>
                          <button
                            onClick={() => handleCastVote(false)}
                            className="flex-1 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold text-sm transition-colors"
                          >
                            ✗ {t('watchParty.voteNo')}
                          </button>
                        </div>
                      ) : (
                        <div className="py-2 bg-gray-700/50 rounded-lg text-center text-sm text-gray-300">
                          ✓ {t('watchParty.votedWaiting')}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Chat messages - scrollable container */}
              <div
                ref={chatContainerRef}
                data-lenis-prevent
                className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar"
              >
                {messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-gray-400 text-center text-sm">
                      {t('watchParty.noMessagesBeFirst')}
                    </p>
                  </div>
                ) : (
                  messages.map((message) => {
                    // Skip deleted or muted messages
                    if (deletedMessages.has(message.id)) return null;
                    if (message.type !== 'system' && mutedUsers.has(message.senderId)) return null;

                    return (
                      <ChatMessageItem
                        key={message.id}
                        message={message}
                        isOwnMessage={message.senderId === userId}
                        isHostMessage={roomInfo?.hostId === message.senderId}
                        isMutedSender={mutedUsers.has(message.senderId)}
                        isCurrentUserHost={isCurrentUserHost}
                        t={t}
                        onToggleMute={toggleMuteUser}
                        onDeleteMessage={handleDeleteMessage}
                      />
                    );
                  })
                )}
              </div>

              {/* Chat input - fixed at bottom */}
              <div className="p-3 border-t border-white/10 bg-black/60 shrink-0">
                {/* Quick emoji reactions */}
                <div className="flex gap-1 mb-2 overflow-x-auto pb-1">
                  {REACTION_EMOJIS.slice(0, 6).map(emoji => (
                    <button
                      key={emoji}
                      onClick={() => handleSendReaction(emoji)}
                      className="p-1.5 hover:bg-gray-700 rounded-md transition-colors text-lg"
                      title={t('watchParty.sendEmoji', { emoji })}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                {/* Markdown formatting buttons */}
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {([
                    { icon: 'B', wrap: ['**', '**'], cls: 'font-bold', title: 'Gras' },
                    { icon: 'I', wrap: ['*', '*'], cls: 'italic', title: 'Italique' },
                    { icon: 'S', wrap: ['~~', '~~'], cls: 'line-through', title: 'Barré' },
                    { icon: '<>', wrap: ['`', '`'], cls: 'font-mono', title: 'Code' },
                    { icon: '{ }', wrap: ['```\n', '\n```'], cls: 'font-mono', title: 'Bloc de code' },
                    { icon: '🔗', wrap: ['[', '](url)'], cls: '', title: 'Lien' },
                    { icon: '❝', wrap: ['> ', ''], cls: '', title: 'Citation' },
                    { icon: '•', wrap: ['- ', ''], cls: '', title: 'Liste' },
                    { icon: '1.', wrap: ['1. ', ''], cls: '', title: 'Liste numérotée' },
                    { icon: 'H', wrap: ['## ', ''], cls: 'font-bold', title: 'Titre' },
                  ] as const).map((btn, i) => (
                    <button
                      key={i}
                      type="button"
                      title={btn.title}
                      onClick={() => {
                        const ta = chatInputRef.current;
                        if (!ta) return;
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        const selected = newMessage.slice(start, end);
                        const before = newMessage.slice(0, start);
                        const after = newMessage.slice(end);
                        const inserted = `${btn.wrap[0]}${selected || 'texte'}${btn.wrap[1]}`;
                        setNewMessage(before + inserted + after);
                        setTimeout(() => {
                          ta.focus();
                          const pos = start + btn.wrap[0].length;
                          ta.setSelectionRange(pos, pos + (selected || 'texte').length);
                        }, 0);
                      }}
                      className={`px-2 py-1 rounded-md text-xs transition-colors bg-white/5 hover:bg-white/15 text-white/50 hover:text-white border border-white/5 hover:border-white/20 ${btn.cls}`}
                    >
                      {btn.icon}
                    </button>
                  ))}
                </div>
                {/* Live markdown preview (debounced 150ms — see debouncedNewMessage) */}
                {newMessage.trim() && (
                  <div className="px-3 py-2 mb-1.5 rounded-lg bg-white/5 border border-white/5 text-sm max-h-20 overflow-y-auto" data-lenis-prevent>
                    <ReactMarkdown remarkPlugins={previewRemarkPlugins} components={CHAT_MD_COMPONENTS}>
                      {debouncedNewMessage}
                    </ReactMarkdown>
                  </div>
                )}
                <form onSubmit={sendChatMessageWithReactions} className="flex items-end gap-2">
                  <textarea
                    ref={chatInputRef}
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendChatMessageWithReactions(e);
                      }
                    }}
                    placeholder={!chatEnabled && !isCurrentUserHost ? t('watchParty.chatDisabled') : t('watchParty.yourMessage')}
                    disabled={socketState !== SocketState.CONNECTED || (!chatEnabled && !isCurrentUserHost)}
                    rows={2}
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 placeholder-white/30 text-white disabled:opacity-50 resize-y min-h-[42px] max-h-32 overflow-y-auto"
                  />
                  <button
                    type="submit"
                    disabled={!newMessage.trim() || socketState !== SocketState.CONNECTED}
                    className={`p-2.5 rounded-xl transition-colors ${newMessage.trim() && socketState === SocketState.CONNECTED
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-white/5 text-white/20 cursor-not-allowed'
                      }`}
                  >
                    <Send size={18} />
                  </button>
                </form>
                <EmojiAutocomplete textareaRef={chatInputRef} value={newMessage} onChange={setNewMessage} maxLength={500} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Participants Panel - modal overlay */}
        <AnimatePresence>
          {showParticipantsPanel && roomInfo && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              onClick={() => setShowParticipantsPanel(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-black/90 border border-white/10 shadow-2xl rounded-xl max-w-md w-full p-5 md:p-6 backdrop-blur-md"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-lg font-semibold">{t('watchParty.participants')} ({participants.length}/{roomInfo.maxParticipants})</h3>
                  <button onClick={() => setShowParticipantsPanel(false)} className="p-1.5 hover:bg-white/10 rounded-full text-white/50 hover:text-white">
                    <X size={20} />
                  </button>
                </div>
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-200">{t('watchParty.inviteFriends')}</p>
                    <div className="flex items-center gap-2">
                      <button onClick={handleCopyInviteLink} className="p-2 bg-gray-700 hover:bg-gray-600 rounded-md flex items-center gap-1.5 text-xs text-gray-300 hover:text-white">
                        {linkCopied ? <><Check size={16} className="text-green-400" /> {t('watchParty.copiedLabel')}</> : <><Clipboard size={15} /> {t('watchParty.copyLabel')}</>}
                      </button>
                      <button
                        onClick={() => {
                          if (navigator.share && roomInfo) {
                            navigator.share({
                              title: t('watchParty.shareTitle', { title: roomInfo.media.title }),
                              text: t('watchParty.shareText', { code: roomInfo.code }),
                              url: getShareLink(roomInfo.code)
                            }).catch(err => console.warn("Share API error:", err));
                          } else { handleCopyInviteLink(); }
                        }}
                        className="p-2 bg-gray-700 hover:bg-gray-600 rounded-md text-gray-300 hover:text-white"
                        title={t('watchParty.webShareApi')}
                      >
                        <Share2 size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="bg-white/5 p-2.5 rounded-lg flex items-center justify-between border border-white/10">
                    <code className="font-mono font-bold text-indigo-400 text-sm tracking-wider">{roomInfo.code}</code>
                    <span className="text-xs text-gray-400">{t('watchParty.invitationCode')}</span>
                  </div>
                </div>
                <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                  {participants.map((participant) => (
                    <div key={participant.id} className={`py-2.5 px-3.5 rounded-lg flex items-center justify-between transition-colors ${participant.id === userId ? 'bg-white/10 border border-white/10' : 'bg-transparent hover:bg-white/5'}`}>
                      <div className="flex items-center gap-2.5">
                        {/* Connection status indicator */}
                        <div className={`w-2.5 h-2.5 rounded-full ${participant.isActive ? 'bg-green-500 ring-green-400' : 'bg-gray-500 ring-gray-600'} ring-1 ring-offset-1 ring-offset-gray-800`}></div>
                        <span className={`font-medium text-sm ${participant.id === roomInfo.hostId ? 'text-yellow-400' : coHosts.includes(participant.id) ? 'text-blue-400' : 'text-gray-100'}`}>
                          {participant.nickname}
                          {participant.id === userId && <span className="text-xs text-gray-400"> {t('watchParty.youLabel')}</span>}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {/* Role badges and actions */}
                        {participant.id === roomInfo.hostId ? (
                          <span className="text-xs bg-yellow-500/30 text-yellow-300 px-2 py-0.5 rounded-full font-semibold tracking-wide">{t('watchParty.hostRole')}</span>
                        ) : coHosts.includes(participant.id) ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs bg-blue-500/30 text-blue-300 px-1.5 py-0.5 rounded text-[10px]">{t('watchParty.coHostRole')}</span>
                            {isCurrentUserHost && (
                              <button
                                onClick={() => handleRevokeControl(participant.id)}
                                className="p-1 text-gray-400 hover:text-red-400 rounded transition-colors"
                                title={t('watchParty.revokeControl')}
                              >
                                <XCircle size={14} />
                              </button>
                            )}
                          </div>
                        ) : isCurrentUserHost && participant.id !== userId && (
                          <button
                            onClick={() => handleKickParticipant(participant.id)}
                            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700/60 rounded-full transition-colors"
                            title={t('watchParty.kickFromParty')}
                          >
                            <UserX size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating chat button - shown when chat is hidden */}
      {/* z-[45] : au-dessus de la barre de controles du lecteur (z-40), sinon le bouton
          passe dessous et devient incliquable ; reste sous les modales (z-50). */}
      {!showChatPanel && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowChatPanel(true)}
          className="fixed bottom-6 right-6 z-[45] p-4 bg-red-600 hover:bg-red-700 rounded-full shadow-lg transition-colors"
          title={t('watchParty.openChat')}
        >
          <MessageSquare size={24} className="text-white" />
        </motion.button>
      )}

      {/* Mobile invite button - shown only when chat is hidden */}
      {roomInfo && !showChatPanel && (
        <div className="hidden bg-gray-800/90 backdrop-blur-sm border-t border-gray-700/60 py-2 px-4 shadow-top shrink-0">
          <button onClick={handleCopyInviteLink} className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 py-2 rounded-lg font-medium text-sm transition-colors">
            <Share2 size={18} />
            {linkCopied ? t('watchParty.linkCopiedSuccess') : t('watchParty.inviteFriends')}
          </button>
        </div>
      )}

      {/* Pause Timer Modal */}
      <AnimatePresence>
        {showPauseTimerModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowPauseTimerModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-black/90 border border-white/10 shadow-2xl rounded-xl max-w-sm w-full p-6 backdrop-blur-md"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Clock size={20} /> {canControlPlayback ? t('watchParty.pauseTimerTitle') : t('watchParty.requestPause')}
              </h3>
              <p className="text-gray-400 text-sm mb-4">
                {canControlPlayback
                  ? t('watchParty.pauseHostDesc')
                  : t('watchParty.pauseVoteDesc')}
              </p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[30, 60, 120, 180, 300, 600].map(seconds => (
                  <button
                    key={seconds}
                    onClick={() => canControlPlayback ? handleStartPauseTimer(seconds) : handleRequestPauseVote(seconds)}
                    className="p-3 bg-gray-700 hover:bg-indigo-600 rounded-lg text-center transition-colors"
                  >
                    <div className="text-lg font-bold">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`}</div>
                    <div className="text-xs text-gray-400">
                      {seconds < 60 ? t('watchParty.secondsLabel') : seconds >= 60 && seconds < 120 ? t('watchParty.minuteLabel') : t('watchParty.minutesLabel')}
                    </div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowPauseTimerModal(false)}
                className="w-full p-2 bg-gray-700 hover:bg-gray-600 rounded-lg"
              >
                {t('watchParty.cancel')}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Control Request Approval Panel (Host only) */}
      <AnimatePresence>
        {isCurrentUserHost && pendingRequests.length > 0 && (
          <motion.div
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            className="fixed bottom-4 right-4 z-[46] bg-black/90 border border-white/10 rounded-xl shadow-2xl p-4 max-w-xs w-full backdrop-blur-md"
          >
            <h4 className="text-sm font-semibold mb-3 flex items-center gap-2 text-yellow-400">
              <Hand size={16} /> {t('watchParty.controlRequests')}
            </h4>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {pendingRequests.map(request => (
                <div key={request.participantId} className="flex items-center justify-between bg-gray-700/50 p-2 rounded-lg">
                  <span className="text-sm font-medium truncate">{request.nickname}</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleApproveControl(request.participantId)}
                      className="p-1.5 bg-green-600 hover:bg-green-700 rounded-md"
                      title={t('watchParty.approve')}
                    >
                      <CheckCircle2 size={14} />
                    </button>
                    <button
                      onClick={() => handleDenyControl(request.participantId)}
                      className="p-1.5 bg-red-600 hover:bg-red-700 rounded-md"
                      title={t('watchParty.deny')}
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Panel */}
      <AnimatePresence>
        {showSettingsPanel && roomInfo && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowSettingsPanel(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-black/90 border border-white/10 shadow-2xl rounded-2xl max-w-md w-full p-6 backdrop-blur-md max-h-[80vh] overflow-y-auto custom-scrollbar overscroll-contain"
              data-lenis-prevent
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Settings size={20} /> {t('watchParty.settings')}
                </h2>
                <button onClick={() => setShowSettingsPanel(false)} className="p-1 hover:bg-white/10 rounded-lg">
                  <X size={20} />
                </button>
              </div>

              <div className="space-y-4">
                {/* Room info */}
                <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                  <p className="text-xs text-white/40 uppercase tracking-wider mb-2">{t('watchParty.invitationCode')}</p>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xl font-bold text-white tracking-widest flex-1">{roomInfo.code}</span>
                    <button onClick={() => { handleCopyInviteLink(); }} className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm transition-colors">
                      {linkCopied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>

                {/* Host-only controls */}
                {isCurrentUserHost && (
                  <>
                    {/* Change media */}
                    <button
                      onClick={() => { setShowSettingsPanel(false); setShowChangeMediaModal(true); }}
                      className="w-full flex items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-red-500/30 transition-all text-left"
                    >
                      <RefreshCw size={20} className="text-red-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-white">{t('watchParty.changeMedia')}</p>
                        <p className="text-xs text-white/40">{t('watchParty.changeMediaDesc')}</p>
                      </div>
                    </button>

                    {/* Control mode */}
                    <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                      <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{t('watchParty.controlModeLabel')}</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { if (controlMode !== 'host-only') handleToggleControlMode(); }}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${controlMode === 'host-only' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                        >
                          {t('watchParty.hostOnlyMode')}
                        </button>
                        <button
                          onClick={() => { if (controlMode !== 'democratic') handleToggleControlMode(); }}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${controlMode === 'democratic' ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                        >
                          🎮 {t('watchParty.democraticMode')}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-white/40 uppercase tracking-wider">{t('watchParty.syncModeLabel')}</p>
                      <p className="mt-1 text-sm text-white/70">{syncStatusLabel}</p>
                    </div>
                    <button
                      onClick={() => setShowSyncInfoModal(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Info size={14} />
                      {t('watchParty.helpLabel')}
                    </button>
                  </div>

                  {isCurrentUserHost ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      <button
                        onClick={() => { if (syncMode !== 'classic') handleSetSyncMode('classic'); }}
                        className={`rounded-lg px-3 py-3 text-left text-sm font-medium transition-all ${syncMode === 'classic' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}
                      >
                        <p>{t('watchParty.syncModeClassic')}</p>
                        <p className="mt-1 text-xs text-current/80">{t('watchParty.syncModeClassicDesc')}</p>
                      </button>
                      <button
                        onClick={() => { if (syncMode !== 'pro') handleSetSyncMode('pro'); }}
                        className={`rounded-lg px-3 py-3 text-left text-sm font-medium transition-all ${syncMode === 'pro' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}
                      >
                        <p>{t('watchParty.syncModePro')}</p>
                        <p className="mt-1 text-xs text-current/80">{t('watchParty.syncModeProDesc')}</p>
                      </button>
                    </div>
                  ) : (
                    <div className={`inline-flex items-center rounded-full border px-3 py-2 text-sm ${syncStatusClasses}`}>
                      {syncMode === 'pro' ? 'Sync Pro' : t('watchParty.syncModeClassic')}
                    </div>
                  )}
                </div>

                {/* Pause timer */}
                <button
                  onClick={() => { setShowSettingsPanel(false); setShowPauseTimerModal(true); }}
                  className="w-full flex items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-left"
                >
                  <Clock size={20} className="text-blue-400 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-white">
                      {canControlPlayback ? t('watchParty.launchTimedPause') : t('watchParty.requestPauseVote')}
                    </p>
                    <p className="text-xs text-white/40">{t('watchParty.pauseDesc')}</p>
                  </div>
                </button>

                {/* Visibility toggle (host) */}
                {isCurrentUserHost && (
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{t('watchParty.visibility')}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => socketRef.current?.emit('room:setVisibility', { isPublic: false })}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${!roomInfo.isPublic ? 'bg-red-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                      >
                        🔒 {t('watchParty.private')}
                      </button>
                      <button
                        onClick={() => socketRef.current?.emit('room:setVisibility', { isPublic: true })}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${roomInfo.isPublic ? 'bg-green-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                      >
                        🌐 {t('watchParty.public')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Chat toggle (host) */}
                {isCurrentUserHost && (
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-white">{t('watchParty.chatToggle')}</p>
                      <p className="text-xs text-white/40">{t('watchParty.chatToggleDesc')}</p>
                    </div>
                    <button
                      onClick={() => socketRef.current?.emit('room:toggleChat', { enabled: !chatEnabled })}
                      className={`relative w-12 h-6 rounded-full transition-colors ${chatEnabled ? 'bg-green-600' : 'bg-white/10'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${chatEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                )}

                {/* Max participants (host) */}
                {isCurrentUserHost && (
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{t('watchParty.maxParticipants')}</p>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={2}
                        max={50}
                        value={roomInfo.maxParticipants || 10}
                        onChange={(e) => socketRef.current?.emit('room:setMaxParticipants', { max: Number(e.target.value) })}
                        className="flex-1 accent-red-500"
                      />
                      <span className="min-w-[3rem] px-2 py-1 bg-white/5 border border-white/10 rounded-xl text-center font-mono text-sm text-white">
                        {roomInfo.maxParticipants || 10}
                      </span>
                    </div>
                    <p className="text-[10px] text-white/30 mt-1">{participants.length} {t('watchParty.currentlyConnected')}</p>
                  </div>
                )}

                {/* Muted users */}
                {mutedUsers.size > 0 && (
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{t('watchParty.mutedUsers')}</p>
                    <div className="space-y-2">
                      {Array.from(mutedUsers).map(id => {
                        const p = participants.find(p => p.id === id);
                        return (
                          <div key={id} className="flex items-center justify-between">
                            <span className="text-sm text-white/70">{p?.nickname || id.slice(0, 8)}</span>
                            <button onClick={() => toggleMuteUser(id)}
                              className="px-3 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/50 transition-colors">
                              {t('watchParty.unmute')}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Leave / End party */}
                <button
                  onClick={() => { window.history.back(); }}
                  className="w-full py-3 rounded-xl bg-red-600/20 border border-red-500/30 hover:bg-red-600/30 text-red-400 text-sm font-medium transition-all"
                >
                  {t('watchParty.quitLabel')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Change media modal (host only) — gated on isOpen so the modal's
          internal state, debounced search, etc. don't live inside the React
          tree (and re-evaluate on every parent re-render) when closed. — perf */}
      {showChangeMediaModal && (
        <ChangeMediaModal
          isOpen={showChangeMediaModal}
          onClose={() => setShowChangeMediaModal(false)}
          onSelect={handleChangeMedia}
        />
      )}

      {showSyncInfoModal && (
        <WatchPartySyncInfoModal
          isOpen={showSyncInfoModal}
          onClose={() => setShowSyncInfoModal(false)}
        />
      )}
    </div>
  );
};

export default WatchPartyRoom;
