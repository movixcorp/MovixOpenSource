// src/components/Settings/SourceCard.tsx
//
// Card présentant une source top-level (Films/Séries) dans le panneau
// "Priorité des sources". Compose :
//  - un label lisible (SOURCE_LABELS)
//  - un badge "#1" si la source est en tête de l'ordre
//  - un switch on/off (exclut la source de l'auto-select sans la retirer du
//    pipeline pour garder le fallback manuel via le menu serveurs)
//  - un PinButton pour épingler à la position 0 (restore à l'unpin)
//  - un bouton Settings (⚙) réservé pour les overrides M6 — stub no-op ici
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { Button } from '../ui/button';
import { PinButton } from '../ui/PinButton';
import type { TopLevelSourceId } from '../../types/sourcePriority';

/**
 * Labels UI pour les sources top-level (Films/Séries).
 * Exporté pour réutilisation par M6 (overrides dialog).
 */
export const SOURCE_LABELS: Record<TopLevelSourceId, string> = {
  darkino: 'Darkino',
  mp4: 'MP4 direct',
  nexus_hls: 'Nexus HLS',
  bravo: 'Bravo/PurStream',
  fstream: 'FStream',
  wiflix: 'Lynx',
  j1f: '1jour1film',
  swiftflow: 'SwiftFlow',
  swiftflux: 'SwiftFlux (MP4)',
  omega: 'Omega',
  coflix: 'Coflix',
  frembed: 'Frembed',
  vostfr: 'Vostfr',
  viper: 'Viper',
  vox: 'Vox',
  kisskh: 'KissKH',
  custom: 'Lecteur Movix',
};

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  ariaLabel?: string;
}

/**
 * Minimal toggle inspiré du `renderToggle` existant dans SettingsPage.
 * Style homogène avec le reste de la page.
 */
const Switch: React.FC<SwitchProps> = ({ checked, onCheckedChange, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    onClick={(e) => {
      e.stopPropagation();
      onCheckedChange(!checked);
    }}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
      checked ? 'bg-indigo-500' : 'bg-gray-600'
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
        checked ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);

interface SourceCardProps {
  id: TopLevelSourceId;
  enabled: boolean;
  isPinned: boolean;
  /** True si la source est en première position de `sourceOrder`. Affiche le badge #1. */
  isFirst: boolean;
  onToggle: (enabled: boolean) => void;
  onTogglePin: () => void;
  /** Stub M6 (overrides dialog). No-op pour l'instant. */
  onOpenOverride: () => void;
}

export const SourceCard: React.FC<SourceCardProps> = ({
  id, enabled, isPinned, isFirst, onToggle, onTogglePin, onOpenOverride,
}) => {
  const { t } = useTranslation();
  const label = SOURCE_LABELS[id];
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-white truncate">{label}</span>
        {isFirst && (
          <span
            className="text-xs text-amber-400 font-semibold"
            aria-label={t('settings.sourcePriority.pinAriaSource')}
          >
            {t('settings.sourcePriority.pinBadge')}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          ariaLabel={t('settings.sourcePriority.toggleSourceAria', { label })}
        />
        <PinButton isPinned={isPinned} onToggle={onTogglePin} />
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenOverride}
          aria-label={t('settings.sourcePriority.customizeHosters')}
          className="h-8 w-8"
        >
          <Settings size={14} />
        </Button>
      </div>
    </div>
  );
};

export default SourceCard;
