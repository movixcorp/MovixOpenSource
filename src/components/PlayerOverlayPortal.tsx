import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { getOverlayPortalRoot } from '../utils/overlayPortal';

/**
 * Porte une surcouche de la page lecteur dans `#movix-overlay-root`.
 *
 * En plein écran, le lecteur passe en `.player-fullscreen-fill` avec un
 * `z-index` de 2147483000 (cf. `src/index.css`). Les panneaux des pages Watch
 * plafonnent, eux, à 10002 : ils s'ouvraient donc bien, mais peints sous le
 * lecteur, donc invisibles et inatteignables. Vu de l'utilisateur, le bouton
 * « Sources » ne faisait rien.
 *
 * La racine de portail suit l'élément plein écran toute seule et monte
 * au-dessus du lecteur (voir `utils/overlayPortal.ts`). Hors plein écran elle
 * est en `display: contents` : ses enfants se comportent exactement comme
 * s'ils étaient restés en place, positionnement et empilement inchangés.
 *
 * Attention au fond des panneaux : la règle
 * `#movix-overlay-root[data-fullscreen='true'] > *` pose `pointer-events: auto`
 * avec une spécificité (1,1,0). Une surcouche qui veut laisser passer les clics
 * vers le lecteur doit donc le dire en style inline, pas via la classe
 * utilitaire `pointer-events-none` (0,1,0), qui perdrait l'arbitrage.
 */
const PlayerOverlayPortal = ({ children }: { children: ReactNode }) =>
  createPortal(children, getOverlayPortalRoot());

export default PlayerOverlayPortal;
