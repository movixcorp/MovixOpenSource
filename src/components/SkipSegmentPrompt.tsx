// src/components/SkipSegmentPrompt.tsx
//
// Carte flottante « Passer l'intro / l'outro / … », calquée sur `NextUpPrompt`
// et `NextEpisodePrompt` de `HLSPlayer` : même ancrage bas-droite, même fond
// `bg-black/80 rounded-lg`, mêmes boutons. Un seul langage visuel pour toutes
// les propositions du lecteur.
//
// La couleur d'accent vient des réglages de l'utilisateur (une teinte par type
// de séquence), la même que celle du marqueur dans la barre de progression :
// c'est ce qui fait le lien entre « cette bande jaune » et « ce bouton ».
//
// La carte n'a plus à esquiver la proposition « À suivre » : tant que celle-ci
// est affichée, le lecteur masque ce bouton, et il revient dès qu'on la
// referme. Deux propositions dans le même coin, c'était surtout deux boutons
// qui se disputaient la touche Entrée.
//
// Le `bottom` change quand la barre de contrôles apparaît/disparaît. Comme le
// conteneur de sous-titres
// (`transition-[bottom,left] duration-200 ease-out` dans `HLSPlayer`), on
// interpole ce déplacement plutôt que de le faire d'un coup, avec le même
// timing que la barre elle-même (0.2 s ease-out) : les deux glissent ensemble.

import React, { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SkipForward, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SegmentKind } from '../utils/skipSegmentPrefs';
import { getPromptBottomRem, readViewportShape } from '../utils/playerPromptOffset';

interface SkipSegmentPromptProps {
  visible: boolean;
  kind: SegmentKind;
  /** Couleur d'accent du type, en hexadécimal. */
  color: string;
  /** Secondes restantes dans la séquence, pour situer la longueur du saut. */
  remainingSeconds: number;
  /** Remonte la carte pour ne pas passer sous la barre de contrôles. */
  controlsVisible: boolean;
  /** Masque l'indice clavier sur tactile, où il n'a aucun sens. */
  showKeyboardHint?: boolean;
  onSkip: () => void;
  onDismiss: () => void;
}

const LABEL_KEY_BY_KIND: Record<SegmentKind, string> = {
  intro: 'watch.skipIntro',
  recap: 'watch.skipRecap',
  outro: 'watch.skipOutro',
  credits: 'watch.skipCredits',
  preview: 'watch.skipPreview',
};

function formatRemaining(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded} s`;
  return `${Math.floor(rounded / 60)} min ${String(rounded % 60).padStart(2, '0')}`;
}

const SkipSegmentPrompt: React.FC<SkipSegmentPromptProps> = ({
  visible,
  kind,
  color,
  remainingSeconds,
  controlsVisible,
  showKeyboardHint = true,
  onSkip,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const bottomRem = getPromptBottomRem(readViewportShape(), controlsVisible);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          // `data-player-controls` : marque la carte comme faisant partie des
          // contrôles, sinon un clic dessus est traité comme un clic vidéo
          // (play/pause) par `handleVideoClick`.
          data-player-controls=""
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="absolute right-4 z-50 overflow-hidden rounded-lg bg-black/80 backdrop-blur-sm transition-[bottom] duration-200 ease-out"
          style={{ bottom: `${bottomRem}rem` }}
        >
          <div className="flex items-stretch">
            {/* Rappel de la couleur du marqueur dans la barre de progression. */}
            <span aria-hidden="true" className="w-1 shrink-0" style={{ backgroundColor: color }} />

            <div className="flex items-center gap-3 py-2.5 pl-3 pr-2">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSkip();
                }}
                className="flex items-center gap-2 rounded bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-gray-200"
              >
                <SkipForward size={16} />
                <span>{t(LABEL_KEY_BY_KIND[kind])}</span>
                {showKeyboardHint && (
                  <kbd className="ml-1 hidden rounded border border-black/25 px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide opacity-60 md:inline">
                    {t('watch.enterKey')}
                  </kbd>
                )}
              </button>

              <span className="hidden text-xs tabular-nums text-gray-400 sm:inline">
                {formatRemaining(remainingSeconds)}
              </span>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDismiss();
                }}
                aria-label={t('watch.dismiss')}
                className="rounded p-1 text-gray-400 transition-colors hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default memo(SkipSegmentPrompt);
