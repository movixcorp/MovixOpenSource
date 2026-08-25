import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Eye, Shield, Image, FileText, Play, RotateCcw } from 'lucide-react';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

export interface AntiSpoilerSettings {
  seasonImages: boolean;
  episodeNames: boolean;
  episodeImages: boolean;
  episodeOverviews: boolean;
  nextEpisodeInfo: boolean;
  enabled: boolean;
}

interface AntiSpoilerSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsChange: (settings: AntiSpoilerSettings) => void;
  currentSettings?: AntiSpoilerSettings;
}

const DEFAULT_SETTINGS: AntiSpoilerSettings = {
  seasonImages: false,
  episodeNames: false,
  episodeImages: false,
  episodeOverviews: false,
  nextEpisodeInfo: false,
  enabled: false,
};

// Component for individual setting options
const SettingOption: React.FC<{
  option: {
    key: keyof AntiSpoilerSettings;
    label: string;
    description: string;
    icon: any;
    color: string;
  };
  isEnabled: boolean;
  onToggle: (key: keyof AntiSpoilerSettings, value: boolean) => void;
}> = ({ option, isEnabled, onToggle }) => {
  const IconComponent = option.icon;
  
  const handleClick = () => {
    onToggle(option.key, !isEnabled);
  };

  return (
    <div
      className={`p-4 rounded-xl border transition-colors cursor-pointer ${
        isEnabled
          ? 'bg-gray-800/60 border-gray-600/60'
          : 'bg-gray-900/40 border-gray-700/40 hover:bg-gray-800/40'
      }`}
      onClick={handleClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IconComponent className={`w-5 h-5 ${option.color}`} />
          <div>
            <h5 className="font-medium text-white">{option.label}</h5>
            <p className="text-sm text-gray-400">{option.description}</p>
          </div>
        </div>
        <button
          className={`relative w-12 h-6 rounded-full transition-colors ${
            isEnabled ? 'bg-green-600' : 'bg-gray-600'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-lg transition-transform duration-150 ease-out ${
              isEnabled ? 'translate-x-6' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  );
};

// Component for quick action buttons
const QuickActionButton: React.FC<{
  onClick: () => void;
  icon: any;
  label: string;
  color: string;
}> = ({ onClick, icon: IconComponent, label, color }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-2 px-4 py-2 bg-gray-800/60 hover:bg-gray-700/60 rounded-lg border border-gray-600/40 transition-colors"
  >
    <IconComponent className={`w-4 h-4 ${color}`} />
    <span className="text-sm text-gray-300">{label}</span>
  </button>
);

const AntiSpoilerSettingsModal: React.FC<AntiSpoilerSettingsProps> = ({
  isOpen,
  onClose,
  onSettingsChange,
  currentSettings
}) => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AntiSpoilerSettings>(currentSettings || DEFAULT_SETTINGS);
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

  const handleSettingChange = (key: keyof AntiSpoilerSettings, value: boolean) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300);
  };

  const handleSave = () => {
    onSettingsChange(settings);
    handleClose();
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const handleToggleAll = () => {
    setSettings(prev => {
      const allEnabled = Object.entries(prev).every(([key, value]) => 
        key === 'enabled' || value === true
      );
      
      const newSettings = { ...prev };
      Object.keys(newSettings).forEach(key => {
        if (key !== 'enabled') {
          (newSettings as any)[key] = !allEnabled;
        }
      });
      newSettings.enabled = !allEnabled;
      return newSettings;
    });
  };

  const settingsOptions = [
    {
      key: 'seasonImages' as keyof AntiSpoilerSettings,
      label: t('antiSpoiler.seasonImages'),
      description: t('antiSpoiler.seasonImagesDesc'),
      icon: Image,
      color: 'text-blue-400'
    },
    {
      key: 'episodeNames' as keyof AntiSpoilerSettings,
      label: t('antiSpoiler.episodeNames'),
      description: t('antiSpoiler.episodeNamesDesc'),
      icon: Play,
      color: 'text-purple-400'
    },
    {
      key: 'episodeImages' as keyof AntiSpoilerSettings,
      label: t('antiSpoiler.episodeImages'),
      description: t('antiSpoiler.episodeImagesDesc'),
      icon: Image,
      color: 'text-yellow-400'
    },
    {
      key: 'episodeOverviews' as keyof AntiSpoilerSettings,
      label: t('antiSpoiler.episodeOverviews'),
      description: t('antiSpoiler.episodeOverviewsDesc'),
      icon: FileText,
      color: 'text-red-400'
    },
    {
      key: 'nextEpisodeInfo' as keyof AntiSpoilerSettings,
      label: t('antiSpoiler.nextEpisodeInfo'),
      description: t('antiSpoiler.nextEpisodeInfoDesc'),
      icon: Eye,
      color: 'text-orange-400'
    }
  ];

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
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-hidden"
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-white">{t('antiSpoiler.title')}</h3>
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
            <div className="overflow-y-auto max-h-[70vh]">
          {/* Master Toggle */}
          <div className="mb-6 p-4 bg-gradient-to-r from-red-900/20 to-orange-900/20 border border-red-500/30 rounded-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-red-400" />
                <div>
                  <h4 className="font-semibold text-white">{t('antiSpoiler.masterToggleTitle')}</h4>
                  <p className="text-sm text-gray-400">{t('antiSpoiler.masterToggleDescription')}</p>
                </div>
              </div>
              <button
                onClick={() => handleSettingChange('enabled', !settings.enabled)}
                className={`relative w-14 h-8 rounded-full transition-colors ${
                  settings.enabled ? 'bg-red-600' : 'bg-gray-600'
                }`}
              >
                <div
                  className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow-lg transition-transform duration-150 ${
                    settings.enabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex gap-2 mb-6">
            <QuickActionButton
              onClick={handleToggleAll}
              icon={Shield}
              label={t('antiSpoiler.enableAll')}
              color="text-blue-400"
            />
            <QuickActionButton
              onClick={handleReset}
              icon={RotateCcw}
              label={t('antiSpoiler.reset')}
              color="text-orange-400"
            />
          </div>

              {/* Settings Options */}
              <div className="space-y-3">
                {settingsOptions.map((option) => (
                  <SettingOption
                    key={option.key}
                    option={option}
                    isEnabled={settings[option.key]}
                    onToggle={handleSettingChange}
                  />
                ))}
              </div>

              {/* Footer */}
              <div className="flex gap-3 mt-6 pt-6 border-t border-gray-700">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-3 bg-gray-600/20 border border-gray-500/30 text-gray-300 rounded-xl hover:bg-gray-600/30 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleSave}
                  className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors font-medium"
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(modalContent, getOverlayPortalRoot());
};

export default AntiSpoilerSettingsModal;