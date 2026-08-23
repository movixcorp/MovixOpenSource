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
    if (character === '{' || character === '(') stack.push(character);
    if (pairs.has(character)) {
      assert.equal(stack.pop(), pairs.get(character), `Unbalanced PBX delimiter: ${character}`);
    }
  }
  assert.deepEqual(stack, []);
}

test('Cast models enforce bounded metadata, content types and valid UTF-8 WebVTT', async () => {
  const source = await read('../ios/Movix/Cast/CastModels.swift');

  assert.match(source, /enum CastRelayError: String, Error, Equatable, Sendable/);
  for (const code of [
    'MOVIX_CAST_SOURCE_INVALID',
    'MOVIX_CAST_CONTENT_TYPE_UNSUPPORTED',
    'MOVIX_CAST_TEXT_TRACK_INVALID',
    'MOVIX_CAST_TOO_MANY_TRACKS',
    'MOVIX_CAST_LOCAL_SOURCE_UNAVAILABLE',
  ]) assert.match(source, new RegExp(code));
  assert.match(source, /maximumTrackCount\s*=\s*16/);
  assert.match(source, /maximumInlineVTTBytes\s*=\s*2 \* 1_024 \* 1_024/);
  assert.match(source, /maximumLanguageCharacters\s*=\s*35/);
  assert.match(source, /maximumLabelCharacters\s*=\s*128/);
  assert.match(source, /Data\(.*\.utf8\)/s);
  assert.match(source, /WEBVTT/);
  assert.match(source, /validateCue/);
  assert.match(source, /MediaProxyPolicy\.validatePublicHTTPSURLSyntax/);
  assert.match(source, /MediaProxyPolicy\.sanitizeRequestHeaders/);
  assert.match(source, /application\/x-mpegurl/);
  assert.match(source, /video\/mp4/);
  assert.doesNotMatch(source, /localizedDescription|\bprint\(|NSLog/);
});

test('relay owns a cryptographic lifecycle session without an absolute TTL', async () => {
  const source = await read('../ios/Movix/Cast/CastRelayServer.swift');

  assert.match(source, /actor CastRelaySessionStore/);
  assert.match(source, /SecRandomCopyBytes/);
  assert.match(source, /tokenByteCount\s*=\s*32/);
  assert.match(source, /tokenCharacterCount\s*=\s*43/);
  assert.match(source, /final class CastRelayAccessBarrier/);
  assert.match(source, /func withValidAccess/);
  assert.match(source, /func revoke\(\)/);
  assert.match(source, /func invalidateAll\(\)/);
  assert.match(source, /maximumResources/);
  assert.doesNotMatch(source, /absoluteTTL|idleTTL|rotationLeadTime|processSecret/);
  assert.match(source, /\/cast\/\\\(registration\.sessionID\)\/\\\(registration\.resourceID\)/);
  assert.match(source, /!path\.contains\("%"\)/);
  assert.match(source, /!path\.contains\("\?"\)/);
  assert.match(source, /!path\.contains\("#"\)/);
});

test('listener binds only the selected address and rejects peers before reading', async () => {
  const source = await read('../ios/Movix/Cast/CastRelayServer.swift');

  assert.match(source, /protocol CastRelayListenerFactory/);
  assert.match(source, /requiredLocalEndpoint\s*=\s*\.hostPort/);
  assert.match(source, /port:\s*\.any/);
  assert.match(source, /NWListener\(using: parameters, on: \.any\)/);
  assert.match(source, /guard authorizePeer\(connection\.endpoint\) else \{\s*connection\.cancel\(\)/s);
  assert.match(source, /isIPv4Mapped/);
  assert.match(source, /clients\.count < Self\.maximumConcurrentClients/);
  assert.doesNotMatch(source, /0\.0\.0\.0|NWEndpoint\.Host\("::"\)|localhost/);
});

test('relay HTTP is strict and applies receiver-facing CORS and PNA itself', async () => {
  const source = await read('../ios/Movix/Cast/CastRelayServer.swift');

  assert.match(source, /MediaProxyHTTPParser\.parse/);
  assert.match(source, /method == "OPTIONS"/);
  assert.match(source, /OPTIONS.*204|statusCode:\s*204/s);
  assert.match(source, /Access-Control-Allow-Origin/);
  assert.match(source, /Access-Control-Allow-Methods/);
  assert.match(source, /GET, HEAD, OPTIONS/);
  assert.match(source, /Range, Accept-Encoding, Content-Type/);
  assert.match(source, /Content-Length, Content-Range, Accept-Ranges, Content-Type/);
  assert.match(source, /Access-Control-Request-Private-Network/);
  assert.match(source, /Access-Control-Allow-Private-Network/);
  assert.match(source, /Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network/);
  assert.match(source, /canonicalHTTPSOrigin/);
  assert.match(source, /components\.user == nil/);
  assert.match(source, /components\.password == nil/);
  assert.match(source, /upstreamCORSHeaderNames/);
});

test('relay reuses pinned upstream and HLS rewriting with bounded backpressure', async () => {
  const source = await read('../ios/Movix/Cast/CastRelayServer.swift');

  assert.match(source, /protocol CastRelayUpstreamOpening/);
  assert.match(source, /extension MediaProxyUpstream: CastRelayUpstreamOpening/);
  assert.match(source, /HLSPlaylistRewriter\.rewrite/);
  assert.match(source, /HLSPlaylistRewriter\.convertSubRipToWebVTT/);
  assert.match(source, /maximumPlaylistBytes\s*=\s*2 \* 1_024 \* 1_024/);
  assert.match(source, /maximumTextTrackBytes\s*=\s*2 \* 1_024 \* 1_024/);
  assert.match(
    source,
    /private func sendStreamingResponse[\s\S]*?while true \{[\s\S]*?lease\.withValidAccess[\s\S]*?guard let chunk = try await response\.body\.nextChunk\(\)/,
  );
  assert.match(source, /lease\.withValidAccess/);
  assert.match(source, /response\.body\.cancel\(\)/);
  assert.match(source, /Content-Range/);
  assert.match(source, /request\.method == "HEAD"/);
  assert.doesNotMatch(source, /URLSession\.shared|data\(contentsOf:/);
});

test('relay resource kinds make transformed HLS and text fail closed', async () => {
  const [models, relay] = await Promise.all([
    read('../ios/Movix/Cast/CastModels.swift'),
    read('../ios/Movix/Cast/CastRelayServer.swift'),
  ]);

  assert.match(models, /enum CastTextTrackFormat: String, Hashable, Sendable/);
  assert.match(relay, /enum CastRelayResourceKind: Hashable, Sendable/);
  assert.match(relay, /case hlsPlaylist/);
  assert.match(relay, /case automatic/);
  assert.match(relay, /case textTrack\(CastTextTrackFormat\)/);
  assert.match(relay, /let kind: CastRelayResourceKind/);
  assert.match(relay, /TargetKey\(normalized, kind: kind\)/);
  assert.match(relay, /registerRemote\([\s\S]*?rootTarget,[\s\S]*?kind: profile\.isHLS \? \.hlsPlaylist : \.media/);
  assert.match(relay, /registerRemote\([\s\S]*?target,[\s\S]*?kind: \.textTrack\(track\.format\)/);
  assert.match(relay, /guard response\.statusCode == 200 else/);
  assert.match(relay, /removingUnsafeTransformationHeaders/);
  assert.match(relay, /initialBody/);
});

test('preparer performs bounded pinned inspection before starting a relay', async () => {
  const [models, preparer] = await Promise.all([
    read('../ios/Movix/Cast/CastModels.swift'),
    read('../ios/Movix/Cast/CastMediaPreparer.swift'),
  ]);

  assert.match(models, /let hlsSegmentFormat: String\?/);
  assert.match(models, /let hlsVideoSegmentFormat: String\?/);
  assert.match(preparer, /protocol CastMediaInspecting: Sendable/);
  assert.match(preparer, /final class CastMediaInspector/);
  assert.match(preparer, /MediaProxyUpstream\(\)/);
  assert.match(preparer, /method: "HEAD"/);
  assert.match(preparer, /statusCode == 405 \|\| .*statusCode == 501/s);
  assert.match(preparer, /Range.*bytes=0-/s);
  assert.match(preparer, /maximumManifestBytes\s*=\s*512 \* 1_024/);
  assert.match(preparer, /maximumSegmentProbeBytes\s*=\s*64 \* 1_024/);
  assert.match(preparer, /#ext-x-map:/i);
  assert.match(preparer, /findRepresentativePlaylist/);
  assert.match(preparer, /findFirstMediaSegment/);
  assert.match(preparer, /withTaskCancellationHandler/);
  assert.match(preparer, /try await inspector\.inspect[\s\S]*try await relayFactory\.prepare/);
  assert.doesNotMatch(preparer, /URLSession\.shared|data\(contentsOf:/);
});

test('relay lifecycle is awaited, idempotent and stops on every required invalidation', async () => {
  const source = await read('../ios/Movix/Cast/CastRelayServer.swift');

  assert.match(source, /actor CastRelayStopGate/);
  assert.match(source, /func stop\(\) async/);
  assert.match(source, /sessionBarrier\.revoke\(\)/);
  assert.match(source, /CastNetworkPathMonitor/);
  assert.match(source, /CastNetworkSelector\.selectionStillValid/);
  assert.match(source, /receiverDidChange/);
  assert.match(source, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(source, /transitionToTerminalSynchronously/);
  assert.match(source, /stoppingOrStopped\s*=\s*true[\s\S]*sessionBarrier\.revoke\(\)/);
  assert.match(source, /notificationCenter\.removeObserver/);
  assert.doesNotMatch(source, /beginBackgroundTask|UIBackgroundTaskIdentifier|AVAudioSession|silent audio/i);
  assert.doesNotMatch(source, /\bprint\(|NSLog|os_log|Logger\(/);
});

test('preparer resolves owned loopback targets and leaves replacement switching to the coordinator', async () => {
  const [models, preparer] = await Promise.all([
    read('../ios/Movix/Cast/CastModels.swift'),
    read('../ios/Movix/Cast/CastMediaPreparer.swift'),
  ]);

  assert.match(preparer, /protocol MediaProxyCastResolving/);
  assert.match(preparer, /MediaProxyServer\.shared\.resolveForCast/);
  assert.match(preparer, /protocol CastRelayPreparing/);
  assert.match(preparer, /try await relayFactory\.prepare/);
  assert.match(preparer, /MediaProxyPolicy\.validatePublicHTTPSURLSyntax/);
  assert.match(preparer, /MediaProxyPolicy\.sanitizeRequestHeaders/);
  assert.doesNotMatch(preparer, /currentRelay|activeRelay|oldRelay|previousRelay/);
  assert.match(models, /struct PreparedCastRelay: Sendable/);
  assert.match(models, /let stop: @Sendable \(\) async -> Void/);
  assert.match(models, /struct PreparedCastTextTrack: Equatable, Sendable/);
});

test('XCTest sources cover security, streaming, lifecycle, duration and rollback behavior', async () => {
  const [relayTests, preparerTests] = await Promise.all([
    read('../ios/MovixTests/CastRelayServerTests.swift'),
    read('../ios/MovixTests/CastMediaPreparerTests.swift'),
  ]);
  const all = `${relayTests}\n${preparerTests}`;
  for (const coverage of [
    'testUnexpectedPeerIsCancelledBeforeFirstReadAndListenerBindsExactSelection',
    'testStrictRouteRejectsPercentQueryFragmentAndWrongTokenLengths',
    'testRootAndNestedHLSStayOnTheSameOpaqueSessionWithoutCDNLeaks',
    'testInlineAndRemoteTracksShareTheRootSession',
    'testRange206HeadOptionsCORSAndPrivateNetworkHeaders',
    'testInvalidCanonicalOriginIsRejectedWithoutOpeningUpstream',
    'testRemoteVTTAndSRTAreBoundedAndSRTUsesExistingConverter',
    'testPartialHLSAndTextResponsesFailClosedWithoutRemoteURLLeaks',
    'testDeclaredRemoteTrackTypesHandleExtensionlessGenericResponses',
    'testRevocationBeforeHeadersAndBetweenChunksCancelsTheUpstream',
    'testPathChangeReceiverChangeAndBackgroundStopTheRelay',
    'testLifecycleCallbacksSynchronouslyRevokeBeforeNewWorkAndSelfCancelDoesNotDeadlock',
    'testSessionRemainsLiveBeyondThirtyMinutesUntilExplicitStop',
    'testStopIsAwaitedExactAndIdempotent',
    'testPreparationFailureRollsBackEveryRegistration',
    'testInspectorHandlesExtensionlessProgressiveAndHeadFallbackWithBoundedRange',
    'testInspectorDetectsTransportStreamAndFMP4HLS',
    'testInspectorRejectsOversizedInvalidAndCancelledProbesBeforeRelayStart',
    'testPreparingReplacementDoesNotStopPreviouslyPreparedRelay',
    'testModelRejectsSeventeenTracksOversizedMetadataAndInvalidVTT',
  ]) assert.match(all, new RegExp(coverage));
  assert.match(all, /FakeCastRelayListenerFactory/);
  assert.match(all, /FakeCastRelayConnection/);
  assert.match(all, /FakeCastRelayUpstream/);
  assert.doesNotMatch(all, /192\.168\.1\.20:\d+\/cast.*URLSession|NWConnection\(to:/);
});

test('Xcode wires three Cast sources and two XCTest files into only intended phases', async () => {
  const project = await read('../ios/Movix.xcodeproj/project.pbxproj');
  assertBalancedPBX(project);

  for (const source of [
    'CastModels.swift',
    'CastRelayServer.swift',
    'CastMediaPreparer.swift',
    'CastRelayServerTests.swift',
    'CastMediaPreparerTests.swift',
  ]) {
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
  for (const source of ['CastModels.swift', 'CastRelayServer.swift', 'CastMediaPreparer.swift']) {
    assert.match(appSources, new RegExp(`${source.replace('.', '\\.')} in Sources`));
    assert.doesNotMatch(testSources, new RegExp(`${source.replace('.', '\\.') } in Sources`));
  }
  for (const source of ['CastRelayServerTests.swift', 'CastMediaPreparerTests.swift']) {
    assert.match(testSources, new RegExp(`${source.replace('.', '\\.')} in Sources`));
    assert.doesNotMatch(appSources, new RegExp(`${source.replace('.', '\\.') } in Sources`));
  }
});
