import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { avatarCategories } from '../data/avatars';
import { platformAvatars, platforms } from '../data/new_avatars';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

interface AvatarSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onAvatarSelect: (avatarUrl: string) => void;
  currentAvatar?: string;
}

// Memoized avatar button component for performance
const AvatarButton = memo(({
  avatar,
  index,
  isSelected,
  onClick
}: {
  avatar: string;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}) => (
  <motion.button
    initial={{ opacity: 0, scale: 0.8 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.15, delay: Math.min(index * 0.005, 0.2) }}
    onClick={onClick}
    whileHover={{ scale: 1.05 }}
    whileTap={{ scale: 0.95 }}
    className={`relative w-16 h-16 sm:w-18 sm:h-18 md:w-20 md:h-20 lg:w-22 lg:h-22 rounded-full ring-2 transition-all duration-200 ${isSelected
        ? 'ring-yellow-500'
        : 'ring-transparent hover:ring-red-600'
      }`}
  >
    <img
      src={avatar}
      alt={`Avatar ${index + 1}`}
      className="w-full h-full object-cover rounded-full"
      loading="lazy"
      decoding="async"
    />
    {isSelected && (
      <div className="absolute inset-0 bg-yellow-500/20 rounded-full flex items-center justify-center">
        <div className="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center">
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      </div>
    )}
  </motion.button>
));

AvatarButton.displayName = 'AvatarButton';

const AvatarSelector: React.FC<AvatarSelectorProps> = ({
  isOpen,
  onClose,
  onAvatarSelect,
  currentAvatar
}) => {
  const { t } = useTranslation();
  const [selectedPlatform, setSelectedPlatform] = useState<string>(platforms[0] || 'Crunchyroll');
  const [isClosing, setIsClosing] = useState(false);

  // Disable body scroll and Lenis when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Stop Lenis to allow native scrolling inside the modal
    const lenis = (window as any).lenis;
    if (lenis) lenis.stop();

    return () => {
      document.body.style.overflow = originalOverflow;
      if (lenis) lenis.start();
    };
  }, [isOpen]);

  // Memoized close handler
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300);
  }, [onClose]);

  // Memoized avatar click handler
  const handleAvatarClick = useCallback((avatarUrl: string) => {
    setIsClosing(true);
    setTimeout(() => {
      onAvatarSelect(avatarUrl);
      onClose();
      setIsClosing(false);
    }, 300);
  }, [onAvatarSelect, onClose]);

  // Memoize current categories to avoid recalculation
  const currentCategories = useMemo(() => {
    const isClassiques = selectedPlatform === 'Classiques';
    return isClassiques
      ? avatarCategories
      : (platformAvatars[selectedPlatform] || {});
  }, [selectedPlatform]);

  // Memoize platform list with Classiques
  const allPlatforms = useMemo(() => {
    const hasOldAvatars = Object.keys(avatarCategories).length > 0;
    return hasOldAvatars ? [...platforms, 'Classiques'] : platforms;
  }, []);

  if (!isOpen) return null;

  const modalContent = (
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          data-lenis-prevent
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-gray-900 rounded-2xl p-6 max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-6 flex-shrink-0">
              <h3 className="text-xl font-bold text-white">{t('profile.selectAvatar')}</h3>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </div>

            {/* Platform Tabs */}
            <div className="flex gap-2 mb-4 flex-wrap justify-center flex-shrink-0">
              {allPlatforms.map((platform) => (
                <button
                  key={platform}
                  onClick={() => setSelectedPlatform(platform)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${selectedPlatform === platform
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-gray-800/60 text-gray-300 border-gray-700 hover:bg-gray-800'
                    }`}
                >
                  {platform}
                </button>
              ))}
            </div>

            {/* Content with Categories */}
            <div className="overflow-y-auto flex-1 scrollbar-hidden relative">
              <AnimatePresence mode="wait">
                <motion.div
                  key={selectedPlatform}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="space-y-4"
                >
                  {Object.entries(currentCategories).map(([category, avatars]) => (
                    <div key={category} className="relative">
                      {/* Sticky Category Title - higher z-index */}
                      <h4 className="text-sm font-semibold text-gray-300 sticky top-0 bg-gray-900 py-2 z-20 border-b border-gray-800/50">
                        {category}
                      </h4>

                      {/* Avatar Grid - lower z-index */}
                      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-3 justify-items-center py-3 relative z-0">
                        {(avatars as string[]).map((avatar: string, index: number) => (
                          <AvatarButton
                            key={`${avatar}-${index}`}
                            avatar={avatar}
                            index={index}
                            isSelected={currentAvatar === avatar}
                            onClick={() => handleAvatarClick(avatar)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(modalContent, getOverlayPortalRoot());
};

export default memo(AvatarSelector);