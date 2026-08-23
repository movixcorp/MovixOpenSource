import Foundation

enum CastRelayError: String, Error, Equatable, Sendable {
  case invalidSource = "MOVIX_CAST_SOURCE_INVALID"
  case pickerDismissed = "MOVIX_CAST_PICKER_DISMISSED"
  case unsupportedContentType = "MOVIX_CAST_CONTENT_TYPE_UNSUPPORTED"
  case invalidTextTrack = "MOVIX_CAST_TEXT_TRACK_INVALID"
  case tooManyTracks = "MOVIX_CAST_TOO_MANY_TRACKS"
  case localSourceUnavailable = "MOVIX_CAST_LOCAL_SOURCE_UNAVAILABLE"
  case listenerUnavailable = "MOVIX_CAST_RELAY_UNAVAILABLE"
  case sessionUnavailable = "MOVIX_CAST_RELAY_SESSION_UNAVAILABLE"
  case capacityExceeded = "MOVIX_CAST_RELAY_CAPACITY_EXCEEDED"
  case invalidRequest = "MOVIX_CAST_RELAY_INVALID_REQUEST"
  case accessRevoked = "MOVIX_CAST_RELAY_ACCESS_REVOKED"
  case upstreamUnavailable = "MOVIX_CAST_RELAY_UPSTREAM_UNAVAILABLE"
  case responseTooLarge = "MOVIX_CAST_RELAY_RESPONSE_TOO_LARGE"
}

struct CastMediaProfile: Equatable, Sendable {
  static let canonicalHLSContentType = "application/x-mpegurl"

  let contentType: String
  let isHLS: Bool
  let hlsSegmentFormat: String?
  let hlsVideoSegmentFormat: String?

  private init(
    contentType: String,
    isHLS: Bool,
    hlsSegmentFormat: String?,
    hlsVideoSegmentFormat: String?
  ) {
    self.contentType = contentType
    self.isHLS = isHLS
    self.hlsSegmentFormat = hlsSegmentFormat
    self.hlsVideoSegmentFormat = hlsVideoSegmentFormat
  }

  static func hlsTS() -> CastMediaProfile {
    CastMediaProfile(
      contentType: canonicalHLSContentType,
      isHLS: true,
      hlsSegmentFormat: "ts",
      hlsVideoSegmentFormat: "mpeg2_ts"
    )
  }

  static func hlsFMP4() -> CastMediaProfile {
    CastMediaProfile(
      contentType: canonicalHLSContentType,
      isHLS: true,
      hlsSegmentFormat: "fmp4",
      hlsVideoSegmentFormat: "fmp4"
    )
  }

  static func progressive(_ rawContentType: String?) -> CastMediaProfile? {
    guard let normalized = normalizedContentType(rawContentType) else { return nil }
    switch normalized {
    case "video/mp4", "audio/mp4", "audio/mpeg", "video/webm", "audio/webm":
      return CastMediaProfile(
        contentType: normalized,
        isHLS: false,
        hlsSegmentFormat: nil,
        hlsVideoSegmentFormat: nil
      )
    default:
      return nil
    }
  }

  init(contentType rawContentType: String?, sourceURL: URL) throws {
    if let rawContentType {
      guard rawContentType.utf8.count <= CastSourceValidation.maximumHeaderValueBytes,
            !rawContentType.unicodeScalars.contains(where: {
              CharacterSet.controlCharacters.contains($0)
            }) else {
        throw CastRelayError.unsupportedContentType
      }
    }
    let raw = Self.normalizedContentType(rawContentType)
    let inferred = raw?.isEmpty == false ? raw : Self.inferredContentType(from: sourceURL)
    switch inferred {
    case "application/x-mpegurl", "application/vnd.apple.mpegurl",
         "audio/mpegurl", "audio/x-mpegurl":
      self = Self.hlsTS()
    default:
      guard let progressive = Self.progressive(inferred) else {
        throw CastRelayError.unsupportedContentType
      }
      self = progressive
    }
  }

  static func normalizedContentType(_ raw: String?) -> String? {
    raw.map { value in
      String(value.split(
        separator: ";",
        maxSplits: 1,
        omittingEmptySubsequences: false
      ).first ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    }
  }

  static func inferredContentType(from url: URL) -> String? {
    switch url.pathExtension.lowercased() {
    case "m3u8": return canonicalHLSContentType
    case "mp4", "m4v": return "video/mp4"
    case "m4a": return "audio/mp4"
    case "mp3": return "audio/mpeg"
    case "webm": return "video/webm"
    default: return nil
    }
  }
}

enum CastTextTrackFormat: String, Hashable, Sendable {
  case webVTT = "text/vtt"
  case subRip = "application/x-subrip"
}

struct CastSourceTrack: Sendable {
  let remoteTarget: MediaProxyTarget?
  let inlineVTT: String?
  let contentType: String
  let format: CastTextTrackFormat
  let language: String?
  let name: String?
  let active: Bool

  init(
    remoteTarget: MediaProxyTarget? = nil,
    inlineVTT: String? = nil,
    contentType: String? = nil,
    language: String? = nil,
    name: String? = nil,
    active: Bool = false
  ) throws {
    guard (remoteTarget == nil) != (inlineVTT == nil),
          Self.validContentTypeInput(contentType),
          Self.validMetadata(language, maximumCharacters: CastSourceValidation.maximumLanguageCharacters),
          Self.validMetadata(name, maximumCharacters: CastSourceValidation.maximumLabelCharacters) else {
      throw CastRelayError.invalidTextTrack
    }

    if let remoteTarget {
      let normalizedFormat: CastTextTrackFormat
      let normalizedTarget: MediaProxyTarget
      do {
        normalizedFormat = try Self.remoteFormat(
          contentType,
          sourceURL: remoteTarget.upstreamURL
        )
        normalizedTarget = try CastSourceValidation.normalizedRemoteTarget(
          remoteTarget,
          requiredMethod: "GET"
        )
      } catch {
        throw CastRelayError.invalidTextTrack
      }
      self.remoteTarget = normalizedTarget
      self.inlineVTT = nil
      self.contentType = normalizedFormat.rawValue
      self.format = normalizedFormat
    } else if let inlineVTT {
      guard contentType == nil || Self.baseContentType(contentType!) == "text/vtt",
            CastVTTValidator.validate(inlineVTT) else {
        throw CastRelayError.invalidTextTrack
      }
      self.remoteTarget = nil
      self.inlineVTT = inlineVTT
      self.contentType = "text/vtt"
      self.format = .webVTT
    } else {
      throw CastRelayError.invalidTextTrack
    }
    self.language = language
    self.name = name
    self.active = active
  }

  private static func remoteFormat(
    _ raw: String?,
    sourceURL: URL
  ) throws -> CastTextTrackFormat {
    let value = raw.map(baseContentType)
    let inferred: String?
    switch sourceURL.pathExtension.lowercased() {
    case "vtt": inferred = "text/vtt"
    case "srt": inferred = "application/x-subrip"
    default: inferred = nil
    }
    switch value?.isEmpty == false ? value : inferred {
    case "text/vtt": return .webVTT
    case "application/x-subrip", "application/srt", "text/srt":
      return .subRip
    default:
      throw CastRelayError.invalidTextTrack
    }
  }

  private static func baseContentType(_ raw: String) -> String {
    String(raw.split(
      separator: ";",
      maxSplits: 1,
      omittingEmptySubsequences: false
    ).first ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
  }

  private static func validMetadata(_ value: String?, maximumCharacters: Int) -> Bool {
    guard let value else { return true }
    return value.count <= maximumCharacters
      && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
  }

  private static func validContentTypeInput(_ value: String?) -> Bool {
    guard let value else { return true }
    return value.utf8.count <= CastSourceValidation.maximumHeaderValueBytes
      && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
  }
}

struct PreparedCastSource: Sendable {
  let url: URL
  let headers: [String: String]
  let contentType: String?
  let protocolVersion: Int
  let tracks: [CastSourceTrack]

  init(
    url: URL,
    headers: [String: String],
    contentType: String? = nil,
    protocolVersion: Int = 1,
    tracks: [CastSourceTrack] = []
  ) throws {
    guard protocolVersion == 1 else { throw CastRelayError.invalidSource }
    guard tracks.count <= CastSourceValidation.maximumTrackCount else {
      throw CastRelayError.tooManyTracks
    }
    let isLoopback = CastSourceValidation.isCanonicalLoopbackMediaURL(url)
    if isLoopback {
      guard headers.isEmpty else { throw CastRelayError.invalidSource }
    } else {
      _ = try CastSourceValidation.validatedRemoteURL(url)
    }
    let normalizedContentType: String?
    if contentType != nil {
      normalizedContentType = try CastMediaProfile(
        contentType: contentType,
        sourceURL: url
      ).contentType
    } else if !isLoopback {
      normalizedContentType = CastMediaProfile.inferredContentType(from: url)
      if let normalizedContentType {
        _ = try CastMediaProfile(
          contentType: normalizedContentType,
          sourceURL: url
        )
      }
    } else {
      normalizedContentType = nil
    }
    self.url = url
    self.headers = isLoopback ? [:] : try CastSourceValidation.sanitizedHeaders(headers)
    self.contentType = normalizedContentType
    self.protocolVersion = protocolVersion
    self.tracks = tracks
  }
}

struct PreparedCastTextTrack: Equatable, Sendable {
  let contentURL: URL
  let contentType: String
  let language: String?
  let name: String?
  let active: Bool
}

struct PreparedCastRelay: Sendable {
  let contentURL: URL
  let profile: CastMediaProfile
  let textTracks: [PreparedCastTextTrack]
  let stop: @Sendable () async -> Void

  var contentType: String { profile.contentType }
}

enum CastSourceValidation {
  static let maximumTrackCount = 16
  static let maximumInlineVTTBytes = 2 * 1_024 * 1_024
  static let maximumLanguageCharacters = 35
  static let maximumLabelCharacters = 128
  static let maximumHeaders = 32
  static let maximumHeaderNameBytes = 128
  static let maximumHeaderValueBytes = 8_192

  static func validatedRemoteURL(_ url: URL) throws -> URL {
    do {
      return try MediaProxyPolicy.validatePublicHTTPSURLSyntax(url.absoluteString)
    } catch {
      throw CastRelayError.invalidSource
    }
  }

  static func normalizedRemoteTarget(
    _ target: MediaProxyTarget,
    requiredMethod: String
  ) throws -> MediaProxyTarget {
    let method = target.method.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard method == requiredMethod else { throw CastRelayError.invalidSource }
    return MediaProxyTarget(
      upstreamURL: try validatedRemoteURL(target.upstreamURL),
      method: method,
      headers: try sanitizedHeaders(target.headers)
    )
  }

  static func sanitizedHeaders(_ headers: [String: String]) throws -> [String: String] {
    guard headers.count <= maximumHeaders,
          headers.allSatisfy({ name, value in
            !name.isEmpty
              && name.utf8.count <= maximumHeaderNameBytes
              && value.utf8.count <= maximumHeaderValueBytes
              && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
              && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
          }) else {
      throw CastRelayError.invalidSource
    }
    return MediaProxyPolicy.sanitizeRequestHeaders(headers)
  }

  static func isCanonicalLoopbackMediaURL(_ url: URL) -> Bool {
    let raw = url.absoluteString
    guard raw.hasPrefix("http://127.0.0.1:"),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme == "http",
          components.host == "127.0.0.1",
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          let port = components.port,
          (1...65_535).contains(port),
          !components.percentEncodedPath.contains("%") else {
      return false
    }
    let path = components.percentEncodedPath
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 5,
          segments[0].isEmpty,
          segments[1] == "p",
          segments.dropFirst(2).allSatisfy({ hasExactTokenSyntax(String($0)) }),
          raw == "http://127.0.0.1:\(port)\(path)" else {
      return false
    }
    return true
  }

  static func hasExactTokenSyntax(_ token: String) -> Bool {
    token.utf8.count == 43 && token.utf8.allSatisfy { byte in
      (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 45 || byte == 95
    }
  }
}

enum CastVTTValidator {
  static func validate(_ source: String) -> Bool {
    let bytes = Data(source.utf8)
    guard !bytes.isEmpty,
          bytes.count <= CastSourceValidation.maximumInlineVTTBytes,
          !source.unicodeScalars.contains(where: { $0.value == 0 }) else {
      return false
    }
    var normalized = source
    if normalized.unicodeScalars.first?.value == 0xFEFF { normalized.removeFirst() }
    normalized = normalized.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    let lines = normalized.components(separatedBy: "\n")
    guard let header = lines.first,
          header == "WEBVTT" || header.hasPrefix("WEBVTT ") || header.hasPrefix("WEBVTT\t") else {
      return false
    }
    for index in lines.indices.dropFirst() where validateCue(lines[index]) {
      let textIndex = lines.index(after: index)
      if textIndex < lines.endIndex,
         !lines[textIndex].trimmingCharacters(in: .whitespaces).isEmpty,
         !lines[textIndex].contains("-->") {
        return true
      }
    }
    return false
  }

  static func validateCue(_ rawLine: String) -> Bool {
    let parts = rawLine.components(separatedBy: "-->")
    guard parts.count == 2,
          let start = timestampMilliseconds(parts[0].trimmingCharacters(in: .whitespaces)),
          let endToken = parts[1]
            .trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .first,
          let end = timestampMilliseconds(String(endToken)),
          start <= end else {
      return false
    }
    return true
  }

  private static func timestampMilliseconds(_ raw: String) -> Int64? {
    let timeParts = raw.split(separator: ":", omittingEmptySubsequences: false)
    guard timeParts.count == 2 || timeParts.count == 3 else { return nil }
    let secondsParts = timeParts.last!.split(separator: ".", omittingEmptySubsequences: false)
    guard secondsParts.count == 2,
          secondsParts[0].count == 2,
          secondsParts[1].count == 3,
          secondsParts.allSatisfy({ $0.allSatisfy(\.isNumber) }),
          let seconds = Int64(secondsParts[0]), seconds < 60,
          let milliseconds = Int64(secondsParts[1]) else { return nil }

    let hours: Int64
    let minutes: Int64
    if timeParts.count == 3 {
      guard timeParts[0].count >= 2,
            timeParts[1].count == 2,
            timeParts[0].allSatisfy(\.isNumber),
            timeParts[1].allSatisfy(\.isNumber),
            let parsedHours = Int64(timeParts[0]),
            let parsedMinutes = Int64(timeParts[1]), parsedMinutes < 60 else { return nil }
      hours = parsedHours
      minutes = parsedMinutes
    } else {
      guard timeParts[0].count >= 2,
            timeParts[0].allSatisfy(\.isNumber),
            let parsedMinutes = Int64(timeParts[0]) else { return nil }
      hours = 0
      minutes = parsedMinutes
    }
    guard hours <= (Int64.max / 3_600_000) - 1,
          minutes <= (Int64.max / 60_000) - 1 else { return nil }
    return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds
  }
}
