// src/components/SwiftfluxGate.tsx
//
// Porte d'entrée du lecteur SwiftFlux (MP4 direct).
//
// Le partenaire ne facture rien mais impose son volume de publicité : une
// ouverture de plus que les autres sources. On la demande explicitement plutôt
// que de l'ouvrir dans le dos de l'utilisateur — un popunder silencieux sur un
// lecteur qu'il n'a pas encore choisi se solde par un onglet fermé et une
// impression perdue. Les VIP en sont dispensés : c'est ce qu'ils achètent.
//
// Vient ensuite Turnstile, obligatoire pour tout le monde (hors dispense
// admin) : c'est lui, et lui seul, qui débloque l'URL du fichier côté serveur.
// Sans cette étape, `/mp4/resolve` serait un robinet à liens directs sur le
// catalogue du partenaire, ouvert à n'importe quel script.
//
// La fenêtre se pose PAR-DESSUS ce qui joue, sans le remplacer : le lecteur en
// cours reste visible derrière le voile, et refuser la porte ne coûte rien —
// on retrouve exactement ce qu'on regardait. Même mécanique que le choix
// d'avatar (`AvatarSelector`) : framer-motion, portail d'overlay, fondu du
// voile et léger zoom du panneau.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';

import TurnstileWidget from './TurnstileWidget';
import { Button } from './ui/button';
import { getOverlayPortalRoot } from '../utils/overlayPortal';
import { isUserVip } from '../utils/vipUtils';
import {
  resolveSwiftfluxPlayback,
  type ResolveSwiftfluxParams,
  type SwiftfluxPlayback,
} from '../services/swiftfluxService';

/**
 * Smartlink imposé par le partenaire pour le catalogue MP4. Distinct du
 * popunder habituel de `adAdultMode` : celui-ci est la contrepartie de cette
 * source-là, pas la régie générale du site. Lu depuis le .env
 * (VITE_SWIFTFLUX_AD_URL) : vide = étape pub sautée, la porte commence
 * directement à la vérification Turnstile.
 */
export const SWIFTFLUX_AD_URL = (
  typeof import.meta.env.VITE_SWIFTFLUX_AD_URL === 'string'
    ? import.meta.env.VITE_SWIFTFLUX_AD_URL
    : ''
).trim();

type GateStep = 'ad' | 'verify' | 'resolving' | 'error';

interface SwiftfluxGateProps {
  /** Identité du contenu à débloquer. Le jeton Turnstile est ajouté ici. */
  request: Omit<ResolveSwiftfluxParams, 'turnstileToken'>;
  onResolved: (playback: SwiftfluxPlayback) => void;
  /** Croix, Échap ou clic sur le voile. Ce qui jouait derrière reprend la main. */
  onClose: () => void;
}

const SwiftfluxGate: React.FC<SwiftfluxGateProps> = ({ request, onResolved, onClose }) => {
  const { t } = useTranslation();
  // Le statut est lu une fois au montage : un changement de statut VIP en cours
  // de porte n'a pas à faire disparaître l'étape sous le doigt de l'utilisateur.
  const [isVip] = useState(() => isUserVip());
  // Pas de smartlink configuré (.env) = pas d'étape pub, pour personne.
  const skipAd = isVip || !SWIFTFLUX_AD_URL;
  const [step, setStep] = useState<GateStep>(() => (isUserVip() || !SWIFTFLUX_AD_URL ? 'verify' : 'ad'));
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [resetSignal, setResetSignal] = useState(0);
  // Laisse le fondu de sortie se jouer avant de rendre la main à la page.
  const [isClosing, setIsClosing] = useState(false);
  // Une résolution par jeton : le callback Turnstile peut se rejouer (refresh
  // automatique du widget) et relancerait sinon une requête déjà en vol.
  const resolvingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const close = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 300);
  }, [isClosing, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const openAd = useCallback(() => {
    if (SWIFTFLUX_AD_URL) window.open(SWIFTFLUX_AD_URL, '_blank', 'noopener,noreferrer');
    setStep('verify');
  }, []);

  const resolve = useCallback(async (verifiedToken: string) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setStep('resolving');
    setError('');
    try {
      onResolved(await resolveSwiftfluxPlayback({ ...request, turnstileToken: verifiedToken }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('watch.swiftflux.genericError'));
      setStep('error');
      setToken('');
      setResetSignal((n) => n + 1);
    } finally {
      resolvingRef.current = false;
    }
  }, [onResolved, request, t]);

  // Le jeton arrive de façon asynchrone (widget résolu ou dispense admin) : on
  // enchaîne dès qu'il est là, sans bouton intermédiaire à cliquer.
  useEffect(() => {
    if (step !== 'verify' || !token) return;
    void resolve(token);
  }, [resolve, step, token]);

  const retry = useCallback(() => {
    setError('');
    setStep(skipAd ? 'verify' : 'ad');
  }, [skipAd]);

  const StepIcon = step === 'ad'
    ? ExternalLink
    : step === 'verify'
      ? ShieldCheck
      : step === 'resolving'
        ? Loader2
        : AlertTriangle;

  const iconClass = step === 'ad'
    ? 'text-indigo-400'
    : step === 'verify'
      ? 'text-emerald-400'
      : step === 'resolving'
        ? 'text-indigo-400 animate-spin'
        : 'text-amber-400';

  const title = step === 'ad'
    ? t('watch.swiftflux.adTitle')
    : step === 'verify'
      ? t('watch.swiftflux.verifyTitle')
      : step === 'resolving'
        ? t('watch.swiftflux.resolvingTitle')
        : t('watch.swiftflux.errorTitle');

  const description = step === 'ad'
    ? t('watch.swiftflux.adDescription')
    : step === 'verify'
      ? t('watch.swiftflux.verifyDescription')
      : step === 'resolving'
        ? t('watch.swiftflux.resolvingDescription')
        : error || t('watch.swiftflux.genericError');

  const modalContent = (
    <AnimatePresence mode="wait">
      {!isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          data-lenis-prevent
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-gray-900 rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
          >
            <div className="flex justify-between items-start gap-4 mb-4">
              <h3 className="text-xl font-bold text-white">{title}</h3>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={close}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-white p-2 -mr-2 -mt-1 rounded-lg hover:bg-gray-800 transition-colors flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </div>

            <div className="text-center">
              <StepIcon className={`mx-auto h-12 w-12 mb-4 ${iconClass}`} />
              <p className="text-gray-300 mb-6">{description}</p>

              {step === 'ad' && (
                <div className="flex flex-col items-center gap-4">
                  <Button onClick={openAd} className="w-full sm:w-auto px-8">
                    {t('watch.swiftflux.openAd')}
                  </Button>
                  <button
                    type="button"
                    onClick={close}
                    className="text-sm text-gray-400 hover:text-gray-200 underline"
                  >
                    {t('watch.swiftflux.chooseAnother')}
                  </button>
                </div>
              )}

              {step === 'verify' && (
                <div className="flex justify-center">
                  <TurnstileWidget
                    onTokenChange={setToken}
                    resetSignal={resetSignal}
                    action="swiftflux-playback"
                    // Le serveur ne dispense personne sur cette route : l'équipe
                    // passe le challenge comme tout le monde, sinon elle
                    // enverrait un marqueur que Cloudflare refuse.
                    forceChallenge
                    className="origin-center scale-[0.85] sm:scale-100"
                  />
                </div>
              )}

              {step === 'error' && (
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <Button onClick={retry} className="px-8">{t('watch.swiftflux.retry')}</Button>
                  <Button variant="ghost" onClick={close} className="px-8">
                    {t('watch.swiftflux.chooseAnother')}
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(modalContent, getOverlayPortalRoot());
};

export default SwiftfluxGate;
