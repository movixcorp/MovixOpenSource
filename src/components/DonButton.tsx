import React, { useState, useEffect } from "react";
import { useTranslation, Trans } from 'react-i18next';
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Heart, X } from "lucide-react";
import { getOverlayPortalRoot } from "../utils/overlayPortal";

const DonButton: React.FC = () => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  // Disable body scroll when modal is open and ensure it's on top
  useEffect(() => {
    if (!showModal) return;

    // Disable body scroll
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPosition = document.body.style.position;

    document.body.style.overflow = 'hidden';
    document.body.style.position = 'relative';

    // Create a style element to ensure our modal is on top
    const styleElement = document.createElement('style');
    styleElement.id = 'don-modal-styles';
    styleElement.textContent = `
      .don-modal-overlay {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin: 0 !important;
        padding: 20px !important;
        box-sizing: border-box !important;
      }
    `;
    document.head.appendChild(styleElement);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.position = previousBodyPosition;
      const existingStyle = document.getElementById('don-modal-styles');
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, [showModal]);

  const handleDonateClick = () => {
    window.open("https://www.paypal.com/donate/?hosted_button_id=LJUQ6JGRWNR8N", "_blank", "noopener,noreferrer");
  };

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setShowModal(false);
      setIsClosing(false);
    }, 300); // Durée de l'animation de fermeture
  };

  if (!showModal) {
    return (
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setShowModal(true)}
        className="flex flex-row items-center gap-3 text-gray-50 font-medium opacity-75 transition-all hover:opacity-100"
      >
        <Heart className="size-5 text-red-400" />
        {t('donate.makeADonation')}
      </motion.button>
    );
  }

  const modalContent = (
    <AnimatePresence mode="wait">
      {showModal && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="select-none don-modal-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 999999999,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            margin: 0,
            boxSizing: 'border-box'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="select-none"
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: '500px',
              backgroundColor: 'rgba(17, 24, 39, 0.98)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(75, 85, 99, 0.6)',
              borderRadius: '20px',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              overflow: 'hidden',
              margin: 'auto',
              transform: 'translateZ(0)'
            }}
          >
            <div className="bg-gray-900 rounded-lg p-6 max-w-md mx-4 relative">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                className="absolute top-4 right-4 text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            
            <div className="text-center">
              <Heart className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-white mb-4">
                {t('donate.supportMovix')}
              </h3>
              
              <div className="text-gray-300 mb-6 space-y-3">
                <p>
                  <Trans
                    i18nKey="donate.donationVipInfo"
                    components={{
                      1: <span className="font-bold text-blue-400" />,
                      2: <span className="font-bold text-yellow-400" />
                    }}
                  />
                </p>
                
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-sm text-gray-400 mb-2">{t('donate.recoverVipAfterDonation')}</p>
                  <div className="space-y-2">
                    <p className="text-sm">
                      📱 <span className="font-medium">Discord:</span> mysticsaba_alt
                    </p>
                    <p className="text-sm">
                      📱 <span className="font-medium">Telegram:</span>{" "}
                      <a
                        href="https://t.me/movix_site"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline transition-colors"
                      >
                        t.me/movix_site
                      </a>
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleClose}
                  className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleDonateClick}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                >
                  <Heart className="w-4 h-4" />
                  {t('donate.donate')}
                </motion.button>
              </div>
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

export default DonButton;
