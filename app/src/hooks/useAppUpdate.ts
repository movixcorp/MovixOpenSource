import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { UPDATE_CHECK } from '../config';
import {
  canInstallApks,
  installApk,
  openInstallSettings,
  getLocalVersionCode,
  getLocalVersionName,
} from '../services/apkInstaller';
import {
  cancelDownload,
  computeSha256,
  enqueueDownload,
  pollUntilDone,
  queryDownload,
  type DownloadProgress,
} from '../services/updateDownloader';
import { fetchLatestVersion, type Manifest } from '../services/versionCheck';
import {
  canReusePendingApk,
  decideUpdateForegroundAction,
} from './updateResume';

export type UpdateStage =
  | 'idle'
  | 'offered'          // dialog shown, user hasn't chosen yet
  | 'need_permission'  // user accepted, but canInstallApks === false
  | 'downloading'      // DL in progress (screen mounted)
  | 'verifying'        // DL complete, computing SHA
  | 'installing'       // SHA ok, system installer launched
  | 'error';

export type UpdateError =
  | 'network'
  | 'sha_mismatch'
  | 'disk'
  | 'install_denied'
  | 'unknown';

export type IosUpdateAction = Readonly<{
  url: string;
}>;

export type UpdateManifest = Manifest & {
  iosAction?: IosUpdateAction;
};

export type UpdateState = {
  stage: UpdateStage;
  manifest: UpdateManifest | null;
  progress: DownloadProgress | null;
  error: UpdateError | null;
  downloadId: number | null;
};

type PendingDownload = {
  downloadId: number;
  targetBuildNumber: number;
  targetVersion: string;
  targetSha256: string;
  apkFilePath: string;
  startedAt: string;
};

const initialState: UpdateState = {
  stage: 'idle',
  manifest: null,
  progress: null,
  error: null,
  downloadId: null,
};

function fileNameForBuild(buildNumber: number): string {
  return `movix-android-${buildNumber}.apk`;
}

type SemanticVersion = {
  core: [number, number, number];
  prerelease: string[];
};

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;

  const core = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
  if (core.some(part => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (
    prerelease.some(
      identifier =>
        /^\d+$/.test(identifier) &&
        identifier.length > 1 &&
        identifier[0] === '0',
    )
  ) {
    return null;
  }

  return {
    core: [core[0], core[1], core[2]],
    prerelease,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) {
        return leftPart.length > rightPart.length ? 1 : -1;
      }
      return leftPart > rightPart ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function isNewerSemanticVersion(
  candidate: string,
  current: string,
): boolean {
  const next = parseSemanticVersion(candidate);
  const local = parseSemanticVersion(current);
  if (!next || !local) return false;

  for (let index = 0; index < next.core.length; index += 1) {
    if (next.core[index] !== local.core[index]) {
      return next.core[index] > local.core[index];
    }
  }
  return comparePrerelease(next.prerelease, local.prerelease) > 0;
}

type ParsedHttpsUpdateUrl = Readonly<{
  origin: string;
  pathname: string;
}>;

const HTTPS_PREFIX = 'https://';
const MAX_UPDATE_URL_LENGTH = 2048;
const RAW_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const ENCODED_CONTROL_RE = /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i;
const MALFORMED_PERCENT_RE = /%(?![0-9a-f]{2})/i;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidHostname(hostname: string): boolean {
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.startsWith('.') ||
    hostname.endsWith('.')
  ) {
    return false;
  }

  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    return hostname.split('.').every(part => {
      if (part.length > 1 && part.startsWith('0')) return false;
      const octet = Number(part);
      return Number.isInteger(octet) && octet >= 0 && octet <= 255;
    });
  }

  return hostname.split('.').every(label => DNS_LABEL_RE.test(label));
}

function parseHttpsUpdateUrl(
  value: string | null | undefined,
): ParsedHttpsUpdateUrl | null {
  if (
    !value ||
    value.length > MAX_UPDATE_URL_LENGTH ||
    value !== value.trim() ||
    !value.startsWith(HTTPS_PREFIX) ||
    /\s/u.test(value) ||
    value.includes('\\') ||
    RAW_CONTROL_RE.test(value) ||
    ENCODED_CONTROL_RE.test(value) ||
    MALFORMED_PERCENT_RE.test(value)
  ) {
    return null;
  }

  const remainder = value.slice(HTTPS_PREFIX.length);
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = remainder.slice(
    0,
    authorityEnd === -1 ? remainder.length : authorityEnd,
  );
  if (!authority || authority.includes('@')) return null;

  const authorityMatch = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!authorityMatch) return null;
  const hostname = authorityMatch[1].toLowerCase();
  if (!isValidHostname(hostname)) return null;

  const rawPort = authorityMatch[2];
  let normalizedPort = '';
  if (rawPort) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    normalizedPort = `:${port}`;
  }

  const suffix = authorityEnd === -1 ? '' : remainder.slice(authorityEnd);
  const pathnameEnd = suffix.search(/[?#]/);
  const pathname = suffix.slice(
    0,
    pathnameEnd === -1 ? suffix.length : pathnameEnd,
  );
  if (pathname && !pathname.startsWith('/')) return null;

  return {
    origin: `${HTTPS_PREFIX}${hostname}${normalizedPort}`,
    pathname,
  };
}

export function isValidHttpsUpdateUrl(
  value: string | null | undefined,
): value is string {
  return parseHttpsUpdateUrl(value) !== null;
}

export function releasePageUrl(githubUrl: string): string | null {
  const parsed = parseHttpsUpdateUrl(githubUrl);
  if (!parsed) return null;
  const repositoryPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${repositoryPath}/releases/latest`;
}

export function useAppUpdate(githubUrl: string | null) {
  const [state, setState] = useState<UpdateState>(initialState);
  const cancelRef = useRef(false);
  const stateRef = useRef(state);
  const pendingRef = useRef<PendingDownload | null>(null);
  const mountedRef = useRef(true);
  const foregroundBusyRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const pollGenerationRef = useRef(0);

  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current = true;
      pollGenerationRef.current += 1;
    };
  }, []);

  // --- On mount: reconcile local / pending DL / fresh manifest -----------
  // Cases handled:
  //   A. User sideloaded a newer build → pending.targetBuildNumber <= localCode → clear pending.
  //   B. Server published a newer build than our pending → cancel pending, offer new.
  //   C. Pending for same target as manifest → query DL, resume or verify.
  //   D. Manifest unreachable but pending exists → use pending alone (syntheticManifest).
  //   E. No pending, no update → idle.
  useEffect(() => {
    let cancelled = false;

    if (Platform.OS === 'ios') {
      if (!githubUrl) return;
      const iosReleasePageUrl = releasePageUrl(githubUrl);
      if (!iosReleasePageUrl) return;

      void (async () => {
        try {
          const [result, localVersion] = await Promise.all([
            fetchLatestVersion(githubUrl),
            getLocalVersionName(),
          ]);
          if (cancelled || result.kind !== 'update-available') return;
          if (!isNewerSemanticVersion(result.remote.version, localVersion)) return;

          setState({
            ...initialState,
            // Reuse the existing full-screen state; iOS performs no permission flow.
            stage: 'need_permission',
            manifest: {
              ...result.remote,
              iosAction: { url: iosReleasePageUrl },
            },
          });
        } catch (err) {
          console.warn('[useAppUpdate] iOS version check failed', err);
        }
      })();

      return () => {
        cancelled = true;
      };
    }

    if (Platform.OS !== 'android') return;
    cancelRef.current = false;

    (async () => {
      try {
        let localCode = 0;
        try {
          localCode = await getLocalVersionCode();
        } catch {}

        const raw = await AsyncStorage.getItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
        let pending: PendingDownload | null = null;
        if (raw) {
          try {
            pending = JSON.parse(raw) as PendingDownload;
            pendingRef.current = pending;
          } catch {
            await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
            pendingRef.current = null;
          }
        }

        // Case A: local already >= pending target → clear.
        if (pending && pending.targetBuildNumber <= localCode) {
          try {
            await cancelDownload(pending.downloadId);
          } catch {}
          await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
          pending = null;
          pendingRef.current = null;
        }

        if (!githubUrl) return; // wait until address config resolves
        const result = await fetchLatestVersion(githubUrl);
        if (cancelled) return;

        if (result.kind === 'update-available') {
          const manifest = result.remote;

          // Case B: pending targets an older version than the fresh manifest.
          if (pending && pending.targetBuildNumber < manifest.buildNumber) {
            try {
              await cancelDownload(pending.downloadId);
            } catch {}
            await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
            pending = null;
            pendingRef.current = null;
          }

          // Case C: pending for same target as manifest — query DL.
          if (pending && pending.targetBuildNumber === manifest.buildNumber) {
            try {
              const progress = await queryDownload(pending.downloadId);
              if (
                progress.status === 'running' ||
                progress.status === 'pending' ||
                progress.status === 'paused'
              ) {
                setState({
                  stage: 'downloading',
                  manifest,
                  progress,
                  error: null,
                  downloadId: pending.downloadId,
                });
                resumeProgressLoop(pending);
                return;
              }
              if (progress.status === 'successful') {
                setState({
                  stage: 'verifying',
                  manifest,
                  progress,
                  error: null,
                  downloadId: pending.downloadId,
                });
                verifyAndInstall(pending);
                return;
              }
            } catch (err) {
              console.warn('[useAppUpdate] queryDownload failed at mount', err);
            }
            // DL failed / query errored / unknown → clear, fall through to offer fresh.
            await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
            pendingRef.current = null;
          }

          // No (valid) pending → offer the fresh manifest.
          setState({ ...initialState, stage: 'offered', manifest });
          return;
        }

        // Case D: manifest unreachable but pending may still be useful.
        if (pending) {
          try {
            const progress = await queryDownload(pending.downloadId);
            if (
              progress.status === 'running' ||
              progress.status === 'pending' ||
              progress.status === 'paused'
            ) {
              setState({
                stage: 'downloading',
                manifest: syntheticManifestFrom(pending),
                progress,
                error: null,
                downloadId: pending.downloadId,
              });
              resumeProgressLoop(pending);
              return;
            }
            if (progress.status === 'successful') {
              setState({
                stage: 'verifying',
                manifest: syntheticManifestFrom(pending),
                progress,
                error: null,
                downloadId: pending.downloadId,
              });
              verifyAndInstall(pending);
              return;
            }
          } catch {}
          await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
          pendingRef.current = null;
        }
        // Case E: idle, stay silent.
      } catch (err) {
        console.warn('[useAppUpdate] mount check failed', err);
      }
    })();

    return () => {
      cancelled = true;
      cancelRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubUrl]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const subscription = AppState.addEventListener('change', nextState => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (previousState !== 'active' && nextState === 'active') {
        void handleForegroundResume();
      }
    });

    return () => subscription.remove();
    // The handler reads current data through refs, so this subscription stays stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Actions ---------------------------------------------------------

  const dismiss = useCallback(() => {
    setState(s => (s.manifest?.mandatory ? s : { ...initialState }));
  }, []);

  const accept = useCallback(async () => {
    if (!state.manifest) return;
    const manifest = state.manifest;

    if (Platform.OS === 'ios') {
      if (!isValidHttpsUpdateUrl(manifest.iosAction?.url)) {
        setState(s => ({ ...s, stage: 'error', error: 'unknown' }));
        return;
      }
      setState(s => ({ ...s, stage: 'need_permission' }));
      return;
    }
    if (Platform.OS !== 'android') return;

    try {
      const allowed = await canInstallApks();
      if (!allowed) {
        setState(s => ({ ...s, stage: 'need_permission' }));
        return;
      }
    } catch (err) {
      console.warn('[useAppUpdate] permission check failed', err);
      setState(s => ({ ...s, stage: 'error', error: 'unknown' }));
      return;
    }

    await beginDownload(manifest);
  }, [state.manifest]);

  const cancel = useCallback(async () => {
    if (Platform.OS === 'ios') {
      setState({ ...initialState });
      return;
    }
    if (Platform.OS !== 'android') return;
    if (state.downloadId == null) return;
    // Leave cancelRef.current = true until a new accept() starts a fresh DL.
    // Any in-flight pollUntilDone promise will see the flag and bail out in its .then.
    cancelRef.current = true;
    pollGenerationRef.current += 1;
    try {
      await cancelDownload(state.downloadId);
    } catch (err) {
      console.warn('[useAppUpdate] cancel failed', err);
    }
    await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
    pendingRef.current = null;
    setState({ ...initialState });
  }, [state.downloadId]);

  const openSettings = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      await openInstallSettings();
    } catch (err) {
      console.warn('[useAppUpdate] openInstallSettings failed', err);
    }
  }, []);

  const retry = useCallback(() => {
    const current = stateRef.current;
    const pending = pendingRef.current;
    if (
      current.error === 'install_denied' &&
      current.manifest &&
      pending &&
      canReusePendingApk(pending, current.manifest.buildNumber)
    ) {
      cancelRef.current = false;
      void verifyAndInstall(pending);
      return;
    }

    setState(s => ({
      ...s,
      stage: s.manifest ? 'offered' : 'idle',
      error: null,
    }));
  }, []);

  // --- Internal helpers -------------------------------------------------

  async function beginDownload(manifest: Manifest) {
    // Fresh download — release any cancel lock from a previous session.
    cancelRef.current = false;
    pollGenerationRef.current += 1;

    try {
      const fileName = fileNameForBuild(manifest.buildNumber);
      const title = `Mise à jour Movix ${manifest.version}`;
      const { downloadId, filePath } = await enqueueDownload(
        manifest.apkUrl,
        fileName,
        title,
      );

      const pending: PendingDownload = {
        downloadId,
        targetBuildNumber: manifest.buildNumber,
        targetVersion: manifest.version,
        targetSha256: manifest.apkSha256,
        apkFilePath: filePath,
        startedAt: new Date().toISOString(),
      };
      pendingRef.current = pending;
      await AsyncStorage.setItem(
        UPDATE_CHECK.PENDING_DOWNLOAD_KEY,
        JSON.stringify(pending),
      );

      if (!mountedRef.current) return;
      setState({
        stage: 'downloading',
        manifest,
        progress: null,
        error: null,
        downloadId,
      });

      resumeProgressLoop(pending);
    } catch (err) {
      console.warn('[useAppUpdate] enqueue failed', err);
      if (mountedRef.current) {
        setState(s => ({ ...s, stage: 'error', error: 'network' }));
      }
    }
  }

  function resumeProgressLoop(pending: PendingDownload) {
    const generation = ++pollGenerationRef.current;
    pollUntilDone(
      pending.downloadId,
      progress => {
        if (generation !== pollGenerationRef.current) return;
        setState(s =>
          s.stage === 'downloading' ? { ...s, progress } : s,
        );
      },
      () =>
        mountedRef.current &&
        !cancelRef.current &&
        generation === pollGenerationRef.current,
    )
      .then(final => {
        if (
          cancelRef.current ||
          !mountedRef.current ||
          generation !== pollGenerationRef.current
        ) {
          return;
        }
        if (final.status === 'successful') {
          verifyAndInstall(pending);
        } else {
          setState(s => ({ ...s, stage: 'error', error: 'network' }));
        }
      })
      .catch(err => {
        if (
          !mountedRef.current ||
          generation !== pollGenerationRef.current
        ) {
          return;
        }
        console.warn('[useAppUpdate] poll error', err);
        setState(s => ({ ...s, stage: 'error', error: 'unknown' }));
      });
  }

  async function verifyAndInstall(pending: PendingDownload) {
    pendingRef.current = pending;
    setState(s => ({ ...s, stage: 'verifying' }));
    try {
      const hash = await computeSha256(pending.apkFilePath);
      if (hash.toLowerCase() !== pending.targetSha256.toLowerCase()) {
        console.warn('[useAppUpdate] SHA mismatch', {
          got: hash,
          want: pending.targetSha256,
        });
        await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
        pendingRef.current = null;
        setState(s => ({ ...s, stage: 'error', error: 'sha_mismatch' }));
        return;
      }
    } catch (err) {
      console.warn('[useAppUpdate] SHA compute failed', err);
      setState(s => ({ ...s, stage: 'error', error: 'unknown' }));
      return;
    }

    setState(s => ({ ...s, stage: 'installing' }));
    try {
      await installApk(pending.apkFilePath);
      // Don't clear pending here — if user cancels system installer, we want to offer retry.
      // It'll be cleared on next cold start when buildNumber check passes.
    } catch (err) {
      console.warn('[useAppUpdate] installApk failed', err);
      setState(s => ({ ...s, stage: 'error', error: 'install_denied' }));
    }
  }

  async function handleForegroundResume() {
    if (foregroundBusyRef.current || !mountedRef.current) return;

    const current = stateRef.current;
    if (
      !current.manifest ||
      (current.stage !== 'need_permission' && current.stage !== 'installing')
    ) {
      return;
    }

    foregroundBusyRef.current = true;
    try {
      const [installPermissionGranted, localBuildNumber] = await Promise.all([
        canInstallApks(),
        getLocalVersionCode().catch(() => 0),
      ]);
      if (
        !mountedRef.current ||
        stateRef.current.stage !== current.stage
      ) {
        return;
      }

      const action = decideUpdateForegroundAction({
        stage: current.stage,
        installPermissionGranted,
        localBuildNumber,
        targetBuildNumber: current.manifest.buildNumber,
      });

      if (action === 'continue_after_permission') {
        await beginDownload(current.manifest);
        return;
      }

      if (action === 'installed') {
        await AsyncStorage.removeItem(UPDATE_CHECK.PENDING_DOWNLOAD_KEY);
        pendingRef.current = null;
        setState({ ...initialState });
        return;
      }

      if (action === 'install_not_completed') {
        setState(s => ({
          ...s,
          stage: 'error',
          error: 'install_denied',
        }));
      }
    } catch (err) {
      console.warn('[useAppUpdate] foreground reconciliation failed', err);
      if (mountedRef.current) {
        setState(s => ({ ...s, stage: 'error', error: 'unknown' }));
      }
    } finally {
      foregroundBusyRef.current = false;
    }
  }

  return {
    state,
    dismiss,
    accept,
    cancel,
    openSettings,
    retry,
  };
}

// When resuming a DL from AsyncStorage, we only persisted a subset of the manifest.
// Reconstruct a Manifest-shaped object sufficient for the UpdateScreen to render.
function syntheticManifestFrom(pending: PendingDownload): Manifest {
  return {
    version: pending.targetVersion,
    buildNumber: pending.targetBuildNumber,
    apkUrl: '',
    apkSizeBytes: 0,
    apkSha256: pending.targetSha256,
    mandatory: false,
    releasedAt: pending.startedAt,
    releaseNotes: { fr: '', en: '' },
  };
}

// Re-export for convenience
export { getLocalVersionCode };
