// src/components/SkipTransitionOverlay.tsx
//
// Voile court affiché pendant un saut de séquence.
//
// Sans lui, « passer l'intro » se traduit par une coupe sèche au milieu d'une
// image : ça se lit comme un bug de lecture plutôt que comme une action
// volontaire. Le voile masque le saut, absorbe la mise en tampon éventuelle à
// l'arrivée, et nomme ce qui vient d'être sauté.
//
// Le voile va au noir COMPLET, pas à un gris très sombre : un fondu qui
// s'arrête à 92 % laisse deviner l'image dessous, et c'est précisément ce
// résidu qui trahit la coupe. Les durées sont exportées pour que le fondu
// audio de `HLSPlayer` reste calé sur le fondu visuel — les deux doivent
// arriver au silence et au noir en même temps.

import React, { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SegmentKind } from '../utils/skipSegmentPrefs';

interface SkipTransitionOverlayProps {
  /** Type de séquence sautée, `null` quand aucun saut n'est en cours. */
  kind: SegmentKind | null;
  /** Couleur d'accent du type, la même que dans la barre de progression. */
  color: string;
  /**
   * `false` quand les transitions sont coupées (mode léger, appareil modeste,
   * `prefers-reduced-motion`) : le voile apparaît et disparaît sans animation
   * plutôt que d'être supprimé, pour que le saut reste annoncé.
   */
  animated: boolean;
  /** Le flou coûte cher sur les téléviseurs et les machines modestes. */
  blurEnabled: boolean;
}

/** Montée au noir. Le son suit la même durée. */
export const SKIP_FADE_IN_MS = 250;
/** Retour à l'image, plus lent : on couvre vite, on redécouvre en douceur. */
export const SKIP_FADE_OUT_MS = 500;

const LABEL_KEY_BY_KIND: Record<SegmentKind, string> = {
  intro: 'watch.introSkipped',
  recap: 'watch.recapSkipped',
  outro: 'watch.outroSkipped',
  credits: 'watch.creditsSkipped',
  preview: 'watch.previewSkipped',
};

const SkipTransitionOverlay: React.FC<SkipTransitionOverlayProps> = ({
  kind,
  color,
  animated,
  blurEnabled,
}) => {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {kind && (
        <motion.div
          key="skip-transition"
          // `z-30` : sous la barre de contrôles (z-40) et sous les cartes
          // flottantes (z-50), pour ne masquer que l'image.
          // `pointer-events-none` : le voile ne doit jamais intercepter un clic
          // destiné à la vidéo ou aux contrôles.
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black"
          initial={{ opacity: 0 }}
          // Entrée et sortie portent chacune leur durée : sans ça Framer
          // réutilise celle de l'entrée pour les deux, et le retour à l'image
          // serait aussi sec que la montée au noir.
          animate={{
            opacity: 1,
            transition: animated
              ? { duration: SKIP_FADE_IN_MS / 1000, ease: 'easeInOut' }
              : { duration: 0 },
          }}
          exit={{
            opacity: 0,
            transition: animated
              ? { duration: SKIP_FADE_OUT_MS / 1000, ease: 'easeInOut' }
              : { duration: 0 },
          }}
        >
          <motion.div
            className={`flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-5 py-2.5 ${
              blurEnabled ? 'backdrop-blur-sm' : ''
            }`}
            initial={animated ? { opacity: 0, scale: 0.94 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={animated ? { duration: 0.3, ease: 'easeOut', delay: 0.12 } : { duration: 0 }}
          >
            {/* Glissement vers la droite : c'est ce qui donne au voile le sens
                « on avance », plutôt que « quelque chose s'est interrompu ». */}
            <motion.span
              style={{ color }}
              initial={animated ? { x: -8, opacity: 0.3 } : false}
              animate={{ x: 0, opacity: 1 }}
              transition={animated ? { duration: 0.45, ease: 'easeOut', delay: 0.12 } : { duration: 0 }}
            >
              <SkipForward size={20} strokeWidth={2.5} />
            </motion.span>
            <span className="text-sm font-medium text-white">{t(LABEL_KEY_BY_KIND[kind])}</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default memo(SkipTransitionOverlay);
