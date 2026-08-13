import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';

type Props = {
  onPress: () => void;
};

/**
 * Minimal always-visible tap target shown when both the address bar and the
 * nav bar are hidden. Tapping opens the Settings modal so the user can turn
 * the bars back on. Rendered as position:absolute in BrowserScreen.
 */
export default function MiniPill({ onPress }: Props) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel="Ouvrir les réglages"
      hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
      style={styles.wrapper}>
      <View style={styles.pill} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 3,
    zIndex: 5,
    elevation: 5,
  },
  pill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#3a3a3a',
  },
});
