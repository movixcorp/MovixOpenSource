import Foundation

struct MediaProxyLocalRequest: Equatable {
  let method: String
  let path: String
  let headers: [String: String]
}

enum MediaProxyHTTPParserError: Error, Equatable {
  case requestTooLarge
  case incompleteRequest
  case requestLineTooLong
  case malformedRequestLine
  case unsupportedMethod
  case absoluteFormForbidden
  case malformedPercentEscape
  case malformedHeader
  case duplicateHeader
  case duplicateRange
  case requestBodyForbidden
  case invalidRange
}

enum MediaProxyHTTPParser {
  static let maximumRequestBytes = 64 * 1_024
  static let maximumRequestLineBytes = 8 * 1_024
  private static let headerTerminator = Data([13, 10, 13, 10])

  static func parse(_ data: Data) throws -> MediaProxyLocalRequest {
    guard data.count <= maximumRequestBytes else {
      throw MediaProxyHTTPParserError.requestTooLarge
    }
    guard let terminatorRange = data.range(of: headerTerminator) else {
      throw MediaProxyHTTPParserError.incompleteRequest
    }
    guard terminatorRange.upperBound == data.endIndex else {
      throw MediaProxyHTTPParserError.requestBodyForbidden
    }
    guard data.allSatisfy({ byte in
      byte == 13 || byte == 10 || (byte >= 32 && byte <= 126)
    }), let text = String(data: data, encoding: .ascii) else {
      throw MediaProxyHTTPParserError.malformedHeader
    }

    let components = text.components(separatedBy: "\r\n")
    guard components.count >= 3,
          components.suffix(2).allSatisfy(\.isEmpty),
          components.dropLast(2).allSatisfy({ !$0.contains("\r") && !$0.contains("\n") }) else {
      throw MediaProxyHTTPParserError.malformedHeader
    }
    let lines = Array(components.dropLast(2))
    guard let requestLine = lines.first, !requestLine.isEmpty else {
      throw MediaProxyHTTPParserError.malformedRequestLine
    }
    guard requestLine.utf8.count <= maximumRequestLineBytes else {
      throw MediaProxyHTTPParserError.requestLineTooLong
    }

    let requestParts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
    guard requestParts.count == 3,
          !requestParts.contains(where: \.isEmpty),
          requestParts[2] == "HTTP/1.1" else {
      throw MediaProxyHTTPParserError.malformedRequestLine
    }
    let method = String(requestParts[0])
    guard method == "GET" || method == "HEAD" else {
      throw MediaProxyHTTPParserError.unsupportedMethod
    }
    let path = String(requestParts[1])
    guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("://") else {
      throw MediaProxyHTTPParserError.absoluteFormForbidden
    }
    guard !path.contains("#"), path.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else {
      throw MediaProxyHTTPParserError.malformedRequestLine
    }
    try validatePercentEscapes(in: path)

    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard !line.isEmpty,
            line.first != " ", line.first != "\t",
            let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
        throw MediaProxyHTTPParserError.malformedHeader
      }
      let rawName = String(line[..<colon])
      guard rawName.utf8.allSatisfy(isHeaderNameByte) else {
        throw MediaProxyHTTPParserError.malformedHeader
      }
      let name = rawName.lowercased()
      guard headers[name] == nil else {
        throw name == "range"
          ? MediaProxyHTTPParserError.duplicateRange
          : MediaProxyHTTPParserError.duplicateHeader
      }
      let rawValue = String(line[line.index(after: colon)...])
      let value = rawValue.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      guard !value.isEmpty,
            value.utf8.allSatisfy({ $0 >= 32 && $0 <= 126 }) else {
        throw MediaProxyHTTPParserError.malformedHeader
      }
      headers[name] = value
    }

    guard headers["host"] != nil else {
      throw MediaProxyHTTPParserError.malformedHeader
    }
    guard headers["transfer-encoding"] == nil, headers["expect"] == nil else {
      throw MediaProxyHTTPParserError.requestBodyForbidden
    }
    if let contentLength = headers["content-length"] {
      guard !contentLength.isEmpty,
            contentLength.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
            let value = UInt64(contentLength), value == 0 else {
        throw MediaProxyHTTPParserError.requestBodyForbidden
      }
    }
    if let range = headers["range"] {
      try validateSingleByteRange(range)
    }
    return MediaProxyLocalRequest(method: method, path: path, headers: headers)
  }

  private static func validatePercentEscapes(in value: String) throws {
    let bytes = Array(value.utf8)
    var index = 0
    while index < bytes.count {
      if bytes[index] == 37 {
        guard index + 2 < bytes.count,
              isHexDigit(bytes[index + 1]), isHexDigit(bytes[index + 2]) else {
          throw MediaProxyHTTPParserError.malformedPercentEscape
        }
        index += 3
      } else {
        index += 1
      }
    }
  }

  private static func validateSingleByteRange(_ value: String) throws {
    guard value.count >= 7,
          value.prefix(6).lowercased() == "bytes=",
          !value.contains(",") else {
      throw MediaProxyHTTPParserError.invalidRange
    }
    let range = value.dropFirst(6)
    let bounds = range.split(separator: "-", omittingEmptySubsequences: false)
    guard bounds.count == 2,
          !bounds.allSatisfy(\.isEmpty),
          bounds.allSatisfy({ bound in
            bound.isEmpty || bound.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 })
          }) else {
      throw MediaProxyHTTPParserError.invalidRange
    }
    let lower = bounds[0].isEmpty ? nil : UInt64(bounds[0])
    let upper = bounds[1].isEmpty ? nil : UInt64(bounds[1])
    guard (bounds[0].isEmpty || lower != nil),
          (bounds[1].isEmpty || upper != nil),
          lower == nil || upper == nil || lower! <= upper! else {
      throw MediaProxyHTTPParserError.invalidRange
    }
  }

  private static func isHeaderNameByte(_ byte: UInt8) -> Bool {
    (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || [33, 35, 36, 37, 38, 39, 42, 43, 45, 46, 94, 95, 96, 124, 126].contains(byte)
  }

  private static func isHexDigit(_ byte: UInt8) -> Bool {
    (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 70)
      || (byte >= 97 && byte <= 102)
  }
}
