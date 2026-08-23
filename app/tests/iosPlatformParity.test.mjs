import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const ts = require('typescript');

class ReactNativePartialURL {
  constructor(url) {
    this.value = url.endsWith('/') ? url : `${url}/`;
  }

  get href() {
    return this.value;
  }

  toString() {
    return this.value;
  }
}

for (const accessor of [
  'hash',
  'host',
  'hostname',
  'origin',
  'password',
  'pathname',
  'port',
  'protocol',
  'search',
  'username',
]) {
  Object.defineProperty(ReactNativePartialURL.prototype, accessor, {
    configurable: true,
    get() {
      throw new Error(`URL.${accessor} is not implemented`);
    },
  });
}

async function loadUpdateHelpersWithReactNativeURL() {
  const source = await read('../src/hooks/useAppUpdate.ts');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const context = vm.createContext({
    AbortController,
    URL: ReactNativePartialURL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    require: specifier => {
      if (specifier === 'react') return {};
      if (specifier === 'react-native') {
        return { AppState: { currentState: 'active' }, Platform: { OS: 'ios' } };
      }
      if (specifier === '@react-native-async-storage/async-storage') {
        return { __esModule: true, default: {} };
      }
      return {};
    },
    setTimeout,
  });
  new vm.Script(compiled, { filename: 'useAppUpdate.compiled.cjs' }).runInContext(
    context,
  );
  return module.exports;
}

function exportedFunction(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing exported function ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertNativeCallIsAndroidGuarded(source, name) {
  const body = exportedFunction(source, name);
  const guard = body.search(/if\s*\(Platform\.OS !== 'android'\)/);
  const nativeCall = body.search(
    name === 'pollUntilDone' ? /await queryDownload\(/ : /ensureModule\(\)/,
  );

  assert.notEqual(guard, -1, `${name} must reject non-Android callers`);
  assert.notEqual(nativeCall, -1, `${name} must retain its Android implementation`);
  assert.ok(guard < nativeCall, `${name} must guard before accessing UpdateModule`);
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker ${endMarker}`);
  return source.slice(start, end);
}

function assertCallFollowsAndroidGuard(section, call) {
  const guard = section.indexOf("if (Platform.OS !== 'android') return;");
  const invocation = section.indexOf(call);
  assert.notEqual(guard, -1, `${call} must have an Android guard`);
  assert.notEqual(invocation, -1, `missing ${call}`);
  assert.ok(guard < invocation, `${call} must remain inside the Android branch`);
}

test('iOS forwards deep links and never invokes the APK installer', async () => {
  const [
    appDelegate,
    infoPlist,
    updateHook,
    updateScreen,
    apkInstaller,
    downloader,
  ] = await Promise.all([
    read('../ios/Movix/AppDelegate.mm'),
    read('../ios/Movix/Info.plist'),
    read('../src/hooks/useAppUpdate.ts'),
    read('../src/screens/UpdateScreen.tsx'),
    read('../src/services/apkInstaller.ts'),
    read('../src/services/updateDownloader.ts'),
  ]);

  assert.match(appDelegate, /#import <React\/RCTLinkingManager\.h>/);
  assert.match(
    appDelegate,
    /RCTLinkingManager application:application openURL:url options:options/,
  );
  assert.match(appDelegate, /continueUserActivity/);
  assert.match(appDelegate, /\[CastBootstrap configure\]/);
  assert.match(appDelegate, /return \[super application:application/);
  assert.match(infoPlist, /<key>CFBundleURLTypes<\/key>/);
  assert.match(infoPlist, /<string>movix<\/string>/);

  assert.match(updateHook, /Platform\.OS === 'ios'/);
  assert.match(updateHook, /Platform\.OS !== 'android'/);
  assert.match(updateHook, /isValidHttpsUpdateUrl/);
  assert.match(updateHook, /function parseHttpsUpdateUrl/);
  assert.match(updateHook, /authority\.includes\('@'\)/);
  assert.match(updateHook, /RAW_CONTROL_RE/);
  assert.doesNotMatch(updateHook, /new URL\(/);
  assert.match(updateHook, /releases\/latest/);
  assert.match(updateScreen, /Télécharger l’IPA/);
  assert.match(updateScreen, /Linking\.canOpenURL/);
  assert.match(updateScreen, /Linking\.openURL/);
  assert.match(updateScreen, /import \{ isValidHttpsUpdateUrl \}/);
  assert.doesNotMatch(updateScreen, /new URL\(/);
  assert.doesNotMatch(updateScreen, /installer automatiquement/i);

  assert.match(apkInstaller, /Platform\.OS !== 'android'/);
  assert.match(downloader, /Platform\.OS !== 'android'/);

  for (const name of [
    'getLocalVersionCode',
    'getLocalVersionName',
    'canInstallApks',
    'openInstallSettings',
    'installApk',
  ]) {
    assertNativeCallIsAndroidGuarded(apkInstaller, name);
  }

  for (const name of [
    'enqueueDownload',
    'queryDownload',
    'cancelDownload',
    'computeSha256',
    'pollUntilDone',
  ]) {
    assertNativeCallIsAndroidGuarded(downloader, name);
  }

  const accept = sourceSection(updateHook, 'const accept =', 'const cancel =');
  const cancel = sourceSection(updateHook, 'const cancel =', 'const openSettings =');
  const settings = sourceSection(updateHook, 'const openSettings =', 'const retry =');
  assertCallFollowsAndroidGuard(accept, 'canInstallApks()');
  assertCallFollowsAndroidGuard(accept, 'beginDownload(manifest)');
  assertCallFollowsAndroidGuard(cancel, 'cancelDownload(');
  assertCallFollowsAndroidGuard(cancel, 'AsyncStorage.removeItem(');
  assertCallFollowsAndroidGuard(settings, 'openInstallSettings()');
});

test('iOS update URLs work with the partial React Native URL global', async () => {
  const { isValidHttpsUpdateUrl, releasePageUrl } =
    await loadUpdateHelpersWithReactNativeURL();
  const repository = 'https://github.com/Movix-STMG/MovixOpenSource';

  assert.equal(isValidHttpsUpdateUrl(repository), true);
  assert.equal(
    releasePageUrl(`${repository}/?source=mobile#download`),
    `${repository}/releases/latest`,
  );

  for (const unsafe of [
    'http://github.com/Movix-STMG/MovixOpenSource',
    'https://user:password@github.com/Movix-STMG/MovixOpenSource',
    'https://github.com/Movix-STMG/\u0000MovixOpenSource',
    'https://github.com/Movix-STMG/%00MovixOpenSource',
    'https://github.com/Movix-STMG/MovixOpenSource\\redirect',
    'https://github.com:99999/Movix-STMG/MovixOpenSource',
  ]) {
    assert.equal(isValidHttpsUpdateUrl(unsafe), false, unsafe);
  }
});

test('semantic versions reject numeric prerelease leading zeroes', async () => {
  const { isNewerSemanticVersion } =
    await loadUpdateHelpersWithReactNativeURL();

  assert.equal(isNewerSemanticVersion('2.5.13-0', '2.5.12'), true);
  assert.equal(isNewerSemanticVersion('2.5.13-01', '2.5.12'), false);
  assert.equal(isNewerSemanticVersion('2.5.13-01a', '2.5.12'), true);
  assert.equal(isNewerSemanticVersion('2.5.13+build.7', '2.5.12'), true);
  assert.equal(isNewerSemanticVersion('2.5.13', '2.5.13-rc.1'), true);
  assert.equal(isNewerSemanticVersion('2.5.13-rc.1', '2.5.13'), false);
});
