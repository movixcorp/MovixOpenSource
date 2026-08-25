import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bell, Calendar, Clock } from 'lucide-react';
import { AlertMenuProps, NotifyBeforeDays } from '../types/alerts';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

const AlertMenu: React.FC<AlertMenuProps> = ({
  isOpen,
  onClose,
  onConfirm,
  showName,
  season,
  episode,
  episodeName,
  airDate
}) => {
  const { t, i18n } = useTranslation();
  const [selectedDays, setSelectedDays] = useState<NotifyBeforeDays>(1);
  const [showAllOptions, setShowAllOptions] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  // Reset selection when menu opens
  useEffect(() => {
    if (isOpen) {
      setSelectedDays(1);
      setShowAllOptions(false);
      setIsClosing(false);
    }
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300);
  };

  const handleConfirm = () => {
    onConfirm(selectedDays);
  };

  const formatAirDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(i18n.language, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const getNotificationText = (days: NotifyBeforeDays) => {
    switch (days) {
      case 0:
        return t('alerts.onReleaseDay');
      case 1:
        return t('alerts.daysBeforeRelease', { count: 1 });
      case 2:
        return t('alerts.daysBeforeRelease', { count: 2 });
      case 3:
        return t('alerts.daysBeforeRelease', { count: 3 });
      case 4:
        return t('alerts.daysBeforeRelease', { count: 4 });
      case 5:
        return t('alerts.daysBeforeRelease', { count: 5 });
      case 6:
        return t('alerts.daysBeforeRelease', { count: 6 });
      case 7:
        return t('alerts.daysBeforeRelease', { count: 7 });
      default:
        return t('alerts.onReleaseDay');
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[99999999999]"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.target === e.currentTarget) handleClose();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-gray-900 rounded-2xl border border-gray-700 shadow-2xl max-w-md w-full mx-4 overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-700">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-yellow-500/20 rounded-lg">
                  <Bell className="w-5 h-5 text-yellow-500" />
                </div>
                <h2 className="text-xl font-bold text-white">{t('alerts.createAlert')}</h2>
              </div>
              <button
                onClick={handleClose}
                className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 flex-1 overflow-y-auto">
              {/* Episode Info */}
              <div className="mb-6 p-4 bg-gray-800/50 rounded-xl border border-gray-700">
                <h3 className="font-semibold text-white mb-2">{showName}</h3>
                <div className="text-sm text-gray-300 space-y-1">
                  <div>
                    {t('alerts.season')} {season}, {t('alerts.episode')} {episode}
                    {episodeName && ` - ${episodeName}`}
                  </div>
                  <div className="flex items-center gap-2 text-gray-400">
                    <Calendar className="w-4 h-4" />
                    <span>{t('alerts.airsOn', { date: formatAirDate(airDate) })}</span>
                  </div>
                </div>
              </div>

              {/* Notification Options */}
              <div className="mb-6">
                <h4 className="text-white font-medium mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  {t('alerts.whenNotify')}
                </h4>

                <div className="space-y-3">
                  {/* Show first 3 options (0, 1, 2 days) by default */}
                  {(showAllOptions
                    ? [0, 1, 2, 3, 4, 5, 6, 7]
                    : [0, 1, 2]
                  ).map((days) => (
                    <motion.label
                      key={days}
                      className={`flex items-center p-4 rounded-xl border cursor-pointer transition-all ${selectedDays === days
                        ? 'border-yellow-500 bg-yellow-500/10'
                        : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/50'
                        }`}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedDays(days as NotifyBeforeDays);
                      }}
                    >
                      <input
                        type="radio"
                        name="notifyDays"
                        value={days}
                        checked={selectedDays === days}
                        onChange={() => setSelectedDays(days as NotifyBeforeDays)}
                        className="sr-only"
                      />
                      <div className={`w-4 h-4 rounded-full border-2 mr-3 flex items-center justify-center ${selectedDays === days
                        ? 'border-yellow-500 bg-yellow-500'
                        : 'border-gray-500'
                        }`}>
                        {selectedDays === days && (
                          <div className="w-2 h-2 bg-white rounded-full" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="text-white font-medium">
                          {days === 0 ? t('alerts.sameDay') : t('alerts.daysBefore', { count: days })}
                        </div>
                        <div className="text-sm text-gray-400">
                          {t('alerts.notifyText', { text: getNotificationText(days as NotifyBeforeDays) })}
                        </div>
                      </div>
                    </motion.label>
                  ))}

                  {/* Show more/less button */}
                  {!showAllOptions && (
                    <motion.button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllOptions(true);
                      }}
                      className="w-full p-3 mt-3 border border-gray-600 hover:border-gray-500 rounded-xl text-gray-400 hover:text-white transition-colors text-sm"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      {t('alerts.showMoreOptions')}
                    </motion.button>
                  )}

                  {showAllOptions && (
                    <motion.button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllOptions(false);
                      }}
                      className="w-full p-3 mt-3 border border-gray-600 hover:border-gray-500 rounded-xl text-gray-400 hover:text-white transition-colors text-sm"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      {t('alerts.showLessOptions')}
                    </motion.button>
                  )}
                </div>
              </div>

            </div>

            {/* Actions - Fixed at bottom */}
            <div className="p-6 border-t border-gray-700 bg-gray-900">
              <div className="flex gap-3">
                <motion.button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleClose();
                  }}
                  className="flex-1 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition-colors"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleConfirm();
                  }}
                  className="flex-1 px-4 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl font-medium transition-colors"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {t('alerts.confirm')}
                </motion.button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    getOverlayPortalRoot()
  );
};

export default AlertMenu;
