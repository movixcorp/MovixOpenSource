import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('manifest and activity expose PiP lifecycle', async () => {
  const [manifest, activity] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/java/com/movix/app/MainActivity.kt'),
  ]);
  assert.match(manifest, /android:supportsPictureInPicture="true"/);
  assert.match(activity, /onUserLeaveHint\(\)/);
  assert.match(activity, /onPictureInPictureRequested\(\)/);
  assert.match(activity, /onPictureInPictureModeChanged/);
  assert.match(activity, /onPictureInPictureUiStateChanged/);
  assert.match(activity, /isTransitioningToPip/);
  assert.match(activity, /PictureInPictureController/);
});

test('application registers the bounded native module', async () => {
  const [application, module, packageSource] = await Promise.all([
    read('android/app/src/main/java/com/movix/app/MainApplication.kt'),
    read('android/app/src/main/java/com/movix/app/pip/PictureInPictureModule.kt'),
    read('android/app/src/main/java/com/movix/app/pip/PictureInPicturePackage.kt'),
  ]);
  assert.match(application, /add\(PictureInPicturePackage\(\)\)/);
  assert.match(module, /override fun getName\(\) = "PictureInPicture"/);
  assert.match(module, /fun setPlaybackActive\(active: Boolean\)/);
  assert.match(module, /MOVIX_PICTURE_IN_PICTURE/);
  assert.match(packageSource, /PictureInPictureModule\(reactContext\)/);
});

test('module clears PiP playback on the UI thread before unsubscribing', async () => {
  const module = await read('android/app/src/main/java/com/movix/app/pip/PictureInPictureModule.kt');
  assert.match(
    module,
    /override fun invalidate\(\) \{\s*val activity = currentActivity as\? MainActivity\s*activity\?\.runOnUiThread \{\s*activity\.pictureInPictureController\.setPlaybackActive\(false\)\s*finishInvalidation\(\)\s*} \?: finishInvalidation\(\)\s*}/,
  );
  assert.match(
    module,
    /private fun finishInvalidation\(\) \{\s*unsubscribe\?\.invoke\(\)\s*context\.removeLifecycleEventListener\(this\)\s*super\.invalidate\(\)\s*}/,
  );
});

test('PiP host exposes three immutable package-local actions', async () => {
  const [manifest, host] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/java/com/movix/app/pip/AndroidPictureInPictureHost.kt'),
  ]);
  assert.match(host, /runCatching \{ actions\(playbackPlaying\) \}/);
  assert.match(host, /let\(builder::setActions\)/);
  assert.match(host, /FLAG_IMMUTABLE/);
  assert.match(host, /PictureInPictureActionReceiver::class\.java/);
  assert.match(host, /SEEK_BACKWARD/);
  assert.match(host, /TOGGLE_PLAYBACK/);
  assert.match(host, /SEEK_FORWARD/);
  assert.match(manifest, /PictureInPictureActionReceiver/);
  assert.match(manifest, /android:exported="false"/);
});

test('iOS native PiP defines a handoff-bound AVPlayer state machine', async () => {
  const [models, controller] = await Promise.all([
    read('ios/Movix/Playback/NativePlaybackModels.swift'),
    read('ios/Movix/Playback/NativePlaybackController.swift'),
  ]);

  assert.match(models, /preparedSourceProtocolVersion\s*=\s*1/);
  assert.match(models, /case\s+ready\(handoffId:\s*String\)/);
  assert.match(models, /case\s+restore\(handoffId:\s*String,\s*positionSec:\s*TimeInterval,\s*paused:\s*Bool\)/);
  assert.match(models, /PIP_SOURCE_NOT_OWNED/);
  assert.match(controller, /enum\s+State/);
  for (const state of ['idle', 'preparing', 'awaitingWebPause', 'entering', 'active', 'restoring']) {
    assert.match(controller, new RegExp(`case\\s+${state}`));
  }
  assert.match(controller, /acknowledgeWebViewPaused\(_\s+handoffId:\s*String\)/);
  assert.match(controller, /acknowledgeRestoreApplied\(_\s+handoffId:\s*String,\s*ok:\s*Bool\)/);
  assert.match(controller, /restoreUserInterfaceForPictureInPictureStop/);
  assert.match(controller, /notifyOthersOnDeactivation/);
  assert.doesNotMatch(controller, /player\.defaultRate/);
  assert.match(controller, /guard let controller = AVPictureInPictureController\(playerLayer: playerLayer\) else/);
  assert.match(controller, /pendingRestoreError/);
  assert.match(controller, /pendingRestoreCompletion/);
  assert.match(controller, /case let \.restoring\(currentID, _\) = state, currentID == handoffId/);
  assert.match(controller, /events\(\.restore\([\s\S]*?schedulePhaseTimeout/);
  assert.doesNotMatch(controller, /gate\.complete\(true\)[\s\S]*?beginRestoring/);
});

test('iOS PiP React module exposes the complete v1 handoff API and one event', async () => {
  const [swift, objc] = await Promise.all([
    read('ios/Movix/Playback/PictureInPictureModule.swift'),
    read('ios/Movix/Playback/PictureInPictureModule.m'),
  ]);

  assert.match(swift, /@objc\(PictureInPicture\)/);
  assert.match(swift, /RCTEventEmitter/);
  assert.match(swift, /"preparedSourceProtocolVersion"\s*:\s*PreparedNativePlaybackSource\.preparedSourceProtocolVersion/);
  assert.match(swift, /supportedEvents\(\).*\["MOVIX_PICTURE_IN_PICTURE"\]/s);
  for (const method of [
    'prepare',
    'acknowledgeWebViewPaused',
    'acknowledgeRestoreApplied',
    'cancel',
    'enter',
    'exit',
  ]) {
    assert.match(objc, new RegExp(`RCT_EXTERN_METHOD\\(${method}`));
  }
  assert.doesNotMatch(swift, /MediaProxyServer\.shared\.close/);
});

test('iOS PiP retains a canonical MediaProxy ownership lease and is wired to both targets', async () => {
  const [server, project] = await Promise.all([
    read('ios/Movix/Proxy/MediaProxyServer.swift'),
    read('ios/Movix.xcodeproj/project.pbxproj'),
  ]);

  assert.match(server, /retainForNativePlayback\(_\s+localURL:\s*URL\)\s+async\s*->\s*MediaProxyAccessLease\?/);
  assert.match(server, /localURL\.absoluteString\s*==\s*canonicalURL/);
  for (const file of [
    'NativePlaybackModels.swift',
    'NativePlaybackController.swift',
    'PictureInPictureModule.swift',
    'PictureInPictureModule.m',
    'NativePlaybackControllerTests.swift',
  ]) {
    assert.match(project, new RegExp(file.replace('.', '\\.')));
  }
  assert.match(project, /NativePlaybackControllerTests\.swift in Sources/);
});
