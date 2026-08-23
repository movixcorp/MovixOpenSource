import { NativeModules, Platform } from 'react-native';

import appMetadata from '../../app.json';

type UpdateModuleType = {
  getVersionCode(): Promise<number>;
  getVersionName(): Promise<string>;
  canInstallApks(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  installApk(filePath: string): Promise<void>;
};

function ensureModule(): UpdateModuleType {
  const { UpdateModule } = NativeModules as { UpdateModule?: UpdateModuleType };
  if (!UpdateModule) {
    throw new Error(
      '[apkInstaller] UpdateModule not registered — check MainApplication.getPackages()',
    );
  }
  return UpdateModule;
}

function unsupportedPlatform(operation: string): Error {
  return new Error(`[apkInstaller] ${operation} is only available on Android`);
}

function iosBuildNumber(): number {
  const buildNumber = Number(appMetadata.buildNumber);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error('[apkInstaller] invalid bundled iOS build number');
  }
  return buildNumber;
}

export async function getLocalVersionCode(): Promise<number> {
  if (Platform.OS !== 'android') {
    if (Platform.OS === 'ios') return iosBuildNumber();
    throw unsupportedPlatform('getLocalVersionCode');
  }
  return ensureModule().getVersionCode();
}

export async function getLocalVersionName(): Promise<string> {
  if (Platform.OS !== 'android') {
    if (Platform.OS === 'ios' && typeof appMetadata.version === 'string') {
      return appMetadata.version;
    }
    throw unsupportedPlatform('getLocalVersionName');
  }
  return ensureModule().getVersionName();
}

export async function canInstallApks(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    return await ensureModule().canInstallApks();
  } catch (err) {
    console.warn('[apkInstaller] canInstallApks failed', err);
    return false;
  }
}

export async function openInstallSettings(): Promise<void> {
  if (Platform.OS !== 'android') {
    throw unsupportedPlatform('openInstallSettings');
  }
  return ensureModule().openInstallSettings();
}

export async function installApk(filePath: string): Promise<void> {
  if (Platform.OS !== 'android') throw unsupportedPlatform('installApk');
  return ensureModule().installApk(filePath);
}
