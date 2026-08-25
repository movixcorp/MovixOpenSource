// src/components/UpNextPanel.tsx
//
// Proposition « À suivre » du lecteur : épisode suivant, film suivant, ou
// relance à la fin d'un film. Remplace les trois composants quasi identiques
// qui vivaient dans `HLSPlayer.tsx` (`NextEpisodePrompt`, `NextUpPrompt`,
// `NextMovieOverlay`) — ils ne différaient que par le libellé des boutons et
// la source de l'image, mais chacun portait sa propre copie du placement
// responsive, ce qui les faisait diverger à chaque retouche.
//
// Trois formes (`resolveUpNextShape`) :
//
//  - `panel` : colonne de droite sur ordinateur et mobile en paysage. La vidéo
//    n'est PAS redimensionnée : elle porte déjà un zoom/pan, des sous-titres
//    positionnés en absolu, le plein écran et la synchro watch party, et un
//    `transform` sur son conteneur les décalerait tous. C'est un dégradé posé
//    par-dessus qui dégage la place.
//  - `drawer` : tiroir montant du bas sur mobile en portrait, où une colonne
//    latérale mangerait la moitié de l'image.
//  - `card` : la petite carte du coin bas-droite, comportement d'origine.
//
// Performance : le composant est `memo`, et le lecteur lui passe des props
// stables. Il se rend donc une fois par changement de contenu, pas quatre fois
// par seconde avec le reste du lecteur — un panneau plein écran redessiné à ce
// rythme par-dessus une vidéo suffit à faire chuter la lecture.

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import type { PanInfo } from 'framer-motion';
import { Play, X, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLightMode } from '../context/LightModeContext';
import { readViewportShape, resolveUpNextShape } from '../utils/playerPromptOffset';
import type { ViewportShape } from '../utils/playerPromptOffset';
import type { NextContentDisplay } from '../utils/nextContentPrefs';

/**
 * Ce que l'anti-spoil masque sur cette proposition.
 *
 * Résolu par l'appelant plutôt que déduit ici : seul le lecteur sait s'il
 * s'agit d'un épisode (les réglages anti-spoil portent sur les épisodes) ou
 * d'un film, pour lequel rien n'est masqué.
 */
export interface UpNextSpoiler {
  hideImage: boolean;
  hideTitle: boolean;
  hideOverview: boolean;
  /**
   * Réglage « Infos prochain épisode » : on ne montre plus rien de l'épisode,
   * juste de quoi l'enchaîner.
   */
  hideAll: boolean;
  maskedTitle: string;
  maskedOverview: string;
}

interface UpNextPanelProps {
  visible: boolean;
  display: NextContentDisplay;
  /** Surtitre : « S1 E2 » pour un épisode, l'année pour un film. */
  eyebrow?: string | null;
  title: string;
  overview?: string | null;
  /** Image de l'épisode (`still_path`) ou affiche du film, déjà en URL complète. */
  imageUrl?: string | null;
  /** Logo TMDB de la série / du film. Repli sur `showName` en texte. */
  logoUrl?: string | null;
  showName?: string | null;
  /** Ligne discrète : note, durée, date de diffusion. */
  meta?: string | null;
  spoiler?: UpNextSpoiler | null;
  /** 0 = pas de compte à rebours, on attend un clic. */
  autoplaySeconds: number;
  showKeyboardHint?: boolean;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
  /** Croix de fermeture. Souvent la même action que le bouton secondaire. */
  onDismiss: () => void;
}

/** Rayon du cercle de décompte, dans le repère 36×36 du SVG. */
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * `useTmdbImages` sert les logos en w300 — assez pour une vignette de
 * carrousel, trop petit ici. Même taille que le logo du `HeroSlider`.
 */
function upscaleLogo(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace('/t/p/w300/', '/t/p/w500/');
}

/**
 * Forme du lecteur, relue sur événement seulement.
 *
 * La lire à chaque rendu forcerait un recalcul de style plusieurs fois par
 * seconde pendant la lecture.
 */
function useViewportShape(): ViewportShape {
  const [shape, setShape] = useState<ViewportShape>(readViewportShape);

  useEffect(() => {
    const update = () => setShape(readViewportShape());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    document.addEventListener('fullscreenchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      document.removeEventListener('fullscreenchange', update);
    };
  }, []);

  return shape;
}

const CountdownRing: React.FC<{ remaining: number; total: number; animated: boolean }> = ({
  remaining, total, animated,
}) => {
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="5" />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          style={{
            strokeDashoffset: RING_CIRCUMFERENCE * (1 - ratio),
            transition: animated ? 'stroke-dashoffset 1s linear' : 'none',
          }}
        />
      </svg>
      <Play size={8} className="fill-current" />
    </span>
  );
};

const UpNextPanel: React.FC<UpNextPanelProps> = ({
  visible,
  display,
  eyebrow,
  title,
  overview,
  imageUrl,
  logoUrl,
  showName,
  meta,
  spoiler,
  autoplaySeconds,
  showKeyboardHint = true,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const { effectivePrefs } = useLightMode();
  const animated = effectivePrefs.transitions;
  const shape = useViewportShape();

  const form = resolveUpNextShape(display, Boolean(spoiler?.hideAll), shape);
  const logoSrc = upscaleLogo(logoUrl);

  // Révélation ponctuelle de l'image masquée : l'anti-spoil reste actif pour
  // les épisodes suivants, on ne fait qu'ouvrir celui-ci.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setRevealed(false); }, [title, imageUrl]);

  // `hideAll` ne masque pas le numéro d'épisode : savoir qu'on passe au 2 n'a
  // jamais rien révélé, et sans lui la carte ne dit plus rien du tout.
  const hideEverything = Boolean(spoiler?.hideAll);
  const hideImage = (Boolean(spoiler?.hideImage) && !revealed) || hideEverything;
  const shownTitle = spoiler?.hideTitle ? (spoiler.maskedTitle || title) : title;
  const shownOverview = spoiler?.hideOverview ? (spoiler.maskedOverview || '') : (overview || '');

  // ---------------------------------------------------------------------
  // Compte à rebours
  //
  // Toute interaction avec la proposition l'annule : on ne veut pas enchaîner
  // sous les doigts de quelqu'un en train de lire le résumé. Une fois annulé
  // il ne repart pas — la proposition reste, mais elle attend un clic.
  // ---------------------------------------------------------------------
  const countdownEnabled = visible && autoplaySeconds > 0;
  const [remaining, setRemaining] = useState(autoplaySeconds);
  const [cancelled, setCancelled] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    setRemaining(autoplaySeconds);
    setCancelled(false);
    firedRef.current = false;
  }, [autoplaySeconds, visible, title]);

  useEffect(() => {
    if (!countdownEnabled || cancelled) return;
    const id = window.setInterval(() => {
      setRemaining((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [countdownEnabled, cancelled]);

  useEffect(() => {
    if (!countdownEnabled || cancelled || remaining > 0 || firedRef.current) return;
    firedRef.current = true;
    onPrimary();
  }, [countdownEnabled, cancelled, remaining, onPrimary]);

  const cancelCountdown = useCallback(() => { setCancelled(true); }, []);

  // ---------------------------------------------------------------------
  // Balayage vers le bas pour fermer le tiroir
  //
  // Le glissement ne démarre que depuis la poignée et l'en-tête
  // (`dragListener` coupé, `dragControls.start` sur cette zone) : posé sur
  // tout le tiroir, il volerait le geste à la zone défilante du contenu.
  // ---------------------------------------------------------------------
  const dragControls = useDragControls();

  const handleDrawerDragEnd = useCallback((_event: unknown, info: PanInfo) => {
    // Distance franche ou pichenette rapide : les deux valent fermeture.
    if (info.offset.y > 90 || info.velocity.y > 600) {
      cancelCountdown();
      onDismiss();
    }
  }, [cancelCountdown, onDismiss]);

  const showCountdown = countdownEnabled && !cancelled;
  const primaryText = showCountdown
    ? t('watch.playbackInSeconds', { count: remaining })
    : primaryLabel;

  const stop = (event: React.SyntheticEvent) => { event.stopPropagation(); };

  const handlePrimary = (event: React.MouseEvent) => {
    stop(event);
    firedRef.current = true;
    onPrimary();
  };

  const handleSecondary = (event: React.MouseEvent) => {
    stop(event);
    cancelCountdown();
    onSecondary();
  };

  const handleDismiss = (event: React.MouseEvent) => {
    stop(event);
    cancelCountdown();
    onDismiss();
  };

  // ---------------------------------------------------------------------
  // Blocs partagés entre les trois formes
  // ---------------------------------------------------------------------
  const imageBlock = (className: string) => {
    // Anti-spoil global : plus d'emplacement d'image du tout, la carte se
    // réduit au strict nécessaire pour enchaîner.
    if (hideEverything) return null;
    if (hideImage) {
      return (
        <div className={`${className} flex flex-col items-center justify-center gap-2 bg-gray-800/80`}>
          <span className="px-2 text-center text-xs text-gray-400">{t('watch.hiddenImage')}</span>
          <button
            type="button"
            onClick={(event) => { stop(event); setRevealed(true); }}
            className="flex items-center gap-1.5 rounded bg-white/10 px-2 py-1 text-[11px] text-gray-200 transition-colors hover:bg-white/20"
          >
            <Eye size={12} />
            <span>{t('watch.revealAnyway')}</span>
          </button>
        </div>
      );
    }
    if (!imageUrl) return null;
    return <img src={imageUrl} alt={shownTitle} className={`${className} object-cover`} />;
  };

  /**
   * Logo de la série, calibré comme celui du `HeroSlider`.
   *
   * La hauteur est bornée en `vh` et pas seulement en pixels : un logo large
   * comme celui de « Silo » remplissait la largeur disponible et poussait le
   * titre de l'épisode hors du tiroir sur un écran court.
   */
  const logoBlock = (className: string) => (
    <div className="flex shrink-0 items-center">
      {logoSrc
        ? (
          <img
            src={logoSrc}
            alt={showName || ''}
            className={`block h-auto w-auto max-w-[70%] object-contain object-left ${className}`}
            draggable={false}
            decoding="async"
          />
        )
        : <span className="truncate text-base font-medium text-gray-100">{showName}</span>}
    </div>
  );

  const primaryButton = (
    <button
      type="button"
      onClick={handlePrimary}
      className="flex items-center justify-center gap-2 rounded bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-200"
    >
      {showCountdown
        ? <CountdownRing remaining={remaining} total={autoplaySeconds} animated={animated} />
        : <Play size={14} className="fill-current" />}
      <span>{primaryText}</span>
      {showKeyboardHint && (
        <kbd className="ml-0.5 hidden rounded border border-black/25 px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide opacity-60 md:inline">
          {t('watch.enterKey')}
        </kbd>
      )}
    </button>
  );

  const secondaryButton = (
    <button
      type="button"
      onClick={handleSecondary}
      className="rounded bg-gray-600/50 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-600"
    >
      {secondaryLabel}
    </button>
  );

  const heading = (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400">
        {t('watch.upNextTitle')}
      </span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('watch.dismiss')}
        className="-mr-1 -mt-1 rounded p-1 text-gray-400 transition-colors hover:text-white"
      >
        <X size={16} />
      </button>
    </div>
  );

  // Le titre et le surtitre ne se coupent jamais ; c'est le résumé qui rend la
  // place quand la hauteur manque (`hidden` sous 620 px de haut), puis l'image.
  const details = (
    <>
      {eyebrow && <p className="text-xs text-gray-400">{eyebrow}</p>}
      <p className="mt-0.5 line-clamp-2 text-base font-medium leading-snug text-white">{shownTitle}</p>
      {meta && <p className="mt-1 text-xs text-gray-400">{meta}</p>}
      {shownOverview && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-400 [@media(min-height:760px)]:line-clamp-4 [@media(max-height:620px)]:hidden">
          {shownOverview}
        </p>
      )}
    </>
  );

  // ---------------------------------------------------------------------
  // Panneau latéral
  // ---------------------------------------------------------------------
  if (form === 'panel') {
    // Deux `AnimatePresence` distincts plutôt qu'un fragment commun :
    // `AnimatePresence` doit voir ses enfants animés directement, un fragment
    // intermédiaire lui cache l'un des deux et son animation de sortie saute.
    return (
      <>
        <AnimatePresence>
          {visible && (
            /* Voile : la vidéo n'est pas touchée, seul un dégradé la couvre.
               `translateZ(0)` le pose sur sa propre couche GPU — sans ça, un
               grand aplat semi-transparent par-dessus une vidéo la fait
               repeindre image par image sur le processeur. */
            <motion.div
              key="up-next-veil"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: animated ? 0.25 : 0, ease: 'easeOut' }}
              style={{ transform: 'translateZ(0)', willChange: 'opacity' }}
              className="pointer-events-none absolute inset-y-0 right-0 z-[55] w-[62%] bg-gradient-to-l from-black via-black/90 to-transparent"
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {visible && (
            <motion.div
              key="up-next-panel"
              data-player-controls=""
              initial={{ opacity: 0, x: animated ? 24 : 0 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: animated ? 24 : 0 }}
              transition={{ duration: animated ? 0.25 : 0, ease: 'easeOut' }}
              onMouseDown={stop}
              onClick={stop}
              // Pleine hauteur, et au-dessus de tout le reste du lecteur : la
              // barre de contrôles est en `z-40`, la barre du haut (retour,
              // épisode précédent / suivant, liste des épisodes) en `z-50`.
              // Le panneau passe par-dessus les deux plutôt que de se serrer
              // entre elles, qui le rendait étriqué.
              //
              // Marge basse courte et constante : les boutons sont posés au
              // fond du panneau, et ne sautent pas quand la barre de contrôles
              // va et vient. Ils la recouvrent au besoin — c'est le sens du
              // `z-[60]`, la proposition prime tant qu'elle est ouverte.
              className="absolute inset-y-0 right-0 z-[60] flex w-[38%] min-w-[290px] max-w-[440px] flex-col gap-2 px-4 pb-4 pt-4 [@media(max-height:560px)]:pt-2"
            >
              {heading}
              {/* Zone défilante : l'image en 16:9 pleine largeur est plus haute
                  que le panneau sur un écran court, et elle poussait le titre
                  et les boutons dehors. Les boutons restent en dehors du
                  défilement, donc toujours atteignables. Pas de `vh` ni de
                  `flex-shrink` sur le ratio : l'un mesure la fenêtre et pas le
                  lecteur, l'autre écrase l'image à zéro. */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {logoBlock('max-h-12 [@media(max-height:560px)]:max-h-8')}
                {/* Hauteur fixe + `object-cover` : l'image se rogne un peu en
                    haut et en bas au lieu d'imposer son 16:9 plein cadre, qui
                    avalait le panneau entier sur les fenêtres étroites. */}
                {imageBlock('h-44 w-full shrink-0 overflow-hidden rounded-md bg-gray-800 [@media(max-height:600px)]:h-32')}
                <div className="shrink-0">{details}</div>
              </div>
              {/* `mt-auto` : collés en bas du panneau quoi qu'il arrive, même
                  si la zone défilante décide de ne pas s'étirer. */}
              <div className="mt-auto flex shrink-0 flex-col gap-2 pt-2">
                {primaryButton}
                {secondaryButton}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  // ---------------------------------------------------------------------
  // Tiroir (mobile en portrait)
  // ---------------------------------------------------------------------
  if (form === 'drawer') {
    return (
      <>
        <AnimatePresence>
          {visible && (
            <motion.div
              key="up-next-scrim"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: animated ? 0.2 : 0, ease: 'easeOut' }}
              style={{ transform: 'translateZ(0)', willChange: 'opacity' }}
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[55] h-1/2 bg-gradient-to-t from-black via-black/80 to-transparent"
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {visible && (
            <motion.div
              key="up-next-drawer"
              data-player-controls=""
              initial={{ y: animated ? '100%' : 0 }}
              animate={{ y: 0 }}
              exit={{ y: animated ? '100%' : 0 }}
              transition={{ duration: animated ? 0.25 : 0, ease: 'easeOut' }}
              onMouseDown={stop}
              onClick={stop}
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              // Bornes à zéro + élasticité vers le bas : le tiroir suit le
              // doigt en descente, remonte tout seul si on le relâche à
              // mi-course, et refuse de monter plus haut que sa place.
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.9 }}
              onDragEnd={handleDrawerDragEnd}
              className="absolute inset-x-0 bottom-0 z-[60] flex max-h-[85%] flex-col gap-2 rounded-t-2xl bg-neutral-950/95 px-4 pb-5 pt-2 backdrop-blur-md"
            >
              {/* Zone de prise du balayage : poignée + en-tête. `touch-none`
                  pour que le navigateur ne confisque pas le geste vertical
                  (défilement natif) avant framer-motion. */}
              <div
                className="-mx-4 -mt-2 shrink-0 cursor-grab touch-none select-none px-4 pt-2 active:cursor-grabbing"
                onPointerDown={(event) => dragControls.start(event)}
              >
                {/* Poignée : dit que ça vient du bas, comme les autres tiroirs. */}
                <span aria-hidden="true" className="mx-auto mb-1 block h-1 w-10 rounded-full bg-white/25" />
                {heading}
              </div>
              {/* Hauteur d'image FIXE (`object-cover` rogne l'excédent) : en
                  16:9 pleine largeur elle faisait à elle seule plus de la
                  moitié du tiroir et poussait le titre dehors. Le défilement
                  ne reste que comme filet de sécurité ; les boutons, eux, sont
                  hors de la zone défilante, donc toujours atteignables. */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {logoBlock('max-h-9')}
                {imageBlock('h-40 w-full shrink-0 overflow-hidden rounded-md bg-gray-800 [@media(max-height:600px)]:h-28')}
                <div className="shrink-0">{details}</div>
              </div>
              <div className="mt-2 flex shrink-0 flex-col gap-2">
                {primaryButton}
                {secondaryButton}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  // ---------------------------------------------------------------------
  // Carte (forme discrète, et repli de l'anti-spoil global)
  // ---------------------------------------------------------------------
  const cardPosition = shape.isMobile
    ? (shape.isLandscape
      ? `${shape.isFullscreen ? 'bottom-16' : 'bottom-4'} right-4 w-64`
      : `${shape.isFullscreen ? 'bottom-16' : 'bottom-2'} left-2 right-2`)
    : `${shape.isFullscreen ? 'bottom-20' : 'bottom-4'} right-4 w-96`;
  const cardImageWidth = shape.isMobile ? (shape.isLandscape ? 'w-16' : 'w-20') : 'w-32';
  // Sans image ni texte, la hauteur fixe ne laisserait qu'un grand vide.
  const cardHeight = hideEverything
    ? 'h-auto'
    : shape.isMobile ? (shape.isLandscape ? 'h-36' : 'h-40') : 'h-48';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="up-next-card"
          data-player-controls=""
          initial={{ opacity: 0, y: animated ? 12 : 0 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: animated ? 12 : 0 }}
          transition={{ duration: animated ? 0.18 : 0, ease: 'easeOut' }}
          onMouseDown={stop}
          onClick={stop}
          className={`absolute ${cardPosition} ${cardHeight} z-[60] overflow-hidden rounded-lg bg-black/80`}
        >
          <div className="flex h-full">
            {imageBlock(`h-full ${cardImageWidth} shrink-0`)}

            <div className="flex flex-1 flex-col justify-between overflow-hidden p-3">
              <div className="min-h-0">
                {heading}
                {eyebrow && <p className="mt-1 text-[11px] text-gray-400">{eyebrow}</p>}
                {!hideEverything && (
                  <>
                    <p className="line-clamp-2 text-sm font-medium leading-snug text-white">{shownTitle}</p>
                    {meta && <p className="mt-0.5 text-[11px] text-gray-400">{meta}</p>}
                    {shownOverview && !(shape.isMobile && shape.isLandscape) && (
                      <p className="mt-1 line-clamp-2 text-xs text-gray-400">{shownOverview}</p>
                    )}
                  </>
                )}
              </div>

              <div className="mt-2 flex shrink-0 gap-2 [&>button]:py-1 [&>button]:text-xs md:[&>button]:text-sm">
                {primaryButton}
                {secondaryButton}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default memo(UpNextPanel);
