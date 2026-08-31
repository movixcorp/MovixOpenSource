/**
 * Generates a random code for watchparty rooms.
 * @param length The length of the code to generate
 * @returns A random alphanumeric code
 */
export const generateRandomCode = (length: number): string => {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed similar looking characters (0, O, 1, I)
  let result = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    result += charset.charAt(randomIndex);
  }

  return result;
};

/**
 * Jeton d'accès à une room.
 *
 * Le serveur exige désormais un token — délivré par POST /create (hôte) ou
 * POST /join (membre) — pour lire `/api/watchparty/room/:roomId` et pour ouvrir
 * la socket. Connaître le `roomId` ne suffit plus à entrer dans une room.
 *
 * Stocké en `sessionStorage` : le token survit à un rafraîchissement de page
 * mais reste cantonné à l'onglet et disparaît à sa fermeture.
 */
const ROOM_TOKEN_PREFIX = 'watchPartyToken:';

export const storeRoomToken = (roomId: string, token: string): void => {
  if (!roomId || !token) return;
  try {
    sessionStorage.setItem(`${ROOM_TOKEN_PREFIX}${roomId}`, token);
  } catch {
    // sessionStorage indisponible (mode privé strict) : on continue sans persistance.
  }
};

export const getRoomToken = (roomId: string): string | null => {
  if (!roomId) return null;
  try {
    return sessionStorage.getItem(`${ROOM_TOKEN_PREFIX}${roomId}`);
  } catch {
    return null;
  }
};

export const clearRoomToken = (roomId: string): void => {
  if (!roomId) return;
  try {
    sessionStorage.removeItem(`${ROOM_TOKEN_PREFIX}${roomId}`);
  } catch {
    // Rien à faire.
  }
};

/**
 * Socket connection state for watchparty
 */
export enum SocketState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * Participant in a watchparty
 */
export interface Participant {
  id: string;
  nickname: string;
  isHost: boolean;
  isActive: boolean;
  joinedAt: number;
}

/**
 * Chat message in a watchparty
 */
export interface ChatMessage {
  id: string;
  senderId: string;
  senderNickname: string;
  text: string;
  timestamp: number;
  type: 'chat' | 'system' | 'action';
  deleted?: boolean;  // Flag to indicate if a message has been deleted
}

/**
 * Playback state for the media
 */
export interface PlaybackState {
  isPlaying: boolean;
  position: number;
  updatedAt: number;
  updatedBy: string | null;
}

export type SyncMode = 'classic' | 'pro';

export type SyncAction = 'play' | 'pause' | 'seek' | 'heartbeat' | 'ended';

export type ParticipantSyncStatus = 'perfect' | 'adjusting' | 'unstable';

export interface SyncProbePayload {
  probeId: string;
  clientSentAt: number;
}

export interface SyncProbeResult {
  probeId: string;
  clientSentAt: number;
  serverReceivedAt: number;
  serverSentAt: number;
  clientReceivedAt?: number;
}

export interface ScheduledPlaybackEvent {
  action: Exclude<SyncAction, 'heartbeat'>;
  position: number;
  scheduledAt: number;
  serverNow: number;
  updatedBy: string | null;
}

/**
 * Individual Nightflix M3U8 stream information
 */
export interface NightflixSourceInfo {
  src: string;         // M3U8 URL
  quality?: string;    // e.g., "1080p", "720p", or a label
  language?: string;   // e.g., "FR", "EN"
  label?: string;      // A display label for the source
}

/**
 * Individual Nexus source information
 */
export interface NexusSourceInfo {
  url: string;         // Source URL
  label: string;       // Display label for the source
  type: 'hls' | 'file'; // Type of Nexus source
}

/**
 * Individual Bravo source information
 */
export interface BravoSourceInfo {
  url: string;         // Source URL
  label: string;       // Display label for the source (e.g., "🦁 Bravo")
  language?: string;   // Language of the source
  isVip?: boolean;     // Whether the source requires VIP
}

/**
 * Individual MP4 source information
 */
export interface Mp4SourceInfo {
  url: string;         // Source URL
  label: string;       // Display label for the source
  language?: string;   // Language of the source
  isVip?: boolean;     // Whether the source requires VIP
  /**
   * Le CDN répond une redirection vers un autre domaine (SwiftFlux).
   *
   * Le salon doit alors retirer `crossOrigin` de l'élément vidéo : en mode CORS
   * le navigateur refuse de suivre la 302 et la lecture échoue. Le drapeau
   * voyage avec la source parce que le salon, lui, n'a aucun moyen de deviner
   * d'où elle vient.
   */
  followsRedirect?: boolean;
}

/**
 * Caption/subtitle information
 */
export interface CaptionInfo {
  label: string;       // Caption label (e.g., "French", "English")
  file: string;        // Caption file URL (VTT/SRT)
}

/**
 * Control request from a participant
 */
export interface ControlRequest {
  participantId: string;
  nickname: string;
  requestedAt: number;
}

/**
 * Pause timer state
 */
export interface PauseTimer {
  endTime: number;
  startedBy: string;
  duration: number;
}

/**
 * Floating reaction
 */
export interface FloatingReaction {
  id: string;
  emoji: string;
  senderId: string;
  senderNickname: string;
  timestamp: number;
}

/**
 * Control state
 */
export interface ControlState {
  controlMode: 'host-only' | 'democratic';
  coHosts: string[];
  pendingRequests: ControlRequest[];
}

/**
 * Watch party room info
 */
export interface WatchPartyRoom {
  id: string;
  code: string;
  hostId: string;
  maxParticipants: number;
  isPublic: boolean;
  syncMode: SyncMode;
  chatEnabled?: boolean;
  controlMode: 'host-only' | 'democratic';
  coHosts: string[];
  pendingControlRequests: ControlRequest[];
  readyState: Record<string, boolean>;
  pauseTimer: PauseTimer | null;
  media: {
    src: string; // Main/default source URL
    title: string;
    poster?: string;
    mediaType: 'movie' | 'tv';
    mediaId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    nightflixSources?: NightflixSourceInfo[]; // Array of available Nightflix streams
    nexusSources?: NexusSourceInfo[]; // Array of available Nexus sources
    bravoSources?: BravoSourceInfo[]; // Array of available Bravo/PurStream sources
    mp4Sources?: Mp4SourceInfo[]; // Array of available generic MP4/file sources
    captions?: CaptionInfo[]; // Array of available subtitles/captions
    currentNexusSource?: NexusSourceInfo; // Currently selected Nexus source
    currentBravoSource?: BravoSourceInfo; // Currently selected Bravo source
  };
  createdAt: number;
  participants: Participant[];
}

/**
 * Formats a timestamp in HH:MM:SS format
 */
export const formatTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Get a share link for a watchparty
 */
export const getShareLink = (roomCode: string): string => {
  const baseUrl = window.location.origin;
  return `${baseUrl}/watchparty/join/${roomCode}`;
};

/**
 * Calculate time difference and determine if sync is needed
 * @param localTime Current local playback time
 * @param remoteTime Remote playback time
 * @param threshold Threshold in seconds before sync is needed
 * @returns Whether sync is needed and the time difference
 */
export const shouldSyncPlayback = (
  localTime: number,
  remoteTime: number,
  threshold: number = 3
): { needsSync: boolean; difference: number } => {
  const difference = Math.abs(localTime - remoteTime);
  return {
    needsSync: difference > threshold,
    difference
  };
}; 
