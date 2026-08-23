import { NativeModules, Platform } from 'react-native';

type DownloadStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'successful'
  | 'failed'
  | 'unknown';

export type DownloadProgress = {
  status: DownloadStatus;
  bytesDownloaded: number;
  bytesTotal: number;
  reason: number;
};

export type EnqueueResult = {
  downloadId: number;
  filePath: string;
};

type UpdateModuleType = {
  enqueueDownload(
    url: string,
    fileName: string,
    title: string,
  ): Promise<EnqueueResult>;
  queryDownload(downloadId: number): Promise<DownloadProgress>;
  cancelDownload(downloadId: number): Promise<boolean>;
  computeSha256(filePath: string): Promise<string>;
};

function ensureModule(): UpdateModuleType {
  const { UpdateModule } = NativeModules as { UpdateModule?: UpdateModuleType };
  if (!UpdateModule) {
    throw new Error(
      '[updateDownloader] UpdateModule not registered — check MainApplication.getPackages()',
    );
  }
  return UpdateModule;
}

function unsupportedPlatform(operation: string): Error {
  return new Error(`[updateDownloader] ${operation} is only available on Android`);
}

export async function enqueueDownload(
  url: string,
  fileName: string,
  title: string,
): Promise<EnqueueResult> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('enqueueDownload');
  return ensureModule().enqueueDownload(url, fileName, title);
}

export async function queryDownload(
  downloadId: number,
): Promise<DownloadProgress> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('queryDownload');
  return ensureModule().queryDownload(downloadId);
}

export async function cancelDownload(downloadId: number): Promise<boolean> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('cancelDownload');
  return ensureModule().cancelDownload(downloadId);
}

export async function computeSha256(filePath: string): Promise<string> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('computeSha256');
  return ensureModule().computeSha256(filePath);
}

/**
 * Poll the DownloadManager at a fixed interval until the download reaches a terminal
 * state (successful / failed) or the caller aborts via `shouldContinue()`.
 * Callback receives each tick's progress; returns the final progress.
 */
export async function pollUntilDone(
  downloadId: number,
  onTick: (p: DownloadProgress) => void,
  shouldContinue: () => boolean,
  intervalMs = 500,
): Promise<DownloadProgress> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('pollUntilDone');
  while (shouldContinue()) {
    const progress = await queryDownload(downloadId);
    onTick(progress);
    if (
      progress.status === 'successful' ||
      progress.status === 'failed' ||
      progress.status === 'unknown'
    ) {
      return progress;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return queryDownload(downloadId);
}
