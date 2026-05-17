/**
 * Bridge des téléchargements custom (Android only).
 *
 * Côté WebView, le runtime expose `window.MovixBridge.download.*` qui pousse
 * des messages typés `MOVIX_DOWNLOAD_*` via `ReactNativeWebView.postMessage`.
 * Ce module les route vers `NativeModules.MovixDownloadModule` et renvoie la
 * réponse au WebView via `__MOVIX_DOWNLOAD_RESPONSE`.
 *
 * En parallèle, on s'abonne aux events du module natif
 * (`MovixDownloadProgress`, `MovixDownloadState`) et on les pousse au WebView
 * via `__MOVIX_DOWNLOAD_EVENT` pour que la page Downloads se mette à jour
 * en temps réel.
 */

import { DeviceEventEmitter, NativeModules, Platform, type EmitterSubscription } from 'react-native';
import { type RefObject } from 'react';

interface InjectableRef {
  injectJavaScript: (script: string) => void;
}

interface DownloadModuleType {
  start: (opts: {
    url: string;
    filename: string;
    subFolder?: string;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string; targetPath: string }>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  launch: (id: string) => Promise<void>;
  list: () => Promise<unknown[]>;
  get: (id: string) => Promise<unknown | null>;
}

const DownloadModule = (NativeModules.MovixDownloadModule ?? null) as DownloadModuleType | null;

export type DownloadBridgeRequest =
  | { type: 'MOVIX_DOWNLOAD_START'; id: string; payload: Parameters<DownloadModuleType['start']>[0] }
  | { type: 'MOVIX_DOWNLOAD_PAUSE'; id: string; payload: { downloadId: string } }
  | { type: 'MOVIX_DOWNLOAD_RESUME'; id: string; payload: { downloadId: string } }
  | { type: 'MOVIX_DOWNLOAD_CANCEL'; id: string; payload: { downloadId: string } }
  | { type: 'MOVIX_DOWNLOAD_DELETE'; id: string; payload: { downloadId: string } }
  | { type: 'MOVIX_DOWNLOAD_LAUNCH'; id: string; payload: { downloadId: string } }
  | { type: 'MOVIX_DOWNLOAD_LIST'; id: string }
  | { type: 'MOVIX_DOWNLOAD_GET'; id: string; payload: { downloadId: string } };

export function isDownloadBridgeMessage(msg: unknown): msg is DownloadBridgeRequest {
  return (
    !!msg &&
    typeof msg === 'object' &&
    typeof (msg as { type?: unknown }).type === 'string' &&
    ((msg as { type: string }).type).startsWith('MOVIX_DOWNLOAD_')
  );
}

function buildResponseScript(id: string, ok: boolean, payload: unknown, error: string | null): string {
  const detail = JSON.stringify({ id, ok, payload: payload ?? null, error });
  return `(function(){try{window.dispatchEvent(new CustomEvent('__MOVIX_DOWNLOAD_RESPONSE',{detail:${detail}}));}catch(e){}})(); true;`;
}

function buildEventScript(event: 'progress' | 'state', payload: unknown): string {
  const detail = JSON.stringify({ event, payload });
  return `(function(){try{window.dispatchEvent(new CustomEvent('__MOVIX_DOWNLOAD_EVENT',{detail:${detail}}));}catch(e){}})(); true;`;
}

function sendResponse(
  webViewRef: RefObject<InjectableRef | null>,
  id: string,
  ok: boolean,
  payload: unknown = null,
  error: string | null = null,
) {
  webViewRef.current?.injectJavaScript(buildResponseScript(id, ok, payload, error));
}

export async function handleDownloadBridgeMessage(
  req: DownloadBridgeRequest,
  webViewRef: RefObject<InjectableRef | null>,
): Promise<void> {
  if (Platform.OS !== 'android' || !DownloadModule) {
    sendResponse(webViewRef, req.id, false, null, 'Downloads not available on this platform');
    return;
  }

  try {
    switch (req.type) {
      case 'MOVIX_DOWNLOAD_START': {
        const result = await DownloadModule.start(req.payload);
        sendResponse(webViewRef, req.id, true, result);
        return;
      }
      case 'MOVIX_DOWNLOAD_PAUSE': {
        await DownloadModule.pause(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true);
        return;
      }
      case 'MOVIX_DOWNLOAD_RESUME': {
        await DownloadModule.resume(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true);
        return;
      }
      case 'MOVIX_DOWNLOAD_CANCEL': {
        await DownloadModule.cancel(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true);
        return;
      }
      case 'MOVIX_DOWNLOAD_DELETE': {
        await DownloadModule.delete(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true);
        return;
      }
      case 'MOVIX_DOWNLOAD_LAUNCH': {
        await DownloadModule.launch(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true);
        return;
      }
      case 'MOVIX_DOWNLOAD_LIST': {
        const list = await DownloadModule.list();
        sendResponse(webViewRef, req.id, true, list);
        return;
      }
      case 'MOVIX_DOWNLOAD_GET': {
        const entry = await DownloadModule.get(req.payload.downloadId);
        sendResponse(webViewRef, req.id, true, entry);
        return;
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? 'Download bridge error';
    sendResponse(webViewRef, req.id, false, null, message);
  }
}

/**
 * S'abonne aux events natifs du module download et les pousse au WebView.
 * À appeler une fois au mount de `BrowserScreen`. Retourne unsubscribe.
 */
export function startDownloadEventForwarding(
  webViewRef: RefObject<InjectableRef | null>,
): () => void {
  if (Platform.OS !== 'android' || !DownloadModule) {
    return () => {};
  }

  const subs: EmitterSubscription[] = [
    DeviceEventEmitter.addListener('MovixDownloadProgress', (payload: unknown) => {
      webViewRef.current?.injectJavaScript(buildEventScript('progress', payload));
    }),
    DeviceEventEmitter.addListener('MovixDownloadState', (payload: unknown) => {
      webViewRef.current?.injectJavaScript(buildEventScript('state', payload));
    }),
  ];

  return () => {
    subs.forEach(s => s.remove());
  };
}
