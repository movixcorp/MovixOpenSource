import Foundation

enum HLSSubtitleResourceFormat: Equatable {
  case webVTT
  case subRip
  case unsupported
}

enum HLSPlaylistRewriter {
  private static let allowedAttributeDirectives: Set<String> = [
    "#EXT-X-KEY", "#EXT-X-MAP", "#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF",
    "#EXT-X-SESSION-DATA", "#EXT-X-SESSION-KEY", "#EXT-X-PART", "#EXT-X-PRELOAD-HINT",
    "#EXT-X-RENDITION-REPORT", "#EXT-X-IMAGE-STREAM-INF",
  ]
  private static let maximumLocalizedURLLength = 16_384

  static func rewrite(
    _ playlist: String,
    baseURL: URL,
    wrapDirectSubtitles: Bool,
    localize: (URL) throws -> String
  ) throws -> String {
    try splitLinesPreservingEndings(playlist).map { line, ending in
      try rewriteLine(line, baseURL: baseURL, wrapDirectSubtitles: wrapDirectSubtitles, localize: localize) + ending
    }.joined()
  }

  /// Task 4 must convert localized `.srt` resources with `convertSubRipToWebVTT` and serve
  /// them as `text/vtt; charset=utf-8`; both direct WebVTT and SubRip resources are wrapped here.
  static func subtitleResourceFormat(for url: URL) -> HLSSubtitleResourceFormat {
    switch url.path.lowercased() {
    case let path where path.hasSuffix(".vtt"): return .webVTT
    case let path where path.hasSuffix(".srt"): return .subRip
    default: return .unsupported
    }
  }

  static func convertSubRipToWebVTT(_ source: String) -> String? {
    var normalized = source
    if normalized.unicodeScalars.first?.value == 0xFEFF { normalized.removeFirst() }
    normalized = normalized.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")

    var blocks: [[String]] = []
    var block: [String] = []
    for line in normalized.components(separatedBy: "\n") {
      if line.trimmingCharacters(in: .whitespaces).isEmpty {
        if !block.isEmpty {
          blocks.append(block)
          block = []
        }
      } else {
        block.append(line)
      }
    }
    if !block.isEmpty { blocks.append(block) }

    guard !blocks.isEmpty else { return nil }
    var cues: [String] = []
    for lines in blocks {
      var cursor = 0
      if lines.first?.allSatisfy({ $0.isNumber }) == true { cursor = 1 }
      guard cursor < lines.count, let timestamp = normalizedSubRipTimestamp(lines[cursor]) else { return nil }
      let text = lines.dropFirst(cursor + 1)
      guard !text.isEmpty, text.contains(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return nil }
      cues.append(([timestamp] + text).joined(separator: "\n"))
    }
    return "WEBVTT\n\n" + cues.joined(separator: "\n\n")
  }

  private static func rewriteLine(
    _ line: String,
    baseURL: URL,
    wrapDirectSubtitles: Bool,
    localize: (URL) throws -> String
  ) throws -> String {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return line }

    if !trimmed.hasPrefix("#") {
      guard let url = resolvedURL(from: trimmed, baseURL: baseURL) else { return line }
      let leading = line.prefix { $0.isWhitespace }
      let trailing = line.reversed().prefix { $0.isWhitespace }.reversed()
      return String(leading) + (try localizedURL(for: url, localize: localize, delimiter: nil)) + String(trailing)
    }

    guard let directive = directiveName(in: trimmed), allowedAttributeDirectives.contains(directive) else { return line }
    let attributes = parseAttributes(in: line)
    let isSubtitleMedia = wrapDirectSubtitles && directive == "#EXT-X-MEDIA" && attributes.contains {
      $0.name.caseInsensitiveCompare("TYPE") == .orderedSame
        && $0.value.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare("SUBTITLES") == .orderedSame
    }

    var replacements: [(Range<String.Index>, String)] = []
    for attribute in attributes where attribute.name.caseInsensitiveCompare("URI") == .orderedSame {
      guard let url = resolvedURL(from: attribute.value, baseURL: baseURL) else { continue }
      let replacement: String
      if isSubtitleMedia, subtitleResourceFormat(for: url) != .unsupported {
        replacement = try directSubtitleWrapper(for: url, localize: localize)
      } else {
        replacement = try localizedURL(for: url, localize: localize, delimiter: attribute.delimiter)
      }
      replacements.append((attribute.valueRange, replacement))
    }
    return applying(replacements, to: line)
  }

  private static func directiveName(in trimmedLine: String) -> String? {
    guard let colon = trimmedLine.firstIndex(of: ":") else { return nil }
    return String(trimmedLine[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  }

  private static func applying(_ replacements: [(Range<String.Index>, String)], to line: String) -> String {
    var output = ""
    var cursor = line.endIndex
    for (range, replacement) in replacements.sorted(by: { $0.0.lowerBound > $1.0.lowerBound }) {
      output = replacement + String(line[range.upperBound..<cursor]) + output
      cursor = range.lowerBound
    }
    return String(line[..<cursor]) + output
  }

  private static func localizedURL(
    for url: URL,
    localize: (URL) throws -> String,
    delimiter: Character?
  ) throws -> String {
    let value = try localize(url)
    let parsed = URL(string: value)
    guard !value.isEmpty,
          value.utf8.count <= maximumLocalizedURLLength,
          !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          delimiter.map({ !value.contains($0) }) ?? true,
          isSafeLocalizedReference(value, parsed: parsed) else {
      throw HLSPlaylistRewriterError.invalidLocalizedURL
    }
    return value
  }

  private static func resolvedURL(from rawValue: String, baseURL: URL) -> URL? {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.lowercased().hasPrefix("data:"), !value.lowercased().hasPrefix("blob:") else { return nil }
    return URL(string: value, relativeTo: baseURL)?.absoluteURL
  }

  private static func directSubtitleWrapper(for url: URL, localize: (URL) throws -> String) throws -> String {
    let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:999999\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:999999.0,\n\(try localizedURL(for: url, localize: localize, delimiter: nil))\n#EXT-X-ENDLIST"
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    guard let encoded = playlist.addingPercentEncoding(withAllowedCharacters: unreserved) else {
      throw HLSPlaylistRewriterError.percentEncodingFailed
    }
    return "data:application/vnd.apple.mpegurl,\(encoded)"
  }

  private static func normalizedSubRipTimestamp(_ value: String) -> String? {
    let parts = value.components(separatedBy: "-->")
    guard parts.count == 2 else { return nil }
    guard let start = parseSubRipTime(parts[0].trimmingCharacters(in: .whitespaces)),
          let end = parseSubRipTime(parts[1].trimmingCharacters(in: .whitespaces)),
          start.milliseconds <= end.milliseconds else { return nil }
    return "\(start.normalized) --> \(end.normalized)"
  }

  private static func parseSubRipTime(_ value: String) -> (milliseconds: Int, normalized: String)? {
    let parts = value.split(separator: ":")
    guard parts.count == 3,
          parts[0].count >= 2, parts[1].count == 2,
          parts[0].allSatisfy(\.isNumber), parts[1].allSatisfy(\.isNumber),
          let separator = parts[2].firstIndex(where: { $0 == "," || $0 == "." }) else { return nil }
    let seconds = parts[2][..<separator]
    let milliseconds = parts[2][parts[2].index(after: separator)...]
    guard seconds.count == 2, milliseconds.count == 3,
          seconds.allSatisfy(\.isNumber), milliseconds.allSatisfy(\.isNumber),
          parts[2].filter({ $0 == "," || $0 == "." }).count == 1,
          let hours = Int(parts[0]), let minutes = Int(parts[1]),
          let secondsValue = Int(seconds), let millisecondsValue = Int(milliseconds),
          minutes < 60, secondsValue < 60,
          hours <= (Int.max - 3_599_999) / 3_600_000 else { return nil }
    return (
      hours * 3_600_000 + minutes * 60_000 + secondsValue * 1_000 + millisecondsValue,
      "\(parts[0]):\(parts[1]):\(seconds).\(milliseconds)"
    )
  }

  private static func isSafeLocalizedReference(_ value: String, parsed: URL?) -> Bool {
    guard let parsed, !value.hasPrefix("//"), !value.contains("\\") else { return false }
    if let scheme = parsed.scheme?.lowercased() {
      return (scheme == "http" || scheme == "https")
        && parsed.host != nil
        && parsed.user == nil
        && parsed.password == nil
    }
    return isSafeRelativeLocalReference(value, parsed: parsed)
  }

  private static func isSafeRelativeLocalReference(_ value: String, parsed: URL) -> Bool {
    !value.isEmpty && parsed.host == nil && parsed.scheme == nil
  }

  private static func splitLinesPreservingEndings(_ playlist: String) -> [(String, String)] {
    var lines: [(String, String)] = []
    var start = playlist.startIndex
    var index = start
    while index < playlist.endIndex {
      let character = playlist[index]
      if character == "\r\n" {
        lines.append((String(playlist[start..<index]), "\r\n"))
        index = playlist.index(after: index)
        start = index
      } else if character == "\r" || character == "\n" {
        let next = playlist.index(after: index)
        if character == "\r", next < playlist.endIndex, playlist[next] == "\n" {
          lines.append((String(playlist[start..<index]), "\r\n"))
          index = playlist.index(after: next)
        } else {
          lines.append((String(playlist[start..<index]), String(character)))
          index = next
        }
        start = index
      } else {
        index = playlist.index(after: index)
      }
    }
    if start < playlist.endIndex { lines.append((String(playlist[start...]), "")) }
    return lines
  }

  private static func parseAttributes(in line: String) -> [HLSAttribute] {
    guard let colon = line.firstIndex(of: ":") else { return [] }
    var attributes: [HLSAttribute] = []
    var segmentStart = line.index(after: colon)
    var index = segmentStart
    var quote: Character?

    func parseSegment(_ start: String.Index, _ end: String.Index) {
      let segment = line[start..<end]
      guard let equals = segment.firstIndex(of: "=") else { return }
      let name = String(segment[..<equals]).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !name.isEmpty else { return }
      var valueStart = line.index(after: equals)
      while valueStart < end, line[valueStart].isWhitespace { valueStart = line.index(after: valueStart) }
      guard valueStart < end else { return }
      if line[valueStart] == "\"" || line[valueStart] == "'" {
        let delimiter = line[valueStart]
        let contentStart = line.index(after: valueStart)
        guard let closing = line[contentStart..<end].firstIndex(of: delimiter) else { return }
        attributes.append(HLSAttribute(name: name, value: String(line[contentStart..<closing]), valueRange: contentStart..<closing, delimiter: delimiter))
      } else {
        var valueEnd = end
        while valueEnd > valueStart, line[line.index(before: valueEnd)].isWhitespace { valueEnd = line.index(before: valueEnd) }
        attributes.append(HLSAttribute(name: name, value: String(line[valueStart..<valueEnd]), valueRange: valueStart..<valueEnd, delimiter: nil))
      }
    }

    while index < line.endIndex {
      let character = line[index]
      if let activeQuote = quote {
        if character == activeQuote { quote = nil }
      } else if character == "\"" || character == "'" {
        quote = character
      } else if character == "," {
        parseSegment(segmentStart, index)
        segmentStart = line.index(after: index)
      }
      index = line.index(after: index)
    }
    parseSegment(segmentStart, line.endIndex)
    return attributes
  }
}

private struct HLSAttribute {
  let name: String
  let value: String
  let valueRange: Range<String.Index>
  let delimiter: Character?
}

enum HLSPlaylistRewriterError: Error, Equatable {
  case invalidLocalizedURL
  case percentEncodingFailed
}
