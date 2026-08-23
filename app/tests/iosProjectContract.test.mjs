import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const text = path => readFile(new URL(path, import.meta.url), 'utf8');
const missing = async path => {
  await assert.rejects(access(new URL(path, import.meta.url)), { code: 'ENOENT' });
};

test('iOS release metadata uses the canonical Movix values', async () => {
  const appJson = JSON.parse(await text('../app.json'));

  assert.equal(appJson.name, 'Movix');
  assert.equal(appJson.displayName, 'Movix');
  assert.equal(appJson.version, '2.5.14');
  assert.equal(appJson.buildNumber, '23');
});

test('iOS project uses the canonical Movix identity', async () => {
  const [appJson, podfile, project, scheme, info, entitlements] = await Promise.all([
    text('../app.json'),
    text('../ios/Podfile'),
    text('../ios/Movix.xcodeproj/project.pbxproj'),
    text('../ios/Movix.xcodeproj/xcshareddata/xcschemes/Movix.xcscheme'),
    text('../ios/Movix/Info.plist'),
    text('../ios/Movix/Movix.entitlements'),
  ]);

  assert.equal(JSON.parse(appJson).name, 'Movix');
  assert.match(podfile, /target 'Movix' do/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.movix\.app;/);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.6;/);
  assert.match(project, /TARGETED_DEVICE_FAMILY = "1,2";/);
  assert.match(project, /PRODUCT_NAME = Movix;/);
  assert.match(project, /MARKETING_VERSION = 2\.5\.14;/);
  assert.match(project, /CURRENT_PROJECT_VERSION = 23;/);
  assert.match(project, /INFOPLIST_FILE = Movix\/Info\.plist;/);
  assert.match(project, /CODE_SIGN_ENTITLEMENTS = Movix\/Movix\.entitlements;/);
  assert.match(project, /SWIFT_OBJC_BRIDGING_HEADER = "?Movix\/Movix-Bridging-Header\.h"?;/);
  assert.match(project, /SWIFT_VERSION = 5\.0;/);
  for (const source of ['main.m', 'AppDelegate.mm', 'DnsManager.swift', 'DnsModule.m', 'DnsModuleSwift.swift']) {
    assert.match(project, new RegExp(`${source.replace('.', '\\\.')} in Sources`));
  }
  assert.match(project, /path = Movix\/Dns;/);
  for (const resource of ['LaunchScreen.storyboard', 'PrivacyInfo.xcprivacy']) {
    assert.match(project, new RegExp(`${resource.replace('.', '\\\.')} in Resources`));
  }
  assert.match(project, /name = Movix;/);
  assert.match(project, /productName = Movix;/);
  assert.match(project, /name = MovixTests;/);
  assert.match(project, /productName = MovixTests;/);
  assert.doesNotMatch(project, /MovixApp/);
  assert.match(scheme, /BuildableName = "Movix\.app"/);
  assert.match(scheme, /BlueprintName = "Movix"/);
  assert.match(scheme, /BuildableName = "MovixTests\.xctest"/);
  assert.match(scheme, /BlueprintName = "MovixTests"/);
  assert.match(scheme, /<TestAction\s+buildConfiguration = "Debug"/);
  assert.match(scheme, /<LaunchAction\s+buildConfiguration = "Debug"/);
  assert.match(scheme, /<ArchiveAction\s+buildConfiguration = "Release"/);
  assert.doesNotMatch(scheme, /MovixApp/);
  assert.match(info, /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
  assert.match(info, /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/);
  assert.match(info, /<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
  assert.match(info, /<key>NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/);
  assert.match(info, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  assert.match(info, /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  assert.match(info, /<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>\s*<\/array>/);
  assert.match(info, /<key>UISupportedInterfaceOrientations~ipad<\/key>/);
  assert.match(entitlements, /<key>com\.apple\.developer\.networking\.networkextension<\/key>\s*<array>\s*<string>dns-settings<\/string>\s*<\/array>/);
  assert.doesNotMatch(entitlements, /com\.apple\.developer\.networking\.dns-settings/);
  assert.match(entitlements, /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>\s*<string>applinks:movix\.tax<\/string>\s*<\/array>/);
});

test('iOS CocoaPods integrates MovixTests with complete inheritance', async () => {
  const podfile = await text('../ios/Podfile');

  assert.match(
    podfile,
    /target 'Movix' do[\s\S]*?target 'MovixTests' do\s+inherit! :complete\s+end\s+post_install do/,
  );
});

test('iOS React Native entry point, privacy manifest, and XCTest target are wired', async () => {
  const [delegate, privacy, smokeTest] = await Promise.all([
    text('../ios/Movix/AppDelegate.mm'),
    text('../ios/Movix/PrivacyInfo.xcprivacy'),
    text('../ios/MovixTests/MovixTests.swift'),
  ]);

  assert.match(delegate, /self\.moduleName = @"Movix";/);
  assert.match(delegate, /jsBundleURLForBundleRoot:@"index"/);
  assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(smokeTest, /@testable import Movix/);
  assert.match(smokeTest, /Bundle\.main\.bundleIdentifier, "com\.movix\.app"/);
});

test('iOS media proxy policy and its XCTest suite are compiled by their targets', async () => {
  const [project, policy] = await Promise.all([
    text('../ios/Movix.xcodeproj/project.pbxproj'),
    text('../ios/Movix/Proxy/MediaProxyPolicy.swift'),
  ]);

  assert.match(project, /path = Movix\/Proxy;/);
  assert.match(project, /MediaProxyPolicy\.swift in Sources/);
  assert.match(project, /MediaProxyPolicyTests\.swift in Sources/);
  assert.equal(project.match(/MediaProxyPolicy\.swift in Sources/g)?.length, 2);
  assert.equal(project.match(/MediaProxyPolicyTests\.swift in Sources/g)?.length, 2);
  assert.match(policy, /ai_socktype: SOCK_STREAM,/);
  assert.doesNotMatch(policy, /SOCK_STREAM\.rawValue/);
  assert.doesNotMatch(policy, /length != 96 \|\| bytes\[8\] == 0/);
});

test('iOS HLS playlist rewriter and its XCTest suite are compiled by their targets', async () => {
  const [project, rewriter, tests] = await Promise.all([
    text('../ios/Movix.xcodeproj/project.pbxproj'),
    text('../ios/Movix/Proxy/HLSPlaylistRewriter.swift'),
    text('../ios/MovixTests/HLSPlaylistRewriterTests.swift'),
  ]);

  assert.match(project, /HLSPlaylistRewriter\.swift in Sources/);
  assert.match(project, /HLSPlaylistRewriterTests\.swift in Sources/);
  assert.equal(project.match(/HLSPlaylistRewriter\.swift in Sources/g)?.length, 2);
  assert.equal(project.match(/HLSPlaylistRewriterTests\.swift in Sources/g)?.length, 2);
  assert.match(rewriter, /enum HLSPlaylistRewriter/);
  assert.match(rewriter, /convertSubRipToWebVTT/);
  assert.match(rewriter, /text\/vtt; charset=utf-8/);
  assert.match(rewriter, /isSafeRelativeLocalReference/);
  assert.match(rewriter, /allowedAttributeDirectives/);
  assert.match(rewriter, /invalidLocalizedURL/);
  assert.match(tests, /@testable import Movix/);
  assert.match(tests, /testDoesNotRewriteURITextInsideQuotedValuesOrNonURIAttributes/);
});

test('iOS authenticated media proxy session store and its XCTest suite are compiled by their targets', async () => {
  const [project, models, store, tests] = await Promise.all([
    text('../ios/Movix.xcodeproj/project.pbxproj'),
    text('../ios/Movix/Proxy/MediaProxyModels.swift'),
    text('../ios/Movix/Proxy/MediaProxySessionStore.swift'),
    text('../ios/MovixTests/MediaProxySessionStoreTests.swift'),
  ]);

  for (const source of ['MediaProxyModels.swift', 'MediaProxySessionStore.swift', 'MediaProxySessionStoreTests.swift']) {
    assert.match(project, new RegExp(`${source.replace('.', '\\.')} in Sources`));
    assert.equal(project.match(new RegExp(`${source.replace('.', '\\.')} in Sources`, 'g'))?.length, 2);
  }
  assert.match(models, /struct MediaProxyTarget: Equatable, Sendable/);
  assert.match(models, /struct MediaProxyResource: Equatable, Sendable/);
  assert.match(models, /enum MediaProxyResolution: Equatable, Sendable/);
  assert.match(models, /struct MediaProxySessionRotation: Equatable, Sendable/);
  assert.match(models, /struct MediaProxySessionStoreDiagnostics: Equatable, Sendable/);
  assert.match(models, /struct MediaProxyLeasedResource: Sendable/);
  assert.match(models, /enum MediaProxyLeasedResolution: Sendable/);
  assert.match(models, /struct MediaProxySessionStoreConfiguration: Equatable, Sendable/);
  assert.match(store, /actor MediaProxySessionStore/);
  assert.match(store, /SecRandomCopyBytes/);
  assert.match(store, /func rotate\(sessionID: String\)/);
  assert.match(store, /func resolveLoopbackRequest\(/);
  assert.match(store, /final class MediaProxyAccessLease/);
  assert.match(store, /final class MediaProxySessionAccessState/);
  assert.match(store, /func withValidAccess/);
  assert.match(store, /absoluteDeadline/);
  assert.match(store, /idleDeadline/);
  assert.match(store, /refreshIdleDeadlineLocked/);
  assert.match(store, /func resolveLoopbackRequestWithLease\(/);
  assert.match(store, /let resourceID = try generateUniqueIdentifier\(\)\r?\n    if let evictedResourceID/);
  assert.match(store, /let resourceID = try generateUniqueIdentifier\(additionalReserved: \[sessionID\]\)[\s\S]*if let evictedSessionID/);
  assert.match(store, /accessBarrier\.revoke\(\)/);
  assert.match(store, /normalizedDuration/);
  assert.match(store, /\.isFinite/);
  assert.match(store, /resourceIDsByTarget/);
  assert.match(store, /identifierTombstones/);
  assert.match(store, /canonicalLoopbackAuthority/);
  assert.doesNotMatch(store, /issuedSessionIDs|issuedResourceIDs/);
  assert.match(tests, /testCastURLParserAcceptsOnlyExactAuthenticatedLoopbackPaths/);
  assert.match(tests, /testRotationAtomicallyRedirectsOldCredentialsDuringBoundedGrace/);
  assert.match(tests, /testSlidingPlaylistChurnKeepsRootAndRecentWindowWithinBounds/);
  assert.match(tests, /testOnlyAuthenticatedLiveTokensResolveAndAbsoluteExpiryIsIndependentFromIdle/);
  assert.match(tests, /testRotationSynchronouslyRevokesRootAndSegmentLeases/);
  assert.match(tests, /testInvalidationWaitsForActiveEmissionThenRejectsEveryLaterSection/);
  assert.match(tests, /testSuccessiveRotationsRetargetRootAndSegmentDirectlyToTerminalSuccessor/);
  assert.match(tests, /testNonFiniteDurationsUseFiniteDefaultsForBothInitializers/);
  assert.match(tests, /testLeaseEnforcesIdleAndAbsoluteDeadlinesWithoutActorPurge/);
  assert.match(tests, /testCapacityCollisionFailureLeavesSessionTransitionsTombstonesAndLeaseUnchanged/);
  assert.match(tests, /testSessionCapacityCollisionFailureLeavesExistingSessionAndLeaseUnchanged/);
});

test('iOS loopback media proxy transport and server are securely wired', async () => {
  const [project, upstream, parser, server, parserTests, integrationTests] = await Promise.all([
    text('../ios/Movix.xcodeproj/project.pbxproj'),
    text('../ios/Movix/Proxy/MediaProxyUpstream.swift'),
    text('../ios/Movix/Proxy/MediaProxyHTTPParser.swift'),
    text('../ios/Movix/Proxy/MediaProxyServer.swift'),
    text('../ios/MovixTests/MediaProxyHTTPParserTests.swift'),
    text('../ios/MovixTests/MediaProxyIntegrationTests.swift'),
  ]);

  for (const source of [
    'MediaProxyUpstream.swift',
    'MediaProxyHTTPParser.swift',
    'MediaProxyServer.swift',
    'MediaProxyHTTPParserTests.swift',
    'MediaProxyIntegrationTests.swift',
  ]) {
    assert.match(project, new RegExp(`${source.replace('.', '\\.')} in Sources`));
    assert.equal(project.match(new RegExp(`${source.replace('.', '\\.')} in Sources`, 'g'))?.length, 2);
  }

  assert.match(parser, /maximumRequestBytes\s*=\s*64 \* 1_024/);
  assert.match(parser, /maximumRequestLineBytes\s*=\s*8 \* 1_024/);
  assert.match(parser, /method == "GET" \|\| method == "HEAD"/);
  assert.match(parser, /duplicateRange/);
  assert.match(parser, /absoluteFormForbidden/);
  assert.match(parser, /malformedPercentEscape/);
  assert.match(parserTests, /testParserAcceptsBoundedGetAndRange/);
  assert.match(parserTests, /testParserRejectsPostAndOversizedHeaders/);
  assert.match(parserTests, /testParserRejectsBodiesAbsoluteFormMalformedEscapesAndDuplicateRange/);
  assert.match(parserTests, /testParserRejectsObsFoldAndHeaderInjection/);

  assert.match(upstream, /final class MediaProxyPinnedHTTPTransport/);
  assert.match(upstream, /NWConnection\(/);
  assert.match(upstream, /sec_protocol_options_set_tls_server_name/);
  assert.match(upstream, /validatePublicHTTPSURL/);
  assert.match(upstream, /maximumRedirects\s*=\s*5/);
  assert.match(upstream, /completionHandler\(nil\)/);
  assert.match(upstream, /MediaProxyURLSessionTestingTransport/);
  assert.match(upstream, /pinnedAddresses/);
  assert.match(upstream, /maximumInformationalResponses/);
  assert.match(upstream, /MediaProxyHTTPResponseHeadDecoder/);
  assert.match(upstream, /MediaProxyChunkedBodyDecoder/);
  assert.match(upstream, /validateEndOfStream/);
  assert.doesNotMatch(upstream, /allowsAnyHTTPSCertificate|serverTrust.*useCredential/);

  assert.match(server, /requiredLocalEndpoint\s*=\s*\.hostPort\(/);
  assert.match(server, /NWEndpoint\.Host\("127\.0\.0\.1"\)/);
  assert.match(server, /NWListener\(using: parameters, on: \.any\)/);
  assert.match(server, /resolveLoopbackRequestWithLease/);
  assert.doesNotMatch(server, /resolveLoopbackRequest\(/);
  assert.match(server, /lease\.withValidAccess/);
  assert.match(server, /lease\.release\(\)/);
  assert.match(server, /307 Temporary Redirect/);
  assert.match(server, /HLSPlaylistRewriter\.convertSubRipToWebVTT/);
  assert.match(server, /text\/vtt; charset=utf-8/);
  assert.match(server, /\.contentProcessed/);
  assert.match(server, /body\.cancel\(\)/);
  assert.match(server, /listenerGeneration/);
  assert.match(server, /listenerStartTimeout/);
  assert.match(server, /sendTimeout/);
  assert.match(server, /requestDeadline/);
  assert.match(server, /upstreamResponse\.statusCode == 200[\s\S]*Self\.isHLS/);
  assert.doesNotMatch(server, /0\.0\.0\.0|localhost/);

  for (const coverage of [
    'testRedirectsAreRevalidatedAndPinnedAtEveryHop',
    'testRejectsPrivateRebindingAnswerBeforeTransportStarts',
    'testServerRewritesFinalURLPlaylistConvertsSRTAndPreservesRange206',
    'testHeadPreservesHeadersWithoutSendingABody',
    'testStreamingUsesBackpressureAndDisconnectCancelsUpstream',
    'testExpiredOrRevokedLeaseStopsStreaming',
    'testRotationReturnsStrictLocal307AndRetargetsAThroughC',
    'testLocalizedCrossHostHLSResourcesInheritProviderHeadersWithoutSensitiveHeaders',
    'testPartialHLS206StreamsRawAndPreservesRangeHeaders',
    'testPinnedResponseDecoderConsumesInformationalResponsesAndRejectsAmbiguousBodylessFraming',
    'testChunkedDecoderRequiresCompleteTrailersAndBoundsExtensions',
    'testPinnedTransportTriesValidatedAddressesSequentially',
    'testPinnedTransportFailsAfterAllValidatedAddressesFail',
    'testListenerCloseInvalidatesPendingGenerationAndConcurrentOpenSharesLiveListener',
    'testLoopbackClientCapIsExactAndEarlyFailureReleasesSlot',
    'testRequestDeadlineIsAbsoluteAndBlockedSendTimesOut',
    'testControlledSendCompletionEnforcesBackpressure',
    'testHeadErrorsHaveNoBodyAndEncodedSubRipIsRejected',
  ]) {
    assert.match(integrationTests, new RegExp(coverage));
  }
});

test('the app icon catalog is compiled into the Movix bundle', async () => {
  const project = await text('../ios/Movix.xcodeproj/project.pbxproj');
  const catalog = JSON.parse(
    await text('../ios/Movix/Images.xcassets/AppIcon.appiconset/Contents.json'),
  );

  // Les fichiers d'icones ne suffisent pas : sans reference, appartenance au
  // groupe, phase Resources et nom de catalogue, l'IPA sort sans icone.
  assert.match(
    project,
    /isa = PBXFileReference; lastKnownFileType = folder\.assetcatalog;[^\n]*path = Movix\/Images\.xcassets;/,
  );
  assert.match(project, /Images\.xcassets in Resources \*\/ = \{isa = PBXBuildFile;/);
  assert.match(project, /Images\.xcassets in Resources \*\/,/);
  assert.equal(
    project.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g)?.length,
    2,
    'les configurations Debug et Release doivent toutes deux nommer AppIcon',
  );

  // L'icone du store est obligatoire, et une entree sans fichier fait echouer
  // la compilation du catalogue.
  assert.ok(
    catalog.images.some(image => image.size === '1024x1024' && image.filename),
    'le catalogue doit fournir l icone 1024x1024',
  );
  await Promise.all(
    catalog.images.map(image => text(
      `../ios/Movix/Images.xcassets/AppIcon.appiconset/${image.filename}`,
    )),
  );
});

test('legacy MovixApp Xcode artifacts are absent', async () => {
  await Promise.all([
    missing('../ios/MovixApp.xcodeproj'),
    missing('../ios/MovixApp.xcworkspace'),
    missing('../ios/MovixAppTests'),
  ]);
});
