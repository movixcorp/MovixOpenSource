/**
 * Bridge React Native <-> WebView
 *
 * Handles:
 *   - GM_* messages (userscript HTTP via native fetch)
 *   - CASTSHIM_* messages (chrome.cast shim ↔ native Cast)
 */

import { type RefObject } from 'react';
import { NativeModules, Platform } from 'react-native';
import type WebView from 'react-native-webview';
import {
  type CastLoadMetadata,
  type NativeCastStatus,
  type PreparedCastSource,
  getCastCapabilities,
  getCastStatus,
  getRelayDisclosurePreference,
  isCastSupported,
  loadCastMedia,
  openCastBatterySettings,
  pauseCast,
  playCast,
  requestCastRelayNotificationPermission,
  seekCastTo,
  setRelayDisclosureSuppressed,
  stopCast,
  subscribeCastStatus,
} from './cast';
import { applyMediaProxyHeaderRules } from './mediaProxyHeaders';
import {
  type PictureInPictureEvent,
  acknowledgePictureInPictureRestoreApplied,
  acknowledgePictureInPictureWebViewPaused,
  cancelPictureInPictureHandoff,
  enterPictureInPicture,
  enterPreparedPictureInPicture,
  exitPictureInPicture,
  getPreparedNativePlaybackSourceProtocolVersion,
  isNativePlaybackHandoffId,
  normalizePreparedNativePlaybackSource,
  preparePictureInPictureSource,
  setPictureInPicturePlaybackActive,
  subscribePictureInPicture,
} from './pictureInPicture';
import type { PreparedNativePlaybackSource } from './nativePlayback';
import { setPlaybackAwakeOwner } from './playbackAwake';
import {
  createCastLoadIdentity,
  createCastLoadSingleFlight,
  type CastLoadSingleFlight,
} from './castLoadSingleFlight';

/** Minimal interface required by the shim helpers — satisfied by both WebView and WebViewBrowserRef. */
interface InjectableRef {
  injectJavaScript: (script: string) => void;
}

type CastShimRequest =
  | { type: 'CASTSHIM_INIT'; id: string; capability: string }
  | {
      type: 'CASTSHIM_LOAD_MEDIA';
      id: string;
      capability: string;
      source: PreparedCastSource;
      metadata: CastLoadMetadata & { currentTime?: number };
    }
  | { type: 'CASTSHIM_GET_STATUS'; id: string; capability: string; refresh?: boolean }
  | { type: 'CASTSHIM_PLAY'; id: string; capability: string }
  | { type: 'CASTSHIM_PAUSE'; id: string; capability: string }
  | { type: 'CASTSHIM_SEEK_TO'; id: string; capability: string; seconds: number }
  | { type: 'CASTSHIM_STOP'; id: string; capability: string }
  | { type: 'CASTSHIM_GET_RELAY_DISCLOSURE_PREFERENCE'; id: string; capability: string }
  | {
      type: 'CASTSHIM_SET_RELAY_DISCLOSURE_SUPPRESSED';
      id: string;
      capability: string;
      suppressed: boolean;
    }
  | { type: 'CASTSHIM_OPEN_BATTERY_SETTINGS'; id: string; capability: string }
  | { type: 'CASTSHIM_REQUEST_NOTIFICATION_PERMISSION'; id: string; capability: string };

type PipShimRequest =
  | { type: 'PIPSHIM_ENTER'; id: string; capability: string }
  | { type: 'PIPSHIM_EXIT'; id: string; capability: string }
  | { type: 'PIPSHIM_WEBVIEW_PAUSED'; id: string; capability: string }
  | {
      type: 'PIPSHIM_RESTORE_APPLIED';
      id: string;
      capability: string;
      ok: boolean;
    }
  | {
      type: 'PIPSHIM_PREPARED_SOURCE';
      id: string;
      capability: string;
      source: PreparedNativePlaybackSource;
    };

const CAST_SOURCE_MAX_URL_LENGTH = 16_384;
const CAST_SOURCE_MAX_HEADER_NAME_LENGTH = 128;
const CAST_SOURCE_MAX_HEADER_VALUE_LENGTH = 8_192;
const CAST_SOURCE_MAX_HEADERS = 32;
const CAST_SOURCE_MAX_TRACKS = 16;
const CAST_INLINE_VTT_MAX_CHARS = 2 * 1024 * 1024;
const CAST_TITLE_MAX_LENGTH = 256;
const CAST_TRACK_LABEL_MAX_LENGTH = 128;
const CAST_TRACK_LANGUAGE_MAX_LENGTH = 35;
const MOVIX_PLAYBACK_AWAKE_V1 = 'MOVIX_PLAYBACK_AWAKE_V1';
const CAST_CAPABILITY_PATTERN = /^[a-f0-9]{32}$/;
const PIP_CAPABILITY_PATTERN = /^[a-f0-9]{32}$/;
const MEDIA_PROXY_CAPABILITY_PATTERN = /^[a-f0-9]{32}$/;
const MEDIA_PROXY_MAX_RETIRED_GENERATIONS = 32;
const castShimCapabilities = new WeakMap<object, string>();
type PipShimCapability = {
  capability: string;
  generation: number;
  navigationGeneration: number | null;
};
type PendingPipHandoff = PipShimCapability & {
  id: string;
  source: PreparedNativePlaybackSource;
};
type ActivePipHandoff = PipShimCapability & {
  id: string;
  invalidated: Promise<void>;
  invalidate: () => void;
  invalidatedFlag: boolean;
  nativeStarted: boolean;
  nativeReady: boolean;
  nativeInactive: boolean;
  exitRequested: boolean;
  restoreRequested: boolean;
  restoreAcknowledging: boolean;
  webViewPauseAcknowledged: boolean;
  restoreAcknowledged: boolean;
  restoreTimeout?: ReturnType<typeof setTimeout>;
  entering: boolean;
};
const PIP_NATIVE_PREPARE_TIMEOUT_MS = 15_000;
const PIP_NATIVE_CLEANUP_TIMEOUT_MS = 2_000;
const PIP_NATIVE_RESTORE_TIMEOUT_MS = 5_000;
const PIP_MAX_RETIRED_HANDOFF_IDS = 32;
let nextPipShimGeneration = 1;
const pipShimCapabilities = new WeakMap<object, PipShimCapability>();
const pendingPipHandoffs = new WeakMap<object, PendingPipHandoff>();
const activePipHandoffs = new WeakMap<object, ActivePipHandoff>();
const retiredPipHandoffIds = new WeakMap<object, Set<string>>();
type MediaProxyCapability = {
  capability: string;
  generation: string;
  navigationGeneration: number;
  topLevelUrl: string;
};
const mediaProxyCapabilities = new WeakMap<object, MediaProxyCapability>();
const retiredMediaProxyGenerations = new WeakMap<object, Set<string>>();
const castLoadSingleFlights = new WeakMap<object, CastLoadSingleFlight>();
const CAST_HEADER_ALLOW_LIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'origin',
  'range',
  'referer',
  'user-agent',
]);

type ParsedAbsoluteHttpUrl = {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
  origin: string;
};

function parseAbsoluteHttpUrl(value: unknown): ParsedAbsoluteHttpUrl | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || /[\u0000-\u0020\\]/.test(value)
  ) {
    return null;
  }
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:` as 'http:' | 'https:';
  const authority = match[2];
  if (!authority || authority.includes('@')) return null;

  let hostname = '';
  let port = '';
  if (authority.startsWith('[')) {
    const bracketEnd = authority.indexOf(']');
    if (bracketEnd <= 1) return null;
    const literal = authority.slice(1, bracketEnd);
    const remainder = authority.slice(bracketEnd + 1);
    if (!/^[0-9a-f:.]+$/i.test(literal)) return null;
    if (remainder) {
      if (!remainder.startsWith(':')) return null;
      port = remainder.slice(1);
    }
    hostname = `[${literal.toLowerCase()}]`;
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      if (authority.indexOf(':') !== colon) return null;
      hostname = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    } else {
      hostname = authority;
    }
    if (
      hostname.length === 0
      || hostname.length > 253
      || !/^[a-z0-9.-]+$/i.test(hostname)
      || hostname.startsWith('.')
      || hostname.includes('..')
    ) {
      return null;
    }
    hostname = hostname.toLowerCase();
  }

  if (port) {
    if (!/^\d{1,5}$/.test(port)) return null;
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65_535) return null;
    if (
      (protocol === 'https:' && portNumber === 443)
      || (protocol === 'http:' && portNumber === 80)
    ) {
      port = '';
    } else {
      port = String(portNumber);
    }
  }

  return {
    protocol,
    hostname,
    port,
    origin: `${protocol}//${hostname}${port ? `:${port}` : ''}`,
  };
}

function normalizeBridgeDocumentUrl(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > CAST_SOURCE_MAX_URL_LENGTH
    || /[\u0000-\u0020\\]/.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
    ) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function hasCoherentTopLevelBridgeUrl(
  context: BridgeMessageContext | undefined,
): context is BridgeMessageContext & {
  topLevelUrl: string;
  navigationGeneration: number;
} {
  if (
    !context
    || !Number.isSafeInteger(context.navigationGeneration)
    || (context.navigationGeneration ?? -1) < 0
  ) {
    return false;
  }
  const sourceUrl = normalizeBridgeDocumentUrl(context.sourceUrl);
  const topLevelUrl = normalizeBridgeDocumentUrl(context.topLevelUrl);
  return sourceUrl !== null && sourceUrl === topLevelUrl;
}

function bridgeNavigationGeneration(
  context: BridgeMessageContext | undefined,
): number | null {
  return Number.isSafeInteger(context?.navigationGeneration)
    && (context?.navigationGeneration ?? -1) >= 0
    ? context!.navigationGeneration!
    : null;
}

function isPreparedPipV1(): boolean {
  if (Platform.OS !== 'ios') return false;
  try {
    return typeof getPreparedNativePlaybackSourceProtocolVersion === 'function'
      && getPreparedNativePlaybackSourceProtocolVersion() === 1;
  } catch {
    return false;
  }
}

function isCurrentPipCapability(
  webViewRef: RefObject<InjectableRef | null>,
  capability: PipShimCapability,
  context?: BridgeMessageContext,
): boolean {
  const current = pipShimCapabilities.get(webViewRef);
  if (current !== capability) return false;
  const navigationGeneration = bridgeNavigationGeneration(context);
  if (isPreparedPipV1()) {
    return capability.navigationGeneration !== null
      && capability.navigationGeneration === navigationGeneration;
  }
  return capability.navigationGeneration === null
    || capability.navigationGeneration === navigationGeneration;
}

function retirePipHandoffId(
  webViewRef: RefObject<InjectableRef | null>,
  id: string,
): void {
  let retired = retiredPipHandoffIds.get(webViewRef);
  if (!retired) {
    retired = new Set<string>();
    retiredPipHandoffIds.set(webViewRef, retired);
  }
  retired.add(id);
  while (retired.size > PIP_MAX_RETIRED_HANDOFF_IDS) {
    const oldest = retired.values().next().value;
    if (typeof oldest !== 'string') break;
    retired.delete(oldest);
  }
}

function cancelNativePipHandoffBounded(handoffId: string): void {
  let cleanup: Promise<void>;
  try {
    cleanup = cancelPictureInPictureHandoff(handoffId);
  } catch {
    return;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timeoutId = setTimeout(resolve, PIP_NATIVE_CLEANUP_TIMEOUT_MS);
  });
  void Promise.race([cleanup.catch(() => undefined), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

function completeActivePipHandoff(
  webViewRef: RefObject<InjectableRef | null>,
  handoff: ActivePipHandoff,
  cancelNative: boolean,
): void {
  if (handoff.invalidatedFlag) return;
  handoff.invalidatedFlag = true;
  if (handoff.restoreTimeout !== undefined) {
    clearTimeout(handoff.restoreTimeout);
    handoff.restoreTimeout = undefined;
  }
  if (activePipHandoffs.get(webViewRef) === handoff) {
    activePipHandoffs.delete(webViewRef);
  }
  retirePipHandoffId(webViewRef, handoff.id);
  handoff.invalidate();
  if (cancelNative && handoff.nativeStarted) {
    cancelNativePipHandoffBounded(handoff.id);
  }
}

function invalidateActivePipHandoff(
  webViewRef: RefObject<InjectableRef | null>,
  handoff: ActivePipHandoff,
): void {
  completeActivePipHandoff(webViewRef, handoff, true);
}

function finishActivePipHandoff(
  webViewRef: RefObject<InjectableRef | null>,
  handoff: ActivePipHandoff,
): void {
  completeActivePipHandoff(webViewRef, handoff, false);
}

function schedulePipRestoreTimeout(
  webViewRef: RefObject<InjectableRef | null>,
  handoff: ActivePipHandoff,
): void {
  if (handoff.restoreTimeout !== undefined) return;
  handoff.restoreTimeout = setTimeout(() => {
    handoff.restoreTimeout = undefined;
    if (
      activePipHandoffs.get(webViewRef) === handoff
      && (
        handoff.nativeInactive
        || handoff.exitRequested
        || handoff.restoreAcknowledged
      )
    ) {
      invalidateActivePipHandoff(webViewRef, handoff);
    }
  }, PIP_NATIVE_RESTORE_TIMEOUT_MS);
}

function clearPendingPipHandoff(
  webViewRef: RefObject<InjectableRef | null>,
): void {
  const pending = pendingPipHandoffs.get(webViewRef);
  if (!pending) return;
  pendingPipHandoffs.delete(webViewRef);
  retirePipHandoffId(webViewRef, pending.id);
}

function createActivePipHandoff(
  pending: PendingPipHandoff,
): ActivePipHandoff {
  let invalidate: () => void = () => undefined;
  const invalidated = new Promise<void>(resolve => {
    invalidate = resolve;
  });
  return {
    id: pending.id,
    capability: pending.capability,
    generation: pending.generation,
    navigationGeneration: pending.navigationGeneration,
    invalidated,
    invalidate,
    invalidatedFlag: false,
    nativeStarted: false,
    nativeReady: false,
    nativeInactive: false,
    exitRequested: false,
    restoreRequested: false,
    restoreAcknowledging: false,
    webViewPauseAcknowledged: false,
    restoreAcknowledged: false,
    entering: false,
  };
}

function buildShimDispatch(detail: object): string {
  const json = JSON.stringify(detail);
  return `(function(){try{window.dispatchEvent(new CustomEvent('__MOVIX_CAST_SHIM__',{detail:${json}}));}catch(e){}})(); true;`;
}

function buildPipShimDispatch(detail: object): string {
  return `(function(){try{window.dispatchEvent(new CustomEvent('__MOVIX_PIP_SHIM__',{detail:${JSON.stringify(detail)}}));}catch(e){}})(); true;`;
}

function sendPipShimResponse(
  webViewRef: RefObject<InjectableRef | null>,
  id: string,
  ok: boolean,
  expectedCapability: string,
): void {
  if (pipShimCapabilities.get(webViewRef)?.capability !== expectedCapability) return;
  webViewRef.current?.injectJavaScript(buildPipShimDispatch({
    kind: 'RESPONSE',
    id,
    capability: expectedCapability,
    ok,
    error: ok ? null : { code: 'PIP_REQUEST_REJECTED' },
  }));
}

function sendPipShimEvent(
  webViewRef: RefObject<InjectableRef | null>,
  event: PictureInPictureEvent,
  expectedCapability = pipShimCapabilities.get(webViewRef)?.capability,
): boolean {
  if (
    !expectedCapability
    || pipShimCapabilities.get(webViewRef)?.capability !== expectedCapability
  ) {
    return false;
  }
  webViewRef.current?.injectJavaScript(buildPipShimDispatch({
    kind: 'NATIVE_EVENT',
    capability: expectedCapability,
    event,
  }));
  return true;
}

async function preparePendingPipHandoff(
  webViewRef: RefObject<InjectableRef | null>,
  pending: PendingPipHandoff,
  handoff: ActivePipHandoff,
): Promise<void> {
  handoff.nativeStarted = true;
  let preparation: Promise<'prepared' | 'failed'>;
  try {
    preparation = preparePictureInPictureSource(pending.source, pending.id).then(
      () => 'prepared' as const,
      () => 'failed' as const,
    );
  } catch {
    preparation = Promise.resolve('failed');
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timeoutId = setTimeout(() => resolve('timeout'), PIP_NATIVE_PREPARE_TIMEOUT_MS);
  });
  const result = await Promise.race([
    preparation,
    handoff.invalidated.then(() => 'invalidated' as const),
    timeout,
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (result === 'invalidated') return;

  const capability = pipShimCapabilities.get(webViewRef);
  const stillCurrent = activePipHandoffs.get(webViewRef) === handoff
    && capability?.capability === handoff.capability
    && capability.generation === handoff.generation;
  if (!stillCurrent) {
    invalidateActivePipHandoff(webViewRef, handoff);
    return;
  }
  if (result !== 'prepared') {
    invalidateActivePipHandoff(webViewRef, handoff);
    sendPipShimResponse(webViewRef, pending.id, false, pending.capability);
    return;
  }
  sendPipShimResponse(webViewRef, pending.id, true, pending.capability);
}

function sendShimResponse(
  webViewRef: RefObject<InjectableRef | null>,
  id: string,
  ok: boolean,
  expectedCapability: string,
  payload?: unknown,
  error?: string,
) {
  if (castShimCapabilities.get(webViewRef) !== expectedCapability) return;
  const script = buildShimDispatch({
    kind: 'RESPONSE',
    id,
    ok,
    payload: payload ?? null,
    error: error ? { code: 'SHIM_ERROR', description: error, message: error } : null,
  });
  webViewRef.current?.injectJavaScript(script);
}

function sendShimStatusEvent(
  webViewRef: RefObject<InjectableRef | null>,
  status: Awaited<ReturnType<typeof getCastStatus>>,
  expectedCapability = castShimCapabilities.get(webViewRef),
) {
  if (
    !expectedCapability
    || castShimCapabilities.get(webViewRef) !== expectedCapability
  ) {
    return;
  }
  const script = buildShimDispatch({
    kind: 'STATUS_EVENT',
    status,
  });
  webViewRef.current?.injectJavaScript(script);
}

// Etats pendant lesquels le telephone alimente encore le relais Cast : couper
// l'ecran a ce moment suspend l'app (iOS) et interrompt le flux. Aligne sur
// CastPowerLease.updatePlaybackState cote Android.
const CAST_AWAKE_STATES = new Set<NativeCastStatus['state']>([
  'loading',
  'buffering',
  'playing',
]);

export function startCastShimEventForwarding(
  webViewRef: RefObject<InjectableRef | null>,
): () => void {
  const stop = subscribeCastStatus(status => {
    setPlaybackAwakeOwner(
      'cast',
      status.connected && CAST_AWAKE_STATES.has(status.state),
    );
    sendShimStatusEvent(webViewRef, status);
  });
  return () => {
    stop();
    setPlaybackAwakeOwner('cast', false);
  };
}

export function startPictureInPictureEventForwarding(
  webViewRef: RefObject<InjectableRef | null>,
  listener: (event: PictureInPictureEvent) => void,
): () => void {
  const stop = subscribePictureInPicture(event => {
    // Le handoff met la WebView en pause, ce qui relache le proprietaire
    // 'local-playback'. Sans ce relais l'ecran s'eteindrait alors que le
    // lecteur natif joue toujours en PiP.
    if (event.kind === 'state') setPlaybackAwakeOwner('pip', event.active);
    if (event.kind === 'error') setPlaybackAwakeOwner('pip', false);
    if (isPreparedPipV1()) {
      if (!('handoffId' in event)) return;
      const handoff = activePipHandoffs.get(webViewRef);
      const capability = pipShimCapabilities.get(webViewRef);
      if (
        !handoff
        || !capability
        || event.handoffId !== handoff.id
        || handoff.capability !== capability.capability
        || handoff.generation !== capability.generation
      ) {
        return;
      }
      if (sendPipShimEvent(webViewRef, event, handoff.capability)) {
        if (event.kind === 'ready') handoff.nativeReady = true;
        if (event.kind === 'restore') handoff.restoreRequested = true;
        if (event.kind === 'state' && event.active === false) {
          handoff.nativeInactive = true;
        }
        listener(event);
      }
      if (event.kind === 'error') {
        invalidateActivePipHandoff(webViewRef, handoff);
      } else if (event.kind === 'state' && event.active === false) {
        if (handoff.restoreAcknowledged) {
          finishActivePipHandoff(webViewRef, handoff);
        } else {
          schedulePipRestoreTimeout(webViewRef, handoff);
        }
      }
      return;
    }
    const expectedCapability = pipShimCapabilities.get(webViewRef)?.capability;
    if (sendPipShimEvent(webViewRef, event, expectedCapability)) listener(event);
  });
  return () => {
    stop();
    setPlaybackAwakeOwner('pip', false);
  };
}

export function clearBridgeCapabilities(
  webViewRef: RefObject<InjectableRef | null>,
): void {
  clearPendingPipHandoff(webViewRef);
  const activePipHandoff = activePipHandoffs.get(webViewRef);
  if (activePipHandoff) {
    invalidateActivePipHandoff(webViewRef, activePipHandoff);
  }
  const mediaProxyCapability = mediaProxyCapabilities.get(webViewRef);
  if (mediaProxyCapability) {
    let retired = retiredMediaProxyGenerations.get(webViewRef);
    if (!retired) {
      retired = new Set<string>();
      retiredMediaProxyGenerations.set(webViewRef, retired);
    }
    retired.add(mediaProxyCapability.generation);
    while (retired.size > MEDIA_PROXY_MAX_RETIRED_GENERATIONS) {
      const oldest = retired.values().next().value;
      if (typeof oldest !== 'string') break;
      retired.delete(oldest);
    }
  }
  mediaProxyCapabilities.delete(webViewRef);
  castShimCapabilities.delete(webViewRef);
  pipShimCapabilities.delete(webViewRef);
  castLoadSingleFlights.delete(webViewRef);
}

function getCastLoadSingleFlight(
  webViewRef: RefObject<InjectableRef | null>,
): CastLoadSingleFlight {
  let singleFlight = castLoadSingleFlights.get(webViewRef);
  if (!singleFlight) {
    singleFlight = createCastLoadSingleFlight();
    castLoadSingleFlights.set(webViewRef, singleFlight);
  }
  return singleFlight;
}

export async function refreshCastShimStatus(
  webViewRef: RefObject<InjectableRef | null>,
): Promise<void> {
  const expectedCapability = castShimCapabilities.get(webViewRef);
  if (!expectedCapability) return;
  try {
    sendShimStatusEvent(
      webViewRef,
      await getCastStatus(true),
      expectedCapability,
    );
  } catch {
    // No active/valid status is safe to omit. A later native event reconciles it.
  }
}

function isBoundedHttpsUrl(value: unknown, allowEmpty = false): value is string {
  if (allowEmpty && value === '') return true;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > CAST_SOURCE_MAX_URL_LENGTH
  ) {
    return false;
  }
  const parsed = parseAbsoluteHttpUrl(value);
  return parsed?.protocol === 'https:' && parsed.port === '';
}

function isAuthenticatedLoopbackMediaUrl(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length <= CAST_SOURCE_MAX_URL_LENGTH
    && /^http:\/\/127\.0\.0\.1:\d{1,5}\/p\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,128}$/.test(value)
  );
}

function parsePreparedHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > CAST_SOURCE_MAX_HEADERS) return null;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (
      !CAST_HEADER_ALLOW_LIST.has(name.toLowerCase())
      || name.length === 0
      || name.length > CAST_SOURCE_MAX_HEADER_NAME_LENGTH
      || typeof headerValue !== 'string'
      || headerValue.length > CAST_SOURCE_MAX_HEADER_VALUE_LENGTH
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(headerValue)
    ) {
      return null;
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parsePreparedCastSource(
  value: unknown,
  allowTracks: boolean,
): PreparedCastSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.protocolVersion !== 1
    || (!isBoundedHttpsUrl(raw.url) && !isAuthenticatedLoopbackMediaUrl(raw.url))
  ) return null;
  const headers = parsePreparedHeaders(raw.headers);
  if (!headers) return null;
  if (isAuthenticatedLoopbackMediaUrl(raw.url) && Object.keys(headers).length > 0) {
    return null;
  }
  if (
    raw.contentType !== undefined
    && (
      typeof raw.contentType !== 'string'
      || raw.contentType.length === 0
      || raw.contentType.length > CAST_SOURCE_MAX_HEADER_VALUE_LENGTH
      || /[\r\n]/.test(raw.contentType)
    )
  ) {
    return null;
  }
  const source: PreparedCastSource = {
    url: raw.url,
    headers,
    protocolVersion: 1,
  };
  if (typeof raw.contentType === 'string') source.contentType = raw.contentType;

  if (allowTracks && raw.tracks !== undefined) {
    if (!Array.isArray(raw.tracks) || raw.tracks.length > CAST_SOURCE_MAX_TRACKS) {
      return null;
    }
    const tracks = [];
    for (const rawTrack of raw.tracks) {
      const metadata = rawTrack as Record<string, unknown>;
      let trackSource: NonNullable<PreparedCastSource['tracks']>[number];
      if (metadata.inlineVtt !== undefined) {
        if (
          typeof metadata.inlineVtt !== 'string'
          || metadata.inlineVtt.length === 0
          || metadata.inlineVtt.length > CAST_INLINE_VTT_MAX_CHARS
          || metadata.inlineVtt.includes('\0')
          || !/^\uFEFF?WEBVTT(?:[ \t]|\r?$)/m.test(metadata.inlineVtt)
          || !metadata.inlineVtt.includes('-->')
          || metadata.url !== undefined
          || metadata.headers !== undefined
          || metadata.protocolVersion !== 1
          || (metadata.contentType !== undefined && metadata.contentType !== 'text/vtt')
        ) return null;
        trackSource = {
          inlineVtt: metadata.inlineVtt,
          contentType: 'text/vtt',
          protocolVersion: 1,
        };
      } else {
        const parsedTrack = parsePreparedCastSource(rawTrack, false);
        if (!parsedTrack) return null;
        trackSource = parsedTrack;
      }
      if (
        metadata.language !== undefined
        && (
          typeof metadata.language !== 'string'
          || metadata.language.length > CAST_TRACK_LANGUAGE_MAX_LENGTH
          || /[\r\n]/.test(metadata.language)
        )
      ) {
        return null;
      }
      if (
        metadata.name !== undefined
        && (
          typeof metadata.name !== 'string'
          || metadata.name.length > CAST_TRACK_LABEL_MAX_LENGTH
          || /[\r\n]/.test(metadata.name)
        )
      ) {
        return null;
      }
      if (metadata.active !== undefined && typeof metadata.active !== 'boolean') {
        return null;
      }
      tracks.push({
        ...trackSource,
        ...(typeof metadata.language === 'string'
          ? { language: metadata.language }
          : {}),
        ...(typeof metadata.name === 'string' ? { name: metadata.name } : {}),
        ...(typeof metadata.active === 'boolean'
          ? { active: metadata.active }
          : {}),
      });
    }
    source.tracks = tracks;
  }
  return source;
}

async function resolvePreparedCastSourceForNative(
  source: PreparedCastSource,
): Promise<PreparedCastSource> {
  const resolveSingle = async (
    candidate: PreparedCastSource,
  ): Promise<PreparedCastSource> => {
    if (!isAuthenticatedLoopbackMediaUrl(candidate.url)) return candidate;
    const mediaProxy = NativeModules.MediaProxy as
      | MediaProxyNativeModule
      | undefined;
    if (!mediaProxy?.resolveForCast) {
      throw new Error('CAST_LOCAL_SOURCE_UNAVAILABLE');
    }
    const rawResolved = await mediaProxy.resolveForCast(candidate.url);
    const resolved = parsePreparedCastSource(rawResolved, false);
    if (!resolved || !isBoundedHttpsUrl(resolved.url)) {
      throw new Error('CAST_LOCAL_SOURCE_INVALID');
    }
    return {
      ...resolved,
      ...(candidate.contentType ? { contentType: candidate.contentType } : {}),
    };
  };

  const root = { ...source };
  delete root.tracks;
  const resolvedRoot = await resolveSingle(root);
  if (!source.tracks?.length) return resolvedRoot;
  const tracks = await Promise.all(source.tracks.map(async track => ({
    ...('inlineVtt' in track ? track : await resolveSingle(track)),
    ...(track.language !== undefined ? { language: track.language } : {}),
    ...(track.name !== undefined ? { name: track.name } : {}),
    ...(track.active !== undefined ? { active: track.active } : {}),
  })));
  return { ...resolvedRoot, tracks };
}

function parseCastLoadMetadata(
  value: unknown,
): (CastLoadMetadata & { currentTime: number }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.title !== 'string'
    || raw.title.length === 0
    || raw.title.length > CAST_TITLE_MAX_LENGTH
    || /[\r\n]/.test(raw.title)
    || (raw.poster !== undefined && !isBoundedHttpsUrl(raw.poster, true))
    || (
      raw.currentTime !== undefined
      && (
        typeof raw.currentTime !== 'number'
        || !Number.isFinite(raw.currentTime)
        || raw.currentTime < 0
      )
    )
  ) {
    return null;
  }
  return {
    title: raw.title,
    ...(typeof raw.poster === 'string' && raw.poster
      ? { poster: raw.poster }
      : {}),
    currentTime: typeof raw.currentTime === 'number' ? raw.currentTime : 0,
  };
}

function castErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (
    message
    && message.length <= 160
    && !/https?:|[?&](?:token|sig|key)=/i.test(message)
  ) {
    return message;
  }
  return fallback;
}

async function handleCastShimMessage(
  req: CastShimRequest,
  webViewRef: RefObject<InjectableRef | null>,
): Promise<void> {
  switch (req.type) {
    case 'CASTSHIM_INIT': {
      // Always resolve successfully — the shim's MovixAndroidCast.isSupported()
      // reads `payload.supported` to return a boolean. Rejecting would make
      // Movix treat the bridge as broken; returning supported:false lets it
      // fall back gracefully (hide cast UI, no error toast).
      const [supported, capabilities] = await Promise.all([
        isCastSupported(),
        getCastCapabilities(),
      ]);
      sendShimResponse(
        webViewRef,
        req.id,
        true,
        req.capability,
        { supported, capabilities },
      );
      return;
    }
    case 'CASTSHIM_LOAD_MEDIA': {
      const parsedSource = parsePreparedCastSource(req.source, true);
      const metadata = parseCastLoadMetadata(req.metadata);
      if (!parsedSource || !metadata) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          'CAST_SOURCE_INVALID',
        );
        return;
      }
      try {
        const supported = await isCastSupported();
        if (!supported) {
          throw new Error('CAST_CAPABILITY_MISMATCH');
        }
        const source = await resolvePreparedCastSourceForNative(parsedSource);
        // If there's already a connected session, CAST_SESSION_STARTED may not
        // fire — loadCastMedia resolves immediately after calling playMedia. In
        // that case we need to synthesize a success response here.
        const { currentTime, ...nativeMetadata } = metadata;
        const singleFlight = getCastLoadSingleFlight(webViewRef);
        const load = singleFlight.run(
          createCastLoadIdentity(source, nativeMetadata),
          () => loadCastMedia(source, nativeMetadata, currentTime),
        );
        await load.promise;
        sendShimResponse(webViewRef, req.id, true, req.capability);
        // Otherwise leave the id in the map — the session-event subscriber will
        // resolve it when STARTED arrives (or reject on PICKER_DISMISSED / FAILED).
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_LOAD_REJECTED'),
        );
      }
      return;
    }
    case 'CASTSHIM_GET_STATUS': {
      try {
        sendShimResponse(
          webViewRef,
          req.id,
          true,
          req.capability,
          await getCastStatus(req.refresh === true),
        );
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_STATUS_UNAVAILABLE'),
        );
      }
      return;
    }
    case 'CASTSHIM_PLAY':
    case 'CASTSHIM_PAUSE':
    case 'CASTSHIM_SEEK_TO':
    case 'CASTSHIM_STOP': {
      try {
        if (req.type === 'CASTSHIM_PLAY') await playCast();
        if (req.type === 'CASTSHIM_PAUSE') await pauseCast();
        if (req.type === 'CASTSHIM_SEEK_TO') {
          if (
            typeof req.seconds !== 'number'
            || !Number.isFinite(req.seconds)
            || req.seconds < 0
          ) {
            throw new Error('CAST_SEEK_INVALID');
          }
          await seekCastTo(req.seconds);
        }
        if (req.type === 'CASTSHIM_STOP') await stopCast();
        sendShimResponse(webViewRef, req.id, true, req.capability);
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_COMMAND_REJECTED'),
        );
      }
      return;
    }
    case 'CASTSHIM_GET_RELAY_DISCLOSURE_PREFERENCE': {
      try {
        sendShimResponse(
          webViewRef,
          req.id,
          true,
          req.capability,
          {
            suppressed: await getRelayDisclosurePreference(),
          },
        );
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_SETTINGS_UNAVAILABLE'),
        );
      }
      return;
    }
    case 'CASTSHIM_SET_RELAY_DISCLOSURE_SUPPRESSED': {
      if (typeof req.suppressed !== 'boolean') {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          'CAST_SETTING_INVALID',
        );
        return;
      }
      try {
        await setRelayDisclosureSuppressed(req.suppressed);
        sendShimResponse(webViewRef, req.id, true, req.capability);
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_SETTINGS_UNAVAILABLE'),
        );
      }
      return;
    }
    case 'CASTSHIM_OPEN_BATTERY_SETTINGS': {
      try {
        await openCastBatterySettings();
        sendShimResponse(webViewRef, req.id, true, req.capability);
      } catch (error) {
        sendShimResponse(
          webViewRef,
          req.id,
          false,
          req.capability,
          undefined,
          castErrorMessage(error, 'CAST_SETTINGS_UNAVAILABLE'),
        );
      }
      return;
    }
    case 'CASTSHIM_REQUEST_NOTIFICATION_PERMISSION': {
      requestCastRelayNotificationPermission();
      sendShimResponse(webViewRef, req.id, true, req.capability);
      return;
    }
  }
}

export interface BridgeRequest {
  id: string;
  type:
    | 'GM_FETCH'
    | 'GM_OPEN_MEDIA_PROXY'
    | 'GM_GET_VALUE'
    | 'GM_SET_VALUE'
    | 'GM_DELETE_VALUE'
    | 'PLAYBACK_AWAKE_SET';
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  responseType?: string;
  timeout?: number;
  key?: string;
  value?: any;
  capability?: string;
  generation?: string;
}

interface BridgeResponse {
  id: string;
  success: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  finalUrl?: string;
  error?: string;
  value?: any;
}

const storage = new Map<string, any>();

function parseResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value: string, key: string) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

interface MediaProxyNativeModule {
  open: (
    url: string,
    method: string,
    headers: Record<string, string>,
  ) => Promise<string>;
  resolveForCast: (localUrl: string) => Promise<unknown>;
}

export function isCanonicalIOSMediaProxyUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = (
    /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/p\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/
  ).exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && String(port) === match[1];
}

function parseMediaProxyRequestHeaders(
  value: unknown,
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 32) return null;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (
      name.length === 0
      || name.length > 128
      || typeof headerValue !== 'string'
      || headerValue.length > 8_192
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(headerValue)
    ) {
      return null;
    }
    headers[name] = headerValue;
  }
  return headers;
}

async function handleGMOpenMediaProxy(
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const method = String(req.method || 'GET').toUpperCase();
  const headers = parseMediaProxyRequestHeaders(req.headers);
  if (
    !isBoundedHttpsUrl(req.url)
    || !headers
    || (method !== 'GET' && method !== 'HEAD')
  ) {
    return {
      id: req.id,
      success: false,
      error: 'Invalid local media proxy request',
    };
  }

  const mediaProxy = NativeModules.MediaProxy as
    | MediaProxyNativeModule
    | undefined;
  if (!mediaProxy?.open) {
    return {
      id: req.id,
      success: false,
      error: 'Local media proxy unavailable',
    };
  }

  try {
    const localUrl = await mediaProxy.open(
      req.url,
      method,
      applyMediaProxyHeaderRules(req.url, headers),
    );
    const validLocalUrl = Platform.OS === 'ios'
      ? isCanonicalIOSMediaProxyUrl(localUrl)
      : Platform.OS === 'android'
        ? /^http:\/\/127\.0\.0\.1:\d+\/p\//i.test(localUrl)
        : false;
    if (!validLocalUrl) {
      throw new Error('Invalid loopback response');
    }
    return {
      id: req.id,
      success: true,
      value: localUrl,
    };
  } catch {
    return {
      id: req.id,
      success: false,
      error: 'Local media proxy unavailable',
    };
  }
}

async function fetchWithRedirectHeaders(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const resp = await fetch(currentUrl, {
      method,
      headers: applyMediaProxyHeaderRules(currentUrl, { ...headers }),
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal,
      redirect: 'manual',
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      currentUrl = new URL(location, currentUrl).href;
      method = 'GET';
      body = undefined;
      continue;
    }
    return resp;
  }
  return fetch(currentUrl, {
    method,
    headers: applyMediaProxyHeaderRules(currentUrl, { ...headers }),
    signal,
  });
}

async function handleGMFetch(req: BridgeRequest): Promise<BridgeResponse> {
  const controller = new AbortController();
  const timeoutId = req.timeout
    ? setTimeout(() => controller.abort(), req.timeout)
    : null;

  try {
    const fetchHeaders: Record<string, string> = applyMediaProxyHeaderRules(
      req.url || '',
      { ...(req.headers || {}) },
    );

    const response = await fetchWithRedirectHeaders(
      req.url!,
      req.method || 'GET',
      fetchHeaders,
      req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      controller.signal,
    );

    let body: string;
    if (req.responseType === 'arraybuffer') {
      const buffer = await response.arrayBuffer();
      body = arrayBufferToBase64(buffer);
    } else {
      body = await response.text();
    }

    return {
      id: req.id,
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: parseResponseHeaders(response.headers),
      body,
      finalUrl: response.url,
    };
  } catch (err: any) {
    return {
      id: req.id,
      success: false,
      error: err?.message || 'Requête échouée',
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function handleGMGetValue(req: BridgeRequest): BridgeResponse {
  return {
    id: req.id,
    success: true,
    value: storage.get(req.key!) ?? null,
  };
}

function handleGMSetValue(req: BridgeRequest): BridgeResponse {
  storage.set(req.key!, req.value);
  return { id: req.id, success: true };
}

function handleGMDeleteValue(req: BridgeRequest): BridgeResponse {
  storage.delete(req.key!);
  return { id: req.id, success: true };
}

function sendToWebView(
  webViewRef: RefObject<WebView | null>,
  response: BridgeResponse,
) {
  const js = `
    (function() {
      var evt = new CustomEvent('__MOVIX_BRIDGE_RESPONSE', {
        detail: ${JSON.stringify(response)}
      });
      window.dispatchEvent(evt);
    })();
    true;
  `;
  webViewRef.current?.injectJavaScript(js);
}

export type BridgeMessageContext = {
  sourceUrl: string;
  topLevelUrl?: string;
  trustedOrigins: readonly string[];
  isTopFrame?: boolean;
  navigationGeneration?: number;
};

function isTrustedPipDocument(
  context: BridgeMessageContext | undefined,
  trusted: boolean,
): boolean {
  if (!trusted || !context) return false;
  if (context.isTopFrame === true) return true;
  return Platform.OS === 'ios'
    && context.isTopFrame === undefined
    && hasCoherentTopLevelBridgeUrl(context);
}

export function isTrustedMovixBridgeUrl(
  sourceUrl: string,
  trustedOrigins: readonly string[],
): boolean {
  const source = parseAbsoluteHttpUrl(sourceUrl);
  if (source?.protocol !== 'https:') return false;
  return trustedOrigins.some(value => {
    const trusted = parseAbsoluteHttpUrl(value);
    return trusted?.protocol === 'https:' && trusted.origin === source.origin;
  });
}

function registerIOSMediaProxyCapability(
  message: Record<string, unknown>,
  webViewRef: RefObject<WebView | null>,
  context: BridgeMessageContext | undefined,
  trusted: boolean,
): void {
  if (
    Platform.OS !== 'ios'
    || !trusted
    || !hasCoherentTopLevelBridgeUrl(context)
    || typeof message.capability !== 'string'
    || !MEDIA_PROXY_CAPABILITY_PATTERN.test(message.capability)
    || typeof message.generation !== 'string'
    || !MEDIA_PROXY_CAPABILITY_PATTERN.test(message.generation)
  ) {
    return;
  }

  const existing = mediaProxyCapabilities.get(webViewRef);
  if (existing) {
    if (
      existing.capability === message.capability
      && existing.generation === message.generation
      && existing.navigationGeneration === context.navigationGeneration
      && existing.topLevelUrl === normalizeBridgeDocumentUrl(context.topLevelUrl)
    ) {
      return;
    }
    return;
  }
  if (retiredMediaProxyGenerations.get(webViewRef)?.has(message.generation)) {
    return;
  }

  const topLevelUrl = normalizeBridgeDocumentUrl(context.topLevelUrl);
  if (!topLevelUrl) return;
  mediaProxyCapabilities.set(webViewRef, {
    capability: message.capability,
    generation: message.generation,
    navigationGeneration: context.navigationGeneration,
    topLevelUrl,
  });
}

function isAuthorizedMediaProxyRequest(
  message: Record<string, unknown>,
  webViewRef: RefObject<WebView | null>,
  context: BridgeMessageContext | undefined,
  trusted: boolean,
  trustedTopFrame: boolean,
): boolean {
  if (Platform.OS === 'android') return trustedTopFrame;
  if (
    Platform.OS !== 'ios'
    || !trusted
    || !hasCoherentTopLevelBridgeUrl(context)
    || typeof message.capability !== 'string'
    || typeof message.generation !== 'string'
  ) {
    return false;
  }
  const capability = mediaProxyCapabilities.get(webViewRef);
  return !!capability
    && capability.capability === message.capability
    && capability.generation === message.generation
    && capability.navigationGeneration === context.navigationGeneration
    && capability.topLevelUrl === normalizeBridgeDocumentUrl(context.topLevelUrl);
}

export async function handleBridgeMessage(
  data: string,
  webViewRef: RefObject<WebView | null>,
  context?: BridgeMessageContext,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  // Route CASTSHIM_* messages to the Cast shim handler.
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    const trusted =
      !!context
      && isTrustedMovixBridgeUrl(context.sourceUrl, context.trustedOrigins);
    const trustedTopFrame = trusted && context?.isTopFrame === true;
    const trustedPipDocument = isTrustedPipDocument(context, trusted);
    if (p.type === 'GM_MEDIA_PROXY_REGISTER_CAPABILITY') {
      registerIOSMediaProxyCapability(p, webViewRef, context, trusted);
      return;
    }
    if (
      p.type === 'GM_OPEN_MEDIA_PROXY'
      && !isAuthorizedMediaProxyRequest(
        p,
        webViewRef,
        context,
        trusted,
        trustedTopFrame,
      )
    ) {
      if (typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128) {
        sendToWebView(webViewRef, {
          id: p.id,
          success: false,
          error: 'Local media proxy unavailable',
        });
      }
      return;
    }
    if (p.type === 'PLAYBACK_AWAKE_SET') {
      if (
        trustedPipDocument
        && p.capability === MOVIX_PLAYBACK_AWAKE_V1
        && typeof p.active === 'boolean'
      ) {
        const playbackAwake = NativeModules.PlaybackAwake as
          | { setLocalPlaybackAwake: (active: boolean) => void }
          | undefined;
        playbackAwake?.setLocalPlaybackAwake(p.active);
        const currentPipCapability = pipShimCapabilities.get(webViewRef);
        const activePipHandoff = activePipHandoffs.get(webViewRef);
        const suppressNativeInactiveTransition = p.active === false
          && isPreparedPipV1()
          && !!currentPipCapability
          && !!activePipHandoff
          && activePipHandoff.capability === currentPipCapability.capability
          && activePipHandoff.generation === currentPipCapability.generation;
        if (!suppressNativeInactiveTransition) {
          setPictureInPicturePlaybackActive(p.active);
        }
      }
      return;
    }
    if (p.type === 'PIPSHIM_REGISTER_CAPABILITY') {
      const navigationGeneration = bridgeNavigationGeneration(context);
      if (
        trustedPipDocument
        && typeof p.capability === 'string'
        && PIP_CAPABILITY_PATTERN.test(p.capability)
        && (!isPreparedPipV1() || navigationGeneration !== null)
        && !pipShimCapabilities.has(webViewRef)
      ) {
        pipShimCapabilities.set(webViewRef, {
          capability: p.capability,
          generation: nextPipShimGeneration++,
          navigationGeneration,
        });
      }
      return;
    }
    if (p.type === 'PIPSHIM_PREPARED_SOURCE') {
      if (!isPreparedPipV1()) return;
      const capability = pipShimCapabilities.get(webViewRef);
      const source = normalizePreparedNativePlaybackSource(p.source);
      if (
        !trustedPipDocument
        || !capability
        || typeof p.capability !== 'string'
        || p.capability !== capability.capability
        || !isCurrentPipCapability(webViewRef, capability, context)
        || !isNativePlaybackHandoffId(p.id)
        || !source
        || retiredPipHandoffIds.get(webViewRef)?.has(p.id)
      ) {
        return;
      }
      const active = activePipHandoffs.get(webViewRef);
      if (active) {
        invalidateActivePipHandoff(webViewRef, active);
        retirePipHandoffId(webViewRef, p.id);
        return;
      }
      if (pendingPipHandoffs.has(webViewRef)) {
        clearPendingPipHandoff(webViewRef);
        retirePipHandoffId(webViewRef, p.id);
        return;
      }
      pendingPipHandoffs.set(webViewRef, {
        ...capability,
        id: p.id,
        source,
      });
      return;
    }
    if (
      p.type === 'PIPSHIM_WEBVIEW_PAUSED'
      || p.type === 'PIPSHIM_RESTORE_APPLIED'
    ) {
      if (!isPreparedPipV1()) return;
      const request = p as PipShimRequest;
      const capability = pipShimCapabilities.get(webViewRef);
      const handoff = activePipHandoffs.get(webViewRef);
      if (
        !trustedPipDocument
        || !capability
        || !handoff
        || typeof request.capability !== 'string'
        || request.capability !== capability.capability
        || handoff.capability !== capability.capability
        || handoff.generation !== capability.generation
        || !isCurrentPipCapability(webViewRef, capability, context)
        || !isNativePlaybackHandoffId(request.id)
        || request.id !== handoff.id
      ) {
        return;
      }

      if (request.type === 'PIPSHIM_WEBVIEW_PAUSED') {
        if (
          !handoff.nativeReady
          || handoff.restoreRequested
          || handoff.webViewPauseAcknowledged
          || handoff.entering
        ) {
          return;
        }
        handoff.webViewPauseAcknowledged = true;
        handoff.entering = true;
        try {
          await acknowledgePictureInPictureWebViewPaused(handoff.id);
          if (
            activePipHandoffs.get(webViewRef) !== handoff
            || handoff.invalidatedFlag
            || pipShimCapabilities.get(webViewRef) !== capability
          ) {
            return;
          }
          if (handoff.restoreRequested) return;
          await enterPreparedPictureInPicture(handoff.id);
        } catch {
          if (handoff.restoreRequested) return;
          invalidateActivePipHandoff(webViewRef, handoff);
        } finally {
          handoff.entering = false;
        }
        return;
      }

      if (request.type !== 'PIPSHIM_RESTORE_APPLIED') return;
      if (
        !handoff.restoreRequested
        || handoff.restoreAcknowledging
        || handoff.restoreAcknowledged
        || typeof request.ok !== 'boolean'
      ) {
        return;
      }
      handoff.restoreAcknowledging = true;
      try {
        await acknowledgePictureInPictureRestoreApplied(handoff.id, request.ok);
        if (
          activePipHandoffs.get(webViewRef) !== handoff
          || handoff.invalidatedFlag
          || pipShimCapabilities.get(webViewRef) !== capability
        ) {
          return;
        }
        handoff.restoreAcknowledging = false;
        handoff.restoreAcknowledged = true;
        if (handoff.nativeInactive) {
          finishActivePipHandoff(webViewRef, handoff);
        } else {
          schedulePipRestoreTimeout(webViewRef, handoff);
        }
      } catch {
        invalidateActivePipHandoff(webViewRef, handoff);
      } finally {
        if (!handoff.invalidatedFlag) handoff.restoreAcknowledging = false;
      }
      return;
    }
    if (p.type === 'PIPSHIM_ENTER' || p.type === 'PIPSHIM_EXIT') {
      const capability = pipShimCapabilities.get(webViewRef);
      const preparedV1 = isPreparedPipV1();
      const validRequestId = preparedV1
        ? isNativePlaybackHandoffId(p.id)
        : typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128;
      if (
        !trustedPipDocument
        || !capability
        || typeof p.capability !== 'string'
        || p.capability !== capability.capability
        || !isCurrentPipCapability(webViewRef, capability, context)
        || !validRequestId
      ) {
        return;
      }

      const request = p as PipShimRequest;
      if (preparedV1) {
        const handoffId = request.id;
        if (request.type === 'PIPSHIM_ENTER') {
          const active = activePipHandoffs.get(webViewRef);
          if (active) {
            invalidateActivePipHandoff(webViewRef, active);
            retirePipHandoffId(webViewRef, handoffId);
            sendPipShimResponse(webViewRef, handoffId, false, capability.capability);
            return;
          }
          const pending = pendingPipHandoffs.get(webViewRef);
          if (
            !pending
            || pending.id !== handoffId
            || pending.capability !== capability.capability
            || pending.generation !== capability.generation
          ) {
            clearPendingPipHandoff(webViewRef);
            retirePipHandoffId(webViewRef, handoffId);
            sendPipShimResponse(webViewRef, handoffId, false, capability.capability);
            return;
          }
          pendingPipHandoffs.delete(webViewRef);
          const handoff = createActivePipHandoff(pending);
          activePipHandoffs.set(webViewRef, handoff);
          await preparePendingPipHandoff(webViewRef, pending, handoff);
          return;
        }

        const active = activePipHandoffs.get(webViewRef);
        const pending = pendingPipHandoffs.get(webViewRef);
        if (active?.id === handoffId) {
          if (!active.nativeReady) {
            invalidateActivePipHandoff(webViewRef, active);
            sendPipShimResponse(webViewRef, handoffId, true, capability.capability);
            return;
          }
          if (active.exitRequested) {
            sendPipShimResponse(webViewRef, handoffId, true, capability.capability);
            return;
          }
          active.exitRequested = true;
          try {
            await exitPictureInPicture();
            if (
              activePipHandoffs.get(webViewRef) === active
              && !active.invalidatedFlag
              && pipShimCapabilities.get(webViewRef) === capability
            ) {
              schedulePipRestoreTimeout(webViewRef, active);
              sendPipShimResponse(webViewRef, handoffId, true, capability.capability);
            }
          } catch {
            invalidateActivePipHandoff(webViewRef, active);
            sendPipShimResponse(webViewRef, handoffId, false, capability.capability);
          }
          return;
        }
        if (pending?.id === handoffId) {
          clearPendingPipHandoff(webViewRef);
          sendPipShimResponse(webViewRef, handoffId, true, capability.capability);
          return;
        }
        if (active) invalidateActivePipHandoff(webViewRef, active);
        clearPendingPipHandoff(webViewRef);
        retirePipHandoffId(webViewRef, handoffId);
        sendPipShimResponse(webViewRef, handoffId, false, capability.capability);
        return;
      }

      if (Platform.OS === 'ios') {
        sendPipShimResponse(webViewRef, request.id, false, capability.capability);
        return;
      }
      try {
        if (request.type === 'PIPSHIM_ENTER') await enterPictureInPicture();
        else await exitPictureInPicture();
        sendPipShimResponse(webViewRef, request.id, true, capability.capability);
      } catch {
        sendPipShimResponse(webViewRef, request.id, false, capability.capability);
      }
      return;
    }
    if (p.type === 'CASTSHIM_REGISTER_CAPABILITY') {
      if (
        trusted
        && typeof p.capability === 'string'
        && CAST_CAPABILITY_PATTERN.test(p.capability)
        && !castShimCapabilities.has(webViewRef)
      ) {
        castShimCapabilities.set(webViewRef, p.capability);
      }
      return;
    }
    if (p.type === 'CASTSHIM_DIAGNOSTIC') {
      return;
    }
    if (typeof p.type === 'string' && p.type.startsWith('CASTSHIM_')) {
      if (
        !trusted
        || typeof p.capability !== 'string'
        || p.capability !== castShimCapabilities.get(webViewRef)
        || typeof p.id !== 'string'
        || p.id.length === 0
        || p.id.length > 128
      ) {
        return;
      }
      await handleCastShimMessage(parsed as CastShimRequest, webViewRef);
      return;
    }
  }

  const req = parsed as BridgeRequest;
  if (!req.type || !req.id) return;

  let response: BridgeResponse;

  switch (req.type) {
    case 'GM_OPEN_MEDIA_PROXY':
      response = await handleGMOpenMediaProxy(req);
      {
        const trusted =
          !!context
          && isTrustedMovixBridgeUrl(context.sourceUrl, context.trustedOrigins);
        if (!isAuthorizedMediaProxyRequest(
          parsed as Record<string, unknown>,
          webViewRef,
          context,
          trusted,
          trusted && context?.isTopFrame === true,
        )) {
          response = {
            id: req.id,
            success: false,
            error: 'Local media proxy unavailable',
          };
        }
      }
      break;
    case 'GM_FETCH':
      response = await handleGMFetch(req);
      break;
    case 'GM_GET_VALUE':
      response = handleGMGetValue(req);
      break;
    case 'GM_SET_VALUE':
      response = handleGMSetValue(req);
      break;
    case 'GM_DELETE_VALUE':
      response = handleGMDeleteValue(req);
      break;
    default:
      return;
  }

  sendToWebView(webViewRef, response);
}
