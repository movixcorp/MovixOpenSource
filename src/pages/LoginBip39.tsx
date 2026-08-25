import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Eye, EyeOff, Shield, LogIn, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  broadcastAuthChange,
  clearPendingAuthAction,
  getPendingAuthAction,
  persistResolvedSession,
} from '../utils/accountAuth';
import { getSessionCreationHeaders } from '../utils/sessionClientId';
import { useTurnstileBypass } from '../hooks/useTurnstileBypass';
const API_URL = import.meta.env.VITE_MAIN_API;
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

interface LoginBip39Props {
  mode?: 'login' | 'link';
}

const LoginBip39: React.FC<LoginBip39Props> = ({ mode = 'login' }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [mnemonic, setMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Dispense admin. Elle ne joue que pour une session déjà ouverte — se
  // connecter ou créer un compte se fait avant que le serveur ne sache qui
  // frappe, donc le challenge reste entier dans le cas courant. Voir
  // `utils/turnstileBypass.ts`.
  const turnstileBypass = useTurnstileBypass();
  const isTurnstileEnabled = typeof TURNSTILE_SITE_KEY === 'string'
    && TURNSTILE_SITE_KEY.trim().length > 0
    && turnstileBypass !== 'bypass';
  const isLinkMode = mode === 'link';
  const pendingAction = getPendingAuthAction();
  const hasValidLinkAction = pendingAction?.type === 'link' && pendingAction.provider === 'bip39';
  const returnPath = hasValidLinkAction ? (pendingAction.returnTo || '/settings#accounts') : '/settings#accounts';
  const authorizeReturnPath = !isLinkMode && pendingAction?.type === 'oauth-authorize'
    ? pendingAction.returnTo || '/'
    : null;
  const hasLinkSession = Boolean(localStorage.getItem('auth_token'));

  const renderTurnstile = useCallback(() => {
    if (!isTurnstileEnabled) return;
    if (window.turnstile && turnstileRef.current && !widgetIdRef.current) {
      widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    }
  }, [isTurnstileEnabled]);

  useEffect(() => {
    if (!isTurnstileEnabled) return;

    if (window.turnstile) {
      renderTurnstile();
    } else {
      const interval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(interval);
          renderTurnstile();
        }
      }, 200);
      return () => clearInterval(interval);
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [isTurnstileEnabled, renderTurnstile]);

  useEffect(() => {
    if (!isLinkMode) return;
    if (hasLinkSession) return;
    setError(t('auth.bip39.linkSessionMissing', 'Session de liaison introuvable. Retournez dans Paramètres et recommencez.'));
  }, [hasLinkSession, isLinkMode, t]);

  const handleBack = () => {
    if (isLinkMode) {
      clearPendingAuthAction();
    }
    navigate(isLinkMode ? returnPath : (authorizeReturnPath || '/'));
  };

  const handleLogin = async () => {
    if (!mnemonic.trim()) {
      setError(t('auth.bip39.enterPhrasePlease'));
      return;
    }

    if (isTurnstileEnabled && !turnstileToken) {
      setError(t('auth.captchaRequired', 'Veuillez compléter la vérification de sécurité'));
      return;
    }

    if (isLinkMode && !hasLinkSession) {
      setError(t('auth.bip39.linkSessionMissing', 'Session de liaison introuvable. Retournez dans Paramètres et recommencez.'));
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      if (isLinkMode) {
        const authToken = localStorage.getItem('auth_token');
        if (!authToken) {
          clearPendingAuthAction();
          throw new Error(t('auth.bip39.linkSessionMissing', 'Session de liaison introuvable. Retournez dans Paramètres et recommencez.'));
        }

        const linkResponse = await fetch(`${API_URL}/api/auth/links/bip39`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ mnemonic: mnemonic.trim() }),
        });

        const linkData = await linkResponse.json();
        if (!linkResponse.ok || !linkData.success) {
          throw new Error(linkData.error || t('auth.bip39.linkFailed', 'Impossible de lier ce compte BIP39.'));
        }

        clearPendingAuthAction();
        navigate(returnPath);
        return;
      }

      const loginResponse = await fetch(`${API_URL}/api/auth/bip39/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getSessionCreationHeaders(),
        },
        body: JSON.stringify({ mnemonic: mnemonic.trim(), turnstileToken }),
      });

      const loginData = await loginResponse.json();

      if (loginData.success) {
        const userId = loginData.account?.userId || loginData.userId;
        const token = loginData.token;

        if (!token || !userId) {
            throw new Error('Réponse de connexion incomplète');
        }

        persistResolvedSession('bip39', loginData);
        broadcastAuthChange();
        setTimeout(() => {
          window.location.href = authorizeReturnPath || '/';
        }, 100);
      } else {
        setError(loginData.error || t('auth.bip39.invalidPhrase'));
      }
    } catch (loginError) {
      console.error('Erreur lors de la connexion:', loginError);
      const message = loginError instanceof Error ? loginError.message : null;
      setError(message || t('auth.bip39.networkError'));
    } finally {
      setIsLoading(false);
      setTurnstileToken('');
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleBack}
            className="absolute top-4 left-4 p-2 bg-gray-800/50 rounded-full text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </motion.button>

          <h1 className="text-3xl font-bold bg-gradient-to-r from-red-400 to-red-600 bg-clip-text text-transparent mb-2">
            {isLinkMode
              ? t('auth.bip39.linkTitle', 'Lier un compte BIP39')
              : t('auth.secureLogin')}
          </h1>
          <p className="text-gray-400">
            {isLinkMode
              ? t('auth.bip39.linkDescription', 'Vérifiez votre phrase secrète pour lier ce compte BIP39.')
              : t('auth.connectWithSecretPhrase')}
          </p>
        </div>

        <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6 backdrop-blur-sm">
          <div className="mb-6">
            <div className="bg-gradient-to-br from-blue-500/10 to-purple-600/10 border border-blue-500/30 rounded-xl p-4 mb-6">
              <Shield className="w-8 h-8 text-blue-400 mx-auto mb-2" />
              <p className="text-gray-300 text-sm text-center mb-3">
                {isLinkMode
                  ? t('auth.bip39.enter12WordsToLink', 'Entrez vos 12 mots pour lier ce compte BIP39.')
                  : t('auth.bip39.enter12WordsToAccess')}
              </p>
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                <p className="text-yellow-200/90 text-xs text-center leading-relaxed">
                  {t('auth.bip39.spaceWarning')}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                {t('auth.bip39.phraseLabel')}
              </label>
              <div className="relative">
                <textarea
                  value={mnemonic}
                  onChange={(e) => setMnemonic(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleLogin(); } }}
                  className="w-full bg-gray-800/70 text-white px-4 py-3 pr-12 rounded-xl border border-gray-700 focus:ring-2 focus:ring-red-500 outline-none transition-all duration-300 resize-none"
                  placeholder={t('auth.bip39.phrasePlaceholder')}
                  rows={3}
                />
                <button
                  onClick={() => setShowMnemonic(!showMnemonic)}
                  className="absolute top-3 right-3 text-gray-400 hover:text-white transition-colors"
                >
                  {showMnemonic ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
              >
                <p className="text-red-400 text-sm">{error}</p>
              </motion.div>
            )}
          </div>

          <div className="space-y-4">
            {isTurnstileEnabled && (
              <div className="flex justify-center overflow-hidden w-full" style={{ maxWidth: '100%' }}>
                <div ref={turnstileRef} className="origin-center scale-[0.85] sm:scale-100" />
              </div>
            )}

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleLogin}
              disabled={!mnemonic.trim() || isLoading || (isTurnstileEnabled && !turnstileToken) || (isLinkMode && !hasLinkSession)}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white py-3 rounded-xl font-medium hover:from-red-700 hover:to-red-800 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  {isLinkMode
                    ? t('auth.bip39.linking', 'Liaison en cours...')
                    : t('auth.bip39.connecting')}
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  {isLinkMode
                    ? t('auth.bip39.linkButton', 'Lier le compte')
                    : t('auth.login', 'Se connecter')}
                </>
              )}
            </motion.button>

            {!isLinkMode && (
              <div className="space-y-3">
                <p className="text-center text-xs text-gray-500">
                  {t('auth.dontHaveAccount', "Vous n'avez pas de compte ?")}
                </p>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => { navigate('/create-account'); }}
                  disabled={isLoading}
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-3 font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  {t('auth.createSecureAccount', 'Créer un compte sécurisé')}
                </motion.button>
              </div>
            )}

            {isLinkMode && (
              <div className="space-y-3">
                <p className="text-center text-xs text-gray-500">
                  {t('auth.bip39.noAccountYet', 'Pas encore de compte BIP39 ? Vous pouvez en créer un puis le lier directement.')}
                </p>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => { navigate('/link-bip39/create', { state: { returnTo: returnPath } }); }}
                  disabled={isLoading || !hasLinkSession}
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-3 font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('auth.bip39.createAndLinkButton', 'Créer et lier un nouveau compte BIP39')}
                </motion.button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginBip39;
