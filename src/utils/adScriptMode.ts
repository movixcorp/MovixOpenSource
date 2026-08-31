// Ad-network <script> mode for the "Voir une pub" button popup (normal mode).
//
// When enabled, the normal-mode popup loads this ad-network script instead of
// opening the direct link (utils/adAdultMode). The script is pre-configured on
// the ad-network side to deliver the ad on the button click, so the button only
// advances the popup flow — it does not open the direct link. The other popup
// modes (auto / click-anywhere) keep using the direct link.
//
// Le chargement du script est suivi (loading/ready/failed) pour détecter les
// bloqueurs de pub : un bloqueur annule la requête réseau → onerror → 'failed'.
// Le popup lit cet état pour rebasculer le bouton sur le lien direct quand le
// script est bloqué, au lieu de valider sans qu'aucune pub ne soit partie.
//
// This is a build-time switch (code constant), not a user setting. Flip
// SCRIPT_AD_MODE_WANTED to false to revert the button to direct-link behaviour.

const SCRIPT_AD_MODE_WANTED = true;

// Ad-network script src, protocol-relative as delivered by the network. Lu
// depuis le .env (VITE_AD_SCRIPT_SRC) : le dépôt est synchronisé vers le
// miroir public, l'URL de régie n'a rien à faire dans le code. Vide = mode
// script coupé, le bouton retombe sur le lien direct.
export const AD_SCRIPT_SRC = (
  typeof import.meta.env.VITE_AD_SCRIPT_SRC === 'string'
    ? import.meta.env.VITE_AD_SCRIPT_SRC
    : ''
).trim();

export const SCRIPT_AD_MODE_ENABLED = SCRIPT_AD_MODE_WANTED && AD_SCRIPT_SRC.length > 0;

// Marker attribute used to keep injection idempotent.
const AD_SCRIPT_MARKER = 'data-movix-ad-script';

export type AdScriptState = 'idle' | 'loading' | 'ready' | 'failed';

let adScriptState: AdScriptState = 'idle';
const stateListeners = new Set<(state: AdScriptState) => void>();

const setAdScriptState = (state: AdScriptState): void => {
  if (adScriptState === state) return;
  adScriptState = state;
  stateListeners.forEach((cb) => cb(state));
};

export const getAdScriptState = (): AdScriptState => adScriptState;

export const subscribeToAdScriptState = (
  cb: (state: AdScriptState) => void,
): (() => void) => {
  stateListeners.add(cb);
  return () => {
    stateListeners.delete(cb);
  };
};

export const isScriptAdModeEnabled = (): boolean => SCRIPT_AD_MODE_ENABLED;

// Inject the ad-network script once, in <head> as required by the network.
// Idempotent: re-calls are no-ops while the tag is present in the document.
// data-cfasync="false" keeps Cloudflare Rocket Loader from deferring it; async
// lets it load without blocking the popup.
export const loadAdScript = (): void => {
  if (!SCRIPT_AD_MODE_ENABLED) return;
  try {
    if (document.querySelector(`script[${AD_SCRIPT_MARKER}]`)) {
      // Tag déjà posé hors suivi (HMR, ancien build) : on le suppose chargé.
      if (adScriptState === 'idle') setAdScriptState('ready');
      return;
    }
    const s = document.createElement('script');
    s.src = AD_SCRIPT_SRC;
    s.async = true;
    s.type = 'text/javascript';
    s.setAttribute('data-cfasync', 'false');
    s.setAttribute(AD_SCRIPT_MARKER, '');
    // Un bloqueur (uBlock, Brave Shields, DNS filtrant) annule la requête et
    // déclenche onerror : c'est le signal « script bloqué » lu par le popup.
    s.onload = () => setAdScriptState('ready');
    s.onerror = () => setAdScriptState('failed');
    setAdScriptState('loading');
    (document.head || document.body).appendChild(s);
  } catch {
    /* document unavailable (SSR / privacy) */
  }
};
