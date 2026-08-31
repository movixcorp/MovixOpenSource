import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Crown, Play, Puzzle, ShieldAlert, Smartphone, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAdFreePopup } from "../context/AdFreePopupContext";
import { getAdPopupMode, subscribeToAdPopupModeChanges, type AdPopupMode } from "../utils/adPopupMode";
import { getAdTargetUrls, isAdultAdsEnabled, subscribeToAdultAdsChanges } from "../utils/adAdultMode";
import {
  SCRIPT_AD_MODE_ENABLED,
  getAdScriptState,
  loadAdScript,
  subscribeToAdScriptState,
  type AdScriptState,
} from "../utils/adScriptMode";
import { getOverlayPortalRoot } from "@/utils/overlayPortal";
import { isMobileOrTabletDevice } from "../utils/deviceDetection";

// Interrupteurs build-time des avertissements du popup de pub (constantes de
// code, pas des réglages utilisateur — même principe que SCRIPT_AD_MODE_ENABLED).
// SHOW_ADULT_AD_WARNING : encart rouge « contenu explicite +18 ».
// SHOW_AD_PAGE_WARNING : bandeau jaune « ne clique rien, ne scanne rien, ne télécharge rien ».
const SHOW_ADULT_AD_WARNING: boolean = false;
const SHOW_AD_PAGE_WARNING: boolean = false;

interface AdFreePlayerAdsProps {
  onClose?: () => void;
  onAccept?: () => void;
  adType?: "ad1" | "ad2";
  onAdClick?: () => void;
  variant?: "player" | "download" | "livetv";
}

const AdFreePlayerAds: React.FC<AdFreePlayerAdsProps> = ({
  onClose,
  onAccept,
  adType: propAdType,
  onAdClick,
  variant = "player",
}) => {
  const { t } = useTranslation();
  const {
    showAdFreePopup,
    adType: contextAdType,
    isVoVostfrOnly,
    handlePopupAccept,
  } = useAdFreePopup();

  const finalAdType = propAdType || contextAdType;
  const finalOnAccept = onAccept || handlePopupAccept;
  const shouldShow = !!onClose || showAdFreePopup;

  const [hasClicked, setHasClicked] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  // Mobile/tablette → on pousse l'appli ; PC/Mac → l'extension navigateur.
  const isMobile = useMemo(() => isMobileOrTabletDevice(), []);
  const [popupMode, setPopupMode] = useState<AdPopupMode>(() => getAdPopupMode());
  const [adultAdsOn, setAdultAdsOn] = useState<boolean>(() => isAdultAdsEnabled());
  const [scriptState, setScriptState] = useState<AdScriptState>(() => getAdScriptState());
  const autoFiredRef = useRef(false);
  const scriptAdFiredRef = useRef(false);
  const scriptAcceptTimeoutRef = useRef<number | null>(null);

  // Le mode script ne s'applique qu'au popup normal avec bouton. Les modes auto
  // et click-anywhere gardent le lien direct.
  const scriptAdMode = popupMode === 'normal' && SCRIPT_AD_MODE_ENABLED;
  // Script réellement utilisable : un bloqueur qui annule son chargement passe
  // l'état à 'failed' → le clic valide alors directement, sans ouvrir de pub
  // (ni script ni lien direct) et sans attendre le timer du geste script.
  const scriptAdActive = scriptAdMode && scriptState !== 'failed';

  useEffect(() => subscribeToAdPopupModeChanges(setPopupMode), []);
  useEffect(() => subscribeToAdultAdsChanges(setAdultAdsOn), []);
  useEffect(() => subscribeToAdScriptState(setScriptState), []);

  useEffect(() => {
    // Reset des gardes quand le popup disparaît, pour laisser le suivant se déclencher.
    if (!shouldShow) {
      autoFiredRef.current = false;
      scriptAdFiredRef.current = false;
      if (scriptAcceptTimeoutRef.current !== null) {
        window.clearTimeout(scriptAcceptTimeoutRef.current);
        scriptAcceptTimeoutRef.current = null;
      }
    }
  }, [shouldShow]);

  useEffect(() => {
    if (shouldShow && scriptAdMode) loadAdScript();
  }, [shouldShow, scriptAdMode]);

  useEffect(() => {
    if (!shouldShow || popupMode !== 'normal') return;

    const lenis = (
      window as Window & { lenis?: { stop: () => void; start: () => void } }
    ).lenis;
    if (lenis) lenis.stop();

    return () => {
      if (lenis) lenis.start();
    };
  }, [shouldShow, popupMode]);

  // Ouvre toutes les cibles pub (1 fenêtre par URL) dans le même geste user.
  // Anchor créé à l'exécution pour éviter le filtrage réseau (Brave Shields /
  // EasyList). Cibles déterminées par le toggle "Publicités +18" : en +18 = les
  // 3 directlinks, sinon le lien SFW unique (utils/adAdultMode). Lu frais au clic.
  // NB: le navigateur n'autorise qu'1 popup non sollicité par geste -> les autres
  // sont souvent bloqués sauf si l'utilisateur autorise les popups pour le site.
  const openAdLinks = useCallback(() => {
    getAdTargetUrls().forEach((url) => {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }, []);

  const handleLinkClick = useCallback(() => {
    openAdLinks();
    setHasClicked(true);
    if (onAdClick) onAdClick();
  }, [openAdLinks, onAdClick]);

  const completeScriptAdGesture = useCallback(() => {
    if (scriptAcceptTimeoutRef.current !== null) {
      window.clearTimeout(scriptAcceptTimeoutRef.current);
      scriptAcceptTimeoutRef.current = null;
    }
    if (onAdClick) onAdClick();
    setHasClicked(true);
  }, [onAdClick]);

  const beginScriptAdGesture = useCallback(() => {
    if (scriptAdFiredRef.current) return;
    scriptAdFiredRef.current = true;
    loadAdScript();
    scriptAcceptTimeoutRef.current = window.setTimeout(completeScriptAdGesture, 700);
  }, [completeScriptAdGesture]);

  // Le popunder peut consommer le onClick React. La capture pointerdown prépare
  // la détection avant les listeners document du script.
  useEffect(() => {
    if (!shouldShow || !scriptAdActive || hasClicked) return;
    const onCapturePointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest('[data-ad-view-button]')) beginScriptAdGesture();
    };
    window.addEventListener('pointerdown', onCapturePointer, true);
    return () => window.removeEventListener('pointerdown', onCapturePointer, true);
  }, [shouldShow, scriptAdActive, hasClicked, beginScriptAdGesture]);

  // Fermeture avec animation de sortie avant de notifier le parent
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      finalOnAccept();
    }, 300);
  }, [finalOnAccept]);

  // Auto mode: fire the ad + accept as soon as the popup is requested. The
  // guard ref ensures a single trigger per popup lifecycle (re-renders won't
  // re-fire it). The reset effect above clears the guard when shouldShow flips
  // back to false, so the next popup can trigger again.
  useEffect(() => {
    if (!shouldShow || popupMode !== 'auto' || autoFiredRef.current) return;
    autoFiredRef.current = true;
    handleLinkClick();
    finalOnAccept();
  }, [shouldShow, popupMode, handleLinkClick, finalOnAccept]);

  // Texte contextualisé
  const headerText = hasClicked
    ? variant === "download"
      ? t("adBlocker.thanksUnlockedDownload")
      : variant === "livetv"
        ? t("adBlocker.thanksUnlockedAccess")
        : t("adBlocker.thanksForHelp")
    : variant === "download"
      ? t("adBlocker.stepBeforeDownload")
      : variant === "livetv"
        ? t("adBlocker.accessLiveTV")
        : t("adBlocker.stepBeforeVideo");

  const descriptionText = hasClicked
    ? variant === "download"
      ? t("adBlocker.thanksDownloadDesc")
      : variant === "livetv"
        ? t("adBlocker.thanksLiveTVDesc")
        : t("adBlocker.thanksPlayerDesc")
    : variant === "download"
      ? t("adBlocker.stepDownloadDesc")
      : variant === "livetv"
        ? t("adBlocker.stepLiveTVDesc")
        : isVoVostfrOnly
          ? t("adBlocker.stepVoVostfrDesc")
          : t("adBlocker.stepPlayerDesc");

  const primaryButtonLabel = hasClicked
    ? variant === "download"
      ? t("adBlocker.decodeLink")
      : variant === "livetv"
        ? t("adBlocker.accessChannel")
        : t("adBlocker.playback")
    : variant === "download"
      ? t("adBlocker.viewAdSpace")
      : t("adBlocker.viewAd");

  if (!shouldShow) return null;

  // Auto mode: useEffect above fires the ad + accept; render nothing.
  if (popupMode === 'auto') return null;

  // Click-anywhere mode: invisible full-screen catcher, first click opens ad + accepts.
  if (popupMode === 'click-anywhere' && !hasClicked) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={t('adBlocker.clickAnywhereLabel')}
        className="fixed inset-0 z-[100000] cursor-pointer bg-transparent"
        onClick={() => {
          handleLinkClick();
          finalOnAccept();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleLinkClick();
            finalOnAccept();
          }
        }}
      />
    );
  }

  return (
    <DialogPrimitive.Root
      open={!isClosing}
      onOpenChange={(open) => {
        if (!open && hasClicked) {
          handleClose();
        }
      }}
    >
      <DialogPrimitive.Portal container={getOverlayPortalRoot()}>
        {/* Overlay avec fond bleu */}
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-300"
          style={{ background: "rgba(59,130,246,0.22)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget && hasClicked) {
              handleClose();
            }
          }}
        />

        {/* Contenu du dialog */}
        <DialogPrimitive.Content
          onPointerDownOutside={(e) => {
            if (!hasClicked) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!hasClicked) e.preventDefault();
          }}
          data-lenis-prevent
          className="fixed left-[50%] top-[50%] z-50 w-full max-w-[480px] translate-x-[-50%] translate-y-[-50%] rounded-2xl p-4 sm:p-6 max-h-[90vh] overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] duration-300"
          style={{
            background: "#181f2e",
            border: "1px solid rgba(255,255,255,0.08)",
            pointerEvents: "auto",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Bouton fermer (visible uniquement après le clic) */}
          {hasClicked && (
            <DialogPrimitive.Close
              onClick={handleClose}
              className="absolute right-4 top-4 rounded-full p-1.5 text-white/50 transition-all duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t("common.close")}</span>
            </DialogPrimitive.Close>
          )}

          {/* Header avec icône */}
          <div className="flex flex-col items-center justify-center pt-4 sm:pt-8 pb-2 px-4 sm:px-8">
            <ShieldAlert
              className="w-10 h-10 text-blue-400 mb-2"
              aria-hidden="true"
            />
            <DialogPrimitive.Title className="text-lg sm:text-xl font-bold leading-tight tracking-tight flex items-center gap-2 text-center mb-1 text-white">
              {headerText}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-xs sm:text-sm text-blue-100/80 font-medium text-center leading-relaxed">
              {descriptionText}
            </DialogPrimitive.Description>
          </div>

          {/* Avertissement contenu adulte (visible seulement si pubs +18 actives) */}
          {SHOW_ADULT_AD_WARNING && !hasClicked && adultAdsOn && (
            <div className="mx-4 sm:mx-6 mb-2">
              <div className="text-left bg-red-950/70 border-2 border-red-500 p-3 sm:p-4 rounded-lg shadow-lg">
                <p className="text-red-300 font-bold text-sm sm:text-base leading-snug">
                  {t("adBlocker.adultAdsWarning")}
                </p>
                <p className="text-red-200/90 text-xs sm:text-sm mt-1.5">
                  {t("adBlocker.adultAdsDisablePrefix")}
                  <Link
                    to="/settings#intermission"
                    className="text-red-300 hover:text-red-100 underline font-semibold"
                  >
                    {t("adBlocker.adultAdsSettingsLink")}
                  </Link>
                  {t("adBlocker.adultAdsDisableSuffix")}
                </p>
              </div>
            </div>
          )}

          {/* Avertissement compact : ne rien faire sur la page de pub */}
          {SHOW_AD_PAGE_WARNING && !hasClicked && (
            <div className="mx-4 sm:mx-6 mb-2">
              <p className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-yellow-200 text-xs sm:text-sm font-semibold text-center">
                ⚠️ {t("adBlocker.adPageWarning")}
              </p>
            </div>
          )}

          {/* Boutons */}
          <div className="flex flex-col items-center gap-2 px-4 sm:px-8 pb-4 sm:pb-8 pt-2">
            {hasClicked ? (
              <button
                onClick={handleClose}
                className="flex items-center justify-center font-bold whitespace-nowrap relative overflow-hidden transition-all duration-200 h-12 text-base px-6 rounded-lg bg-blue-600 text-white hover:bg-blue-700 hover:scale-105 active:scale-95 focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 shadow-lg w-full max-w-xs cursor-pointer"
                autoFocus
              >
                <Play className="w-5 h-5 mr-2" /> {primaryButtonLabel}
              </button>
            ) : (
              <>
                <button
                  data-ad-view-button
                  onClick={
                    scriptAdMode
                      ? scriptAdActive
                        ? beginScriptAdGesture
                        : completeScriptAdGesture
                      : handleLinkClick
                  }
                  className="flex items-center justify-center font-bold whitespace-nowrap relative overflow-hidden transition-all duration-200 h-12 text-base px-6 rounded-lg bg-blue-600 text-white hover:bg-blue-700 hover:scale-105 active:scale-95 focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 shadow-lg w-full max-w-xs mb-1 cursor-pointer"
                  autoFocus
                >
                  {primaryButtonLabel}
                </button>
                <span className="text-xs text-blue-200 text-center mt-1">
                  {t("adBlocker.closeAdTip")}
                </span>
              </>
            )}

            {/* Alternatives sans pub : VIP, et extension (PC/Mac) ou appli (mobile) */}
            {!hasClicked && (
              <div className="w-full max-w-xs mt-2 pt-3 border-t border-white/10">
                <p className="text-[11px] text-blue-200/70 text-center mb-2">
                  {t("adBlocker.noAdsQuestion")}
                </p>
                <div className={`grid gap-2 ${variant === "player" ? "grid-cols-2" : "grid-cols-1"}`}>
                  <Link
                    to="/vip"
                    className="flex flex-col items-center justify-center gap-0.5 rounded-lg py-2 px-2 bg-amber-500/15 border border-amber-400/40 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold">
                      <Crown className="w-4 h-4 flex-shrink-0" />
                      {t("adBlocker.vipButton")}
                    </span>
                    <span className="text-[10px] text-amber-200/70 leading-tight text-center">
                      {t("adBlocker.vipButtonHint")}
                    </span>
                  </Link>
                  {variant === "player" && (
                    <Link
                      to={isMobile ? "/app" : "/extension"}
                      className="flex flex-col items-center justify-center gap-0.5 rounded-lg py-2 px-2 bg-indigo-500/15 border border-indigo-400/40 text-indigo-300 hover:bg-indigo-500/25 hover:text-indigo-200 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold">
                        {isMobile ? (
                          <Smartphone className="w-4 h-4 flex-shrink-0" />
                        ) : (
                          <Puzzle className="w-4 h-4 flex-shrink-0" />
                        )}
                        {isMobile ? t("adBlocker.appButton") : t("adBlocker.extensionButton")}
                      </span>
                      <span className="text-[10px] text-indigo-200/70 leading-tight text-center">
                        {t("adBlocker.sourcesButtonHint")}
                      </span>
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

export default AdFreePlayerAds;
