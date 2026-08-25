// src/components/Settings/SkipSegmentsPanel.tsx
//
// Réglages du saut de séquences (intro, résumé, outro, crédits, aperçu),
// affichés dans l'onglet Progression du lecteur.
//
// Reprend le vocabulaire visuel de `SubtitleStyleControls` — cartes
// `rounded-xl border-white/10`, boutons-choix, `Switch` maison,
// `BgColorPickerPanel` — pour que ce panneau ne détonne pas au milieu des
// autres réglages du lecteur. Le tri des sources passe par `SortableList`
// (dnd-kit), comme la priorité des hosters.
//
// Aucune boîte de confirmation : chaque réglage s'applique immédiatement et
// se défait aussi vite.

import React, { memo, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, RotateCcw, Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SortableList } from '@/components/ui/SortableList';
import { BgColorPickerPanel } from '@/components/Settings/BgColorPickerPanel';
import {
  fetchProviders,
  type ProviderInfo,
  type ProviderStatus,
} from '../../services/mediaSegmentsService';
import {
  DEFAULT_SKIP_SETTINGS,
  END_OFFSET_MAX,
  END_OFFSET_MIN,
  PROMPT_DELAY_MAX,
  PROVIDER_IDS,
  SEGMENT_COLOR_PRESETS,
  SEGMENT_KINDS,
  type ProviderId,
  type SegmentKind,
  type SegmentModeOverride,
  type SegmentTypeSettings,
  type SkipMode,
  type SkipSegmentSettings,
} from '../../utils/skipSegmentPrefs';

interface SkipSegmentsPanelProps {
  settings: SkipSegmentSettings;
  /** État renvoyé par le backend pour le contenu en cours (`ok`, `empty`, …). */
  providerStatus?: Record<string, ProviderStatus>;
  /** Détail technique par source (code HTTP), pour l'infobulle du badge. */
  providerDetail?: Record<string, string>;
  onSettingsChange: (patch: Partial<SkipSegmentSettings>) => void;
  onSegmentTypeChange: (kind: SegmentKind, patch: Partial<SegmentTypeSettings>) => void;
  onSegmentColorChange: (kind: SegmentKind, hex: string) => void;
  onProviderToggle: (id: ProviderId, enabled: boolean) => void;
  onProviderReorder: (order: ProviderId[]) => void;
  onReset: () => void;
  /** Ouvre le studio de repérage. Absent quand le contenu n'est pas identifié. */
  onOpenStudio?: () => void;
  /** Nombre de propositions déjà déposées pour ce contenu. */
  communityCount: number;
}

// === Vocabulaire visuel, aligné sur SubtitleStyleControls ===================
const CARD = 'space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3';
const CHOICE = (selected: boolean) =>
  `min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm transition-[transform,color,background-color,border-color] duration-150 active:scale-[.98] ${
    selected
      ? 'border-red-500/50 bg-red-600/20 text-white font-medium'
      : 'border-white/10 bg-white/5 text-white hover:bg-white/10'
  }`;

const Heading: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div>
    <h3 className="font-semibold text-white">{title}</h3>
    <p className="text-xs leading-relaxed text-gray-400">{description}</p>
  </div>
);

/**
 * Curseur au look maison : la piste et la pastille sont dessinées, l'`input`
 * natif est superposé en transparence — ce qui donne le clavier, le tactile et
 * l'accessibilité sans les réimplémenter.
 */
const Range: React.FC<{
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  onChange: (value: number) => void;
}> = ({ min, max, step, value, label, onChange }) => {
  const ratio = max > min ? (value - min) / (max - min) : 0;

  // Course rentrée d'une demi-pastille de chaque côté, exactement comme le fait
  // un `input[type=range]` natif. Sans ça, la pastille est centrée sur 0 % et
  // sur 100 %, donc sa moitié déborde du conteneur — et la carte qui l'entoure
  // est en `overflow-hidden` (nécessaire pour l'animation de dépliage), ce qui
  // la coupe en deux demi-lunes aux extrémités.
  const THUMB_REM = 1; // h-4 / w-4
  const center = `calc(${THUMB_REM / 2}rem + (100% - ${THUMB_REM}rem) * ${ratio})`;

  return (
    <div className="relative flex h-9 w-full items-center">
      <div className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-white/15">
        {/* Le remplissage s'arrête au centre de la pastille, pas au bord du
            conteneur : sinon la barre rouge la devance de quelques pixels. */}
        <div className="h-full rounded-full bg-red-600" style={{ width: center }} />
      </div>
      <div
        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white bg-red-600 shadow-lg shadow-black/40"
        style={{ left: center }}
      />
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        // La pastille native est invisible mais c'est elle qui définit la
        // course réelle : on lui impose la même taille que la pastille dessinée
        // pour que le pointeur et le visuel tombent exactement au même endroit.
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none"
      />
    </div>
  );
};

/** Ligne « intitulé — valeur — curseur — explication ». */
const RangeRow: React.FC<{
  title: string;
  description: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}> = ({ title, description, valueLabel, ...range }) => (
  <div>
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <span className="text-sm text-white">{title}</span>
      <span className="shrink-0 text-sm tabular-nums text-gray-300">{valueLabel}</span>
    </div>
    <Range label={title} {...range} />
    <p className="text-[11px] leading-relaxed text-gray-500">{description}</p>
  </div>
);

/** Ligne « intitulé + explication » avec un interrupteur à droite. */
const SwitchRow: React.FC<{
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}> = ({ title, description, checked, onChange }) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <p className="text-sm text-white">{title}</p>
      <p className="text-[11px] leading-relaxed text-gray-500">{description}</p>
    </div>
    <div className="pt-0.5">
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} size="sm" />
    </div>
  </div>
);

const SEGMENT_LABEL_KEY: Record<SegmentKind, string> = {
  intro: 'watch.segmentIntro',
  recap: 'watch.segmentRecap',
  outro: 'watch.segmentOutro',
  credits: 'watch.segmentCredits',
  preview: 'watch.segmentPreview',
};

const SEGMENT_HINT_KEY: Record<SegmentKind, string> = {
  intro: 'watch.segmentIntroHint',
  recap: 'watch.segmentRecapHint',
  outro: 'watch.segmentOutroHint',
  credits: 'watch.segmentCreditsHint',
  preview: 'watch.segmentPreviewHint',
};

/** Position et largeur de chaque type dans l'aperçu de barre, en pourcentage. */
const PREVIEW_LAYOUT: Record<SegmentKind, { left: number; width: number }> = {
  recap: { left: 2, width: 8 },
  intro: { left: 12, width: 13 },
  outro: { left: 78, width: 10 },
  credits: { left: 89, width: 6 },
  preview: { left: 96, width: 3 },
};

const SKIP_MODES: readonly SkipMode[] = ['off', 'button', 'auto'];
const SKIP_MODE_LABEL_KEY: Record<SkipMode, string> = {
  off: 'watch.skipModeOff',
  button: 'watch.skipModeButton',
  auto: 'watch.skipModeAuto',
};
const SKIP_MODE_DESC_KEY: Record<SkipMode, string> = {
  off: 'watch.skipModeOffDesc',
  button: 'watch.skipModeButtonDesc',
  auto: 'watch.skipModeAutoDesc',
};

const OVERRIDES: readonly SegmentModeOverride[] = ['inherit', 'button', 'auto'];
const OVERRIDE_LABEL_KEY: Record<SegmentModeOverride, string> = {
  inherit: 'watch.segmentModeInherit',
  off: 'watch.skipModeOff',
  button: 'watch.skipModeButton',
  auto: 'watch.skipModeAuto',
};

const PROVIDER_STATUS_LABEL_KEY: Record<string, string> = {
  ok: 'watch.providerStatusOk',
  empty: 'watch.providerStatusEmpty',
  error: 'watch.providerStatusError',
  timeout: 'watch.providerStatusTimeout',
  'rate-limited': 'watch.providerStatusRateLimited',
  throttled: 'watch.providerStatusThrottled',
  unauthorized: 'watch.providerStatusUnauthorized',
  unconfigured: 'watch.providerStatusUnconfigured',
  unsupported: 'watch.providerStatusUnsupported',
  'no-id': 'watch.providerStatusNoId',
};

const PROVIDER_STATUS_CLASS: Record<string, string> = {
  ok: 'text-green-400 bg-green-500/10',
  empty: 'text-gray-400 bg-white/5',
  error: 'text-red-400 bg-red-500/10',
  timeout: 'text-orange-400 bg-orange-500/10',
  'rate-limited': 'text-orange-400 bg-orange-500/10',
  throttled: 'text-orange-400 bg-orange-500/10',
  unauthorized: 'text-orange-400 bg-orange-500/10',
  unconfigured: 'text-gray-500 bg-white/5',
  unsupported: 'text-gray-500 bg-white/5',
  'no-id': 'text-gray-500 bg-white/5',
};

const FALLBACK_PROVIDER_LABEL: Record<ProviderId, string> = {
  skipdb: 'SkipDB',
  introdb: 'IntroDB',
  theintrodb: 'TheIntroDB',
  aniskip: 'AniSkip',
};

const SkipSegmentsPanel: React.FC<SkipSegmentsPanelProps> = ({
  settings,
  providerStatus = {},
  providerDetail = {},
  onSettingsChange,
  onSegmentTypeChange,
  onSegmentColorChange,
  onProviderToggle,
  onProviderReorder,
  onReset,
  onOpenStudio,
  communityCount,
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Un seul éditeur de couleur ouvert à la fois : cinq pipettes dépliées
  // rendraient le panneau illisible.
  const [colorEditing, setColorEditing] = useState<SegmentKind | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  // Inventaire des sources côté serveur : sert à afficher leur nom et à
  // signaler celles qui sont hors service faute de clé d'API. L'appel est mis
  // en cache par le service, donc rouvrir le panneau ne relance rien.
  useEffect(() => {
    let cancelled = false;
    fetchProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const providersById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const enabledProviders = useMemo(
    () => new Set(settings.enabledProviders),
    [settings.enabledProviders],
  );

  // Une source ajoutée côté serveur après coup se retrouve en queue de liste.
  const orderedProviders = useMemo(() => {
    const known = settings.providerOrder.filter((id) => PROVIDER_IDS.includes(id));
    for (const id of PROVIDER_IDS) if (!known.includes(id)) known.push(id);
    return known;
  }, [settings.providerOrder]);

  const active = settings.mode !== 'off';
  const activeKinds = SEGMENT_KINDS.filter((kind) => settings.types[kind].enabled);

  return (
    <div className="space-y-3">
      {/* ================================================================== */}
      {/* Quoi faire des séquences                                            */}
      {/* ================================================================== */}
      <div className={CARD}>
        <Heading title={t('watch.skipSegments')} description={t('watch.skipSegmentsDesc')} />

        <div className="flex gap-2">
          {SKIP_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={settings.mode === mode}
              onClick={() => onSettingsChange({ mode })}
              className={CHOICE(settings.mode === mode)}
            >
              {t(SKIP_MODE_LABEL_KEY[mode])}
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-gray-400">{t(SKIP_MODE_DESC_KEY[settings.mode])}</p>

        {/* Aperçu : une barre de progression factice où l'on voit d'un coup
            d'œil ce que « séquence » veut dire et à quoi servent les couleurs. */}
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-gray-500">
            {t('watch.skipPreviewLabel')}
          </p>
          <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-600/40">
            <div className="absolute inset-y-0 left-0 w-2/5 bg-red-600" />
            {activeKinds.map((kind) => (
              <div
                key={kind}
                className="absolute inset-y-0 rounded-full"
                style={{
                  left: `${PREVIEW_LAYOUT[kind].left}%`,
                  width: `${PREVIEW_LAYOUT[kind].width}%`,
                  backgroundColor: settings.colors[kind],
                  opacity: settings.showMarkers ? 1 : 0.25,
                }}
                title={t(SEGMENT_LABEL_KEY[kind])}
              />
            ))}
            <div
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600"
              style={{ left: '40%' }}
            />
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            key="skip-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-3 overflow-hidden"
          >
            {/* ============================================================== */}
            {/* Quelles séquences, et de quelle couleur                        */}
            {/* ============================================================== */}
            <div className={CARD}>
              <Heading title={t('watch.segmentTypes')} description={t('watch.segmentTypesDesc')} />

              <div className="space-y-2">
                {SEGMENT_KINDS.map((kind) => {
                  const type = settings.types[kind];
                  const color = settings.colors[kind];
                  const isEditingColor = colorEditing === kind;

                  return (
                    <div
                      key={kind}
                      className={`rounded-lg border transition-colors ${
                        type.enabled ? 'border-white/10 bg-white/5' : 'border-transparent bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center gap-3 p-2.5">
                        <button
                          type="button"
                          onClick={() => setColorEditing(isEditingColor ? null : kind)}
                          aria-label={t('watch.segmentColorFor', { name: t(SEGMENT_LABEL_KEY[kind]) })}
                          className={`h-6 w-6 shrink-0 rounded-full border-2 transition-transform active:scale-90 ${
                            isEditingColor ? 'border-white' : 'border-white/25 hover:border-white/60'
                          }`}
                          style={{ backgroundColor: color }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm ${type.enabled ? 'text-white' : 'text-gray-400'}`}>
                            {t(SEGMENT_LABEL_KEY[kind])}
                          </p>
                          <p className="text-[11px] leading-relaxed text-gray-500">
                            {t(SEGMENT_HINT_KEY[kind])}
                          </p>
                        </div>
                        <Switch
                          checked={type.enabled}
                          onCheckedChange={(next) => onSegmentTypeChange(kind, { enabled: next })}
                          aria-label={t(SEGMENT_LABEL_KEY[kind])}
                          size="sm"
                        />
                      </div>

                      {/* Surcharge de comportement : « Hériter » convient dans
                          l'immense majorité des cas, d'où l'affichage discret. */}
                      {type.enabled && (
                        <div className="flex gap-1 px-2.5 pb-2.5">
                          {OVERRIDES.map((override) => (
                            <button
                              key={override}
                              type="button"
                              aria-pressed={type.mode === override}
                              onClick={() => onSegmentTypeChange(kind, { mode: override })}
                              className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                                type.mode === override
                                  ? 'bg-red-600/80 text-white'
                                  : 'bg-white/5 text-gray-300 hover:bg-white/10'
                              }`}
                            >
                              {t(OVERRIDE_LABEL_KEY[override])}
                            </button>
                          ))}
                        </div>
                      )}

                      <AnimatePresence initial={false}>
                        {isEditingColor && (
                          <motion.div
                            key="color"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.18 }}
                            className="overflow-hidden"
                          >
                            <div className="space-y-2 border-t border-white/10 px-2.5 py-3">
                              <div className="flex flex-wrap gap-2">
                                {SEGMENT_COLOR_PRESETS.map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    aria-label={preset}
                                    aria-pressed={color === preset}
                                    onClick={() => onSegmentColorChange(kind, preset)}
                                    className={`h-7 w-7 rounded-full border-2 transition-transform active:scale-90 ${
                                      color === preset ? 'border-white' : 'border-white/20 hover:border-white/50'
                                    }`}
                                    style={{ backgroundColor: preset }}
                                  />
                                ))}
                              </div>
                              <BgColorPickerPanel
                                committedHex={color}
                                hint={t('watch.segmentColorHint')}
                                onCommit={(hex) => onSegmentColorChange(kind, hex)}
                                layout="column"
                              />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ============================================================== */}
            {/* Sources                                                        */}
            {/* ============================================================== */}
            <div className={CARD}>
              <Heading title={t('watch.skipSources')} description={t('watch.skipSourcesDesc')} />

              <SortableList
                items={orderedProviders}
                onReorder={(order) => onProviderReorder(order as ProviderId[])}
                renderItem={(id) => {
                  const providerId = id as ProviderId;
                  const info = providersById.get(providerId);
                  const isEnabled = enabledProviders.has(providerId);
                  // Le serveur est seul juge de la disponibilité : une source
                  // sans clé d'API ne peut pas être activée d'ici.
                  const unavailable = info ? !info.configured : false;
                  const status = unavailable ? 'unconfigured' : providerStatus[providerId];
                  const detail = providerDetail[providerId];

                  return (
                    <div
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                        isEnabled && !unavailable
                          ? 'border-white/10 bg-white/5'
                          : 'border-transparent bg-white/[0.02]'
                      }`}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={`truncate text-sm ${isEnabled && !unavailable ? 'text-white' : 'text-gray-400'}`}
                        >
                          {info?.label || FALLBACK_PROVIDER_LABEL[providerId]}
                        </span>
                        {status && (
                          <span
                            title={detail || undefined}
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                              PROVIDER_STATUS_CLASS[status] || 'text-gray-400 bg-white/5'
                            }`}
                          >
                            {t(PROVIDER_STATUS_LABEL_KEY[status] || 'watch.providerStatusEmpty')}
                          </span>
                        )}
                      </span>
                      <Switch
                        checked={isEnabled && !unavailable}
                        disabled={unavailable}
                        onCheckedChange={(next) => onProviderToggle(providerId, next)}
                        aria-label={info?.label || FALLBACK_PROVIDER_LABEL[providerId]}
                        size="sm"
                      />
                    </div>
                  );
                }}
              />

              <button
                type="button"
                onClick={() => onSettingsChange({ providerOrder: [...DEFAULT_SKIP_SETTINGS.providerOrder] })}
                className="text-xs text-gray-400 transition-colors hover:text-white"
              >
                {t('watch.skipSourcesResetOrder')}
              </button>
            </div>

            {/* ============================================================== */}
            {/* Réglages avancés                                                */}
            {/* ============================================================== */}
            <div className={CARD}>
              <button
                type="button"
                onClick={() => setShowAdvanced((value) => !value)}
                aria-expanded={showAdvanced}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <Heading title={t('watch.skipAdvanced')} description={t('watch.skipAdvancedDesc')} />
                <span className="shrink-0 text-gray-400">
                  {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </button>

              <AnimatePresence initial={false}>
                {showAdvanced && (
                  <motion.div
                    key="advanced"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-4 overflow-hidden border-t border-white/10 pt-3"
                  >
                    <RangeRow
                      title={t('watch.minSources')}
                      description={t('watch.minSourcesDesc')}
                      valueLabel={t('watch.minSourcesValue', { count: settings.minSources, total: PROVIDER_IDS.length })}
                      min={1}
                      max={PROVIDER_IDS.length}
                      step={1}
                      value={settings.minSources}
                      onChange={(minSources) => onSettingsChange({ minSources })}
                    />

                    <RangeRow
                      title={t('watch.minConfidence')}
                      description={t('watch.minConfidenceDesc')}
                      valueLabel={`${Math.round(settings.minConfidence * 100)} %`}
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(settings.minConfidence * 100)}
                      onChange={(percent) => onSettingsChange({ minConfidence: percent / 100 })}
                    />

                    <RangeRow
                      title={t('watch.promptDelay')}
                      description={t('watch.promptDelayDesc')}
                      valueLabel={
                        settings.promptDelay === 0
                          ? t('watch.promptDelayNone')
                          : t('watch.secondsValue', { sec: settings.promptDelay })
                      }
                      min={0}
                      max={PROMPT_DELAY_MAX}
                      step={0.5}
                      value={settings.promptDelay}
                      onChange={(promptDelay) => onSettingsChange({ promptDelay })}
                    />

                    <RangeRow
                      title={t('watch.endOffset')}
                      description={t('watch.endOffsetDesc')}
                      valueLabel={
                        settings.endOffset === 0
                          ? t('watch.endOffsetNone')
                          : `${settings.endOffset > 0 ? '+' : ''}${t('watch.secondsValue', { sec: settings.endOffset })}`
                      }
                      min={END_OFFSET_MIN}
                      max={END_OFFSET_MAX}
                      step={0.5}
                      value={settings.endOffset}
                      onChange={(endOffset) => onSettingsChange({ endOffset })}
                    />

                    <div className="space-y-3 border-t border-white/10 pt-3">
                      <SwitchRow
                        title={t('watch.showMarkers')}
                        description={t('watch.showMarkersDesc')}
                        checked={settings.showMarkers}
                        onChange={(showMarkers) => onSettingsChange({ showMarkers })}
                      />
                      <SwitchRow
                        title={t('watch.deferLoading')}
                        description={t('watch.deferLoadingDesc')}
                        checked={settings.deferLoading}
                        onChange={(deferLoading) => onSettingsChange({ deferLoading })}
                      />
                    </div>

                    {/* Propositions de la communauté : ce qu'on en affiche, et
                        si on les suit avant qu'elles soient validées. */}
                    <div className="space-y-3 border-t border-white/10 pt-3">
                      <SwitchRow
                        title={t('watch.showCommunityProposals')}
                        description={t('watch.showCommunityProposalsDesc')}
                        checked={settings.showCommunityProposals}
                        onChange={(showCommunityProposals) => onSettingsChange({ showCommunityProposals })}
                      />
                      <SwitchRow
                        title={t('watch.trustPendingProposals')}
                        description={t('watch.trustPendingProposalsDesc')}
                        checked={settings.trustPendingProposals}
                        onChange={(trustPendingProposals) => onSettingsChange({ trustPendingProposals })}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={onReset}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-gray-200 transition-colors hover:bg-white/10"
                    >
                      <RotateCcw size={14} />
                      {t('watch.skipReset')}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ============================================================== */}
            {/* Contribuer                                                     */}
            {/* ============================================================== */}
            {onOpenStudio && (
              <div className={CARD}>
                <Heading title={t('watch.studioEntryTitle')} description={t('watch.studioEntryDesc')} />
                <button
                  type="button"
                  onClick={onOpenStudio}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10"
                >
                  <Scissors size={15} />
                  {t('watch.studioEntryAction')}
                </button>
                {communityCount > 0 && (
                  <p className="text-center text-[11px] text-gray-500">
                    {t('watch.studioEntryCount', { count: communityCount })}
                  </p>
                )}
              </div>
            )}

            <p className="px-1 text-[11px] leading-relaxed text-gray-500">
              {t('watch.skipSegmentsSource')}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default memo(SkipSegmentsPanel);
