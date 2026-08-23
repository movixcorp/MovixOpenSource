import Foundation
import Network
import UIKit
import XCTest
@testable import Movix

final class CastRelayServerTests: XCTestCase {
  func testUnexpectedPeerIsCancelledBeforeFirstReadAndListenerBindsExactSelection() async throws {
    let listener = FakeCastRelayListener()
    let factory = FakeCastRelayListenerFactory(listener: listener)
    let server = try await CastRelayServer.start(
      selection: selection(),
      upstream: FakeCastRelayUpstream(),
      listenerFactory: factory,
      makePathMonitor: { FakeCastRelayPathMonitor() },
      notificationCenter: NotificationCenter()
    )
    defer { Task { await server.stop() } }

    XCTAssertEqual(factory.boundAddress, ip("192.168.1.20"))
    XCTAssertEqual(factory.boundPort, .any)
    let denied = FakeCastRelayConnection(peer: "192.168.1.41", request: Data())
    listener.accept(denied)
    XCTAssertEqual(denied.cancelCount, 1)
    XCTAssertEqual(denied.receiveCount, 0, "peer authorization must precede every read")
    XCTAssertTrue(server.authorizePeer("192.168.1.40"))
    XCTAssertTrue(server.authorizePeer("::ffff:192.168.1.40"))
    XCTAssertFalse(server.authorizePeer("192.168.1.41"))
  }

  func testStrictRouteRejectsPercentQueryFragmentAndWrongTokenLengths() async throws {
    let harness = try await makeHarness()
    defer { Task { await harness.server.stop() } }
    let validPath = harness.prepared.contentURL.path

    for path in [
      validPath + "?x=1",
      validPath + "#fragment",
      validPath.replacingOccurrences(of: "/cast/", with: "/cast/%41"),
      "/cast/short/short",
      validPath + "/extra",
    ] {
      let connection = harness.request(path: path)
      try await waitUntil { connection.cancelCount > 0 }
      XCTAssertTrue(
        connection.responseString.contains(" 400 ")
          || connection.responseString.contains(" 404 "),
        path
      )
    }
    XCTAssertEqual(harness.upstream.openCount, 0)
  }

  func testRootAndNestedHLSStayOnTheSameOpaqueSessionWithoutCDNLeaks() async throws {
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://media.example/root.m3u8",
      status: 200,
      headers: ["Content-Type": "application/vnd.apple.mpegurl"],
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://cdn.example/nested.m3u8\n"
    )
    upstream.enqueue(
      url: "https://cdn.example/nested.m3u8",
      status: 200,
      headers: ["Content-Type": "application/vnd.apple.mpegurl"],
      body: "#EXTM3U\n#EXTINF:4,\nhttps://segments.example/one.ts\n"
    )
    let harness = try await makeHarness(upstream: upstream)
    defer { Task { await harness.server.stop() } }

    let root = harness.request(url: harness.prepared.contentURL)
    try await waitUntil { root.responseString.contains("#EXTM3U") }
    XCTAssertFalse(root.responseString.contains("cdn.example"))
    let nestedURL = try XCTUnwrap(firstHTTPURL(in: root.responseString))
    XCTAssertEqual(session(in: nestedURL), session(in: harness.prepared.contentURL))

    let nested = harness.request(url: nestedURL)
    try await waitUntil { nested.responseString.contains("#EXTINF") }
    XCTAssertFalse(nested.responseString.contains("segments.example"))
    let segmentURL = try XCTUnwrap(firstHTTPURL(in: nested.responseString))
    XCTAssertEqual(session(in: segmentURL), session(in: harness.prepared.contentURL))
    XCTAssertEqual(upstream.openedURLs, [
      "https://media.example/root.m3u8",
      "https://cdn.example/nested.m3u8",
    ])
  }

  func testInlineAndRemoteTracksShareTheRootSession() async throws {
    let tracks = try [
      CastSourceTrack(
        inlineVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n",
        language: "fr",
        name: "Français",
        active: true
      ),
      CastSourceTrack(
        remoteTarget: target("https://subtitles.example/en.vtt"),
        contentType: "text/vtt",
        language: "en",
        name: "English"
      ),
    ]
    let harness = try await makeHarness(tracks: tracks)
    defer { Task { await harness.server.stop() } }

    XCTAssertEqual(harness.prepared.textTracks.count, 2)
    let rootSession = try XCTUnwrap(session(in: harness.prepared.contentURL))
    XCTAssertTrue(harness.prepared.textTracks.allSatisfy {
      session(in: $0.contentURL) == rootSession
        && $0.contentType == "text/vtt"
    })
  }

  func testRange206HeadOptionsCORSAndPrivateNetworkHeaders() async throws {
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://media.example/root.m3u8",
      method: "GET",
      status: 206,
      headers: [
        "Content-Type": "video/mp4",
        "Content-Length": "4",
        "Content-Range": "bytes 0-3/100",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "https://attacker.invalid",
        "Vary": "Cookie",
      ],
      body: "data"
    )
    upstream.enqueue(
      url: "https://media.example/root.m3u8",
      method: "HEAD",
      status: 206,
      headers: [
        "Content-Type": "video/mp4",
        "Content-Length": "4",
        "Content-Range": "bytes 0-3/100",
        "Accept-Ranges": "bytes",
      ],
      body: "must-not-be-sent"
    )
    let harness = try await makeHarness(upstream: upstream, contentType: "video/mp4")
    defer { Task { await harness.server.stop() } }

    let get = harness.request(
      url: harness.prepared.contentURL,
      method: "GET",
      headers: ["Range": "bytes=0-3"]
    )
    try await waitUntil { get.responseString.contains("data") }
    XCTAssertTrue(get.responseString.contains("HTTP/1.1 206"))
    XCTAssertTrue(get.responseString.contains("Content-Range: bytes 0-3/100"))
    XCTAssertTrue(get.responseString.contains("Access-Control-Allow-Origin: *"))
    XCTAssertFalse(get.responseString.contains("attacker.invalid"))
    XCTAssertFalse(get.responseString.contains("Vary: Cookie"))

    let head = harness.request(
      url: harness.prepared.contentURL,
      method: "HEAD",
      headers: ["Origin": "https://receiver.example"]
    )
    try await waitUntil { head.responseString.contains("HTTP/1.1 206") }
    XCTAssertTrue(head.responseString.contains("Access-Control-Allow-Origin: https://receiver.example"))
    XCTAssertFalse(head.responseString.hasSuffix("must-not-be-sent"))

    let callsBeforeOptions = upstream.openCount
    let options = harness.request(
      url: harness.prepared.contentURL,
      method: "OPTIONS",
      headers: [
        "Origin": "https://receiver.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Range, Content-Type",
        "Access-Control-Request-Private-Network": "true",
      ]
    )
    try await waitUntil { options.responseString.contains("HTTP/1.1 204") }
    XCTAssertEqual(upstream.openCount, callsBeforeOptions)
    XCTAssertTrue(options.responseString.contains("Access-Control-Allow-Methods: GET, HEAD, OPTIONS"))
    XCTAssertTrue(options.responseString.contains("Access-Control-Allow-Headers: Range, Accept-Encoding, Content-Type"))
    XCTAssertTrue(options.responseString.contains("Access-Control-Allow-Private-Network: true"))
    XCTAssertTrue(options.responseString.contains("Access-Control-Request-Private-Network"))
  }

  func testInvalidCanonicalOriginIsRejectedWithoutOpeningUpstream() async throws {
    let harness = try await makeHarness()
    defer { Task { await harness.server.stop() } }

    for origin in [
      "http://receiver.example",
      "https://user@receiver.example",
      "https://Receiver.Example",
      "https://receiver.example/",
      "https://receiver.example\r\nInjected: true",
    ] {
      let denied = harness.request(
        url: harness.prepared.contentURL,
        headers: ["Origin": origin]
      )
      try await waitUntil { denied.cancelCount > 0 }
      XCTAssertTrue(
        denied.responseString.contains(" 400 ")
          || denied.responseString.contains(" 403 "),
        origin
      )
    }
    XCTAssertEqual(harness.upstream.openCount, 0)
  }

  func testRemoteVTTAndSRTAreBoundedAndSRTUsesExistingConverter() async throws {
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://subtitles.example/fr.srt",
      status: 200,
      headers: ["Content-Type": "application/x-subrip"],
      body: "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n"
    )
    upstream.enqueue(
      url: "https://subtitles.example/huge.vtt",
      status: 200,
      headers: ["Content-Type": "text/vtt"],
      data: Data(repeating: 65, count: 2 * 1_024 * 1_024 + 1)
    )
    let tracks = try [
      CastSourceTrack(remoteTarget: target("https://subtitles.example/fr.srt"), contentType: "application/x-subrip"),
      CastSourceTrack(remoteTarget: target("https://subtitles.example/huge.vtt"), contentType: "text/vtt"),
    ]
    let harness = try await makeHarness(upstream: upstream, tracks: tracks)
    defer { Task { await harness.server.stop() } }

    let srt = harness.request(url: harness.prepared.textTracks[0].contentURL)
    try await waitUntil { srt.responseString.contains("WEBVTT") }
    XCTAssertTrue(srt.responseString.contains("00:00:01.000 --> 00:00:02.000"))
    XCTAssertTrue(srt.responseString.contains("Content-Type: text/vtt; charset=utf-8"))

    let huge = harness.request(url: harness.prepared.textTracks[1].contentURL)
    try await waitUntil { huge.cancelCount > 0 }
    XCTAssertTrue(huge.responseString.contains(" 502 "))
  }

  func testPartialHLSAndTextResponsesFailClosedWithoutRemoteURLLeaks() async throws {
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://media.example/root.m3u8",
      status: 206,
      headers: [
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Range": "bytes 0-63/128",
      ],
      body: "#EXTM3U\nhttps://cdn.example/private-segment.ts\n"
    )
    let harness = try await makeHarness(upstream: upstream)
    defer { Task { await harness.server.stop() } }

    let response = harness.request(
      url: harness.prepared.contentURL,
      headers: ["Range": "bytes=0-63"]
    )
    try await waitUntil { response.responseString.contains(" 502 ") }
    XCTAssertFalse(response.responseString.contains("cdn.example"))
    XCTAssertGreaterThan(response.cancelCount, 0)

    let textUpstream = FakeCastRelayUpstream()
    textUpstream.enqueue(
      url: "https://subtitles.example/caption?id=fr",
      status: 206,
      headers: [
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes 0-31/64",
      ],
      body: "1\n00:00:01,000 --> 00:00:02,000\nprivate.example\n"
    )
    let track = try CastSourceTrack(
      remoteTarget: target("https://subtitles.example/caption?id=fr"),
      contentType: "application/x-subrip"
    )
    let textHarness = try await makeHarness(upstream: textUpstream, tracks: [track])
    defer { Task { await textHarness.server.stop() } }
    let textResponse = textHarness.request(
      url: textHarness.prepared.textTracks[0].contentURL,
      headers: ["Range": "bytes=0-31"]
    )
    try await waitUntil { textResponse.responseString.contains(" 502 ") }
    XCTAssertFalse(textResponse.responseString.contains("private.example"))

    let nestedUpstream = FakeCastRelayUpstream()
    nestedUpstream.enqueue(
      url: "https://media.example/root.m3u8",
      status: 200,
      headers: ["Content-Type": "application/vnd.apple.mpegurl"],
      body: "#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/opaque?id=1\n"
    )
    nestedUpstream.enqueue(
      url: "https://cdn.example/opaque?id=1",
      status: 206,
      headers: [
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes 32-63/128",
      ],
      body: "https://private-cdn.example/segment.ts\n"
    )
    let nestedHarness = try await makeHarness(upstream: nestedUpstream)
    defer { Task { await nestedHarness.server.stop() } }
    let nestedRoot = nestedHarness.request(url: nestedHarness.prepared.contentURL)
    try await waitUntil { nestedRoot.responseString.contains("#EXTM3U") }
    let nestedURL = try XCTUnwrap(firstHTTPURL(in: nestedRoot.responseString))
    let unsafePartial = nestedHarness.request(
      url: nestedURL,
      headers: ["Range": "bytes=32-63"]
    )
    try await waitUntil { unsafePartial.responseString.contains(" 502 ") }
    XCTAssertFalse(unsafePartial.responseString.contains("private-cdn.example"))
  }

  func testDeclaredRemoteTrackTypesHandleExtensionlessGenericResponses() async throws {
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://subtitles.example/caption?id=fr",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n"
    )
    upstream.enqueue(
      url: "https://subtitles.example/caption?id=en",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"
    )
    let tracks = try [
      CastSourceTrack(
        remoteTarget: target("https://subtitles.example/caption?id=fr"),
        contentType: "application/x-subrip"
      ),
      CastSourceTrack(
        remoteTarget: target("https://subtitles.example/caption?id=en"),
        contentType: "text/vtt"
      ),
    ]
    let harness = try await makeHarness(upstream: upstream, tracks: tracks)
    defer { Task { await harness.server.stop() } }

    let srt = harness.request(url: harness.prepared.textTracks[0].contentURL)
    try await waitUntil { srt.responseString.contains("WEBVTT") }
    XCTAssertTrue(srt.responseString.contains("00:00:01.000 --> 00:00:02.000"))
    XCTAssertTrue(srt.responseString.contains("Content-Type: text/vtt; charset=utf-8"))

    let vtt = harness.request(url: harness.prepared.textTracks[1].contentURL)
    try await waitUntil { vtt.responseString.contains("Hello") }
    XCTAssertTrue(vtt.responseString.contains("Content-Type: text/vtt; charset=utf-8"))
  }

  func testRevocationBeforeHeadersAndBetweenChunksCancelsTheUpstream() async throws {
    let barrier = CastRelayAccessBarrier()
    let store = CastRelaySessionStore(accessBarrier: barrier, tokenGenerator: tokenGenerator())
    let registration = try await store.registerRemote(target("https://media.example/movie.mp4"))
    let resolved = await store.resolve(
      sessionID: registration.sessionID,
      resourceID: registration.resourceID
    )
    let leased = try XCTUnwrap(resolved)
    await store.invalidateAll()
    XCTAssertNil(leased.lease.withValidAccess { true }, "revocation before headers must close the gate")

    let barrier2 = CastRelayAccessBarrier()
    let store2 = CastRelaySessionStore(accessBarrier: barrier2, tokenGenerator: tokenGenerator())
    let registration2 = try await store2.registerRemote(target("https://media.example/movie.mp4"))
    let resolved2 = await store2.resolve(
      sessionID: registration2.sessionID,
      resourceID: registration2.resourceID
    )
    let leased2 = try XCTUnwrap(resolved2)
    XCTAssertEqual(leased2.lease.withValidAccess { "first" }, "first")
    await store2.invalidateAll()
    XCTAssertNil(leased2.lease.withValidAccess { "second" })

    let body = FakeCastRelayBody(chunks: [Data("one".utf8), Data("two".utf8)])
    let upstream = FakeCastRelayUpstream()
    upstream.enqueue(
      url: "https://media.example/root.m3u8",
      status: 200,
      headers: ["Content-Type": "video/mp4"],
      bodyObject: body
    )
    let harness = try await makeHarness(upstream: upstream, contentType: "video/mp4")
    _ = harness.request(url: harness.prepared.contentURL)
    try await waitUntil { body.readCount > 0 }
    await harness.server.stop()
    XCTAssertTrue(body.isCancelled)
  }

  func testResourceKindParticipatesInRemoteDeduplication() async throws {
    let store = CastRelaySessionStore(tokenGenerator: tokenGenerator())
    let remote = target("https://media.example/opaque")
    let media = try await store.registerRemote(remote, kind: .media)
    let duplicateMedia = try await store.registerRemote(remote, kind: .media)
    let text = try await store.registerRemote(remote, kind: .textTrack(.webVTT))

    XCTAssertEqual(media, duplicateMedia)
    XCTAssertNotEqual(media.resourceID, text.resourceID)
    await store.invalidateAll()
  }

  func testPathChangeReceiverChangeAndBackgroundStopTheRelay() async throws {
    let pathMonitor = FakeCastRelayPathMonitor()
    let pathHarness = try await makeHarness(makePathMonitor: { pathMonitor })
    pathMonitor.emit(CastRouteSnapshot(candidates: [
      LocalInterfaceAddress(
        name: "wifi42",
        address: ip("192.168.1.20"),
        prefixLength: 24,
        type: .wifi,
        isUp: true,
        isRunning: true
      ),
    ]))
    XCTAssertFalse(pathHarness.server.isStopped)
    pathMonitor.emit(CastRouteSnapshot(candidates: []))
    try await waitUntil { pathHarness.server.isStopped }

    let receiverHarness = try await makeHarness()
    await receiverHarness.server.receiverDidChange(to: ip("192.168.1.41"))
    XCTAssertTrue(receiverHarness.server.isStopped)

    let center = NotificationCenter()
    let backgroundHarness = try await makeHarness(notificationCenter: center)
    center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    try await waitUntil { backgroundHarness.server.isStopped }
  }

  func testLifecycleCallbacksSynchronouslyRevokeBeforeNewWorkAndSelfCancelDoesNotDeadlock() async throws {
    let backgroundUpstream = FakeCastRelayUpstream()
    let center = NotificationCenter()
    let backgroundHarness = try await makeHarness(
      upstream: backgroundUpstream,
      notificationCenter: center
    )
    center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    XCTAssertTrue(backgroundHarness.server.isStopped, "callback must mark terminal before returning")
    let afterBackground = backgroundHarness.request(url: backgroundHarness.prepared.contentURL)
    XCTAssertEqual(afterBackground.receiveCount, 0)
    XCTAssertEqual(afterBackground.sendCount, 0)
    XCTAssertEqual(backgroundUpstream.openCount, 0)
    XCTAssertGreaterThan(afterBackground.cancelCount, 0)

    let pathMonitor = FakeCastRelayPathMonitor()
    let pathUpstream = FakeCastRelayUpstream()
    let pathHarness = try await makeHarness(
      upstream: pathUpstream,
      makePathMonitor: { pathMonitor }
    )
    pathMonitor.emit(CastRouteSnapshot(candidates: []))
    XCTAssertTrue(pathHarness.server.isStopped, "path callback must revoke synchronously")
    let afterPath = pathHarness.request(url: pathHarness.prepared.contentURL)
    XCTAssertEqual(afterPath.receiveCount, 0)
    XCTAssertEqual(afterPath.sendCount, 0)
    XCTAssertEqual(pathUpstream.openCount, 0)

    let betweenChunksBody = SuspendingBetweenChunksCastRelayBody()
    let betweenChunksUpstream = FakeCastRelayUpstream()
    betweenChunksUpstream.enqueue(
      url: "https://media.example/root.m3u8",
      status: 200,
      headers: ["Content-Type": "video/mp4"],
      bodyObject: betweenChunksBody
    )
    let betweenChunksCenter = NotificationCenter()
    let betweenChunksHarness = try await makeHarness(
      upstream: betweenChunksUpstream,
      contentType: "video/mp4",
      notificationCenter: betweenChunksCenter
    )
    let streaming = betweenChunksHarness.request(url: betweenChunksHarness.prepared.contentURL)
    try await waitUntil { betweenChunksBody.isWaiting }
    let sendsBeforeInvalidation = streaming.sendCount
    XCTAssertGreaterThanOrEqual(sendsBeforeInvalidation, 2)
    betweenChunksCenter.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    XCTAssertTrue(betweenChunksHarness.server.isStopped)
    XCTAssertEqual(streaming.sendCount, sendsBeforeInvalidation)
    try await waitUntil { betweenChunksBody.isCancelled }
    XCTAssertEqual(streaming.sendCount, sendsBeforeInvalidation)

    let selfCancellingListener = FakeCastRelayListener(emitCancellationOnCancel: true)
    let server = try await CastRelayServer.start(
      selection: selection(),
      upstream: FakeCastRelayUpstream(),
      listenerFactory: FakeCastRelayListenerFactory(listener: selfCancellingListener),
      makePathMonitor: { FakeCastRelayPathMonitor() },
      notificationCenter: NotificationCenter()
    )
    await server.stop()
    XCTAssertTrue(server.isStopped)
    XCTAssertEqual(selfCancellingListener.cancelCount, 1)
  }

  func testSessionRemainsLiveBeyondThirtyMinutesUntilExplicitStop() async throws {
    let clock = MutableCastRelayClock(Date(timeIntervalSince1970: 10))
    let store = CastRelaySessionStore(
      clock: { clock.now },
      tokenGenerator: tokenGenerator()
    )
    let registration = try await store.registerRemote(target("https://media.example/movie.mp4"))
    clock.advance(by: 31 * 60)
    let stillLive = await store.resolve(
      sessionID: registration.sessionID,
      resourceID: registration.resourceID
    )
    XCTAssertNotNil(stillLive)
    await store.invalidateAll()
    let revoked = await store.resolve(
      sessionID: registration.sessionID,
      resourceID: registration.resourceID
    )
    XCTAssertNil(revoked)
  }

  func testStopIsAwaitedExactAndIdempotent() async throws {
    let listener = FakeCastRelayListener()
    let server = try await CastRelayServer.start(
      selection: selection(),
      upstream: FakeCastRelayUpstream(),
      listenerFactory: FakeCastRelayListenerFactory(listener: listener),
      makePathMonitor: { FakeCastRelayPathMonitor() },
      notificationCenter: NotificationCenter()
    )

    async let first: Void = server.stop()
    async let second: Void = server.stop()
    async let third: Void = server.stop()
    _ = await (first, second, third)
    XCTAssertEqual(listener.cancelCount, 1)
    XCTAssertTrue(server.isStopped)
  }

  private func makeHarness(
    upstream: FakeCastRelayUpstream = FakeCastRelayUpstream(),
    contentType: String = "application/vnd.apple.mpegurl",
    tracks: [CastSourceTrack] = [],
    makePathMonitor: @escaping @Sendable () -> CastRelayPathMonitoring = {
      FakeCastRelayPathMonitor()
    },
    notificationCenter: NotificationCenter = NotificationCenter()
  ) async throws -> RelayHarness {
    let listener = FakeCastRelayListener()
    let server = try await CastRelayServer.start(
      selection: selection(),
      upstream: upstream,
      listenerFactory: FakeCastRelayListenerFactory(listener: listener),
      makePathMonitor: makePathMonitor,
      notificationCenter: notificationCenter
    )
    let profile = try CastMediaProfile(contentType: contentType, sourceURL: URL(string: "https://media.example/root.m3u8")!)
    let prepared = try await server.prepare(
      rootTarget: target("https://media.example/root.m3u8"),
      profile: profile,
      tracks: tracks
    )
    return RelayHarness(server: server, prepared: prepared, listener: listener, upstream: upstream)
  }

  private func selection() -> CastNetworkSelection {
    CastNetworkSelection(
      localAddress: ip("192.168.1.20"),
      receiverAddress: ip("192.168.1.40"),
      interfaceName: "wifi42",
      prefixLength: 24
    )
  }

  private func target(_ raw: String) -> MediaProxyTarget {
    MediaProxyTarget(upstreamURL: URL(string: raw)!, method: "GET", headers: [:])
  }

  private func ip(_ raw: String) -> MediaProxyIPAddress {
    MediaProxyIPAddress(raw)!
  }

  private func session(in url: URL) -> String? {
    let parts = url.path.split(separator: "/")
    guard parts.count == 3, parts[0] == "cast" else { return nil }
    return String(parts[1])
  }

  private func firstHTTPURL(in response: String) -> URL? {
    response.components(separatedBy: .newlines)
      .first(where: { $0.hasPrefix("http://") })
      .flatMap(URL.init(string:))
  }

  private func tokenGenerator() -> @Sendable () -> String {
    let source = CastRelayTokenSource()
    return { source.next() }
  }

  private func waitUntil(
    timeout: TimeInterval = 1,
    condition: @escaping () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() >= deadline { XCTFail("Timed out waiting for asynchronous relay state"); return }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
  }
}

private struct RelayHarness {
  let server: CastRelayServer
  let prepared: PreparedCastRelay
  let listener: FakeCastRelayListener
  let upstream: FakeCastRelayUpstream

  func request(
    url: URL,
    method: String = "GET",
    headers: [String: String] = [:]
  ) -> FakeCastRelayConnection {
    request(path: url.path, method: method, headers: headers)
  }

  func request(
    path: String,
    method: String = "GET",
    headers: [String: String] = [:]
  ) -> FakeCastRelayConnection {
    var lines = ["\(method) \(path) HTTP/1.1", "Host: 192.168.1.20:49152"]
    for name in headers.keys.sorted() { lines.append("\(name): \(headers[name]!)") }
    let request = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    let connection = FakeCastRelayConnection(peer: "192.168.1.40", request: request)
    listener.accept(connection)
    return connection
  }
}

private final class FakeCastRelayListenerFactory: CastRelayListenerFactory, @unchecked Sendable {
  private let listener: FakeCastRelayListener
  private let lock = NSLock()
  private(set) var boundAddress: MediaProxyIPAddress?
  private(set) var boundPort: NWEndpoint.Port?

  init(listener: FakeCastRelayListener) { self.listener = listener }

  func makeListener(
    boundTo localAddress: MediaProxyIPAddress,
    port: NWEndpoint.Port
  ) throws -> CastRelayListener {
    lock.lock()
    boundAddress = localAddress
    boundPort = port
    lock.unlock()
    return listener
  }
}

private final class FakeCastRelayListener: CastRelayListener, @unchecked Sendable {
  let port = NWEndpoint.Port(rawValue: 49_152)
  var newConnectionHandler: ((CastRelayConnection) -> Void)?
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)?
  private let lock = NSLock()
  private let emitCancellationOnCancel: Bool
  private(set) var cancelCount = 0

  init(emitCancellationOnCancel: Bool = false) {
    self.emitCancellationOnCancel = emitCancellationOnCancel
  }

  func start(on queue: DispatchQueue) { stateUpdateHandler?(.ready) }
  func cancel() {
    lock.lock()
    cancelCount += 1
    lock.unlock()
    if emitCancellationOnCancel { stateUpdateHandler?(.cancelled) }
  }
  func accept(_ connection: FakeCastRelayConnection) { newConnectionHandler?(connection) }
}

private final class FakeCastRelayConnection: CastRelayConnection, @unchecked Sendable {
  let endpoint: NWEndpoint
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)?
  private let lock = NSLock()
  private var request: Data?
  private var response = Data()
  private(set) var cancelCount = 0
  private(set) var receiveCount = 0
  private(set) var sendCount = 0

  init(peer: String, request: Data) {
    endpoint = .hostPort(host: NWEndpoint.Host(peer), port: NWEndpoint.Port(rawValue: 60_000)!)
    self.request = request
  }

  var responseString: String { lock.withCriticalSection { String(decoding: response, as: UTF8.self) } }

  func start(on queue: DispatchQueue) { stateUpdateHandler?(.ready) }
  func cancel() { lock.withCriticalSection { cancelCount += 1 } }
  func receive(maximumLength: Int, completion: @escaping @Sendable (Data?, Bool, Error?) -> Void) {
    let value = lock.withCriticalSection { () -> Data? in
      receiveCount += 1
      defer { request = nil }
      return request
    }
    completion(value.map { Data($0.prefix(maximumLength)) }, true, nil)
  }
  func send(
    content: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    completion: @escaping @Sendable (Error?) -> Void
  ) {
    lock.withCriticalSection {
      sendCount += 1
      if let content { response.append(content) }
    }
    completion(nil)
  }
}

private final class FakeCastRelayPathMonitor: CastRelayPathMonitoring, @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (CastRouteSnapshot) -> Void)?
  private(set) var cancelCount = 0

  @discardableResult
  func start(_ handler: @escaping @Sendable (CastRouteSnapshot) -> Void) -> Bool {
    lock.withCriticalSection { self.handler = handler }
    return true
  }
  func cancel() { lock.withCriticalSection { cancelCount += 1; handler = nil } }
  func emit(_ snapshot: CastRouteSnapshot) { lock.withCriticalSection { handler }?(snapshot) }
}

private final class FakeCastRelayUpstream: CastRelayUpstreamOpening, @unchecked Sendable {
  private struct Key: Hashable { let method: String; let url: String }
  private struct Stub {
    let status: Int
    let headers: [String: String]
    let finalURL: URL
    let body: MediaProxyUpstreamBody
  }
  private let lock = NSLock()
  private var stubs: [Key: [Stub]] = [:]
  private var opened: [String] = []

  var openCount: Int { lock.withCriticalSection { opened.count } }
  var openedURLs: [String] { lock.withCriticalSection { opened } }

  func enqueue(
    url: String,
    method: String = "GET",
    status: Int,
    headers: [String: String],
    body: String
  ) {
    enqueue(url: url, method: method, status: status, headers: headers, data: Data(body.utf8))
  }

  func enqueue(
    url: String,
    method: String = "GET",
    status: Int,
    headers: [String: String],
    data: Data
  ) {
    enqueue(
      url: url,
      method: method,
      status: status,
      headers: headers,
      bodyObject: FakeCastRelayBody(chunks: [data])
    )
  }

  func enqueue(
    url: String,
    method: String = "GET",
    status: Int,
    headers: [String: String],
    bodyObject: MediaProxyUpstreamBody
  ) {
    lock.withCriticalSection {
      let key = Key(method: method, url: url)
      stubs[key, default: []].append(Stub(
        status: status,
        headers: headers,
        finalURL: URL(string: url)!,
        body: bodyObject
      ))
    }
  }

  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    try lock.withCriticalSection {
      let raw = target.upstreamURL.absoluteString
      opened.append(raw)
      let key = Key(method: target.method.uppercased(), url: raw)
      guard var values = stubs[key], !values.isEmpty else {
        throw MediaProxyUpstreamError.connectionFailed
      }
      let stub = values.removeFirst()
      stubs[key] = values
      return MediaProxyUpstreamResponse(
        statusCode: stub.status,
        headers: stub.headers,
        finalURL: stub.finalURL,
        body: stub.body
      )
    }
  }
}

private final class FakeCastRelayBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var chunks: [Data]
  private(set) var readCount = 0
  private(set) var isCancelled = false

  init(chunks: [Data]) { self.chunks = chunks }
  func nextChunk() async throws -> Data? {
    try lock.withCriticalSection {
      guard !isCancelled else { throw MediaProxyUpstreamError.cancelled }
      readCount += 1
      return chunks.isEmpty ? nil : chunks.removeFirst()
    }
  }
  func cancel() { lock.withCriticalSection { isCancelled = true; chunks.removeAll() } }
}

private final class SuspendingBetweenChunksCastRelayBody: MediaProxyUpstreamBody,
  @unchecked Sendable {
  private let lock = NSLock()
  private var state = 0
  private var continuation: CheckedContinuation<Data?, Error>?
  private var cancelled = false

  var isWaiting: Bool { lock.withCriticalSection { continuation != nil } }
  var isCancelled: Bool { lock.withCriticalSection { cancelled } }

  func nextChunk() async throws -> Data? {
    let first = try lock.withCriticalSection { () -> Data? in
      guard !cancelled else { throw MediaProxyUpstreamError.cancelled }
      if state == 0 {
        state = 1
        return Data([0, 1, 2, 3])
      }
      return nil
    }
    if let first { return first }
    return try await withCheckedThrowingContinuation { continuation in
      let cancelImmediately = lock.withCriticalSection { () -> Bool in
        guard !cancelled else { return true }
        self.continuation = continuation
        return false
      }
      if cancelImmediately {
        continuation.resume(throwing: MediaProxyUpstreamError.cancelled)
      }
    }
  }

  func cancel() {
    let pending = lock.withCriticalSection { () -> CheckedContinuation<Data?, Error>? in
      guard !cancelled else { return nil }
      cancelled = true
      defer { continuation = nil }
      return continuation
    }
    pending?.resume(throwing: MediaProxyUpstreamError.cancelled)
  }
}

private final class MutableCastRelayClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date
  init(_ value: Date) { self.value = value }
  var now: Date { lock.withCriticalSection { value } }
  func advance(by interval: TimeInterval) { lock.withCriticalSection { value.addTimeInterval(interval) } }
}

private final class CastRelayTokenSource: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func next() -> String {
    lock.withCriticalSection {
      value += 1
      let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
      return String(repeating: alphabet[value % alphabet.count], count: 43)
    }
  }
}

private extension NSLock {
  func withCriticalSection<T>(_ operation: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try operation()
  }
}
