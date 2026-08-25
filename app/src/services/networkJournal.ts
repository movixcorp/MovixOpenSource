import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';

/**
 * Journal réseau — diagnostic local, jamais de télémétrie.
 *
 * Sur mobile, la requête média part du pont natif : elle n'apparaît ni dans un
 * inspecteur réseau, ni dans les journaux de la WebView. Or les hébergeurs qui
 * classent leurs clients (LuluStream, Veev, Fsvid…) refusent sur un seul
 * en-tête — sans voir ce qui est réellement émis, un 403 est indébogable.
 *
 * Le tampon vit côté natif (MediaProxyJournal.kt) pour que les entrées du pont
 * et celles de l'amont s'ordonnent dans un seul fil. Tout est en mémoire, effacé
 * à l'extinction, et la capture est éteinte par défaut.
 */

const STORAGE_KEY = 'debug:networkJournal';

interface MediaProxyJournalModule {
  setJournalEnabled?: (enabled: boolean) => Promise<boolean>;
  getJournal?: () => Promise<string[]>;
  clearJournal?: () => Promise<boolean>;
  recordJournalEntry?: (
    phase: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    statusCode: number,
    error: string | null,
  ) => Promise<boolean>;
}

function nativeJournal(): MediaProxyJournalModule | null {
  const mediaProxy = NativeModules.MediaProxy as
    | MediaProxyJournalModule
    | undefined;
  return mediaProxy?.recordJournalEntry ? mediaProxy : null;
}

let enabled = false;
const listeners = new Set<(value: boolean) => void>();

export function isNetworkJournalEnabled(): boolean {
  return enabled;
}

/**
 * Le renvoi de la console est armé à la construction du script injecté : la
 * WebView doit donc se reconstruire quand la capture change d'état — d'où cet
 * abonnement. La bascule ne prend effet qu'au chargement suivant de la page.
 */
export function subscribeNetworkJournal(
  listener: (value: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadNetworkJournalPreference(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    await setNetworkJournalEnabled(stored === '1');
  } catch {
    enabled = false;
  }
  return enabled;
}

export async function setNetworkJournalEnabled(value: boolean): Promise<void> {
  const changed = enabled !== value;
  enabled = value;
  if (changed) listeners.forEach(listener => listener(value));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Une préférence de débogage non persistée n'empêche pas la capture.
  }
  await nativeJournal()?.setJournalEnabled?.(value);
}

/**
 * Consigne une requête vue côté pont. Volontairement tolérant : un journal qui
 * fait planter la lecture qu'il sert à déboguer ne vaut rien.
 */
export function recordJournalEntry(
  phase: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  statusCode = 0,
  error: string | null = null,
): void {
  if (!enabled) return;
  nativeJournal()
    ?.recordJournalEntry?.(phase, method, url, headers, statusCode, error)
    ?.catch(() => {});
}

export async function getNetworkJournal(): Promise<string[]> {
  try {
    return (await nativeJournal()?.getJournal?.()) ?? [];
  } catch {
    return [];
  }
}

export async function clearNetworkJournal(): Promise<void> {
  try {
    await nativeJournal()?.clearJournal?.();
  } catch {
    // Rien à faire : le tampon natif se vide aussi en coupant la capture.
  }
}
