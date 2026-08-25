import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PUBLIC_DOMAIN } from '../i18n/currentDomain';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

interface RedirectPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

const RedirectPopup: React.FC<RedirectPopupProps> = ({
  isOpen,
  onClose
}) => {
  const { t } = useTranslation();
  const [isClosing, setIsClosing] = useState(false);

  // Disable body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300); // Durée de l'animation de fermeture
  };

  const handleTelegram = () => {
    window.open('https://t.me/movix_site', '_blank');
  };


  if (!isOpen) return null;

  const modalContent = (
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
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
            className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border-2 border-red-600"
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-white">🔄 {t('redirect.newAddress')}</h3>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </div>

            {/* Content */}
            <div className="text-center">
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-red-500 mb-4">
                  {t('redirect.ourNewAddress')}
                </h2>
                <div className="bg-red-600/20 border-2 border-red-500 rounded-lg p-4 mb-4">
                  <p className="text-3xl font-bold text-white">{DEFAULT_PUBLIC_DOMAIN}</p>
                </div>
                <p className="text-gray-300 text-sm">
                  {t('redirect.joinTelegramNews')}
                </p>
              </div>

              {/* Buttons */}
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleTelegram}
                  className="bg-[#229ED9] hover:bg-[#1a8abf] text-white font-bold py-3 px-5 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <MessageCircle className="w-4 h-4" />
                  Telegram
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleClose}
                  className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-5 rounded-lg transition-colors"
                >
                  {t('common.close')}
                </motion.button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Utiliser createPortal pour rendre le modal au niveau du body
  return createPortal(modalContent, getOverlayPortalRoot());
};

export default RedirectPopup;
