import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  broadcastAuthChange,
  clearPendingAuthAction,
  getPendingAuthAction,
  persistResolvedSession,
} from '../utils/accountAuth';
import { getSessionCreationHeaders } from '../utils/sessionClientId';

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
type GoogleAuthWindow = Window & { __google_verify_done?: boolean };

const GoogleAuth: React.FC = () => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string>(t('auth.fetchingGoogleProfile'));

  useEffect(() => {
    const handleAuth = async () => {
      const authWindow = window as GoogleAuthWindow;
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = fragment.get('access_token');

      if (authWindow.__google_verify_done) return;
      authWindow.__google_verify_done = true;

      try {
        history.replaceState(null, '', window.location.pathname);
      } catch (replaceStateError) {
        console.debug('Unable to clean Google callback URL:', replaceStateError);
      }

      if (!accessToken) {
        setError(t('auth.google.authFailed'));
        return;
      }

      const pendingAction = getPendingAuthAction();
      const isLinkAction = pendingAction?.type === 'link' && pendingAction.provider === 'google';
      const authorizeReturnTo = pendingAction?.type === 'oauth-authorize'
        ? pendingAction.returnTo || '/'
        : null;

      try {
        if (isLinkAction) {
          const authToken = localStorage.getItem('auth_token');
          if (!authToken) {
            throw new Error('Session actuelle manquante');
          }

          setStep('Vérification du compte Google');
          const response = await fetch(`${import.meta.env.VITE_MAIN_API}/api/auth/links/google`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({ access_token: accessToken }),
          });

          const payload = await response.json();
          if (!response.ok || !payload.success) {
            throw new Error(payload.error || 'Impossible de lier Google à ce compte');
          }

          clearPendingAuthAction();
          setStep('Compte Google lié, redirection…');
          await sleep(900);
          window.location.href = pendingAction.returnTo || '/settings#accounts';
          return;
        }

        setStep(t('auth.fetchingGoogleProfile'));
        const verifyResponse = await fetch(`${import.meta.env.VITE_MAIN_API}/api/auth/google/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getSessionCreationHeaders(),
          },
          body: JSON.stringify({ access_token: accessToken }),
        });

        const payload = await verifyResponse.json();
        if (!verifyResponse.ok || !payload.success) {
          throw new Error(payload.error || t('auth.google.authFailed'));
        }

        setStep('Sauvegarde locale');
        persistResolvedSession('google', payload, { accessToken });
        if (!authorizeReturnTo) {
          clearPendingAuthAction();
        }
        broadcastAuthChange();

        setStep(t('auth.discord.finalizing'));
        await sleep(1000);
        window.location.href = authorizeReturnTo || '/';
      } catch (err: unknown) {
        setError(t('auth.google.authError'));
        console.error(err);
      }
    };

    handleAuth();
  }, [t]);

  if (error) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6">
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-3 rounded-xl">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-950 to-gray-900 flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="bg-gray-900/70 border border-gray-800 rounded-2xl p-8 max-w-md w-full text-center backdrop-blur-md shadow-2xl"
      >
        <div className="mb-6 flex flex-col items-center">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/20 flex items-center justify-center mb-3">
            <img
              src="https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png"
              alt="Google"
              className="h-8 w-8"
            />
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
            {t('auth.loginWithGoogle')}
          </h2>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-center">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-2 border-white/20"></div>
              <div className="absolute inset-0 rounded-full border-t-2 border-white animate-spin"></div>
            </div>
          </div>
          <div className="text-center text-gray-300 text-sm">
            {step}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default GoogleAuth;
