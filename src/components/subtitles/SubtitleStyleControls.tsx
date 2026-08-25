import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BgColorPickerPanel } from '@/components/Settings/BgColorPickerPanel';
import { SubtitlePreview } from '@/components/subtitles/SubtitlePreview';
import {
  DEFAULT_SUBTITLE_PREFERENCES,
  parseSubtitlePixelInput,
  SUBTITLE_FONT_FAMILIES,
  type SubtitleFontFamily,
  type SubtitlePreferencePatch,
  type SubtitlePreferences,
} from '@/utils/subtitlePreferences';

export interface SubtitleStyleControlsProps {
  preferences: SubtitlePreferences;
  onChange: (patch: SubtitlePreferencePatch) => void;
  onPreviewChange?: (patch: SubtitlePreferencePatch) => void;
  onCommitPreview?: () => void;
  onReset: () => void;
  density?: 'full' | 'compact';
  showGlobalHeader?: boolean;
  showPreview?: boolean;
}

interface SmoothRangeProps {
  label: string;
  min: number;
  max: number;
  keyboardStep: number;
  value: number;
  outputRef?: { current: HTMLElement | null };
  formatValue?: (value: number) => string;
  animateExternalValue?: boolean;
  disabled?: boolean;
  onPreview: (value: number) => void;
  onCommit: () => void;
}

interface SmoothRangeHandle {
  animateTo: (value: number) => void;
}

const SmoothRange = React.forwardRef<SmoothRangeHandle, SmoothRangeProps>(({
  label,
  min,
  max,
  keyboardStep,
  value,
  outputRef,
  formatValue = String,
  animateExternalValue = true,
  disabled = false,
  onPreview,
  onCommit,
}, forwardedRef) => {
  const sliderRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentValueRef = useRef(value);
  const pendingClientXRef = useRef<number | null>(null);
  const sliderBoundsRef = useRef({ left: 0, width: 1 });
  const frameRef = useRef<number | null>(null);
  const externalAnimationFrameRef = useRef<number | null>(null);
  const externalTargetValueRef = useRef(value);
  const externalAnimationTimestampRef = useRef<number | null>(null);
  const interactingRef = useRef(false);

  const applyVisualValue = useCallback((next: number) => {
    const normalized = clampValue(next, min, max);
    const progress = max === min ? 0 : ((normalized - min) / (max - min)) * 100;
    currentValueRef.current = normalized;
    sliderRef.current?.setAttribute('aria-valuenow', normalized.toFixed(2));
    sliderRef.current?.setAttribute('aria-valuetext', formatValue(normalized));
    if (outputRef?.current instanceof HTMLInputElement) {
      outputRef.current.value = formatValue(normalized);
      outputRef.current.setAttribute('aria-valuenow', normalized.toFixed(2));
    } else if (outputRef?.current) {
      outputRef.current.textContent = formatValue(normalized);
    }
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${progress / 100})`;
    if (thumbRef.current) thumbRef.current.style.transform = `translate3d(${progress}%, 0, 0)`;
  }, [formatValue, max, min, outputRef]);

  const animateTo = useCallback((nextValue: number) => {
    const target = clampValue(nextValue, min, max);
    externalTargetValueRef.current = target;
    if (!animateExternalValue || Math.abs(target - currentValueRef.current) < 0.01) {
      if (externalAnimationFrameRef.current !== null) window.cancelAnimationFrame(externalAnimationFrameRef.current);
      externalAnimationFrameRef.current = null;
      externalAnimationTimestampRef.current = null;
      applyVisualValue(target);
      return;
    }
    if (externalAnimationFrameRef.current !== null) return;

    const animate = (timestamp: number) => {
      const previousTimestamp = externalAnimationTimestampRef.current;
      const elapsedMs = previousTimestamp === null
        ? 1000 / 60
        : Math.min(34, Math.max(0, timestamp - previousTimestamp));
      externalAnimationTimestampRef.current = timestamp;
      const liveTarget = externalTargetValueRef.current;
      const smoothing = 1 - Math.exp(-elapsedMs / 72);
      const next = currentValueRef.current + (liveTarget - currentValueRef.current) * smoothing;

      if (Math.abs(liveTarget - next) < 0.01) {
        applyVisualValue(liveTarget);
        externalAnimationFrameRef.current = null;
        externalAnimationTimestampRef.current = null;
        return;
      }

      applyVisualValue(next);
      externalAnimationFrameRef.current = window.requestAnimationFrame(animate);
    };
    externalAnimationTimestampRef.current = null;
    externalAnimationFrameRef.current = window.requestAnimationFrame(animate);
  }, [animateExternalValue, applyVisualValue, max, min]);

  useImperativeHandle(forwardedRef, () => ({ animateTo }), [animateTo]);

  useEffect(() => {
    if (!interactingRef.current) animateTo(value);
  }, [animateTo, value]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (externalAnimationFrameRef.current !== null) window.cancelAnimationFrame(externalAnimationFrameRef.current);
  }, []);

  const applyPendingPoint = useCallback(() => {
    frameRef.current = null;
    const clientX = pendingClientXRef.current;
    if (clientX === null) return;
    const { left, width } = sliderBoundsRef.current;
    const ratio = clampValue((clientX - left) / width, 0, 1);
    const next = min + ratio * (max - min);
    applyVisualValue(next);
    onPreview(next);
  }, [applyVisualValue, max, min, onPreview]);

  const schedulePoint = useCallback((clientX: number) => {
    pendingClientXRef.current = clientX;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(applyPendingPoint);
  }, [applyPendingPoint]);

  const flushPoint = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    applyPendingPoint();
  }, [applyPendingPoint]);

  const finishInteraction = useCallback((event: React.PointerEvent<HTMLDivElement>, applyFinalPoint = true) => {
    if (!interactingRef.current) return;
    if (applyFinalPoint) schedulePoint(event.clientX);
    flushPoint();
    interactingRef.current = false;
    sliderRef.current?.removeAttribute('data-dragging');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit();
  }, [flushPoint, onCommit, schedulePoint]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next = currentValueRef.current;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= keyboardStep;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += keyboardStep;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    applyVisualValue(next);
    onPreview(currentValueRef.current);
    onCommit();
  }, [applyVisualValue, disabled, keyboardStep, max, min, onCommit, onPreview]);

  const initialProgress = max === min ? 0 : ((clampValue(value, min, max) - min) / (max - min)) * 100;

  return (
    <div
      ref={sliderRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatValue(value)}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        if (externalAnimationFrameRef.current !== null) {
          window.cancelAnimationFrame(externalAnimationFrameRef.current);
          externalAnimationFrameRef.current = null;
        }
        externalAnimationTimestampRef.current = null;
        externalTargetValueRef.current = currentValueRef.current;
        const rect = event.currentTarget.getBoundingClientRect();
        sliderBoundsRef.current = { left: rect.left, width: Math.max(rect.width, 1) };
        interactingRef.current = true;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute('data-dragging', 'true');
        schedulePoint(event.clientX);
      }}
      onPointerMove={(event) => interactingRef.current && schedulePoint(event.clientX)}
      onPointerUp={(event) => finishInteraction(event)}
      onPointerCancel={(event) => finishInteraction(event, false)}
      onKeyDown={handleKeyDown}
      className={`group relative flex h-11 w-full touch-none items-center outline-none focus-visible:ring-2 focus-visible:ring-red-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
    >
      <div className="pointer-events-none relative h-1.5 w-full overflow-hidden rounded-full bg-white/15">
        <div
          ref={fillRef}
          className="absolute inset-0 origin-left rounded-full bg-red-600 will-change-transform"
          style={{ transform: `scaleX(${initialProgress / 100})` }}
        />
      </div>
      <div
        ref={thumbRef}
        className="pointer-events-none absolute inset-x-0 top-1/2 h-0 will-change-transform"
        style={{ transform: `translate3d(${initialProgress}%, 0, 0)` }}
      >
        <div className="absolute left-0 top-0 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-600 shadow-lg shadow-black/40 transition-[transform,box-shadow] duration-150 group-hover:scale-125 group-data-[dragging=true]:scale-[1.4] group-data-[dragging=true]:shadow-red-500/30" />
      </div>
    </div>
  );
});
SmoothRange.displayName = 'SmoothRange';

interface EditablePixelValueProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

const EditablePixelValue = React.forwardRef<HTMLInputElement, EditablePixelValueProps>(({
  label,
  value,
  min,
  max,
  step,
  decimals = 0,
  disabled = false,
  onCommit,
}, forwardedRef) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const startValueRef = useRef(value);
  const dirtyRef = useRef(false);
  const cancelledRef = useRef(false);
  const formatDisplayValue = useCallback(
    (next: number) => `${Number(next.toFixed(decimals))} px`,
    [decimals],
  );

  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input) return;
    input.value = formatDisplayValue(value);
    input.setAttribute('aria-valuenow', value.toFixed(2));
  }, [formatDisplayValue, value]);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      role="spinbutton"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      disabled={disabled}
      defaultValue={formatDisplayValue(value)}
      onFocus={(event) => {
        startValueRef.current = parseSubtitlePixelInput(event.currentTarget.value, min, max, step) ?? value;
        dirtyRef.current = false;
        cancelledRef.current = false;
        event.currentTarget.value = String(Number(startValueRef.current.toFixed(decimals)));
        event.currentTarget.select();
      }}
      onInput={() => { dirtyRef.current = true; }}
      onBlur={(event) => {
        const next = parseSubtitlePixelInput(event.currentTarget.value, min, max, step);
        const shouldCommit = dirtyRef.current && !cancelledRef.current && next !== null;
        const displayedValue = shouldCommit ? next : startValueRef.current;
        event.currentTarget.value = formatDisplayValue(displayedValue);
        event.currentTarget.setAttribute('aria-valuenow', displayedValue.toFixed(2));
        dirtyRef.current = false;
        cancelledRef.current = false;
        if (shouldCommit) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelledRef.current = true;
          event.currentTarget.blur();
        }
      }}
      className="w-[5.5rem] rounded-md border border-transparent bg-transparent px-1.5 py-1 text-right text-sm font-medium tabular-nums text-white outline-none transition-colors hover:border-white/10 hover:bg-white/5 focus:border-red-500/50 focus:bg-black/30 focus:ring-2 focus:ring-red-500/20 disabled:cursor-default disabled:opacity-50"
    />
  );
});
EditablePixelValue.displayName = 'EditablePixelValue';

const AutoStatus: React.FC<{ active: boolean; label: string }> = ({ active, label }) => (
  <span
    aria-hidden={!active}
    className={`rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200 transition-[transform,opacity] duration-200 ${active ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'}`}
  >
    {label}
  </span>
);

const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const EDGE_OPTIONS = ['shadow', 'outline', 'none'] as const;
const WEIGHT_OPTIONS = [
  { value: 400, labelKey: 'settings.subtitles.weightNormal' },
  { value: 700, labelKey: 'settings.subtitles.weightBold' },
] as const;
const FONT_OPTIONS: ReadonlyArray<{ value: SubtitleFontFamily; labelKey: string }> = [
  { value: 'standard', labelKey: 'settings.subtitles.fontStandard' },
  { value: 'atkinson', labelKey: 'settings.subtitles.fontAtkinson' },
  { value: 'lexend', labelKey: 'settings.subtitles.fontLexend' },
  { value: 'opendyslexic', labelKey: 'settings.subtitles.fontOpenDyslexic' },
  { value: 'arial', labelKey: 'settings.subtitles.fontArial' },
  { value: 'verdana', labelKey: 'settings.subtitles.fontVerdana' },
  { value: 'trebuchet', labelKey: 'settings.subtitles.fontTrebuchet' },
  { value: 'tahoma', labelKey: 'settings.subtitles.fontTahoma' },
  { value: 'serif', labelKey: 'settings.subtitles.fontSerif' },
  { value: 'monospace', labelKey: 'settings.subtitles.fontMonospace' },
];
const COLOR_OPTIONS = [
  { color: '#ffffff', labelKey: 'settings.subtitles.colorWhite' },
  { color: '#fcd34d', labelKey: 'settings.subtitles.colorYellow' },
  { color: '#3b82f6', labelKey: 'settings.subtitles.colorBlue' },
  { color: '#06b6d4', labelKey: 'settings.subtitles.colorCyan' },
  { color: '#22c55e', labelKey: 'settings.subtitles.colorGreen' },
  { color: '#ef4444', labelKey: 'settings.subtitles.colorRed' },
  { color: '#d946ef', labelKey: 'settings.subtitles.colorMagenta' },
  { color: '#000000', labelKey: 'settings.subtitles.colorBlack' },
] as const;

const expandShortHexColor = (color: string) => {
  const match = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  return match ? `#${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}` : color;
};

const formatDelay = (delayInSeconds: number) => {
  const sign = delayInSeconds >= 0 ? '+' : '';
  return `${sign}${Number(delayInSeconds.toFixed(1))}s`;
};

export const SubtitleStyleControls: React.FC<SubtitleStyleControlsProps> = ({
  preferences,
  onChange,
  onPreviewChange,
  onCommitPreview,
  onReset,
  density = 'full',
  showGlobalHeader = false,
  showPreview = true,
}) => {
  const { t } = useTranslation();
  const [resetAnnouncement, setResetAnnouncement] = useState(0);
  const commitTimerRef = useRef<number | null>(null);
  const buttonPreviewFrameRef = useRef<number | null>(null);
  const pendingButtonPatchRef = useRef<SubtitlePreferencePatch | null>(null);
  const workingPreferencesRef = useRef(preferences);
  const fontSizeRangeRef = useRef<SmoothRangeHandle>(null);
  const heightRangeRef = useRef<SmoothRangeHandle>(null);
  const fontSizeOutputRef = useRef<HTMLInputElement>(null);
  const heightOutputRef = useRef<HTMLInputElement>(null);
  const edgeSizeOutputRef = useRef<HTMLInputElement>(null);
  const delayOutputRef = useRef<HTMLSpanElement>(null);
  const backgroundOutputRef = useRef<HTMLSpanElement>(null);
  const weightOutputRef = useRef<HTMLSpanElement>(null);
  const compact = density === 'compact';
  const commitPreview = onCommitPreview ?? (() => undefined);
  const cardClass = compact
    ? 'space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3'
    : 'space-y-4 rounded-2xl border border-white/10 bg-gray-900/35 p-5';
  const iconButton = 'inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white transition-[transform,background-color,border-color] duration-150 hover:bg-white/10 active:scale-95 disabled:opacity-40';
  const choiceButton = (selected: boolean) => `min-h-11 rounded-lg border px-3 py-2 text-sm transition-[transform,color,background-color,border-color] duration-150 active:scale-[.98] ${selected ? 'border-red-500/50 bg-red-600/20 text-white' : 'border-white/10 bg-white/5 text-white hover:bg-white/10'}`;
  const heading = (title: string, description: string) => (
    <>
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="text-xs leading-relaxed text-gray-400">{description}</p>
    </>
  );

  useEffect(() => {
    workingPreferencesRef.current = preferences;
  }, [preferences]);

  const cancelQueuedButtonPatch = useCallback(() => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    if (buttonPreviewFrameRef.current !== null) window.cancelAnimationFrame(buttonPreviewFrameRef.current);
    commitTimerRef.current = null;
    buttonPreviewFrameRef.current = null;
    pendingButtonPatchRef.current = null;
  }, []);

  useEffect(() => cancelQueuedButtonPatch, [cancelQueuedButtonPatch]);

  const previewChange = useCallback((patch: SubtitlePreferencePatch) => {
    workingPreferencesRef.current = { ...workingPreferencesRef.current, ...patch };
    (onPreviewChange ?? onChange)(patch);
  }, [onChange, onPreviewChange]);

  const commitPixelPatch = useCallback((patch: SubtitlePreferencePatch) => {
    workingPreferencesRef.current = { ...workingPreferencesRef.current, ...patch };
    onChange(patch);
  }, [onChange]);

  const flushButtonPreview = useCallback(() => {
    buttonPreviewFrameRef.current = null;
    const patch = pendingButtonPatchRef.current;
    if (!patch) return;
    pendingButtonPatchRef.current = null;
    previewChange(patch);
  }, [previewChange]);

  const handleReset = () => {
    cancelQueuedButtonPatch();
    onReset();
    setResetAnnouncement((count) => count + 1);
  };

  const queueButtonPatch = (
    patch: SubtitlePreferencePatch,
    rangeRef?: React.RefObject<SmoothRangeHandle>,
    next?: number,
  ) => {
    workingPreferencesRef.current = { ...workingPreferencesRef.current, ...patch };
    if (rangeRef && next !== undefined) rangeRef.current?.animateTo(next);
    if (!onPreviewChange || !onCommitPreview) {
      onChange(patch);
      return;
    }
    pendingButtonPatchRef.current = { ...pendingButtonPatchRef.current, ...patch };
    if (buttonPreviewFrameRef.current === null) {
      buttonPreviewFrameRef.current = window.requestAnimationFrame(flushButtonPreview);
    }
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      if (buttonPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(buttonPreviewFrameRef.current);
        flushButtonPreview();
      }
      onCommitPreview();
    }, 160);
  };

  const adjustFontSize = (delta: number) => {
    const current = workingPreferencesRef.current.fontSizePx;
    const next = clampValue(current + delta, 8, 48);
    queueButtonPatch({ fontSizeMode: 'manual', fontSizePx: next }, fontSizeRangeRef, next);
  };

  const adjustHeight = (delta: number) => {
    const current = workingPreferencesRef.current.bottomOffsetPx;
    const next = clampValue(current + delta, 25, 900);
    queueButtonPatch({ bottomOffsetPx: next }, heightRangeRef, next);
  };

  const adjustDelay = (delta: number) => {
    const current = workingPreferencesRef.current.delay;
    const next = clampValue(current + delta, -10, 10);
    if (delayOutputRef.current) delayOutputRef.current.textContent = formatDelay(next);
    queueButtonPatch({ delay: next });
  };

  const resetDelay = () => {
    const next = DEFAULT_SUBTITLE_PREFERENCES.delay;
    if (delayOutputRef.current) delayOutputRef.current.textContent = formatDelay(next);
    queueButtonPatch({ delay: next });
  };

  const resetFontSize = () => {
    const next = DEFAULT_SUBTITLE_PREFERENCES.fontSizePx;
    queueButtonPatch({ fontSizeMode: 'auto', fontSizePx: next }, fontSizeRangeRef, next);
  };

  const resetHeight = () => {
    const next = DEFAULT_SUBTITLE_PREFERENCES.bottomOffsetPx;
    queueButtonPatch({ bottomOffsetPx: next }, heightRangeRef, next);
  };

  const commitColor = useCallback((color: string) => {
    onChange({ color: expandShortHexColor(color) });
  }, [onChange]);
  const previewColor = useCallback((color: string) => {
    previewChange({ color: expandShortHexColor(color) });
  }, [previewChange]);
  const commitEdgeColor = useCallback((edgeColor: string) => {
    onChange({ edgeColor: expandShortHexColor(edgeColor) });
  }, [onChange]);
  const previewEdgeColor = useCallback((edgeColor: string) => {
    previewChange({ edgeColor: expandShortHexColor(edgeColor) });
  }, [previewChange]);

  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      <div className={showGlobalHeader ? 'flex flex-wrap items-start justify-between gap-3' : 'flex justify-end'}>
        {showGlobalHeader && <p className="max-w-2xl text-sm text-gray-400">{t('settings.subtitles.description')}</p>}
        <button type="button" onClick={handleReset} className="min-h-11 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-white/5">
          <RotateCcw className="mr-2 inline h-4 w-4" />
          {t('common.reset')}
        </button>
        {resetAnnouncement > 0 && <p key={resetAnnouncement} role="status" aria-live="polite" className="sr-only">{t('settings.subtitles.resetAnnounced')}</p>}
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="décalage,temporel,synchronisation,sous-titres">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-white">{t('watch.timeOffset')}</h3>
            <p className="mt-1 text-sm text-gray-400">
              {t('watch.currentLabel')} <span ref={delayOutputRef} className="font-medium tabular-nums text-white">{formatDelay(preferences.delay)}</span>
            </p>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
            onClick={resetDelay}
          >
            {t('watch.resetLabel')}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            { delta: -3, label: t('watch.subtitleDelayBackLong') },
            { delta: -0.5, label: t('watch.subtitleDelayBackShort') },
            { delta: 0.5, label: t('watch.subtitleDelayForwardShort') },
            { delta: 3, label: t('watch.subtitleDelayForwardLong') },
          ] as const).map(({ delta, label }) => (
            <button
              key={delta}
              type="button"
              className="min-h-11 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
              disabled={(delta < 0 && preferences.delay <= -10) || (delta > 0 && preferences.delay >= 10)}
              onClick={() => adjustDelay(delta)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {showPreview && (
        <div className={cardClass} data-settings-search-title data-settings-search-keywords="aperçu,preview,position" data-position-x={preferences.positionXPercent}>
          <h3 className="font-semibold text-white">{t('settings.subtitles.preview')}</h3>
          <SubtitlePreview preferences={preferences} onChange={onChange} compact={compact} />
        </div>
      )}

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="taille,police,auto">
        <div className="flex items-start justify-between gap-3">
          <div>{heading(t('settings.subtitles.textSize'), t('settings.subtitles.textSizeDescription'))}</div>
          <div className="flex shrink-0 items-center gap-2">
            <EditablePixelValue
              ref={fontSizeOutputRef}
              label={t('settings.subtitles.textSize')}
              value={preferences.fontSizePx}
              min={8}
              max={48}
              step={1}
              onCommit={(fontSizePx) => commitPixelPatch({ fontSizeMode: 'manual', fontSizePx })}
            />
            <AutoStatus active={preferences.fontSizeMode === 'auto'} label={t('settings.subtitles.auto')} />
          </div>
        </div>
        <SmoothRange
          ref={fontSizeRangeRef}
          label={t('settings.subtitles.textSize')}
          min={8}
          max={48}
          keyboardStep={1}
          value={preferences.fontSizePx}
          outputRef={fontSizeOutputRef}
          formatValue={(value) => `${Number(value.toFixed(1))} px`}
          onPreview={(fontSizePx) => previewChange({ fontSizeMode: 'manual', fontSizePx })}
          onCommit={commitPreview}
        />
        <div className="flex items-center gap-2">
          <button type="button" className={iconButton} aria-label={`${t('settings.subtitles.textSize')} −`} disabled={preferences.fontSizePx <= 8} onClick={() => adjustFontSize(-1)}><Minus className="h-4 w-4" /></button>
          <button type="button" className={iconButton} aria-label={`${t('settings.subtitles.textSize')} +`} disabled={preferences.fontSizePx >= 48} onClick={() => adjustFontSize(1)}><Plus className="h-4 w-4" /></button>
          <button type="button" className="ml-auto min-h-11 px-2 text-xs font-medium text-red-300 transition-colors hover:text-red-200" onClick={resetFontSize}>{t('settings.subtitles.backToAuto')}</button>
        </div>
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="hauteur,position,bas,auto">
        <div className="flex items-start justify-between gap-3">
          <div>{heading(t('settings.subtitles.height'), t('settings.subtitles.heightDescription'))}</div>
          <div className="flex shrink-0 items-center gap-2">
            <EditablePixelValue
              ref={heightOutputRef}
              label={t('settings.subtitles.height')}
              value={preferences.bottomOffsetPx}
              min={25}
              max={900}
              step={1}
              onCommit={(bottomOffsetPx) => commitPixelPatch({ bottomOffsetPx })}
            />
            <AutoStatus active={preferences.bottomOffsetPx === DEFAULT_SUBTITLE_PREFERENCES.bottomOffsetPx} label={t('settings.subtitles.auto')} />
          </div>
        </div>
        <SmoothRange
          ref={heightRangeRef}
          label={t('settings.subtitles.height')}
          min={25}
          max={900}
          keyboardStep={5}
          value={preferences.bottomOffsetPx}
          outputRef={heightOutputRef}
          formatValue={(value) => `${Math.round(value)} px`}
          onPreview={(bottomOffsetPx) => previewChange({ bottomOffsetPx })}
          onCommit={commitPreview}
        />
        <div className="flex items-center gap-2">
          <button type="button" className={iconButton} aria-label={`${t('settings.subtitles.height')} −`} disabled={preferences.bottomOffsetPx <= 25} onClick={() => adjustHeight(-5)}><Minus className="h-4 w-4" /></button>
          <button type="button" className={iconButton} aria-label={`${t('settings.subtitles.height')} +`} disabled={preferences.bottomOffsetPx >= 900} onClick={() => adjustHeight(5)}><Plus className="h-4 w-4" /></button>
          <button type="button" className="ml-auto min-h-11 px-2 text-xs font-medium text-red-300 transition-colors hover:text-red-200" onClick={resetHeight}>{t('settings.subtitles.backToAuto')}</button>
        </div>
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="couleur,blanc,jaune,bleu,cyan,vert,rouge,magenta,noir">
        {heading(t('settings.subtitles.textColor'), t('settings.subtitles.textColorDescription'))}
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map(({ color, labelKey }) => (
            <button key={color} type="button" aria-label={t(labelKey)} aria-pressed={preferences.color === color} onClick={() => onChange({ color })} className={choiceButton(preferences.color === color)}>
              <span className="block h-6 w-6 rounded-full border border-white/25 shadow-sm" style={{ backgroundColor: color }} />
              <span className="sr-only">{t(labelKey)}</span>
            </button>
          ))}
        </div>
        <BgColorPickerPanel
          committedHex={preferences.color}
          inputLabel={t('settings.subtitles.textColor')}
          hint={t('watch.customColorHint')}
          onPreview={previewColor}
          onCommit={commitColor}
          layout="column"
        />
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="contour,ombre">
        {heading(t('settings.subtitles.edge'), t('settings.subtitles.edgeDescription'))}
        <div className="flex flex-wrap gap-2">
          {EDGE_OPTIONS.map((edgeStyle) => <button key={edgeStyle} type="button" aria-pressed={preferences.edgeStyle === edgeStyle} onClick={() => onChange({ edgeStyle })} className={choiceButton(preferences.edgeStyle === edgeStyle)}>{t(`settings.subtitles.edge${edgeStyle[0].toUpperCase()}${edgeStyle.slice(1)}`)}</button>)}
        </div>
        <div
          aria-hidden={preferences.edgeStyle === 'none'}
          inert={preferences.edgeStyle === 'none'}
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${preferences.edgeStyle !== 'none' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-4 border-t border-white/10 pt-4">
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-white">{t('settings.subtitles.edgeColor')}</h4>
              <div className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map(({ color, labelKey }) => (
                  <button key={color} type="button" aria-label={t(labelKey)} aria-pressed={preferences.edgeColor === color} onClick={() => onChange({ edgeColor: color })} className={choiceButton(preferences.edgeColor === color)}>
                    <span className="block h-6 w-6 rounded-full border border-white/25 shadow-sm" style={{ backgroundColor: color }} />
                    <span className="sr-only">{t(labelKey)}</span>
                  </button>
                ))}
              </div>
              <BgColorPickerPanel
                committedHex={preferences.edgeColor}
                inputLabel={t('settings.subtitles.edgeColor')}
                hint={t('settings.subtitles.edgeColorHint')}
                onPreview={previewEdgeColor}
                onCommit={commitEdgeColor}
                layout="column"
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-medium text-white">{t('settings.subtitles.edgeSize')}</h4>
                <div className="flex shrink-0 items-center gap-2">
                  <EditablePixelValue
                    ref={edgeSizeOutputRef}
                    label={t('settings.subtitles.edgeSize')}
                    value={preferences.edgeSizePx}
                    min={0.5}
                    max={6}
                    step={0.1}
                    decimals={1}
                    disabled={preferences.edgeStyle === 'none'}
                    onCommit={(edgeSizePx) => commitPixelPatch({ edgeSizePx })}
                  />
                  <AutoStatus active={preferences.edgeSizePx === DEFAULT_SUBTITLE_PREFERENCES.edgeSizePx} label={t('settings.subtitles.auto')} />
                </div>
              </div>
              <SmoothRange
                label={t('settings.subtitles.edgeSize')}
                min={0.5}
                max={6}
                keyboardStep={0.5}
                value={preferences.edgeSizePx}
                disabled={preferences.edgeStyle === 'none'}
                outputRef={edgeSizeOutputRef}
                formatValue={(value) => `${Number(value.toFixed(1))} px`}
                onPreview={(edgeSizePx) => previewChange({ edgeSizePx })}
                onCommit={commitPreview}
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  className="min-h-11 px-2 text-xs font-medium text-red-300 transition-colors hover:text-red-200"
                  onClick={() => onChange({ edgeSizePx: DEFAULT_SUBTITLE_PREFERENCES.edgeSizePx })}
                >
                  {t('common.reset')}
                </button>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="fond,bandeau,opacité">
        {heading(t('settings.subtitles.background'), t('settings.subtitles.backgroundDescription'))}
        <div className="flex items-center justify-between gap-3">
          <button type="button" role="switch" aria-checked={preferences.backgroundEnabled} onClick={() => onChange({ backgroundEnabled: !preferences.backgroundEnabled })} className={choiceButton(preferences.backgroundEnabled)}>{preferences.backgroundEnabled ? t('common.enabled') : t('common.disabled')}</button>
          <div aria-hidden={!preferences.backgroundEnabled} className={`flex shrink-0 items-center gap-2 transition-opacity duration-200 ${preferences.backgroundEnabled ? 'opacity-100' : 'opacity-0'}`}>
            <span ref={backgroundOutputRef} className="text-sm font-medium tabular-nums text-white">{Math.round(preferences.backgroundOpacity * 100)}%</span>
            <AutoStatus active={preferences.backgroundEnabled && preferences.backgroundOpacity === DEFAULT_SUBTITLE_PREFERENCES.backgroundOpacity} label={t('settings.subtitles.auto')} />
          </div>
        </div>
        <div
          aria-hidden={!preferences.backgroundEnabled}
          inert={!preferences.backgroundEnabled}
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${preferences.backgroundEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        >
          <div className="min-h-0 overflow-hidden">
            <SmoothRange
              label={t('settings.subtitles.background')}
              min={0}
              max={1}
              keyboardStep={0.05}
              value={preferences.backgroundOpacity}
              disabled={!preferences.backgroundEnabled}
              outputRef={backgroundOutputRef}
              formatValue={(value) => `${Math.round(value * 100)}%`}
              onPreview={(backgroundOpacity) => previewChange({ backgroundOpacity })}
              onCommit={commitPreview}
            />
          </div>
        </div>
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="police,dyslexie,lisibilité,lexend,atkinson,opendyslexic,arial,verdana,trebuchet,tahoma,serif,chasse fixe">
        {heading(t('settings.subtitles.font'), t('settings.subtitles.fontDescription'))}
        <div className="flex flex-wrap gap-2">
          {FONT_OPTIONS.map(({ value, labelKey }) => (
            <button
              key={value}
              type="button"
              aria-pressed={preferences.fontFamily === value}
              onClick={() => onChange({ fontFamily: value })}
              className={choiceButton(preferences.fontFamily === value)}
              style={{ fontFamily: SUBTITLE_FONT_FAMILIES[value] }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className={cardClass} data-settings-search-title data-settings-search-keywords="gras,épaisse">
        {heading(t('settings.subtitles.weight'), t('settings.subtitles.weightDescription'))}
        <div className="flex flex-wrap gap-2">
          {WEIGHT_OPTIONS.map(({ value, labelKey }) => <button key={value} type="button" aria-pressed={preferences.fontWeight === value} onClick={() => onChange({ fontWeight: value })} className={choiceButton(preferences.fontWeight === value)}>{t(labelKey)}</button>)}
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-white">{t('settings.subtitles.weightSize')}</h4>
            <div className="flex shrink-0 items-center gap-2">
              <span ref={weightOutputRef} className="text-sm font-medium tabular-nums text-white">{preferences.fontWeight}</span>
              <AutoStatus active={preferences.fontWeight === DEFAULT_SUBTITLE_PREFERENCES.fontWeight} label={t('settings.subtitles.auto')} />
            </div>
          </div>
          <SmoothRange
            label={t('settings.subtitles.weightSize')}
            min={100}
            max={900}
            keyboardStep={100}
            value={preferences.fontWeight}
            animateExternalValue
            outputRef={weightOutputRef}
            formatValue={(value) => `${Math.round(value)}`}
            onPreview={(fontWeight) => previewChange({ fontWeight: Math.round(fontWeight) })}
            onCommit={commitPreview}
          />
        </div>
      </div>
    </div>
  );
};
