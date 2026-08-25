import { useSyncExternalStore } from 'react';

import {
  getServerTurnstileBypassStatus,
  getTurnstileBypassStatus,
  subscribeTurnstileBypass,
  type TurnstileBypassStatus,
} from '../utils/turnstileBypass';

/**
 * Le statut de dispense Turnstile de l'utilisateur courant, et son suivi.
 *
 * Rend `'unknown'` le temps que le serveur réponde : les appelants doivent
 * alors n'afficher aucun widget, sinon un admin verrait le challenge
 * apparaître puis disparaître. Voir `utils/turnstileBypass.ts`.
 */
export const useTurnstileBypass = (): TurnstileBypassStatus =>
  useSyncExternalStore(
    subscribeTurnstileBypass,
    getTurnstileBypassStatus,
    getServerTurnstileBypassStatus,
  );
