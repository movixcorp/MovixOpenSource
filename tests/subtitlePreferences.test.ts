import assert from 'node:assert/strict';
import test from 'node:test';

test('migrates the legacy HLS subtitle style without losing delay', async () => {
  const modulePath = '../src/utils/subtitlePreferences.ts';
  let preferencesModule: typeof import('../src/utils/subtitlePreferences.ts') | null = null;
  try {
    preferencesModule = await import(modulePath);
  } catch {
    // Intentional RED phase while the module is absent.
  }
  assert.ok(preferencesModule, 'subtitle preference helper must exist');

  const migrated = preferencesModule.normalizeSubtitlePreferences({
    fontSize: 1.5,
    backgroundOpacity: 0.4,
    color: 'yellow',
    delay: -1.5,
  });

  assert.equal(migrated.version, 3);
  assert.equal(migrated.fontSizeMode, 'manual');
  assert.equal(migrated.fontSizePx, 24);
  assert.equal(migrated.backgroundEnabled, true);
  assert.equal(migrated.backgroundOpacity, 0.4);
  assert.equal(migrated.color, '#fcd34d');
  assert.equal(migrated.delay, -1.5);
  assert.equal(migrated.bottomOffsetPx, 96);
  assert.equal(migrated.positionXPercent, 50);
  assert.equal(migrated.maxWidthPercent, 80);
  assert.equal(migrated.maxWidthMode, 'auto');
});

test('normalizes corrupt and out-of-range subtitle fields', async () => {
  const { normalizeSubtitlePreferences, getRelativeLuminance } = await import('../src/utils/subtitlePreferences.ts');
  const normalized = normalizeSubtitlePreferences({
    fontSizeMode: 'broken',
    fontSizePx: 1000,
    bottomOffsetPx: -40,
    positionXPercent: 120,
    maxWidthPercent: 999,
    maxWidthMode: 'broken',
    color: 'javascript:alert(1)',
    edgeStyle: 'glow',
    backgroundOpacity: 8,
    fontFamily: 'comic-sans',
    fontWeight: 'heavy',
    edgeColor: 'not-a-color',
    edgeSizePx: 99,
    delay: 100,
  });

  assert.equal(normalized.fontSizeMode, 'auto');
  assert.equal(normalized.fontSizePx, 48);
  assert.equal(normalized.bottomOffsetPx, 25);
  assert.equal(normalized.positionXPercent, 100);
  assert.equal(normalized.maxWidthPercent, 80);
  assert.equal(normalized.maxWidthMode, 'auto');
  assert.equal(normalized.color, '#ffffff');
  assert.equal(normalized.edgeStyle, 'none');
  assert.equal(normalized.backgroundOpacity, 1);
  assert.equal(normalized.fontFamily, 'standard');
  assert.equal(normalized.fontWeight, 400);
  assert.equal(normalized.edgeColor, '#000000');
  assert.equal(normalized.edgeSizePx, 6);
  assert.equal(normalized.delay, 10);
  assert.equal(normalizeSubtitlePreferences({ color: '#000000' }).color, '#000000');
  assert.equal(getRelativeLuminance('#000000'), 0);
  assert.equal(getRelativeLuminance('#ffffff'), 1);
});

test('falls back safely when subtitle coordinates or background opacity are NaN', async () => {
  const { normalizeSubtitlePreferences } = await import('../src/utils/subtitlePreferences.ts');
  const normalized = normalizeSubtitlePreferences({
    bottomOffsetPx: Number.NaN,
    positionXPercent: Number.NaN,
    maxWidthPercent: Number.NaN,
    backgroundOpacity: Number.NaN,
  });

  assert.equal(normalized.bottomOffsetPx, 96);
  assert.equal(normalized.positionXPercent, 50);
  assert.equal(normalized.maxWidthPercent, 80);
  assert.equal(normalized.backgroundOpacity, 0.4);
  assert.equal(normalized.backgroundEnabled, true);
});

test('maps the logical subtitle width to the safe player width', async () => {
  const { getSubtitleSafeWidthCss } = await import('../src/utils/subtitlePreferences.ts');

  assert.equal(getSubtitleSafeWidthCss(100), 'calc(100% - 24px)');
  assert.equal(getSubtitleSafeWidthCss(50), 'calc(50% - 12px)');
  assert.equal(getSubtitleSafeWidthCss(0), 'calc(20% - 4.8px)');
});

test('keeps manual 100% width distinct from automatic intrinsic width', async () => {
  const { normalizeSubtitlePreferences } = await import('../src/utils/subtitlePreferences.ts');

  assert.equal(normalizeSubtitlePreferences({ maxWidthPercent: 99 }).maxWidthMode, 'manual');
  const migratedAuto = normalizeSubtitlePreferences({ maxWidthPercent: 100 });
  assert.equal(migratedAuto.maxWidthMode, 'auto');
  assert.equal(migratedAuto.maxWidthPercent, 80);
  const manualFullWidth = normalizeSubtitlePreferences({ maxWidthPercent: 100, maxWidthMode: 'manual' });
  assert.equal(manualFullWidth.maxWidthMode, 'manual');
  assert.equal(manualFullWidth.maxWidthPercent, 100);
});

test('realigns untouched version 2 defaults with the legacy HLS renderer', async () => {
  const { normalizeSubtitlePreferences } = await import('../src/utils/subtitlePreferences.ts');
  const normalized = normalizeSubtitlePreferences({
    version: 2,
    fontSizeMode: 'auto',
    fontSizePx: 32,
    bottomOffsetPx: 275,
  });

  assert.equal(normalized.version, 3);
  assert.equal(normalized.fontSizePx, 24);
  assert.equal(normalized.bottomOffsetPx, 96);
});

test('keeps every supported readability font while rejecting unknown values', async () => {
  const { normalizeSubtitlePreferences } = await import('../src/utils/subtitlePreferences.ts');
  for (const fontFamily of ['standard', 'atkinson', 'lexend', 'opendyslexic', 'arial', 'verdana', 'trebuchet', 'tahoma', 'serif', 'monospace']) {
    assert.equal(normalizeSubtitlePreferences({ fontFamily }).fontFamily, fontFamily);
  }
  assert.equal(normalizeSubtitlePreferences({ fontFamily: 'unknown-font' }).fontFamily, 'standard');
});

test('keeps outline and shadow visually distinct with custom color and size', async () => {
  const { getSubtitleEdgeStyles } = await import('../src/utils/subtitlePreferences.ts');

  assert.deepEqual(getSubtitleEdgeStyles('outline', '#ef4444', 2, 1), {
    textShadow: 'none',
    WebkitTextStroke: '2px #ef4444',
    paintOrder: 'stroke fill',
  });
  assert.deepEqual(getSubtitleEdgeStyles('outline', '#06b6d4', 2, 0.44), {
    textShadow: 'none',
    WebkitTextStroke: '0.88px #06b6d4',
    paintOrder: 'stroke fill',
  });
  assert.deepEqual(getSubtitleEdgeStyles('shadow', '#ef4444', 2, 1), {
    textShadow: '0 2px 6px #ef4444, 0 0 3px #ef4444',
    WebkitTextStroke: '0 transparent',
  });
});

test('migrates legacy named font weights to adjustable numeric weights', async () => {
  const { normalizeSubtitlePreferences } = await import('../src/utils/subtitlePreferences.ts');
  assert.equal(normalizeSubtitlePreferences({ fontWeight: 'normal' }).fontWeight, 400);
  assert.equal(normalizeSubtitlePreferences({ fontWeight: 'bold' }).fontWeight, 700);
  assert.equal(normalizeSubtitlePreferences({ fontWeight: 615 }).fontWeight, 615);
});

test('scales subtitle reference values and respects cue bounds', async () => {
  const { DEFAULT_SUBTITLE_PREFERENCES, calculateSubtitlePlacement, getSubtitleResponsiveScale } = await import('../src/utils/subtitlePreferences.ts');
  const desktop = calculateSubtitlePlacement(DEFAULT_SUBTITLE_PREFERENCES, {
    width: 1920,
    height: 1080,
    blockWidth: 600,
    blockHeight: 80,
    controlsInset: 96,
  });
  assert.equal(desktop.scale, 1);
  assert.equal(desktop.fontSizePx, 24);
  assert.equal(desktop.bottomPx, 96);
  assert.equal(desktop.leftPx, 960);

  const phone = calculateSubtitlePlacement(DEFAULT_SUBTITLE_PREFERENCES, {
    width: 800,
    height: 450,
    blockWidth: 300,
    blockHeight: 52,
    controlsInset: 72,
  });
  assert.equal(Number(phone.scale.toFixed(3)), 0.417);
  assert.equal(Number(phone.fontSizePx.toFixed(2)), 10);
  assert.ok(phone.bottomPx >= 72);
  assert.equal(getSubtitleResponsiveScale(480, 270), 0.35);
  assert.equal(getSubtitleResponsiveScale(480, 270, 0.1), 0.25);
});

test('converts dragging to reference coordinates and clamps every edge', async () => {
  const { DEFAULT_SUBTITLE_PREFERENCES, preferencesFromDrag } = await import('../src/utils/subtitlePreferences.ts');
  const next = preferencesFromDrag(DEFAULT_SUBTITLE_PREFERENCES, {
    width: 960,
    height: 540,
    blockWidth: 360,
    blockHeight: 70,
    controlsInset: 80,
  }, -100, 900);
  assert.equal(next.positionXPercent, 20);
  assert.equal(next.bottomOffsetPx, 160);
});

test('snaps preview coordinates and keeps resize distance at zero past its anchor', async () => {
  const {
    getDirectionalResizeDistance,
    getSubtitleGuideSnap,
    scaleSubtitleFontSizeFromPointer,
  } = await import('../src/utils/subtitlePreferences.ts');

  const firstQuarter = getSubtitleGuideSnap(248, 1000, 10);
  assert.equal(firstQuarter?.index, 0);
  assert.equal(firstQuarter?.positionPx, 250);

  const firstThird = getSubtitleGuideSnap(338, 1000, 10);
  assert.equal(firstThird?.index, 1);
  assert.equal(Number(firstThird?.positionPx.toFixed(2)), 333.33);
  assert.equal(getSubtitleGuideSnap(290, 1000, 10), null);

  assert.equal(scaleSubtitleFontSizeFromPointer(24, 100, 150), 36);
  assert.equal(scaleSubtitleFontSizeFromPointer(24, 100, 50), 12);
  assert.equal(scaleSubtitleFontSizeFromPointer(40, 100, 200), 48);
  assert.equal(scaleSubtitleFontSizeFromPointer(24, 100, 101), 24);
  assert.equal(scaleSubtitleFontSizeFromPointer(24, 100, 104), 25);
  assert.equal(getDirectionalResizeDistance(50, 0, 100, 0, 1, 0, 80, 60), 0);
  assert.equal(getDirectionalResizeDistance(20, 20, 100, 100, 1, 1, 80, 60), 0);
  assert.equal(getDirectionalResizeDistance(180, 160, 100, 100, 1, 1, 80, 60), 100);
});

test('parses directly edited pixel values with localized decimals and bounds', async () => {
  const { parseSubtitlePixelInput } = await import('../src/utils/subtitlePreferences.ts');

  assert.equal(parseSubtitlePixelInput('31,6 px', 8, 48, 1), 32);
  assert.equal(parseSubtitlePixelInput('2.4', 0.5, 6, 0.5), 2.5);
  assert.equal(parseSubtitlePixelInput('999', 25, 900, 5), 900);
  assert.equal(parseSubtitlePixelInput('', 8, 48, 1), null);
  assert.equal(parseSubtitlePixelInput('px', 8, 48, 1), null);
});
