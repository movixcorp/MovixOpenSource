import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { LogOut, User, List, Star, Check, ChevronDown, Crown, Settings, Shield } from 'lucide-react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { googleAuth } from '../services/googleAuth';
import { discordAuth } from '../services/discordAuth';
import { useVipModal } from '../context/VipModalContext';
import ProfileSwitcher from './ProfileSwitcher';
import { isUserVip } from '../utils/authUtils';
import { checkVipStatus } from '../utils/vipUtils';
import { useProfile } from '../context/ProfileContext';
import { broadcastAuthChange, clearStoredAuthSession } from '../utils/accountAuth';

const ProfileMenu: React.FC = () => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isVip, setIsVip] = useState(false);
  const [canAccessAdminPanel, setCanAccessAdminPanel] = useState(false);

  // Use profile context for display data
  let currentProfile = null;
  try {
    const profileCtx = useProfile();
    currentProfile = profileCtx.currentProfile;
  } catch {
    // ProfileProvider might not be available yet
  }

  const profileImage = currentProfile?.avatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
  const username = currentProfile?.name || '';

  // Safe hook usage with error handling
  let openVipModal: (() => void) | null = null;
  try {
    const vipModal = useVipModal();
    openVipModal = vipModal.openVipModal;
  } catch (error) {
    // Silently handle the error - VipModalProvider might not be available yet
    openVipModal = null;
  }

  useEffect(() => {
    let mounted = true;

    const checkAuth = () => {
      const auth = localStorage.getItem('auth');
      const discordAuth = localStorage.getItem('discord_auth');
      const googleAuth = localStorage.getItem('google_auth');
      const bip39Auth = localStorage.getItem('bip39_auth');
      const isVipUser = isUserVip();

      const isAuth = discordAuth === 'true' || googleAuth === 'true' || bip39Auth === 'true' || !!auth;

      setIsAuthenticated(isAuth);
      setIsVip(isVipUser);
    };

    checkAuth();
    window.addEventListener('storage', checkAuth);
    window.addEventListener('vipStatusChanged', checkAuth);

    if (localStorage.getItem('access_code')) {
      void checkVipStatus().then(() => {
        if (mounted) checkAuth();
      });
    }

    return () => {
      mounted = false;
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('vipStatusChanged', checkAuth);
    };
  }, []);

  useEffect(() => {
    const checkAdminAccess = async () => {
      if (!isAuthenticated) {
        setCanAccessAdminPanel(false);
        return;
      }

      const authToken = localStorage.getItem('auth_token');
      if (!authToken) {
        setCanAccessAdminPanel(false);
        return;
      }

      try {
        const response = await fetch(`${import.meta.env.VITE_MAIN_API}/api/admin/check`, {
          headers: {
            'Authorization': `Bearer ${authToken}`
          }
        });

        if (!response.ok) {
          setCanAccessAdminPanel(false);
          return;
        }

        const data = await response.json();
        const role = String(data?.admin?.role || '').toLowerCase();
        setCanAccessAdminPanel(role === 'admin' || role === 'uploader');
      } catch {
        setCanAccessAdminPanel(false);
      }
    };

    checkAdminAccess();
  }, [isAuthenticated]);

  const handleLogout = async () => {
    const sessionId = localStorage.getItem('session_id');
    const token = localStorage.getItem('auth_token');

    // Tenter de supprimer la session courante côté serveur si possible
    try {
      if (sessionId && token) {
        await fetch(`${import.meta.env.VITE_MAIN_API}/api/sessions/delete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ sessionId })
        });
      }
    } catch (err) {
      console.error('Erreur suppression de la session lors de la déconnexion:', err);
    }

    try {
      clearStoredAuthSession();
      broadcastAuthChange();
    } catch {}
    setIsAuthenticated(false);
    setIsOpen(false);
    // Redirection simple (pas besoin de reload explicite)
    window.location.href = '/';
  };

  const handleLogin = () => {
    discordAuth.login();
  };

  const handleGoogleLogin = () => {
    googleAuth.login();
  };

  // Fonction pour ouvrir la modal VIP
  const handleOpenVipModal = () => {
    setIsOpen(false); // Fermer le menu de profil
    if (openVipModal) {
      openVipModal(); // Utiliser la fonction du contexte pour ouvrir la modal
    } else {
      // Fallback: rediriger vers la page de connexion VIP
      window.location.href = '/login-bip39';
    }
  };

  return (
    <div className="relative z-50 flex items-center justify-center">
      {/* Desktop profile button */}
      <motion.div
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 cursor-pointer md:px-0 max-md:px-0 max-md:py-0 max-md:bg-transparent"
      >
        <div className="flex items-center gap-1 sm:gap-2">
          <div className="relative group">
            <img
              src={isAuthenticated ? profileImage : 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp'}
              alt={t('header.profile')}
              className="w-7 h-7 md:w-7 md:h-7 max-md:w-7 max-md:h-7 rounded-full object-cover border-2 border-transparent group-hover:border-red-600 transition-all duration-300 shadow-md"
              onError={(e) => {
                e.currentTarget.src = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
              }}
              key={profileImage}
            />
            {isAuthenticated && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border border-black"></span>
            )}
            {isVip && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-yellow-500 text-xs flex items-center justify-center rounded-full border border-black">
                <Crown className="w-2 h-2 text-black" />
              </span>
            )}
          </div>
          <span className="hidden sm:inline md:inline text-sm font-medium truncate max-w-[80px] lg:max-w-[120px]">
            {isAuthenticated ? 
              (username.length > 12 ? username.substring(0, 12) + '...' : username) 
              : t('auth.login')}
          </span>
        </div>
        
        <ChevronDown className="w-4 h-4 hidden sm:inline md:inline transition-transform duration-300" />
      </motion.div>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Overlay to close menu when clicking outside */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            ></motion.div>
            
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="absolute right-0 md:right-0 top-full mt-2 w-64 max-sm:w-64 sm:w-64 rounded-xl bg-gradient-to-b from-gray-900 to-gray-800 shadow-2xl border border-gray-700 overflow-hidden z-[100]"
            >
              {/* Small triangle at the top of the menu - visible only on desktop */}
              <div className="absolute right-3 -top-2 w-4 h-4 bg-gray-900 transform rotate-45 border-t border-l border-gray-700 md:block"></div>
              
              {isAuthenticated ? (
                <>
                  <div className="px-5 py-4 border-b border-gray-700/50">
                    <div className="flex items-center gap-3">
                      <img 
                        src={profileImage} 
                        alt={t('header.profile')}
                        className="w-10 h-10 md:w-10 md:h-10 max-md:w-12 max-md:h-12 rounded-full object-cover border-2 border-red-600/70"
                        onError={(e) => {
                          e.currentTarget.src = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
                        }}
                      />
                      <div>
                        <div className="font-semibold text-white max-md:text-lg">
                          {username}
                          {isVip && (
                            <span className="ml-2 px-1.5 py-0.5 bg-yellow-500 text-black text-xs font-bold rounded-full">
                              VIP
                            </span>
                          )}
                        </div>
                        <div className="text-xs max-md:text-sm text-gray-400">{t('profile.connectedUser')}</div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="py-1">
                    <div className="px-5 py-3 border-b border-gray-700/30">
                      <ProfileSwitcher />
                    </div>

                    <div className="max-h-64 overflow-y-auto">
                    <Link 
                      to="/profile"
                      className="flex items-center gap-3 px-5 py-3 max-md:py-4 hover:bg-gray-700/50 transition-colors cursor-pointer"
                      onClick={() => setIsOpen(false)}
                    >
                      <User className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5 text-gray-400" />
                      <span className="max-md:text-base">{t('profile.title')}</span>
                    </Link>
                    <Link 
                      to="/profile?tab=watchlist"
                      className="flex items-center gap-3 px-5 py-3 max-md:py-4 hover:bg-gray-700/50 transition-colors cursor-pointer"
                      onClick={() => setIsOpen(false)}
                    >
                      <List className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5 text-gray-400" />
                      <span className="max-md:text-base">{t('profile.watchlist')}</span>
                    </Link>
                    <Link 
                      to="/profile?tab=favorites"
                      className="flex items-center gap-3 px-5 py-3 max-md:py-4 hover:bg-gray-700/50 transition-colors cursor-pointer"
                      onClick={() => setIsOpen(false)}
                    >
                      <Star className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5 text-gray-400" />
                      <span className="max-md:text-base">{t('common.favorites')}</span>
                    </Link>
                    <Link 
                      to="/profile?tab=watched"
                      className="flex items-center gap-3 px-5 py-3 max-md:py-4 hover:bg-gray-700/50 transition-colors cursor-pointer"
                      onClick={() => setIsOpen(false)}
                    >
                      <Check className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5 text-gray-400" />
                      <span className="max-md:text-base">{t('profile.watched')}</span>
                    </Link>
                    <Link 
                      to="/settings"
                      className="flex items-center gap-3 px-5 py-3 max-md:py-4 hover:bg-gray-700/50 transition-colors cursor-pointer border-t border-gray-700/30"
                      onClick={() => setIsOpen(false)}
                    >
                      <Settings className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5 text-gray-400" />
                      <span className="max-md:text-base">{t('settings.title')}</span>
                    </Link>
                    </div>
                  </div>
                  
                  <div className="px-4 py-3 border-t border-gray-700/50 space-y-3">
                    {canAccessAdminPanel && (
                      <Link
                        to="/admin"
                        className="flex items-center justify-center gap-2 w-full px-3 py-3 max-md:py-4 bg-gradient-to-r from-amber-500/90 to-red-600/90 hover:from-amber-500 hover:to-red-600 text-white rounded-lg transition-colors shadow-md"
                        onClick={() => setIsOpen(false)}
                      >
                        <Shield className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5" />
                        <span className="font-medium max-md:text-base">{t('admin.adminPanel')}</span>
                      </Link>
                    )}

                    {/* Bouton VIP */}
                    <motion.div
                      whileHover={isVip ? undefined : { scale: 1.02 }}
                      whileTap={isVip ? undefined : { scale: 0.98 }}
                      className={`flex items-center justify-center gap-2 w-full px-3 py-3 max-md:py-3
                        ${isVip
                          ? 'bg-gradient-to-r from-yellow-500 to-amber-600 text-black cursor-default opacity-80'
                          : 'bg-gradient-to-r from-purple-600 to-blue-600 text-white cursor-pointer hover:shadow-md'
                        } rounded-lg transition-colors`}
                      onClick={isVip ? undefined : handleOpenVipModal}
                    >
                      <Crown className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5" />
                      <span className="font-medium max-md:text-base">
                        {isVip ? t('vip.youAreVip') : t('vip.becomeVip')}
                      </span>
                    </motion.div>

                    <motion.div 
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="flex items-center justify-center gap-2 w-full px-3 py-3 max-md:py-4 bg-red-600/80 hover:bg-red-600 text-white rounded-lg transition-colors cursor-pointer"
                      onClick={handleLogout}
                    >
                      <LogOut className="w-4 h-4 md:w-4 md:h-4 max-md:w-5 max-md:h-5" />
                      <span className="font-medium max-md:text-base">{t('auth.logout')}</span>
                    </motion.div>
                  </div>
                </>
              ) : (
                <div className="p-4 max-md:p-5">
                  <div className="text-sm max-md:text-base text-gray-400 px-2 pb-3 border-b border-gray-700/50 mb-3">
                    {t('auth.loginPrompt')}
                  </div>
                  
                  <div className="space-y-3 max-md:space-y-4">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={handleLogin}
                      className="flex items-center justify-center gap-3 w-full px-4 py-3 max-md:py-4 bg-[#5865F2] hover:bg-[#4752C4] text-white rounded-lg transition-colors shadow-md"
                    >
                      <div className="flex items-center justify-center w-7 h-7 max-md:w-8 max-md:h-8 bg-white rounded-full p-0.5">
                        <img 
                          src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png"
                          alt="Discord"
                          className="w-5 h-5 max-md:w-6 max-md:h-6 object-contain"
                        />
                      </div>
                      <span className="font-medium max-md:text-base">{t('auth.loginWithDiscord')}</span>
                    </motion.button>
                    
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={handleGoogleLogin}
                      className="flex items-center justify-center gap-3 w-full px-4 py-3 max-md:py-4 bg-white hover:bg-gray-100 text-gray-800 rounded-lg transition-colors shadow-md"
                    >
                      <div className="flex items-center justify-center w-7 h-7 max-md:w-8 max-md:h-8 bg-white rounded-full shadow-sm border border-gray-200 p-0.5">
                        <img
                          src="https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png"
                          alt="Google"
                          className="w-5 h-5 max-md:w-6 max-md:h-6 object-contain"
                        />
                      </div>
                      <span className="font-medium max-md:text-base">{t('auth.loginWithGoogle')}</span>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => window.location.href = '/login-bip39'}
                      className="flex items-center justify-center gap-3 w-full px-4 py-3 max-md:py-4 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white rounded-lg transition-colors shadow-md"
                    >
                      <div className="flex items-center justify-center w-7 h-7 max-md:w-8 max-md:h-8 bg-white/20 rounded-full p-0.5">
                        <svg className="w-5 h-5 max-md:w-6 max-md:h-6" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                        </svg>
                      </div>
                      <span className="font-medium max-md:text-base">{t('auth.secretPhrase')}</span>
                    </motion.button>

                    <Link
                      to="/settings"
                      className="flex items-center justify-center gap-3 w-full px-4 py-3 max-md:py-4 bg-gray-700/50 hover:bg-gray-700/80 text-white rounded-lg transition-colors shadow-md border border-gray-600/30"
                      onClick={() => setIsOpen(false)}
                    >
                      <div className="flex items-center justify-center w-7 h-7 max-md:w-8 max-md:h-8 bg-white/10 rounded-full p-0.5">
                        <Settings className="w-5 h-5 max-md:w-6 max-md:h-6" />
                      </div>
                      <span className="font-medium max-md:text-base">{t('settings.title')}</span>
                    </Link>

                    {/* Bouton VIP pour les non-connectés */}
                    <motion.button
                      whileHover={isVip ? undefined : { scale: 1.02 }}
                      whileTap={isVip ? undefined : { scale: 0.98 }}
                      onClick={isVip ? undefined : handleOpenVipModal}
                      className={`flex items-center justify-center gap-3 w-full px-4 py-3 max-md:py-4
                        ${isVip
                          ? 'bg-gradient-to-r from-yellow-500 to-amber-600 text-black cursor-default opacity-80'
                          : 'bg-gradient-to-r from-purple-600 to-blue-600 text-white cursor-pointer hover:shadow-md'
                        } rounded-lg transition-colors`}
                    >
                      <Crown className="w-5 h-5 max-md:w-6 max-md:h-6" />
                      <span className="font-medium max-md:text-base">
                        {isVip ? t('vip.youAreVip') : t('vip.becomeVip')}
                      </span>
                    </motion.button>
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ProfileMenu;
