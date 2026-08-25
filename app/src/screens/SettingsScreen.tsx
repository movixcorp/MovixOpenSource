import React, { useState, useEffect, useCallback } from 'react';
import {
  AppState,
  View,
  Text,
  Switch,
  StyleSheet,
  ScrollView,
  Alert,
  NativeModules,
  Platform,
  TouchableOpacity,
  Linking,
  Modal,
  Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONFIG } from '../config';
import { useBrowserUIPrefs } from '../hooks/useBrowserUIPrefs';
import { useAddress } from '../context/AddressContext';
import { getLocalVersionName } from '../services/apkInstaller';
import {
  clearNetworkJournal,
  getNetworkJournal,
  loadNetworkJournalPreference,
  setNetworkJournalEnabled,
} from '../services/networkJournal';

const { DnsModule } = NativeModules;

// Doit rester aligné sur `M3U8_EXTRACTOR_KEYS` (src/utils/extractionPrefs.ts) :
// les préférences sont partagées avec le site via le pont d'injection.
const M3U8_KEYS = ['voe','fsvid','vidzy','vidmoly','sibnet','uqload','doodstream','seekstreaming','lulustream','veev','vidara'] as const;
const LIVETV_KEYS = ['northlive','vavoo','matches'] as const;

type ExtractionPrefs = {
  version: 1;
  m3u8: Record<typeof M3U8_KEYS[number], boolean>;
  livetv: Record<typeof LIVETV_KEYS[number], boolean>;
};

const buildDefaultExtractionPrefs = (): ExtractionPrefs => ({
  version: 1,
  m3u8: M3U8_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {} as ExtractionPrefs['m3u8']),
  livetv: LIVETV_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {} as ExtractionPrefs['livetv']),
});

export default function SettingsScreen() {
  const { config } = useAddress();
  const primaryUrl = config?.primaryUrl ?? CONFIG.SITE_URL;
  const [dnsEnabled, setDnsEnabled] = useState(false);
  const [dnsStatus, setDnsStatus] = useState<'off' | 'connecting' | 'active' | 'error'>('off');
  const [appVersion, setAppVersion] = useState<string>('—');
  const [extractionPrefs, setExtractionPrefs] = useState<ExtractionPrefs>(buildDefaultExtractionPrefs);
  const { prefs: uiPrefs, setShowUrlBar, setShowNavBar } = useBrowserUIPrefs();
  const [journalEnabled, setJournalEnabled] = useState(false);
  const [journalEntries, setJournalEntries] = useState<string[]>([]);
  const [journalVisible, setJournalVisible] = useState(false);

  useEffect(() => {
    loadNetworkJournalPreference()
      .then(setJournalEnabled)
      .catch(() => setJournalEnabled(false));
  }, []);

  const toggleJournal = useCallback(async (value: boolean) => {
    setJournalEnabled(value);
    await setNetworkJournalEnabled(value);
    if (!value) setJournalEntries([]);
  }, []);

  const openJournal = useCallback(async () => {
    const entries = await getNetworkJournal();
    setJournalEntries(entries);
    setJournalVisible(true);
  }, []);

  const shareJournal = useCallback(async () => {
    const entries = await getNetworkJournal();
    if (!entries.length) {
      Alert.alert('Journal réseau', 'Aucune requête enregistrée pour le moment.');
      return;
    }
    // Le journal contient des URLs signées et des jetons de lecture : c'est ce
    // qui le rend utile, et c'est pourquoi on ne le partage que sur demande.
    try {
      await Share.share({ message: entries.join('\n') });
    } catch {
      Alert.alert('Journal réseau', 'Partage impossible.');
    }
  }, []);

  useEffect(() => {
    getLocalVersionName()
      .then(setAppVersion)
      .catch(err => {
        console.warn('[SettingsScreen] getLocalVersionName failed', err);
      });
  }, []);

  const refreshDnsState = useCallback(async () => {
    let active = false;
    if (DnsModule) {
      try {
        active = await DnsModule.isEnabled();
      } catch {}
    }
    if (active) {
      setDnsEnabled(true);
      setDnsStatus('active');
      await AsyncStorage.setItem('dns_enabled', 'true');
      return;
    }
    const val = await AsyncStorage.getItem('dns_enabled');
    if (Platform.OS === 'android' && val === 'true') {
        setDnsEnabled(true);
        setDnsStatus('active');
        return;
    }
    if (val === 'true') {
      await AsyncStorage.setItem('dns_enabled', 'false');
    }
    setDnsEnabled(false);
    setDnsStatus('off');
  }, []);

  useEffect(() => {
    void refreshDnsState();
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void refreshDnsState();
      }
    });
    return () => subscription.remove();
  }, [refreshDnsState]);

  useEffect(() => {
    AsyncStorage.getItem('movix_extraction_prefs').then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && parsed.m3u8 && parsed.livetv) {
          const defaults = buildDefaultExtractionPrefs();
          setExtractionPrefs({
            version: 1,
            m3u8: { ...defaults.m3u8, ...parsed.m3u8 },
            livetv: { ...defaults.livetv, ...parsed.livetv },
          });
        }
      } catch {
        // corrupted — keep defaults
      }
    });
  }, []);

  const updateExtractionPrefs = useCallback((next: ExtractionPrefs) => {
    setExtractionPrefs(next);
    AsyncStorage.setItem('movix_extraction_prefs', JSON.stringify(next));
  }, []);

  const toggleDns = useCallback(async (value: boolean) => {
    if (!DnsModule) {
      Alert.alert(
        'Module DNS indisponible',
        'Le module natif DNS n\'est pas disponible sur cette plateforme.',
      );
      return;
    }

    setDnsEnabled(value);

    if (value) {
      setDnsStatus('connecting');
      try {
        const dnsActivated = await DnsModule.enable(CONFIG.DNS_PRIMARY, CONFIG.DNS_SECONDARY);
        if (Platform.OS === 'ios' && !dnsActivated) {
          setDnsStatus('off');
          setDnsEnabled(false);
          await AsyncStorage.setItem('dns_enabled', 'false');
          Alert.alert(
            'Activation DNS requise',
            'La configuration est installée. Active-la manuellement dans Réglages > Général > VPN et gestion de l’appareil > DNS.',
            [{ text: 'Compris' }],
          );
          return;
        }
        setDnsStatus('active');
        await AsyncStorage.setItem('dns_enabled', 'true');
      } catch (err: any) {
        setDnsStatus('error');
        setDnsEnabled(false);
        Alert.alert('Erreur DNS', err?.message || 'Impossible d\'activer le DNS');
      }
    } else {
      try {
        await DnsModule.disable();
        setDnsStatus('off');
        await AsyncStorage.setItem('dns_enabled', 'false');
      } catch (err: any) {
        Alert.alert('Erreur DNS', err?.message || 'Impossible de désactiver le DNS');
      }
    }
  }, []);

  const statusColor = {
    off: '#666666',
    connecting: '#f59e0b',
    active: '#22c55e',
    error: '#ef4444',
  }[dnsStatus];

  const statusLabel = {
    off: 'Désactivé',
    connecting: 'Connexion...',
    active: 'Actif — 1.1.1.1',
    error: 'Erreur',
  }[dnsStatus];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* DNS Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>DNS Cloudflare</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>DNS 1.1.1.1</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusText, { color: statusColor }]}>
                  {statusLabel}
                </Text>
              </View>
            </View>
            <Switch
              value={dnsEnabled}
              onValueChange={toggleDns}
              trackColor={{ false: '#333333', true: '#8b5cf6' }}
              thumbColor={dnsEnabled ? '#ffffff' : '#888888'}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>DNS Primaire</Text>
            <Text style={styles.infoValue}>{CONFIG.DNS_PRIMARY}</Text>
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>DNS Secondaire</Text>
            <Text style={styles.infoValue}>{CONFIG.DNS_SECONDARY}</Text>
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Méthode</Text>
            <Text style={styles.infoValue}>
              {Platform.OS === 'android' ? 'VPN local (pas de données envoyées)' : 'Configuration DNS système'}
            </Text>
          </View>
        </View>

        <Text style={styles.hint}>
          {Platform.OS === 'android'
            ? 'Un VPN local est créé pour rediriger les requêtes DNS vers Cloudflare 1.1.1.1. Aucune donnée ne transite par un serveur tiers.'
            : 'Le DNS système est configuré pour utiliser Cloudflare 1.1.1.1 via DNS-over-HTTPS.'}
        </Text>
      </View>

      {/* Extension Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Extension Movix</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>Proxy intégré</Text>
              <Text style={styles.rowSubtitle}>
                Bypass CORS, injection headers, extraction sources
              </Text>
            </View>
            <View style={[styles.badge, styles.badgeActive]}>
              <Text style={styles.badgeText}>Actif</Text>
            </View>
          </View>
        </View>

        <Text style={styles.hint}>
          L'extension Movix est intégrée directement dans l'application. Elle remplace
          le userscript Tampermonkey et l'extension Chrome/Firefox.
        </Text>
      </View>

      {/* Affichage Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Affichage</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>Barre d'adresse</Text>
              <Text style={styles.rowSubtitle}>Cadenas + domaine en haut du toolbar</Text>
            </View>
            <Switch
              value={uiPrefs.showUrlBar}
              onValueChange={setShowUrlBar}
              trackColor={{ false: '#333333', true: '#8b5cf6' }}
              thumbColor={uiPrefs.showUrlBar ? '#ffffff' : '#888888'}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowTitle}>Contrôles de navigation</Text>
              <Text style={styles.rowSubtitle}>
                Boutons back / forward / home / cast / réglages
              </Text>
            </View>
            <Switch
              value={uiPrefs.showNavBar}
              onValueChange={setShowNavBar}
              trackColor={{ false: '#333333', true: '#8b5cf6' }}
              thumbColor={uiPrefs.showNavBar ? '#ffffff' : '#888888'}
            />
          </View>
        </View>

        <Text style={styles.hint}>
          Quand les deux sont désactivés, un petit indicateur en bas permet de
          rouvrir les réglages.
        </Text>
      </View>

      {/* Extractions Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Extractions</Text>

        <View style={styles.card}>
          <Text style={[styles.rowTitle, { marginBottom: 8 }]}>Extracteurs m3u8</Text>
          {M3U8_KEYS.map((key) => (
            <View key={key} style={styles.row}>
              <Text style={styles.rowSubtitle}>{key}</Text>
              <Switch
                value={extractionPrefs.m3u8[key]}
                onValueChange={(v) => updateExtractionPrefs({ ...extractionPrefs, m3u8: { ...extractionPrefs.m3u8, [key]: v } })}
                trackColor={{ false: '#333333', true: '#8b5cf6' }}
                thumbColor={extractionPrefs.m3u8[key] ? '#ffffff' : '#888888'}
              />
            </View>
          ))}
        </View>

        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={[styles.rowTitle, { marginBottom: 8 }]}>Sources Live TV</Text>
          {LIVETV_KEYS.map((key) => (
            <View key={key} style={styles.row}>
              <Text style={styles.rowSubtitle}>{key}</Text>
              <Switch
                value={extractionPrefs.livetv[key]}
                onValueChange={(v) => updateExtractionPrefs({ ...extractionPrefs, livetv: { ...extractionPrefs.livetv, [key]: v } })}
                trackColor={{ false: '#333333', true: '#8b5cf6' }}
                thumbColor={extractionPrefs.livetv[key] ? '#ffffff' : '#888888'}
              />
            </View>
          ))}
        </View>

        <Text style={styles.hint}>
          Ces réglages s'appliquent à l'extraction native de l'app. Pour régler l'extension ou le userscript, va sur {primaryUrl.replace(/^https?:\/\//, '')}/settings#extractions.
        </Text>
      </View>

      {/* Débogage Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Débogage</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.rowTitle}>Journal réseau</Text>
              <Text style={styles.rowSubtitle}>
                Enregistre chaque requête média : en-têtes réellement émis, code
                de réponse, en-têtes reçus.
              </Text>
            </View>
            <Switch
              value={journalEnabled}
              onValueChange={toggleJournal}
              trackColor={{ false: '#333333', true: '#8b5cf6' }}
              thumbColor={journalEnabled ? '#ffffff' : '#888888'}
            />
          </View>

          {journalEnabled && (
            <View style={{ marginTop: 12 }}>
              <TouchableOpacity style={styles.linkButton} onPress={openJournal}>
                <Text style={styles.linkText}>Voir le journal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.linkButton, { marginTop: 8 }]}
                onPress={shareJournal}>
                <Text style={styles.linkText}>Partager le journal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.linkButton, { marginTop: 8 }]}
                onPress={async () => {
                  await clearNetworkJournal();
                  setJournalEntries([]);
                }}>
                <Text style={styles.linkText}>Vider le journal</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <Text style={styles.hint}>
          Tout reste en mémoire sur l'appareil, rien n'est envoyé : le journal
          disparaît en coupant l'interrupteur ou en fermant l'app. Il contient
          des URLs signées et des jetons de lecture — à ne partager qu'avec
          quelqu'un qui doit diagnostiquer.
        </Text>
      </View>

      <Modal
        visible={journalVisible}
        animationType="slide"
        onRequestClose={() => setJournalVisible(false)}>
        <View style={styles.container}>
          <View style={styles.journalHeader}>
            <Text style={styles.sectionTitle}>
              Journal réseau ({journalEntries.length})
            </Text>
            <TouchableOpacity onPress={() => setJournalVisible(false)}>
              <Text style={styles.linkText}>Fermer</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content} horizontal={false}>
            {journalEntries.length === 0 ? (
              <Text style={styles.hint}>
                Aucune requête enregistrée. Lance une lecture, puis rouvre cet
                écran.
              </Text>
            ) : (
              journalEntries.map((entry, index) => (
                <Text key={index} selectable style={styles.journalEntry}>
                  {entry}
                </Text>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* About Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>À propos</Text>

        <View style={styles.card}>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Version</Text>
            <Text style={styles.infoValue}>{appVersion}</Text>
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Plateforme</Text>
            <Text style={styles.infoValue}>
              {Platform.OS === 'android' ? 'Android' : 'iOS'} ({Platform.Version})
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.linkButton}
          onPress={() => Linking.openURL(primaryUrl)}>
          <Text style={styles.linkText}>
            Visiter {primaryUrl.replace(/^https?:\/\//, '')}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    color: '#8b5cf6',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#151515',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLeft: {
    flex: 1,
    marginRight: 12,
  },
  rowTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: '#888888',
    fontSize: 13,
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: '#1f1f1f',
    marginVertical: 12,
  },
  infoBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  infoLabel: {
    color: '#888888',
    fontSize: 14,
  },
  infoValue: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
  hint: {
    color: '#666666',
    fontSize: 12,
    marginTop: 8,
    marginLeft: 4,
    lineHeight: 18,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeActive: {
    backgroundColor: '#22c55e20',
  },
  badgeText: {
    color: '#22c55e',
    fontSize: 13,
    fontWeight: '600',
  },
  linkButton: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 10,
  },
  linkText: {
    color: '#8b5cf6',
    fontSize: 14,
    fontWeight: '500',
  },
  journalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  journalEntry: {
    color: '#d4d4d4',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 12,
  },
});
