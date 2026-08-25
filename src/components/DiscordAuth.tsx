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
type DiscordAuthWindow = Window & { __discord_verify_done?: boolean };

const DiscordAuth: React.FC = () => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string>(t('auth.discord.initializing'));

  useEffect(() => {
    const authWindow = window as DiscordAuthWindow;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = fragment.get('access_token');

    if (authWindow.__discord_verify_done) return;

    if (!accessToken) {
      setError(t('auth.discord.tokenMissing'));
      return;
    }

    authWindow.__discord_verify_done = true;
    try {
      history.replaceState(null, '', window.location.pathname);
    } catch (replaceStateError) {
      console.debug('Unable to clean Discord callback URL:', replaceStateError);
    }

    const pendingAction = getPendingAuthAction();
    const isLinkAction = pendingAction?.type === 'link' && pendingAction.provider === 'discord';
    const authorizeReturnTo = pendingAction?.type === 'oauth-authorize'
      ? pendingAction.returnTo || '/'
      : null;

    const handleAuth = async () => {
      try {
        if (isLinkAction) {
          const authToken = localStorage.getItem('auth_token');
          if (!authToken) {
            throw new Error('Session actuelle manquante');
          }

          setStep('Vérification du compte Discord');
          const linkResponse = await fetch(`${import.meta.env.VITE_MAIN_API}/api/auth/links/discord`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({ access_token: accessToken }),
          });

          const linkPayload = await linkResponse.json();
          if (!linkResponse.ok || !linkPayload.success) {
            throw new Error(linkPayload.error || 'Impossible de lier Discord à ce compte');
          }

          clearPendingAuthAction();
          setStep('Compte Discord lié, redirection…');
          await sleep(900);
          window.location.href = pendingAction.returnTo || '/settings#accounts';
          return;
        }

        setStep(t('auth.discord.verifying'));
        const verifyResponse = await fetch(`${import.meta.env.VITE_MAIN_API}/api/auth/discord/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getSessionCreationHeaders(),
          },
          body: JSON.stringify({ access_token: accessToken }),
        });

        const payload = await verifyResponse.json();
        if (!verifyResponse.ok || !payload.success) {
          throw new Error(payload.error || t('auth.discord.verificationFailed'));
        }

        setStep(t('auth.discord.savingLocal'));
        persistResolvedSession('discord', payload, { accessToken });
        if (!authorizeReturnTo) {
          clearPendingAuthAction();
        }
        broadcastAuthChange();

        setStep(t('auth.discord.finalizing'));
        await sleep(1000);
        window.location.href = authorizeReturnTo || '/';
      } catch (err: unknown) {
        console.error('Detailed error:', err);
        setError(t('auth.discord.authError'));
      }
    };

    handleAuth();
  }, [t]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-950 to-gray-900 flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="bg-gray-900/70 border border-gray-800 rounded-2xl p-8 max-w-md w-full text-center backdrop-blur-md shadow-2xl"
      >
        <div className="mb-6 flex flex-col items-center">
          <div className="w-16 h-16 rounded-2xl bg-[#5865F2]/10 border border-[#5865F2]/30 flex items-center justify-center mb-3">
            <img
              src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png"
              alt="Discord"
              className="h-10 w-10"
            />
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
            {t('auth.loginWithDiscord')}
          </h2>
        </div>

        {error ? (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-3 rounded-xl">
            {error}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-center">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 rounded-full border-2 border-[#5865F2]/30"></div>
                <div className="absolute inset-0 rounded-full border-t-2 border-[#5865F2] animate-spin"></div>
              </div>
            </div>
            <div className="text-center text-gray-300 text-sm">
              {step}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default DiscordAuth;
