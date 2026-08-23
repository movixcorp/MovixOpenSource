import XCTest
@testable import Movix

final class MediaProxyPolicyTests: XCTestCase {
  private let publicV4 = MediaProxyIPAddress("93.184.216.34")!
  private let publicV6 = MediaProxyIPAddress("2606:2800:220:1:248:1893:25c8:1946")!

  func testAcceptsOnlyPublicHTTPSURLsOnTheDefaultPort() throws {
    let implicitPort = try MediaProxyPolicy.validatePublicHTTPSURL(
      "https://video.example/stream.m3u8",
      resolve: { _ in [self.publicV4, self.publicV6] },
      activeNAT64Prefixes: []
    )
    let explicitPort = try MediaProxyPolicy.validatePublicHTTPSURL(
      "HTTPS://video.example:443/stream.m3u8",
      resolve: { _ in [self.publicV4] },
      activeNAT64Prefixes: []
    )

    XCTAssertEqual(implicitPort.absoluteString, "https://video.example/stream.m3u8")
    XCTAssertEqual(explicitPort.port, 443)
    assertURLFailure("http://video.example/stream.m3u8", .httpsRequired)
    assertURLFailure("https://video.example:8443/stream.m3u8", .unsupportedPort)
    assertURLFailure("https://user:password@video.example/stream.m3u8", .credentialsForbidden)
    assertURLFailure("https:///stream.m3u8", .missingHost)
  }

  func testRejectsReservedLocalHostsBeforeResolution() {
    for host in [
      "localhost", "LOCALHOST.", "video.localhost", "printer.local",
      "router.home.arpa", "service.internal", "host.localdomain",
    ] {
      var resolverCalled = false
      XCTAssertThrowsError(try MediaProxyPolicy.validatePublicHTTPSURL(
        "https://\(host)/stream.m3u8",
        resolve: { _ in
          resolverCalled = true
          return [self.publicV4]
        },
        activeNAT64Prefixes: []
      )) { error in
        XCTAssertEqual(error as? MediaProxyPolicyError, .forbiddenHost, host)
      }
      XCTAssertFalse(resolverCalled, host)
    }
  }

  func testRejectsPrivateAddressLiteralsEvenWithAInjectedPublicResolver() {
    for host in [
      "127.0.0.1", "127.0.0.1.", "127.1", "0177.0.0.1", "0x7f000001", "2130706433",
      "[::1]", "[::ffff:127.0.0.1]",
    ] {
      var resolverCalled = false
      XCTAssertThrowsError(try MediaProxyPolicy.validatePublicHTTPSURL(
        "https://\(host)/secret",
        resolve: { _ in
          resolverCalled = true
          return [self.publicV4]
        },
        activeNAT64Prefixes: []
      )) { error in
        XCTAssertEqual(error as? MediaProxyPolicyError, .forbiddenAddress, host)
      }
      XCTAssertFalse(resolverCalled, host)
    }
  }

  func testRejectsEmptyFailedOrPartlyPrivateDNSResults() {
    assertURLFailure("https://video.example/stream.m3u8", .dnsFailed, resolve: { _ in [] })
    assertURLFailure("https://video.example/stream.m3u8", .dnsFailed, resolve: { _ in
      throw ResolverFailure.expected
    })
    assertURLFailure("https://video.example/stream.m3u8", .forbiddenAddress, resolve: { _ in
      [self.publicV4, MediaProxyIPAddress("10.0.0.1")!]
    })
  }

  func testURLLengthUsesUTF8BytesBeforeAndAfterFoundationNormalization() {
    let tooLongRaw = "https://video.example/" + String(repeating: "a", count: MediaProxyPolicy.maximumURLLength)
    assertURLFailure(tooLongRaw, .invalidURL)

    // The raw Unicode URL is below the limit, but URL normalization percent-encodes it beyond the limit.
    let normalizationExpansion = "https://video.example/" + String(repeating: "\u{00E9}", count: 3_000)
    XCTAssertLessThan(normalizationExpansion.utf8.count, MediaProxyPolicy.maximumURLLength)
    assertURLFailure(normalizationExpansion, .invalidURL)
  }

  func testRejectsForbiddenIPv4Ranges() {
    let forbidden = [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1",
      "169.254.1.1", "172.16.0.1", "172.31.255.254", "192.0.0.1", "192.0.2.1",
      "192.0.0.170", "192.0.0.171", "192.88.99.1", "192.168.1.1",
      "198.18.0.1", "198.19.255.254", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]

    for literal in forbidden {
      XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(MediaProxyIPAddress(literal)!), literal)
    }
    for literal in [
      "8.8.8.8", "93.184.216.34", "100.128.0.1", "172.32.0.1",
      "192.0.0.9", "192.0.0.10", "223.255.255.254",
    ] {
      XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(MediaProxyIPAddress(literal)!), literal)
    }
  }

  func testRejectsForbiddenIPv6RangesAndClassifiesEmbeddedIPv4() {
    let forbidden = [
      "::", "::1", "fe80::1", "febf::1", "fec0::1", "fc00::1", "fdff::1", "ff02::1",
      "2001:db8::1", "2001:2::1", "100::1", "100:0:0:1::1", "64:ff9b:1::1",
      "2001:0:ffff::1", "2001:1::4", "2001:5::1", "2001:10::1",
      "3fff:0fff::1", "5f00::1",
      "::ffff:10.0.0.1", "::192.168.1.1", "64:ff9b::127.0.0.1",
      "2002:0a00:0001::1", "2001:0000::ffff:ffff:f5ff:fffe",
    ]

    for literal in forbidden {
      XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(MediaProxyIPAddress(literal)!), literal)
    }
    for literal in [
      "2001:4860:4860::8888", "2606:4700:4700::1111",
      "2001:1::1", "2001:1::2", "2001:1::3", "2001:3:abcd::1",
      "2001:4:112:ffff::1", "2001:2f::1", "2001:3f::1",
      "3fff:1000::1", "5f01::1",
      "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2002:0808:0808::1",
    ] {
      XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(MediaProxyIPAddress(literal)!), literal)
    }
  }

  func testRFC6052PrefixesRoundTripEverySupportedLength() {
    let prefixes = [
      MediaProxyNAT64Prefix("2606:4700::", length: 32)!,
      MediaProxyNAT64Prefix("2606:4700:1200::", length: 40)!,
      MediaProxyNAT64Prefix("2606:4700:1234::", length: 48)!,
      MediaProxyNAT64Prefix("2606:4700:1234:5600::", length: 56)!,
      MediaProxyNAT64Prefix("2606:4700:1234:5678::", length: 64)!,
      MediaProxyNAT64Prefix("2606:4700:1234:5678:9abc:def0::", length: 96)!,
    ]
    let publicIPv4 = MediaProxyIPAddress("8.8.4.4")!
    let privateIPv4 = MediaProxyIPAddress("10.0.0.1")!

    for prefix in prefixes {
      let publicSynthetic = prefix.synthesize(publicIPv4)!
      let privateSynthetic = prefix.synthesize(privateIPv4)!
      XCTAssertEqual(prefix.extractIPv4(from: publicSynthetic), publicIPv4, "prefix length \(prefix.length)")
      XCTAssertEqual(prefix.extractIPv4(from: privateSynthetic), privateIPv4, "prefix length \(prefix.length)")
    }
    if case let .v6(validBytes) = prefixes[3].synthesize(publicIPv4)! {
      var invalidBytes = validBytes
      invalidBytes[8] = 1
      XCTAssertNil(prefixes[3].extractIPv4(from: .v6(invalidBytes)))
    }
    XCTAssertNil(MediaProxyNAT64Prefix("2606:4700::", length: 24))
    XCTAssertNotNil(MediaProxyNAT64Prefix(
      "2606:4700:1234:5678:9abc:def0::",
      length: 96
    ))
    XCTAssertNil(MediaProxyNAT64Prefix(
      "2606:4700:1234:5678:9abc:def0::1",
      length: 96
    ))
  }

  func testDerivesRFC7050PrefixOnlyFromPairedWellKnownAnswers() {
    let prefix = MediaProxyNAT64Prefix("2606:4700:1234:5600::", length: 56)!
    let answer170 = prefix.synthesize(MediaProxyIPAddress("192.0.0.170")!)!
    let answer171 = prefix.synthesize(MediaProxyIPAddress("192.0.0.171")!)!

    XCTAssertEqual(MediaProxyPolicy.deriveNAT64Prefixes(from: [answer170, answer171]), [prefix])
    XCTAssertTrue(MediaProxyPolicy.deriveNAT64Prefixes(from: [answer170]).isEmpty)
  }

  func testDerivesRFC7050NSP96WithNonzeroPrefixBytes8Through11() {
    let prefix = MediaProxyNAT64Prefix(
      "2606:4700:1234:5678:9abc:def0::",
      length: 96
    )!
    let answers = [
      prefix.synthesize(MediaProxyIPAddress("192.0.0.170")!)!,
      prefix.synthesize(MediaProxyIPAddress("192.0.0.171")!)!,
    ]

    XCTAssertEqual(MediaProxyPolicy.deriveNAT64Prefixes(from: answers), [prefix])
  }

  func testDiscoversRFC7050PrefixesThroughAnInjectedIPv6Resolver() {
    let prefix = MediaProxyNAT64Prefix(
      "2606:4700:1234:5678:9abc:def0::",
      length: 96
    )!
    let answers = [
      prefix.synthesize(MediaProxyIPAddress("192.0.0.170")!)!,
      prefix.synthesize(MediaProxyIPAddress("192.0.0.171")!)!,
    ]
    var resolvedHost: String?

    let discovered = MediaProxyPolicy.discoverNAT64Prefixes { host in
      resolvedHost = host
      return answers
    }

    XCTAssertEqual(resolvedHost, "ipv4only.arpa")
    XCTAssertEqual(discovered, [prefix])
    XCTAssertTrue(MediaProxyPolicy.discoverNAT64Prefixes { _ in
      throw ResolverFailure.expected
    }.isEmpty)
  }

  func testClassifiesWellKnownAndActiveLocalUseNAT64Prefixes() {
    let publicAddress = MediaProxyIPAddress("8.8.8.8")!
    let privateAddress = MediaProxyIPAddress("10.0.0.1")!
    let wellKnown = MediaProxyNAT64Prefix("64:ff9b::", length: 96)!
    let localUse = MediaProxyNAT64Prefix("64:ff9b:1::", length: 48)!

    XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(wellKnown.synthesize(publicAddress)!))
    XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(wellKnown.synthesize(privateAddress)!))
    XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(localUse.synthesize(publicAddress)!))
    XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(
      localUse.synthesize(publicAddress)!,
      activeNAT64Prefixes: [localUse]
    ))
    XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(
      localUse.synthesize(privateAddress)!,
      activeNAT64Prefixes: [localUse]
    ))
  }

  func testClassifiesActiveOperatorNAT64PrefixesAt96AndNon96Lengths() {
    let publicAddress = MediaProxyIPAddress("8.8.8.8")!
    let privateAddress = MediaProxyIPAddress("192.168.1.1")!
    let prefixes = [
      MediaProxyNAT64Prefix("2606:4700:64::", length: 96)!,
      MediaProxyNAT64Prefix("2606:4700:1234:5600::", length: 56)!,
    ]

    for prefix in prefixes {
      XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(
        prefix.synthesize(publicAddress)!,
        activeNAT64Prefixes: [prefix]
      ))
      XCTAssertTrue(MediaProxyPolicy.isForbiddenAddress(
        prefix.synthesize(privateAddress)!,
        activeNAT64Prefixes: [prefix]
      ))
    }

    // An arbitrary inactive NSP is indistinguishable from ordinary public IPv6 space.
    XCTAssertFalse(MediaProxyPolicy.isForbiddenAddress(prefixes[0].synthesize(privateAddress)!))
  }

  func testURLValidationAppliesInjectedNAT64PrefixesToAllDNSAnswers() throws {
    let prefix = MediaProxyNAT64Prefix(
      "2606:4700:1234:5678:9abc:def0::",
      length: 96
    )!
    let publicSynthetic = prefix.synthesize(MediaProxyIPAddress("8.8.8.8")!)!
    let privateSynthetic = prefix.synthesize(MediaProxyIPAddress("10.0.0.1")!)!

    XCTAssertNoThrow(try MediaProxyPolicy.validatePublicHTTPSURL(
      "https://video.example/stream.m3u8",
      resolve: { _ in [publicSynthetic] },
      activeNAT64Prefixes: [prefix]
    ))
    XCTAssertThrowsError(try MediaProxyPolicy.validatePublicHTTPSURL(
      "https://video.example/stream.m3u8",
      resolve: { _ in [publicSynthetic, privateSynthetic] },
      activeNAT64Prefixes: [prefix]
    )) { error in
      XCTAssertEqual(error as? MediaProxyPolicyError, .forbiddenAddress)
    }
  }

  func testSanitizesOnlyTheExactHeaderAllowlistWithoutCredentials() {
    let sanitized = MediaProxyPolicy.sanitizeRequestHeaders([
      " origin ": " https://movix.tax ",
      "Referer": "https://movix.tax/watch",
      "Range": "bytes=100-",
      "Cookie": "session=secret",
      "Authorization": "Bearer secret",
      "Host": "internal.example",
      "Connection": "keep-alive",
      "Transfer-Encoding": "chunked",
      "X-Bad": "ignored",
    ])

    XCTAssertEqual(sanitized, [
      "Origin": "https://movix.tax",
      "Referer": "https://movix.tax/watch",
      "Range": "bytes=100-",
    ])
  }

  func testRejectsUnsafeEmptyAndOversizedHeaderValues() {
    let sanitized = MediaProxyPolicy.sanitizeRequestHeaders([
      "Accept": "\r\nInjected: yes",
      "Accept-Language": "fr\u{0}en",
      "Content-Type": "video\u{7f}/mp2t",
      "If-Modified-Since": "\t",
      "If-None-Match": String(repeating: "\u{00E9}", count: 4_097),
      "Range": "bytes=0-\u{1f}",
      "Sec-Fetch-Dest": String(repeating: " ", count: 8_193) + "video",
    ])

    XCTAssertTrue(sanitized.isEmpty)
  }

  func testRejectsCaseVariantDuplicatesDeterministically() {
    let sanitized = MediaProxyPolicy.sanitizeRequestHeaders([
      "Origin": "https://first.example",
      " origin ": "https://second.example",
      "Range": "bytes=10-",
    ])

    XCTAssertNil(sanitized["Origin"])
    XCTAssertEqual(sanitized["Range"], "bytes=10-")
  }

  func testLocalOverridesUseTheRestrictedAllowlist() {
    let sanitized = MediaProxyPolicy.sanitizeLocalOverrideHeaders([
      " Accept ": "application/vnd.apple.mpegurl",
      "RANGE": "bytes=20-",
      "Origin": "https://attacker.example",
      "Referer": "https://attacker.example/watch",
      "Content-Type": "text/plain",
      "User-Agent": "attacker",
    ])

    XCTAssertEqual(sanitized, [
      "Accept": "application/vnd.apple.mpegurl",
      "Range": "bytes=20-",
    ])
  }

  private func assertURLFailure(
    _ raw: String,
    _ expected: MediaProxyPolicyError,
    resolve: ((String) throws -> [MediaProxyIPAddress])? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let resolver = resolve ?? { _ in [self.publicV4] }
    XCTAssertThrowsError(
      try MediaProxyPolicy.validatePublicHTTPSURL(
        raw,
        resolve: resolver,
        activeNAT64Prefixes: []
      ),
      file: file,
      line: line
    ) { error in
      XCTAssertEqual(error as? MediaProxyPolicyError, expected, file: file, line: line)
    }
  }
}

private enum ResolverFailure: Error {
  case expected
}
