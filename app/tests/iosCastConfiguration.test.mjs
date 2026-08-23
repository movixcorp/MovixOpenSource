import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const sourceURL = path => new URL(path, import.meta.url);
const read = path => readFile(sourceURL(path), 'utf8');
const readIfPresent = async path => {
  try {
    return await read(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
};
const occurrences = (source, pattern) => source.match(pattern)?.length ?? 0;

async function assertValidPlist(path) {
  const absolutePath = fileURLToPath(sourceURL(path));

  if (process.platform === 'darwin') {
    await execFileAsync('/usr/bin/plutil', ['-lint', absolutePath]);
    return;
  }

  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; $path = [Environment]::GetEnvironmentVariable("MOVIX_PLIST_PATH"); [xml]$plist = Get-Content -Raw -LiteralPath $path; if ($null -eq $plist.plist.dict) { throw "Missing plist dictionary" }',
    ], {
      env: { ...process.env, MOVIX_PLIST_PATH: absolutePath },
    });
    return;
  }

  const xml = await read(path);
  const withoutMetadata = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const match of withoutMetadata.matchAll(/<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g)) {
    const token = match[0];
    const name = match[1];
    if (token.startsWith('</')) {
      assert.equal(stack.pop(), name, `XML closing tag ${name} must match its opening tag`);
    } else if (!token.endsWith('/>')) {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], 'XML tags must be balanced');
  assert.match(withoutMetadata, /^\s*<plist\b[\s\S]*<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>\s*$/);
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBalancedPBX(project) {
  const syntax = project
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const stack = [];
  const pairs = new Map([['}', '{'], [')', '(']]);
  for (const character of syntax) {
    if (character === '{' || character === '(') {
      stack.push(character);
    } else if (pairs.has(character)) {
      assert.equal(stack.pop(), pairs.get(character), `Unbalanced PBX delimiter: ${character}`);
    }
  }
  assert.deepEqual(stack, [], 'PBX delimiters must be balanced');
}

test('iOS pins the official Google Cast pod inside the Movix target', async () => {
  const podfile = await read('../ios/Podfile');
  const declarations = [...podfile.matchAll(/^\s*pod\s+['"]google-cast-sdk['"][^\r\n]*$/gm)]
    .map(match => match[0].trim());

  assert.deepEqual(declarations, ["pod 'google-cast-sdk', '~> 4.8.4'"]);
  assert.ok(
    podfile.indexOf("target 'Movix' do") < podfile.indexOf("pod 'google-cast-sdk', '~> 4.8.4'"),
    'Cast pod must be declared after the Movix target opens',
  );
  assert.ok(
    podfile.indexOf("pod 'google-cast-sdk', '~> 4.8.4'") < podfile.indexOf("target 'MovixTests' do"),
    'Cast pod must be declared in Movix before the inheriting test target',
  );
  assert.match(podfile, /target 'MovixTests' do\s+inherit! :complete\s+end/);
});

test('iOS declares the exact Google Cast Bonjour services in a valid plist', async () => {
  const plist = await read('../ios/Movix/Info.plist');
  await assertValidPlist('../ios/Movix/Info.plist');

  for (const key of ['NSBonjourServices', 'NSLocalNetworkUsageDescription', 'NSAllowsLocalNetworking']) {
    assert.equal(occurrences(plist, new RegExp(`<key>${key}<\\/key>`, 'g')), 1, `${key} must be unique`);
  }

  const servicesBlock = plist.match(/<key>NSBonjourServices<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  assert.ok(servicesBlock, 'NSBonjourServices array must exist');
  const services = [...servicesBlock.matchAll(/<string>([^<]+)<\/string>/g)].map(match => match[1]);
  assert.deepEqual(services, ['_googlecast._tcp', '_CC1AD845._googlecast._tcp']);
  assert.equal(
    servicesBlock.replace(/\s/g, ''),
    '<string>_googlecast._tcp</string><string>_CC1AD845._googlecast._tcp</string>',
  );
  assert.equal(occurrences(plist, /<string>_googlecast\._tcp<\/string>/g), 1);
  assert.equal(occurrences(plist, /<string>_CC1AD845\._googlecast\._tcp<\/string>/g), 1);
  assert.match(
    plist,
    /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>Movix utilise votre réseau local pour détecter votre Chromecast et lui transmettre la vidéo\.<\/string>/,
  );
  assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
});

test('CastBootstrap initializes the default receiver once and only on the main thread', async () => {
  const bootstrap = await readIfPresent('../ios/Movix/Cast/CastBootstrap.swift');

  assert.match(bootstrap, /import GoogleCast/);
  assert.match(bootstrap, /@objc\s+final class CastBootstrap:\s*NSObject/);
  assert.match(bootstrap, /@objc\s+static func configure\(\)/);
  assert.match(bootstrap, /guard Thread\.isMainThread else\s*\{/);
  assert.match(bootstrap, /DispatchQueue\.main\.async\s*\{/);
  assert.match(bootstrap, /private static var isConfigured = false/);
  assert.match(bootstrap, /guard !isConfigured else\s*\{\s*return\s*\}/);
  assert.match(bootstrap, /GCKDiscoveryCriteria\(applicationID:\s*kGCKDefaultMediaReceiverApplicationID\)/);
  assert.match(bootstrap, /GCKCastOptions\(discoveryCriteria:\s*criteria\)/);
  assert.match(bootstrap, /options\.stopReceiverApplicationWhenEndingSession\s*=\s*true/);
  assert.match(bootstrap, /options\.physicalVolumeButtonsWillControlDeviceVolume\s*=\s*false/);
  assert.match(bootstrap, /GCKCastContext\.sharedInstance\(\)\.useDefaultExpandedMediaControls\s*=\s*true/);
  assert.equal(occurrences(bootstrap, /GCKCastContext\.setSharedInstanceWith\(options\)/g), 1);

  const mainThreadGuard = bootstrap.indexOf('guard Thread.isMainThread else');
  const idempotenceGuard = bootstrap.indexOf('guard !isConfigured else');
  const markConfigured = bootstrap.indexOf('isConfigured = true');
  const initializeContext = bootstrap.indexOf('GCKCastContext.setSharedInstanceWith(options)');
  assert.ok(mainThreadGuard < idempotenceGuard, 'main-thread handoff must precede mutable bootstrap state');
  assert.ok(idempotenceGuard < markConfigured, 'idempotence guard must precede the configured flag');
  assert.ok(markConfigured < initializeContext, 'bootstrap must reserve initialization before touching the SDK');

  assert.doesNotMatch(bootstrap, /suspendSessionsWhenBackgrounded\s*=\s*false/);
  assert.doesNotMatch(bootstrap, /beginBackgroundTask|UIBackgroundTask|AVAudioSession/);
});

test('AppDelegate bootstraps Cast before React Native and super', async () => {
  const delegate = await read('../ios/Movix/AppDelegate.mm');

  assert.equal(occurrences(delegate, /^#import "Movix-Swift\.h"$/gm), 1);
  assert.equal(occurrences(delegate, /\[CastBootstrap configure\];/g), 1);
  assert.match(
    delegate,
    /didFinishLaunchingWithOptions:\(NSDictionary \*\)launchOptions\s*\{\s*\[CastBootstrap configure\];/,
  );

  const configure = delegate.indexOf('[CastBootstrap configure];');
  const reactNativeConfiguration = delegate.indexOf('self.moduleName = @"Movix";');
  const superLaunch = delegate.indexOf('[super application:application didFinishLaunchingWithOptions:launchOptions]');
  assert.ok(configure < reactNativeConfiguration, 'Cast must initialize before React Native configuration');
  assert.ok(configure < superLaunch, 'Cast must initialize before the React Native super implementation');
});

test('iOS exposes the React Native CastModule backed by the native relay and receiver client', async () => {
  const module = await readIfPresent('../ios/Movix/Cast/CastModule.swift');
  const bridge = await readIfPresent('../ios/Movix/Cast/CastModule.m');
  const project = await read('../ios/Movix.xcodeproj/project.pbxproj');

  assert.match(module, /@objc\(CastModule\)/);
  assert.match(module, /RCTEventEmitter/);
  assert.match(module, /GCKSessionManagerListener/);
  assert.match(module, /GCKRemoteMediaClientListener/);
  assert.match(module, /CastMediaPreparer/);
  assert.match(module, /CastNetworkSelector\.select/);
  assert.match(module, /presentCastDialog\(\)/);
  assert.match(module, /sendEvent\(withName:\s*"CAST_MEDIA_STATUS"/);

  // Parite Android (CastModule.kt/setOnDismissListener) : fermer le selecteur
  // sans choisir d'appareil doit rejeter la promesse au lieu de la laisser en
  // suspens, sinon le single-flight JS reste bloque jusqu'au rechargement.
  const dialog = module.indexOf('context?.presentCastDialog()');
  const watchdog = module.indexOf('armPickerWatchdog()', dialog);
  assert.notEqual(dialog, -1, 'loadProxiedMedia must present the Cast dialog');
  assert.notEqual(watchdog, -1, 'the Cast dialog must arm the picker watchdog');
  assert.match(module, /func cancelPickerWatchdog\(\)/);
  assert.match(module, /rejectPending\(\.pickerDismissed\)/);
  assert.match(module, /state == \.connecting \|\| state == \.connected/);
  assert.match(module, /cancelPickerWatchdog\(\)\s+let pending = pendingLoad/);
  for (const method of [
    'isSupported',
    'getCapabilities',
    'loadProxiedMedia',
    'getStatus',
    'play',
    'pause',
    'seekTo',
    'stop',
    'getRelayDisclosurePreference',
    'setRelayDisclosureSuppressed',
    'openBatterySettings',
    'requestRelayNotificationPermission',
  ]) {
    assert.match(module, new RegExp(`func ${method}\\b`), `${method} must be exported by CastModule`);
    assert.match(bridge, new RegExp(`RCT_EXTERN_METHOD\\(${method}\\b`), `${method} must be bridged to RN`);
  }
  assert.match(bridge, /RCT_EXTERN_MODULE\(CastModule,\s*RCTEventEmitter\)/);
  assert.equal(
    occurrences(project, /\/\* CastModule\.swift \*\/ = \{isa = PBXFileReference;/g),
    1,
  );
  assert.equal(
    occurrences(project, /\/\* CastModule\.m \*\/ = \{isa = PBXFileReference;/g),
    1,
  );
  assert.equal(occurrences(project, /CastModule\.swift in Sources/g), 2);
  assert.equal(occurrences(project, /CastModule\.m in Sources/g), 2);
});

test('Xcode wires CastBootstrap once into only the Movix Sources phase', async () => {
  const project = await read('../ios/Movix.xcodeproj/project.pbxproj');
  assertBalancedPBX(project);

  assert.equal(occurrences(project, /\/\* Cast \*\/ = \{\s*isa = PBXGroup;/g), 1);
  assert.equal(occurrences(project, /path = Movix\/Cast;/g), 1);
  assert.equal(
    occurrences(project, /\/\* CastBootstrap\.swift \*\/ = \{isa = PBXFileReference;[^\r\n]*path = CastBootstrap\.swift;/g),
    1,
  );
  assert.equal(
    occurrences(project, /\/\* CastBootstrap\.swift in Sources \*\/ = \{isa = PBXBuildFile;[^\r\n]*\/\* CastBootstrap\.swift \*\//g),
    1,
  );
  assert.equal(occurrences(project, /CastBootstrap\.swift in Sources/g), 2);

  const testSources = section(
    project,
    '00E356EA1AD99517003FC87E /* Sources */ = {',
    '13B07F871A680F5B00A75B9A /* Sources */ = {',
  );
  const appSources = section(
    project,
    '13B07F871A680F5B00A75B9A /* Sources */ = {',
    '/* End PBXSourcesBuildPhase section */',
  );
  assert.doesNotMatch(testSources, /CastBootstrap\.swift/);
  assert.equal(occurrences(appSources, /CastBootstrap\.swift in Sources/g), 1);

  assert.doesNotMatch(project, /GoogleCast[^\r\n]*(?:framework|xcframework)|google-cast-sdk/i);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.6;/);
  assert.match(project, /SWIFT_VERSION = 5\.0;/);
  assert.match(project, /TARGETED_DEVICE_FAMILY = "1,2";/);
});
