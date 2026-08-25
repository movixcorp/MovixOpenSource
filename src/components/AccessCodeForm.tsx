import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Crown } from 'lucide-react';
import { useVipModal } from '../context/VipModalContext';
import { useTranslation } from 'react-i18next';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';

// Interface SellAuth supprimée car nous utilisons désormais Discord pour les tickets VIP

interface AccessCodeFormProps {
  isModal?: boolean;
  hideNoKeyButton?: boolean;
}

const AccessCodeForm: React.FC<AccessCodeFormProps> = ({ isModal = false, hideNoKeyButton = false }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const { checkAccessCode, error } = useAuth();
  const [showVipInfo, setShowVipInfo] = useState(false);
  const [isClosingVipInfo, setIsClosingVipInfo] = useState(false);
  const { closeVipModal } = useVipModal();


  const handleCloseVipInfo = () => {
    setIsClosingVipInfo(true);
    setTimeout(() => {
      setShowVipInfo(false);
      setIsClosingVipInfo(false);
    }, 300);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Vérifier si l'utilisateur est déjà connecté via Discord ou Google
    const discordAuth = localStorage.getItem('discord_auth') === 'true';
    const googleAuth = localStorage.getItem('google_auth') === 'true';
    const alreadyAuthenticated = discordAuth || googleAuth;
    
    try {
      const success = await checkAccessCode(code, alreadyAuthenticated);
      if (success) {
        // Add VIP flag to localStorage
        localStorage.setItem('is_vip', 'true');
        
        // Ensure guest_uuid exists
        if (!localStorage.getItem('guest_uuid')) {
          // Generate a simple UUID for anonymous users
          const tempUuid = 'vip_' + Math.random().toString(36).substring(2, 15);
          localStorage.setItem('guest_uuid', tempUuid);
        }
        
        // Informer l'application du changement de statut VIP
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('authStateChanged'));
        
        // Fermer la modal si nous sommes en mode modal
        if (isModal) {
          closeVipModal();
        }
        
        // Conserver la page en cours (film, lecteur, rÃ©glagesâ€¦) aprÃ¨s
        // l'activation : seule la modal VIP se ferme si elle Ã©tait ouverte.
      }
    } catch (error) {
      console.error('Error checking access code:', error);
    }
  };

  if (isModal) {
    return (
      <div className="w-full">
        <h2 className="text-2xl font-bold text-white mb-6 text-center bg-gradient-to-r from-red-500 to-purple-500 bg-clip-text text-transparent">
          {t('vip.accessMovixVip')}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="code" className="block text-sm font-medium text-gray-300 mb-2">
              {t('auth.accessCode')}
            </label>
            <input
              type="text"
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all duration-200"
              placeholder={t('auth.enterAccessCode')}
              required
            />
          </div>
          {error && (
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-red-500 text-sm mt-2 bg-red-500/10 p-3 rounded-lg border border-red-500/20"
            >
              {error}
            </motion.p>
          )}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="submit"
            className="w-full bg-gradient-to-r from-blue-500 to-blue-700 text-white py-3 px-4 rounded-xl font-medium hover:from-blue-600 hover:to-blue-800 transition-all duration-200 shadow-lg hover:shadow-blue-500/25"
          >
            {t('vip.accessMovixVip')}
          </motion.button>
          
          {!hideNoKeyButton && (
            <button
              onClick={() => setShowVipInfo(true)}
              className="w-full text-gray-400 hover:text-white mt-2 text-sm transition-colors duration-200"
            >
              {t('vip.noVipKey')}
            </button>
          )}
        </form>

        <AnimatePresence>
          {showVipInfo && !isClosingVipInfo && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-800 rounded-2xl p-6 max-w-md w-full relative"
              >
                <button
                  onClick={handleCloseVipInfo}
                  className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
                >
                  <X size={24} />
                </button>

                <h3 className="text-2xl font-bold text-white mb-4">{t('vip.getVip')}</h3>
                <div className="space-y-4 text-gray-300">
                  <p>{t('vip.accessForPrice')}</p>
                  <ul className="list-disc list-inside space-y-2">
                    <li>{t('vip.noAds')}</li>
                    <li>{t('vip.prioritySupport')}</li>
                  </ul>
                  <p className="text-center py-3 px-4 bg-gray-700/60 rounded-xl text-gray-200">
                    {t('vip.donateForKey')}
                  </p>
                  <Link
                    to="/vip"
                    onClick={() => {
                      handleCloseVipInfo();
                      closeVipModal();
                    }}
                    className="flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 text-black py-3 px-4 rounded-xl font-medium transition-colors duration-200"
                  >
                    <Crown className="w-4 h-4" />
                    {t('vip.donate')}
                  </Link>
                  <a
                    href="https://t.me/movix_site"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-center bg-[#0088cc] text-white py-3 px-4 rounded-xl font-medium hover:bg-[#006699] transition-colors duration-200"
                  >
                    {t('telegram.joinTelegram')}
                  </a>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-gray-900 to-black">
      <div className="relative w-full max-w-md mx-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gray-800/50 backdrop-blur-lg p-8 rounded-2xl shadow-2xl border border-gray-700"
        >
          <h2 className="text-3xl font-bold text-white mb-8 text-center bg-gradient-to-r from-red-500 to-purple-500 bg-clip-text text-transparent">
            {t('vip.accessMovixVip')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-gray-300 mb-2">
                {t('auth.accessCode')}
              </label>
              <input
                type="text"
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all duration-200"
                placeholder={t('auth.enterAccessCode')}
                required
              />
            </div>
            {error && (
              <motion.p 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-red-500 text-sm mt-2 bg-red-500/10 p-3 rounded-lg border border-red-500/20"
              >
                {error}
              </motion.p>
            )}
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              className="w-full bg-gradient-to-r from-blue-500 to-blue-700 text-white py-3 px-4 rounded-xl font-medium hover:from-blue-600 hover:to-blue-800 transition-all duration-200 shadow-lg hover:shadow-blue-500/25"
            >
              {t('vip.accessMovixVip')}
            </motion.button>
          </form>

          {!hideNoKeyButton && (
            <button
              onClick={() => setShowVipInfo(true)}
              className="w-full text-gray-400 hover:text-white mt-4 text-sm transition-colors duration-200"
            >
              {t('vip.noVipKey')}
            </button>
          )}
        </motion.div>

        <AnimatePresence>
          {showVipInfo && !isClosingVipInfo && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-800 rounded-2xl p-6 max-w-md w-full relative"
              >
                <button
                  onClick={handleCloseVipInfo}
                  className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
                >
                  <X size={24} />
                </button>

                <h3 className="text-2xl font-bold text-white mb-4">{t('vip.getVip')}</h3>
                <div className="space-y-4 text-gray-300">
                  <p>{t('vip.accessForLifePrice')}</p>
                  <ul className="list-disc list-inside space-y-2">
                    <li>{t('vip.quality4k')}</li>
                    <li>{t('vip.noAds')}</li>
                    <li>{t('vip.prioritySupport')}</li>
                    <li>{t('vip.multiLangSubtitles')}</li>
                    <li>{t('vip.multipleLanguages')}</li>
                  </ul>
                  <p className="text-center py-3 px-4 bg-gray-700/60 rounded-xl text-gray-200">
                    {t('vip.donateForKey')}
                  </p>
                  <Link
                    to="/vip"
                    onClick={handleCloseVipInfo}
                    className="flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 text-black py-3 px-4 rounded-xl font-medium transition-colors duration-200"
                  >
                    <Crown className="w-4 h-4" />
                    {t('vip.donate')}
                  </Link>
                  <a
                    href="https://t.me/movix_site"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-center bg-[#0088cc] text-white py-3 px-4 rounded-xl font-medium hover:bg-[#006699] transition-colors duration-200"
                  >
                    {t('telegram.joinTelegram')}
                  </a>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default AccessCodeForm;
