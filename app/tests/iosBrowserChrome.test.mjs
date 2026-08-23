import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');

test('native browser chrome uses adaptive UIKit controls and SF Symbols', async () => {
  const [nativeChrome, manager] = await Promise.all([
    read('ios/Movix/UI/MovixBrowserChromeView.swift'),
    read('ios/Movix/UI/MovixBrowserChromeViewManager.m'),
  ]);

  for (const symbol of [
    'chevron.backward',
    'chevron.forward',
    'arrow.clockwise',
    'xmark',
    'house',
    'gearshape',
    'lock.fill',
  ]) {
    assert.ok(nativeChrome.includes(symbol), `missing SF Symbol ${symbol}`);
  }
  assert.match(nativeChrome, /UIButton\.Configuration/);
  assert.match(nativeChrome, /greaterThanOrEqualToConstant: 44/);
  assert.match(nativeChrome, /lessThanOrEqualToConstant: 720/);
  assert.match(nativeChrome, /horizontalSizeClass == \.regular/);
  assert.match(nativeChrome, /accessibilityLabel/);
  assert.match(nativeChrome, /DNS sécurisé activé/);
  assert.match(nativeChrome, /UIActivityIndicatorView/);
  assert.match(nativeChrome, /currentURL\.utf8\.count <= 4_096/);
  assert.match(nativeChrome, /UIColor\.label/);
  assert.match(nativeChrome, /UIColor\.secondaryLabel/);
  assert.doesNotMatch(nativeChrome, /#[0-9a-fA-F]{3,8}/);

  for (const prop of [
    'canGoBack',
    'canGoForward',
    'loading',
    'currentURL',
    'dnsEnabled',
    'showURLBar',
    'showNavBar',
  ]) {
    assert.match(manager, new RegExp(`RCT_EXPORT_VIEW_PROPERTY\\(${prop},`));
  }
  for (const event of ['onGoBack', 'onGoForward', 'onReload', 'onHome', 'onSettings']) {
    assert.match(manager, new RegExp(`RCT_EXPORT_VIEW_PROPERTY\\(${event}, RCTBubblingEventBlock\\)`));
  }
});

test('React Native wrapper maps toolbar props and events one-to-one', async () => {
  const wrapper = await read('src/components/ios/IOSBrowserToolbar.tsx');

  assert.match(wrapper, /requireNativeComponent<NativeProps>\('MovixBrowserChromeView'\)/);
  assert.match(wrapper, /Platform\.OS === 'ios'[\s\S]*Platform\.isPad[\s\S]*width >= 768/);
  for (const prop of [
    'canGoBack',
    'canGoForward',
    'loading',
    'currentURL',
    'dnsEnabled',
    'showURLBar',
    'showNavBar',
  ]) {
    assert.match(wrapper, new RegExp(`${prop}=`));
  }
  for (const event of ['onGoBack', 'onGoForward', 'onReload', 'onHome', 'onSettings']) {
    assert.match(wrapper, new RegExp(`${event}=\\{`));
  }
});

test('BrowserScreen selects native iOS chrome and preserves the Android toolbar', async () => {
  const screen = await read('src/screens/BrowserScreen.tsx');

  assert.match(screen, /Platform\.OS === 'ios'/);
  assert.match(screen, /<IOSBrowserToolbar/);
  assert.match(screen, /<BrowserToolbar/);
  assert.match(screen, /<NativeGlassSurface/);
  assert.match(screen, /<MiniPill/);
  assert.match(screen, /onReload=\{\(\) => webViewRef\.current\?\.reload\(\)\}/);
  assert.match(screen, /nextState === 'active'[\s\S]*AsyncStorage\.getItem\('dns_enabled'\)/);
});

test('MiniPill uses native glass only on iOS and remains a 44-point target', async () => {
  const pill = await read('src/components/MiniPill.tsx');

  assert.match(pill, /Platform\.OS === 'ios'/);
  assert.match(pill, /<NativeGlassSurface/);
  assert.match(pill, /minWidth: 44/);
  assert.match(pill, /minHeight: 44/);
});

test('Xcode compiles the native browser chrome sources', async () => {
  const project = await read('ios/Movix.xcodeproj/project.pbxproj');

  for (const source of [
    'MovixBrowserChromeView.swift',
    'MovixBrowserChromeViewManager.m',
  ]) {
    const sourceEntry = new RegExp(`${source.replace('.', '\\.')} in Sources`, 'g');
    assert.equal(project.match(sourceEntry)?.length, 2, `${source} must have a file and build entry`);
  }
  assert.match(project, /path = Movix\/UI;/);
});
