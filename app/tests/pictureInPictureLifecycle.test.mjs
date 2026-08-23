import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WebView selects explicit Android/iOS-v1 modes and only forwards active native PiP state', async () => {
  const source = await read('src/components/WebViewBrowser.tsx');

  assert.match(source, /Platform\.OS === 'android'/);
  assert.match(source, /Number\(Platform\.Version\) >= 26/);
  assert.match(source, /getPreparedNativePlaybackSourceProtocolVersion/);
  assert.match(source, /Platform\.OS === 'ios'[\s\S]*?=== 1/);
  assert.match(source, /pictureInPictureMode/);
  assert.match(source, /'disabled'/);
  assert.match(source, /'android'/);
  assert.match(source, /'ios-native-v1'/);
  assert.match(source, /startPictureInPictureEventForwarding/);
  assert.match(source, /onPictureInPictureModeChange/);
  assert.doesNotMatch(source, /event\.kind === 'prepare'[\s\S]*?onPictureInPictureModeChange\?\.\(true\)/);
  assert.match(source, /event\.kind === 'state'[\s\S]*?onPictureInPictureModeChange\?\.\(event\.active\)/);
  assert.match(source, /event\.kind === 'error'[\s\S]*?onPictureInPictureModeChange\?\.\(false\)/);
  assert.match(source, /allowsInlineMediaPlayback=\{true\}/);
  assert.match(source, /allowsPictureInPictureMediaPlayback=\{Platform\.OS === 'ios'\}/);
  assert.match(source, /mediaPlaybackRequiresUserAction=\{false\}/);
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
  assert.match(
    source,
    /typeof event\.nativeEvent\.isTopFrame === 'boolean'[\s\S]*?event\.nativeEvent\.isTopFrame[\s\S]*?: undefined/,
  );
  assert.match(source, /isTopFrame:\s*isTopFrame/);
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
  assert.match(source, /isPictureInPictureActive \? 0 : insets\.top/);
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
