import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { checkVipStatus, isUserVip } from '../utils/vipUtils';
import { getAdPopupMode, subscribeToAdPopupModeChanges } from '../utils/adPopupMode';
import { SCRIPT_AD_MODE_ENABLED, loadAdScript } from '../utils/adScriptMode';


interface AdFreePopupContextType {
  showAdFreePopup: boolean;
  adType: 'ad1' | 'ad2';
  playerToShow: string | null;
  shouldLoadIframe: boolean;
  isSpecialPlayer: boolean;
  isVoVostfrOnly: boolean;
  is_vip: boolean;
  showPopupForPlayer: (playerType: string, additionalInfo?: any) => void;
  handlePopupClose: () => void;
  handlePopupAccept: () => void;
  resetVipStatus: () => void;
}

const AdFreePopupContext = createContext<AdFreePopupContextType | undefined>(undefined);

export const AdFreePopupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [showAdFreePopup, setShowAdFreePopup] = useState(false);
  const [adType, setAdType] = useState<'ad1' | 'ad2'>('ad2');
  const [playerToShow, setPlayerToShow] = useState<string | null>(null);
  const [shouldLoadIframe, setShouldLoadIframe] = useState(true);
  const [isSpecialPlayer, setIsSpecialPlayer] = useState(false);
  const [isVoVostfrOnly, setIsVoVostfrOnly] = useState(false);
  const [is_vip, setIsVip] = useState(() => {
    // Check VIP status via server-verified utility
    return isUserVip();
  });

  // Effect to listen for changes to VIP status (localStorage + custom events)
  useEffect(() => {
    let mounted = true;

    const syncVipStatus = () => {
      if (mounted) setIsVip(isUserVip());
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'is_vip') {
        setIsVip(e.newValue === 'true');
      }
    };

    const handleVipStatusChanged = () => {
      setIsVip(isUserVip());
    };

    // La vÃ©rification lancÃ©e au dÃ©marrage peut finir avant le montage de ce
    // provider. On relit donc l'Ã©tat, puis on rejoint sa requÃªte en cours afin
    // de ne jamais rester bloquÃ© avec la valeur initiale aprÃ¨s une connexion.
    syncVipStatus();
    if (localStorage.getItem('access_code')) {
      void checkVipStatus().then((vip) => {
        if (mounted) setIsVip(vip);
      });
    }

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('vipStatusChanged', handleVipStatusChanged);
    return () => {
      mounted = false;
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('vipStatusChanged', handleVipStatusChanged);
    };
  }, []);

  // Précharge le script popunder quand le popup est en mode normal/bouton.
  // Auto et click-anywhere continuent d'utiliser le lien direct.
  useEffect(() => {
    const sync = () => {
      if (getAdPopupMode() === 'normal' && SCRIPT_AD_MODE_ENABLED) loadAdScript();
    };
    sync();
    return subscribeToAdPopupModeChanges(sync);
  }, []);

  const showPopupForPlayer = useCallback((playerType: string, additionalInfo?: any) => {
    // First check VIP status via server-verified utility
    const isVipUser = isUserVip() || is_vip;

    if (isVipUser) {
      setIsVip(true); // Ensure state is in sync with localStorage
      setShouldLoadIframe(true);
      return;
    }
    const adTypeRandom = Math.random() < 0.3 ? 'ad1' : 'ad2';
    setAdType(adTypeRandom);

    // Check if this is a VO/VOSTFR only player
    const isVoVostfrOnlyPlayer = additionalInfo?.isVoVostfrOnly || false;
    setIsVoVostfrOnly(isVoVostfrOnlyPlayer);

    // ALWAYS show popup for ALL player types (unless user is VIP)
    // This ensures the popup appears for every player source
    const isSpecial = true; // Consider all players as "special" to ensure popup shows

    // Log specific player types for debugging
    if (playerType === 'darkino') {
      console.log(`[AdFreePopupContext] Darkino player detected`);
    } else if (playerType === 'adfree') {
      console.log(`[AdFreePopupContext] AdFree player detected`);
    } else if (playerType === 'mp4') {
      console.log(`[AdFreePopupContext] MP4 player detected`);
    } else if (playerType === 'multi') {
      console.log(`[AdFreePopupContext] Multi/Coflix player detected`);
    } else if (playerType === 'omega') {
      console.log(`[AdFreePopupContext] Omega player detected`);
    } else if (playerType === 'vidmoly') {
      console.log(`[AdFreePopupContext] Vidmoly player detected`);
    } else if (playerType === 'dropload') {
      console.log(`[AdFreePopupContext] Dropload player detected`);
    } else if (playerType === 'fstream') {
      console.log(`[AdFreePopupContext] FStream player detected`);
    } else if (playerType === 'wiflix') {
      console.log(`[AdFreePopupContext] Wiflix/Lynx player detected`);
    } else if (playerType === 'j1f') {
      console.log(`[AdFreePopupContext] 1jour1film player detected`);
    } else if (playerType === 'frembed') {
      console.log(`[AdFreePopupContext] Frembed player detected`);
    } else if (playerType === 'coflix') {
      console.log(`[AdFreePopupContext] Coflix player detected`);
    } else if (playerType === 'nexus_hls' || playerType === 'nexus_file') {
      console.log(`[AdFreePopupContext] Nexus player detected`);
    } else {
      console.log(`[AdFreePopupContext] Generic player detected: ${playerType}`);
    }

    setIsSpecialPlayer(isSpecial);

    // Always show popup for any player type
    setPlayerToShow(playerType);
    setShowAdFreePopup(true);
    // Click-anywhere preloads the player (iframe/HLS) behind the transparent
    // catcher so the user sees the video instead of a black screen. The catcher
    // (z-100000) intercepts the first click to open the ad, then unmounts. Other
    // modes keep the player gated until the user accepts via the popup.
    setShouldLoadIframe(getAdPopupMode() === 'click-anywhere');
    console.log(`[AdFreePopupContext] Popup shown for ${playerType}`);
  }, [is_vip]);

  const handlePopupClose = useCallback(() => {
    setShowAdFreePopup(false);
    setPlayerToShow(null);
  }, []);

  const handlePopupAccept = useCallback(() => {
    setShowAdFreePopup(false);
    setIsVip(true);
    setShouldLoadIframe(true);
    // Don't set localStorage here - this is temporary for the session only
    try {
      const evt = new CustomEvent('ad_popup_accepted', { detail: { timestamp: Date.now() } });
      window.dispatchEvent(evt);
    } catch { }
  }, []);

  const resetVipStatus = useCallback(() => {
    // Don't reset if localStorage has permanent VIP status
    if (localStorage.getItem('is_vip') !== 'true') {
      setIsVip(false);
      console.log('[AdFreePopupContext] VIP status reset.');
    }
  }, []);

  // Memoize the context value so the 7 consumers (Movie/TVDetails, Watch
  // pages, MovieVideoPlayer, AdFreePlayerAds) don't re-render on every parent
  // render. AdFreePopupProvider sits near the root of the App provider stack,
  // so anything its parents re-render for (route changes, auth ticks) used to
  // cascade into the heavy detail pages via this provider. — perf
  const value = useMemo<AdFreePopupContextType>(() => ({
    showAdFreePopup,
    adType,
    playerToShow,
    shouldLoadIframe,
    isSpecialPlayer,
    isVoVostfrOnly,
    is_vip,
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept,
    resetVipStatus
  }), [
    showAdFreePopup,
    adType,
    playerToShow,
    shouldLoadIframe,
    isSpecialPlayer,
    isVoVostfrOnly,
    is_vip,
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept,
    resetVipStatus
  ]);

  return (
    <AdFreePopupContext.Provider value={value}>
      {children}
    </AdFreePopupContext.Provider>
  );
};

export const useAdFreePopup = () => {
  const context = useContext(AdFreePopupContext);
  if (context === undefined) {
    throw new Error('useAdFreePopup must be used within an AdFreePopupProvider');
  }
  return context;
};
