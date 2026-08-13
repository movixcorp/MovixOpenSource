import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WebView gates shim to Android API 26 and forwards native PiP presentation state', async () => {
  const source = await read('src/components/WebViewBrowser.tsx');

  assert.match(source, /Platform\.OS === 'android'/);
  assert.match(source, /Number\(Platform\.Version\) >= 26/);
  assert.match(source, /pictureInPictureEnabled/);
  assert.match(source, /startPictureInPictureEventForwarding/);
  assert.match(source, /onPictureInPictureModeChange/);
  assert.match(source, /event\.kind === 'prepare'[\s\S]*?onPictureInPictureModeChange\?\.\(true\)/);
  assert.match(source, /event\.kind === 'state'[\s\S]*?onPictureInPictureModeChange\?\.\(event\.active\)/);
  assert.match(source, /event\.kind === 'error'[\s\S]*?onPictureInPictureModeChange\?\.\(false\)/);
});

test('WebView teardown disables PiP eligibility, awake playback, and bridge capabilities', async () => {
  const source = await read('src/components/WebViewBrowser.tsx');

  assert.match(source, /clearBridgeCapabilities\(webViewRef\)/);
  assert.match(source, /stopCastStatusForwarding\(\)/);
  assert.match(source, /stopPictureInPictureForwarding\(\)/);
  assert.match(source, /setPictureInPicturePlaybackActive\(false\)/);
  assert.match(source, /setLocalPlaybackAwake\(false\)/);
});

test('WebView retains top-frame provenance and navigation capability invalidation', async () => {
  const source = await read('src/components/WebViewBrowser.tsx');

  assert.match(source, /const topLevelUrlRef = useRef\(url\)/);
  assert.match(
    source,
    /const sourceUrl = hasUsableReportedOrigin[\s\S]*?reportedSourceUrl[\s\S]*?isTopFrame[\s\S]*?topLevelUrlRef\.current[\s\S]*?: ''/,
  );
  assert.match(
    source,
    /request\.isTopFrame !== false[\s\S]*?isUsableHttpUrl\(request\.url\)[\s\S]*?topLevelUrlRef\.current = request\.url[\s\S]*?clearBridgeCapabilities\(webViewRef\)/,
  );
  assert.match(source, /isTopFrame:\s*event\.nativeEvent\.isTopFrame === true/);
  assert.match(
    source,
    /onShouldStartLoadWithRequest=\{\(request\)\s*=>\s*\{[\s\S]*?request\.isTopFrame !== false[\s\S]*?clearBridgeCapabilities\(webViewRef\)/,
  );
  assert.match(source, /goBack:[\s\S]*?clearBridgeCapabilities\(webViewRef\)/);
  assert.match(source, /goForward:[\s\S]*?clearBridgeCapabilities\(webViewRef\)/);
  assert.match(source, /reload:[\s\S]*?clearBridgeCapabilities\(webViewRef\)/);
  assert.match(source, /loadUrl:[\s\S]*?clearBridgeCapabilities\(webViewRef\)/);
});

test('BrowserScreen hides toolbar pill and inset while PiP is active', async () => {
  const source = await read('src/screens/BrowserScreen.tsx');

  assert.match(source, /isPictureInPictureActive/);
  assert.match(source, /onPictureInPictureModeChange/);
  assert.match(source, /!isPictureInPictureActive && !toolbarHidden/);
  assert.match(source, /!isPictureInPictureActive && navBarHidden/);
  // Fork Movix : le padding est piloté par `immersive`, qui regroupe le PiP
  // Android et la lecture plein écran iOS (cf. définition juste au-dessus du
  // rendu). `isPictureInPictureActive` en reste l'un des deux déclencheurs.
  assert.match(source, /const immersive =[\s\S]*?isPictureInPictureActive;/);
  assert.match(source, /immersive \? 0 : insets\.top/);
});

test('BrowserScreen closes and gates settings while PiP presentation is active', async () => {
  const source = await read('src/screens/BrowserScreen.tsx');

  assert.match(
    source,
    /const onPictureInPictureModeChange = useCallback\(\(active: boolean\) => \{[\s\S]*?if \(active\) \{[\s\S]*?setSettingsVisible\(false\);[\s\S]*?setIsPictureInPictureActive\(active\);[\s\S]*?\}, \[\]\);/,
  );
  assert.match(
    source,
    /<WebViewBrowser[\s\S]*?onPictureInPictureModeChange=\{onPictureInPictureModeChange\}/,
  );
  assert.match(source, /<Modal[\s\S]*?visible=\{!isPictureInPictureActive && settingsVisible\}/);
});

test('BrowserScreen cleanup disables PiP eligibility and awake playback', async () => {
  const source = await read('src/screens/BrowserScreen.tsx');

  assert.match(source, /setPictureInPicturePlaybackActive\(false\)/);
  assert.match(source, /setLocalPlaybackAwake\(false\)/);
});
