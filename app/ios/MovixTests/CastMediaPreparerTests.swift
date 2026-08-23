import Foundation
import Network
import XCTest
@testable import Movix

final class CastMediaPreparerTests: XCTestCase {
  func testModelRejectsSeventeenTracksOversizedMetadataAndInvalidVTT() throws {
    let validTrack = try CastSourceTrack(
      inlineVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n"
    )
    XCTAssertThrowsError(
      try PreparedCastSource(
        url: URL(string: "https://media.example/movie.mp4")!,
        headers: [:],
        contentType: "video/mp4",
        protocolVersion: 1,
        tracks: Array(repeating: validTrack, count: 17)
      )
    ) { XCTAssertEqual($0 as? CastRelayError, .tooManyTracks) }

    XCTAssertThrowsError(try CastSourceTrack(
      inlineVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n",
      language: String(repeating: "f", count: 36)
    )) { XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack) }
    XCTAssertThrowsError(try CastSourceTrack(
      inlineVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n",
      name: String(repeating: "n", count: 129)
    )) { XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack) }

    for invalid in [
      "",
      "not webvtt",
      "WEBVTT\n\nno cue",
      "WEBVTT\u{0}\n\n00:00:01.000 --> 00:00:02.000\nBad",
      "WEBVTT\n\n00:99:01.000 --> 00:00:02.000\nBad",
    ] {
      XCTAssertThrowsError(try CastSourceTrack(inlineVTT: invalid), invalid) {
        XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack)
      }
    }
    let oversized = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n"
      + String(repeating: "x", count: 2 * 1_024 * 1_024)
    XCTAssertThrowsError(try CastSourceTrack(inlineVTT: oversized)) {
      XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack)
    }
    XCTAssertThrowsError(
      try CastMediaProfile(
        contentType: "text/html",
        sourceURL: URL(string: "https://media.example/movie")!
      )
    ) { XCTAssertEqual($0 as? CastRelayError, .unsupportedContentType) }
    XCTAssertThrowsError(try CastSourceTrack(
      remoteTarget: target("https://subtitles.example/caption"),
      contentType: "text/vtt\r\nX-Leak: true"
    )) { XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack) }
    XCTAssertThrowsError(try CastSourceTrack(
      remoteTarget: target("https://subtitles.example/caption"),
      contentType: "text/vtt;" + String(repeating: "x", count: 8_192)
    )) { XCTAssertEqual($0 as? CastRelayError, .invalidTextTrack) }
  }

  func testInspectorHandlesExtensionlessProgressiveAndHeadFallbackWithBoundedRange() async throws {
    let headOnly = FakeCastInspectionUpstream()
    headOnly.enqueue(
      url: "https://cdn.example/video",
      method: "HEAD",
      status: 200,
      headers: ["Content-Type": "video/mp4"],
      body: Data()
    )
    let direct = try await CastMediaInspector(upstream: headOnly).inspect(
      target: target("https://cdn.example/video"),
      hintedContentType: nil
    )
    XCTAssertEqual(direct.contentType, "video/mp4")
    XCTAssertEqual(headOnly.requests.map(\.method), ["HEAD"])

    let fallback = FakeCastInspectionUpstream()
    fallback.enqueue(
      url: "https://cdn.example/opaque",
      method: "HEAD",
      status: 405,
      headers: [:],
      body: Data()
    )
    fallback.enqueue(
      url: "https://cdn.example/opaque",
      method: "GET",
      status: 206,
      headers: ["Content-Type": "application/octet-stream"],
      body: syntheticMP4Prefix()
    )
    let inspected = try await CastMediaInspector(upstream: fallback).inspect(
      target: target("https://cdn.example/opaque"),
      hintedContentType: nil
    )
    XCTAssertEqual(inspected.contentType, "video/mp4")
    XCTAssertEqual(fallback.requests.map(\.method), ["HEAD", "GET"])
    XCTAssertEqual(fallback.requests.last?.localHeaders["Range"], "bytes=0-524287")

    let extensionlessHLS = FakeCastInspectionUpstream()
    extensionlessHLS.enqueue(
      url: "https://cdn.example/live",
      method: "HEAD",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: Data()
    )
    let playlist = Data("#EXTM3U\n#EXTINF:4,\nchunk.ts?id=1\n".utf8)
    extensionlessHLS.enqueue(
      url: "https://cdn.example/live",
      method: "GET",
      status: 206,
      headers: ["Content-Type": "application/octet-stream"],
      body: playlist
    )
    extensionlessHLS.enqueue(
      url: "https://cdn.example/live",
      method: "GET",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: playlist
    )
    let hls = try await CastMediaInspector(upstream: extensionlessHLS).inspect(
      target: target("https://cdn.example/live"),
      hintedContentType: nil
    )
    XCTAssertEqual(hls.hlsSegmentFormat, "ts")
    XCTAssertEqual(extensionlessHLS.requests.map(\.method), ["HEAD", "GET", "GET"])
    XCTAssertEqual(extensionlessHLS.requests[1].localHeaders["Range"], "bytes=0-524287")
    XCTAssertNil(extensionlessHLS.requests[2].localHeaders["Range"])
  }

  func testInspectorDetectsTransportStreamAndFMP4HLS() async throws {
    let tsUpstream = FakeCastInspectionUpstream()
    tsUpstream.enqueue(
      url: "https://cdn.example/live",
      method: "GET",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: Data("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk?id=1\n".utf8)
    )
    tsUpstream.enqueue(
      url: "https://cdn.example/chunk?id=1",
      method: "GET",
      status: 206,
      headers: ["Content-Type": "application/octet-stream"],
      body: syntheticTransportStreamPrefix()
    )
    let ts = try await CastMediaInspector(upstream: tsUpstream).inspect(
      target: target("https://cdn.example/live"),
      hintedContentType: "application/x-mpegurl"
    )
    XCTAssertEqual(ts.hlsSegmentFormat, "ts")
    XCTAssertEqual(ts.hlsVideoSegmentFormat, "mpeg2_ts")
    XCTAssertEqual(tsUpstream.requests.last?.localHeaders["Range"], "bytes=0-65535")

    let fmp4Upstream = FakeCastInspectionUpstream()
    fmp4Upstream.enqueue(
      url: "https://cdn.example/master",
      method: "GET",
      status: 200,
      headers: ["Content-Type": "application/vnd.apple.mpegurl"],
      body: Data("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia?id=1\n".utf8)
    )
    fmp4Upstream.enqueue(
      url: "https://cdn.example/media?id=1",
      method: "GET",
      status: 200,
      headers: ["Content-Type": "application/octet-stream"],
      body: Data("#EXTM3U\n#EXT-X-MAP:URI=\"init?id=1\"\n#EXTINF:4,\nsegment?id=1\n".utf8)
    )
    let fmp4 = try await CastMediaInspector(upstream: fmp4Upstream).inspect(
      target: target("https://cdn.example/master"),
      hintedContentType: "application/x-mpegurl"
    )
    XCTAssertEqual(fmp4.hlsSegmentFormat, "fmp4")
    XCTAssertEqual(fmp4.hlsVideoSegmentFormat, "fmp4")
    XCTAssertEqual(fmp4Upstream.requests.map(\.url), [
      "https://cdn.example/master",
      "https://cdn.example/media?id=1",
    ])
  }

  func testInspectorRejectsOversizedInvalidAndCancelledProbesBeforeRelayStart() async throws {
    for body in [
      Data(repeating: 0x41, count: 512 * 1_024 + 1),
      Data("not a supported media representation".utf8),
    ] {
      let upstream = FakeCastInspectionUpstream()
      upstream.enqueue(
        url: "https://cdn.example/opaque",
        method: "HEAD",
        status: 405,
        headers: [:],
        body: Data()
      )
      upstream.enqueue(
        url: "https://cdn.example/opaque",
        method: "GET",
        status: 206,
        headers: ["Content-Type": "application/octet-stream"],
        body: body
      )
      await XCTAssertThrowsErrorAsync(
        try await CastMediaInspector(upstream: upstream).inspect(
          target: target("https://cdn.example/opaque"),
          hintedContentType: nil
        )
      ) { error in
        guard let relayError = error as? CastRelayError else {
          XCTFail("Expected stable Cast relay error")
          return
        }
        XCTAssertTrue([
          CastRelayError.responseTooLarge,
          CastRelayError.unsupportedContentType,
        ].contains(relayError))
      }
    }

    let timedOutFactory = FakeCastRelayPreparing()
    let timedOutPreparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: timedOutFactory,
      inspector: CastMediaInspector(upstream: FailingCastInspectionUpstream(
        error: MediaProxyUpstreamError.timedOut
      ))
    )
    let timedOutSource = try PreparedCastSource(
      url: URL(string: "https://cdn.example/timed-out")!,
      headers: [:]
    )
    await XCTAssertThrowsErrorAsync(
      try await timedOutPreparer.prepare(
        source: timedOutSource,
        selection: selection()
      )
    ) { error in
      XCTAssertEqual(error as? CastRelayError, .upstreamUnavailable)
    }
    XCTAssertTrue(timedOutFactory.rootTargets.isEmpty)

    let suspendingBody = SuspendingCastInspectionBody()
    let cancelledUpstream = FakeCastInspectionUpstream()
    cancelledUpstream.enqueue(
      url: "https://cdn.example/cancelled",
      method: "HEAD",
      status: 405,
      headers: [:],
      body: Data()
    )
    cancelledUpstream.enqueue(
      url: "https://cdn.example/cancelled",
      method: "GET",
      status: 206,
      headers: ["Content-Type": "application/octet-stream"],
      bodyObject: suspendingBody
    )
    let relayFactory = FakeCastRelayPreparing()
    let preparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: relayFactory,
      inspector: CastMediaInspector(upstream: cancelledUpstream)
    )
    let source = try PreparedCastSource(
      url: URL(string: "https://cdn.example/cancelled")!,
      headers: [:]
    )
    let task = Task { try await preparer.prepare(source: source, selection: selection()) }
    try await waitUntil { suspendingBody.didStart }
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("Expected inspection cancellation")
    } catch is CancellationError {
      // Expected.
    } catch let error as MediaProxyUpstreamError {
      XCTAssertEqual(error, .cancelled)
    }
    XCTAssertTrue(suspendingBody.isCancelled)
    XCTAssertTrue(relayFactory.rootTargets.isEmpty)
  }

  func testPreparerResolvesCanonicalLoopbackAndCopiesOnlySanitizedOwnedTarget() async throws {
    let loopback = URL(string:
      "http://127.0.0.1:28123/p/\(String(repeating: "A", count: 43))/\(String(repeating: "b", count: 43))/\(String(repeating: "_", count: 43))"
    )!
    let resolved = MediaProxyTarget(
      upstreamURL: URL(string: "https://cdn.example/movie.mp4")!,
      method: "GET",
      headers: [
        "Referer": "https://movix.tax/",
        "Cookie": "must-not-cross",
        "Host": "attacker.invalid",
      ]
    )
    let resolver = FakeMediaProxyCastResolver(result: resolved)
    let relayFactory = FakeCastRelayPreparing()
    let preparer = CastMediaPreparer(
      resolver: resolver,
      relayFactory: relayFactory,
      inspector: StaticCastMediaInspector()
    )
    let source = try PreparedCastSource(
      url: loopback,
      headers: [:],
      contentType: "video/mp4"
    )

    _ = try await preparer.prepare(source: source, selection: selection())

    XCTAssertEqual(resolver.requests, [loopback])
    let copied = try XCTUnwrap(relayFactory.rootTargets.first)
    XCTAssertEqual(copied.upstreamURL.absoluteString, "https://cdn.example/movie.mp4")
    XCTAssertEqual(copied.headers["Referer"], "https://movix.tax/")
    XCTAssertNil(copied.headers["Cookie"])
    XCTAssertNil(copied.headers["Host"])
  }

  func testPreparerRejectsMissingLoopbackOwnershipWithStableNonSensitiveError() async throws {
    let loopback = URL(string:
      "http://127.0.0.1:28123/p/\(String(repeating: "A", count: 43))/\(String(repeating: "b", count: 43))/\(String(repeating: "_", count: 43))"
    )!
    let preparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: FakeCastRelayPreparing(),
      inspector: StaticCastMediaInspector()
    )
    let source = try PreparedCastSource(url: loopback, headers: [:], contentType: "video/mp4")

    do {
      _ = try await preparer.prepare(source: source, selection: selection())
      XCTFail("Expected loopback ownership failure")
    } catch let error as CastRelayError {
      XCTAssertEqual(error, .localSourceUnavailable)
      XCTAssertEqual(error.rawValue, "MOVIX_CAST_LOCAL_SOURCE_UNAVAILABLE")
      XCTAssertFalse(error.rawValue.contains("127.0.0.1"))
      XCTAssertFalse(error.rawValue.contains("28123"))
    }
  }

  func testRemoteSourceIsValidatedAndSanitizedBeforeRelayRegistration() async throws {
    let resolver = FakeMediaProxyCastResolver(result: nil)
    let relayFactory = FakeCastRelayPreparing()
    let preparer = CastMediaPreparer(
      resolver: resolver,
      relayFactory: relayFactory,
      inspector: StaticCastMediaInspector()
    )
    let source = try PreparedCastSource(
      url: URL(string: "https://cdn.example/movie.mp4")!,
      headers: [
        "Range": "bytes=0-",
        "Origin": "https://movix.tax",
        "Authorization": "secret",
      ],
      contentType: "video/mp4"
    )

    _ = try await preparer.prepare(source: source, selection: selection())

    XCTAssertTrue(resolver.requests.isEmpty)
    let copied = try XCTUnwrap(relayFactory.rootTargets.first)
    XCTAssertEqual(copied.method, "GET")
    XCTAssertEqual(copied.headers["Range"], "bytes=0-")
    XCTAssertEqual(copied.headers["Origin"], "https://movix.tax")
    XCTAssertNil(copied.headers["Authorization"])
  }

  func testPreparationFailureRollsBackEveryRegistration() async throws {
    let listener = FakeRollbackListener()
    let tokens = CastMediaPreparerTokenSource()
    FakeRollbackRegistrationProbe.reset()
    let relayFactory = CastRelayServerFactory(
      upstream: FakeRollbackUpstream(),
      listenerFactory: FakeRollbackListenerFactory(listener: listener),
      makePathMonitor: { FakeRollbackPathMonitor() },
      notificationCenter: NotificationCenter(),
      maximumResources: 2,
      tokenGenerator: {
        let value = tokens.next()
        FakeRollbackRegistrationProbe.registered(value)
        return value
      }
    )
    let preparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: relayFactory,
      inspector: StaticCastMediaInspector()
    )
    let firstTrack = try CastSourceTrack(
      inlineVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n"
    )
    let secondTrack = try CastSourceTrack(
      inlineVTT: "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nEncore\n"
    )
    let source = try PreparedCastSource(
      url: URL(string: "https://cdn.example/movie.mp4")!,
      headers: [:],
      contentType: "video/mp4",
      tracks: [firstTrack, secondTrack]
    )

    await XCTAssertThrowsErrorAsync(
      try await preparer.prepare(source: source, selection: selection())
    ) { error in
      XCTAssertEqual(error as? CastRelayError, .capacityExceeded)
    }
    XCTAssertEqual(listener.cancelCount, 1, "failed preparation must stop its new relay")
    XCTAssertEqual(FakeRollbackRegistrationProbe.issuedCount, 3)
    XCTAssertEqual(FakeRollbackRegistrationProbe.liveCount, 0)
  }

  func testPreparingReplacementDoesNotStopPreviouslyPreparedRelay() async throws {
    let factory = FakeCastRelayPreparing()
    let preparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: factory,
      inspector: StaticCastMediaInspector()
    )
    let firstSource = try PreparedCastSource(
      url: URL(string: "https://cdn.example/first.mp4")!,
      headers: [:],
      contentType: "video/mp4"
    )
    let secondSource = try PreparedCastSource(
      url: URL(string: "https://cdn.example/second.mp4")!,
      headers: [:],
      contentType: "video/mp4"
    )

    let first = try await preparer.prepare(source: firstSource, selection: selection())
    let second = try await preparer.prepare(source: secondSource, selection: selection())
    XCTAssertEqual(factory.stopCounters.map(\.value), [0, 0])
    await second.stop()
    XCTAssertEqual(factory.stopCounters.map(\.value), [0, 1])
    await first.stop()
    XCTAssertEqual(factory.stopCounters.map(\.value), [1, 1])
  }

  func testPreparedStopClosureIsAwaitedAndIdempotent() async throws {
    let factory = FakeCastRelayPreparing()
    let preparer = CastMediaPreparer(
      resolver: FakeMediaProxyCastResolver(result: nil),
      relayFactory: factory,
      inspector: StaticCastMediaInspector()
    )
    let source = try PreparedCastSource(
      url: URL(string: "https://cdn.example/movie.mp4")!,
      headers: [:],
      contentType: "video/mp4"
    )
    let prepared = try await preparer.prepare(source: source, selection: selection())

    async let first: Void = prepared.stop()
    async let second: Void = prepared.stop()
    _ = await (first, second)
    XCTAssertEqual(factory.stopCounters.single?.value, 1)
  }

  private func selection() -> CastNetworkSelection {
    CastNetworkSelection(
      localAddress: MediaProxyIPAddress("192.168.1.20")!,
      receiverAddress: MediaProxyIPAddress("192.168.1.40")!,
      interfaceName: "wifi42",
      prefixLength: 24
    )
  }

  private func target(_ raw: String) -> MediaProxyTarget {
    MediaProxyTarget(upstreamURL: URL(string: raw)!, method: "GET", headers: [:])
  }

  private func syntheticMP4Prefix() -> Data {
    Data([0, 0, 0, 24]) + Data("ftypisom".utf8) + Data(repeating: 0, count: 12)
  }

  private func syntheticTransportStreamPrefix() -> Data {
    var bytes = Data(repeating: 0, count: 3 * 188)
    bytes[0] = 0x47
    bytes[188] = 0x47
    bytes[376] = 0x47
    return bytes
  }

  private func waitUntil(
    timeout: TimeInterval = 1,
    condition: @escaping () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() >= deadline { XCTFail("Timed out waiting for inspection state"); return }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
  }
}

private final class FakeMediaProxyCastResolver: MediaProxyCastResolving, @unchecked Sendable {
  private let lock = NSLock()
  private let result: MediaProxyTarget?
  private var values: [URL] = []
  init(result: MediaProxyTarget?) { self.result = result }
  var requests: [URL] { lock.withPreparationLock { values } }
  func resolveForCast(_ localURL: URL) async -> MediaProxyTarget? {
    lock.withPreparationLock { values.append(localURL) }
    return result
  }
}

private struct StaticCastMediaInspector: CastMediaInspecting {
  func inspect(
    target: MediaProxyTarget,
    hintedContentType: String?
  ) async throws -> CastMediaProfile {
    try CastMediaProfile(
      contentType: hintedContentType ?? "video/mp4",
      sourceURL: target.upstreamURL
    )
  }
}

private struct CastInspectionRequest: Equatable {
  let method: String
  let url: String
  let localHeaders: [String: String]
}

private final class FakeCastInspectionUpstream: CastRelayUpstreamOpening, @unchecked Sendable {
  private struct Key: Hashable {
    let method: String
    let url: String
  }

  private struct Stub {
    let status: Int
    let headers: [String: String]
    let body: MediaProxyUpstreamBody
  }

  private let lock = NSLock()
  private var stubs: [Key: [Stub]] = [:]
  private var recorded: [CastInspectionRequest] = []

  var requests: [CastInspectionRequest] { lock.withPreparationLock { recorded } }

  func enqueue(
    url: String,
    method: String,
    status: Int,
    headers: [String: String],
    body: Data
  ) {
    enqueue(
      url: url,
      method: method,
      status: status,
      headers: headers,
      bodyObject: FakeCastInspectionBody(body)
    )
  }

  func enqueue(
    url: String,
    method: String,
    status: Int,
    headers: [String: String],
    bodyObject: MediaProxyUpstreamBody
  ) {
    lock.withPreparationLock {
      stubs[Key(method: method, url: url), default: []].append(Stub(
        status: status,
        headers: headers,
        body: bodyObject
      ))
    }
  }

  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    try lock.withPreparationLock {
      let method = target.method.uppercased()
      let url = target.upstreamURL.absoluteString
      recorded.append(CastInspectionRequest(
        method: method,
        url: url,
        localHeaders: localHeaders
      ))
      let key = Key(method: method, url: url)
      guard var queued = stubs[key], !queued.isEmpty else {
        throw MediaProxyUpstreamError.connectionFailed
      }
      let stub = queued.removeFirst()
      stubs[key] = queued
      return MediaProxyUpstreamResponse(
        statusCode: stub.status,
        headers: stub.headers,
        finalURL: target.upstreamURL,
        body: stub.body
      )
    }
  }
}

private final class FailingCastInspectionUpstream: CastRelayUpstreamOpening,
  @unchecked Sendable {
  private let error: Error

  init(error: Error) { self.error = error }

  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    throw error
  }
}

private final class FakeCastInspectionBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var data: Data?
  private var cancelled = false

  init(_ data: Data) { self.data = data }

  func nextChunk() async throws -> Data? {
    try lock.withPreparationLock {
      guard !cancelled else { throw MediaProxyUpstreamError.cancelled }
      defer { data = nil }
      return data
    }
  }

  func cancel() {
    lock.withPreparationLock {
      cancelled = true
      data = nil
    }
  }
}

private final class SuspendingCastInspectionBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data?, Error>?
  private var started = false
  private var cancelled = false

  var didStart: Bool { lock.withPreparationLock { started } }
  var isCancelled: Bool { lock.withPreparationLock { cancelled } }

  func nextChunk() async throws -> Data? {
    try await withCheckedThrowingContinuation { continuation in
      let cancelImmediately = lock.withPreparationLock { () -> Bool in
        started = true
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
    let pending = lock.withPreparationLock { () -> CheckedContinuation<Data?, Error>? in
      guard !cancelled else { return nil }
      cancelled = true
      defer { continuation = nil }
      return continuation
    }
    pending?.resume(throwing: MediaProxyUpstreamError.cancelled)
  }
}

private final class FakeCastRelayPreparing: CastRelayPreparing, @unchecked Sendable {
  private let lock = NSLock()
  private var targets: [MediaProxyTarget] = []
  private var counters: [PreparationStopCounter] = []
  var rootTargets: [MediaProxyTarget] { lock.withPreparationLock { targets } }
  var stopCounters: [PreparationStopCounter] { lock.withPreparationLock { counters } }

  func prepare(
    selection: CastNetworkSelection,
    rootTarget: MediaProxyTarget,
    profile: CastMediaProfile,
    tracks: [CastSourceTrack]
  ) async throws -> PreparedCastRelay {
    let counter = PreparationStopCounter()
    let index = lock.withPreparationLock { () -> Int in
      targets.append(rootTarget)
      counters.append(counter)
      return counters.count
    }
    let token = String(repeating: Character(String(index % 10)), count: 43)
    let contentURL = URL(string: "http://192.168.1.20:49152/cast/\(String(repeating: "A", count: 43))/\(token)")!
    let gate = PreparationStopGate(counter: counter)
    return PreparedCastRelay(
      contentURL: contentURL,
      profile: profile,
      textTracks: [],
      stop: { await gate.stop() }
    )
  }
}

private actor PreparationStopGate {
  private let counter: PreparationStopCounter
  private var stopped = false
  init(counter: PreparationStopCounter) { self.counter = counter }
  func stop() {
    guard !stopped else { return }
    stopped = true
    counter.increment()
  }
}

private final class PreparationStopCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.withPreparationLock { count } }
  func increment() { lock.withPreparationLock { count += 1 } }
}

private final class FakeRollbackListenerFactory: CastRelayListenerFactory, @unchecked Sendable {
  let listener: FakeRollbackListener
  init(listener: FakeRollbackListener) { self.listener = listener }
  func makeListener(
    boundTo localAddress: MediaProxyIPAddress,
    port: NWEndpoint.Port
  ) throws -> CastRelayListener { listener }
}

private enum FakeRollbackRegistrationProbe {
  private static let lock = NSLock()
  private static var issued: [String] = []
  private static var live: Set<String> = []

  static var issuedCount: Int { lock.withPreparationLock { issued.count } }
  static var liveCount: Int { lock.withPreparationLock { live.count } }

  static func reset() {
    lock.withPreparationLock {
      issued.removeAll()
      live.removeAll()
    }
  }

  static func registered(_ token: String) {
    lock.withPreparationLock {
      issued.append(token)
      live.insert(token)
    }
  }

  static func listenerStopped() {
    lock.withPreparationLock { live.removeAll() }
  }
}

private final class CastMediaPreparerTokenSource: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func next() -> String {
    lock.withPreparationLock {
      value += 1
      let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
      return String(repeating: alphabet[value % alphabet.count], count: 43)
    }
  }
}

private final class FakeRollbackListener: CastRelayListener, @unchecked Sendable {
  let port = NWEndpoint.Port(rawValue: 49_152)
  var newConnectionHandler: ((CastRelayConnection) -> Void)?
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)?
  private let lock = NSLock()
  private(set) var cancelCount = 0
  func start(on queue: DispatchQueue) { stateUpdateHandler?(.ready) }
  func cancel() {
    lock.withPreparationLock { cancelCount += 1 }
    FakeRollbackRegistrationProbe.listenerStopped()
  }
}

private final class FakeRollbackPathMonitor: CastRelayPathMonitoring, @unchecked Sendable {
  @discardableResult
  func start(_ handler: @escaping @Sendable (CastRouteSnapshot) -> Void) -> Bool { true }
  func cancel() {}
}

private final class FakeRollbackUpstream: CastRelayUpstreamOpening, @unchecked Sendable {
  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    throw MediaProxyUpstreamError.connectionFailed
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ errorHandler: (Error) -> Void = { _ in }
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw")
  } catch {
    errorHandler(error)
  }
}

private extension Collection {
  var single: Element? { count == 1 ? first : nil }
}

private extension NSLock {
  func withPreparationLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try operation()
  }
}
