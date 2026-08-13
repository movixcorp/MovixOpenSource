import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  resolveAddressConfig,
  type AddressConfig,
} from '../services/addressResolver';

const CACHE_KEY = '@movix/address_config';

type AddressContextValue = {
  config: AddressConfig | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
};

const AddressContext = createContext<AddressContextValue | null>(null);

export function AddressProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<AddressConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    // Charge le cache immédiatement pour un démarrage quasi-instantané.
    let hadCache = false;
    try {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: AddressConfig = JSON.parse(cached);
        setConfig(parsed);
        setIsLoading(false);
        hadCache = true;
      }
    } catch {}

    if (!hadCache) setIsLoading(true);
    try {
      const next = await resolveAddressConfig();
      setConfig(next);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(next)).catch(() => {});
    } catch {
      // Si le réseau échoue et qu'on a un cache, on reste sur le cache silencieusement.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AddressContext.Provider value={{ config, isLoading, refresh: load }}>
      {children}
    </AddressContext.Provider>
  );
}

export function useAddress(): AddressContextValue {
  const ctx = useContext(AddressContext);
  if (!ctx) {
    throw new Error('useAddress must be used inside <AddressProvider>');
  }
  return ctx;
}
