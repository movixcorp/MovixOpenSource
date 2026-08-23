import Foundation
import XCTest
@testable import Movix

final class MediaProxyHTTPParserTests: XCTestCase {
  func testParserAcceptsBoundedGetAndRange() throws {
    let request = try MediaProxyHTTPParser.parse(Data(
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=100-199\r\n\r\n".utf8
    ))
    XCTAssertEqual(request.method, "GET")
    XCTAssertEqual(request.path, "/p/a/b/c")
    XCTAssertEqual(request.headers["range"], "bytes=100-199")
  }

  func testParserRejectsPostAndOversizedHeaders() {
    XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(
      "POST /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8
    )))
    XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(repeating: 65, count: 65_537)))
  }

  func testParserAcceptsHeadAndZeroContentLengthWithoutBody() throws {
    let request = try MediaProxyHTTPParser.parse(Data(
      "HEAD /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nContent-Length: 0\r\n\r\n".utf8
    ))
    XCTAssertEqual(request.method, "HEAD")
    XCTAssertEqual(request.headers["content-length"], "0")
  }

  func testParserRejectsBodiesAbsoluteFormMalformedEscapesAndDuplicateRange() {
    let rejected = [
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nx",
      "GET https://example.com/p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      "GET /p/a/%2 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      "GET /p/a/%GG HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-1\r\nrange: bytes=2-3\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-1,4-5\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n",
    ]
    for raw in rejected {
      XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(raw.utf8)), raw)
    }
  }

  func testParserRejectsObsFoldAndHeaderInjection() {
    let rejected = [
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\n folded\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost : 127.0.0.1\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHo(st): 127.0.0.1\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\u{7f}\r\n\r\n",
      "GET /p/a/b/c HTTP/1.1\nHost: 127.0.0.1\n\n",
    ]
    for raw in rejected {
      XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(raw.utf8)), raw)
    }
  }

  func testParserRejectsOversizedRequestLineAndIncompleteRequest() {
    let target = "/" + String(repeating: "a", count: 8_192)
    XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(
      "GET \(target) HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8
    )))
    XCTAssertThrowsError(try MediaProxyHTTPParser.parse(Data(
      "GET /p/a/b/c HTTP/1.1\r\nHost: 127.0.0.1\r\n".utf8
    )))
  }
}
