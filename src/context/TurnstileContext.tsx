import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ADMIN_BYPASS_TOKEN, resolveTurnstileBypass } from '../utils/turnstileBypass';

const TURNSTILE_INVISIBLE_SITEKEY = import.meta.env.VITE_TURNSTILE_INVISIBLE_SITEKEY;
const TOKEN_REFRESH_MS = 250_000;
const TURNSTILE_WAIT_TIMEOUT_MS = 10_000;
const TURNSTILE_POLL_INTERVAL_MS = 200;

interface TurnstileContextValue {
  token: string;
  isVerifying: boolean;
  resetToken: () => void;
  getValidToken: () => Promise<string>;
}

const TurnstileContext = createContext<TurnstileContextValue>({
  token: '',
  isVerifying: false,
  resetToken: () => {},
  getValidToken: () => Promise.resolve(''),
});

export const useTurnstile = () => useContext(TurnstileContext);

export const TurnstileProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const widgetId = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tokenTimestamp = useRef(0);
  const tokenResolvers = useRef<Array<(nextToken: string) => void>>([]);

  const resolvePendingTokens = useCallback((nextToken: string) => {
    tokenResolvers.current.forEach(resolve => resolve(nextToken));
    tokenResolvers.current = [];
  }, []);

  const cleanupWidget = useCallback(() => {
    if (widgetId.current !== null && window.turnstile) {
      try {
        window.turnstile.remove(widgetId.current);
      } catch {
        /* ignore */
      }
    }

    widgetId.current = null;
    tokenTimestamp.current = 0;

    if (containerRef.current) {
      containerRef.current.remove();
      containerRef.current = null;
    }
  }, []);

  const waitForTurnstile = useCallback((): Promise<boolean> => {
    if (!TURNSTILE_INVISIBLE_SITEKEY) {
      return Promise.resolve(false);
    }

    if (window.turnstile) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const interval = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(interval);
          window.clearTimeout(timeout);
          resolve(true);
        }
      }, TURNSTILE_POLL_INTERVAL_MS);

      const timeout = window.setTimeout(() => {
        window.clearInterval(interval);
        resolve(false);
      }, TURNSTILE_WAIT_TIMEOUT_MS);
    });
  }, []);

  const ensureWidget = useCallback(async (): Promise<'created' | 'existing' | null> => {
    if (!TURNSTILE_INVISIBLE_SITEKEY) {
      return null;
    }

    const isReady = await waitForTurnstile();
    if (!isReady || !window.turnstile) {
      return null;
    }

    if (widgetId.current !== null) {
      return 'existing';
    }

    if (!containerRef.current) {
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.top = '-9999px';
      container.style.left = '-9999px';
      document.body.appendChild(container);
      containerRef.current = container;
    }

    widgetId.current = window.turnstile.render(containerRef.current, {
      sitekey: TURNSTILE_INVISIBLE_SITEKEY,
      size: 'invisible',
      callback: (nextToken: string) => {
        setToken(nextToken);
        setIsVerifying(false);
        tokenTimestamp.current = Date.now();
        resolvePendingTokens(nextToken);
      },
      'expired-callback': () => {
        setToken('');
        tokenTimestamp.current = 0;
        setIsVerifying(false);
      },
      'error-callback': () => {
        setToken('');
        setIsVerifying(false);
        cleanupWidget();
        resolvePendingTokens('');
      },
    });

    return widgetId.current !== null ? 'created' : null;
  }, [cleanupWidget, resolvePendingTokens, waitForTurnstile]);

  useEffect(() => {
    return () => {
      cleanupWidget();
      resolvePendingTokens('');
    };
  }, [cleanupWidget, resolvePendingTokens]);

  const resetToken = useCallback(() => {
    setToken('');
    setIsVerifying(false);
    cleanupWidget();
  }, [cleanupWidget]);

  const getValidToken = useCallback(async (): Promise<string> => {
    // Dispense admin : aucun challenge, et le widget invisible n'est même pas
    // construit. Le serveur tranche de son côté sur le JWT qu'il vérifie ; ce
    // jeton n'est qu'un marqueur d'interface (`utils/turnstileBypass.ts`).
    if (await resolveTurnstileBypass() === 'bypass') {
      return ADMIN_BYPASS_TOKEN;
    }

    if (!TURNSTILE_INVISIBLE_SITEKEY) {
      return '';
    }

    if (token && tokenTimestamp.current && Date.now() - tokenTimestamp.current < TOKEN_REFRESH_MS) {
      return token;
    }

    return new Promise<string>((resolve) => {
      tokenResolvers.current.push(resolve);
      const isPrimaryRequest = tokenResolvers.current.length === 1;

      window.setTimeout(() => {
        const resolverIndex = tokenResolvers.current.indexOf(resolve);
        if (resolverIndex === -1) {
          return;
        }

        tokenResolvers.current.splice(resolverIndex, 1);
        if (tokenResolvers.current.length === 0) {
          setIsVerifying(false);
        }
        resolve('');
      }, TURNSTILE_WAIT_TIMEOUT_MS);

      if (!isPrimaryRequest) {
        return;
      }

      setToken('');
      setIsVerifying(true);
      tokenTimestamp.current = 0;

      void (async () => {
        const widgetState = await ensureWidget();
        if (!widgetState || !window.turnstile || widgetId.current === null) {
          setIsVerifying(false);
          cleanupWidget();
          resolvePendingTokens('');
          return;
        }

        if (widgetState === 'existing') {
          try {
            window.turnstile.reset(widgetId.current);
          } catch {
            setIsVerifying(false);
            cleanupWidget();
            resolvePendingTokens('');
          }
        }
      })();
    });
  }, [cleanupWidget, ensureWidget, resolvePendingTokens, token]);

  const value = useMemo(
    () => ({ token, isVerifying, resetToken, getValidToken }),
    [token, isVerifying, resetToken, getValidToken]
  );

  return (
    <TurnstileContext.Provider value={value}>
      {children}
    </TurnstileContext.Provider>
  );
};
