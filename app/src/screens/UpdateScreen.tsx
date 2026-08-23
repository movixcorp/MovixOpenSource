import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { DownloadProgress } from '../services/updateDownloader';
import type {
  UpdateError,
  UpdateManifest,
  UpdateStage,
} from '../hooks/useAppUpdate';
import { isValidHttpsUpdateUrl } from '../hooks/useAppUpdate';

type Props = {
  manifest: UpdateManifest;
  stage: UpdateStage;
  progress: DownloadProgress | null;
  error: UpdateError | null;
  locale: 'fr' | 'en';
  onCancel: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEta(bytesRemaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '…';
  const seconds = Math.ceil(bytesRemaining / bytesPerSecond);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function errorLabel(error: UpdateError | null): string {
  switch (error) {
    case 'network':
      return 'Problème de connexion';
    case 'sha_mismatch':
      return 'Fichier corrompu, réessaye';
    case 'disk':
      return 'Espace insuffisant sur l\'appareil';
    case 'install_denied':
      return 'Installation annulée ou bloquée. Tu peux réessayer sans retélécharger.';
    case 'unknown':
    default:
      return 'Erreur inattendue';
  }
}

export default function UpdateScreen({
  manifest,
  stage,
  progress,
  error,
  locale,
  onCancel,
  onOpenSettings,
  onRetry,
}: Props) {
  const barAnim = useRef(new Animated.Value(0)).current;
  const lastTick = useRef<{ t: number; b: number } | null>(null);
  const [bps, setBps] = useState(0);
  const [iosOpenError, setIosOpenError] = useState(false);
  const iosUpdateUrl = manifest.iosAction?.url ?? null;

  const openIosUpdatePage = useCallback(async () => {
    setIosOpenError(false);
    if (!isValidHttpsUpdateUrl(iosUpdateUrl)) {
      setIosOpenError(true);
      return;
    }

    try {
      const supported = await Linking.canOpenURL(iosUpdateUrl);
      if (!supported) {
        setIosOpenError(true);
        return;
      }
      await Linking.openURL(iosUpdateUrl);
    } catch {
      setIosOpenError(true);
    }
  }, [iosUpdateUrl]);

  // Compute bytes-per-second from last 3 ticks (rolling average)
  const bpsSamples = useRef<number[]>([]);
  useEffect(() => {
    if (!progress) return;
    const now = Date.now();
    if (lastTick.current) {
      const dt = (now - lastTick.current.t) / 1000;
      const db = progress.bytesDownloaded - lastTick.current.b;
      if (dt > 0 && db >= 0) {
        bpsSamples.current.push(db / dt);
        if (bpsSamples.current.length > 3) bpsSamples.current.shift();
        const avg =
          bpsSamples.current.reduce((a, b) => a + b, 0) /
          bpsSamples.current.length;
        setBps(avg);
      }
    }
    lastTick.current = { t: now, b: progress.bytesDownloaded };
  }, [progress]);

  const percent = useMemo(() => {
    if (!progress || progress.bytesTotal <= 0) return 0;
    return Math.min(
      100,
      Math.floor((progress.bytesDownloaded / progress.bytesTotal) * 100),
    );
  }, [progress]);

  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: percent,
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [percent, barAnim]);

  const notes =
    manifest.releaseNotes[locale] || manifest.releaseNotes.fr || '';

  const barWidth = barAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const downloaded = progress?.bytesDownloaded ?? 0;
  const total = progress?.bytesTotal ?? manifest.apkSizeBytes ?? 0;
  const remaining = Math.max(0, total - downloaded);

  if (Platform.OS === 'ios') {
    return (
      <View style={styles.container}>
        <View style={styles.inner}>
          <Image
            source={require('../../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')}
            style={styles.icon}
            resizeMode="contain"
          />
          <Text style={styles.title}>Mise à jour vers {manifest.version}</Text>
          {!!notes && (
            <View style={styles.notesCard}>
              <Text style={styles.notesTitle}>Nouveautés</Text>
              <ScrollView style={styles.notesScroll} nestedScrollEnabled>
                <Text style={styles.notes}>{notes}</Text>
              </ScrollView>
            </View>
          )}
          <Text style={styles.statusText}>
            La page de la version iOS s’ouvre dans votre navigateur. Le fichier
            doit ensuite être signé et installé avec un outil externe.
          </Text>
          {iosOpenError && (
            <Text style={styles.errorText}>
              Impossible d’ouvrir la page de mise à jour sécurisée.
            </Text>
          )}
          <TouchableOpacity
            onPress={openIosUpdatePage}
            style={[styles.button, styles.buttonPrimary]}
            accessibilityRole="link"
            activeOpacity={0.8}>
            <Text style={styles.buttonTextPrimary}>Télécharger l’IPA</Text>
          </TouchableOpacity>
          {!manifest.mandatory && (
            <TouchableOpacity
              onPress={onCancel}
              style={[styles.button, styles.buttonSecondary]}
              accessibilityRole="button"
              activeOpacity={0.8}>
              <Text style={styles.buttonTextSecondary}>Plus tard</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.inner}>
        <Image
          source={require('../../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')}
          style={styles.icon}
          resizeMode="contain"
        />
        <Text style={styles.title}>
          {stage === 'error'
            ? 'Échec de la mise à jour'
            : `Mise à jour vers ${manifest.version}`}
        </Text>

        {!!notes && stage !== 'error' && (
          <View style={styles.notesCard}>
            <Text style={styles.notesTitle}>Nouveautés</Text>
            <ScrollView style={styles.notesScroll} nestedScrollEnabled>
              <Text style={styles.notes}>{notes}</Text>
            </ScrollView>
          </View>
        )}

        {stage === 'downloading' && (
          <>
            <View style={styles.barOuter}>
              <Animated.View style={[styles.barInner, { width: barWidth }]} />
            </View>
            <Text style={styles.progressPercent}>{percent} %</Text>
            <Text style={styles.progressDetail}>
              {formatBytes(downloaded)} / {formatBytes(total)}
            </Text>
            <Text style={styles.progressDetail}>
              {bps > 0
                ? `${(bps / (1024 * 1024)).toFixed(1)} MB/s · ${formatEta(remaining, bps)} restantes`
                : 'Démarrage…'}
            </Text>

            {!manifest.mandatory && (
              <TouchableOpacity
                onPress={onCancel}
                style={[styles.button, styles.buttonSecondary]}
                accessibilityRole="button"
                activeOpacity={0.8}>
                <Text style={styles.buttonTextSecondary}>Annuler</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {stage === 'verifying' && (
          <Text style={styles.statusText}>Vérification du fichier…</Text>
        )}

        {stage === 'installing' && (
          <Text style={styles.statusText}>
            Ouverture du programme d'installation…
          </Text>
        )}

        {stage === 'need_permission' && (
          <>
            <Text style={styles.statusText}>
              Autorise Movix à installer des APK pour continuer.
            </Text>
            <TouchableOpacity
              onPress={onOpenSettings}
              style={[styles.button, styles.buttonPrimary]}
              accessibilityRole="button"
              activeOpacity={0.8}>
              <Text style={styles.buttonTextPrimary}>Ouvrir les réglages</Text>
            </TouchableOpacity>
            {!manifest.mandatory && (
              <TouchableOpacity
                onPress={onCancel}
                style={[styles.button, styles.buttonSecondary]}
                accessibilityRole="button"
                activeOpacity={0.8}>
                <Text style={styles.buttonTextSecondary}>Annuler</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {stage === 'error' && (
          <>
            <Text style={styles.errorText}>{errorLabel(error)}</Text>
            <TouchableOpacity
              onPress={onRetry}
              style={[styles.button, styles.buttonPrimary]}
              accessibilityRole="button"
              activeOpacity={0.8}>
              <Text style={styles.buttonTextPrimary}>Réessayer</Text>
            </TouchableOpacity>
            {!manifest.mandatory && (
              <TouchableOpacity
                onPress={onCancel}
                style={[styles.button, styles.buttonSecondary]}
                accessibilityRole="button"
                activeOpacity={0.8}>
                <Text style={styles.buttonTextSecondary}>Plus tard</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  inner: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
  },
  icon: {
    width: 96,
    height: 96,
    marginBottom: 24,
    borderRadius: 24,
  },
  title: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  notesCard: {
    width: '100%',
    backgroundColor: '#151515',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 14,
    marginBottom: 24,
  },
  notesTitle: {
    color: '#c4c4c4',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  notesScroll: {
    maxHeight: 120,
  },
  notes: {
    color: '#d0d0d0',
    fontSize: 14,
    lineHeight: 20,
  },
  barOuter: {
    width: '100%',
    height: 10,
    backgroundColor: '#1c1c1c',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 10,
  },
  barInner: {
    height: '100%',
    backgroundColor: '#8b5cf6',
    borderRadius: 5,
  },
  progressPercent: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  progressDetail: {
    color: '#8a8a8a',
    fontSize: 13,
    marginBottom: 4,
  },
  statusText: {
    color: '#c4c4c4',
    fontSize: 15,
    marginTop: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 15,
    marginTop: 16,
    marginBottom: 24,
    textAlign: 'center',
  },
  button: {
    width: '100%',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  buttonPrimary: {
    backgroundColor: '#8b5cf6',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#333333',
  },
  buttonTextPrimary: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonTextSecondary: {
    color: '#c4c4c4',
    fontSize: 15,
    fontWeight: '500',
  },
});
