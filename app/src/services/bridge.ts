/**
 * Bridge React Native <-> WebView
 *
 * Handles:
 *   - GM_* messages (userscript HTTP via native fetch)
 *   - CASTSHIM_* messages (chrome.cast shim ↔ native Cast)
 */

import { type RefObject } from 'react';
import type WebView from 'react-native-webview';
import {
  getCurrentDeviceName,
  getSessionState,
  isCastSupported,
  loadCastMedia,
  stopCast,
  subscribeCastSessionEvents,
} from './cast';
import {
  handleDownloadBridgeMessage,
  isDownloadBridgeMessage,
} from './downloadBridge';

/** Minimal interface required by the shim helpers — satisfied by both WebView and WebViewBrowserRef. */
interface InjectableRef {
  injectJavaScript: (script: string) => void;
}

type CastShimRequest =
  | { type: 'CASTSHIM_INIT'; id: string }
  | { type: 'CASTSHIM_LOAD_MEDIA'; id: string; url: string; title: string; poster: string; currentTime: number }
  | { type: 'CASTSHIM_STOP'; id: string };

function buildShimDispatch(detail: object): string {
  const json = JSON.stringify(detail);
  return `(function(){try{window.dispatchEvent(new CustomEvent('__MOVIX_CAST_SHIM__',{detail:${json}}));}catch(e){}})(); true;`;
}

function sendShimResponse(
  webViewRef: RefObject<InjectableRef | null>,
  id: string,
  ok: boolean,
  payload?: object,
  error?: string,
) {
  const script = buildShimDispatch({
    kind: 'RESPONSE',
    id,
    ok,
    payload: payload ?? null,
    error: error ? { code: 'SHIM_ERROR', description: error, message: error } : null,
  });
  webViewRef.current?.injectJavaScript(script);
}

function sendShimSessionEvent(
  webViewRef: RefObject<InjectableRef | null>,
  event: 'STARTED' | 'RESUMED' | 'ENDED' | 'FAILED' | 'PICKER_DISMISSED',
  extra: { deviceName?: string; durationSec?: number; error?: number } = {},
) {
  const script = buildShimDispatch({
    kind: 'SESSION_EVENT',
    event,
    deviceName: extra.deviceName ?? '',
    durationSec: extra.durationSec ?? 0,
    error: extra.error ?? 0,
  });
  webViewRef.current?.injectJavaScript(script);
}

// Map pending CASTSHIM_LOAD_MEDIA request ids to {webViewRef} so the
// session-event subscription can resolve them when STARTED arrives.
const pendingLoadMediaIds: Map<string, RefObject<InjectableRef | null>> = new Map();

/**
 * Subscribes to native CAST_SESSION_* events and forwards them to the WebView
 * shim as `__MOVIX_CAST_SHIM__` DOM events. Resolves any pending CASTSHIM_LOAD_MEDIA
 * when STARTED / RESUMED arrives, or rejects on ENDED / FAILED / PICKER_DISMISSED.
 * Returns an unsubscribe function. Call once from BrowserScreen with the
 * WebView ref.
 */
export function startCastShimEventForwarding(
  webViewRef: RefObject<InjectableRef | null>,
): () => void {
  const unsub = subscribeCastSessionEvents(evt => {
    switch (evt.type) {
      case 'CAST_SESSION_STARTED':
      case 'CAST_SESSION_RESUMED': {
        // Resolve any pending LOAD_MEDIA with success + device name
        for (const id of pendingLoadMediaIds.keys()) {
          sendShimResponse(webViewRef, id, true, { deviceName: evt.deviceName, durationSec: evt.durationSec });
          pendingLoadMediaIds.delete(id);
        }
        const shimEvent = evt.type === 'CAST_SESSION_STARTED' ? 'STARTED' : 'RESUMED';
        sendShimSessionEvent(webViewRef, shimEvent, { deviceName: evt.deviceName, durationSec: evt.durationSec });
        break;
      }
      case 'CAST_SESSION_ENDED':
      case 'CAST_SESSION_FAILED': {
        for (const id of pendingLoadMediaIds.keys()) {
          sendShimResponse(webViewRef, id, false, undefined, 'Session ' + (evt.type === 'CAST_SESSION_ENDED' ? 'ended' : 'failed'));
          pendingLoadMediaIds.delete(id);
        }
        const shimEvent = evt.type === 'CAST_SESSION_ENDED' ? 'ENDED' : 'FAILED';
        sendShimSessionEvent(webViewRef, shimEvent, { error: evt.error });
        break;
      }
      case 'CAST_PICKER_DISMISSED': {
        for (const id of pendingLoadMediaIds.keys()) {
          sendShimResponse(webViewRef, id, false, undefined, 'Picker dismissed');
          pendingLoadMediaIds.delete(id);
        }
        sendShimSessionEvent(webViewRef, 'PICKER_DISMISSED');
        break;
      }
    }
  });
  return () => {
    unsub();
    pendingLoadMediaIds.clear();
  };
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
      try {
        const supported = await isCastSupported();
        const state = supported ? await getSessionState() : 'idle';
        const active = state === 'connected';
        const deviceName = active ? ((await getCurrentDeviceName()) ?? '') : '';
        sendShimResponse(webViewRef, req.id, true, { supported, activeSession: active, deviceName });
      } catch (err) {
        console.warn('[bridge] CASTSHIM_INIT error', err);
        sendShimResponse(webViewRef, req.id, true, { supported: false, activeSession: false, deviceName: '' });
      }
      return;
    }
    case 'CASTSHIM_LOAD_MEDIA': {
      // Record the id so the CAST_SESSION_STARTED subscriber can resolve it.
      pendingLoadMediaIds.set(req.id, webViewRef);
      try {
        await loadCastMedia(req.url, req.title, req.poster || null, req.currentTime);
        // If there's already a connected session, CAST_SESSION_STARTED may not
        // fire — loadCastMedia resolves immediately after calling playMedia. In
        // that case we need to synthesize a success response here.
        const state = await getSessionState();
        if (state === 'connected') {
          const deviceName = (await getCurrentDeviceName()) ?? '';
          if (pendingLoadMediaIds.has(req.id)) {
            pendingLoadMediaIds.delete(req.id);
            sendShimResponse(webViewRef, req.id, true, { deviceName });
          }
        }
        // Otherwise leave the id in the map — the session-event subscriber will
        // resolve it when STARTED arrives (or reject on PICKER_DISMISSED / FAILED).
      } catch (err) {
        pendingLoadMediaIds.delete(req.id);
        sendShimResponse(webViewRef, req.id, false, undefined, (err as Error)?.message ?? 'load error');
      }
      return;
    }
    case 'CASTSHIM_STOP': {
      try {
        await stopCast();
        sendShimResponse(webViewRef, req.id, true);
      } catch (err) {
        sendShimResponse(webViewRef, req.id, false, undefined, (err as Error)?.message ?? 'stop error');
      }
      return;
    }
  }
}

export interface BridgeRequest {
  id: string;
  type: 'GM_FETCH' | 'GM_GET_VALUE' | 'GM_SET_VALUE' | 'GM_DELETE_VALUE';
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  responseType?: string;
  timeout?: number;
  key?: string;
  value?: any;
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
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

const HEADER_RULES: Array<{ match: RegExp; headers: Record<string, string> }> = [
  {
    match: /fsvid\.lol/i,
    headers: { origin: 'https://fsvid.lol', referer: 'https://fsvid.lol/' },
  },
];

function applyHeaderRules(url: string, headers: Record<string, string>): Record<string, string> {
  for (const rule of HEADER_RULES) {
    if (rule.match.test(url)) {
      for (const [key, value] of Object.entries(rule.headers)) {
        if (!headers[key]) {
          headers[key] = value;
        }
      }
    }
  }
  return headers;
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
      headers: applyHeaderRules(currentUrl, { ...headers }),
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
    headers: applyHeaderRules(currentUrl, { ...headers }),
    signal,
  });
}

async function handleGMFetch(req: BridgeRequest): Promise<BridgeResponse> {
  const controller = new AbortController();
  const timeoutId = req.timeout
    ? setTimeout(() => controller.abort(), req.timeout)
    : null;

  try {
    const fetchHeaders: Record<string, string> = applyHeaderRules(
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

export async function handleBridgeMessage(
  data: string,
  webViewRef: RefObject<WebView | null>,
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
    if (typeof p.type === 'string' && p.type.startsWith('CASTSHIM_')) {
      await handleCastShimMessage(parsed as CastShimRequest, webViewRef);
      return;
    }
  }

  // Route MOVIX_DOWNLOAD_* vers le bridge des téléchargements custom.
  if (isDownloadBridgeMessage(parsed)) {
    await handleDownloadBridgeMessage(parsed, webViewRef);
    return;
  }

  const req = parsed as BridgeRequest;
  if (!req.type || !req.id) return;

  let response: BridgeResponse;

  switch (req.type) {
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
