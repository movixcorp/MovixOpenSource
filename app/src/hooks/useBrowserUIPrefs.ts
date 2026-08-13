import { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CastMode = 'airplay' | 'chromecast';

export type BrowserUIPrefs = {
  showUrlBar: boolean;
  showNavBar: boolean;
  proxyEnabled: boolean;
  castMode: CastMode;
};

const STORAGE_KEY = 'browser_ui_prefs';
const CHANGE_EVENT = 'browser_ui_prefs:changed';

type StoredShape = {
  version: 1;
  showUrlBar: boolean;
  showNavBar: boolean;
  proxyEnabled: boolean;
  castMode?: CastMode;
};

const defaults: BrowserUIPrefs = {
  showUrlBar: true,
  showNavBar: true,
  proxyEnabled: true,
  castMode: 'airplay',
};

function parseStored(raw: string | null): BrowserUIPrefs {
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>;
    if (parsed && parsed.version === 1) {
      return {
        showUrlBar: typeof parsed.showUrlBar === 'boolean' ? parsed.showUrlBar : true,
        showNavBar: typeof parsed.showNavBar === 'boolean' ? parsed.showNavBar : true,
        proxyEnabled:
          typeof parsed.proxyEnabled === 'boolean' ? parsed.proxyEnabled : true,
        castMode: parsed.castMode === 'chromecast' ? 'chromecast' : 'airplay',
      };
    }
  } catch (err) {
    console.warn('[useBrowserUIPrefs] parse error', err);
  }
  return defaults;
}

async function persist(next: BrowserUIPrefs): Promise<void> {
  const payload: StoredShape = {
    version: 1,
    showUrlBar: next.showUrlBar,
    showNavBar: next.showNavBar,
    proxyEnabled: next.proxyEnabled,
    castMode: next.castMode,
  };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[useBrowserUIPrefs] persist error', err);
  }
}

/**
 * Load + mutate the browser UI prefs.
 * Multiple hook instances (SettingsScreen, BrowserScreen) stay in sync via
 * a DeviceEventEmitter broadcast whenever any consumer calls a setter.
 */
export function useBrowserUIPrefs(): {
  prefs: BrowserUIPrefs;
  setShowUrlBar: (v: boolean) => void;
  setShowNavBar: (v: boolean) => void;
  setProxyEnabled: (v: boolean) => void;
  setCastMode: (v: CastMode) => void;
} {
  const [prefs, setPrefs] = useState<BrowserUIPrefs>(defaults);

  // Initial load + subscribe to cross-component broadcasts.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (cancelled) return;
      setPrefs(parseStored(raw));
    });
    const sub = DeviceEventEmitter.addListener(CHANGE_EVENT, (next: BrowserUIPrefs) => {
      if (cancelled) return;
      setPrefs(next);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const apply = useCallback((next: BrowserUIPrefs) => {
    setPrefs(next);
    persist(next);
    DeviceEventEmitter.emit(CHANGE_EVENT, next);
  }, []);

  const setShowUrlBar = useCallback(
    (v: boolean) => {
      apply({ ...prefs, showUrlBar: v });
    },
    [apply, prefs],
  );

  const setShowNavBar = useCallback(
    (v: boolean) => {
      apply({ ...prefs, showNavBar: v });
    },
    [apply, prefs],
  );

  const setProxyEnabled = useCallback(
    (v: boolean) => {
      apply({ ...prefs, proxyEnabled: v });
    },
    [apply, prefs],
  );

  const setCastMode = useCallback(
    (v: CastMode) => {
      if (Platform.OS !== 'ios') return;
      apply({ ...prefs, castMode: v });
    },
    [apply, prefs],
  );

  return { prefs, setShowUrlBar, setShowNavBar, setProxyEnabled, setCastMode };
}
