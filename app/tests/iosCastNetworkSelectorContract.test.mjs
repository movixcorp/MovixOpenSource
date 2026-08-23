import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const occurrences = (source, pattern) => source.match(pattern)?.length ?? 0;

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

test('Cast network models keep parsed addresses, prefix and active interface state', async () => {
  const source = await read('../ios/Movix/Cast/CastNetworkSelector.swift');

  assert.match(source, /struct LocalInterfaceAddress: Equatable, Sendable/);
  assert.match(source, /let address: MediaProxyIPAddress/);
  assert.match(source, /let prefixLength: Int/);
  assert.match(source, /let type: LocalInterfaceType/);
  assert.match(source, /let isUp: Bool/);
  assert.match(source, /let isRunning: Bool/);
  assert.match(source, /struct CastNetworkSelection: Equatable, Sendable/);
  assert.match(source, /let receiverAddress: MediaProxyIPAddress/);
  assert.match(source, /struct CastRouteSnapshot: Equatable, Sendable/);
});

test('Cast selector uses subnet masks, longest prefix and stable tie breakers', async () => {
  const source = await read('../ios/Movix/Cast/CastNetworkSelector.swift');

  assert.match(source, /static func select\(/);
  assert.match(source, /candidate\.type == \.wifi/);
  assert.match(source, /candidate\.isUp && candidate\.isRunning/);
  assert.match(source, /sameSubnet\(/);
  assert.match(source, /UInt8\.max << \(8 - remainingBits\)/);
  assert.doesNotMatch(source, /UInt8\(0xff << \(8 - remainingBits\)\)/);
  assert.match(source, /candidate\.address != receiverAddress/);
  assert.match(source, /lhs\.prefixLength != rhs\.prefixLength/);
  assert.match(source, /lhs\.name != rhs\.name/);
  assert.match(source, /lexicographicallyPrecedes/);
  assert.match(source, /selectionStillValid\(/);
  assert.doesNotMatch(source, /"en0"/);
});

test('Cast selector rejects non-unicast, mapped and scoped addresses and brackets IPv6', async () => {
  const source = await read('../ios/Movix/Cast/CastNetworkSelector.swift');

  assert.match(source, /invalidReceiverAddress/);
  assert.match(source, /unusableReceiverAddress/);
  assert.match(source, /noUsableWiFiRoute/);
  assert.match(source, /isIPv4MappedOrCompatible/);
  assert.match(source, /isUsableUnicast/);
  assert.match(source, /isUsableIPv4Host/);
  assert.match(source, /localURLAuthorityHost/);
  assert.ok(source.includes(String.raw`return "[\(literal)]"`));
  assert.doesNotMatch(source, /MediaProxyPolicy\.isForbiddenAddress/);
});

test('production collector crosses active NWPath Wi-Fi interfaces with getifaddrs', async () => {
  const source = await read('../ios/Movix/Cast/CastNetworkSelector.swift');

  assert.match(source, /import Network/);
  assert.match(source, /NWPathMonitor\(requiredInterfaceType: \.wifi\)/);
  assert.match(source, /path\.status == \.satisfied/);
  assert.match(source, /path\.usesInterfaceType\(\.wifi\)/);
  assert.match(source, /path\.availableInterfaces/);
  assert.match(source, /getifaddrs\(/);
  assert.match(source, /freeifaddrs\(/);
  assert.match(source, /IFF_UP/);
  assert.match(source, /IFF_RUNNING/);
  assert.match(source, /getnameinfo\(/);
  assert.match(source, /final class CastNetworkSnapshotDelivery/);
  assert.match(source, /DispatchQueue\.getSpecific\(key:/);
  assert.match(source, /queue\.sync/);
  assert.match(source, /delivery\.cancel\(\)/);
  assert.match(source, /delivery\.synchronized\s*\{/);
  assert.match(source, /self\.delivery\.deliver\s*\{/);
  assert.doesNotMatch(source, /private let stateLock|self\.isActive/);
});

test('XCTest covers route, subnet, address safety, lifecycle and arbitrary Wi-Fi names', async () => {
  const tests = await read('../ios/MovixTests/CastNetworkSelectorTests.swift');

  for (const coverage of [
    'testSelectsOnlyActiveRunningWiFiOnTheReceiverSubnet',
    'testRejectsSameFamilyAddressesOnDifferentSubnets',
    'testRejectsAddressFamilyMismatch',
    'testChoosesLongestPrefixBeforeDeterministicInterfaceOrdering',
    'testSelectsIPv4SubnetsWithNonByteAlignedPrefixes',
    'testSelectsIPv6SubnetsWithNonByteAlignedPrefixes',
    'testRejectsTheLocalAddressAsReceiverForHostRoutes',
    'testBreaksEqualPrefixTiesByInterfaceNameThenAddressBytes',
    'testSelectsIPv6ULAAndFormatsBracketedURLAuthority',
    'testRejectsInvalidScopedAndIPv4MappedReceiverAddresses',
    'testRejectsUnspecifiedLoopbackLinkLocalMulticastAndReservedAddresses',
    'testRejectsIPv4NetworkAndDirectedBroadcastHosts',
    'testSelectionStillValidRequiresTheExactBestRoute',
    'testCollectorUsesArbitraryActiveWiFiNamesAndPreservesInterfaceState',
    'testDeliveryCancelWaitsForAnAdmittedHandlerAndRejectsLaterDelivery',
    'testDeliveryCanCancelFromItsOwnHandlerWithoutDeadlockOrRedelivery',
  ]) {
    assert.match(tests, new RegExp(coverage));
  }
  assert.match(tests, /wifi42/);
  assert.match(tests, /fd12:3456:789a:1::20/);
  assert.match(tests, /::ffff:192\.168\.1\.40/);
  assert.match(tests, /fe80::1%wifi42/);
  for (const prefix of [23, 25, 31, 65, 127, 32, 128]) {
    assert.match(tests, new RegExp(`(?:prefix|prefixLength): ${prefix}`));
  }
});

test('Xcode wires selector and tests into only their intended Sources phases', async () => {
  const project = await read('../ios/Movix.xcodeproj/project.pbxproj');
  assertBalancedPBX(project);

  for (const source of ['CastNetworkSelector.swift', 'CastNetworkSelectorTests.swift']) {
    const escaped = source.replace('.', '\\.');
    assert.equal(occurrences(project, new RegExp(`/\\* ${escaped} \\*/ = \\{isa = PBXFileReference;`, 'g')), 1);
    assert.equal(occurrences(project, new RegExp(`${escaped} in Sources`, 'g')), 2);
  }

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

  assert.match(testSources, /CastNetworkSelectorTests\.swift in Sources/);
  assert.doesNotMatch(testSources, /CastNetworkSelector\.swift in Sources/);
  assert.match(appSources, /CastNetworkSelector\.swift in Sources/);
  assert.doesNotMatch(appSources, /CastNetworkSelectorTests\.swift in Sources/);
});
