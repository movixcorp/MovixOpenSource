import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');

test('native glass chooses Liquid Glass only when available and honors accessibility', async () => {
  const swift = await read('ios/Movix/UI/MovixGlassEffectView.swift');

  assert.match(swift, /enum MovixGlassMaterialChoice: Equatable/);
  assert.match(swift, /if reduceTransparency \{ return \.opaque \}/);
  assert.match(swift, /if systemMajorVersion >= 26 \{ return \.liquidGlass \}/);
  assert.match(swift, /increaseContrast \? \.systemMaterial : \.systemThinMaterial/);
  assert.match(swift, /UIAccessibility\.isReduceTransparencyEnabled/);
  assert.match(swift, /UIAccessibility\.isDarkerSystemColorsEnabled/);
  assert.match(swift, /#available\(iOS 26\.0, \*\)/);
  assert.match(swift, /UIGlassEffect\(style: \.regular\)/);
  assert.match(swift, /effect\.isInteractive = interactive/);
  assert.match(swift, /UIColor\.tintColor\.withAlphaComponent\(0\.35\)/);
  assert.match(swift, /backgroundColor = \.secondarySystemBackground/);
  assert.doesNotMatch(swift, /#[0-9a-fA-F]{3,8}/);
});

test('native glass rebuilds for accessibility and validates its public props', async () => {
  const [swift, manager] = await Promise.all([
    read('ios/Movix/UI/MovixGlassEffectView.swift'),
    read('ios/Movix/UI/MovixGlassEffectViewManager.m'),
  ]);

  assert.match(swift, /reduceTransparencyStatusDidChangeNotification/);
  assert.match(swift, /darkerSystemColorsStatusDidChangeNotification/);
  assert.match(swift, /traitCollectionDidChange/);
  assert.match(swift, /value\.isFinite/);
  assert.match(swift, /\(0\.\.\.64\)\.contains\(value\)/);
  assert.match(swift, /clipsToBounds = true/);
  assert.match(manager, /RCT_EXPORT_MODULE\(MovixGlassEffectView\)/);
  for (const [name, type] of [
    ['interactive', 'BOOL'],
    ['prominent', 'BOOL'],
  ]) {
    assert.match(manager, new RegExp(`RCT_EXPORT_VIEW_PROPERTY\\(${name}, ${type}\\)`));
  }
  assert.match(manager, /RCT_CUSTOM_VIEW_PROPERTY\(cornerRadius, NSNumber, MovixGlassEffectView\)/);
  assert.match(manager, /isfinite\(radius\)/);
  assert.match(manager, /radius >= 0\.0 && radius <= 64\.0/);
});

test('React Native wrapper preserves children and degrades to a plain View off iOS', async () => {
  const wrapper = await read('src/components/ios/NativeGlassSurface.tsx');

  assert.match(wrapper, /PropsWithChildren/);
  assert.match(wrapper, /requireNativeComponent<Props>\('MovixGlassEffectView'\)/);
  assert.match(wrapper, /Platform\.OS !== 'ios'/);
  assert.match(wrapper, /return <View \{\.\.\.viewProps\} \/>/);
  assert.match(wrapper, /return <IOSGlass \{\.\.\.props\} \/>/);
});

test('Xcode compiles the glass view, manager, and focused XCTest', async () => {
  const [project, tests] = await Promise.all([
    read('ios/Movix.xcodeproj/project.pbxproj'),
    read('ios/MovixTests/MovixGlassEffectViewTests.swift'),
  ]);

  for (const source of [
    'MovixGlassEffectView.swift',
    'MovixGlassEffectViewManager.m',
    'MovixGlassEffectViewTests.swift',
  ]) {
    const sourceEntry = new RegExp(`${source.replace('.', '\\.')} in Sources`, 'g');
    assert.equal(project.match(sourceEntry)?.length, 2, `${source} must have a file and build entry`);
  }
  assert.match(project, /path = Movix\/UI;/);
  assert.match(tests, /testUsesFallbackMaterialBeforeIOS26/);
  assert.match(tests, /testDisablesTransparencyForAccessibility/);
  assert.match(tests, /testUsesHigherContrastFallbackMaterial/);
});
