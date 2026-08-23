import React from 'react';
import {
  Platform,
  PlatformColor,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NativeGlassSurface } from './ios/NativeGlassSurface';

type Props = {
  onPress: () => void;
};

/**
 * Minimal always-visible tap target shown when both the address bar and the
 * nav bar are hidden. Tapping opens the Settings modal so the user can turn
 * the bars back on. Rendered as position:absolute in BrowserScreen.
 */
export default function MiniPill({ onPress }: Props) {
  const insets = useSafeAreaInsets();
  const indicator = <View style={styles.pill} />;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel="Ouvrir les réglages"
      style={[styles.wrapper, { bottom: insets.bottom + 8 }]}>
      {Platform.OS === 'ios' ? (
        <NativeGlassSurface interactive cornerRadius={14} style={styles.glass}>
          {indicator}
        </NativeGlassSurface>
      ) : indicator}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    alignSelf: 'center',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    elevation: 5,
  },
  glass: {
    width: 60,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    width: 40,
    height: 6,
    borderRadius: 3,
    backgroundColor: Platform.OS === 'ios'
      ? PlatformColor('secondaryLabelColor')
      : '#333333',
  },
});
