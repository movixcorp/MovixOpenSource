import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, Eye, EyeOff, ArrowLeft, Camera, Shield } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AvatarSelector from '../components/AvatarSelector';
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

interface Step {
  id: number;
  title: string;
  description: string;
}

interface CreateAccountProps {
  mode?: 'create' | 'link';
}

const CreateAccount: React.FC<CreateAccountProps> = ({ mode = 'create' }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isLinkMode = mode === 'link';
  const [currentStep, setCurrentStep] = useState(1);
  const [mnemonic, setMnemonic] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [username, setUsername] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('');
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [verificationMnemonic, setVerificationMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
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
  const pendingAction = getPendingAuthAction();
  const hasValidLinkAction = pendingAction?.type === 'link' && pendingAction.provider === 'bip39';
  const stateReturnTo = typeof location.state === 'object' && location.state && 'returnTo' in location.state && typeof location.state.returnTo === 'string'
    ? location.state.returnTo
    : null;
  const returnPath = stateReturnTo || (hasValidLinkAction ? (pendingAction.returnTo || '/settings#accounts') : '/settings#accounts');
  const authorizeReturnPath = !isLinkMode && pendingAction?.type === 'oauth-authorize'
    ? pendingAction.returnTo || '/'
    : null;
  const hasLinkSession = Boolean(localStorage.getItem('auth_token'));

  const steps: Step[] = [
    {
      id: 1,
      title: t('auth.bip39.generateTitle'),
      description: t('auth.bip39.generateDesc')
    },
    {
      id: 2,
      title: t('auth.bip39.saveTitle'),
      description: t('auth.bip39.saveDesc')
    },
    {
      id: 3,
      title: t('auth.bip39.profileTitle'),
      description: t('auth.bip39.profileDesc')
    },
    {
      id: 4,
      title: t('auth.bip39.verificationTitle'),
      description: t('auth.bip39.verificationDesc')
    }
  ];

  useEffect(() => {
    if (currentStep === 1 && !mnemonic) {
      generateMnemonic();
    }
  }, [currentStep, mnemonic]);

  useEffect(() => {
    if (!isLinkMode || hasLinkSession) return;
    toast.error(t('auth.bip39.linkSessionMissing', 'Session de liaison introuvable. Retournez dans Paramètres et recommencez.'));
    navigate('/settings#accounts', { replace: true });
  }, [hasLinkSession, isLinkMode, navigate, t]);

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

    if (currentStep === 4) {
      // Rendre Turnstile quand on arrive à l'étape 4
      setTimeout(() => {
        if (window.turnstile) {
          renderTurnstile();
        } else {
          const interval = setInterval(() => {
            if (window.turnstile) {
              clearInterval(interval);
              renderTurnstile();
            }
          }, 200);
        }
      }, 300); // Attendre que le DOM soit rendu
    }
    return () => {
      if (currentStep !== 4 && widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
        setTurnstileToken('');
      }
    };
  }, [currentStep, isTurnstileEnabled, renderTurnstile]);

  const generateMnemonic = async () => {
    setIsGenerating(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/bip39/generate`);
      const data = await response.json();
      
      if (data.success) {
        setMnemonic(data.mnemonic);
      } else {
        console.error('Erreur lors de la génération:', data.error);
      }
    } catch (error) {
      console.error('Erreur réseau:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error('Erreur lors de la copie:', error);
    }
  };

  const handleConfirmed = () => {
    setIsConfirmed(true);
    setCurrentStep(3);
  };

  const handleAvatarSelect = (avatarUrl: string) => {
    // Les URLs dans avatars.ts sont déjà au bon format
    setSelectedAvatar(avatarUrl);
    setShowAvatarModal(false);
  };

  const createAccount = async () => {
    if (!verificationMnemonic || verificationMnemonic !== mnemonic) {
      toast.error(t('auth.secretPhraseMismatch'));
      return;
    }

    if (isTurnstileEnabled && !turnstileToken) {
      toast.error(t('auth.captchaRequired', 'Veuillez compléter la vérification de sécurité'));
      return;
    }

    setIsCreating(true);
    try {
      const currentAuthToken = isLinkMode ? localStorage.getItem('auth_token') : null;
      if (isLinkMode && !currentAuthToken) {
        clearPendingAuthAction();
        throw new Error(t('auth.bip39.linkSessionMissing', 'Session de liaison introuvable. Retournez dans Paramètres et recommencez.'));
      }

      const response = await fetch(`${API_URL}/api/auth/bip39/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getSessionCreationHeaders(),
        },
        body: JSON.stringify({
          mnemonic,
          username,
          avatar: selectedAvatar,
          turnstileToken
        }),
      });

      const data = await response.json();
      
      if (data.success) {
        if (isLinkMode) {
          const linkResponse = await fetch(`${API_URL}/api/auth/links/bip39`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${currentAuthToken}`,
            },
            body: JSON.stringify({ mnemonic }),
          });

          const linkData = await linkResponse.json();
          if (!linkResponse.ok || !linkData.success) {
            throw new Error(linkData.error || t('auth.bip39.linkFailed', 'Impossible de lier ce compte BIP39.'));
          }

          clearPendingAuthAction();
          navigate(returnPath);
          return;
        }

        // Sauvegarder les informations d'authentification
        persistResolvedSession('bip39', {
          sessionId: data.sessionId || null,
          token: data.token || null,
          account: {
            userType: 'bip39',
            userId: data.userProfile?.id || null,
          },
          authData: {
            userProfile: data.userProfile,
            provider: 'bip39',
          },
        });


        // Déclencher l'événement de changement d'authentification
        broadcastAuthChange();

        // Rediriger vers la page d'accueil ou reprendre le flow OAuth
        navigate(authorizeReturnPath || '/');
      } else {
        toast.error(data.error || t('auth.bip39.creationError'));
      }
    } catch (error) {
      console.error('Erreur lors de la création du compte:', error);
      const message = error instanceof Error ? error.message : null;
      toast.error(message || t('auth.bip39.networkCreationError'));
    } finally {
      setIsCreating(false);
      setTurnstileToken('');
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    }
  };

  const renderStep1 = () => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="text-center space-y-6"
    >
      <div className="bg-gradient-to-br from-blue-500/10 to-purple-600/10 border border-blue-500/30 rounded-xl p-6">
        <Shield className="w-12 h-12 text-blue-400 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-white mb-2">{t('auth.bip39.maxSecurity')}</h3>
        <p className="text-gray-300 text-sm">
          {t('auth.bip39.maxSecurityDesc')}
        </p>
      </div>

      {isGenerating ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-500"></div>
          <span className="ml-3 text-gray-300">{t('auth.bip39.generating')}</span>
        </div>
      ) : (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setCurrentStep(2)}
          disabled={!mnemonic || isGenerating}
          className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white py-3 rounded-xl font-medium hover:from-red-700 hover:to-red-800 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isGenerating ? t('auth.bip39.generating') : t('common.continue')}
        </motion.button>
      )}
    </motion.div>
  );

  const renderStep2 = () => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="bg-gradient-to-br from-yellow-500/10 to-orange-600/10 border border-yellow-500/30 rounded-xl p-4">
        <h3 className="text-yellow-400 font-semibold mb-2 flex items-center gap-2">
          ⚠️ {t('common.important')}
        </h3>
        <p className="text-gray-300 text-sm">
          {t('auth.bip39.saveWarningDesc')}
        </p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-400">{t('auth.bip39.yourPhrase12')}</span>
          <button
            onClick={() => setShowMnemonic(!showMnemonic)}
            className="text-gray-400 hover:text-white transition-colors"
          >
            {showMnemonic ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        
        <div className="bg-black/30 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-3 gap-2 text-sm">
            {(showMnemonic ? mnemonic.split(' ') : Array(12).fill('•••••')).map((word, index) => (
              <div key={index} className="bg-gray-700/50 rounded px-2 py-1 text-center">
                <span className="text-gray-400 text-xs">{index + 1}.</span>
                <span className="text-white ml-1">{word}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={copyToClipboard}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {isCopied ? t('common.copied') : t('common.copy')}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              setMnemonic('');
              setIsCopied(false);
              setIsConfirmed(false);
              generateMnemonic();
            }}
            disabled={isGenerating}
            className="px-4 bg-gray-600 hover:bg-gray-700 text-white py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('auth.generateNewPhrase')}
          >
            🔄
          </motion.button>
        </div>
      </div>

      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isConfirmed}
            onChange={(e) => setIsConfirmed(e.target.checked)}
            className="mt-1 w-4 h-4 text-green-600 bg-gray-700 border-gray-600 rounded focus:ring-green-500 focus:ring-2"
          />
          <span className="text-sm text-gray-300">
            {t('auth.bip39.savedConfirmation')}
          </span>
        </label>
      </div>

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={handleConfirmed}
        disabled={!isConfirmed}
        className="w-full bg-gradient-to-r from-green-600 to-green-700 text-white py-3 rounded-xl font-medium hover:from-green-700 hover:to-green-800 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('auth.bip39.notedContinue')}
      </motion.button>
    </motion.div>
  );

  const renderStep3 = () => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Avatar Selection */}
      <div className="text-center">
        <label className="block text-sm font-medium text-gray-300 mb-3">{t('auth.bip39.profilePicture')}</label>
        <div className="relative inline-block">
          <motion.div
            whileHover={{ scale: 1.05 }}
            className="w-24 h-24 rounded-full overflow-hidden border-2 border-red-600/70 cursor-pointer"
            onClick={() => setShowAvatarModal(true)}
          >
            <img
              src={selectedAvatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp'}
              alt={t('common.avatar')}
              className="w-full h-full object-cover"
            />
          </motion.div>
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setShowAvatarModal(true)}
            className="absolute bottom-0 right-0 p-2 bg-red-600 rounded-full text-white hover:bg-red-700 transition-colors"
          >
            <Camera className="w-4 h-4" />
          </motion.button>
        </div>
      </div>

      {/* Username Input */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">{t('auth.username', "Nom d'utilisateur")}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full bg-gray-800/70 text-white px-4 py-3 rounded-xl border border-gray-700 focus:ring-2 focus:ring-red-500 outline-none transition-all duration-300"
          placeholder={t('auth.bip39.usernamePlaceholder')}
          maxLength={20}
        />
      </div>

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => setCurrentStep(4)}
        disabled={!username.trim() || !selectedAvatar}
        className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white py-3 rounded-xl font-medium hover:from-red-700 hover:to-red-800 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('common.continue')}
      </motion.button>
    </motion.div>
  );

  const renderStep4 = () => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="bg-gradient-to-br from-green-500/10 to-blue-600/10 border border-green-500/30 rounded-xl p-4">
        <h3 className="text-green-400 font-semibold mb-2">{t('auth.bip39.lastStep')}</h3>
        <p className="text-gray-300 text-sm">
          {t('auth.bip39.confirmDesc')}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          {t('auth.bip39.confirmPhrase')}
        </label>
        <textarea
          value={verificationMnemonic}
          onChange={(e) => setVerificationMnemonic(e.target.value)}
          className="w-full bg-gray-800/70 text-white px-4 py-3 rounded-xl border border-gray-700 focus:ring-2 focus:ring-red-500 outline-none transition-all duration-300 resize-none"
          placeholder={t('auth.bip39.phrasePlaceholder')}
          rows={3}
        />
      </div>

      {/* Turnstile CAPTCHA */}
      {isTurnstileEnabled && (
        <div className="flex justify-center overflow-hidden w-full" style={{ maxWidth: '100%' }}>
          <div ref={turnstileRef} className="origin-center scale-[0.85] sm:scale-100" />
        </div>
      )}

      <div className="flex gap-3">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setCurrentStep(3)}
          className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-xl font-medium transition-colors"
        >
          {t('common.back')}
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={createAccount}
          disabled={!verificationMnemonic.trim() || isCreating || (isTurnstileEnabled && !turnstileToken)}
          className="flex-1 bg-gradient-to-r from-green-600 to-green-700 text-white py-3 rounded-xl font-medium hover:from-green-700 hover:to-green-800 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              {isLinkMode
                ? t('auth.bip39.createAndLinkLoading', 'Création et liaison en cours...')
                : t('auth.bip39.creating')}
            </>
          ) : (
            isLinkMode
              ? t('auth.bip39.createAndLinkButtonShort', 'Créer et lier')
              : t('auth.createAccount', 'Créer le compte')
          )}
        </motion.button>
      </div>
    </motion.div>
  );

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate(isLinkMode ? '/link-bip39' : (authorizeReturnPath || '/'))}
            className="absolute top-4 left-4 p-2 bg-gray-800/50 rounded-full text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </motion.button>
          
          <h1 className="text-3xl font-bold bg-gradient-to-r from-red-400 to-red-600 bg-clip-text text-transparent mb-2">
            {isLinkMode
              ? t('auth.bip39.linkCreateTitle', 'Créer et lier un compte BIP39')
              : t('auth.createAccount', 'Créer un compte')}
          </h1>
          <p className="text-gray-400">
            {isLinkMode
              ? t('auth.bip39.linkCreateDescription', 'Générez une phrase secrète puis liez ce nouveau compte BIP39 à votre compte actuel.')
              : t('auth.bip39.secureConnectionDesc')}
          </p>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-between mb-8">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all duration-300 ${
                currentStep >= step.id 
                  ? 'bg-red-600 text-white' 
                  : 'bg-gray-700 text-gray-400'
              }`}>
                {step.id}
              </div>
              {index < steps.length - 1 && (
                <div className={`w-8 h-0.5 mx-2 transition-all duration-300 ${
                  currentStep > step.id ? 'bg-red-600' : 'bg-gray-700'
                }`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6 backdrop-blur-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-white mb-2">
              {steps[currentStep - 1]?.title}
            </h2>
            <p className="text-gray-400 text-sm">
              {steps[currentStep - 1]?.description}
            </p>
          </div>

          <AnimatePresence mode="wait">
            {currentStep === 1 && renderStep1()}
            {currentStep === 2 && renderStep2()}
            {currentStep === 3 && renderStep3()}
            {currentStep === 4 && renderStep4()}
          </AnimatePresence>
        </div>
      </div>

      {/* Avatar Selection Modal */}
      <AvatarSelector
        isOpen={showAvatarModal}
        onClose={() => setShowAvatarModal(false)}
        onAvatarSelect={handleAvatarSelect}
        currentAvatar={selectedAvatar}
      />
    </div>
  );
};

export default CreateAccount;
