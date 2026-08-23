import Foundation

protocol MediaProxyCastResolving: Sendable {
  func resolveForCast(_ localURL: URL) async -> MediaProxyTarget?
}

struct MediaProxyServerCastResolver: MediaProxyCastResolving {
  func resolveForCast(_ localURL: URL) async -> MediaProxyTarget? {
    await MediaProxyServer.shared.resolveForCast(localURL)
  }
}

protocol CastMediaInspecting: Sendable {
  func inspect(
    target: MediaProxyTarget,
    hintedContentType: String?
  ) async throws -> CastMediaProfile
}

final class CastMediaInspector: CastMediaInspecting, @unchecked Sendable {
  private static let maximumManifestBytes = 512 * 1_024
  private static let maximumSegmentProbeBytes = 64 * 1_024
  private static let maximumPlaylistDepth = 2

  private let upstream: CastRelayUpstreamOpening

  init(upstream: CastRelayUpstreamOpening = MediaProxyUpstream()) {
    self.upstream = upstream
  }

  func inspect(
    target: MediaProxyTarget,
    hintedContentType: String?
  ) async throws -> CastMediaProfile {
    let normalized: MediaProxyTarget
    do {
      normalized = try CastSourceValidation.normalizedRemoteTarget(
        target,
        requiredMethod: "GET"
      )
    } catch {
      throw CastRelayError.invalidSource
    }
    return try await inspectValidated(
      target: normalized,
      hintedContentType: hintedContentType
    )
  }

  private func inspectValidated(
    target: MediaProxyTarget,
    hintedContentType: String?
  ) async throws -> CastMediaProfile {
    try Task.checkCancellation()
    let hintedHLS = Self.isHLSType(hintedContentType)
      || target.upstreamURL.path.lowercased().hasSuffix(".m3u8")
    if hintedHLS {
      return try await inspectBoundedGET(
        target: target,
        hintedContentType: hintedContentType,
        rangeProbe: false
      )
    }

    let headTarget = MediaProxyTarget(
      upstreamURL: target.upstreamURL,
      method: "HEAD",
      headers: Self.probeHeaders(target.headers)
    )
    let head = try await open(target: headTarget, localHeaders: [:])
    defer { head.body.cancel() }
    if head.statusCode == 405 || head.statusCode == 501 {
      head.body.cancel()
      return try await inspectBoundedGET(
        target: target,
        hintedContentType: hintedContentType,
        rangeProbe: true
      )
    }
    guard (200...299).contains(head.statusCode) else {
      throw CastRelayError.upstreamUnavailable
    }
    let responseType = try Self.contentType(in: head.headers)
    if let profile = CastMediaProfile.progressive(responseType ?? hintedContentType),
       responseType == nil || Self.isSupportedProgressiveType(responseType) {
      return profile
    }
    head.body.cancel()
    return try await inspectBoundedGET(
      target: target,
      hintedContentType: hintedContentType,
      rangeProbe: !Self.isHLSType(responseType)
    )
  }

  private func inspectBoundedGET(
    target: MediaProxyTarget,
    hintedContentType: String?,
    rangeProbe: Bool
  ) async throws -> CastMediaProfile {
    let getTarget = MediaProxyTarget(
      upstreamURL: target.upstreamURL,
      method: "GET",
      headers: Self.probeHeaders(target.headers)
    )
    let localHeaders = rangeProbe
      ? ["Range": "bytes=0-\(Self.maximumManifestBytes - 1)"]
      : [:]
    let response = try await open(
      target: getTarget,
      localHeaders: localHeaders
    )
    defer { response.body.cancel() }
    guard (200...299).contains(response.statusCode) else {
      throw CastRelayError.upstreamUnavailable
    }
    let bytes = try await readBounded(
      response.body,
      maximumBytes: Self.maximumManifestBytes
    )
    let responseType = try Self.contentType(in: response.headers)
    if Self.looksLikeHLS(responseType, bytes: bytes) {
      if rangeProbe, response.statusCode == 206 {
        response.body.cancel()
        return try await inspectBoundedGET(
          target: target,
          hintedContentType: hintedContentType,
          rangeProbe: false
        )
      }
      guard response.statusCode == 200 else {
        throw CastRelayError.upstreamUnavailable
      }
      return try await inspectHLSPlaylist(
        bytes,
        baseURL: response.finalURL,
        inheritedHeaders: getTarget.headers,
        depth: 0
      )
    }
    if let profile = CastMediaProfile.progressive(responseType),
       Self.isSupportedProgressiveType(responseType) {
      return profile
    }
    if responseType == nil,
       let hinted = CastMediaProfile.progressive(hintedContentType) {
      return hinted
    }
    if let detected = Self.detectProgressiveBytes(bytes) {
      return detected
    }
    throw CastRelayError.unsupportedContentType
  }

  private func inspectHLSPlaylist(
    _ bytes: Data,
    baseURL: URL,
    inheritedHeaders: [String: String],
    depth: Int
  ) async throws -> CastMediaProfile {
    guard depth <= Self.maximumPlaylistDepth,
          let source = String(data: bytes, encoding: .utf8),
          Self.hasHLSHeader(source) else {
      throw CastRelayError.unsupportedContentType
    }
    if let representative = try Self.findRepresentativePlaylist(
      in: source,
      baseURL: baseURL
    ) {
      guard depth < Self.maximumPlaylistDepth else {
        throw CastRelayError.unsupportedContentType
      }
      let response = try await open(
        target: MediaProxyTarget(
          upstreamURL: representative,
          method: "GET",
          headers: Self.probeHeaders(inheritedHeaders)
        ),
        localHeaders: [:]
      )
      defer { response.body.cancel() }
      guard response.statusCode == 200 else {
        throw CastRelayError.upstreamUnavailable
      }
      let representativeBytes = try await readBounded(
        response.body,
        maximumBytes: Self.maximumManifestBytes
      )
      guard Self.looksLikeHLS(
        try Self.contentType(in: response.headers),
        bytes: representativeBytes
      ) else {
        throw CastRelayError.unsupportedContentType
      }
      return try await inspectHLSPlaylist(
        representativeBytes,
        baseURL: response.finalURL,
        inheritedHeaders: inheritedHeaders,
        depth: depth + 1
      )
    }

    let lowercased = source.lowercased()
    if lowercased.contains("#ext-x-map:") {
      return .hlsFMP4()
    }
    guard let segment = try Self.findFirstMediaSegment(in: source, baseURL: baseURL) else {
      throw CastRelayError.unsupportedContentType
    }
    let segmentPath = segment.path.lowercased()
    if segmentPath.hasSuffix(".m4s") || segmentPath.hasSuffix(".mp4") {
      return .hlsFMP4()
    }
    if segmentPath.hasSuffix(".ts") {
      return .hlsTS()
    }
    return try await inspectRepresentativeSegment(
      segment,
      inheritedHeaders: inheritedHeaders
    )
  }

  private func inspectRepresentativeSegment(
    _ url: URL,
    inheritedHeaders: [String: String]
  ) async throws -> CastMediaProfile {
    let response = try await open(
      target: MediaProxyTarget(
        upstreamURL: url,
        method: "GET",
        headers: Self.probeHeaders(inheritedHeaders)
      ),
      localHeaders: [
        "Range": "bytes=0-\(Self.maximumSegmentProbeBytes - 1)",
      ]
    )
    defer { response.body.cancel() }
    guard (200...299).contains(response.statusCode) else {
      throw CastRelayError.upstreamUnavailable
    }
    let prefix = try await readPrefix(
      response.body,
      maximumBytes: Self.maximumSegmentProbeBytes
    )
    let contentType = try Self.contentType(in: response.headers)
    if Self.isTransportStream(prefix)
      || contentType == "video/mp2t" || contentType == "video/mpeg" {
      return .hlsTS()
    }
    if Self.isISOBaseMedia(prefix)
      || contentType == "video/mp4" || contentType == "audio/mp4"
      || contentType == "application/mp4" {
      return .hlsFMP4()
    }
    throw CastRelayError.unsupportedContentType
  }

  private func readBounded(
    _ body: MediaProxyUpstreamBody,
    maximumBytes: Int
  ) async throws -> Data {
    try await withTaskCancellationHandler {
      try await readBoundedOperation(body, maximumBytes: maximumBytes)
    } onCancel: {
      body.cancel()
    }
  }

  private func readBoundedOperation(
    _ body: MediaProxyUpstreamBody,
    maximumBytes: Int
  ) async throws -> Data {
    do {
      var output = Data()
      while let chunk = try await body.nextChunk() {
        try Task.checkCancellation()
        guard chunk.count <= maximumBytes - output.count else {
          throw CastRelayError.responseTooLarge
        }
        output.append(chunk)
      }
      return output
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as CastRelayError {
      throw error
    } catch {
      if Task.isCancelled { throw CancellationError() }
      throw CastRelayError.upstreamUnavailable
    }
  }

  private func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    do {
      return try await upstream.open(target: target, localHeaders: localHeaders)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as CastRelayError {
      throw error
    } catch {
      if Task.isCancelled { throw CancellationError() }
      throw CastRelayError.upstreamUnavailable
    }
  }

  private func readPrefix(
    _ body: MediaProxyUpstreamBody,
    maximumBytes: Int
  ) async throws -> Data {
    try await withTaskCancellationHandler {
      try await readPrefixOperation(body, maximumBytes: maximumBytes)
    } onCancel: {
      body.cancel()
    }
  }

  private func readPrefixOperation(
    _ body: MediaProxyUpstreamBody,
    maximumBytes: Int
  ) async throws -> Data {
    do {
      var output = Data()
      while output.count < maximumBytes,
            let chunk = try await body.nextChunk() {
        try Task.checkCancellation()
        let remaining = maximumBytes - output.count
        output.append(chunk.prefix(remaining))
        if chunk.count >= remaining { break }
      }
      return output
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as CastRelayError {
      throw error
    } catch {
      if Task.isCancelled { throw CancellationError() }
      throw CastRelayError.upstreamUnavailable
    }
  }

  private static func contentType(in headers: [String: String]) throws -> String? {
    guard let raw = headers.first(where: {
      $0.key.caseInsensitiveCompare("Content-Type") == .orderedSame
    })?.value else { return nil }
    guard raw.utf8.count <= CastSourceValidation.maximumHeaderValueBytes,
          !raw.unicodeScalars.contains(where: {
            CharacterSet.controlCharacters.contains($0)
          }) else {
      throw CastRelayError.unsupportedContentType
    }
    let normalized = CastMediaProfile.normalizedContentType(raw)
    return normalized?.isEmpty == false ? normalized : nil
  }

  private static func probeHeaders(_ headers: [String: String]) -> [String: String] {
    let removed: Set<String> = [
      "range", "if-range", "if-match", "if-none-match",
      "if-modified-since", "if-unmodified-since",
    ]
    return headers.filter { !removed.contains($0.key.lowercased()) }
  }

  private static func isSupportedProgressiveType(_ raw: String?) -> Bool {
    CastMediaProfile.progressive(raw) != nil
  }

  private static func isHLSType(_ raw: String?) -> Bool {
    guard let normalized = CastMediaProfile.normalizedContentType(raw) else { return false }
    return normalized == "application/x-mpegurl"
      || normalized == "application/vnd.apple.mpegurl"
      || normalized == "audio/mpegurl"
      || normalized == "audio/x-mpegurl"
  }

  private static func looksLikeHLS(_ contentType: String?, bytes: Data) -> Bool {
    isHLSType(contentType)
      || String(data: bytes, encoding: .utf8).map(hasHLSHeader) == true
  }

  private static func hasHLSHeader(_ source: String) -> Bool {
    var normalized = source
    if normalized.unicodeScalars.first?.value == 0xFEFF { normalized.removeFirst() }
    normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized == "#EXTM3U" || normalized.hasPrefix("#EXTM3U\n")
      || normalized.hasPrefix("#EXTM3U\r")
  }

  private static func detectProgressiveBytes(_ bytes: Data) -> CastMediaProfile? {
    if isISOBaseMedia(bytes) { return CastMediaProfile.progressive("video/mp4") }
    let prefix = [UInt8](bytes.prefix(4))
    if prefix == [0x1A, 0x45, 0xDF, 0xA3] {
      return CastMediaProfile.progressive("video/webm")
    }
    if bytes.starts(with: Data("ID3".utf8))
      || (prefix.count >= 2 && prefix[0] == 0xFF && (prefix[1] & 0xE0) == 0xE0) {
      return CastMediaProfile.progressive("audio/mpeg")
    }
    return nil
  }

  private static func isISOBaseMedia(_ bytes: Data) -> Bool {
    guard bytes.count >= 8 else { return false }
    let type = String(decoding: bytes[4..<8], as: UTF8.self)
    return type == "ftyp" || type == "styp" || type == "moof"
  }

  private static func isTransportStream(_ bytes: Data) -> Bool {
    guard bytes.count >= 3 * 188 else { return false }
    return bytes[bytes.startIndex] == 0x47
      && bytes[bytes.startIndex + 188] == 0x47
      && bytes[bytes.startIndex + 376] == 0x47
  }

  private static func findRepresentativePlaylist(
    in source: String,
    baseURL: URL
  ) throws -> URL? {
    let lines = source.components(separatedBy: .newlines)
    for index in lines.indices where lines[index]
      .trimmingCharacters(in: .whitespaces)
      .lowercased()
      .hasPrefix("#ext-x-stream-inf:") {
      for candidate in lines.dropFirst(index + 1) {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        guard !trimmed.hasPrefix("#") else { continue }
        return try validatedReference(trimmed, baseURL: baseURL)
      }
    }
    return nil
  }

  private static func findFirstMediaSegment(
    in source: String,
    baseURL: URL
  ) throws -> URL? {
    var expectsSegment = false
    for rawLine in source.components(separatedBy: .newlines) {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.lowercased().hasPrefix("#extinf:") {
        expectsSegment = true
        continue
      }
      if expectsSegment, !line.isEmpty, !line.hasPrefix("#") {
        return try validatedReference(line, baseURL: baseURL)
      }
    }
    return nil
  }

  private static func validatedReference(_ raw: String, baseURL: URL) throws -> URL {
    guard raw.utf8.count <= MediaProxyPolicy.maximumURLLength,
          !raw.unicodeScalars.contains(where: {
            CharacterSet.controlCharacters.contains($0)
          }),
          let resolved = URL(string: raw, relativeTo: baseURL)?.absoluteURL else {
      throw CastRelayError.unsupportedContentType
    }
    do {
      return try MediaProxyPolicy.validatePublicHTTPSURLSyntax(resolved.absoluteString)
    } catch {
      throw CastRelayError.unsupportedContentType
    }
  }
}

protocol CastRelayPreparing: Sendable {
  func prepare(
    selection: CastNetworkSelection,
    rootTarget: MediaProxyTarget,
    profile: CastMediaProfile,
    tracks: [CastSourceTrack]
  ) async throws -> PreparedCastRelay
}

final class CastRelayServerFactory: CastRelayPreparing, @unchecked Sendable {
  private let upstream: CastRelayUpstreamOpening
  private let listenerFactory: CastRelayListenerFactory
  private let makePathMonitor: @Sendable () -> CastRelayPathMonitoring
  private let notificationCenter: NotificationCenter
  private let timing: CastRelayServerTiming
  private let maximumResources: Int
  private let tokenGenerator: (@Sendable () -> String)?

  init(
    upstream: CastRelayUpstreamOpening = MediaProxyUpstream(),
    listenerFactory: CastRelayListenerFactory = CastRelayNWListenerFactory(),
    makePathMonitor: @escaping @Sendable () -> CastRelayPathMonitoring = {
      CastNetworkPathMonitor()
    },
    notificationCenter: NotificationCenter = .default,
    timing: CastRelayServerTiming = .production,
    maximumResources: Int = 2_048,
    tokenGenerator: (@Sendable () -> String)? = nil
  ) {
    self.upstream = upstream
    self.listenerFactory = listenerFactory
    self.makePathMonitor = makePathMonitor
    self.notificationCenter = notificationCenter
    self.timing = timing
    self.maximumResources = maximumResources
    self.tokenGenerator = tokenGenerator
  }

  func prepare(
    selection: CastNetworkSelection,
    rootTarget: MediaProxyTarget,
    profile: CastMediaProfile,
    tracks: [CastSourceTrack]
  ) async throws -> PreparedCastRelay {
    let relay = try await CastRelayServer.start(
      selection: selection,
      upstream: upstream,
      listenerFactory: listenerFactory,
      makePathMonitor: makePathMonitor,
      notificationCenter: notificationCenter,
      timing: timing,
      maximumResources: maximumResources,
      tokenGenerator: tokenGenerator
    )
    return try await relay.prepare(
      rootTarget: rootTarget,
      profile: profile,
      tracks: tracks
    )
  }
}

struct CastMediaPreparer: Sendable {
  private let resolver: MediaProxyCastResolving
  private let relayFactory: CastRelayPreparing
  private let inspector: CastMediaInspecting

  init(
    resolver: MediaProxyCastResolving = MediaProxyServerCastResolver(),
    relayFactory: CastRelayPreparing? = nil,
    inspector: CastMediaInspecting? = nil
  ) {
    let sharedUpstream = MediaProxyUpstream()
    self.resolver = resolver
    self.relayFactory = relayFactory ?? CastRelayServerFactory(upstream: sharedUpstream)
    self.inspector = inspector ?? CastMediaInspector(upstream: sharedUpstream)
  }

  func prepare(
    source: PreparedCastSource,
    selection: CastNetworkSelection
  ) async throws -> PreparedCastRelay {
    guard source.protocolVersion == 1 else { throw CastRelayError.invalidSource }
    guard source.tracks.count <= CastSourceValidation.maximumTrackCount else {
      throw CastRelayError.tooManyTracks
    }
    let rootTarget: MediaProxyTarget
    if CastSourceValidation.isCanonicalLoopbackMediaURL(source.url) {
      guard let ownedTarget = await resolver.resolveForCast(source.url),
            let normalized = try? CastSourceValidation.normalizedRemoteTarget(
              ownedTarget,
              requiredMethod: "GET"
            ) else {
        throw CastRelayError.localSourceUnavailable
      }
      rootTarget = normalized
    } else {
      let validatedURL: URL
      do {
        validatedURL = try MediaProxyPolicy.validatePublicHTTPSURLSyntax(
          source.url.absoluteString
        )
      } catch {
        throw CastRelayError.invalidSource
      }
      rootTarget = MediaProxyTarget(
        upstreamURL: validatedURL,
        method: "GET",
        headers: MediaProxyPolicy.sanitizeRequestHeaders(source.headers)
      )
    }
    let profile = try await inspector.inspect(
      target: rootTarget,
      hintedContentType: source.contentType
    )
    try Task.checkCancellation()
    return try await relayFactory.prepare(
      selection: selection,
      rootTarget: rootTarget,
      profile: profile,
      tracks: source.tracks
    )
  }
}
