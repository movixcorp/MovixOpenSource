/**
 * Dispense de Turnstile pour l'équipe : un admin ne voit plus le challenge.
 *
 * ## Où la décision se prend vraiment
 *
 * **Pas ici.** Le serveur tranche seul, dans `verifyTurnstileFromRequest`
 * (`API/Mainapi/utils/turnstile.js`), à partir du JWT qu'il vérifie lui-même
 * et de la table `admins`. Ce module ne fait qu'éviter d'afficher un challenge
 * à quelqu'un dont on sait qu'il en est dispensé — c'est du confort
 * d'affichage, pas un contrôle d'accès.
 *
 * La conséquence est volontaire : quiconque bricole son navigateur pour se
 * déclarer admin n'obtient rien. Il se prive juste du widget, le serveur ne le
 * dispense pas, et sa requête est refusée faute de jeton valide. Le pire cas
 * se retourne contre le tricheur, jamais contre le site.
 *
 * ## Le jeton marqueur
 *
 * Les appelants existants conditionnent tous leur bouton à un jeton non vide
 * (`disabled={!turnstileToken}`). Plutôt que de reprendre cette garde dans une
 * douzaine de fichiers, un dispensé reçoit `ADMIN_BYPASS_TOKEN` à la place du
 * jeton Cloudflare. Ce n'est pas un secret et ça n'ouvre rien : le serveur
 * accorde la dispense avant même de regarder le jeton, et pour tout autre
 * visiteur cette chaîne part chez Cloudflare, qui la rejette.
 *
 * ## Ce que la dispense ne couvre pas
 *
 * La connexion et la création de compte. Le serveur ne peut pas savoir qui
 * frappe à la porte avant de l'avoir ouverte, et retirer le challenge de ces
 * routes affaiblirait précisément les comptes à plus forte valeur.
 */

/** Marqueur d'interface, sans valeur côté serveur. Voir l'en-tête. */
export const ADMIN_BYPASS_TOKEN = 'movix-admin-turnstile-bypass';

/** `unknown` tant que le serveur n'a pas répondu : on n'affiche rien encore. */
export type TurnstileBypassStatus = 'unknown' | 'bypass' | 'challenge';

const MAIN_API = import.meta.env.VITE_MAIN_API;
const RESOLVE_TIMEOUT_MS = 5_000;

let status: TurnstileBypassStatus = 'unknown';
/** Jeton d'auth pour lequel `status` a été établi — une connexion le périme. */
let resolvedFor: string | null = null;
let inFlight: Promise<TurnstileBypassStatus> | null = null;
const listeners = new Set<() => void>();

const readAuthToken = (): string => {
  try {
    return localStorage.getItem('auth_token') || '';
  } catch {
    return '';
  }
};

const setStatus = (next: TurnstileBypassStatus, authToken: string): void => {
  resolvedFor = authToken;
  if (status === next) return;
  status = next;
  listeners.forEach(listener => listener());
};

/**
 * Établit le statut si besoin, et le rend. Un échec — réseau, 403, délai
 * dépassé — retombe sur le challenge : dans le doute, on montre le widget.
 */
export const resolveTurnstileBypass = async (): Promise<TurnstileBypassStatus> => {
  const authToken = readAuthToken();

  if (resolvedFor === authToken && status !== 'unknown') return status;
  if (inFlight) return inFlight;

  if (!authToken || !MAIN_API) {
    setStatus('challenge', authToken);
    return status;
  }

  inFlight = (async (): Promise<TurnstileBypassStatus> => {
    let next: TurnstileBypassStatus = 'challenge';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

    try {
      const response = await fetch(`${MAIN_API}/api/admin/check`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      });

      if (response.ok) {
        const data = await response.json();
        // `/admin/check` laisse aussi passer les uploaders : on exige le rôle,
        // pour aligner la dispense sur le middleware `isAdmin` du serveur.
        if (data?.success && String(data?.admin?.role || '').toLowerCase() === 'admin') {
          next = 'bypass';
        }
      }
    } catch {
      /* 403 pour un non-admin, réseau coupé, délai dépassé : challenge */
    } finally {
      window.clearTimeout(timeout);
      inFlight = null;
    }

    setStatus(next, authToken);
    return next;
  })();

  return inFlight;
};

/** Lecture pure, pour `useSyncExternalStore`. */
export const getTurnstileBypassStatus = (): TurnstileBypassStatus => status;

/** Rendu serveur : personne n'est connecté, donc challenge. */
export const getServerTurnstileBypassStatus = (): TurnstileBypassStatus => 'challenge';

/** S'abonne, et déclenche la résolution au premier abonné. */
export const subscribeTurnstileBypass = (listener: () => void): (() => void) => {
  void resolveTurnstileBypass();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
