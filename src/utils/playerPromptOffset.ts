// src/utils/playerPromptOffset.ts
//
// Géométrie des cartes flottantes du lecteur (`SkipSegmentPrompt`,
// `SegmentVotePrompt`) et forme de la proposition « À suivre ».
//
// Elle vit ici et pas dans l'un des composants parce que plusieurs doivent
// tomber exactement au même endroit : les cartes de saut et de vote ne
// s'affichent jamais ensemble (une séquence est soit adoptée, soit encore
// proposée), donc un écart entre leurs deux calculs se verrait comme un saut
// au moment où l'une remplace l'autre.

import type { NextContentDisplay } from './nextContentPrefs';

export interface ViewportShape {
  isMobile: boolean;
  isLandscape: boolean;
  isFullscreen: boolean;
}

/**
 * Décalage depuis le bas, en rem, d'une carte flottante.
 *
 * Il n'y a plus d'empilement au-dessus de la proposition « À suivre » : tant
 * qu'elle est affichée, le lecteur masque les cartes de saut et de vote (elles
 * reviennent dès qu'on la referme). Deux propositions concurrentes dans le même
 * coin, c'était surtout deux boutons qui se disputaient la touche Entrée.
 */
export function getPromptBottomRem(
  { isMobile, isLandscape, isFullscreen }: ViewportShape,
  controlsVisible: boolean,
): number {
  let base: number;

  if (isMobile && isLandscape) {
    base = isFullscreen ? 4 : 1;      // bottom-16 / bottom-4
  } else if (isMobile) {
    base = isFullscreen ? 4 : 0.5;    // bottom-16 / bottom-2
  } else {
    base = isFullscreen ? 5 : 1;      // bottom-20 / bottom-4
  }

  // Dégage la barre de contrôles quand elle est visible.
  return base + (controlsVisible ? 4.5 : 0);
}

/**
 * État d'affichage du lecteur.
 *
 * Lire `innerWidth` / `fullscreenElement` force un recalcul de style : à
 * appeler au montage et sur événement (`resize`, `fullscreenchange`), jamais à
 * chaque rendu. Le lecteur se rend plusieurs fois par seconde pendant la
 * lecture, et ces lectures-là finissaient par coûter des images perdues.
 */
export function readViewportShape(): ViewportShape {
  return {
    isMobile: window.innerWidth < 768,
    isLandscape: window.innerWidth > window.innerHeight,
    isFullscreen: !!document.fullscreenElement,
  };
}

/** Forme rendue par `UpNextPanel`. */
export type UpNextShape = 'panel' | 'drawer' | 'card';

/**
 * Forme réellement rendue pour un réglage donné.
 *
 * Pure : la forme du lecteur est passée en argument plutôt que lue ici, pour
 * que le calcul ne déclenche aucun recalcul de style.
 *
 * @param hideAll anti-spoil « infos prochain épisode » : le panneau n'aurait
 *   plus rien à montrer, on revient à la petite carte.
 */
export function resolveUpNextShape(
  display: NextContentDisplay,
  hideAll: boolean,
  shape: ViewportShape,
): UpNextShape {
  if (display !== 'panel') return 'card';
  if (hideAll) return 'card';
  // En portrait, un panneau latéral mangerait la moitié de l'image : c'est un
  // tiroir qui monte du bas, comme partout ailleurs sur mobile.
  if (shape.isMobile && !shape.isLandscape) return 'drawer';
  return 'panel';
}
