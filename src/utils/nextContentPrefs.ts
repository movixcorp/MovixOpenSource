// src/utils/nextContentPrefs.ts
//
// Réglages de la proposition « À suivre » (épisode ou film suivant) : quand
// elle apparaît, sous quelle forme, et au bout de combien de temps elle
// enchaîne toute seule.
//
// Storage : localStorage sous une clé unique préfixée `player` → captée par
// `SYNCABLE_PREFIXES` (`src/utils/syncStorage.ts` et
// `API/Mainapi/utils/syncPolicy.js`), donc synchronisée entre appareils sans
// travail supplémentaire. Même raisonnement que `skipSegmentPrefs.ts` : ces
// réglages n'ont de sens qu'ensemble, une lecture partielle donnerait un état
// incohérent le temps d'une synchro.
//
// Les deux seuils (pourcentage et temps avant la fin) sont stockés séparément.
// Avant, une seule valeur servait aux deux modes : régler « 5 min avant la
// fin » puis repasser en pourcentage donnait 300 %, un seuil que la lecture
// n'atteint jamais — la carte ne s'affichait plus du tout.

export type NextContentTrigger = 'threshold' | 'segment';
export type NextContentThresholdMode = 'percentage' | 'timeBeforeEnd';
export type NextContentDisplay = 'panel' | 'card';

export interface NextContentPrefs {
  /**
   * Ce qui déclenche la proposition.
   *
   * - `threshold` : le seuil réglé ci-dessous, comme avant.
   * - `segment` : le début du générique de fin relevé par les bases de
   *   séquences (`outro` ou `credits`). Quand aucun n'est connu pour ce
   *   contenu, on retombe sur le seuil — d'où la présence des deux réglages
   *   en même temps.
   */
  trigger: NextContentTrigger;
  thresholdMode: NextContentThresholdMode;
  /** Part de la vidéo lue, en pourcent. Utilisé si `thresholdMode === 'percentage'`. */
  percentage: number;
  /** Secondes restantes. Utilisé si `thresholdMode === 'timeBeforeEnd'`. */
  timeBeforeEnd: number;
  /**
   * `panel` : panneau latéral droit, image de l'épisode et logo de la série.
   * `card` : la petite carte du coin bas-droite, plus discrète.
   */
  display: NextContentDisplay;
  /**
   * Secondes avant l'enchaînement automatique une fois la proposition
   * affichée. `0` = jamais : on attend un clic, ce qui reste le comportement
   * par défaut (l'enchaînement à la toute fin de la vidéo, lui, dépend du
   * réglage « épisode suivant automatique » et n'est pas touché ici).
   */
  autoplaySeconds: number;
}

const STORAGE_KEY = 'playerNextContent';

export const NEXT_CONTENT_PREFS_CHANGE_EVENT = 'movix-next-content-prefs-changed';

export const PERCENTAGE_MIN = 50;
export const PERCENTAGE_MAX = 99;
export const TIME_BEFORE_END_MIN = 30;
export const TIME_BEFORE_END_MAX = 300;
export const AUTOPLAY_SECONDS_MAX = 30;
/** En dessous, le compte à rebours se termine avant qu'on ait lu la carte. */
export const AUTOPLAY_SECONDS_MIN = 3;

export const DEFAULT_NEXT_CONTENT_PREFS: NextContentPrefs = {
  // Le générique par défaut : c'est le moment juste, et le repli sur le seuil
  // rend le choix sans risque même quand aucune base ne connaît le contenu.
  trigger: 'segment',
  thresholdMode: 'percentage',
  // 99 % : sans générique relevé, mieux vaut proposer la suite au tout dernier
  // moment que couper une fin de scène cinq minutes trop tôt.
  percentage: 99,
  timeBeforeEnd: 60,
  display: 'panel',
  autoplaySeconds: 0,
};

// Clés de l'ancien format, lues une seule fois pour ne pas réinitialiser les
// réglages de ceux qui avaient déjà touché au seuil.
const LEGACY_MODE_KEY = 'playerNextContentThresholdMode';
const LEGACY_VALUE_KEY = 'playerNextContentThresholdValue';

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Fusionne une valeur stockée avec les défauts.
 *
 * Tolérant par construction : une préférence écrite par une version antérieure
 * (ou par une autre plateforme via la synchro) ne doit jamais casser le
 * lecteur. Toute valeur inconnue retombe sur le défaut.
 */
function sanitize(raw: unknown): NextContentPrefs {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<NextContentPrefs>;

  const autoplay = clamp(input.autoplaySeconds, 0, AUTOPLAY_SECONDS_MAX, DEFAULT_NEXT_CONTENT_PREFS.autoplaySeconds);

  return {
    trigger: input.trigger === 'threshold' || input.trigger === 'segment'
      ? input.trigger
      : DEFAULT_NEXT_CONTENT_PREFS.trigger,
    thresholdMode: input.thresholdMode === 'percentage' || input.thresholdMode === 'timeBeforeEnd'
      ? input.thresholdMode
      : DEFAULT_NEXT_CONTENT_PREFS.thresholdMode,
    percentage: Math.round(clamp(
      input.percentage, PERCENTAGE_MIN, PERCENTAGE_MAX, DEFAULT_NEXT_CONTENT_PREFS.percentage,
    )),
    timeBeforeEnd: Math.round(clamp(
      input.timeBeforeEnd, TIME_BEFORE_END_MIN, TIME_BEFORE_END_MAX, DEFAULT_NEXT_CONTENT_PREFS.timeBeforeEnd,
    )),
    display: input.display === 'panel' || input.display === 'card'
      ? input.display
      : DEFAULT_NEXT_CONTENT_PREFS.display,
    // Un compte à rebours d'une ou deux secondes est ininterrompable en
    // pratique : soit on ne l'active pas, soit il laisse le temps de réagir.
    autoplaySeconds: autoplay > 0 ? Math.max(AUTOPLAY_SECONDS_MIN, Math.round(autoplay)) : 0,
  };
}

/** Reprend les deux anciennes clés quand la nouvelle n'existe pas encore. */
function readLegacy(): Partial<NextContentPrefs> {
  try {
    const mode = localStorage.getItem(LEGACY_MODE_KEY);
    const value = Number(localStorage.getItem(LEGACY_VALUE_KEY));
    if (mode !== 'percentage' && mode !== 'timeBeforeEnd') return {};
    if (!Number.isFinite(value)) return { thresholdMode: mode };
    return mode === 'percentage'
      ? { thresholdMode: mode, percentage: value }
      : { thresholdMode: mode, timeBeforeEnd: value };
  } catch {
    return {};
  }
}

/**
 * L'utilisateur a-t-il déjà des réglages à lui ?
 *
 * Sert au lecteur pour savoir s'il peut encore appliquer la valeur initiale
 * passée en prop (`nextContentThreshold`) sans écraser un choix explicite.
 */
export function hasStoredNextContentPrefs(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
      || localStorage.getItem(LEGACY_MODE_KEY) !== null;
  } catch {
    return false;
  }
}

export function getNextContentPrefs(): NextContentPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
    return sanitize(readLegacy());
  } catch {
    return sanitize(null);
  }
}

/** Applique un patch partiel et renvoie l'état complet résultant. */
export function setNextContentPrefs(patch: Partial<NextContentPrefs>): NextContentPrefs {
  const next = sanitize({ ...getNextContentPrefs(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent(NEXT_CONTENT_PREFS_CHANGE_EVENT));
  } catch {
    /* noop */
  }
  return next;
}

/** Valeur du seuil courant, dans l'unité du mode sélectionné. */
export function getThresholdValue(prefs: NextContentPrefs): number {
  return prefs.thresholdMode === 'percentage' ? prefs.percentage : prefs.timeBeforeEnd;
}

/**
 * Le seuil est-il atteint ?
 *
 * Sert aussi de repli quand `trigger === 'segment'` mais qu'aucun générique
 * n'est connu : c'est bien le mode choisi ici qui reprend la main, pas un
 * défaut arbitraire.
 */
export function isThresholdReached(
  prefs: NextContentPrefs,
  currentTime: number,
  duration: number,
): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (prefs.thresholdMode === 'percentage') {
    return (currentTime / duration) * 100 >= prefs.percentage;
  }
  return duration - currentTime <= prefs.timeBeforeEnd;
}
