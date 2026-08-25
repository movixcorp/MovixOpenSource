/**
 * Racine d'accueil des portails : menus déroulants, listes de sélection,
 * modales, info-bulles.
 *
 * ## Pourquoi ça ne s'affichait pas en plein écran
 *
 * Un élément passé en plein écran est promu dans la « top layer » du
 * navigateur : lui seul et sa descendance sont peints, tout le reste du
 * document est masqué. Or nos surcouches étaient portées dans
 * `document.body`, donc *en dehors* de l'élément plein écran — le lecteur
 * étant lui-même dans l'hôte plein écran (`#movix-fullscreen-host`, voir
 * `playerFullscreenPersistence.ts`). Le menu s'ouvrait bel et bien, mais
 * restait invisible et inatteignable : on ne pouvait plus choisir une langue
 * de sous-titres, une source, ni rien de ce qui passe par un portail.
 *
 * ## Comment on le règle
 *
 * Tous les portails partagent désormais une seule racine,
 * `#movix-overlay-root`, que ce module déplace au gré du plein écran :
 *
 * - hors plein écran, elle vit dans `document.body` en `display: contents`.
 *   Elle ne génère alors aucune boîte : ses enfants se comportent exactement
 *   comme s'ils étaient enfants directs de `body`, positionnement et ordre
 *   d'empilement inchangés. Rien ne bouge par rapport à l'existant.
 * - en plein écran, elle est greffée *dans* l'élément plein écran et passe en
 *   `position: fixed; inset: 0`, avec un `z-index` maximal : le lecteur monte
 *   déjà à 2147483000 (`.player-fullscreen-fill`), il faut donc passer
 *   au-dessus. `pointer-events: none` sur la racine — et `auto` sur ses
 *   enfants directs — l'empêche d'intercepter les clics destinés aux
 *   contrôles du lecteur quand aucune surcouche n'est ouverte.
 *
 * La racine étant unique et d'identité stable, React ne remonte jamais les
 * portails quand elle change de parent : un menu ouvert survit à l'entrée
 * comme à la sortie du plein écran.
 *
 * Les styles associés sont dans `src/index.css`.
 */

import { getFullscreenElement } from './playerFullscreenPersistence';

export const OVERLAY_PORTAL_ROOT_ID = 'movix-overlay-root';

/** Toutes les préfixations de l'événement de changement de plein écran. */
const FULLSCREEN_CHANGE_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
] as const;

/**
 * Éléments remplacés : le navigateur ignore les enfants qu'on leur greffe.
 * Si l'un d'eux occupe le plein écran (une `<video>` mise en plein écran
 * directement, par exemple), aucune surcouche n'est affichable — on reste
 * alors dans `body` plutôt que de greffer dans le vide.
 */
const CHILDLESS_TAGS = new Set([
  'VIDEO',
  'AUDIO',
  'IMG',
  'CANVAS',
  'IFRAME',
  'EMBED',
  'OBJECT',
  'INPUT',
  'TEXTAREA',
]);

let root: HTMLElement | null = null;
let listening = false;

/** L'élément qui doit héberger la racine : le plein écran s'il le peut. */
const resolveHost = (): HTMLElement => {
  const element = getFullscreenElement();
  if (element instanceof HTMLElement && !CHILDLESS_TAGS.has(element.tagName)) {
    return element;
  }
  return document.body;
};

/** Replace la racine sous le bon hôte et bascule son mode d'affichage. */
const syncPlacement = (): void => {
  if (!root) return;
  const host = resolveHost();
  // Un élément situé *dans* une surcouche peut lui-même passer en plein écran.
  // Y greffer la racine formerait un cycle, et `appendChild` lèverait une
  // `HierarchyRequestError` : on la laisse où elle est.
  if (root.contains(host)) return;
  if (root.parentElement !== host) host.appendChild(root);
  root.dataset.fullscreen = String(host !== document.body);
};

/**
 * La racine où porter une surcouche. À appeler au rendu, à la place de
 * `document.body` : le résultat est stable et suit le plein écran tout seul.
 */
export const getOverlayPortalRoot = (): HTMLElement => {
  if (!root) {
    const existing = document.getElementById(OVERLAY_PORTAL_ROOT_ID);
    root = existing instanceof HTMLElement ? existing : document.createElement('div');
    root.id = OVERLAY_PORTAL_ROOT_ID;
  }

  if (!listening) {
    listening = true;
    FULLSCREEN_CHANGE_EVENTS.forEach(event => document.addEventListener(event, syncPlacement));
  }

  syncPlacement();
  return root;
};
