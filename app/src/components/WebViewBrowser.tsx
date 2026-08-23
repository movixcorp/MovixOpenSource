import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';
import { Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewMessageEvent,
} from 'react-native-webview/lib/WebViewTypes';
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

const injectedJS = buildInjectedJavaScript({
  pictureInPictureMode: getPictureInPictureShimMode(),
  mediaProxyRoutingEnabled:
    Platform.OS === 'android' || Platform.OS === 'ios',
  mediaProxyCapabilityEnabled: Platform.OS === 'ios',
});

function isUsableHttpUrl(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && !/[\u0000-\u0020\\]/.test(value)
    && /^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
  );
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
