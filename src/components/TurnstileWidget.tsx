import React, { useEffect, useRef } from 'react';

import { useTurnstileBypass } from '../hooks/useTurnstileBypass';
import { ADMIN_BYPASS_TOKEN } from '../utils/turnstileBypass';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  onTokenChange?: (token: string) => void;
  onVerify?: (token: string) => void;
  siteKey?: string;
  resetSignal?: number;
  className?: string;
  theme?: 'light' | 'dark' | 'auto';
  action?: string;
}

const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  onTokenChange,
  onVerify,
  siteKey,
  resetSignal = 0,
  className,
  theme = 'dark',
  action
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const resolvedSiteKey = siteKey || TURNSTILE_SITE_KEY;
  const handleTokenChange = onTokenChange || onVerify || null;
  const bypassStatus = useTurnstileBypass();

  useEffect(() => {
    // Dispense admin : aucun widget, et le marqueur qui débloque les boutons
    // conditionnés à un jeton non vide. Voir `utils/turnstileBypass.ts`.
    if (bypassStatus === 'bypass') {
      handleTokenChange?.(ADMIN_BYPASS_TOKEN);
      return undefined;
    }

    // Statut encore inconnu : on attend la réponse du serveur plutôt que
    // d'afficher un challenge qu'il faudrait retirer juste après.
    if (bypassStatus === 'unknown') {
      return undefined;
    }

    if (!resolvedSiteKey) {
      handleTokenChange?.('');
      return undefined;
    }

    let isMounted = true;

    const renderWidget = () => {
      if (!isMounted || !window.turnstile || !containerRef.current || widgetIdRef.current) {
        return;
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: resolvedSiteKey,
        theme,
        ...(action ? { action } : {}),
        callback: (token: string) => handleTokenChange?.(token),
        'expired-callback': () => handleTokenChange?.(''),
        'error-callback': () => handleTokenChange?.('')
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      const interval = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(interval);
          renderWidget();
        }
      }, 200);

      const timeout = window.setTimeout(() => {
        window.clearInterval(interval);
      }, 10000);

      return () => {
        isMounted = false;
        window.clearInterval(interval);
        window.clearTimeout(timeout);
        handleTokenChange?.('');
        if (widgetIdRef.current && window.turnstile) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // Ignore cleanup errors from Cloudflare widget
          }
        }
        widgetIdRef.current = null;
      };
    }

    return () => {
      isMounted = false;
      handleTokenChange?.('');
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors from Cloudflare widget
        }
      }
      widgetIdRef.current = null;
    };
  }, [action, bypassStatus, handleTokenChange, resolvedSiteKey, theme]);

  useEffect(() => {
    // Un dispensé n'a rien à réinitialiser : effacer le marqueur ici
    // rebloquerait le bouton après le premier envoi.
    if (bypassStatus !== 'challenge') return;

    handleTokenChange?.('');
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [bypassStatus, handleTokenChange, resetSignal]);

  if (bypassStatus !== 'challenge' || !resolvedSiteKey) {
    return null;
  }

  return <div ref={containerRef} className={className} />;
};

export default TurnstileWidget;
