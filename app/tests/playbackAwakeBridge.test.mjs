import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');
const readOptional = relativePath => read(relativePath).catch(() => '');

async function loadPlaybackAwakeService(nativeModule) {
  const source = await read('src/services/playbackAwake.ts');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  const factory = vm.runInNewContext(
    `(function(require,module,exports){${outputText}\n})`,
    {},
  );
  factory(
    id => {
      assert.equal(id, 'react-native');
      return { NativeModules: { PlaybackAwake: nativeModule } };
    },
    module,
    module.exports,
  );
  return module.exports;
}

test('injected playback-awake shim posts one message only for active-state transitions and can force false', async () => {
  const shim = await read('src/injection/playback-awake-shim.ts');

  assert.match(shim, /MovixAndroidPlaybackAwake/);
  assert.match(shim, /PLAYBACK_AWAKE_SET/);
  assert.match(shim, /if \(active === lastActive\) return/);
  assert.match(shim, /setActive\(false\)/);
});

test('native bridge validates PLAYBACK_AWAKE_SET and updates awake and PiP eligibility together', async () => {
  const bridge = await read('src/services/bridge.ts');

  assert.match(bridge, /'PLAYBACK_AWAKE_SET'/);
  assert.match(bridge, /typeof p\.active === 'boolean'/);
  assert.match(bridge, /NativeModules\.PlaybackAwake/);
  assert.match(bridge, /setLocalPlaybackAwake\(p\.active\)/);
  assert.match(bridge, /setPictureInPicturePlaybackActive/);
  assert.match(bridge, /setPictureInPicturePlaybackActive\(p\.active\)/);
});

test('WebView and Browser lifecycle cleanup force the native awake state off', async () => {
  const [webView, browser] = await Promise.all([
    read('src/components/WebViewBrowser.tsx'),
    read('src/screens/BrowserScreen.tsx'),
  ]);

  assert.match(webView, /setLocalPlaybackAwake\(false\)/);
  assert.match(browser, /setLocalPlaybackAwake\(false\)/);
});

test('playback-awake owners are forwarded independently when the native owner API exists', async () => {
  const ownerCalls = [];
  const localCalls = [];
  const service = await loadPlaybackAwakeService({
    setLocalPlaybackAwake: active => localCalls.push(active),
    setPlaybackAwakeOwner: (owner, active) => ownerCalls.push([owner, active]),
  });

  service.setPlaybackAwakeOwner('local-playback', true);
  service.setPlaybackAwakeOwner('cast', true);
  service.setPlaybackAwakeOwner('local-playback', false);
  service.setPlaybackAwakeOwner('pip', true);
  service.setPlaybackAwakeOwner('cast', false);

  assert.deepEqual(ownerCalls, [
    ['local-playback', true],
    ['cast', true],
    ['local-playback', false],
    ['pip', true],
    ['cast', false],
  ]);
  assert.deepEqual(localCalls, []);
});

test('owner API falls back only for local playback on legacy native modules', async () => {
  const localCalls = [];
  const service = await loadPlaybackAwakeService({
    setLocalPlaybackAwake: active => localCalls.push(active),
  });

  service.setPlaybackAwakeOwner('local-playback', true);
  service.setPlaybackAwakeOwner('pip', true);
  service.setPlaybackAwakeOwner('cast', false);
  service.setLocalPlaybackAwake(false);

  assert.deepEqual(localCalls, [true, false]);
});

test('iOS native playback-awake module validates owners and serializes state on main', async () => {
  const [swift, objc, swiftTests] = await Promise.all([
    readOptional('ios/Movix/Playback/PlaybackAwakeModule.swift'),
    readOptional('ios/Movix/Playback/PlaybackAwakeModule.m'),
    readOptional('ios/MovixTests/PlaybackAwakeModuleTests.swift'),
  ]);

  assert.match(swift, /@objc\(PlaybackAwake\)/);
  assert.match(swift, /Set<String>/);
  assert.match(swift, /"local-playback"/);
  assert.match(swift, /\^\[a-z0-9-\]\{1,32\}\$/);
  assert.match(swift, /Thread\.isMainThread/);
  assert.match(swift, /DispatchQueue\.main\.async/);
  assert.match(swift, /UIApplication\.shared\.isIdleTimerDisabled/);
  assert.match(objc, /RCT_EXTERN_MODULE\(PlaybackAwake, NSObject\)/);
  assert.match(objc, /RCT_EXTERN_METHOD\(setLocalPlaybackAwake:/);
  assert.match(objc, /RCT_EXTERN_METHOD\(setPlaybackAwakeOwner:/);
  assert.match(swiftTests, /testReleasingOneOwnerKeepsTheOtherOwnersAwake/);
  assert.match(swiftTests, /testInvalidOwnersCannotChangeAwakeState/);
  assert.match(swiftTests, /testOwnerMutationRunsOnTheMainThread/);
});

test('cast and PiP claim their own awake owner around the local playback one', async () => {
  const bridge = await read('src/services/bridge.ts');

  // Le Cast diffuse depuis le telephone : eteindre l'ecran suspend le relais.
  assert.match(bridge, /CAST_AWAKE_STATES = new Set<NativeCastStatus\['state'\]>/);
  for (const state of ['loading', 'buffering', 'playing']) {
    assert.match(bridge, new RegExp(`'${state}'`), state);
  }
  assert.match(
    bridge,
    /setPlaybackAwakeOwner\(\s*'cast',\s*status\.connected && CAST_AWAKE_STATES\.has\(status\.state\),?\s*\)/,
  );
  assert.match(bridge, /setPlaybackAwakeOwner\('cast', false\)/);

  // Le handoff PiP met la WebView en pause, ce qui relache 'local-playback'.
  assert.match(
    bridge,
    /if \(event\.kind === 'state'\) setPlaybackAwakeOwner\('pip', event\.active\)/,
  );
  assert.match(
    bridge,
    /if \(event\.kind === 'error'\) setPlaybackAwakeOwner\('pip', false\)/,
  );
  assert.match(bridge, /setPlaybackAwakeOwner\('pip', false\)/);

  // Les deux proprietaires doivent etre relaches quand l'abonnement s'arrete.
  for (const section of ['startCastShimEventForwarding', 'startPictureInPictureEventForwarding']) {
    const start = bridge.indexOf(`export function ${section}`);
    const end = bridge.indexOf('\nexport ', start + 1);
    const body = bridge.slice(start, end === -1 ? bridge.length : end);
    assert.match(body, /return \(\) => \{\s+stop\(\);\s+setPlaybackAwakeOwner\(/, section);
  }
});

test('Android native playback-awake module mirrors the iOS owner semantics', async () => {
  const [kotlin, kotlinTests] = await Promise.all([
    readOptional(
      'android/app/src/main/java/com/movix/app/playback/PlaybackAwakeModule.kt',
    ),
    readOptional(
      'android/app/src/test/java/com/movix/app/playback/PlaybackAwakeModuleTest.kt',
    ),
  ]);

  assert.match(kotlin, /@ReactMethod\s+fun setLocalPlaybackAwake/);
  assert.match(kotlin, /@ReactMethod\s+fun setPlaybackAwakeOwner/);
  assert.match(kotlin, /ALLOWED_OWNERS = setOf\(LOCAL_PLAYBACK_OWNER, "pip", "cast"\)/);
  assert.match(kotlin, /\^\[a-z0-9-\]\{1,32\}\$/);
  assert.match(kotlin, /owners\.isNotEmpty\(\)/);
  assert.match(kotlin, /synchronized\(lock\)/);
  assert.match(kotlin, /FLAG_KEEP_SCREEN_ON/);
  assert.match(kotlinTests, /releasing one owner keeps the other owners awake/);
  assert.match(kotlinTests, /invalid owners cannot change the awake state/);
  assert.match(kotlinTests, /invalidate drops every owner/);
});
