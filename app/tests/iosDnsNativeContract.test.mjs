import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');

function methodSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test('iOS DNS module exports the existing promise API', async () => {
  const [swift, objc] = await Promise.all([
    read('ios/Movix/Dns/DnsModuleSwift.swift'),
    read('ios/Movix/Dns/DnsModule.m'),
  ]);

  assert.match(swift, /@objc\(DnsModule\)/);
  assert.match(swift, /func enable\(/);
  assert.match(swift, /func disable\(/);
  assert.match(swift, /func isEnabled\(/);
  assert.match(objc, /RCT_EXTERN_METHOD\(enable:/);
  assert.match(objc, /RCT_EXTERN_METHOD\(disable:/);
  assert.match(objc, /RCT_EXTERN_METHOD\(isEnabled:/);
});

test('DNS enable validates literal servers and an HTTPS DoH endpoint', async () => {
  const manager = await read('ios/Movix/Dns/DnsManager.swift');

  assert.match(manager, /IPv4Address\(server\)/);
  assert.match(manager, /IPv6Address\(server\)/);
  assert.match(manager, /DNS_INVALID_SERVER/);
  assert.match(manager, /https:\/\/cloudflare-dns\.com\/dns-query/);
  assert.match(manager, /scheme\?\.lowercased\(\) == "https"/);
});

test('DNS mutations load persisted preferences before changing them', async () => {
  const manager = await read('ios/Movix/Dns/DnsManager.swift');
  const enable = methodSection(manager, 'static func enable(', 'static func disable(');
  const disable = methodSection(manager, 'static func disable(', 'static func isEnabled(');

  const enableLoad = enable.indexOf('loadFromPreferences');
  const settingsMutation = enable.indexOf('manager.dnsSettings =');
  const save = enable.indexOf('saveToPreferences');
  assert.notEqual(enableLoad, -1);
  assert.ok(settingsMutation > enableLoad);
  assert.ok(save > settingsMutation);
  assert.doesNotMatch(enable, /manager\.isEnabled\s*=/);
  assert.match(enable, /saveToPreferences[\s\S]*loadFromPreferences[\s\S]*manager\.isEnabled/);

  const disableLoad = disable.indexOf('loadFromPreferences');
  const remove = disable.indexOf('removeFromPreferences');
  assert.notEqual(disableLoad, -1);
  assert.ok(remove > disableLoad);
});

test('DNS uses the documented network-extension entitlement shape', async () => {
  const entitlements = await read('ios/Movix/Movix.entitlements');

  assert.match(
    entitlements,
    /<key>com\.apple\.developer\.networking\.networkextension<\/key>\s*<array>\s*<string>dns-settings<\/string>\s*<\/array>/,
  );
  assert.doesNotMatch(entitlements, /com\.apple\.developer\.networking\.dns-settings/);
});

test('iOS DNS setup reports actual system activation instead of claiming success', async () => {
  const [app, settings] = await Promise.all([
    read('src/App.tsx'),
    read('src/screens/SettingsScreen.tsx'),
  ]);

  assert.match(app, /const dnsActivated = await DnsModule\.enable/);
  assert.match(app, /dnsActivated \? 'true' : 'false'/);
  assert.match(settings, /const dnsActivated = await DnsModule\.enable/);
  assert.match(settings, /Platform\.OS === 'ios' && !dnsActivated/);
  assert.doesNotMatch(app, /Linking\.openSettings\(\)/);
  assert.doesNotMatch(settings, /Linking\.openSettings\(\)/);
  assert.match(app, /Réglages[^']*Général[^']*DNS/);
  assert.match(settings, /Réglages[^']*Général[^']*DNS/);
  assert.match(app, /AppState\.addEventListener\('change'/);
  assert.match(settings, /AppState\.addEventListener\('change'/);
  assert.match(settings, /if \(nextState === 'active'\)/);
  assert.match(settings, /await DnsModule\.isEnabled\(\)/);
  assert.doesNotMatch(settings, /await DnsModule\.enable[^;]+;\s*setDnsStatus\('active'\)/s);
});

test('DNS promise completion is exactly-once with stable public error codes', async () => {
  const manager = await read('ios/Movix/Dns/DnsManager.swift');

  for (const code of [
    'DNS_INVALID_SERVER',
    'DNS_LOAD_FAILED',
    'DNS_SAVE_FAILED',
    'DNS_REMOVE_FAILED',
  ]) {
    assert.match(manager, new RegExp(`"${code}"`));
  }
  assert.doesNotMatch(manager, /"DNS_ERROR"/);
  assert.doesNotMatch(manager, /localizedDescription/);
  assert.match(manager, /final class DnsPromiseCompletion/);
  assert.match(manager, /NSLock\(\)/);
  assert.match(manager, /guard !completed else \{ return false \}/);
});

test('DNS isEnabled accepts only enabled persisted DoH settings with HTTPS URL', async () => {
  const manager = await read('ios/Movix/Dns/DnsManager.swift');
  const isEnabled = manager.slice(manager.indexOf('static func isEnabled('));

  assert.match(isEnabled, /loadFromPreferences/);
  assert.match(isEnabled, /manager\.isEnabled/);
  assert.match(isEnabled, /as\? NEDNSOverHTTPSSettings/);
  assert.match(isEnabled, /serverURL/);
  assert.match(isEnabled, /scheme\?\.lowercased\(\) == "https"/);
  assert.match(isEnabled, /completion\.reject\(\.loadFailed\)/);
});

test('iOS project compiles the PlaybackAwake bridge and its XCTest', async () => {
  const [project, module, tests] = await Promise.all([
    read('ios/Movix.xcodeproj/project.pbxproj'),
    read('ios/Movix/Playback/PlaybackAwakeModule.swift'),
    read('ios/MovixTests/PlaybackAwakeModuleTests.swift'),
  ]);

  assert.match(project, /path = Movix\/Playback;/);
  for (const source of [
    'PlaybackAwakeModule.swift',
    'PlaybackAwakeModule.m',
    'PlaybackAwakeModuleTests.swift',
  ]) {
    const sourceEntry = new RegExp(`${source.replace('.', '\\.')} in Sources`, 'g');
    assert.equal(project.match(sourceEntry)?.length, 2);
  }

  assert.match(module, /@objc func invalidate\(\)/);
  assert.match(module, /owners\.removeAll\(\)/);
  assert.match(module, /setIdleTimerDisabled\(false\)/);
  assert.match(module, /guard !invalidated else \{ return \}/);
  const invalidate = methodSection(module, '@objc func invalidate()', 'private func setOwner');
  assert.doesNotMatch(invalidate, /\[weak self\]/);
  assert.match(invalidate, /DispatchQueue\.main\.async\s*\{\s*self\.invalidate\(\)/);
  assert.match(tests, /testInvalidateReleasesEveryOwnerAndRejectsLateMutations/);
});
