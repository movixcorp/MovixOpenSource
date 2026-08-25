/**
 * Quel pointeur pilote réellement l'interface — souris ou doigt.
 *
 * ## Pourquoi ce n'est pas `isTouchDevice`
 *
 * `'ontouchstart' in window || navigator.maxTouchPoints > 0` ne dit que ce dont
 * l'appareil est *capable*. Un portable à dalle tactile piloté à la souris y
 * répond « tactile », et le lecteur lui coupait alors tout le chemin souris :
 * le curseur ne s'escamotait plus avec la barre de lecture, et bouger la
 * souris ne la rappelait plus. Le curseur semblait quand même disparaître au
 * repos, mais c'était le navigateur qui le masquait de lui-même en plein
 * écran — un secours qui ne se réarme pas après un changement d'épisode, d'où
 * un curseur planté sur le film jusqu'à la fin.
 *
 * On retient donc le dernier pointeur réellement utilisé, `pointerType` à
 * l'appui. Un appareil sait être les deux tour à tour, et c'est l'usage du
 * moment qui compte, pas le matériel.
 *
 * ## Pourquoi l'état vit hors de React
 *
 * Le lecteur est démonté puis remonté à chaque changement d'épisode (voir
 * `playerFullscreenPersistence.ts`). Un état local repartirait de zéro à
 * chaque épisode, et le lecteur retomberait sur la valeur par défaut — donc
 * « tactile » sur ces machines — précisément dans le cas qui posait problème.
 * Au niveau du module, la valeur traverse les remontages.
 */

export type PointerKind = 'mouse' | 'touch';

/**
 * Par défaut on suit la capacité de l'appareil : c'est la meilleure supposition
 * tant qu'aucun pointeur ne s'est manifesté. Le premier événement tranche.
 */
const initialKind = (): PointerKind => {
  if (typeof window === 'undefined') return 'mouse';
  const touchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return touchCapable ? 'touch' : 'mouse';
};

let kind: PointerKind = initialKind();
let listening = false;
const listeners = new Set<() => void>();

/** Le stylet a un curseur à l'écran : il se comporte comme une souris. */
const kindOf = (event: PointerEvent): PointerKind =>
  event.pointerType === 'touch' ? 'touch' : 'mouse';

const handlePointer = (event: PointerEvent): void => {
  const next = kindOf(event);
  if (next === kind) return;
  kind = next;
  listeners.forEach(listener => listener());
};

const startListening = (): void => {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // En capture, pour ne pas dépendre de ce qu'un gestionnaire en aval arrête.
  window.addEventListener('pointerdown', handlePointer, { capture: true, passive: true });
  window.addEventListener('pointermove', handlePointer, { capture: true, passive: true });
};

/** Le pointeur en cours. Lecture pure : `subscribePointerKind` fait l'écoute. */
export const getPointerKind = (): PointerKind => kind;

/** Rendu serveur : aucun pointeur, on répond souris pour ne rien escamoter. */
export const getServerPointerKind = (): PointerKind => 'mouse';

/** S'abonne aux changements de pointeur et arme l'écoute au premier abonné. */
export const subscribePointerKind = (listener: () => void): (() => void) => {
  startListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
