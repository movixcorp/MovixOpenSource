// src/utils/skipSegmentPrefs.ts
//
// Reglages du saut d'intro / outro / credits / resume / apercu, et du decompte
// de fin d'episode.
//
// Storage : localStorage, prefixe `player` → capte par `SYNCABLE_PREFIXES`
// (`src/utils/syncStorage.ts` et `API/Mainapi/utils/syncPolicy.js`), donc
// synchronise entre appareils sans travail supplementaire. Un prefixe different
// serait silencieusement filtre a la synchro.
//
// Tout tient dans une seule cle JSON (`playerSkipSegments`) plutot qu'une
// quinzaine de cles independantes : les reglages n'ont de sens qu'ensemble, et
// une lecture partielle donnerait un etat incoherent le temps d'une synchro.

export type SkipMode = 'off' | 'button' | 'auto';
export type SegmentKind = 'intro' | 'recap' | 'outro' | 'credits' | 'preview';
/** `inherit` suit le mode global ; les autres valeurs le surchargent. */
export type SegmentModeOverride = 'inherit' | 'off' | 'button' | 'auto';
export type ProviderId = 'aniskip' | 'skipdb' | 'theintrodb' | 'introdb';

export const SEGMENT_KINDS: readonly SegmentKind[] = ['intro', 'recap', 'outro', 'credits', 'preview'];
export const PROVIDER_IDS: readonly ProviderId[] = ['skipdb', 'introdb', 'theintrodb', 'aniskip'];
export const SKIP_MODES: readonly SkipMode[] = ['off', 'button', 'auto'];
export const SEGMENT_MODE_OVERRIDES: readonly SegmentModeOverride[] = ['inherit', 'off', 'button', 'auto'];

export interface SegmentTypeSettings {
  enabled: boolean;
  mode: SegmentModeOverride;
}

export interface SkipSegmentSettings {
  /** Mode applique par defaut a tous les types. */
  mode: SkipMode;
  types: Record<SegmentKind, SegmentTypeSettings>;
  /**
   * Couleur de chaque type, en hexadecimal. Sert au reperage dans la barre de
   * progression et a l'accent du bouton de saut. Stockee avec le reste des
   * reglages, donc suivie d'un appareil a l'autre par la synchro de compte.
   */
  colors: Record<SegmentKind, string>;
  /** Ordre de preference des fournisseurs, du plus au moins prioritaire. */
  providerOrder: ProviderId[];
  /** Fournisseurs autorises. Un fournisseur absent est ignore cote client. */
  enabledProviders: ProviderId[];
  /** Confiance minimale d'un segment pour etre propose. 0–1. */
  minConfidence: number;
  /** Nombre de fournisseurs devant s'accorder sur un segment. 1–4. */
  minSources: number;
  /** Delai avant l'apparition du bouton apres le debut du segment, en secondes. */
  promptDelay: number;
  /** Decalage applique a la fin du segment, en secondes. Negatif = saute moins loin. */
  endOffset: number;
  /** Marqueurs colores dans la barre de progression. */
  showMarkers: boolean;
  /**
   * Afficher les propositions de la communauté pas encore adoptées : marqueurs
   * en pointillés dans la barre et carte « Ce passage est-il bien … ? ».
   *
   * Coupé, on ne voit plus que les séquences confirmées. Les propositions
   * continuent d'exister côté serveur : c'est un réglage d'affichage, pas un
   * retrait de la fonctionnalité, et le studio reste accessible.
   */
  showCommunityProposals: boolean;
  /**
   * Traiter une proposition en attente comme une vraie séquence, sans attendre
   * les voix qui l'adoptent.
   *
   * Coupé par défaut : une proposition non adoptée n'a été vérifiée par
   * personne, et une borne fausse fait sauter en plein milieu d'une scène.
   * Activé, elle déclenche bouton ou saut automatique comme n'importe quelle
   * autre source — utile sur un contenu que personne d'autre ne regarde, ou
   * quand on relève soi-même ses séquences.
   */
  trustPendingProposals: boolean;
  /**
   * N'interroger les fournisseurs qu'une fois la lecture reellement lancee.
   * Active par defaut : la requete de segments ne doit pas se disputer la bande
   * passante avec le manifeste HLS et les premiers fragments.
   */
  deferLoading: boolean;
}

const STORAGE_KEY = 'playerSkipSegments';

export const SKIP_PREFS_CHANGE_EVENT = 'movix-skip-prefs-changed';

export const PROMPT_DELAY_MAX = 10;

/**
 * Couleurs par defaut, une teinte franchement distincte par type et toutes
 * distinctes du rouge de la progression et du gris du tampon, pour rester
 * lisibles par-dessus l'un comme l'autre.
 */
export const DEFAULT_SEGMENT_COLORS: Record<SegmentKind, string> = {
  intro: '#fbbf24',
  recap: '#38bdf8',
  outro: '#a78bfa',
  credits: '#e879f9',
  preview: '#34d399',
};

/** Teintes proposees en acces direct sous chaque type, avant la pipette. */
export const SEGMENT_COLOR_PRESETS: readonly string[] = [
  '#fbbf24', '#fb923c', '#f87171', '#e879f9',
  '#a78bfa', '#60a5fa', '#38bdf8', '#34d399',
];

const HEX_RE = /^#[0-9a-f]{6}$/;

/** Normalise une couleur : accepte `#abc`, sans diese, en majuscules. */
export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  let hex = value.trim().toLowerCase();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return HEX_RE.test(hex) ? hex : fallback;
}
export const END_OFFSET_MIN = -10;
export const END_OFFSET_MAX = 10;

/**
 * Les cinq types sont actifs par defaut.
 *
 * Le mode par defaut reste `button` : rien n'est saute tout seul, on propose
 * seulement. Couper le resume et l'apercu d'office privait surtout de bouton
 * ceux qui les voulaient, alors qu'un bouton ignore ne coute rien — et les
 * couper cachait aussi leurs marqueurs dans la barre de progression.
 */
export const DEFAULT_SKIP_SETTINGS: SkipSegmentSettings = {
  mode: 'button',
  types: {
    intro: { enabled: true, mode: 'inherit' },
    recap: { enabled: true, mode: 'inherit' },
    outro: { enabled: true, mode: 'inherit' },
    credits: { enabled: true, mode: 'inherit' },
    preview: { enabled: true, mode: 'inherit' },
  },
  colors: { ...DEFAULT_SEGMENT_COLORS },
  // SkipDB en tete : c'est le seul a recaler lui-meme ses horodatages sur la
  // duree du flux, donc celui dont les bornes tombent juste le plus souvent.
  providerOrder: ['skipdb', 'introdb', 'theintrodb', 'aniskip'],
  enabledProviders: ['skipdb', 'introdb', 'theintrodb', 'aniskip'],
  minConfidence: 0.4,
  minSources: 1,
  promptDelay: 0,
  endOffset: 0,
  showMarkers: true,
  showCommunityProposals: true,
  trustPendingProposals: false,
  deferLoading: true,
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeProviderList(value: unknown, fallback: ProviderId[]): ProviderId[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<ProviderId>();
  for (const entry of value) {
    if (PROVIDER_IDS.includes(entry as ProviderId)) seen.add(entry as ProviderId);
  }
  return seen.size > 0 ? [...seen] : [...fallback];
}

/**
 * Fusionne une valeur stockee avec les defauts.
 *
 * Tolerant par construction : une preference ecrite par une version anterieure
 * (ou par une autre plateforme via la synchro) ne doit jamais casser le lecteur.
 * Toute valeur inconnue retombe sur le defaut.
 */
function sanitize(raw: unknown): SkipSegmentSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<SkipSegmentSettings>;

  const types = {} as Record<SegmentKind, SegmentTypeSettings>;
  for (const kind of SEGMENT_KINDS) {
    const stored = (input.types as Record<string, unknown> | undefined)?.[kind];
    const entry = (stored && typeof stored === 'object' ? stored : {}) as Partial<SegmentTypeSettings>;
    types[kind] = {
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : DEFAULT_SKIP_SETTINGS.types[kind].enabled,
      mode: SEGMENT_MODE_OVERRIDES.includes(entry.mode as SegmentModeOverride)
        ? (entry.mode as SegmentModeOverride)
        : 'inherit',
    };
  }

  const colors = {} as Record<SegmentKind, string>;
  for (const kind of SEGMENT_KINDS) {
    colors[kind] = normalizeHexColor(
      (input.colors as Record<string, unknown> | undefined)?.[kind],
      DEFAULT_SEGMENT_COLORS[kind],
    );
  }

  // L'ordre doit contenir chaque fournisseur exactement une fois : on complete
  // avec ceux qui manquent (nouveau fournisseur ajoute cote serveur).
  const order = sanitizeProviderList(input.providerOrder, DEFAULT_SKIP_SETTINGS.providerOrder);
  for (const id of DEFAULT_SKIP_SETTINGS.providerOrder) {
    if (!order.includes(id)) order.push(id);
  }

  return {
    mode: SKIP_MODES.includes(input.mode as SkipMode) ? (input.mode as SkipMode) : DEFAULT_SKIP_SETTINGS.mode,
    types,
    colors,
    providerOrder: order,
    enabledProviders: Array.isArray(input.enabledProviders)
      ? sanitizeProviderList(input.enabledProviders, DEFAULT_SKIP_SETTINGS.enabledProviders)
      : [...DEFAULT_SKIP_SETTINGS.enabledProviders],
    minConfidence: clamp(input.minConfidence as number, 0, 1, DEFAULT_SKIP_SETTINGS.minConfidence),
    minSources: Math.round(clamp(input.minSources as number, 1, PROVIDER_IDS.length, DEFAULT_SKIP_SETTINGS.minSources)),
    promptDelay: clamp(input.promptDelay as number, 0, PROMPT_DELAY_MAX, DEFAULT_SKIP_SETTINGS.promptDelay),
    endOffset: clamp(input.endOffset as number, END_OFFSET_MIN, END_OFFSET_MAX, DEFAULT_SKIP_SETTINGS.endOffset),
    showMarkers: typeof input.showMarkers === 'boolean' ? input.showMarkers : DEFAULT_SKIP_SETTINGS.showMarkers,
    showCommunityProposals: typeof input.showCommunityProposals === 'boolean'
      ? input.showCommunityProposals
      : DEFAULT_SKIP_SETTINGS.showCommunityProposals,
    trustPendingProposals: typeof input.trustPendingProposals === 'boolean'
      ? input.trustPendingProposals
      : DEFAULT_SKIP_SETTINGS.trustPendingProposals,
    deferLoading: typeof input.deferLoading === 'boolean' ? input.deferLoading : DEFAULT_SKIP_SETTINGS.deferLoading,
  };
}

function emitChange(): void {
  try {
    window.dispatchEvent(new CustomEvent(SKIP_PREFS_CHANGE_EVENT));
  } catch {
    /* noop */
  }
}

export function getSkipSettings(): SkipSegmentSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return sanitize(null);
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize(null);
  }
}

/** Applique un patch partiel et renvoie l'etat complet resultant. */
export function setSkipSettings(patch: Partial<SkipSegmentSettings>): SkipSegmentSettings {
  const next = sanitize({ ...getSkipSettings(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
  emitChange();
  return next;
}

export function setSegmentTypeSettings(kind: SegmentKind, patch: Partial<SegmentTypeSettings>): SkipSegmentSettings {
  const current = getSkipSettings();
  return setSkipSettings({
    types: { ...current.types, [kind]: { ...current.types[kind], ...patch } },
  });
}

/** Change la couleur d'un type de sequence. */
export function setSegmentColor(kind: SegmentKind, hex: string): SkipSegmentSettings {
  const current = getSkipSettings();
  return setSkipSettings({
    colors: { ...current.colors, [kind]: normalizeHexColor(hex, DEFAULT_SEGMENT_COLORS[kind]) },
  });
}

/** Remet toutes les couleurs a leurs valeurs d'origine, sans toucher au reste. */
export function resetSegmentColors(): SkipSegmentSettings {
  return setSkipSettings({ colors: { ...DEFAULT_SEGMENT_COLORS } });
}

/** Active / desactive un fournisseur sans toucher a l'ordre de priorite. */
export function setProviderEnabled(id: ProviderId, enabled: boolean): SkipSegmentSettings {
  const current = getSkipSettings();
  const enabledProviders = enabled
    ? [...new Set([...current.enabledProviders, id])]
    : current.enabledProviders.filter((entry) => entry !== id);
  return setSkipSettings({ enabledProviders });
}

/** Deplace un fournisseur d'un cran dans l'ordre de priorite. */
export function moveProvider(id: ProviderId, direction: -1 | 1): SkipSegmentSettings {
  const current = getSkipSettings();
  const order = [...current.providerOrder];
  const index = order.indexOf(id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= order.length) return current;
  [order[index], order[target]] = [order[target], order[index]];
  return setSkipSettings({ providerOrder: order });
}

export function resetSkipSettings(): SkipSegmentSettings {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
  emitChange();
  return sanitize(null);
}

/**
 * Mode effectif pour un type donne : la surcharge par type gagne sur le mode
 * global, et un type desactive est toujours `off`.
 */
export function resolveSegmentMode(settings: SkipSegmentSettings, kind: SegmentKind): SkipMode {
  if (settings.mode === 'off') return 'off';
  const type = settings.types[kind];
  if (!type?.enabled) return 'off';
  if (type.mode === 'inherit') return settings.mode;
  return type.mode;
}

/** Y a-t-il au moins un type susceptible d'etre propose ? */
export function hasAnyActiveSegmentKind(settings: SkipSegmentSettings): boolean {
  return SEGMENT_KINDS.some((kind) => resolveSegmentMode(settings, kind) !== 'off');
}
