/**
 * Service DNS — wrapper pour le module natif.
 *
 * Android : VPN local qui redirige les requêtes DNS vers 1.1.1.1
 * iOS     : NEDNSSettingsManager (DNS-over-HTTPS via Cloudflare)
 */

import { NativeModules, Platform } from 'react-native';
import { CONFIG } from '../config';

const { DnsModule } = NativeModules;

export interface DnsState {
  enabled: boolean;
  primary: string;
  secondary: string;
  method: 'vpn' | 'system' | 'none';
}

export async function enableDns(): Promise<boolean> {
  if (!DnsModule) {
    throw new Error('Module DNS natif non disponible');
  }
  const enabled = await DnsModule.enable(CONFIG.DNS_PRIMARY, CONFIG.DNS_SECONDARY);
  return Platform.OS === 'ios' ? enabled === true : true;
}

export async function disableDns(): Promise<void> {
  if (!DnsModule) {
    throw new Error('Module DNS natif non disponible');
  }
  await DnsModule.disable();
}

export async function getDnsStatus(): Promise<DnsState> {
  if (!DnsModule) {
    return {
      enabled: false,
      primary: CONFIG.DNS_PRIMARY,
      secondary: CONFIG.DNS_SECONDARY,
      method: 'none',
    };
  }

  try {
    const enabled = await DnsModule.isEnabled();
    return {
      enabled,
      primary: CONFIG.DNS_PRIMARY,
      secondary: CONFIG.DNS_SECONDARY,
      method: Platform.OS === 'android' ? 'vpn' : 'system',
    };
  } catch {
    return {
      enabled: false,
      primary: CONFIG.DNS_PRIMARY,
      secondary: CONFIG.DNS_SECONDARY,
      method: Platform.OS === 'android' ? 'vpn' : 'system',
    };
  }
}
