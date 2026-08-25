/**
 * Préférences utilisateur contrôlant quelles extractions l'extension /
 * userscript / app ont le droit d'effectuer. Source de vérité : localStorage.
 *
 * Les valeurs par défaut sont "tout activé" pour ne créer aucune régression
 * pour les utilisateurs existants.
 */

export const M3U8_EXTRACTOR_KEYS = [
  'voe', 'fsvid', 'vidzy', 'vidmoly', 'sibnet', 'uqload', 'doodstream', 'seekstreaming',
  'lulustream', 'veev', 'vidara',
] as const;

export const LIVETV_SOURCE_KEYS = [
  'northlive', 'vavoo', 'matches',
] as const;

export const EXTRACTION_METHOD_KEYS = [
  'server', 'extension', 'userscript',
] as const;

export type M3u8ExtractorKey = typeof M3U8_EXTRACTOR_KEYS[number];
export type LiveTvSourceKey = typeof LIVETV_SOURCE_KEYS[number];
export type ExtractionMethod = typeof EXTRACTION_METHOD_KEYS[number];

export interface ExtractionPrefs {
  version: 1;
  m3u8: Record<M3u8ExtractorKey, boolean>;
  livetv: Record<LiveTvSourceKey, boolean>;
  /**
   * Méthode d'extraction choisie par l'utilisateur. Aucune bascule automatique :
   * l'utilisateur sélectionne explicitement une seule des 3 méthodes.
   * - `server`    : serveur VIP uniquement
   * - `extension` : extension/app uniquement
   * - `userscript`: userscript Tampermonkey uniquement
   */
  method: ExtractionMethod;
  updatedAt: number;
}

const STORAGE_KEY = 'settings_extraction_prefs';
const CHANGE_EVENT = 'movix-extraction-prefs-changed';

function buildDefaults(): ExtractionPrefs {
  const m3u8 = {} as Record<M3u8ExtractorKey, boolean>;
  M3U8_EXTRACTOR_KEYS.forEach((k) => { m3u8[k] = true; });
  const livetv = {} as Record<LiveTvSourceKey, boolean>;
  LIVETV_SOURCE_KEYS.forEach((k) => { livetv[k] = true; });
  return {
    version: 1,
    m3u8,
    livetv,
    method: 'server',
    updatedAt: Date.now(),
  };
}

function normalizeMethod(value: unknown): ExtractionMethod {
  if (typeof value === 'string' && (EXTRACTION_METHOD_KEYS as readonly string[]).includes(value)) {
    return value as ExtractionMethod;
  }
  return 'server';
}

export const DEFAULT_EXTRACTION_PREFS: ExtractionPrefs = buildDefaults();

/**
 * Contrôle de FORME uniquement, volontairement.
 *
 * Exiger que chaque clé de `M3U8_EXTRACTOR_KEYS` soit présente rendait toute
 * préférence enregistrée invalide dès qu'on ajoutait un extracteur : l'objet
 * stocké la veille n'avait pas la nouvelle clé, `getExtractionPrefs` repartait
 * sur les valeurs par défaut, et l'utilisateur perdait silencieusement ses
 * réglages (méthode d'extraction comprise). Les clés manquantes sont complétées
 * par la fusion en aval — c'est là que la compatibilité ascendante se joue.
 */
function isValid(obj: unknown): obj is ExtractionPrefs {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Partial<ExtractionPrefs>;
  return p.version === 1
    && !!p.m3u8 && typeof p.m3u8 === 'object'
    && !!p.livetv && typeof p.livetv === 'object';
}

/** Ne retient d'un objet stocké que les clés connues portant un booléen. */
function pickBooleans<K extends string>(
  keys: readonly K[],
  stored: Partial<Record<K, unknown>> | undefined,
): Partial<Record<K, boolean>> {
  const out: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    if (typeof stored?.[key] === 'boolean') out[key] = stored[key] as boolean;
  }
  return out;
}

export function getExtractionPrefs(): ExtractionPrefs {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return buildDefaults();
    const parsed = JSON.parse(raw);
    if (!isValid(parsed)) return buildDefaults();
    // Complete any missing keys with defaults (forward-compat for added extractors)
    const defaults = buildDefaults();
    const parsedMethod = (parsed as Partial<ExtractionPrefs>).method;
    return {
      version: 1,
      m3u8: { ...defaults.m3u8, ...pickBooleans(M3U8_EXTRACTOR_KEYS, parsed.m3u8) },
      livetv: { ...defaults.livetv, ...pickBooleans(LIVETV_SOURCE_KEYS, parsed.livetv) },
      method: normalizeMethod(parsedMethod),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return buildDefaults();
  }
}

export function setExtractionPrefs(next: ExtractionPrefs): void {
  const toStore: ExtractionPrefs = { ...next, version: 1, updatedAt: Date.now() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    window.dispatchEvent(new CustomEvent<ExtractionPrefs>(CHANGE_EVENT, { detail: toStore }));
  } catch (e) {
    console.warn('[extractionPrefs] setExtractionPrefs failed', e);
  }
}

export function resetExtractionPrefs(): void {
  setExtractionPrefs(buildDefaults());
}

export function isM3u8ExtractorEnabled(key: M3u8ExtractorKey): boolean {
  return getExtractionPrefs().m3u8[key] !== false;
}

export function isLiveTvSourceEnabled(key: LiveTvSourceKey): boolean {
  return getExtractionPrefs().livetv[key] !== false;
}

/** Retourne la méthode d'extraction choisie par l'utilisateur. */
export function getExtractionMethod(): ExtractionMethod {
  return getExtractionPrefs().method;
}

export function subscribeToPrefsChanges(cb: (prefs: ExtractionPrefs) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ExtractionPrefs>).detail;
    cb(detail || getExtractionPrefs());
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/**
 * Ships the current prefs to the extension/userscript via the existing
 * postMessage bridge. No-op if the extension is not available.
 * Safe to call on every change — failure is swallowed.
 */
export async function pushPrefsToExtension(prefs?: ExtractionPrefs): Promise<void> {
  const payload = prefs ?? getExtractionPrefs();
  try {
    const { isExtensionAvailable, fetchFromExtension } = await import('./extensionProxy');
    if (!isExtensionAvailable()) return;
    await fetchFromExtension('SET_EXTRACTION_PREFS', { prefs: payload });
  } catch (e) {
    // Old extension without handler throws "Unknown action" — harmless.
    console.debug('[extractionPrefs] push to extension failed (non-fatal):', e);
  }
}
