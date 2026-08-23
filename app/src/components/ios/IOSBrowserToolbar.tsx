import React from 'react';
import {
  Platform,
  requireNativeComponent,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { BrowserToolbarProps } from '../BrowserToolbar';

type EmptyNativeEvent = NativeSyntheticEvent<Record<string, never>>;

type NativeProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  currentURL: string;
  dnsEnabled: boolean;
  showURLBar: boolean;
  showNavBar: boolean;
  onGoBack: (event: EmptyNativeEvent) => void;
  onGoForward: (event: EmptyNativeEvent) => void;
  onReload: (event: EmptyNativeEvent) => void;
  onHome: (event: EmptyNativeEvent) => void;
  onSettings: (event: EmptyNativeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

const NativeChrome = requireNativeComponent<NativeProps>('MovixBrowserChromeView');

export default function IOSBrowserToolbar({
  canGoBack,
  canGoForward,
  loading,
  currentUrl,
  dnsEnabled,
  showUrlBar,
  showNavBar,
  onGoBack,
  onGoForward,
  onReload,
  onHome,
  onSettings,
}: BrowserToolbarProps) {
  const { width } = useWindowDimensions();
  const oneRow = Platform.OS === 'ios'
    && Platform.isPad
    && width >= 768
    && showUrlBar
    && showNavBar;
  const height = oneRow || !(showUrlBar && showNavBar) ? 60 : 112;

  return (
    <NativeChrome
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      loading={loading}
      currentURL={currentUrl}
      dnsEnabled={dnsEnabled}
      showURLBar={showUrlBar}
      showNavBar={showNavBar}
      onGoBack={onGoBack}
      onGoForward={onGoForward}
      onReload={onReload}
      onHome={onHome}
      onSettings={onSettings}
      style={{ height }}
    />
  );
}
