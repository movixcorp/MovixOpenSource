import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Grid3X3, Maximize, Minimize, Play, RotateCcw, Settings, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  calculateSubtitlePlacement,
  getDirectionalResizeDistance,
  getSubtitleGuideSnap,
  getSubtitleEdgeStyles,
  normalizeSubtitlePreferences,
  preferencesFromDrag,
  scaleSubtitleFontSizeFromPointer,
  SUBTITLE_FONT_FAMILIES,
  SUBTITLE_GUIDE_RATIOS,
  SUBTITLE_STYLE_CHANGED_EVENT,
  SUBTITLE_STYLE_PREVIEW_EVENT,
  type SubtitlePreferencePatch,
  type SubtitlePreferences,
} from '@/utils/subtitlePreferences';

export interface SubtitlePreviewProps {
  preferences: SubtitlePreferences;
  onChange: (patch: SubtitlePreferencePatch) => void;
  compact?: boolean;
}

const SAMPLE_OPTIONS = [
  { lines: 1, key: 'settings.subtitles.previewOneLine' },
  { lines: 2, key: 'settings.subtitles.previewTwoLines' },
  { lines: 3, key: 'settings.subtitles.previewThreeLines' },
] as const;
const GUIDE_POINT_POSITIONS = SUBTITLE_GUIDE_RATIOS;
const GUIDE_LABELS = ['1/4', '1/3', '1/2', '2/3', '3/4'] as const;
const CENTER_GUIDE_INDEX = SUBTITLE_GUIDE_RATIOS.findIndex((ratio) => ratio === 1 / 2);
const SCALE_HANDLES = [
  { key: 'north-west', position: '-left-3.5 -top-3.5', cursor: 'cursor-nwse-resize', x: -1, y: -1 },
  { key: 'north-east', position: '-right-3.5 -top-3.5', cursor: 'cursor-nesw-resize', x: 1, y: -1 },
  { key: 'south-west', position: '-bottom-3.5 -left-3.5', cursor: 'cursor-nesw-resize', x: -1, y: 1 },
  { key: 'south-east', position: '-bottom-3.5 -right-3.5', cursor: 'cursor-nwse-resize', x: 1, y: 1 },
] as const;

const cueTransform = (leftPx: number, bottomPx: number) => (
  `translate3d(${leftPx}px, ${-bottomPx}px, 0) translateX(-50%)`
);
const getStickyGuideSnap = (
  coordinatePx: number,
  extentPx: number,
  thresholdPx: number,
  activeIndex: number | null,
) => {
  if (activeIndex !== null) {
    const ratio = SUBTITLE_GUIDE_RATIOS[activeIndex];
    const positionPx = extentPx * ratio;
    if (Math.abs(coordinatePx - positionPx) <= thresholdPx * 1.7) {
      return { index: activeIndex, ratio, positionPx };
    }
  }
  return getSubtitleGuideSnap(coordinatePx, extentPx, thresholdPx);
};
const POSITION_IDLE_TRANSITION = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
const CUE_IDLE_TRANSITION = 'font-size 160ms ease-out, padding 160ms ease-out';

export const SubtitlePreview: React.FC<SubtitlePreviewProps> = ({ preferences, onChange, compact = false }) => {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const cuePositionRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const scaleAnimationFrameRef = useRef<number | null>(null);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);
  const pendingPatchRef = useRef<SubtitlePreferencePatch | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const stylePreviewActiveRef = useRef(false);
  const livePreferencesRef = useRef(preferences);
  const verticalGuideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const horizontalGuideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const centerBadgeRef = useRef<HTMLDivElement>(null);
  const activeGuideSnapRef = useRef<{ x: number | null; y: number | null }>({ x: null, y: null });
  const activeScaleHandleRef = useRef<HTMLDivElement | null>(null);
  const scaleValueRef = useRef<HTMLSpanElement>(null);
  const scaleStartRef = useRef({
    anchorX: 0,
    anchorY: 0,
    frameLeft: 0,
    frameTop: 0,
    directionX: 1,
    directionY: 1,
    distancePx: 1,
    fontSizePx: preferences.fontSizePx,
    blockWidth: 0,
    blockHeight: 0,
  });
  const pendingScalePointRef = useRef<{ x: number; y: number } | null>(null);
  const pendingFontSizeRef = useRef<number | null>(null);
  const pendingScalePatchRef = useRef<SubtitlePreferencePatch | null>(null);
  const scalingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isScaling, setIsScaling] = useState(false);
  const [sampleLines, setSampleLines] = useState<1 | 2 | 3>(1);
  const [customText, setCustomText] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [guidesVisible, setGuidesVisible] = useState(true);
  const [viewport, setViewport] = useState({ width: 0, height: 0, blockWidth: 0, blockHeight: 0 });

  const sample = customMode
    ? customText || t('settings.subtitles.previewExample')
    : Array.from({ length: sampleLines }, () => t('settings.subtitles.previewExample')).join('\n');
  const previewChoiceButton = (selected: boolean) => (
    `min-h-11 rounded-lg border px-3 py-2 text-xs text-white transition-[transform,background-color,border-color] duration-200 active:scale-[.98] ${selected
      ? 'border-red-500/50 bg-red-600/20'
      : 'border-white/10 bg-white/5 hover:bg-white/10'}`
  );

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const cue = cueRef.current;
    if (!frame || !cue) return;
    const measure = () => {
      if (stylePreviewActiveRef.current) return;
      const frameRect = frame.getBoundingClientRect();
      const cueRect = cue.getBoundingClientRect();
      setViewport((current) => {
        const next = { width: frameRect.width, height: frameRect.height, blockWidth: cueRect.width, blockHeight: cueRect.height };
        return current.width === next.width
          && current.height === next.height
          && current.blockWidth === next.blockWidth
          && current.blockHeight === next.blockHeight
          ? current
          : next;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(cue);
    measure();
    return () => observer.disconnect();
  }, [sample, preferences.fontSizePx, preferences.fontFamily, preferences.fontWeight]);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    if (scaleAnimationFrameRef.current !== null) window.cancelAnimationFrame(scaleAnimationFrameRef.current);
  }, []);

  // Comme dans le lecteur, seuls les sous-titres placés trop bas remontent
  // lorsque les contrôles apparaissent. Leur position choisie reste intacte.
  const previewViewport = useMemo(() => ({
    ...viewport,
    controlsInset: controlsVisible ? 64 : 12,
    minScale: 0.1,
  }), [controlsVisible, viewport]);
  const placement = calculateSubtitlePlacement(preferences, previewViewport);

  useEffect(() => {
    livePreferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const applyPreview = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const cue = cueRef.current;
      const cuePosition = cuePositionRef.current;
      if (!cue || !cuePosition) return;
      const previous = livePreferencesRef.current;
      const next = normalizeSubtitlePreferences(event.detail);
      livePreferencesRef.current = next;
      const geometryChanged = next.fontSizePx !== previous.fontSizePx
        || next.fontFamily !== previous.fontFamily
        || next.fontWeight !== previous.fontWeight
        || next.positionXPercent !== previous.positionXPercent
        || next.bottomOffsetPx !== previous.bottomOffsetPx;

      stylePreviewActiveRef.current = true;
      cue.style.transition = 'none';
      cuePosition.style.transition = 'none';
      if (next.color !== previous.color) cue.style.color = next.color;
      if (next.fontFamily !== previous.fontFamily) cue.style.fontFamily = SUBTITLE_FONT_FAMILIES[next.fontFamily];
      if (next.fontWeight !== previous.fontWeight) cue.style.fontWeight = `${next.fontWeight}`;
      if (next.backgroundEnabled !== previous.backgroundEnabled || next.backgroundOpacity !== previous.backgroundOpacity) {
        cue.style.backgroundColor = next.backgroundEnabled ? `rgba(0,0,0,${next.backgroundOpacity})` : 'transparent';
      }

      const nextPlacement = geometryChanged ? calculateSubtitlePlacement(next, previewViewport) : null;
      if (nextPlacement) {
        cuePosition.style.transform = cueTransform(nextPlacement.leftPx, nextPlacement.bottomPx);
        cue.style.fontSize = `${nextPlacement.fontSizePx}px`;
      }
      if (next.edgeStyle !== previous.edgeStyle
        || next.edgeColor !== previous.edgeColor
        || next.edgeSizePx !== previous.edgeSizePx) {
        const nextEdgeStyles = getSubtitleEdgeStyles(
          next.edgeStyle,
          next.edgeColor,
          next.edgeSizePx,
          nextPlacement?.scale ?? placement.scale,
        );
        cue.style.textShadow = nextEdgeStyles.textShadow;
        cue.style.setProperty('-webkit-text-stroke', nextEdgeStyles.WebkitTextStroke);
        cue.style.paintOrder = nextEdgeStyles.paintOrder ?? '';
      }
    };
    const restoreTransition = (event: Event) => {
      if (event instanceof CustomEvent) livePreferencesRef.current = normalizeSubtitlePreferences(event.detail);
      stylePreviewActiveRef.current = false;
      if (cueRef.current) cueRef.current.style.transition = CUE_IDLE_TRANSITION;
      if (cuePositionRef.current) cuePositionRef.current.style.transition = POSITION_IDLE_TRANSITION;
    };

    window.addEventListener(SUBTITLE_STYLE_PREVIEW_EVENT, applyPreview);
    window.addEventListener(SUBTITLE_STYLE_CHANGED_EVENT, restoreTransition);
    return () => {
      window.removeEventListener(SUBTITLE_STYLE_PREVIEW_EVENT, applyPreview);
      window.removeEventListener(SUBTITLE_STYLE_CHANGED_EVENT, restoreTransition);
    };
  }, [placement.scale, previewViewport]);

  const applyPendingDrag = () => {
    animationFrameRef.current = null;
    const point = pendingPointRef.current;
    const frame = frameRef.current;
    const cue = cueRef.current;
    const cuePosition = cuePositionRef.current;
    if (!point || !frame || !cue || !cuePosition) return;

    const rect = frame.getBoundingClientRect();
    const rawCenterX = point.x - dragOffsetRef.current.x - rect.left;
    const rawCenterY = point.y - dragOffsetRef.current.y - rect.top;
    const snapDistance = Math.max(8, Math.min(14, rect.width * 0.02));
    const xSnap = guidesVisible ? getStickyGuideSnap(rawCenterX, rect.width, snapDistance, activeGuideSnapRef.current.x) : null;
    const ySnap = guidesVisible ? getStickyGuideSnap(rawCenterY, rect.height, snapDistance, activeGuideSnapRef.current.y) : null;
    const centerX = xSnap?.positionPx ?? rawCenterX;
    const centerY = ySnap?.positionPx ?? rawCenterY;
    const patch = preferencesFromDrag(preferences, previewViewport, centerX, centerY);
    const nextPlacement = calculateSubtitlePlacement({ ...preferences, ...patch }, previewViewport);
    pendingPatchRef.current = patch;
    cuePosition.style.transform = cueTransform(nextPlacement.leftPx, nextPlacement.bottomPx);
    cue.setAttribute('aria-valuenow', String(Math.round(patch.positionXPercent)));
    const actualCenterY = rect.height - nextPlacement.bottomPx - previewViewport.blockHeight / 2;
    const activeX = xSnap && Math.abs(nextPlacement.leftPx - xSnap.positionPx) < 1 ? xSnap.index : -1;
    const activeY = ySnap && Math.abs(actualCenterY - ySnap.positionPx) < 1 ? ySnap.index : -1;
    activeGuideSnapRef.current = {
      x: activeX >= 0 ? activeX : null,
      y: activeY >= 0 ? activeY : null,
    };
    verticalGuideRefs.current.forEach((guide, index) => {
      if (!guide) return;
      guide.style.opacity = index === activeX ? '1' : '0.72';
      guide.style.backgroundColor = index === activeX ? '#ef4444' : 'rgba(255,255,255,.82)';
    });
    horizontalGuideRefs.current.forEach((guide, index) => {
      if (!guide) return;
      guide.style.opacity = index === activeY ? '1' : '0.72';
      guide.style.backgroundColor = index === activeY ? '#ef4444' : 'rgba(255,255,255,.82)';
    });
    if (centerBadgeRef.current) {
      centerBadgeRef.current.style.opacity = activeX === CENTER_GUIDE_INDEX && activeY === CENTER_GUIDE_INDEX ? '1' : '0';
    }
  };

  const scheduleDrag = (clientX: number, clientY: number) => {
    pendingPointRef.current = { x: clientX, y: clientY };
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(applyPendingDrag);
  };

  const flushDrag = () => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      applyPendingDrag();
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const cueRect = event.currentTarget.getBoundingClientRect();
    dragOffsetRef.current = {
      x: event.clientX - (cueRect.left + cueRect.width / 2),
      y: event.clientY - (cueRect.top + cueRect.height / 2),
    };
    pendingPatchRef.current = null;
    activeGuideSnapRef.current = { x: null, y: null };
    draggingRef.current = true;
    if (cuePositionRef.current) cuePositionRef.current.style.transition = 'none';
    setIsDragging(true);
    verticalGuideRefs.current.forEach((guide) => {
      if (!guide) return;
      guide.style.opacity = '0.72';
      guide.style.backgroundColor = 'rgba(255,255,255,.82)';
    });
    horizontalGuideRefs.current.forEach((guide) => {
      if (!guide) return;
      guide.style.opacity = '0.72';
      guide.style.backgroundColor = 'rgba(255,255,255,.82)';
    });
    if (centerBadgeRef.current) centerBadgeRef.current.style.opacity = '0';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>, applyFinalPoint = true) => {
    if (!draggingRef.current) return;
    if (applyFinalPoint) scheduleDrag(event.clientX, event.clientY);
    flushDrag();
    draggingRef.current = false;
    if (cuePositionRef.current) cuePositionRef.current.style.transition = POSITION_IDLE_TRANSITION;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pendingPatchRef.current) onChange(pendingPatchRef.current);
    pendingPatchRef.current = null;
    activeGuideSnapRef.current = { x: null, y: null };
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.shiftKey ? 24 : 8;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    onChange(preferencesFromDrag(
      preferences,
      previewViewport,
      placement.leftPx + offset[0],
      viewport.height - placement.bottomPx - viewport.blockHeight / 2 + offset[1],
    ));
  };

  const applyPendingScale = () => {
    scaleAnimationFrameRef.current = null;
    const point = pendingScalePointRef.current;
    const cue = cueRef.current;
    const cuePosition = cuePositionRef.current;
    const frame = frameRef.current;
    if (!point || !cue || !cuePosition || !frame) return;

    const currentDistancePx = getDirectionalResizeDistance(
      point.x,
      point.y,
      scaleStartRef.current.anchorX,
      scaleStartRef.current.anchorY,
      scaleStartRef.current.directionX,
      scaleStartRef.current.directionY,
      scaleStartRef.current.blockWidth,
      scaleStartRef.current.blockHeight,
    );

    const nextFontSizePx = scaleSubtitleFontSizeFromPointer(
      scaleStartRef.current.fontSizePx,
      scaleStartRef.current.distancePx,
      currentDistancePx,
    );
    const scaledFontPlacement = calculateSubtitlePlacement(
      { ...preferences, fontSizeMode: 'manual', fontSizePx: nextFontSizePx },
      previewViewport,
    );
    cue.style.fontSize = `${scaledFontPlacement.fontSizePx}px`;
    const resizedCueRect = cue.getBoundingClientRect();
    const resizedViewport = {
      ...previewViewport,
      blockWidth: resizedCueRect.width,
      blockHeight: resizedCueRect.height,
    };
    const centerX = scaleStartRef.current.anchorX
      + scaleStartRef.current.directionX * resizedCueRect.width / 2
      - scaleStartRef.current.frameLeft;
    const centerY = scaleStartRef.current.anchorY
      + scaleStartRef.current.directionY * resizedCueRect.height / 2
      - scaleStartRef.current.frameTop;
    const positionPatch = preferencesFromDrag(preferences, resizedViewport, centerX, centerY);
    const patch: SubtitlePreferencePatch = { fontSizeMode: 'manual', fontSizePx: nextFontSizePx, ...positionPatch };
    const nextPlacement = calculateSubtitlePlacement(
      { ...preferences, ...patch },
      resizedViewport,
    );
    cuePosition.style.transform = cueTransform(nextPlacement.leftPx, nextPlacement.bottomPx);
    activeScaleHandleRef.current?.setAttribute('aria-valuenow', String(Math.round(nextFontSizePx)));
    if (scaleValueRef.current) scaleValueRef.current.textContent = `${Number(nextFontSizePx.toFixed(1))} px`;
    pendingFontSizeRef.current = nextFontSizePx;
    pendingScalePatchRef.current = patch;
  };

  const scheduleScale = (clientX: number, clientY: number) => {
    pendingScalePointRef.current = { x: clientX, y: clientY };
    if (scaleAnimationFrameRef.current !== null) return;
    scaleAnimationFrameRef.current = window.requestAnimationFrame(applyPendingScale);
  };

  const flushScale = () => {
    if (scaleAnimationFrameRef.current === null) return;
    window.cancelAnimationFrame(scaleAnimationFrameRef.current);
    applyPendingScale();
  };

  const startScaling = (
    event: React.PointerEvent<HTMLDivElement>,
    directionX: number,
    directionY: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cueRect = cueRef.current?.getBoundingClientRect();
    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!cueRect || !frameRect) return;
    const anchorX = directionX < 0
      ? cueRect.right
      : directionX > 0
        ? cueRect.left
        : cueRect.left + cueRect.width / 2;
    const anchorY = directionY < 0
      ? cueRect.bottom
      : directionY > 0
        ? cueRect.top
        : cueRect.top + cueRect.height / 2;
    const distancePx = directionX === 0
      ? Math.abs(event.clientY - anchorY)
      : directionY === 0
        ? Math.abs(event.clientX - anchorX)
        : Math.hypot(event.clientX - anchorX, event.clientY - anchorY);
    scaleStartRef.current = {
      anchorX,
      anchorY,
      frameLeft: frameRect.left,
      frameTop: frameRect.top,
      directionX,
      directionY,
      distancePx: Math.max(1, distancePx),
      fontSizePx: preferences.fontSizePx,
      blockWidth: cueRect.width,
      blockHeight: cueRect.height,
    };
    pendingFontSizeRef.current = null;
    pendingScalePatchRef.current = null;
    scalingRef.current = true;
    stylePreviewActiveRef.current = true;
    cueRef.current.style.transition = 'none';
    if (cuePositionRef.current) cuePositionRef.current.style.transition = 'none';
    activeScaleHandleRef.current = event.currentTarget;
    setIsScaling(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishScaling = (event: React.PointerEvent<HTMLDivElement>, applyFinalPoint = true) => {
    event.stopPropagation();
    if (!scalingRef.current) return;
    if (applyFinalPoint) scheduleScale(event.clientX, event.clientY);
    flushScale();
    scalingRef.current = false;
    stylePreviewActiveRef.current = false;
    if (cueRef.current) cueRef.current.style.transition = CUE_IDLE_TRANSITION;
    if (cuePositionRef.current) cuePositionRef.current.style.transition = POSITION_IDLE_TRANSITION;
    setIsScaling(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const frameRect = frameRef.current?.getBoundingClientRect();
    const cueRect = cueRef.current?.getBoundingClientRect();
    let finalPatch = pendingScalePatchRef.current;
    if (frameRect && cueRect) {
      const measuredViewport = {
        width: frameRect.width,
        height: frameRect.height,
        blockWidth: cueRect.width,
        blockHeight: cueRect.height,
      };
      const finalViewport = {
        ...measuredViewport,
        controlsInset: previewViewport.controlsInset,
        minScale: 0.1,
      };
      setViewport(measuredViewport);
      if (finalPatch) {
        const centerX = cueRect.left + cueRect.width / 2 - frameRect.left;
        const centerY = cueRect.top + cueRect.height / 2 - frameRect.top;
        finalPatch = {
          ...finalPatch,
          ...preferencesFromDrag({ ...preferences, ...finalPatch }, finalViewport, centerX, centerY),
        };
      }
    }
    if (finalPatch) onChange(finalPatch);
    if (scaleValueRef.current) scaleValueRef.current.textContent = `${Number((pendingFontSizeRef.current ?? preferences.fontSizePx).toFixed(1))} px`;
    pendingFontSizeRef.current = null;
    pendingScalePatchRef.current = null;
    activeScaleHandleRef.current = null;
  };

  const handleScaleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
        ? -1
        : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onChange({
      fontSizeMode: 'manual',
      fontSizePx: Math.min(48, Math.max(8, preferences.fontSizePx + direction)),
    });
  };

  const toggleFullscreen = async () => {
    setFullscreenError(false);
    try {
      if (document.fullscreenElement === frameRef.current) await document.exitFullscreen();
      else await frameRef.current?.requestFullscreen();
    } catch {
      setFullscreenError(true);
    }
  };

  const edgeStyles = getSubtitleEdgeStyles(
    preferences.edgeStyle,
    preferences.edgeColor,
    preferences.edgeSizePx,
    placement.scale,
  );

  return (
    <div className="space-y-3">
      <div ref={frameRef} className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl fullscreen:h-screen fullscreen:aspect-auto fullscreen:rounded-none fullscreen:border-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_22%,rgba(37,99,235,.28),transparent_34%),linear-gradient(135deg,#111827,#020617_60%,#000)]" />

        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 z-10 transition-opacity duration-200 ease-out ${isDragging && guidesVisible ? 'opacity-100' : 'opacity-0'}`}
        >
          {SUBTITLE_GUIDE_RATIOS.map((ratio, index) => (
            <div
              key={`vertical-${ratio}`}
              ref={(node) => { verticalGuideRefs.current[index] = node; }}
              className="absolute inset-y-0 w-px -translate-x-1/2 transition-[opacity,background-color] duration-100"
              style={{ left: `${ratio * 100}%`, opacity: 0.72, backgroundColor: 'rgba(255,255,255,.82)' }}
            >
              <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {GUIDE_LABELS[index]}
              </span>
            </div>
          ))}
          {SUBTITLE_GUIDE_RATIOS.map((ratio, index) => (
            <div
              key={`horizontal-${ratio}`}
              ref={(node) => { horizontalGuideRefs.current[index] = node; }}
              className="absolute inset-x-0 h-px -translate-y-1/2 transition-[opacity,background-color] duration-100"
              style={{ top: `${ratio * 100}%`, opacity: 0.72, backgroundColor: 'rgba(255,255,255,.82)' }}
            >
              <span className="absolute left-2 top-1/2 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {GUIDE_LABELS[index]}
              </span>
            </div>
          ))}
          {GUIDE_POINT_POSITIONS.flatMap((x) => GUIDE_POINT_POSITIONS.map((y) => {
            const isCenter = x === 1 / 2 && y === 1 / 2;
            return (
              <div
                key={`${x}-${y}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-black/60 shadow-sm shadow-black/50 ${isCenter ? 'h-3 w-3' : 'h-1.5 w-1.5'}`}
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              />
            );
          }))}
          <div ref={centerBadgeRef} className="absolute left-1/2 top-10 -translate-x-1/2 rounded-md bg-red-600 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-lg shadow-black/30 transition-opacity duration-150">
            {t('settings.subtitles.previewAlignedCenter')}
          </div>
        </div>

        <div className="absolute right-3 top-3 z-40 flex gap-2">
          <button
            type="button"
            onClick={() => setGuidesVisible((visible) => !visible)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 bg-black/65 text-white transition-[transform,background-color] duration-200 hover:bg-black/85 active:scale-95"
            aria-label={t(guidesVisible ? 'settings.subtitles.previewHideGrid' : 'settings.subtitles.previewShowGrid')}
            aria-pressed={guidesVisible}
          >
            <span className="relative inline-flex h-5 w-5 items-center justify-center">
              <Grid3X3 className={`h-4 w-4 transition-[transform,opacity] duration-200 ${guidesVisible ? 'scale-100 opacity-100' : 'scale-90 opacity-70'}`} />
              <span className={`absolute h-0.5 w-5 rotate-45 rounded-full bg-current transition-[transform,opacity] duration-200 ${guidesVisible ? 'scale-x-0 opacity-0' : 'scale-x-100 opacity-100'}`} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => setControlsVisible((visible) => !visible)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 bg-black/65 text-white transition-[transform,background-color] duration-200 hover:bg-black/85 active:scale-95"
            aria-label={t(controlsVisible ? 'settings.subtitles.previewHideControls' : 'settings.subtitles.previewShowControls')}
            aria-pressed={!controlsVisible}
          >
            <span className={`inline-flex transition-[transform,opacity] duration-300 ease-out ${controlsVisible ? 'rotate-0 scale-100 opacity-100' : 'rotate-180 scale-90 opacity-90'}`}>
              {controlsVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </span>
          </button>
        </div>

        <div
          ref={cuePositionRef}
          className="pointer-events-none absolute bottom-0 left-0 z-20 w-max max-w-[90%]"
          style={{
            transform: cueTransform(placement.leftPx, placement.bottomPx),
            transition: isDragging || isScaling ? 'none' : POSITION_IDLE_TRANSITION,
            willChange: 'transform',
          }}
        >
          <div
            ref={cueRef}
            role="slider"
            tabIndex={0}
            aria-label={t('settings.subtitles.previewDragHint')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(preferences.positionXPercent)}
            onPointerDown={handlePointerDown}
            onPointerMove={(event) => draggingRef.current && scheduleDrag(event.clientX, event.clientY)}
            onPointerUp={(event) => stopDragging(event)}
            onPointerCancel={(event) => stopDragging(event, false)}
            onKeyDown={handleKeyDown}
            className="pointer-events-auto relative max-w-full touch-none cursor-grab select-none whitespace-pre-wrap rounded text-center active:cursor-grabbing"
            style={{
              padding: `${8 * placement.scale}px ${16 * placement.scale}px`,
              overflowWrap: 'anywhere',
              transition: isScaling ? 'none' : CUE_IDLE_TRANSITION,
              color: preferences.color,
              fontFamily: SUBTITLE_FONT_FAMILIES[preferences.fontFamily],
              fontSize: placement.fontSizePx,
              fontWeight: preferences.fontWeight,
              ...edgeStyles,
              backgroundColor: preferences.backgroundEnabled ? `rgba(0,0,0,${preferences.backgroundOpacity})` : 'transparent',
            }}
          >
            {sample}
          </div>

          <div
            aria-hidden="true"
            className={`absolute inset-0 rounded-sm border border-[#8b3dff] transition-opacity duration-150 ${isScaling ? 'opacity-100' : 'opacity-95'}`}
          />

          <span
            ref={scaleValueRef}
            className={`pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] font-semibold tabular-nums text-white shadow-lg transition-[transform,opacity] duration-150 ${isScaling ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
          >
            {Number(preferences.fontSizePx.toFixed(1))} px
          </span>

          {SCALE_HANDLES.map((handle) => (
            <div
              key={handle.key}
              data-scale-handle={handle.key}
              role="slider"
              tabIndex={0}
              aria-label={t('settings.subtitles.textSize')}
              aria-valuemin={8}
              aria-valuemax={48}
              aria-valuenow={Math.round(preferences.fontSizePx)}
              onPointerDown={(event) => startScaling(event, handle.x, handle.y)}
              onPointerMove={(event) => {
                event.stopPropagation();
                if (scalingRef.current) scheduleScale(event.clientX, event.clientY);
              }}
              onPointerUp={(event) => finishScaling(event)}
              onPointerCancel={(event) => finishScaling(event, false)}
              onKeyDown={handleScaleKeyDown}
              className={`group pointer-events-auto absolute z-30 flex h-7 w-7 touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b3dff] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${handle.position} ${handle.cursor}`}
            >
              <span className="block h-3 w-3 rounded-full border-2 border-[#8b3dff] bg-white shadow-sm shadow-black/40 transition-transform duration-150 group-active:scale-110" />
            </div>
          ))}
        </div>

        <div
          aria-hidden={!controlsVisible}
          className={`pointer-events-none absolute inset-0 z-30 transition-opacity duration-300 ease-out ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}
        >
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-28 bg-gradient-to-t from-black via-black/65 to-transparent" />
            <div className="pointer-events-none absolute inset-x-4 bottom-12 z-30 h-1 rounded-full bg-white/25"><div className="h-full w-[38%] rounded-full bg-red-600" /></div>
            <div className="absolute inset-x-4 bottom-1 z-30 flex h-10 items-center gap-3 text-white">
              <div className="pointer-events-none flex items-center gap-3">
                <Play className="h-5 w-5 fill-current" />
                <Volume2 className="h-5 w-5" />
                <span className="text-xs tabular-nums">24:18 / 52:03</span>
              </div>
              <span className="flex-1" />
              <Settings className="pointer-events-none h-5 w-5" />
              <button
                type="button"
                onClick={toggleFullscreen}
                tabIndex={controlsVisible ? 0 : -1}
                className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-md transition-[transform,background-color] duration-150 hover:bg-white/10 active:scale-95"
                aria-label={t('settings.subtitles.previewFullscreen')}
              >
                <span className={`inline-flex transition-transform duration-300 ease-out ${isFullscreen ? 'rotate-180 scale-90' : 'rotate-0 scale-100'}`}>
                  {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                </span>
              </button>
            </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" aria-label={t('settings.subtitles.preview')}>
        {SAMPLE_OPTIONS.map(({ lines, key }) => (
          <button key={lines} type="button" aria-pressed={!customMode && sampleLines === lines} onClick={() => { setCustomMode(false); setSampleLines(lines); }} className={previewChoiceButton(!customMode && sampleLines === lines)}>{t(key)}</button>
        ))}
        <button type="button" aria-pressed={customMode} onClick={() => setCustomMode(true)} className={previewChoiceButton(customMode)}>{t('settings.subtitles.previewCustomText')}</button>
      </div>

      <div
        aria-hidden={!customMode}
        inert={!customMode}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${customMode ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-2 pt-1">
            <textarea value={customText} onChange={(event) => setCustomText(event.target.value)} placeholder={t('settings.subtitles.previewCustomPlaceholder')} rows={compact ? 2 : 3} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" />
            <button type="button" onClick={() => { setCustomText(''); setCustomMode(false); setSampleLines(1); }} className="min-h-11 rounded-lg px-3 py-2 text-sm text-gray-200 transition-colors hover:text-white"><RotateCcw className="mr-2 inline h-4 w-4" />{t('settings.subtitles.previewRestore')}</button>
          </div>
        </div>
      </div>
      {fullscreenError && <p role="status" className="text-xs text-amber-300">{t('settings.subtitles.previewFullscreenError')}</p>}
    </div>
  );
};
