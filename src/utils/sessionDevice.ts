export type SessionDeviceType = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'unknown';

export interface SessionDeviceInfo {
  version: 1;
  browser: string | null;
  browserVersion: string | null;
  operatingSystem: string | null;
  deviceType: SessionDeviceType;
}

const DEVICE_TYPES = new Set<SessionDeviceType>(['desktop', 'mobile', 'tablet', 'tv', 'unknown']);

/** Normalise la rÃ©ponse de l'API pour garder les anciennes sessions affichables. */
export function normalizeSessionDeviceInfo(value: unknown): SessionDeviceInfo {
  if (!value || typeof value !== 'object') {
    return {
      version: 1,
      browser: null,
      browserVersion: null,
      operatingSystem: null,
      deviceType: 'unknown',
    };
  }

  const candidate = value as Partial<SessionDeviceInfo>;
  return {
    version: 1,
    browser: typeof candidate.browser === 'string' && candidate.browser.trim() ? candidate.browser : null,
    browserVersion: typeof candidate.browserVersion === 'string' && candidate.browserVersion.trim()
      ? candidate.browserVersion
      : null,
    operatingSystem: typeof candidate.operatingSystem === 'string' && candidate.operatingSystem.trim()
      ? candidate.operatingSystem
      : null,
    deviceType: DEVICE_TYPES.has(candidate.deviceType as SessionDeviceType)
      ? candidate.deviceType as SessionDeviceType
      : 'unknown',
  };
}

export function getSessionBrowserLabel(device: SessionDeviceInfo, fallback: string): string {
  if (!device.browser) return fallback;
  return device.browserVersion ? `${device.browser} ${device.browserVersion}` : device.browser;
}
