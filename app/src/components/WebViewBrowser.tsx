import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Linking, Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewMessageEvent,
  WebViewOpenWindowEvent,
} from 'react-native-webview/lib/WebViewTypes';
import {
  isNetworkJournalEnabled,
  subscribeNetworkJournal,
} from '../services/networkJournal';
import {
  clearBridgeCapabilities,
  handleBridgeMessage,
  refreshCastShimStatus,
  startCastShimEventForwarding,
  startPictureInPictureEventForwarding,
} from '../services/bridge';
import { setLocalPlaybackAwake } from '../services/playbackAwake';
import {
  getPreparedNativePlaybackSourceProtocolVersion,
  setPictureInPicturePlaybackActive,
} from '../services/pictureInPicture';
import { buildInjectedJavaScript } from '../injection/inject';
import type { PictureInPictureShimMode } from '../injection/picture-in-picture-shim';
import { CONFIG } from '../config';

export interface WebViewBrowserRef {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadUrl: (url: string) => void;
  injectJavaScript: (script: string) => void;
  refreshCastShimStatus: () => void;
}

interface WebViewBrowserProps {
  url: string;
  onNavigationStateChange?: (state: WebViewNavigation) => void;
  onError?: (error: string) => void;
  onPictureInPictureModeChange?: (active: boolean) => void;
}

function getPictureInPictureShimMode(): PictureInPictureShimMode {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 26) {
    return 'android';
  }
  if (Platform.OS === 'ios') {
    try {
      if (getPreparedNativePlaybackSourceProtocolVersion() === 1) {
        return 'ios-native-v1';
      }
    } catch {
      // A missing/older native module must leave WebKit behavior untouched.
    }
  }
  return 'disabled';
}

const BASE_INJECTION_OPTIONS = {
  pictureInPictureMode: getPictureInPictureShimMode(),
  mediaProxyRoutingEnabled:
    Platform.OS === 'android' || Platform.OS === 'ios',
  mediaProxyCapabilityEnabled: Platform.OS === 'ios',
  // WebKit bloque `http://127.0.0.1` comme contenu mixte depuis une page https,
  // là où Chromium exempte la boucle locale. Router les segments HLS par le
  // proxy local ne peut donc qu'échouer sur iOS : chaque requête payait deux
  // allers-retours de pont avant de retomber sur GM_FETCH. Le handoff natif
  // (`GM_openMediaProxy`) reste actif, lui ne passe pas par le moteur web.
  mediaProxyXhrRoutingEnabled: Platform.OS === 'android',
  // Le pendant iOS du routage par la boucle locale : WebKit la refuse depuis
  // une page https, mais route un schéma personnalisé vers le natif. Le
  // handler est enregistré sur la configuration WKWebView (patch
  // react-native-webview) et relaie vers le proxy local.
  mediaProxyScheme: Platform.OS === 'ios' ? 'movix-media' : null,
} as const;

// Construit une fois par état de capture, pas à chaque rendu : le script
// injecté est volumineux, et son contenu ne dépend que de ce booléen.
const INJECTED_JS_BY_JOURNAL_STATE = new Map<boolean, string>();

function injectedJavaScriptFor(journalConsoleEnabled: boolean): string {
  const cached = INJECTED_JS_BY_JOURNAL_STATE.get(journalConsoleEnabled);
  if (cached !== undefined) return cached;
  const built = buildInjectedJavaScript({
    ...BASE_INJECTION_OPTIONS,
    journalConsoleEnabled,
  });
  INJECTED_JS_BY_JOURNAL_STATE.set(journalConsoleEnabled, built);
  return built;
}

function isUsableHttpUrl(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && !/[\u0000-\u0020\\]/.test(value)
    && /^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
  );
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const WebViewBrowser = forwardRef<WebViewBrowserRef, WebViewBrowserProps>(
  ({ url, onNavigationStateChange, onError, onPictureInPictureModeChange }, ref) => {
    const webViewRef = useRef<WebView>(null);
    const topLevelUrlRef = useRef(url);
    const navigationGenerationRef = useRef(0);

    React.useEffect(() => {
      topLevelUrlRef.current = url;
    }, [url]);

    React.useEffect(() => {
      const stopCastStatusForwarding = startCastShimEventForwarding(webViewRef);
      const stopPictureInPictureForwarding = startPictureInPictureEventForwarding(
        webViewRef,
        event => {
          if (event.kind === 'state') onPictureInPictureModeChange?.(event.active);
          if (event.kind === 'error') onPictureInPictureModeChange?.(false);
        },
      );
      return () => {
        clearBridgeCapabilities(webViewRef);
        stopCastStatusForwarding();
        stopPictureInPictureForwarding();
        setPictureInPicturePlaybackActive(false);
        setLocalPlaybackAwake(false);
      };
    }, [onPictureInPictureModeChange]);

    useImperativeHandle(ref, () => ({
      goBack: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.goBack();
      },
      goForward: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.goForward();
      },
      reload: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.reload();
      },
      loadUrl: (newUrl: string) => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(newUrl)}; true;`,
        );
      },
      injectJavaScript: (script: string) => {
        webViewRef.current?.injectJavaScript(script);
      },
      refreshCastShimStatus: () => {
        void refreshCastShimStatus(webViewRef);
      },
    }));

    const onMessage = useCallback((event: WebViewMessageEvent) => {
      const isTopFrame = typeof event.nativeEvent.isTopFrame === 'boolean'
        ? event.nativeEvent.isTopFrame
        : undefined;
      const reportedSourceUrl =
        typeof event.nativeEvent.url === 'string' ? event.nativeEvent.url : '';
      const hasUsableReportedOrigin = isUsableHttpUrl(reportedSourceUrl);
      const sourceUrl = hasUsableReportedOrigin
        ? reportedSourceUrl
        : isTopFrame
          ? topLevelUrlRef.current
          : '';
      handleBridgeMessage(event.nativeEvent.data, webViewRef, {
        sourceUrl,
        topLevelUrl: topLevelUrlRef.current,
        trustedOrigins: [url],
        isTopFrame: isTopFrame,
        navigationGeneration: navigationGenerationRef.current,
      });
    }, [url]);

    // `window.open` et les liens `target="_blank"` : sans ce gestionnaire,
    // react-native-webview recharge la cible dans le WebView courant, ce qui
    // fait entrer les pop-ups publicitaires dans l'application. Seules les
    // fenêtres de même origine que la page Movix restent internes ; tout le
    // reste part vers le navigateur par défaut du système.
    const onOpenWindow = useCallback((event: WebViewOpenWindowEvent) => {
      const targetUrl = event.nativeEvent.targetUrl;
      if (!isUsableHttpUrl(targetUrl)) return;
      if (isSameOrigin(targetUrl, topLevelUrlRef.current)) {
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(targetUrl)}; true;`,
        );
        return;
      }
      Linking.openURL(targetUrl).catch(() => {
        // Aucun gestionnaire système : la pop-up est simplement abandonnée.
      });
    }, []);

    const onHttpError = useCallback(
      (event: any) => {
        onError?.(
          `HTTP ${event.nativeEvent.statusCode}: ${event.nativeEvent.url}`,
        );
      },
      [onError],
    );

    const onWebViewError = useCallback(
      (event: WebViewErrorEvent) => {
        onError?.(event.nativeEvent.description);
      },
      [onError],
    );

    // Le renvoi de la console est armé dans le script injecté : il faut donc le
    // reconstruire quand la capture change. La bascule ne prend effet qu'au
    // chargement suivant de la page, `injectedJavaScriptBeforeContentLoaded`
    // n'étant relu qu'à la navigation.
    const [journalConsole, setJournalConsole] = useState(
      isNetworkJournalEnabled,
    );
    useEffect(() => subscribeNetworkJournal(setJournalConsole), []);
    const injectedJS = useMemo(
      () => injectedJavaScriptFor(journalConsole),
      [journalConsole],
    );

    const userAgent =
      Platform.OS === 'ios' ? CONFIG.USER_AGENT_IOS : CONFIG.USER_AGENT;

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={{ flex: 1, backgroundColor: '#0a0a0a' }}
        // Injection du bridge + userscript avant le chargement
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        // Réinjection après chaque navigation
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={true}
        // Bridge messages
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(request) => {
          if (request.isTopFrame !== false) {
            if (isUsableHttpUrl(request.url)) {
              topLevelUrlRef.current = request.url;
            }
            navigationGenerationRef.current += 1;
            clearBridgeCapabilities(webViewRef);
          }
          return true;
        }}
        // Navigation
        onNavigationStateChange={onNavigationStateChange}
        // Pop-ups : hors origine Movix -> navigateur système
        setSupportMultipleWindows={true}
        onOpenWindow={onOpenWindow}
        // Errors
        onError={onWebViewError}
        onHttpError={onHttpError}
        // Config
        userAgent={userAgent}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        allowsPictureInPictureMediaPlayback={Platform.OS === 'ios'}
        allowsFullscreenVideo={true}
        allowsBackForwardNavigationGestures={true}
        // Sécurité
        originWhitelist={['https://*', 'http://*']}
        mixedContentMode="compatibility"
        // Cache
        cacheEnabled={true}
        // Désactive le zoom pour un rendu app-like
        scalesPageToFit={true}
        // Android
        overScrollMode="never"
        thirdPartyCookiesEnabled={true}
        // iOS
        sharedCookiesEnabled={true}
        contentMode="mobile"
      />
    );
  },
);

WebViewBrowser.displayName = 'WebViewBrowser';
export default WebViewBrowser;
