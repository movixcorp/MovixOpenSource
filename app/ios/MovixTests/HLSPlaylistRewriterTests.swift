import Foundation
import XCTest
@testable import Movix

final class HLSPlaylistRewriterTests: XCTestCase {
  private let baseURL = URL(string: "https://cdn.example/library/master/main.m3u8")!

  func testRewritesResourceLinesPreservingIndentationCRLFAndTrailingNewline() throws {
    let source = "#EXTM3U\r\n  video/segment-1.ts  \r\n"
    XCTAssertEqual(
      try rewrite(source),
      "#EXTM3U\r\n  \(localized("https://cdn.example/library/master/video/segment-1.ts"))  \r\n"
    )
  }

  func testRewritesExactURIAttributesAcrossAllowedHLSDirectiveTypes() throws {
    let source = """
    #EXT-X-KEY:METHOD=AES-128,URI = "keys/key.bin",IV=0x1
    #EXT-X-MAP:URI='init.mp4'
    #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1, URI = "iframes.m3u8"
    #EXT-X-SESSION-DATA:DATA-ID="com.example",URI="session.json"
    #EXT-X-SESSION-KEY:METHOD=AES-128,URI="session.key"
    #EXT-X-PART:DURATION=0.2,URI="part.m4s"
    #EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"
    #EXT-X-RENDITION-REPORT:URI="variant.m3u8"
    #EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,URI="image.m3u8"
    """
    let output = try rewrite(source)

    for path in ["keys/key.bin", "init.mp4", "iframes.m3u8", "session.json", "session.key", "part.m4s", "next.m4s", "variant.m3u8", "image.m3u8"] {
      XCTAssertTrue(output.contains(localized("https://cdn.example/library/master/\(path)")), path)
    }
  }

  func testRewritesMultipleURIAttributesWithoutIndexCorruption() throws {
    let source = "#EXT-X-KEY:METHOD=AES-128,URI=\"a\",URI=\"a-very-long-key-name.bin\""
    let expected = "#EXT-X-KEY:METHOD=AES-128,URI=\"\(localized("https://cdn.example/library/master/a"))\",URI=\"\(localized("https://cdn.example/library/master/a-very-long-key-name.bin"))\""
    XCTAssertEqual(try rewrite(source), expected)
  }

  func testDoesNotRewriteURITextInsideQuotedValuesOrNonURIAttributes() throws {
    let source = "#EXT-X-MEDIA:TYPE=AUDIO,NAME=\"URI=not-a-url,still-name\",X-URI=\"bad.m3u8\",URI=\"good.m3u8\""
    let expected = "#EXT-X-MEDIA:TYPE=AUDIO,NAME=\"URI=not-a-url,still-name\",X-URI=\"bad.m3u8\",URI=\"\(localized("https://cdn.example/library/master/good.m3u8"))\""
    XCTAssertEqual(try rewrite(source), expected)
  }

  func testLeavesNonAttributeTagPayloadsByteIdentical() throws {
    let source = "#EXTINF:10,URI=\"title\"\r\n#EXT-X-PROGRAM-DATE-TIME:URI=\"2026-01-01T00:00:00Z\"\r\n#EXT-X-UNKNOWN:URI=\"unchanged\""
    XCTAssertEqual(try rewrite(source), source)
  }

  func testDoesNotCallLocalizerForDataOrBlobURIs() throws {
    let source = "#EXT-X-KEY:METHOD=NONE,URI=\"data:text/plain,ok\"\n#EXT-X-MAP:URI = 'blob:abc'\ndata:application/octet-stream,bytes\nblob:segment"
    let output = try HLSPlaylistRewriter.rewrite(source, baseURL: baseURL, wrapDirectSubtitles: true) { _ in
      XCTFail("localizer must not be called")
      return "http://127.0.0.1:8080/proxy"
    }
    XCTAssertEqual(output, source)
  }

  func testWrapsDirectVTTSubtitleWithQueryForWhitespaceTolerantMediaTag() throws {
    let source = "#EXT-X-MEDIA: TYPE = SUBTITLES , GROUP-ID=\"sub\", URI = \"tracks/fr.vtt?lang=fr\""
    let output = try rewrite(source)
    let wrapped = try XCTUnwrap(attributeValue(named: "URI", in: output))
    XCTAssertTrue(wrapped.hasPrefix("data:application/vnd.apple.mpegurl,"))
    let decoded = try XCTUnwrap(String(wrapped.dropFirst("data:application/vnd.apple.mpegurl,".count)).removingPercentEncoding)
    XCTAssertEqual(decoded, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:999999\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:999999.0,\n\(localized("https://cdn.example/library/master/tracks/fr.vtt?lang=fr"))\n#EXT-X-ENDLIST")
  }

  func testWrapsSubRipSubtitleAndExposesTask4ConversionContract() throws {
    let source = "#EXT-X-MEDIA:TYPE=SUBTITLES,URI=\"tracks/fr.srt\""
    let output = try rewrite(source)
    let wrapped = try XCTUnwrap(attributeValue(named: "URI", in: output))
    let decoded = try XCTUnwrap(String(wrapped.dropFirst("data:application/vnd.apple.mpegurl,".count)).removingPercentEncoding)
    XCTAssertEqual(decoded, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:999999\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:999999.0,\n\(localized("https://cdn.example/library/master/tracks/fr.srt"))\n#EXT-X-ENDLIST")
    XCTAssertEqual(HLSPlaylistRewriter.subtitleResourceFormat(for: URL(string: "https://cdn.example/tracks/fr.srt")!), .subRip)
  }

  func testConvertsSubRipToWebVTTWithStrictTimestampValidation() {
    let source = "\u{FEFF}1\r\n00:00:01,250 --> 00:00:03,500\r\nBonjour\r\nle monde\r\n\r\n00:00:04,000 --> 00:00:05,000\r\nSalut"
    XCTAssertEqual(HLSPlaylistRewriter.convertSubRipToWebVTT(source), "WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nBonjour\nle monde\n\n00:00:04.000 --> 00:00:05.000\nSalut")
    XCTAssertEqual(HLSPlaylistRewriter.convertSubRipToWebVTT("123:59:59.999 --> 124:00:00,000\nLong cue"), "WEBVTT\n\n123:59:59.999 --> 124:00:00.000\nLong cue")
    for invalid in [
      "00:60:00,000 --> 00:00:01,000\nText",
      "00:00:60,000 --> 00:00:01,000\nText",
      "00:00:01,25 --> 00:00:02,000\nText",
      "00:01,000 --> 00:00:02,000\nText",
      "01:00:02,000 --> 00:00:01,000\nBackward",
    ] {
      XCTAssertNil(HLSPlaylistRewriter.convertSubRipToWebVTT(invalid), invalid)
    }
  }

  func testRejectsEntireSubRipWhenAnyNonemptyBlockIsInvalid() {
    let valid = "1\n00:00:01,000 --> 00:00:02,000\nValid"
    XCTAssertNil(HLSPlaylistRewriter.convertSubRipToWebVTT("\n  \n\(valid)\n\n\t\n\n2\ninvalid\nBroken\n\n \n"))
    XCTAssertNil(HLSPlaylistRewriter.convertSubRipToWebVTT("\(valid)\n\n2\n00:00:03,000 --> 00:00:04,000"))
  }

  func testRejectsUnsafeLocalizerOutputAndPropagatesFailure() {
    for value in ["", "//127.0.0.1/proxy", "javascript:alert(1)", "data:text/plain,ok", "blob:abc", "file:///tmp/x", "https://user:secret@example.com/proxy", "http://127.0.0.1:8080/ok\r\nInjected: yes", "https://example.com/\"quote"] {
      XCTAssertThrowsError(try HLSPlaylistRewriter.rewrite(
        "#EXT-X-KEY:URI=\"key.bin\"", baseURL: baseURL, wrapDirectSubtitles: true, localize: { _ in value }
      )) { error in
        XCTAssertEqual(error as? HLSPlaylistRewriterError, .invalidLocalizedURL)
      }
    }
    XCTAssertThrowsError(try HLSPlaylistRewriter.rewrite(
      "#EXT-X-KEY:URI=\"key.bin\"", baseURL: baseURL, wrapDirectSubtitles: true, localize: { _ in throw LocalizerFailure.expected }
    )) { error in
      XCTAssertEqual(error as? LocalizerFailure, .expected)
    }
  }

  func testAcceptsSafeRelativeLocalizerReference() throws {
    let source = "#EXT-X-KEY:URI=\"key.bin\""
    let output = try HLSPlaylistRewriter.rewrite(source, baseURL: baseURL, wrapDirectSubtitles: true) { url in
      "local?url=" + (url.absoluteString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
    }
    XCTAssertEqual(output, "#EXT-X-KEY:URI=\"local?url=https://cdn.example/library/master/key.bin\"")
  }

  func testResolvesAbsoluteAndNetworkPathURLsAgainstFinalBaseURL() throws {
    let source = "https://origin.example/path/one.ts\n//media.example/two.ts\n../three.ts"
    XCTAssertEqual(try rewrite(source), "\(localized("https://origin.example/path/one.ts"))\n\(localized("https://media.example/two.ts"))\n\(localized("https://cdn.example/library/three.ts"))")
  }

  private func rewrite(_ source: String) throws -> String {
    try HLSPlaylistRewriter.rewrite(source, baseURL: baseURL, wrapDirectSubtitles: true, localize: localize)
  }

  private func localize(_ url: URL) -> String { localized(url.absoluteString) }

  private func localized(_ upstream: String) -> String {
    let encoded = upstream.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
    return "http://127.0.0.1:8080/proxy?upstream=\(encoded)"
  }

  private func attributeValue(named name: String, in line: String) -> String? {
    let pattern = "(?i)\\b\(name)\\s*=\\s*\"([^\"]*)\""
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
          let range = Range(match.range(at: 1), in: line) else { return nil }
    return String(line[range])
  }
}

private enum LocalizerFailure: Error, Equatable { case expected }
