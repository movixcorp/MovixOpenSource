import Foundation
import Network
import XCTest
@testable import Movix

final class MediaProxyIntegrationTests: XCTestCase {
  private let publicAddress = MediaProxyIPAddress("93.184.216.34")!

  func testRedirectsAreRevalidatedAndPinnedAtEveryHop() async throws {
    let transport = RecordingUpstreamTransport { request, call in
      if call == 0 {
        return MediaProxyUpstreamTransportResponse(
          statusCode: 302,
          headers: ["Location": "https://media.example/final/master.m3u8"],
          body: TestUpstreamBody([])
        )
      }
      return MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "application/vnd.apple.mpegurl"],
        body: TestUpstreamBody([Data("#EXTM3U\n".utf8)])
      )
    }
    let firstAddress = MediaProxyIPAddress("93.184.216.34")!
    let secondAddress = MediaProxyIPAddress("8.8.8.8")!
    let resolver = RecordingResolver([
      "origin.example": [firstAddress],
      "media.example": [secondAddress],
    ])
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { try resolver.resolve($0) },
      activeNAT64Prefixes: { [] }
    )
    let response = try await upstream.open(
      target: MediaProxyTarget(
        upstreamURL: URL(string: "https://origin.example/start")!,
        method: "GET",
        headers: ["Origin": "https://movix.tax", "Referer": "https://movix.tax/watch"]
      ),
      localHeaders: [:]
    )

    XCTAssertEqual(response.finalURL.absoluteString, "https://media.example/final/master.m3u8")
    XCTAssertEqual(resolver.hosts, ["origin.example", "media.example"])
    XCTAssertEqual(transport.requests.map(\.pinnedAddresses), [[firstAddress], [secondAddress]])
    XCTAssertEqual(transport.requests.map(\.url), [
      URL(string: "https://origin.example/start")!,
      URL(string: "https://media.example/final/master.m3u8")!,
    ])
    XCTAssertNil(transport.requests[1].headers["Origin"])
    XCTAssertNil(transport.requests[1].headers["Referer"])
    response.body.cancel()
  }

  func testRejectsPrivateRebindingAnswerBeforeTransportStarts() async {
    let transport = RecordingUpstreamTransport { _, _ in
      XCTFail("Transport must not start for a private DNS answer")
      return MediaProxyUpstreamTransportResponse(
        statusCode: 500,
        headers: [:],
        body: TestUpstreamBody([])
      )
    }
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { _ in [MediaProxyIPAddress("10.0.0.1")!] },
      activeNAT64Prefixes: { [] }
    )

    do {
      _ = try await upstream.open(
        target: MediaProxyTarget(
          upstreamURL: URL(string: "https://rebind.example/video.ts")!,
          method: "GET",
          headers: ["Range": "bytes=0-99"]
        ),
        localHeaders: [:]
      )
      XCTFail("Expected rebinding rejection")
    } catch {
      XCTAssertEqual(error as? MediaProxyPolicyError, .forbiddenAddress)
    }
    XCTAssertTrue(transport.requests.isEmpty)
  }

  func testRedirectLimitIsExactlyFive() async {
    let transport = RecordingUpstreamTransport { _, call in
      MediaProxyUpstreamTransportResponse(
        statusCode: 302,
        headers: ["Location": "/redirect-\(call + 1)"],
        body: TestUpstreamBody([])
      )
    }
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )

    do {
      _ = try await upstream.open(
        target: MediaProxyTarget(
          upstreamURL: URL(string: "https://video.example/redirect-0")!,
          method: "GET",
          headers: [:]
        ),
        localHeaders: [:]
      )
      XCTFail("Expected redirect limit rejection")
    } catch {
      XCTAssertEqual(error as? MediaProxyUpstreamError, .tooManyRedirects)
    }
    XCTAssertEqual(transport.requests.count, 6)
  }

  func testServerRewritesFinalURLPlaylistConvertsSRTAndPreservesRange206() async throws {
    let fixture = MediaProxyURLProtocolFixture()
    fixture.install { request in
      switch (request.url?.host, request.url?.path) {
      case ("origin.example", "/start"):
        return .response(302, ["Location": "https://cdn.example/final/master.m3u8"], Data())
      case ("cdn.example", "/final/master.m3u8"):
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI=\"captions/fr.srt\"\nsegment.ts\n"
        return .response(200, ["Content-Type": "application/vnd.apple.mpegurl"], Data(playlist.utf8))
      case ("cdn.example", "/final/segment.ts"):
        XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=100-199")
        return .response(
          206,
          [
            "Content-Type": "video/mp2t",
            "Content-Range": "bytes 100-199/1000",
            "Content-Length": "100",
          ],
          Data(repeating: 0x47, count: 100)
        )
      case ("cdn.example", "/final/captions/fr.srt"):
        let srt = "1\r\n00:00:01,250 --> 00:00:03,500\r\nBonjour\r\n"
        return .response(200, ["Content-Type": "application/x-subrip"], Data(srt.utf8))
      default:
        return .response(404, [:], Data())
      }
    }
    defer { fixture.uninstall() }
    let upstream = MediaProxyUpstream(
      testingConfiguration: fixture.configuration,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let server = MediaProxyServer(store: MediaProxySessionStore(), upstream: upstream)
    addTeardownBlock { await server.close() }
    let localURL = try await server.open(target: MediaProxyTarget(
      upstreamURL: URL(string: "https://origin.example/start")!,
      method: "GET",
      headers: ["User-Agent": "MovixTests"]
    ))

    let (playlistData, playlistResponse) = try await URLSession.shared.data(from: localURL)
    let playlist = try XCTUnwrap(String(data: playlistData, encoding: .utf8))
    XCTAssertEqual(playlistResponse.mimeType, "application/vnd.apple.mpegurl")
    XCTAssertEqual(playlistResponse.expectedContentLength, Int64(playlistData.count))
    XCTAssertFalse(playlist.contains("https://cdn.example"))

    let segmentURL = try XCTUnwrap(firstLoopbackURL(in: playlist))
    var segmentRequest = URLRequest(url: segmentURL)
    segmentRequest.setValue("bytes=100-199", forHTTPHeaderField: "Range")
    let (segmentData, segmentResponseValue) = try await URLSession.shared.data(for: segmentRequest)
    let segmentResponse = try XCTUnwrap(segmentResponseValue as? HTTPURLResponse)
    XCTAssertEqual(segmentResponse.statusCode, 206)
    XCTAssertEqual(segmentResponse.value(forHTTPHeaderField: "Content-Range"), "bytes 100-199/1000")
    XCTAssertEqual(segmentData.count, 100)

    let subtitleURL = try XCTUnwrap(subtitleLoopbackURL(in: playlist))
    let (subtitleData, subtitleResponseValue) = try await URLSession.shared.data(from: subtitleURL)
    let subtitleResponse = try XCTUnwrap(subtitleResponseValue as? HTTPURLResponse)
    XCTAssertEqual(subtitleResponse.value(forHTTPHeaderField: "Content-Type"), "text/vtt; charset=utf-8")
    XCTAssertEqual(
      String(data: subtitleData, encoding: .utf8),
      "WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nBonjour"
    )
    XCTAssertEqual(fixture.requestedHosts, [
      "origin.example", "cdn.example", "cdn.example", "cdn.example",
    ])
  }

  func testHeadPreservesHeadersWithoutSendingABody() async throws {
    let fixture = MediaProxyURLProtocolFixture()
    fixture.install { request in
      XCTAssertEqual(request.httpMethod, "HEAD")
      return .response(
        200,
        ["Content-Type": "video/mp4", "Content-Length": "500"],
        Data(repeating: 7, count: 500)
      )
    }
    defer { fixture.uninstall() }
    let upstream = MediaProxyUpstream(
      testingConfiguration: fixture.configuration,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let server = MediaProxyServer(store: MediaProxySessionStore(), upstream: upstream)
    addTeardownBlock { await server.close() }
    let localURL = try await server.open(target: MediaProxyTarget(
      upstreamURL: URL(string: "https://video.example/movie.mp4")!,
      method: "GET",
      headers: [:]
    ))
    var request = URLRequest(url: localURL)
    request.httpMethod = "HEAD"

    let (data, responseValue) = try await URLSession.shared.data(for: request)
    let response = try XCTUnwrap(responseValue as? HTTPURLResponse)
    XCTAssertEqual(response.statusCode, 200)
    XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Length"), "500")
    XCTAssertTrue(data.isEmpty)
  }

  func testStreamingUsesBackpressureAndDisconnectCancelsUpstream() async throws {
    let backpressureBody = TestBackpressureBody(
      chunks: Array(repeating: Data(repeating: 0x47, count: 32_768), count: 4)
    )
    let directTransport = RecordingUpstreamTransport { _, _ in
      MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "video/mp2t"],
        body: backpressureBody
      )
    }
    let directUpstream = MediaProxyUpstream(
      transport: directTransport,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let directServer = MediaProxyServer(store: MediaProxySessionStore(), upstream: directUpstream)
    let directURL = try await directServer.open(target: mediaTarget("https://video.example/live.ts"))
    let (data, _) = try await URLSession.shared.data(from: directURL)
    XCTAssertEqual(data.count, 4 * 32_768)
    XCTAssertEqual(backpressureBody.maximumConcurrentReads, 1)
    await directServer.close()

    let fixture = MediaProxyURLProtocolFixture()
    let upstreamStarted = expectation(description: "upstream started")
    let upstreamCancelled = expectation(description: "upstream cancelled")
    fixture.installSlowResponse(started: upstreamStarted, cancelled: upstreamCancelled)
    defer { fixture.uninstall() }
    let slowUpstream = MediaProxyUpstream(
      testingConfiguration: fixture.configuration,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let slowServer = MediaProxyServer(store: MediaProxySessionStore(), upstream: slowUpstream)
    let slowURL = try await slowServer.open(target: mediaTarget("https://video.example/slow.ts"))
    let localTask = URLSession.shared.dataTask(with: slowURL)
    localTask.resume()
    await fulfillment(of: [upstreamStarted], timeout: 2)
    localTask.cancel()
    await fulfillment(of: [upstreamCancelled], timeout: 2)
    await slowServer.close()
  }

  func testExpiredOrRevokedLeaseStopsStreaming() async throws {
    let clock = TestMediaProxyClock(Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 1,
      absoluteTTL: 30
    )
    let body = TestUpstreamBody([Data(repeating: 1, count: 32)])
    let transport = RecordingUpstreamTransport { _, _ in
      MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "video/mp4"],
        body: body
      )
    }
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let server = MediaProxyServer(store: store, upstream: upstream)
    let localURL = try await server.open(target: mediaTarget("https://video.example/movie.mp4"))
    clock.advance(by: 1)

    let (_, responseValue) = try await URLSession.shared.data(from: localURL)
    XCTAssertEqual((responseValue as? HTTPURLResponse)?.statusCode, 404)
    XCTAssertTrue(transport.requests.isEmpty)
    await server.close()

    let secondReadStarted = expectation(description: "second upstream read started")
    let cancelled = expectation(description: "revoked upstream body cancelled")
    let pausingBody = TestPausingBody(
      first: Data(repeating: 2, count: 32_768),
      secondReadStarted: secondReadStarted,
      cancelled: cancelled
    )
    let liveStore = MediaProxySessionStore(idleTTL: 1_000, absoluteTTL: 1_000)
    let liveTransport = RecordingUpstreamTransport { _, _ in
      MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "video/mp4"],
        body: pausingBody
      )
    }
    let liveUpstream = MediaProxyUpstream(
      transport: liveTransport,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let liveServer = MediaProxyServer(store: liveStore, upstream: liveUpstream)
    let liveURL = try await liveServer.open(target: mediaTarget("https://video.example/other.mp4"))
    let resolvedTarget = await liveServer.resolveForCast(liveURL)
    XCTAssertNotNil(resolvedTarget)
    let localRead = Task { try? await URLSession.shared.data(from: liveURL) }
    await fulfillment(of: [secondReadStarted], timeout: 2)
    await liveStore.invalidateAll()
    pausingBody.resumeSecond(with: Data(repeating: 3, count: 32_768))
    await fulfillment(of: [cancelled], timeout: 2)
    _ = await localRead.value
    XCTAssertTrue(pausingBody.wasCancelled)
    await liveServer.close()
  }

  func testRotationReturnsStrictLocal307AndRetargetsAThroughC() async throws {
    let clock = TestMediaProxyClock(Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 1_000,
      absoluteTTL: 100,
      rotationLeadTime: 10,
      transitionGraceTTL: 100
    )
    let transport = RecordingUpstreamTransport { _, _ in
      MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "video/mp4"],
        body: TestUpstreamBody([Data([1])])
      )
    }
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let server = MediaProxyServer(store: store, upstream: upstream)
    let urlA = try await server.open(target: mediaTarget("https://video.example/movie.mp4"))
    clock.advance(by: 90)

    let responseAB = try await responseWithoutFollowingRedirect(urlA)
    XCTAssertEqual(responseAB.statusCode, 307)
    let urlB = try XCTUnwrap(responseAB.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
    assertStrictLocalRedirect(from: urlA, to: urlB)
    clock.advance(by: 90)
    let responseBC = try await responseWithoutFollowingRedirect(urlB)
    XCTAssertEqual(responseBC.statusCode, 307)
    let urlC = try XCTUnwrap(responseBC.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
    assertStrictLocalRedirect(from: urlB, to: urlC)

    let responseAC = try await responseWithoutFollowingRedirect(urlA)
    XCTAssertEqual(responseAC.statusCode, 307)
    XCTAssertEqual(responseAC.value(forHTTPHeaderField: "Location"), urlC.absoluteString)
    XCTAssertTrue(transport.requests.isEmpty)
    await server.close()
  }

  func testLocalizedCrossHostHLSResourcesInheritProviderHeadersWithoutSensitiveHeaders() async throws {
    let fixture = MediaProxyURLProtocolFixture()
    fixture.install { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://provider.example")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Referer"), "https://provider.example/watch")
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      switch (request.url?.host, request.url?.path) {
      case ("origin.example", "/master.m3u8"):
        return .response(
          200,
          ["Content-Type": "application/vnd.apple.mpegurl"],
          Data("#EXTM3U\nhttps://cdn.example/nested.m3u8\n".utf8)
        )
      case ("cdn.example", "/nested.m3u8"):
        return .response(
          200,
          ["Content-Type": "application/vnd.apple.mpegurl"],
          Data("#EXTM3U\nhttps://assets.example/segment.ts\n".utf8)
        )
      case ("assets.example", "/segment.ts"):
        return .response(200, ["Content-Type": "video/mp2t"], Data([0x47]))
      default:
        return .response(404, [:], Data())
      }
    }
    defer { fixture.uninstall() }
    let upstream = MediaProxyUpstream(
      testingConfiguration: fixture.configuration,
      resolve: { _ in [self.publicAddress] },
      activeNAT64Prefixes: { [] }
    )
    let server = MediaProxyServer(store: MediaProxySessionStore(), upstream: upstream)
    addTeardownBlock { await server.close() }
    let rootURL = try await server.open(target: MediaProxyTarget(
      upstreamURL: URL(string: "https://origin.example/master.m3u8")!,
      method: "GET",
      headers: [
        "Origin": "https://provider.example",
        "Referer": "https://provider.example/watch",
        "Cookie": "session=must-not-leak",
        "Authorization": "Bearer must-not-leak",
        "Host": "attacker.example",
      ]
    ))

    let (rootData, _) = try await URLSession.shared.data(from: rootURL)
    let root = try XCTUnwrap(String(data: rootData, encoding: .utf8))
    let nestedURL = try XCTUnwrap(firstLoopbackURL(in: root))
    let (nestedData, _) = try await URLSession.shared.data(from: nestedURL)
    let nested = try XCTUnwrap(String(data: nestedData, encoding: .utf8))
    let segmentURL = try XCTUnwrap(firstLoopbackURL(in: nested))
    let (segment, _) = try await URLSession.shared.data(from: segmentURL)

    XCTAssertEqual(segment, Data([0x47]))
    XCTAssertEqual(fixture.requestedHosts, ["origin.example", "cdn.example", "assets.example"])
  }

  func testPartialHLS206StreamsRawAndPreservesRangeHeaders() async throws {
    let fixture = MediaProxyURLProtocolFixture()
    let partial = Data("https://cdn.example/segment.ts\n".utf8)
    let range = "bytes=0-\(partial.count - 1)"
    let contentRange = "bytes 0-\(partial.count - 1)/100"
    fixture.install { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), range)
      if request.url?.path == "/captions.srt" {
        return .response(
          206,
          [
            "Content-Type": "application/x-subrip",
            "Content-Range": contentRange,
            "Content-Length": String(partial.count),
          ],
          partial
        )
      }
      return .response(
        206,
        [
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Range": contentRange,
          "Content-Length": String(partial.count),
        ],
        partial
      )
    }
    defer { fixture.uninstall() }
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(
        testingConfiguration: fixture.configuration,
        resolve: { _ in [self.publicAddress] },
        activeNAT64Prefixes: { [] }
      )
    )
    addTeardownBlock { await server.close() }
    let localURL = try await server.open(target: mediaTarget("https://origin.example/master.m3u8"))
    var request = URLRequest(url: localURL)
    request.setValue(range, forHTTPHeaderField: "Range")

    let (data, responseValue) = try await URLSession.shared.data(for: request)
    let response = try XCTUnwrap(responseValue as? HTTPURLResponse)
    XCTAssertEqual(response.statusCode, 206)
    XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Range"), contentRange)
    XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Length"), String(partial.count))
    XCTAssertEqual(data, partial)

    let subtitleURL = try await server.open(target: mediaTarget("https://origin.example/captions.srt"))
    var subtitleRequest = URLRequest(url: subtitleURL)
    subtitleRequest.setValue(range, forHTTPHeaderField: "Range")
    let (subtitleData, subtitleResponseValue) = try await URLSession.shared.data(for: subtitleRequest)
    let subtitleResponse = try XCTUnwrap(subtitleResponseValue as? HTTPURLResponse)
    XCTAssertEqual(subtitleResponse.statusCode, 206)
    XCTAssertEqual(subtitleResponse.value(forHTTPHeaderField: "Content-Range"), contentRange)
    XCTAssertEqual(subtitleData, partial)
  }

  func testPinnedResponseDecoderConsumesInformationalResponsesAndRejectsAmbiguousBodylessFraming() throws {
    var decoder = MediaProxyHTTPResponseHeadDecoder(requestMethod: "GET")
    let response = Data((
      "HTTP/1.1 103 Early Hints\r\nLink: </asset>; rel=preload\r\n\r\n"
        + "HTTP/1.1 100 Continue\r\n\r\n"
        + "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody"
    ).utf8)
    let decoded = try XCTUnwrap(decoder.append(response))
    XCTAssertEqual(decoded.statusCode, 200)
    XCTAssertEqual(decoded.framing, .contentLength(4))
    XCTAssertEqual(decoded.initialBody, Data("body".utf8))

    for raw in [
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n",
      "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n",
      "HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n",
    ] {
      var bodyless = MediaProxyHTTPResponseHeadDecoder(requestMethod: "HEAD")
      XCTAssertThrowsError(try bodyless.append(Data(raw.utf8)))
    }

    var divergent = MediaProxyHTTPResponseHeadDecoder(requestMethod: "HEAD")
    XCTAssertThrowsError(try divergent.append(Data(
      "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\n".utf8
    )))

    var excessive = MediaProxyHTTPResponseHeadDecoder(requestMethod: "GET")
    let informational = String(repeating: "HTTP/1.1 103 Early Hints\r\n\r\n", count: 9)
      + "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
    XCTAssertThrowsError(try excessive.append(Data(informational.utf8)))
  }

  func testChunkedDecoderRequiresCompleteTrailersAndBoundsExtensions() throws {
    var decoder = MediaProxyChunkedBodyDecoder()
    var buffer = Data((
      "4;name=value\r\nWiki\r\n"
        + "5;quoted=\"safe value\"\r\npedia\r\n"
        + "0\r\nX-Checksum: okay\r\n\r\n"
    ).utf8)
    var decoded = Data()
    while let chunk = try decoder.takeChunk(from: &buffer) { decoded.append(chunk) }
    XCTAssertEqual(decoded, Data("Wikipedia".utf8))
    XCTAssertTrue(decoder.isComplete)
    XCTAssertTrue(buffer.isEmpty)
    XCTAssertNoThrow(try decoder.validateEndOfStream())

    var truncated = MediaProxyChunkedBodyDecoder()
    var truncatedBuffer = Data("0\r\n".utf8)
    XCTAssertNil(try truncated.takeChunk(from: &truncatedBuffer))
    XCTAssertFalse(truncated.isComplete)
    XCTAssertThrowsError(try truncated.validateEndOfStream()) { error in
      XCTAssertEqual(error as? MediaProxyUpstreamError, .truncatedBody)
    }

    var overflow = MediaProxyChunkedBodyDecoder()
    var overflowBuffer = Data(("0\r\nX-Long: " + String(repeating: "a", count: 8 * 1_024)).utf8)
    XCTAssertThrowsError(try overflow.takeChunk(from: &overflowBuffer))

    var oversizedExtension = MediaProxyChunkedBodyDecoder()
    var oversizedExtensionBuffer = Data((
      "1;name=" + String(repeating: "a", count: 129) + "\r\na\r\n0\r\n\r\n"
    ).utf8)
    XCTAssertThrowsError(try oversizedExtension.takeChunk(from: &oversizedExtensionBuffer))
  }

  func testPinnedTransportTriesValidatedAddressesSequentially() async throws {
    let first = MediaProxyIPAddress("93.184.216.34")!
    let second = MediaProxyIPAddress("8.8.8.8")!
    let attempts = TestAddressRecorder()
    let transport = MediaProxyPinnedHTTPTransport(
      totalTimeout: 1,
      perAttemptTimeout: 0.5,
      exchangeFactory: { _, address in
        attempts.append(address)
        return TestPinnedExchange {
          if address == first { throw MediaProxyUpstreamError.connectionFailed }
          return MediaProxyUpstreamTransportResponse(
            statusCode: 200,
            headers: ["Content-Length": "0"],
            body: TestUpstreamBody([])
          )
        }
      }
    )
    let resolver = RecordingResolver(["video.example": [first, second]])
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { try resolver.resolve($0) },
      activeNAT64Prefixes: { [] }
    )
    let response = try await upstream.open(
      target: MediaProxyTarget(
        upstreamURL: URL(string: "https://video.example/movie.mp4")!,
        method: "GET",
        headers: ["Origin": "https://provider.example"]
      ),
      localHeaders: [:]
    )
    XCTAssertEqual(response.statusCode, 200)
    XCTAssertEqual(attempts.values, [first, second])
    XCTAssertEqual(resolver.hosts, ["video.example"])
    response.body.cancel()
  }

  func testPinnedTransportFailsAfterAllValidatedAddressesFail() async {
    let addresses = [
      MediaProxyIPAddress("93.184.216.34")!,
      MediaProxyIPAddress("8.8.8.8")!,
    ]
    let attempts = TestAddressRecorder()
    let transport = MediaProxyPinnedHTTPTransport(
      totalTimeout: 1,
      perAttemptTimeout: 0.5,
      exchangeFactory: { _, address in
        attempts.append(address)
        return TestPinnedExchange { throw MediaProxyUpstreamError.connectionFailed }
      }
    )
    let resolver = RecordingResolver(["video.example": addresses])
    let upstream = MediaProxyUpstream(
      transport: transport,
      resolve: { try resolver.resolve($0) },
      activeNAT64Prefixes: { [] }
    )
    do {
      _ = try await upstream.open(
        target: MediaProxyTarget(
          upstreamURL: URL(string: "https://video.example/movie.mp4")!,
          method: "GET",
          headers: [:]
        ),
        localHeaders: [:]
      )
      XCTFail("Expected every validated address to fail")
    } catch {
      XCTAssertEqual(error as? MediaProxyUpstreamError, .connectionFailed)
    }
    XCTAssertEqual(attempts.values, addresses)
    XCTAssertEqual(resolver.hosts, ["video.example"])
  }

  func testListenerCloseInvalidatesPendingGenerationAndConcurrentOpenSharesLiveListener() async throws {
    let factory = TestLoopbackListenerFactory()
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(),
      makeListener: { try factory.make() },
      timing: MediaProxyServerTiming(listenerStartTimeout: 1, requestTimeout: 10, sendTimeout: 1)
    )
    let firstOpen = Task { try await server.open(target: self.mediaTarget("https://video.example/one.ts")) }
    let first = try await factory.nextCreatedListener()
    await server.close()
    first.transition(to: .ready)
    do {
      _ = try await firstOpen.value
      XCTFail("A closed listener generation must not produce a URL")
    } catch {
      XCTAssertEqual(error as? MediaProxyServerError, .listenerUnavailable)
    }
    XCTAssertTrue(first.wasCancelled)

    let secondOpen = Task { try await server.open(target: self.mediaTarget("https://video.example/two.ts")) }
    let thirdOpen = Task { try await server.open(target: self.mediaTarget("https://video.example/three.ts")) }
    let second = try await factory.nextCreatedListener()
    await Task.yield()
    XCTAssertEqual(factory.createdCount, 2)
    second.transition(to: .ready)
    let secondURL = try await secondOpen.value
    let thirdURL = try await thirdOpen.value
    XCTAssertEqual(secondURL.port, Int(second.port!.rawValue))
    XCTAssertEqual(thirdURL.port, secondURL.port)
    XCTAssertNotEqual(secondURL.path, thirdURL.path)
    await server.close()

    let timeoutFactory = TestLoopbackListenerFactory()
    let timeoutServer = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(),
      makeListener: { try timeoutFactory.make() },
      timing: MediaProxyServerTiming(
        listenerStartTimeout: 0.05,
        requestTimeout: 1,
        sendTimeout: 1
      )
    )
    let timedOpen = Task {
      try await timeoutServer.open(target: self.mediaTarget("https://video.example/timeout.ts"))
    }
    let timedListener = try await timeoutFactory.nextCreatedListener()
    do {
      _ = try await timedOpen.value
      XCTFail("A listener that never becomes ready must time out")
    } catch {
      XCTAssertEqual(error as? MediaProxyServerError, .listenerUnavailable)
    }
    XCTAssertTrue(timedListener.wasCancelled)
    await timeoutServer.close()
  }

  func testLoopbackClientCapIsExactAndEarlyFailureReleasesSlot() async throws {
    let factory = TestLoopbackListenerFactory()
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(),
      makeListener: { try factory.make() },
      timing: MediaProxyServerTiming(listenerStartTimeout: 1, requestTimeout: 10, sendTimeout: 1)
    )
    let opening = Task { try await server.open(target: self.mediaTarget("https://video.example/live.ts")) }
    let listener = try await factory.nextCreatedListener()
    listener.transition(to: .ready)
    _ = try await opening.value

    let clients = (0..<65).map { _ in TestLoopbackConnection() }
    for client in clients { listener.accept(client) }
    XCTAssertTrue(clients.prefix(64).allSatisfy { $0.startCount == 1 })
    XCTAssertEqual(clients[64].startCount, 0)
    XCTAssertTrue(clients[64].wasCancelled)

    clients[0].transition(to: .failed)
    let replacement = TestLoopbackConnection()
    listener.accept(replacement)
    XCTAssertEqual(replacement.startCount, 1)
    await server.close()
  }

  func testRequestDeadlineIsAbsoluteAndBlockedSendTimesOut() async throws {
    let clock = TestMonotonicClock(100)
    let factory = TestLoopbackListenerFactory()
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(),
      makeListener: { try factory.make() },
      timing: MediaProxyServerTiming(listenerStartTimeout: 1, requestTimeout: 10, sendTimeout: 0.05),
      monotonicNow: { clock.now }
    )
    let opening = Task { try await server.open(target: self.mediaTarget("https://video.example/live.ts")) }
    let listener = try await factory.nextCreatedListener()
    listener.transition(to: .ready)
    _ = try await opening.value

    let slow = TestLoopbackConnection(autoCompleteSends: true)
    listener.accept(slow)
    slow.transition(to: .ready)
    await slow.waitForReceive()
    clock.advance(by: 11)
    slow.completeReceive(with: Data("G".utf8), isComplete: false)
    await slow.waitUntilCancelled()
    XCTAssertEqual(slow.receiveCount, 1)

    let blocked = TestLoopbackConnection(autoCompleteSends: false)
    listener.accept(blocked)
    blocked.transition(to: .ready)
    await blocked.waitForReceive()
    blocked.completeReceive(
      with: Data("GET /bad HTTP/1.1\r\nHost: 127.0.0.1:\(listener.port!.rawValue)\r\n\r\n".utf8),
      isComplete: false
    )
    await blocked.waitForSend()
    await blocked.waitUntilCancelled()
    await server.close()
  }

  func testControlledSendCompletionEnforcesBackpressure() async throws {
    let body = TestReadCountingBody([Data([1]), Data([2])])
    let transport = RecordingUpstreamTransport { _, _ in
      MediaProxyUpstreamTransportResponse(
        statusCode: 200,
        headers: ["Content-Type": "video/mp2t"],
        body: body
      )
    }
    let factory = TestLoopbackListenerFactory()
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(
        transport: transport,
        resolve: { _ in [self.publicAddress] },
        activeNAT64Prefixes: { [] }
      ),
      makeListener: { try factory.make() },
      timing: MediaProxyServerTiming(listenerStartTimeout: 1, requestTimeout: 1, sendTimeout: 1)
    )
    let opening = Task { try await server.open(target: self.mediaTarget("https://video.example/live.ts")) }
    let listener = try await factory.nextCreatedListener()
    listener.transition(to: .ready)
    let localURL = try await opening.value
    let connection = TestLoopbackConnection(autoCompleteSends: false)
    listener.accept(connection)
    connection.transition(to: .ready)
    await connection.waitForReceive()
    connection.completeReceive(
      with: Data("GET \(localURL.path) HTTP/1.1\r\nHost: 127.0.0.1:\(listener.port!.rawValue)\r\n\r\n".utf8),
      isComplete: false
    )

    await connection.waitForSend()
    XCTAssertEqual(body.readCount, 0)
    connection.completeNextSend()
    await connection.waitForSend(count: 2)
    XCTAssertEqual(body.readCount, 1)
    await Task.yield()
    XCTAssertEqual(body.readCount, 1)
    connection.completeNextSend()
    await connection.waitForSend(count: 3)
    XCTAssertEqual(body.readCount, 2)
    connection.completeAllSends()
    await server.close()
  }

  func testHeadErrorsHaveNoBodyAndEncodedSubRipIsRejected() async throws {
    let fixture = MediaProxyURLProtocolFixture()
    fixture.install { request in
      if request.url?.path == "/encoded.srt" {
        return .response(
          200,
          ["Content-Type": "application/x-subrip", "Content-Encoding": "gzip"],
          Data("not-gzip-and-not-srt".utf8)
        )
      }
      return .response(500, [:], Data())
    }
    defer { fixture.uninstall() }
    let server = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(
        testingConfiguration: fixture.configuration,
        resolve: { _ in [self.publicAddress] },
        activeNAT64Prefixes: { [] }
      )
    )
    addTeardownBlock { await server.close() }
    let localURL = try await server.open(target: mediaTarget("https://video.example/encoded.srt"))
    let (subtitleData, subtitleResponseValue) = try await URLSession.shared.data(from: localURL)
    XCTAssertEqual((subtitleResponseValue as? HTTPURLResponse)?.statusCode, 502)
    XCTAssertEqual(String(data: subtitleData, encoding: .utf8), "Media proxy error\n")

    var invalidComponents = URLComponents(url: localURL, resolvingAgainstBaseURL: false)!
    invalidComponents.path = "/bad"
    var head = URLRequest(url: invalidComponents.url!)
    head.httpMethod = "HEAD"
    let (headData, headResponseValue) = try await URLSession.shared.data(for: head)
    XCTAssertEqual((headResponseValue as? HTTPURLResponse)?.statusCode, 404)
    XCTAssertTrue(headData.isEmpty)

    let failingTransport = RecordingUpstreamTransport { _, _ in
      throw MediaProxyUpstreamError.connectionFailed
    }
    let failingServer = MediaProxyServer(
      store: MediaProxySessionStore(),
      upstream: MediaProxyUpstream(
        transport: failingTransport,
        resolve: { _ in [self.publicAddress] },
        activeNAT64Prefixes: { [] }
      )
    )
    addTeardownBlock { await failingServer.close() }
    let failingURL = try await failingServer.open(target: mediaTarget("https://video.example/failure.ts"))
    var failingHead = URLRequest(url: failingURL)
    failingHead.httpMethod = "HEAD"
    let (failingData, failingResponseValue) = try await URLSession.shared.data(for: failingHead)
    XCTAssertEqual((failingResponseValue as? HTTPURLResponse)?.statusCode, 502)
    XCTAssertTrue(failingData.isEmpty)
  }

  private func mediaTarget(_ rawURL: String) -> MediaProxyTarget {
    MediaProxyTarget(upstreamURL: URL(string: rawURL)!, method: "GET", headers: [:])
  }

  private func firstLoopbackURL(in playlist: String) -> URL? {
    playlist.split(whereSeparator: \.isNewline)
      .map(String.init)
      .first(where: { $0.hasPrefix("http://127.0.0.1:") })
      .flatMap(URL.init(string:))
  }

  private func subtitleLoopbackURL(in playlist: String) -> URL? {
    guard let range = playlist.range(of: "data:application/vnd.apple.mpegurl,") else { return nil }
    let encoded = String(playlist[range.upperBound...]).split(separator: "\"").first.map(String.init) ?? ""
    guard let decoded = encoded.removingPercentEncoding else { return nil }
    return decoded.split(whereSeparator: \.isNewline)
      .map(String.init)
      .first(where: { $0.hasPrefix("http://127.0.0.1:") })
      .flatMap(URL.init(string:))
  }

  private func responseWithoutFollowingRedirect(_ url: URL) async throws -> HTTPURLResponse {
    let delegate = NoRedirectURLSessionDelegate()
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (_, response) = try await session.data(from: url)
    return try XCTUnwrap(response as? HTTPURLResponse)
  }

  private func assertStrictLocalRedirect(
    from source: URL,
    to destination: URL,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertEqual(destination.scheme, "http", file: file, line: line)
    XCTAssertEqual(destination.host, "127.0.0.1", file: file, line: line)
    XCTAssertEqual(destination.port, source.port, file: file, line: line)
    XCTAssertNil(destination.query, file: file, line: line)
    XCTAssertNil(destination.fragment, file: file, line: line)
  }
}

private final class RecordingResolver: @unchecked Sendable {
  private let lock = NSLock()
  private let answers: [String: [MediaProxyIPAddress]]
  private var recordedHosts: [String] = []

  init(_ answers: [String: [MediaProxyIPAddress]]) { self.answers = answers }

  var hosts: [String] { lock.withLock { recordedHosts } }

  func resolve(_ host: String) throws -> [MediaProxyIPAddress] {
    lock.withLock { recordedHosts.append(host) }
    guard let answer = answers[host] else { throw MediaProxyPolicyError.dnsFailed }
    return answer
  }
}

private final class RecordingUpstreamTransport: MediaProxyUpstreamTransport, @unchecked Sendable {
  typealias Handler = (MediaProxyUpstreamTransportRequest, Int) throws -> MediaProxyUpstreamTransportResponse
  private let lock = NSLock()
  private let handler: Handler
  private var recordedRequests: [MediaProxyUpstreamTransportRequest] = []

  init(handler: @escaping Handler) { self.handler = handler }

  var requests: [MediaProxyUpstreamTransportRequest] { lock.withLock { recordedRequests } }

  func execute(_ request: MediaProxyUpstreamTransportRequest) async throws -> MediaProxyUpstreamTransportResponse {
    let call = lock.withLock { () -> Int in
      let current = recordedRequests.count
      recordedRequests.append(request)
      return current
    }
    return try handler(request, call)
  }
}

private final class TestAddressRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [MediaProxyIPAddress] = []

  var values: [MediaProxyIPAddress] { lock.withLock { recorded } }
  func append(_ value: MediaProxyIPAddress) { lock.withLock { recorded.append(value) } }
}

private final class TestPinnedExchange: MediaProxyPinnedHTTPExchangeTask, @unchecked Sendable {
  typealias Operation = @Sendable () async throws -> MediaProxyUpstreamTransportResponse
  private let operation: Operation
  private let lock = NSLock()
  private var cancelled = false

  init(operation: @escaping Operation) { self.operation = operation }

  func start(timeout: TimeInterval) async throws -> MediaProxyUpstreamTransportResponse {
    guard !lock.withLock({ cancelled }) else { throw MediaProxyUpstreamError.cancelled }
    return try await operation()
  }

  func cancel() { lock.withLock { cancelled = true } }
}

private final class TestLoopbackListenerFactory: @unchecked Sendable {
  private let lock = NSLock()
  private var listeners: [TestLoopbackListener] = []
  private var nextListenerIndex = 0
  private var waiter: CheckedContinuation<TestLoopbackListener, Never>?

  var createdCount: Int { lock.withLock { listeners.count } }

  func make() throws -> MediaProxyLoopbackListener {
    let snapshot = lock.withLock { () -> (TestLoopbackListener, CheckedContinuation<TestLoopbackListener, Never>?) in
      let rawPort = UInt16(18_000 + listeners.count)
      let listener = TestLoopbackListener(port: NWEndpoint.Port(rawValue: rawPort)!)
      listeners.append(listener)
      guard nextListenerIndex < listeners.count, let waiter = waiter else {
        return (listener, nil)
      }
      self.waiter = nil
      let next = listeners[nextListenerIndex]
      nextListenerIndex += 1
      return (next, waiter)
    }
    snapshot.1?.resume(returning: snapshot.0)
    return snapshot.0
  }

  func nextCreatedListener() async throws -> TestLoopbackListener {
    await withCheckedContinuation { continuation in
      let immediate = lock.withLock { () -> TestLoopbackListener? in
        if nextListenerIndex < listeners.count {
          defer { nextListenerIndex += 1 }
          return listeners[nextListenerIndex]
        }
        waiter = continuation
        return nil
      }
      if let immediate = immediate { continuation.resume(returning: immediate) }
    }
  }
}

private final class TestLoopbackListener: MediaProxyLoopbackListener, @unchecked Sendable {
  let port: NWEndpoint.Port?
  private let lock = NSLock()
  private var connectionHandler: ((MediaProxyLoopbackConnection) -> Void)?
  private var updateHandler: ((MediaProxyLoopbackState) -> Void)?
  private var cancelled = false

  init(port: NWEndpoint.Port) { self.port = port }

  var newConnectionHandler: ((MediaProxyLoopbackConnection) -> Void)? {
    get { lock.withLock { connectionHandler } }
    set { lock.withLock { connectionHandler = newValue } }
  }

  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)? {
    get { lock.withLock { updateHandler } }
    set { lock.withLock { updateHandler = newValue } }
  }

  var wasCancelled: Bool { lock.withLock { cancelled } }

  func start(on queue: DispatchQueue) {}

  func cancel() { lock.withLock { cancelled = true } }

  func transition(to state: MediaProxyLoopbackState) {
    lock.withLock { updateHandler }?(state)
  }

  func accept(_ connection: MediaProxyLoopbackConnection) {
    lock.withLock { connectionHandler }?(connection)
  }
}

private enum TestLoopbackError: Error { case cancelled }

private final class TestLoopbackConnection: MediaProxyLoopbackConnection, @unchecked Sendable {
  let endpoint: NWEndpoint
  private let lock = NSLock()
  private let autoCompleteSends: Bool
  private var updateHandler: ((MediaProxyLoopbackState) -> Void)?
  private var pendingReceives: [(@Sendable (Data?, Bool, Error?) -> Void)] = []
  private var pendingSends: [(@Sendable (Error?) -> Void)] = []
  private var receiveWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
  private var sendWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
  private var cancellationWaiters: [CheckedContinuation<Void, Never>] = []
  private var nextObservedReceive = 1
  private var starts = 0
  private var receives = 0
  private var sends = 0
  private var cancelled = false

  init(autoCompleteSends: Bool = false) {
    self.autoCompleteSends = autoCompleteSends
    endpoint = .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: .init(rawValue: 30_000)!)
  }

  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)? {
    get { lock.withLock { updateHandler } }
    set { lock.withLock { updateHandler = newValue } }
  }

  var startCount: Int { lock.withLock { starts } }
  var receiveCount: Int { lock.withLock { receives } }
  var wasCancelled: Bool { lock.withLock { cancelled } }

  func start(on queue: DispatchQueue) { lock.withLock { starts += 1 } }

  func transition(to state: MediaProxyLoopbackState) {
    lock.withLock { updateHandler }?(state)
  }

  func receive(
    maximumLength: Int,
    completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
  ) {
    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      receives += 1
      pendingReceives.append(completion)
      let ready = receiveWaiters.filter { $0.0 <= receives }.map { $0.1 }
      receiveWaiters.removeAll { $0.0 <= receives }
      return ready
    }
    waiters.forEach { $0.resume() }
  }

  func send(
    content: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    completion: @escaping @Sendable (Error?) -> Void
  ) {
    let snapshot = lock.withLock { () -> ([CheckedContinuation<Void, Never>], Bool) in
      sends += 1
      if !autoCompleteSends { pendingSends.append(completion) }
      let ready = sendWaiters.filter { $0.0 <= sends }.map { $0.1 }
      sendWaiters.removeAll { $0.0 <= sends }
      return (ready, autoCompleteSends)
    }
    snapshot.0.forEach { $0.resume() }
    if snapshot.1 { completion(nil) }
  }

  func cancel() {
    let snapshot = lock.withLock { () -> (
      [(@Sendable (Data?, Bool, Error?) -> Void)],
      [(@Sendable (Error?) -> Void)],
      [CheckedContinuation<Void, Never>]
    ) in
      guard !cancelled else { return ([], [], []) }
      cancelled = true
      defer {
        pendingReceives.removeAll()
        pendingSends.removeAll()
        cancellationWaiters.removeAll()
      }
      return (pendingReceives, pendingSends, cancellationWaiters)
    }
    snapshot.0.forEach { $0(nil, true, TestLoopbackError.cancelled) }
    snapshot.1.forEach { $0(TestLoopbackError.cancelled) }
    snapshot.2.forEach { $0.resume() }
  }

  func completeReceive(with data: Data?, isComplete: Bool) {
    let completion = lock.withLock { pendingReceives.isEmpty ? nil : pendingReceives.removeFirst() }
    completion?(data, isComplete, nil)
  }

  func completeNextSend() {
    let completion = lock.withLock { pendingSends.isEmpty ? nil : pendingSends.removeFirst() }
    completion?(nil)
  }

  func completeAllSends() {
    while lock.withLock({ !pendingSends.isEmpty }) { completeNextSend() }
  }

  func waitForReceive() async {
    let target = lock.withLock { () -> Int in
      defer { nextObservedReceive += 1 }
      return nextObservedReceive
    }
    await withCheckedContinuation { continuation in
      let ready = lock.withLock { () -> Bool in
        guard receives < target else { return true }
        receiveWaiters.append((target, continuation))
        return false
      }
      if ready { continuation.resume() }
    }
  }

  func waitForSend(count target: Int = 1) async {
    await withCheckedContinuation { continuation in
      let ready = lock.withLock { () -> Bool in
        guard sends < target else { return true }
        sendWaiters.append((target, continuation))
        return false
      }
      if ready { continuation.resume() }
    }
  }

  func waitUntilCancelled() async {
    await withCheckedContinuation { continuation in
      let ready = lock.withLock { () -> Bool in
        guard !cancelled else { return true }
        cancellationWaiters.append(continuation)
        return false
      }
      if ready { continuation.resume() }
    }
  }
}

private final class TestMonotonicClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: TimeInterval

  init(_ value: TimeInterval) { self.value = value }
  var now: TimeInterval { lock.withLock { value } }
  func advance(by interval: TimeInterval) { lock.withLock { value += interval } }
}

private final class TestReadCountingBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var chunks: [Data]
  private var reads = 0
  private var cancelled = false

  init(_ chunks: [Data]) { self.chunks = chunks }
  var readCount: Int { lock.withLock { reads } }

  func nextChunk() async throws -> Data? {
    lock.withLock {
      guard !cancelled else { return nil }
      reads += 1
      return chunks.isEmpty ? nil : chunks.removeFirst()
    }
  }

  func cancel() { lock.withLock { cancelled = true } }
}

private class TestUpstreamBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var chunks: [Data]
  private(set) var isCancelled = false

  init(_ chunks: [Data]) { self.chunks = chunks }

  func nextChunk() async throws -> Data? {
    lock.withLock {
      guard !isCancelled, !chunks.isEmpty else { return nil }
      return chunks.removeFirst()
    }
  }

  func cancel() { lock.withLock { isCancelled = true } }
}

private final class TestBackpressureBody: TestUpstreamBody {
  private let metricsLock = NSLock()
  private var activeReads = 0
  private var maximumReads = 0

  init(chunks: [Data]) { super.init(chunks) }

  var maximumConcurrentReads: Int { metricsLock.withLock { maximumReads } }

  override func nextChunk() async throws -> Data? {
    metricsLock.withLock {
      activeReads += 1
      maximumReads = max(maximumReads, activeReads)
    }
    defer { metricsLock.withLock { activeReads -= 1 } }
    return try await super.nextChunk()
  }
}

private final class TestPausingBody: MediaProxyUpstreamBody, @unchecked Sendable {
  private let lock = NSLock()
  private var first: Data?
  private var continuation: CheckedContinuation<Data?, Never>?
  private var cancelledState = false
  private let secondReadStarted: XCTestExpectation
  private let cancelledExpectation: XCTestExpectation

  init(
    first: Data,
    secondReadStarted: XCTestExpectation,
    cancelled: XCTestExpectation
  ) {
    self.first = first
    self.secondReadStarted = secondReadStarted
    cancelledExpectation = cancelled
  }

  var wasCancelled: Bool { lock.withLock { cancelledState } }

  func nextChunk() async throws -> Data? {
    if let first = lock.withLock({ () -> Data? in
      defer { self.first = nil }
      return self.first
    }) {
      return first
    }
    return await withCheckedContinuation { continuation in
      lock.withLock { self.continuation = continuation }
      secondReadStarted.fulfill()
    }
  }

  func resumeSecond(with data: Data) {
    let continuation = lock.withLock { () -> CheckedContinuation<Data?, Never>? in
      defer { self.continuation = nil }
      return self.continuation
    }
    continuation?.resume(returning: data)
  }

  func cancel() {
    let state = lock.withLock { () -> (Bool, CheckedContinuation<Data?, Never>?) in
      let firstCancellation = !cancelledState
      cancelledState = true
      defer { continuation = nil }
      return (firstCancellation, continuation)
    }
    state.1?.resume(returning: nil)
    if state.0 { cancelledExpectation.fulfill() }
  }
}

private final class TestMediaProxyClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date

  init(_ value: Date) { self.value = value }
  var now: Date { lock.withLock { value } }
  func advance(by interval: TimeInterval) {
    lock.withLock { value = value.addingTimeInterval(interval) }
  }
}

private final class NoRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private enum MediaProxyURLProtocolFixtureResult {
  case response(Int, [String: String], Data)
}

private final class MediaProxyURLProtocolFixture {
  private let state = MediaProxyURLProtocolFixtureState()

  var configuration: URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MediaProxyFixtureURLProtocol.self]
    MediaProxyFixtureURLProtocol.state = state
    return configuration
  }

  var requestedHosts: [String] { state.requestedHosts }

  func install(
    _ handler: @escaping @Sendable (URLRequest) -> MediaProxyURLProtocolFixtureResult
  ) {
    state.install(handler)
    MediaProxyFixtureURLProtocol.state = state
  }

  func installSlowResponse(started: XCTestExpectation, cancelled: XCTestExpectation) {
    state.installSlow(started: started, cancelled: cancelled)
    MediaProxyFixtureURLProtocol.state = state
  }

  func uninstall() {
    state.uninstall()
    if MediaProxyFixtureURLProtocol.state === state { MediaProxyFixtureURLProtocol.state = nil }
  }
}

private final class MediaProxyURLProtocolFixtureState: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (URLRequest) -> MediaProxyURLProtocolFixtureResult)?
  private var slowStarted: XCTestExpectation?
  private var slowCancelled: XCTestExpectation?
  private var hosts: [String] = []

  var requestedHosts: [String] { lock.withLock { hosts } }

  func install(_ handler: @escaping @Sendable (URLRequest) -> MediaProxyURLProtocolFixtureResult) {
    lock.withLock { self.handler = handler }
  }

  func installSlow(started: XCTestExpectation, cancelled: XCTestExpectation) {
    lock.withLock {
      slowStarted = started
      slowCancelled = cancelled
      handler = nil
    }
  }

  func uninstall() {
    lock.withLock {
      handler = nil
      slowStarted = nil
      slowCancelled = nil
      hosts = []
    }
  }

  func start(_ protocolInstance: MediaProxyFixtureURLProtocol, request: URLRequest) {
    let snapshot = lock.withLock { () -> ((@Sendable (URLRequest) -> MediaProxyURLProtocolFixtureResult)?, XCTestExpectation?) in
      if let host = request.url?.host { hosts.append(host) }
      return (handler, slowStarted)
    }
    if let started = snapshot.1 {
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "video/mp2t"]
      )!
      protocolInstance.client?.urlProtocol(protocolInstance, didReceive: response, cacheStoragePolicy: .notAllowed)
      protocolInstance.client?.urlProtocol(protocolInstance, didLoad: Data(repeating: 0x47, count: 1_024))
      started.fulfill()
      return
    }
    guard let result = snapshot.0?(request) else {
      protocolInstance.client?.urlProtocol(protocolInstance, didFailWithError: URLError(.badServerResponse))
      return
    }
    switch result {
    case let .response(status, headers, data):
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
      )!
      protocolInstance.client?.urlProtocol(protocolInstance, didReceive: response, cacheStoragePolicy: .notAllowed)
      if !data.isEmpty { protocolInstance.client?.urlProtocol(protocolInstance, didLoad: data) }
      protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
    }
  }

  func stop() {
    let expectation = lock.withLock { () -> XCTestExpectation? in
      defer { slowCancelled = nil }
      return slowCancelled
    }
    expectation?.fulfill()
  }
}

private final class MediaProxyFixtureURLProtocol: URLProtocol {
  static var state: MediaProxyURLProtocolFixtureState?

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.scheme == "https"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let state = Self.state else {
      client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
      return
    }
    state.start(self, request: request)
  }

  override func stopLoading() { Self.state?.stop() }
}

private extension NSLock {
  func withLock<Result>(_ body: () throws -> Result) rethrows -> Result {
    lock()
    defer { unlock() }
    return try body()
  }
}
