import Foundation
import Darwin

enum MediaProxyIPAddress: Equatable, Hashable, Sendable {
  case v4([UInt8])
  case v6([UInt8])

  init?(_ literal: String) {
    var v4 = in_addr()
    if inet_pton(AF_INET, literal, &v4) == 1 {
      self = .v4(withUnsafeBytes(of: &v4) { Array($0) })
      return
    }

    var v6 = in6_addr()
    if inet_pton(AF_INET6, literal, &v6) == 1 {
      self = .v6(withUnsafeBytes(of: &v6) { Array($0) })
      return
    }
    return nil
  }
}

struct MediaProxyNAT64Prefix: Equatable, Hashable, Sendable {
  static let supportedLengths = [32, 40, 48, 56, 64, 96]

  let length: Int
  fileprivate let bytes: [UInt8]

  init?(_ literal: String, length: Int) {
    guard case let .v6(addressBytes)? = MediaProxyIPAddress(literal) else { return nil }
    self.init(bytes: addressBytes, length: length)
  }

  func synthesize(_ ipv4: MediaProxyIPAddress) -> MediaProxyIPAddress? {
    guard case let .v4(ipv4Bytes) = ipv4, ipv4Bytes.count == 4 else { return nil }
    var synthesized = bytes
    for (index, position) in zip(ipv4Bytes.indices, Self.ipv4Positions(for: length)) {
      synthesized[position] = ipv4Bytes[index]
    }
    if length < 96 { synthesized[8] = 0 }
    return .v6(synthesized)
  }

  func extractIPv4(from address: MediaProxyIPAddress) -> MediaProxyIPAddress? {
    guard case let .v6(addressBytes) = address,
          addressBytes.count == 16,
          matches(addressBytes),
          length == 96 || addressBytes[8] == 0 else { return nil }
    return .v4(Self.ipv4Positions(for: length).map { addressBytes[$0] })
  }

  fileprivate var isWellKnown: Bool {
    length == 96
      && hasPrefix([0x00, 0x64, 0xff, 0x9b])
      && bytes[4...].allSatisfy({ $0 == 0 })
  }

  fileprivate var isLocalUse: Bool {
    length == 48
      && hasPrefix([0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])
  }

  fileprivate static func derived(from address: MediaProxyIPAddress, length: Int) -> Self? {
    guard case let .v6(addressBytes) = address, addressBytes.count == 16 else { return nil }
    var prefixBytes = addressBytes
    let prefixByteCount = length / 8
    if prefixByteCount < prefixBytes.count {
      for index in prefixByteCount..<prefixBytes.count { prefixBytes[index] = 0 }
    }
    return Self(bytes: prefixBytes, length: length)
  }

  private init?(bytes: [UInt8], length: Int) {
    guard Self.supportedLengths.contains(length), bytes.count == 16 else { return nil }
    let prefixByteCount = length / 8
    guard bytes[prefixByteCount...].allSatisfy({ $0 == 0 }) else { return nil }
    self.length = length
    self.bytes = bytes
  }

  private func matches(_ addressBytes: [UInt8]) -> Bool {
    let prefixByteCount = length / 8
    return addressBytes.prefix(prefixByteCount).elementsEqual(bytes.prefix(prefixByteCount))
  }

  private func hasPrefix(_ prefix: [UInt8]) -> Bool {
    bytes.prefix(prefix.count).elementsEqual(prefix)
  }

  private static func ipv4Positions(for length: Int) -> [Int] {
    switch length {
    case 32: return [4, 5, 6, 7]
    case 40: return [5, 6, 7, 9]
    case 48: return [6, 7, 9, 10]
    case 56: return [7, 9, 10, 11]
    case 64: return [9, 10, 11, 12]
    case 96: return [12, 13, 14, 15]
    default: return []
    }
  }
}

enum MediaProxyPolicyError: Error, Equatable {
  case invalidURL
  case httpsRequired
  case credentialsForbidden
  case unsupportedPort
  case missingHost
  case forbiddenHost
  case dnsFailed
  case forbiddenAddress
}

enum MediaProxyPolicy {
  static let maximumURLLength = 16_384
  static let maximumHeaderValueLength = 8_192
  static let playbackUserAgent = "Mozilla/5.0 Chrome/140.0.0.0"

  static let allowedRequestHeaders: [String: String] = [
    "accept": "Accept",
    "accept-language": "Accept-Language",
    "content-type": "Content-Type",
    "if-modified-since": "If-Modified-Since",
    "if-none-match": "If-None-Match",
    "origin": "Origin",
    "range": "Range",
    "referer": "Referer",
    "sec-fetch-dest": "Sec-Fetch-Dest",
    "sec-fetch-mode": "Sec-Fetch-Mode",
    "sec-fetch-site": "Sec-Fetch-Site",
    "user-agent": "User-Agent",
  ]

  static let allowedLocalOverrides: Set<String> = [
    "accept",
    "accept-language",
    "if-modified-since",
    "if-none-match",
    "range",
  ]

  /// Validates the initial upstream URL. The Task 4 transport layer must separately
  /// pin or revalidate every connection and redirect to defend against DNS rebinding.
  static func validatePublicHTTPSURL(
    _ raw: String,
    resolve: (String) throws -> [MediaProxyIPAddress] = resolveHost,
    activeNAT64Prefixes: [MediaProxyNAT64Prefix]? = nil
  ) throws -> URL {
    let url = try validatePublicHTTPSURLSyntax(raw)
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let componentHost = components.host else {
      throw MediaProxyPolicyError.invalidURL
    }
    let host = normalizedHost(componentHost)
    let effectiveNAT64Prefixes = activeNAT64Prefixes ?? discoverNAT64Prefixes()

    if let literalAddresses = numericAddresses(for: host), literalAddresses.contains(where: {
      isForbiddenAddress($0, activeNAT64Prefixes: effectiveNAT64Prefixes)
    }) {
      throw MediaProxyPolicyError.forbiddenAddress
    }

    let addresses: [MediaProxyIPAddress]
    do {
      addresses = try resolve(host)
    } catch {
      throw MediaProxyPolicyError.dnsFailed
    }
    guard !addresses.isEmpty else { throw MediaProxyPolicyError.dnsFailed }
    guard addresses.allSatisfy({
      !isForbiddenAddress($0, activeNAT64Prefixes: effectiveNAT64Prefixes)
    }) else {
      throw MediaProxyPolicyError.forbiddenAddress
    }
    return url
  }

  /// Performs only deterministic URL syntax and literal-address checks. Callers
  /// opening a connection must still resolve, pin, and revalidate every redirect.
  static func validatePublicHTTPSURLSyntax(_ raw: String) throws -> URL {
    guard !raw.isEmpty, raw.utf8.count <= maximumURLLength,
          let components = URLComponents(string: raw),
          let url = components.url,
          url.absoluteString.utf8.count <= maximumURLLength else {
      throw MediaProxyPolicyError.invalidURL
    }
    guard components.scheme?.lowercased() == "https" else {
      throw MediaProxyPolicyError.httpsRequired
    }
    guard components.user == nil, components.password == nil else {
      throw MediaProxyPolicyError.credentialsForbidden
    }
    guard components.port == nil || components.port == 443 else {
      throw MediaProxyPolicyError.unsupportedPort
    }
    guard let componentHost = components.host, !componentHost.isEmpty else {
      throw MediaProxyPolicyError.missingHost
    }

    let host = normalizedHost(componentHost)
    guard !host.isEmpty else { throw MediaProxyPolicyError.missingHost }
    guard !isReservedLocalHost(host) else {
      throw MediaProxyPolicyError.forbiddenHost
    }

    if let literalAddresses = numericAddresses(for: host), literalAddresses.contains(where: {
      isForbiddenAddress($0)
    }) {
      throw MediaProxyPolicyError.forbiddenAddress
    }
    return url
  }

  static func sanitizeRequestHeaders(_ input: [String: String]) -> [String: String] {
    let candidates = input.compactMap { rawName, rawValue -> (String, String, String)? in
      guard !containsControlCharacter(rawName) else { return nil }
      let normalizedName = rawName.trimmingCharacters(in: .whitespaces).lowercased()
      guard let canonicalName = allowedRequestHeaders[normalizedName] else { return nil }
      return (normalizedName, canonicalName, rawValue)
    }
    let counts = Dictionary(grouping: candidates, by: { $0.0 }).mapValues(\.count)

    return candidates.reduce(into: [:]) { output, candidate in
      let (normalizedName, canonicalName, rawValue) = candidate
      guard counts[normalizedName] == 1,
            rawValue.utf8.count <= maximumHeaderValueLength,
            !containsControlCharacter(rawValue) else { return }
      let value = rawValue.trimmingCharacters(in: .whitespaces)
      guard !value.isEmpty, value.utf8.count <= maximumHeaderValueLength else { return }
      output[canonicalName] = value
    }
  }

  static func sanitizeLocalOverrideHeaders(_ input: [String: String]) -> [String: String] {
    let allowed = input.filter { rawName, _ in
      let normalizedName = rawName.trimmingCharacters(in: .whitespaces).lowercased()
      return allowedLocalOverrides.contains(normalizedName)
    }
    return sanitizeRequestHeaders(allowed)
  }

  static func deriveNAT64Prefixes(
    from answers: [MediaProxyIPAddress]
  ) -> [MediaProxyNAT64Prefix] {
    let wellKnownIPv4Addresses = [
      MediaProxyIPAddress("192.0.0.170")!,
      MediaProxyIPAddress("192.0.0.171")!,
    ]
    var evidence: [MediaProxyNAT64Prefix: Set<MediaProxyIPAddress>] = [:]

    for answer in answers {
      for wellKnownIPv4 in wellKnownIPv4Addresses {
        // Type de retour explicite : dans une closure multi-instructions, le
        // `return nil` du guard ne suffit pas a inferer ElementOfResult.
        let candidates = MediaProxyNAT64Prefix.supportedLengths
          .compactMap { length -> MediaProxyNAT64Prefix? in
            guard let prefix = MediaProxyNAT64Prefix.derived(from: answer, length: length),
                  prefix.extractIPv4(from: answer) == wellKnownIPv4 else { return nil }
            return prefix
          }
        guard candidates.count == 1, let prefix = candidates.first else { continue }
        evidence[prefix, default: []].insert(wellKnownIPv4)
      }
    }

    return evidence.compactMap { prefix, addresses in
      addresses.count == wellKnownIPv4Addresses.count ? prefix : nil
    }.sorted { lhs, rhs in
      if lhs.length != rhs.length { return lhs.length < rhs.length }
      return lhs.bytes.lexicographicallyPrecedes(rhs.bytes)
    }
  }

  static func discoverNAT64Prefixes(
    resolve: (String) throws -> [MediaProxyIPAddress] = resolveIPv6Host
  ) -> [MediaProxyNAT64Prefix] {
    guard let answers = try? resolve("ipv4only.arpa") else { return [] }
    return deriveNAT64Prefixes(from: answers)
  }

  static func isForbiddenAddress(
    _ address: MediaProxyIPAddress,
    activeNAT64Prefixes: [MediaProxyNAT64Prefix] = []
  ) -> Bool {
    switch address {
    case let .v4(bytes):
      return isForbiddenIPv4(bytes)
    case let .v6(bytes):
      guard bytes.count == 16 else { return true }

      // IPv4-mapped, IPv4-compatible and IPv4-translated forms.
      if bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
        return isForbiddenIPv4(Array(bytes[12...15]))
      }
      if bytes[0..<12].allSatisfy({ $0 == 0 }) {
        return isForbiddenIPv4(Array(bytes[12...15]))
      }
      if bytes[0..<8].allSatisfy({ $0 == 0 }) && bytes[8] == 0xff && bytes[9] == 0xff
        && bytes[10] == 0 && bytes[11] == 0 {
        return isForbiddenIPv4(Array(bytes[12...15]))
      }

      let ipv6Address = MediaProxyIPAddress.v6(bytes)
      let wellKnownNAT64 = MediaProxyNAT64Prefix("64:ff9b::", length: 96)!
      var embeddedIPv4Addresses: [MediaProxyIPAddress] = []
      if let embeddedIPv4 = wellKnownNAT64.extractIPv4(from: ipv6Address) {
        embeddedIPv4Addresses.append(embeddedIPv4)
      }
      for prefix in activeNAT64Prefixes where isUsableActiveNAT64Prefix(prefix) {
        if let embeddedIPv4 = prefix.extractIPv4(from: ipv6Address) {
          embeddedIPv4Addresses.append(embeddedIPv4)
        }
      }
      if !embeddedIPv4Addresses.isEmpty {
        return embeddedIPv4Addresses.contains { isForbiddenAddress($0) }
      }

      if isForbiddenIPv6Base(bytes) { return true }
      if hasPrefix(bytes, [0x20, 0x02]) { // 6to4
        return isForbiddenIPv4(Array(bytes[2...5]))
      }
      return false
    }
  }

  static func resolveHost(_ host: String) throws -> [MediaProxyIPAddress] {
    let addresses = addressesFromGetAddrInfo(host: host, service: "443", flags: AI_ADDRCONFIG)
    guard let resolvedAddresses = addresses, !resolvedAddresses.isEmpty else {
      throw MediaProxyPolicyError.dnsFailed
    }
    return resolvedAddresses
  }

  static func resolveIPv6Host(_ host: String) throws -> [MediaProxyIPAddress] {
    let addresses = addressesFromGetAddrInfo(
      host: host,
      service: nil,
      flags: AI_ADDRCONFIG,
      family: AF_INET6
    )
    guard let resolvedAddresses = addresses, !resolvedAddresses.isEmpty else {
      throw MediaProxyPolicyError.dnsFailed
    }
    return resolvedAddresses
  }

  private static func normalizedHost(_ host: String) -> String {
    var normalized = host.lowercased()
    if normalized.hasPrefix("[") && normalized.hasSuffix("]") {
      normalized.removeFirst()
      normalized.removeLast()
    }
    if let scope = normalized.firstIndex(of: "%") {
      normalized = String(normalized[..<scope])
    }
    if normalized.hasSuffix(".") {
      normalized.removeLast()
    }
    return normalized
  }

  private static func isReservedLocalHost(_ host: String) -> Bool {
    let unqualified = host.hasSuffix(".") ? String(host.dropLast()) : host
    return unqualified == "localhost"
      || unqualified.hasSuffix(".localhost")
      || unqualified == "local"
      || unqualified.hasSuffix(".local")
      || unqualified == "home.arpa"
      || unqualified.hasSuffix(".home.arpa")
      || unqualified == "internal"
      || unqualified.hasSuffix(".internal")
      || unqualified == "localdomain"
      || unqualified.hasSuffix(".localdomain")
  }

  private static func numericAddresses(for host: String) -> [MediaProxyIPAddress]? {
    if let strictAddress = MediaProxyIPAddress(host) { return [strictAddress] }
    return addressesFromGetAddrInfo(host: host, service: nil, flags: AI_NUMERICHOST)
  }

  private static func addressesFromGetAddrInfo(
    host: String,
    service: String?,
    flags: Int32,
    family: Int32 = AF_UNSPEC
  ) -> [MediaProxyIPAddress]? {
    var hints = addrinfo(
      ai_flags: flags,
      ai_family: family,
      ai_socktype: SOCK_STREAM,
      ai_protocol: Int32(IPPROTO_TCP),
      ai_addrlen: 0,
      ai_canonname: nil,
      ai_addr: nil,
      ai_next: nil
    )
    var result: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, service, &hints, &result) == 0, let first = result else {
      return nil
    }
    defer { freeaddrinfo(result) }

    var addresses: [MediaProxyIPAddress] = []
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let infoPointer = cursor {
      let info = infoPointer.pointee
      if let socketAddress = info.ai_addr,
         info.ai_family == AF_INET || info.ai_family == AF_INET6 {
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(
          socketAddress,
          info.ai_addrlen,
          &buffer,
          socklen_t(buffer.count),
          nil,
          0,
          NI_NUMERICHOST
        ) == 0, let address = MediaProxyIPAddress(String(cString: buffer)) {
          addresses.append(address)
        }
      }
      cursor = info.ai_next
    }
    return addresses
  }

  private static func isForbiddenIPv4(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 4 else { return true }
    let first = Int(bytes[0])
    let second = Int(bytes[1])
    let third = Int(bytes[2])
    let fourth = Int(bytes[3])
    return first == 0
      || first == 10
      || first == 127
      || first >= 224
      || (first == 100 && second >= 64 && second <= 127)
      || (first == 169 && second == 254)
      || (first == 172 && second >= 16 && second <= 31)
      || (first == 192 && second == 0 && third == 0 && fourth != 9 && fourth != 10)
      || (first == 192 && second == 0 && third == 2)
      || (first == 192 && second == 88 && third == 99)
      || (first == 192 && second == 168)
      || (first == 198 && (second == 18 || second == 19))
      || (first == 198 && second == 51 && third == 100)
      || (first == 203 && second == 0 && third == 113)
  }

  private static func isUsableActiveNAT64Prefix(_ prefix: MediaProxyNAT64Prefix) -> Bool {
    prefix.isWellKnown || prefix.isLocalUse || !isForbiddenIPv6Base(prefix.bytes)
  }

  private static func isForbiddenIPv6Base(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 16 else { return true }
    if bytes.allSatisfy({ $0 == 0 }) { return true }
    if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes.last == 1 { return true }
    if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true } // fe80::/10
    if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0xc0 { return true } // fec0::/10
    if (bytes[0] & 0xfe) == 0xfc { return true } // fc00::/7
    if bytes[0] == 0xff { return true } // ff00::/8
    if hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01]) { return true } // local NAT64
    if hasPrefix(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0]) { return true } // discard-only
    if hasPrefix(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0x01]) { return true } // dummy
    if isInIETFProtocolAssignments(bytes) && !isGlobalIETFProtocolException(bytes) { return true }
    if hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8]) { return true } // documentation
    if bytes[0] == 0x3f && bytes[1] == 0xff && (bytes[2] & 0xf0) == 0 { return true }
    if hasPrefix(bytes, [0x5f, 0x00]) { return true } // SRv6 SIDs
    if hasPrefix(bytes, [0x3f, 0xfe]) { return true } // retired 6bone
    return false
  }

  private static func isInIETFProtocolAssignments(_ bytes: [UInt8]) -> Bool {
    hasPrefix(bytes, [0x20, 0x01]) && (bytes[2] & 0xfe) == 0
  }

  private static func isGlobalIETFProtocolException(_ bytes: [UInt8]) -> Bool {
    let exactAnycast = hasPrefix(bytes, [0x20, 0x01, 0x00, 0x01])
      && bytes[4..<15].allSatisfy({ $0 == 0 })
      && [UInt8(1), UInt8(2), UInt8(3)].contains(bytes[15])
    return exactAnycast
      || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x03])
      || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x04, 0x01, 0x12])
      || (hasPrefix(bytes, [0x20, 0x01, 0x00]) && (bytes[3] & 0xf0) == 0x20)
      || (hasPrefix(bytes, [0x20, 0x01, 0x00]) && (bytes[3] & 0xf0) == 0x30)
  }

  private static func hasPrefix(_ bytes: [UInt8], _ prefix: [UInt8]) -> Bool {
    bytes.count >= prefix.count && bytes.prefix(prefix.count).elementsEqual(prefix)
  }

  private static func containsControlCharacter(_ value: String) -> Bool {
    value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
  }
}
