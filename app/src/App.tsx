import React, { useEffect, useState } from 'react';
import {
  StatusBar,
  Alert,
  NativeModules,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import BrowserScreen from './screens/BrowserScreen';
import UpdateScreen from './screens/UpdateScreen';
import UpdateDialog from './components/UpdateDialog';
import { useAppUpdate } from './hooks/useAppUpdate';
import { AddressProvider, useAddress } from './context/AddressContext';
import { installConsoleCapture, pushLog } from './services/debugLog';
import { setWebViewLogSink } from './services/bridge';

const { DnsModule } = NativeModules;

// Capture les `console.*` dès le chargement du module pour la console de debug.
installConsoleCapture();
// Le bridge relaie les `console.*` du WebView sans dépendre de `debugLog` :
// on branche ici le puits de logs.
setWebViewLogSink((level, args) => pushLog(level, 'web', args));

function promptDns() {
  Alert.alert(
    'DNS Cloudflare 1.1.1.1',
    'Activer le DNS Cloudflare pour une navigation plus rapide et sécurisée ?\n\n(Recommandé)',
    [
      {
        text: 'Non merci',
        style: 'cancel',
        onPress: () => {
          AsyncStorage.setItem('dns_enabled', 'false');
        },
      },
      {
        text: 'Activer',
        style: 'default',
        onPress: async () => {
          try {
            if (DnsModule) {
              await DnsModule.enable('1.1.1.1', '1.0.0.1');
            }
            await AsyncStorage.setItem('dns_enabled', 'true');
          } catch {
            await AsyncStorage.setItem('dns_enabled', 'false');
          }
        },
      },
    ],
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [dnsSettled, setDnsSettled] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('dns_enabled');
        let nativeEnabled = false;
        if (DnsModule) {
          try {
            nativeEnabled = await DnsModule.isEnabled();
          } catch {}
        }

        if (nativeEnabled) {
          if (stored !== 'true') {
            await AsyncStorage.setItem('dns_enabled', 'true');
          }
          setDnsSettled(true);
        } else if (stored === 'true' && DnsModule) {
          DnsModule.enable('1.1.1.1', '1.0.0.1').catch(() => {});
          setDnsSettled(true);
        } else if (stored === null) {
          promptDns();
          // Mark settled on next tick — we don't block on user's DNS answer.
          // The update check is cheap and will still run after; its dialog
          // stacks on top of the DNS prompt on Android without issue now
          // that it's a proper Modal, not Alert.alert.
          setDnsSettled(true);
        } else {
          setDnsSettled(true);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <AddressProvider>
        <AppShell dnsSettled={dnsSettled} />
      </AddressProvider>
    </SafeAreaProvider>
  );
}

function AppShell({ dnsSettled }: { dnsSettled: boolean }) {
  const { config } = useAddress();
  const { state, accept, dismiss, cancel, openSettings, retry } = useAppUpdate(
    config?.githubUrl ?? null,
  );

  // No i18n in the mobile app today — FR is the primary language. The JSON
  // manifest still carries both `fr` and `en` release notes for future use.
  const locale: 'fr' | 'en' = 'fr';

  const showScreen =
    state.manifest &&
    (state.stage === 'downloading' ||
      state.stage === 'verifying' ||
      state.stage === 'installing' ||
      state.stage === 'need_permission' ||
      state.stage === 'error');

  if (showScreen && state.manifest) {
    return (
      <UpdateScreen
        manifest={state.manifest}
        stage={state.stage}
        progress={state.progress}
        error={state.error}
        locale={locale}
        onCancel={cancel}
        onOpenSettings={openSettings}
        onRetry={retry}
      />
    );
  }

  return (
    <>
      <BrowserScreen />
      {dnsSettled && state.stage === 'offered' && state.manifest && (
        <UpdateDialog
          manifest={state.manifest}
          locale={locale}
          onLater={dismiss}
          onUpdate={accept}
        />
      )}
    </>
  );
}
