/**
 * Détection et wrappers du bridge exposé par l'app native Movix (Android).
 *
 * L'app RN injecte avant chargement de page un objet `window.MovixBridge`
 * dont la simple présence (`isApp === true`) est l'indicateur le plus
 * fiable que la page tourne dans l'app — plus robuste qu'un sniff UA.
 *
 * Toutes les méthodes retournent une Promise. Hors app, elles throw
 * immédiatement : les call sites doivent gate via `isMovixApp()`.
 */

export type MovixDownloadStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export type MovixDownloadType = 'movie' | 'series' | 'animes';

export interface MovixDownloadMetadata {
  type?: MovixDownloadType;
  tmdbId?: number | string;
  title?: string;
  poster?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  language?: string;
  quality?: string;
  provider?: string;
  host?: string;
  originalLink?: string;
  // Champs libres : le natif ne les inspecte pas, on les relit tel quel.
  [k: string]: unknown;
}

export interface MovixDownloadStartOpts {
  url: string;
  filename: string;
  subFolder?: string;
  headers?: Record<string, string>;
  metadata?: MovixDownloadMetadata;
}

export interface MovixDownloadEntry {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  totalBytes: number;
  downloadedBytes: number;
  status: MovixDownloadStatus;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  metadata: MovixDownloadMetadata;
  headers: Record<string, string>;
}

export interface MovixDownloadProgressEvent {
  event: 'progress';
  payload: {
    id: string;
    bytesDownloaded: number;
    bytesTotal: number;
    speedBytesPerSec: number;
  };
}

export interface MovixDownloadStateEvent {
  event: 'state';
  payload: MovixDownloadEntry;
}

export type MovixDownloadEvent = MovixDownloadProgressEvent | MovixDownloadStateEvent;

interface MovixBridge {
  isApp: true;
  platform: 'android' | 'ios';
  version: number;
  download: {
    start: (opts: MovixDownloadStartOpts) => Promise<{ id: string; targetPath: string }>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    delete: (id: string) => Promise<void>;
    launch: (id: string) => Promise<void>;
    list: () => Promise<MovixDownloadEntry[]>;
    get: (id: string) => Promise<MovixDownloadEntry | null>;
    subscribe: (cb: (evt: MovixDownloadEvent) => void) => () => void;
  };
}

declare global {
  interface Window {
    MovixBridge?: MovixBridge;
  }
}

export function getMovixBridge(): MovixBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.MovixBridge;
  if (!bridge || bridge.isApp !== true) return null;
  return bridge;
}

export function isMovixApp(): boolean {
  return getMovixBridge() !== null;
}

export function isMovixAndroid(): boolean {
  const b = getMovixBridge();
  return b !== null && b.platform === 'android';
}

/**
 * Tag « sous-dossier » sûr pour l'organisation sur disque côté app.
 * On garde du JSON court pour la metadata, mais sur disque on range par type.
 */
export function buildDownloadSubFolder(metadata: MovixDownloadMetadata | undefined): string {
  const type = metadata?.type;
  if (type === 'movie') return 'movies';
  if (type === 'series') return 'series';
  if (type === 'animes') return 'animes';
  return 'misc';
}
