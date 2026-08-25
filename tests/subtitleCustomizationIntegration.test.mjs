import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('subtitle preview exposes fullscreen, sample text and bounded drag interactions', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  assert.match(preview, /requestFullscreen\(\)/);
  assert.match(preview, /setPointerCapture/);
  assert.match(preview, /preferencesFromDrag/);
  assert.match(preview, /previewOneLine/);
  assert.match(preview, /previewTwoLines/);
  assert.match(preview, /previewThreeLines/);
  assert.match(preview, /previewCustomText/);
  assert.match(preview, /onKeyDown/);
  assert.match(preview, /overflowWrap: 'anywhere'/);
});

test('shared subtitle controls expose every approved appearance field', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  for (const field of [
    'fontSizePx', 'fontSizeMode', 'bottomOffsetPx', 'positionXPercent',
    'maxWidthPercent', 'maxWidthMode',
    'color', 'edgeStyle', 'edgeColor', 'edgeSizePx', 'backgroundEnabled', 'backgroundOpacity',
    'fontFamily', 'fontWeight',
  ]) {
    assert.match(controls, new RegExp(field));
  }
});

test('subtitle color picker expands shorthand hex before persisting it', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  assert.match(controls, /expandShortHexColor\(color\)/);
  assert.match(controls, /match\s*\?\s*`#\$\{match\[1\]\}\$\{match\[1\]\}\$\{match\[2\]\}\$\{match\[2\]\}\$\{match\[3\]\}\$\{match\[3\]\}`/);
});

test('Settings uses a bounded sticky sidebar, search bar and subtitle section', () => {
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');
  assert.match(settings, /grid-cols-\[280px,minmax\(0,1fr\)\]/);
  assert.match(settings, /sticky/);
  assert.doesNotMatch(settings, /<nav className="[^"]*fixed left-0/);
  assert.doesNotMatch(settings, /<SquareBackground/);
  assert.match(settings, /className="min-h-screen overflow-clip bg-black text-white"/);
  assert.match(settings, /data-settings-sidebar-header/);
  assert.match(settings, /data-settings-sidebar-scroll/);
  assert.match(settings, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(settings, /<SettingsSearchBar/);
  assert.match(settings, /id="subtitles"/);
  assert.match(settings, /<SubtitleStyleControls/);
  assert.match(settings, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(360px,440px\)\]/);
  assert.match(settings, /showPreview=\{false\}/);
  assert.match(settings, /xl:sticky xl:top-36/);
});

test('Task 6 keeps sticky ancestors clipped without becoming scroll containers', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');
  const globalCss = readFileSync('src/index.css', 'utf8');

  assert.match(app, /min-h-screen bg-black text-white relative overflow-clip/);
  assert.match(settings, /className="min-h-screen overflow-clip bg-black text-white"/);
  assert.match(globalCss, /body\s*\{\s*overflow-x: clip;/);
  assert.match(globalCss, /#root\s*\{\s*overflow-x: clip;/);
});

test('Task 6 keeps the preview cue proportionally sized and removes its duplicate header', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');

  assert.match(preview, /translate3d\(\$\{leftPx\}px, \$\{-bottomPx\}px, 0\) translateX\(-50%\)/);
  assert.match(preview, /width: `\$\{preferences\.maxWidthPercent \* 0\.9\}%`/);
  assert.match(preview, /minScale: 0\.1/);
  assert.match(preview, /padding: `\$\{8 \* placement\.scale\}px \$\{16 \* placement\.scale\}px`/);
  assert.match(preview, /width 260ms cubic-bezier/);
  assert.match(preview, /max-w-\[90%\]/);
  assert.doesNotMatch(settings, /showGlobalHeader/);
});

test('subtitle preview matches HLS cue weights, crisp outline and touch dragging', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  const hlsPlayer = readFileSync('src/components/HLSPlayer.tsx', 'utf8');

  assert.match(preview, /touch-none/);
  assert.match(preview, /fontWeight: preferences\.fontWeight/);
  assert.match(preview, /getSubtitleEdgeStyles\([\s\S]*preferences\.edgeStyle,[\s\S]*preferences\.edgeColor,[\s\S]*preferences\.edgeSizePx,[\s\S]*placement\.scale/);
  assert.match(hlsPlayer, /getSubtitleEdgeStyles\([\s\S]*subtitlePreferences\.edgeStyle,[\s\S]*subtitlePreferences\.edgeColor,[\s\S]*subtitlePreferences\.edgeSizePx,[\s\S]*subtitlePlacement\.scale/);
});

test('subtitle controls announce resets and label preset colors for each locale', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');

  assert.match(controls, /role="status"/);
  assert.match(controls, /aria-live="polite"/);
  assert.match(controls, /resetAnnounced/);
  assert.doesNotMatch(controls, /aria-label=\{color\}/);
  for (const localePath of ['src/i18n/locales/fr.json', 'src/i18n/locales/en.json']) {
    const locale = JSON.parse(readFileSync(localePath, 'utf8'));
    assert.equal(typeof locale.settings.subtitles.resetAnnounced, 'string');
    assert.equal(typeof locale.settings.subtitles.colorWhite, 'string');
    assert.equal(typeof locale.settings.subtitles.colorYellow, 'string');
    assert.equal(typeof locale.settings.subtitles.colorCyan, 'string');
    assert.equal(typeof locale.settings.subtitles.colorBlue, 'string');
    assert.equal(typeof locale.settings.subtitles.colorGreen, 'string');
    assert.equal(typeof locale.settings.subtitles.colorRed, 'string');
    assert.equal(typeof locale.settings.subtitles.colorMagenta, 'string');
    assert.equal(typeof locale.settings.subtitles.colorBlack, 'string');
    assert.equal(typeof locale.settings.subtitles.edgeColor, 'string');
    assert.equal(typeof locale.settings.subtitles.edgeSize, 'string');
    assert.equal(typeof locale.settings.subtitles.weightSize, 'string');
    assert.equal(typeof locale.settings.subtitles.maxWidth, 'string');
    assert.equal(typeof locale.settings.subtitles.maxWidthDescription, 'string');
    assert.equal(typeof locale.settings.subtitles.backToDefault, 'string');
    assert.equal(typeof locale.settings.subtitles.auto, 'string');
    assert.equal(typeof locale.settings.subtitles.previewAlignedCenter, 'string');
  }
});

test('subtitle interactions render on animation frames and persist after the gesture', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  const picker = readFileSync('src/components/Settings/BgColorPickerPanel.tsx', 'utf8');

  assert.match(preview, /requestAnimationFrame\(applyPendingDrag\)/);
  assert.match(preview, /if \(pendingPatchRef\.current\) onChange\(pendingPatchRef\.current\)/);
  assert.match(preview, /previewHideControls/);
  assert.match(preview, /onClick=\{toggleFullscreen\}/);
  assert.match(controls, /onPreviewChange/);
  assert.match(controls, /onCommitPreview/);
  assert.match(picker, /requestAnimationFrame/);
  assert.match(picker, /onPreview/);
  assert.match(controls, /role="slider"/);
  assert.match(controls, /setPointerCapture/);
  assert.match(controls, /requestAnimationFrame\(applyPendingPoint\)/);
  assert.match(controls, /h-11 w-full touch-none/);
  assert.match(controls, /sliderBoundsRef\.current = \{ left: rect\.left, width: Math\.max\(rect\.width, 1\) \}/);
  assert.doesNotMatch(controls, /type="range"/);
});

test('subtitle live previews bypass page rerenders and controls fade smoothly', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  const hook = readFileSync('src/hooks/useSubtitlePreferences.ts', 'utf8');
  const player = readFileSync('src/components/HLSPlayer.tsx', 'utf8');

  assert.match(hook, /dispatchEvent\(new CustomEvent\(SUBTITLE_STYLE_PREVIEW_EVENT/);
  assert.match(preview, /transition-opacity duration-300 ease-out/);
  assert.match(preview, /transition-\[transform,opacity\] duration-300 ease-out/);
  assert.match(preview, /cue\.style\.transition = 'none'/);
  assert.match(controls, /scaleX\(\$\{progress \/ 100\}\)/);
  assert.match(player, /subtitlePreviewActiveRef\.current = true/);
  assert.match(player, /position\.style\.transition = 'none'/);
});

test('subtitle controls expose live values, edge customization and weight size', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');

  assert.match(controls, /outputRef/);
  assert.match(controls, /formatValue/);
  assert.match(controls, /edgeColor/);
  assert.match(controls, /edgeSizePx/);
  assert.match(controls, /Math\.round\(value \* 100\).*%/s);
  assert.match(controls, /min=\{100\}[\s\S]*max=\{900\}/);
  assert.match(controls, /animateExternalValue/);
  assert.match(controls, /animateExternalValue = true/);
  assert.match(controls, /AutoStatus/);
  assert.equal((controls.match(/<AutoStatus/g) ?? []).length, 6);
  assert.doesNotMatch(controls, /absolute right-0 top-0 rounded-full border border-emerald/);
  assert.match(preview, /pointer-events-none.*transition-opacity/);
  assert.match(preview, /pointer-events-auto/);
  assert.match(preview, /previewAlignedCenter/);
});

test('pixel outputs can be edited directly with keyboard confirmation and cancellation', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');

  assert.equal((controls.match(/<EditablePixelValue/g) ?? []).length, 3);
  assert.match(controls, /onKeyDown=.*Enter/s);
  assert.match(controls, /event\.key === 'Escape'/);
  assert.match(controls, /parseSubtitlePixelInput/);
  assert.match(controls, /fontSizeMode: 'manual', fontSizePx/);
  assert.match(controls, /bottomOffsetPx/);
  assert.match(controls, /edgeSizePx/);
});

test('subtitle background controls retract like an accordion when disabled', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');

  assert.match(controls, /grid-rows-\[1fr\]/);
  assert.match(controls, /grid-rows-\[0fr\]/);
  assert.match(controls, /disabled=\{!preferences\.backgroundEnabled\}/);
  assert.doesNotMatch(controls, /preferences\.backgroundEnabled && \(\s*<SmoothRange/);
});

test('conditional subtitle controls share accordion and selected-state motion', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');

  assert.match(controls, /preferences\.edgeStyle !== 'none' \? 'grid-rows-\[1fr\] opacity-100'/);
  assert.doesNotMatch(controls, /preferences\.edgeStyle !== 'none' && \(/);
  assert.match(preview, /customMode \? 'grid-rows-\[1fr\] opacity-100'/);
  assert.match(preview, /previewChoiceButton/);
});

test('rapid minus and plus clicks preview immediately and commit once after the burst', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');

  assert.match(controls, /useImperativeHandle/);
  assert.match(controls, /\.animateTo\(next\)/);
  assert.match(controls, /externalTargetValueRef/);
  assert.match(controls, /if \(externalAnimationFrameRef\.current !== null\) return;/);
  assert.match(controls, /1 - Math\.exp\(-elapsedMs \/ 72\)/);
  assert.match(controls, /pendingButtonPatchRef/);
  assert.match(controls, /requestAnimationFrame\(flushButtonPreview\)/);
  assert.match(controls, /commitTimerRef/);
  assert.match(controls, /window\.clearTimeout\(commitTimerRef\.current\)/);
  assert.match(controls, /window\.setTimeout/);
});

test('subtitle preview exposes quarter guides and Canva-style corner scaling', () => {
  const preview = readFileSync('src/components/subtitles/SubtitlePreview.tsx', 'utf8');
  const preferences = readFileSync('src/utils/subtitlePreferences.ts', 'utf8');

  assert.match(preferences, /SUBTITLE_GUIDE_RATIOS = \[1 \/ 4, 1 \/ 3, 1 \/ 2, 2 \/ 3, 3 \/ 4\]/);
  assert.match(preview, /GUIDE_POINT_POSITIONS\.flatMap/);
  assert.match(preview, /SUBTITLE_GUIDE_RATIOS\.map/);
  assert.match(preview, /getSubtitleGuideSnap/);
  assert.match(preview, /scaleSubtitleFontSizeFromPointer/);
  assert.match(preview, /requestAnimationFrame\(applyPendingScale\)/);
  assert.match(preview, /const resizedCueRect = cue\.getBoundingClientRect\(\)/);
  assert.match(preview, /blockHeight: resizedCueRect\.height/);
  assert.doesNotMatch(preview, /estimatedBlockHeight/);
  assert.match(preview, /fontSizeMode: 'manual'/);
  assert.match(preview, /SCALE_HANDLES/);
  assert.match(preview, /data-scale-handle/);
  assert.match(preview, /west-edge/);
  assert.match(preview, /east-edge/);
  assert.doesNotMatch(preview, /north-edge/);
  assert.match(preview, /guidesVisible/);
  assert.match(preview, /previewHideGrid/);
  assert.match(preview, /guidesVisible \? getStickyGuideSnap/);
  assert.match(preview, /mode: 'width'/);
  assert.match(preview, /pendingCueWidthPercentRef/);
  assert.match(preview, /maxWidth > 0 \? nextWidth \/ maxWidth \* 100 : 100/);
  assert.match(preview, /maxWidthMode: 'manual'/);
  assert.doesNotMatch(preview, /setCueWidthPercent/);
  assert.match(preview, /anchorX/);
  assert.match(preview, /directionX/);
  assert.match(preview, /cursor-nwse-resize/);
  assert.match(preview, /cursor-nesw-resize/);
  assert.doesNotMatch(preview, /MoveDiagonal2/);
});

test('subtitle search and HLS style panel expose only the intended clear and settings controls', () => {
  const search = readFileSync('src/components/Settings/SettingsSearchBar.tsx', 'utf8');
  const panel = readFileSync('src/components/HLSPlayerSettingsPanel.tsx', 'utf8');
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');

  assert.match(search, /type="text"/);
  assert.match(search, /inputMode="search"/);
  assert.match(search, /<X className="h-4 w-4"/);
  assert.match(panel, /href="\/settings#subtitles"/);
  assert.match(panel, /moreSubtitleSettings/);
  assert.match(settings, /location\.hash\.replace\('#', ''\)/);
  assert.match(settings, /requestAnimationFrame\(\(\) => scrollToSection\(sectionId\)\)/);
});

test('subtitle controls expose the extended readable font collection', () => {
  const controls = readFileSync('src/components/subtitles/SubtitleStyleControls.tsx', 'utf8');
  const preferences = readFileSync('src/utils/subtitlePreferences.ts', 'utf8');

  for (const font of ['atkinson', 'lexend', 'opendyslexic', 'arial', 'verdana', 'trebuchet', 'tahoma']) {
    assert.match(controls, new RegExp(`value: '${font}'`));
    assert.match(preferences, new RegExp(`${font}:`));
  }
});

test('subtitle Settings locale keys share one root settings object', () => {
  for (const localePath of ['src/i18n/locales/fr.json', 'src/i18n/locales/en.json']) {
    const source = readFileSync(localePath, 'utf8');
    const locale = JSON.parse(source);
    assert.equal((source.match(/^  "settings"\s*:/gm) ?? []).length, 1);
    assert.equal(typeof locale.settings.sections.subtitles, 'string');
    assert.equal(typeof locale.settings.search.placeholder, 'string');
    assert.equal(typeof locale.settings.subtitles.title, 'string');
  }
});

test('HLS settings and cue renderer use the shared subtitle preference system', () => {
  const player = readFileSync('src/components/HLSPlayer.tsx', 'utf8');
  const panel = readFileSync('src/components/HLSPlayerSettingsPanel.tsx', 'utf8');
  assert.match(player, /useSubtitlePreferences/);
  assert.match(player, /calculateSubtitlePlacement/);
  assert.match(player, /ResizeObserver/);
  assert.match(player, /subtitleCueBlockRef/);
  assert.match(player, /getSubtitleSafeWidthCss/);
  assert.match(player, /width:\s*getSubtitleSafeWidthCss\(subtitlePreferences\.maxWidthPercent\)/);
  assert.match(player, /maxWidth:\s*getSubtitleSafeWidthCss\(100\)/);
  assert.match(player, /const subtitleDelayRef = useRef\(subtitlePreferences\.delay\)/);
  assert.match(player, /subtitleDelayRef\.current = subtitlePreferences\.delay/);
  assert.match(player, /refreshActiveCues\(video, textTrack, subtitleDelayRef\.current\)/);
  assert.match(panel, /<SubtitleStyleControls/);
  assert.doesNotMatch(panel, /subtitleStyle\.fontSize\.toFixed/);
});
