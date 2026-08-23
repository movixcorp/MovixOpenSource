import React from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';

import {
  IconBack,
  IconClose,
  IconForward,
  IconHome,
  IconRefresh,
  IconSettings,
} from './icons/ToolbarIcons';

export interface BrowserToolbarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  currentUrl: string;
  dnsEnabled: boolean;
  showUrlBar: boolean;
  showNavBar: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onHome: () => void;
  onSettings: () => void;
}

export default function BrowserToolbar({
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
  const domain = (() => {
    try {
      return new URL(currentUrl).hostname;
    } catch {
      return currentUrl;
    }
  })();

  return (
    <View style={styles.container}>
      {showUrlBar && (
        <View style={styles.urlBar}>
          {dnsEnabled && <View style={styles.dnsIndicator} />}
          {loading ? (
            <ActivityIndicator size="small" color="#8b5cf6" style={styles.loadingIndicator} />
          ) : (
            <Text style={styles.lockIcon}>🔒</Text>
          )}
          <Text style={styles.urlText} numberOfLines={1}>
            {domain}
          </Text>
        </View>
      )}

      {showNavBar && (
        <View style={styles.navBar}>
          <TouchableOpacity
            onPress={onGoBack}
            disabled={!canGoBack}
            style={styles.navButton}>
            <IconBack size={22} color={canGoBack ? '#ffffff' : '#444444'} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onGoForward}
            disabled={!canGoForward}
            style={styles.navButton}>
            <IconForward size={22} color={canGoForward ? '#ffffff' : '#444444'} />
          </TouchableOpacity>

          <TouchableOpacity onPress={onReload} style={styles.navButton}>
            {loading ? (
              <IconClose size={22} color="#ffffff" />
            ) : (
              <IconRefresh size={22} color="#ffffff" />
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={onHome} style={styles.navButton}>
            <IconHome size={22} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity onPress={onSettings} style={styles.navButton}>
            <IconSettings size={22} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#111111',
    borderTopWidth: 1,
    borderTopColor: '#1f1f1f',
    paddingBottom: 4,
  },
  urlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dnsIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22c55e',
    marginRight: 6,
  },
  loadingIndicator: {
    marginRight: 6,
  },
  lockIcon: {
    fontSize: 12,
    marginRight: 6,
  },
  urlText: {
    color: '#a0a0a0',
    fontSize: 13,
    flex: 1,
  },
  navBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  navButton: {
    padding: 8,
    minWidth: 44,
    alignItems: 'center',
  },
});
