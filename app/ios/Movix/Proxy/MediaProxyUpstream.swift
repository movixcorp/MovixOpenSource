import Foundation
import Network
import Security

enum MediaProxyUpstreamError: Error, Equatable {
  case invalidResponse
  case responseHeadersTooLarge
  case unsupportedTransferEncoding
  case missingRedirectLocation
  case tooManyRedirects
  case decoyRedirect
  case connectionFailed
  case timedOut
  case truncatedBody
  case cancelled
}

protocol MediaProxyUpstreamBody: AnyObject, Sendable {
  func nextChunk() async throws -> Data?
  func cancel()
}

struct MediaProxyUpstreamTransportRequest: Sendable {
  let url: URL
  let method: String
  let headers: [String: String]
  let pinnedAddresses: [MediaProxyIPAddress]
}

struct MediaProxyUpstreamTransportResponse: Sendable {
  let statusCode: Int
  let headers: [String: String]
  let body: MediaProxyUpstreamBody
}

protocol MediaProxyUpstreamTransport: AnyObject, Sendable {
  func execute(
    _ request: MediaProxyUpstreamTransportRequest
  ) async throws -> MediaProxyUpstreamTransportResponse
}

struct MediaProxyUpstreamResponse: Sendable {
  let statusCode: Int
  let headers: [String: String]
  let finalURL: URL
  let body: MediaProxyUpstreamBody
}

final class MediaProxyUpstream: @unchecked Sendable {
  static let maximumRedirects = 5

  typealias Resolver = @Sendable (String) throws -> [MediaProxyIPAddress]
  typealias NAT64PrefixProvider = @Sendable () -> [MediaProxyNAT64Prefix]

  private let transport: MediaProxyUpstreamTransport
  private let resolve: Resolver
  private let activeNAT64Prefixes: NAT64PrefixProvider

  init(
    transport: MediaProxyUpstreamTransport = MediaProxyPinnedHTTPTransport(),
    resolve: @escaping Resolver = MediaProxyPolicy.resolveHost,
    activeNAT64Prefixes: @escaping NAT64PrefixProvider = {
      MediaProxyPolicy.discoverNAT64Prefixes()
    }
  ) {
    self.transport = transport
    self.resolve = resolve
    self.activeNAT64Prefixes = activeNAT64Prefixes
  }

  /// This initializer exists only for deterministic XCTest fixtures. Production
  /// always uses `MediaProxyPinnedHTTPTransport`, which connects to a validated IP.
  convenience init(
    testingConfiguration: URLSessionConfiguration,
    resolve: @escaping Resolver,
    activeNAT64Prefixes: @escaping NAT64PrefixProvider
  ) {
    self.init(
      transport: MediaProxyURLSessionTestingTransport(configuration: testingConfiguration),
      resolve: resolve,
      activeNAT64Prefixes: activeNAT64Prefixes
    )
  }

  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse {
    let method = target.method.uppercased()
    guard method == "GET" || method == "HEAD" else {
      throw MediaProxyUpstreamError.invalidResponse
    }
    if MediaProxyPolicy.isProviderDecoyURL(target.upstreamURL.absoluteString) {
      throw MediaProxyUpstreamError.decoyRedirect
    }
    var headers = MediaProxyPolicy.sanitizeRequestHeaders(target.headers)
    for (name, value) in MediaProxyPolicy.sanitizeLocalOverrideHeaders(localHeaders) {
      headers[name] = value
    }
    if headers["User-Agent"] == nil {
      headers["User-Agent"] = MediaProxyPolicy.playbackUserAgent
    }
    if headers["Sec-Ch-Ua"] == nil {
      headers["Sec-Ch-Ua"] = MediaProxyPolicy.playbackSecChUa
    }
    if headers["Sec-Ch-Ua-Mobile"] == nil {
      headers["Sec-Ch-Ua-Mobile"] = MediaProxyPolicy.playbackSecChUaMobile
    }
    if headers["Sec-Ch-Ua-Platform"] == nil {
      headers["Sec-Ch-Ua-Platform"] = MediaProxyPolicy.playbackSecChUaPlatform
    }

    var currentURL = target.upstreamURL
    var redirects = 0
    var previousOrigin: MediaProxyOrigin?
    while true {
      try Task.checkCancellation()
      let validated = try validateAndResolveAddresses(for: currentURL)
      currentURL = validated.url
      let currentOrigin = MediaProxyOrigin(currentURL)
      if let previousOrigin = previousOrigin, previousOrigin != currentOrigin {
        headers.removeValue(forKey: "Origin")
        headers.removeValue(forKey: "Referer")
      }
      headers = MediaProxyPolicy.sanitizeRequestHeaders(headers)
      let response = try await transport.execute(MediaProxyUpstreamTransportRequest(
        url: currentURL,
        method: method,
        headers: headers,
        pinnedAddresses: validated.addresses
      ))

      // Corps non relevé : il arrive en flux et le lire le consommerait pour le
      // lecteur. Ce sont les en-têtes émis qui départagent un 403.
      MediaProxyJournal.record(
        phase: "media/ios",
        method: method,
        url: currentURL.absoluteString,
        requestHeaders: headers,
        statusCode: response.statusCode,
        responseHeaders: response.headers,
        localRequestHeaders: localHeaders
      )

      guard Self.redirectStatusCodes.contains(response.statusCode) else {
        return MediaProxyUpstreamResponse(
          statusCode: response.statusCode,
          headers: response.headers,
          finalURL: currentURL,
          body: response.body
        )
      }
      response.body.cancel()
      guard redirects < Self.maximumRedirects else {
        throw MediaProxyUpstreamError.tooManyRedirects
      }
      guard let rawLocation = Self.header(named: "location", in: response.headers),
            rawLocation.utf8.count <= MediaProxyPolicy.maximumURLLength,
            !rawLocation.unicodeScalars.contains(where: {
              CharacterSet.controlCharacters.contains($0)
            }),
            let nextURL = URL(string: rawLocation, relativeTo: currentURL)?.absoluteURL else {
        throw MediaProxyUpstreamError.missingRedirectLocation
      }
      // Fsvid/Vidzy redirigent vers leur flux leurre quand ils refusent la
      // requête : la suivre ferait lire la vidéo troll au lieu d'échouer.
      if MediaProxyPolicy.isProviderDecoyURL(nextURL.absoluteString) {
        throw MediaProxyUpstreamError.decoyRedirect
      }
      previousOrigin = currentOrigin
      currentURL = nextURL
      redirects += 1
    }
  }

  private func validateAndResolveAddresses(
    for rawURL: URL
  ) throws -> (url: URL, addresses: [MediaProxyIPAddress]) {
    let syntaxURL = try MediaProxyPolicy.validatePublicHTTPSURLSyntax(rawURL.absoluteString)
    guard let host = syntaxURL.host else { throw MediaProxyPolicyError.missingHost }
    let addresses: [MediaProxyIPAddress]
    do {
      addresses = try resolve(host)
    } catch let error as MediaProxyPolicyError {
      throw error
    } catch {
      throw MediaProxyPolicyError.dnsFailed
    }
    let validatedURL = try MediaProxyPolicy.validatePublicHTTPSURL(
      syntaxURL.absoluteString,
      resolve: { _ in addresses },
      activeNAT64Prefixes: activeNAT64Prefixes()
    )
    var seen: Set<MediaProxyIPAddress> = []
    let uniqueAddresses = addresses.filter { seen.insert($0).inserted }
    guard !uniqueAddresses.isEmpty else {
      throw MediaProxyPolicyError.dnsFailed
    }
    return (validatedURL, uniqueAddresses)
  }

  private static let redirectStatusCodes: Set<Int> = [301, 302, 303, 307, 308]

  fileprivate static func header(
    named requestedName: String,
    in headers: [String: String]
  ) -> String? {
    headers.first(where: {
      $0.key.caseInsensitiveCompare(requestedName) == .orderedSame
    })?.value
  }
}

private struct MediaProxyOrigin: Equatable {
  let scheme: String
  let host: String
  let port: Int

  init(_ url: URL) {
    scheme = url.scheme?.lowercased() ?? ""
    host = url.host?.lowercased() ?? ""
    port = url.port ?? 443
  }
}

final class MediaProxyURLSessionTestingTransport: NSObject,
  MediaProxyUpstreamTransport,
  URLSessionTaskDelegate,
  @unchecked Sendable {
  private let configuration: URLSessionConfiguration
  private lazy var session = URLSession(
    configuration: configuration,
    delegate: self,
    delegateQueue: nil
  )

  init(configuration: URLSessionConfiguration) {
    self.configuration = configuration
    super.init()
  }

  func execute(
    _ request: MediaProxyUpstreamTransportRequest
  ) async throws -> MediaProxyUpstreamTransportResponse {
    var urlRequest = URLRequest(url: request.url)
    urlRequest.httpMethod = request.method
    urlRequest.timeoutInterval = 30
    for (name, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    let (data, response) = try await session.data(for: urlRequest, delegate: self)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw MediaProxyUpstreamError.invalidResponse
    }
    var headers: [String: String] = [:]
    for (name, value) in httpResponse.allHeaderFields {
      guard let name = name as? String else { continue }
      headers[name] = String(describing: value)
    }
    return MediaProxyUpstreamTransportResponse(
      statusCode: httpResponse.statusCode,
      headers: headers,
      body: MediaProxyDataUpstreamBody(data)
    )
  }

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

private final class MediaProxyDataUpstreamBody: MediaProxyUpstreamBody,
  @unchecked Sendable {
  private let lock = NSLock()
  private var data: Data?
  private var cancelled = false

  init(_ data: Data) { self.data = data }

  func nextChunk() async throws -> Data? {
    lock.lock()
    defer { lock.unlock() }
    guard !cancelled else { throw MediaProxyUpstreamError.cancelled }
    defer { data = nil }
    return data
  }

  func cancel() {
    lock.lock()
    cancelled = true
    data = nil
    lock.unlock()
  }
}

protocol MediaProxyPinnedHTTPExchangeTask: AnyObject, Sendable {
  func start(timeout: TimeInterval) async throws -> MediaProxyUpstreamTransportResponse
  func cancel()
}

final class MediaProxyPinnedHTTPTransport: MediaProxyUpstreamTransport,
  @unchecked Sendable {
  typealias ExchangeFactory = @Sendable (
    MediaProxyUpstreamTransportRequest,
    MediaProxyIPAddress
  ) throws -> MediaProxyPinnedHTTPExchangeTask

  private static let defaultTotalTimeout: TimeInterval = 30
  private static let defaultPerAttemptTimeout: TimeInterval = 5
  private let totalTimeout: TimeInterval
  private let perAttemptTimeout: TimeInterval
  private let monotonicNow: @Sendable () -> TimeInterval
  private let exchangeFactory: ExchangeFactory

  init(
    totalTimeout: TimeInterval = 30,
    perAttemptTimeout: TimeInterval = 5,
    monotonicNow: @escaping @Sendable () -> TimeInterval = {
      ProcessInfo.processInfo.systemUptime
    },
    exchangeFactory: @escaping ExchangeFactory = { request, address in
      try MediaProxyPinnedHTTPExchange(request: request, pinnedAddress: address)
    }
  ) {
    self.totalTimeout = totalTimeout.isFinite && totalTimeout > 0
      ? totalTimeout
      : Self.defaultTotalTimeout
    self.perAttemptTimeout = perAttemptTimeout.isFinite && perAttemptTimeout > 0
      ? perAttemptTimeout
      : Self.defaultPerAttemptTimeout
    self.monotonicNow = monotonicNow
    self.exchangeFactory = exchangeFactory
  }

  func execute(
    _ request: MediaProxyUpstreamTransportRequest
  ) async throws -> MediaProxyUpstreamTransportResponse {
    guard !request.pinnedAddresses.isEmpty else {
      throw MediaProxyUpstreamError.connectionFailed
    }
    let deadline = monotonicNow() + totalTimeout
    var lastError: Error = MediaProxyUpstreamError.connectionFailed
    for address in request.pinnedAddresses {
      try Task.checkCancellation()
      let remaining = deadline - monotonicNow()
      guard remaining > 0 else { throw MediaProxyUpstreamError.timedOut }
      let exchange: MediaProxyPinnedHTTPExchangeTask
      do {
        exchange = try exchangeFactory(request, address)
      } catch {
        lastError = error
        continue
      }
      do {
        return try await exchange.start(timeout: min(perAttemptTimeout, remaining))
      } catch is CancellationError {
        exchange.cancel()
        throw CancellationError()
      } catch {
        exchange.cancel()
        if Task.isCancelled { throw CancellationError() }
        lastError = error
      }
    }
    if monotonicNow() >= deadline { throw MediaProxyUpstreamError.timedOut }
    throw lastError
  }
}

final class MediaProxyPinnedHTTPExchange: MediaProxyPinnedHTTPExchangeTask,
  @unchecked Sendable {
  private let request: MediaProxyUpstreamTransportRequest
  private let queue = DispatchQueue(label: "com.movix.media-proxy.upstream")
  private let connection: NWConnection
  private var responseDecoder: MediaProxyHTTPResponseHeadDecoder
  private var completed = false

  init(
    request: MediaProxyUpstreamTransportRequest,
    pinnedAddress: MediaProxyIPAddress
  ) throws {
    self.request = request
    responseDecoder = MediaProxyHTTPResponseHeadDecoder(requestMethod: request.method)
    let tlsOptions = NWProtocolTLS.Options()
    guard let hostname = request.url.host else {
      throw MediaProxyUpstreamError.connectionFailed
    }
    hostname.withCString { serverName in
      sec_protocol_options_set_tls_server_name(
        tlsOptions.securityProtocolOptions,
        serverName
      )
    }
    let parameters = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
    let endpoint = NWEndpoint.hostPort(
      host: try Self.endpointHost(for: pinnedAddress),
      port: NWEndpoint.Port(rawValue: 443)!
    )
    connection = NWConnection(to: endpoint, using: parameters)
  }

  func start(timeout: TimeInterval) async throws -> MediaProxyUpstreamTransportResponse {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = MediaProxyContinuationGate<MediaProxyUpstreamTransportResponse>(
          continuation
        )
        connection.stateUpdateHandler = { [weak self] state in
          guard let self = self else { return }
          switch state {
          case .ready:
            self.sendRequest(gate: gate)
          case .failed:
            if gate.resume(throwing: MediaProxyUpstreamError.connectionFailed) {
              self.connection.cancel()
            }
          case .cancelled:
            gate.resume(throwing: MediaProxyUpstreamError.cancelled)
          default:
            break
          }
        }
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
          guard let self = self, !self.completed else { return }
          if gate.resume(throwing: MediaProxyUpstreamError.timedOut) {
            self.connection.cancel()
          }
        }
        connection.start(queue: queue)
      }
    } onCancel: {
      self.cancel()
    }
  }

  func cancel() { connection.cancel() }

  private func sendRequest(
    gate: MediaProxyContinuationGate<MediaProxyUpstreamTransportResponse>
  ) {
    let serialized: Data
    do {
      serialized = try Self.serialize(request)
    } catch {
      gate.resume(throwing: error)
      connection.cancel()
      return
    }
    connection.send(
      content: serialized,
      contentContext: .defaultStream,
      isComplete: false,
      completion: .contentProcessed { [weak self] error in
        guard let self = self else { return }
        if error != nil {
          gate.resume(throwing: MediaProxyUpstreamError.connectionFailed)
          self.connection.cancel()
          return
        }
        self.receiveResponseHeaders(gate: gate)
      }
    )
  }

  private func receiveResponseHeaders(
    gate: MediaProxyContinuationGate<MediaProxyUpstreamTransportResponse>
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1_024) {
      [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      do {
        if let data = data,
           let parsed = try self.responseDecoder.append(data) {
          let body = MediaProxyPinnedHTTPBody(
            connection: self.connection,
            initialData: parsed.initialBody,
            framing: parsed.framing
          )
          self.completed = true
          self.connection.stateUpdateHandler = nil
          gate.resume(returning: MediaProxyUpstreamTransportResponse(
            statusCode: parsed.statusCode,
            headers: parsed.headers,
            body: body
          ))
          return
        }
      } catch {
        gate.resume(throwing: error)
        self.connection.cancel()
        return
      }
      guard error == nil, !isComplete else {
        gate.resume(throwing: MediaProxyUpstreamError.invalidResponse)
        self.connection.cancel()
        return
      }
      self.receiveResponseHeaders(gate: gate)
    }
  }

  private static func serialize(_ request: MediaProxyUpstreamTransportRequest) throws -> Data {
    guard let components = URLComponents(url: request.url, resolvingAgainstBaseURL: false),
          let rawHost = components.host else {
      throw MediaProxyUpstreamError.connectionFailed
    }
    var requestTarget = components.percentEncodedPath
    if requestTarget.isEmpty { requestTarget = "/" }
    if let query = components.percentEncodedQuery { requestTarget += "?\(query)" }
    guard !requestTarget.contains("\r"), !requestTarget.contains("\n") else {
      throw MediaProxyUpstreamError.connectionFailed
    }
    let host = rawHost.contains(":") ? "[\(rawHost)]" : rawHost
    var lines = ["\(request.method) \(requestTarget) HTTP/1.1", "Host: \(host)"]
    var headers = request.headers
    headers.removeValue(forKey: "Host")
    headers.removeValue(forKey: "Connection")
    headers.removeValue(forKey: "Accept-Encoding")
    headers["Accept-Encoding"] = "identity"
    headers["Connection"] = "close"
    for name in headers.keys.sorted() {
      guard let value = headers[name],
            !name.contains("\r"), !name.contains("\n"),
            !value.contains("\r"), !value.contains("\n") else {
        throw MediaProxyUpstreamError.connectionFailed
      }
      lines.append("\(name): \(value)")
    }
    return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
  }

  private static func endpointHost(
    for address: MediaProxyIPAddress
  ) throws -> NWEndpoint.Host {
    switch address {
    case let .v4(bytes):
      guard let address = IPv4Address(Data(bytes)) else {
        throw MediaProxyUpstreamError.connectionFailed
      }
      return .ipv4(address)
    case let .v6(bytes):
      guard let address = IPv6Address(Data(bytes)) else {
        throw MediaProxyUpstreamError.connectionFailed
      }
      return .ipv6(address)
    }
  }

}

enum MediaProxyHTTPBodyFraming: Sendable, Equatable {
  case none
  case contentLength(Int64)
  case chunked
  case untilEOF
}

struct MediaProxyDecodedHTTPResponseHead: Sendable {
  let statusCode: Int
  let headers: [String: String]
  let framing: MediaProxyHTTPBodyFraming
  let initialBody: Data
}

struct MediaProxyHTTPResponseHeadDecoder: Sendable {
  static let maximumInformationalResponses = 8
  private static let maximumResponseHeaderBytes = 64 * 1_024
  private static let maximumStatusLineBytes = 8 * 1_024
  private static let delimiter = Data([13, 10, 13, 10])

  private let requestMethod: String
  private var buffer = Data()
  private var consumedHeaderBytes = 0
  private var informationalResponses = 0
  private var finished = false

  init(requestMethod: String) {
    self.requestMethod = requestMethod.uppercased()
  }

  mutating func append(_ data: Data) throws -> MediaProxyDecodedHTTPResponseHead? {
    guard !finished else { throw MediaProxyUpstreamError.invalidResponse }
    buffer.append(data)
    while let delimiterRange = buffer.range(of: Self.delimiter) {
      let headerData = Data(buffer[..<delimiterRange.upperBound])
      consumedHeaderBytes += headerData.count
      guard consumedHeaderBytes <= Self.maximumResponseHeaderBytes else {
        throw MediaProxyUpstreamError.responseHeadersTooLarge
      }
      buffer.removeSubrange(..<delimiterRange.upperBound)
      let parsed = try Self.parse(headerData, requestMethod: requestMethod)
      if parsed.statusCode < 200 {
        informationalResponses += 1
        guard informationalResponses <= Self.maximumInformationalResponses else {
          throw MediaProxyUpstreamError.invalidResponse
        }
        continue
      }
      finished = true
      let initialBody = buffer
      buffer.removeAll(keepingCapacity: false)
      return MediaProxyDecodedHTTPResponseHead(
        statusCode: parsed.statusCode,
        headers: parsed.headers,
        framing: parsed.framing,
        initialBody: initialBody
      )
    }
    guard consumedHeaderBytes + buffer.count <= Self.maximumResponseHeaderBytes else {
      throw MediaProxyUpstreamError.responseHeadersTooLarge
    }
    return nil
  }

  private static func parse(
    _ data: Data,
    requestMethod: String
  ) throws -> ParsedResponse {
    guard data.count <= maximumResponseHeaderBytes,
          data.allSatisfy({ byte in
            byte == 13 || byte == 10 || (byte >= 32 && byte <= 126)
          }),
          let text = String(data: data, encoding: .ascii) else {
      throw MediaProxyUpstreamError.invalidResponse
    }
    let parts = text.components(separatedBy: "\r\n")
    guard parts.count >= 3,
          parts.suffix(2).allSatisfy(\.isEmpty),
          let statusLine = parts.first,
          statusLine.utf8.count <= maximumStatusLineBytes else {
      throw MediaProxyUpstreamError.invalidResponse
    }
    let statusParts = statusLine.split(separator: " ", maxSplits: 2)
    guard statusParts.count >= 2,
          statusParts[0] == "HTTP/1.1" || statusParts[0] == "HTTP/1.0",
          statusParts[1].count == 3,
          let statusCode = Int(statusParts[1]),
          (100...599).contains(statusCode),
          statusCode != 101 else {
      throw MediaProxyUpstreamError.invalidResponse
    }

    var valuesByName: [String: [String]] = [:]
    var displayNames: [String: String] = [:]
    for line in parts.dropFirst().dropLast(2) {
      guard !line.isEmpty,
            line.first != " ", line.first != "\t",
            let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      let rawName = String(line[..<colon])
      guard rawName.utf8.allSatisfy(MediaProxyHTTPToken.isNameByte) else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      let value = String(line[line.index(after: colon)...])
        .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      guard value.utf8.allSatisfy({ $0 >= 32 && $0 <= 126 }) else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      let name = rawName.lowercased()
      valuesByName[name, default: []].append(value)
      displayNames[name] = rawName
    }
    guard valuesByName["location", default: []].count <= 1 else {
      throw MediaProxyUpstreamError.invalidResponse
    }

    let transferValues = valuesByName["transfer-encoding", default: []]
    let contentLengthValues = valuesByName["content-length", default: []]
    guard transferValues.isEmpty || contentLengthValues.isEmpty else {
      throw MediaProxyUpstreamError.invalidResponse
    }

    var contentLength: Int64?
    if !contentLengthValues.isEmpty {
      let parsedLengths = try contentLengthValues.map { rawValue -> Int64 in
        guard !rawValue.isEmpty,
              rawValue.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let value = UInt64(rawValue),
              value <= UInt64(Int64.max) else {
          throw MediaProxyUpstreamError.invalidResponse
        }
        return Int64(value)
      }
      guard Set(parsedLengths).count == 1 else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      contentLength = parsedLengths[0]
    }

    let hasTransferEncoding = !transferValues.isEmpty
    if hasTransferEncoding {
      guard transferValues.count == 1,
            transferValues[0].caseInsensitiveCompare("chunked") == .orderedSame else {
        throw MediaProxyUpstreamError.unsupportedTransferEncoding
      }
    }

    let framing: MediaProxyHTTPBodyFraming
    if statusCode < 200 || statusCode == 204 {
      guard !hasTransferEncoding, contentLength == nil else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      framing = .none
    } else if requestMethod == "HEAD" || statusCode == 304 {
      guard !hasTransferEncoding else {
        throw MediaProxyUpstreamError.unsupportedTransferEncoding
      }
      framing = .none
    } else if hasTransferEncoding {
      framing = .chunked
    } else if let contentLength = contentLength {
      framing = .contentLength(contentLength)
    } else {
      framing = .untilEOF
    }

    var headers: [String: String] = [:]
    for (name, values) in valuesByName where name != "transfer-encoding" {
      guard let displayName = displayNames[name] else { continue }
      headers[displayName] = name == "content-length"
        ? contentLength.map { String($0) } ?? values[0]
        : values.joined(separator: ", ")
    }
    return ParsedResponse(statusCode: statusCode, headers: headers, framing: framing)
  }

  private struct ParsedResponse {
    let statusCode: Int
    let headers: [String: String]
    let framing: MediaProxyHTTPBodyFraming
  }
}

struct MediaProxyChunkedBodyDecoder: Sendable {
  private static let maximumChunkLineBytes = 128
  private static let maximumTrailerBytes = 8 * 1_024
  private static let lineEnd = Data([13, 10])
  private static let trailerEnd = Data([13, 10, 13, 10])

  private enum State: Sendable {
    case chunkLine
    case chunkData(Int)
    case chunkTerminator
    case trailers
    case complete
  }

  private var state: State = .chunkLine

  var isComplete: Bool {
    if case .complete = state { return true }
    return false
  }

  mutating func takeChunk(from buffer: inout Data) throws -> Data? {
    while true {
      switch state {
      case .chunkLine:
        guard let lineRange = buffer.range(of: Self.lineEnd) else {
          if buffer.count > Self.maximumChunkLineBytes {
            throw MediaProxyUpstreamError.invalidResponse
          }
          return nil
        }
        let lineData = Data(buffer[..<lineRange.lowerBound])
        guard lineData.count <= Self.maximumChunkLineBytes,
              let line = String(data: lineData, encoding: .ascii),
              let size = Self.parseChunkLine(line) else {
          throw MediaProxyUpstreamError.invalidResponse
        }
        buffer.removeSubrange(..<lineRange.upperBound)
        state = size == 0 ? .trailers : .chunkData(size)

      case let .chunkData(remaining):
        guard remaining > 0 else {
          state = .chunkTerminator
          continue
        }
        guard !buffer.isEmpty else { return nil }
        let count = min(remaining, min(buffer.count, 64 * 1_024))
        let chunk = Data(buffer.prefix(count))
        buffer.removeFirst(count)
        state = remaining == count ? .chunkTerminator : .chunkData(remaining - count)
        return chunk

      case .chunkTerminator:
        guard buffer.count >= 2 else { return nil }
        guard buffer[buffer.startIndex] == 13,
              buffer[buffer.index(after: buffer.startIndex)] == 10 else {
          throw MediaProxyUpstreamError.invalidResponse
        }
        buffer.removeFirst(2)
        state = .chunkLine

      case .trailers:
        if buffer.starts(with: Self.lineEnd) {
          buffer.removeFirst(2)
          guard buffer.isEmpty else { throw MediaProxyUpstreamError.invalidResponse }
          state = .complete
          return nil
        }
        if let trailerRange = buffer.range(of: Self.trailerEnd) {
          guard trailerRange.upperBound <= Self.maximumTrailerBytes else {
            throw MediaProxyUpstreamError.invalidResponse
          }
          let trailerData = Data(buffer[..<trailerRange.lowerBound])
          try Self.validateTrailers(trailerData)
          buffer.removeSubrange(..<trailerRange.upperBound)
          guard buffer.isEmpty else { throw MediaProxyUpstreamError.invalidResponse }
          state = .complete
          return nil
        }
        guard buffer.count <= Self.maximumTrailerBytes else {
          throw MediaProxyUpstreamError.invalidResponse
        }
        return nil

      case .complete:
        guard buffer.isEmpty else { throw MediaProxyUpstreamError.invalidResponse }
        return nil
      }
    }
  }

  func validateEndOfStream() throws {
    guard isComplete else { throw MediaProxyUpstreamError.truncatedBody }
  }

  private static func parseChunkLine(_ line: String) -> Int? {
    let parts = line.split(separator: ";", omittingEmptySubsequences: false)
    guard let sizePart = parts.first, !sizePart.isEmpty,
          sizePart.utf8.allSatisfy(MediaProxyHTTPToken.isHexDigit),
          let size = UInt64(String(sizePart), radix: 16),
          size <= UInt64(Int.max) else { return nil }
    for rawExtension in parts.dropFirst() {
      guard !rawExtension.isEmpty else { return nil }
      let pair = rawExtension.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard let rawName = pair.first, !rawName.isEmpty,
            rawName.utf8.allSatisfy(MediaProxyHTTPToken.isNameByte) else { return nil }
      if pair.count == 2 {
        let rawValue = pair[1]
        guard !rawValue.isEmpty,
              (rawValue.utf8.allSatisfy(MediaProxyHTTPToken.isNameByte)
                || isValidQuotedString(rawValue)) else { return nil }
      }
    }
    return Int(size)
  }

  private static func isValidQuotedString(_ value: Substring) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count >= 2, bytes.first == 34, bytes.last == 34 else { return false }
    var index = 1
    while index < bytes.count - 1 {
      let byte = bytes[index]
      if byte == 92 {
        index += 1
        guard index < bytes.count - 1, bytes[index] >= 32, bytes[index] <= 126 else {
          return false
        }
      } else if byte == 34 || byte < 32 || byte > 126 {
        return false
      }
      index += 1
    }
    return true
  }

  private static func validateTrailers(_ data: Data) throws {
    guard let text = String(data: data, encoding: .ascii) else {
      throw MediaProxyUpstreamError.invalidResponse
    }
    for line in text.components(separatedBy: "\r\n") {
      guard !line.isEmpty, line.first != " ", line.first != "\t",
            let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
        throw MediaProxyUpstreamError.invalidResponse
      }
      let name = line[..<colon]
      let value = String(line[line.index(after: colon)...])
        .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      guard name.utf8.allSatisfy(MediaProxyHTTPToken.isNameByte),
            value.utf8.allSatisfy({ $0 >= 32 && $0 <= 126 }) else {
        throw MediaProxyUpstreamError.invalidResponse
      }
    }
  }
}

private final class MediaProxyPinnedHTTPBody: MediaProxyUpstreamBody,
  @unchecked Sendable {
  private static let maximumReceiveBytes = 64 * 1_024
  private static let readTimeout: TimeInterval = 30

  private let connection: NWConnection
  private let lock = NSLock()
  private var buffer: Data
  private var framing: MediaProxyHTTPBodyFraming
  private var cancelled = false
  private var reachedEOF = false
  private var chunkedDecoder = MediaProxyChunkedBodyDecoder()

  init(
    connection: NWConnection,
    initialData: Data,
    framing: MediaProxyHTTPBodyFraming
  ) {
    self.connection = connection
    buffer = initialData
    self.framing = framing
  }

  func nextChunk() async throws -> Data? {
    while true {
      try Task.checkCancellation()
      if let result = try takeBufferedChunk() { return result }
      if isFinished { return nil }
      if hasReachedEOF {
        try validateEndOfStream()
        return nil
      }
      let received = try await receiveMore()
      lock.lock()
      if let data = received.data { buffer.append(data) }
      if received.isComplete { reachedEOF = true }
      lock.unlock()
    }
  }

  func cancel() {
    lock.lock()
    let wasCancelled = cancelled
    cancelled = true
    buffer.removeAll(keepingCapacity: false)
    lock.unlock()
    if !wasCancelled { connection.cancel() }
  }

  private var isFinished: Bool {
    lock.lock()
    defer { lock.unlock() }
    switch framing {
    case .none: return true
    case let .contentLength(remaining): return remaining == 0
    case .untilEOF: return reachedEOF && buffer.isEmpty
    case .chunked: return chunkedDecoder.isComplete
    }
  }

  private var hasReachedEOF: Bool {
    lock.lock()
    defer { lock.unlock() }
    return reachedEOF
  }

  private func validateEndOfStream() throws {
    lock.lock()
    defer { lock.unlock() }
    switch framing {
    case .none, .untilEOF:
      return
    case let .contentLength(remaining):
      guard remaining == 0 else { throw MediaProxyUpstreamError.truncatedBody }
    case .chunked:
      try chunkedDecoder.validateEndOfStream()
    }
  }

  private func takeBufferedChunk() throws -> Data? {
    lock.lock()
    defer { lock.unlock() }
    guard !cancelled else { throw MediaProxyUpstreamError.cancelled }
    switch framing {
    case .none:
      buffer.removeAll(keepingCapacity: false)
      return nil
    case let .contentLength(remaining):
      guard remaining > 0 else {
        guard buffer.isEmpty else { throw MediaProxyUpstreamError.invalidResponse }
        return nil
      }
      guard !buffer.isEmpty else { return nil }
      let count = min(buffer.count, Int(min(remaining, Int64(Self.maximumReceiveBytes))))
      let chunk = Data(buffer.prefix(count))
      buffer.removeFirst(count)
      framing = .contentLength(remaining - Int64(count))
      if case .contentLength(0) = framing, !buffer.isEmpty {
        throw MediaProxyUpstreamError.invalidResponse
      }
      return chunk
    case .untilEOF:
      guard !buffer.isEmpty else { return nil }
      let count = min(buffer.count, Self.maximumReceiveBytes)
      let chunk = Data(buffer.prefix(count))
      buffer.removeFirst(count)
      return chunk
    case .chunked:
      let chunk = try chunkedDecoder.takeChunk(from: &buffer)
      if chunkedDecoder.isComplete { connection.cancel() }
      return chunk
    }
  }

  private func receiveMore() async throws -> (data: Data?, isComplete: Bool) {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        // Le tuple doit porter les memes etiquettes que le type de retour de la
        // fonction, sinon la continuation ne correspond pas a celle attendue.
        let gate = MediaProxyContinuationGate<(data: Data?, isComplete: Bool)>(continuation)
        connection.receive(
          minimumIncompleteLength: 1,
          maximumLength: Self.maximumReceiveBytes
        ) { data, _, isComplete, error in
          if error != nil {
            gate.resume(throwing: MediaProxyUpstreamError.connectionFailed)
          } else {
            gate.resume(returning: (data, isComplete))
          }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(
          deadline: .now() + Self.readTimeout
        ) { [weak self] in
          if gate.resume(throwing: MediaProxyUpstreamError.timedOut) {
            self?.connection.cancel()
          }
        }
      }
    } onCancel: {
      self.cancel()
    }
  }
}

private final class MediaProxyContinuationGate<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?

  init(_ continuation: CheckedContinuation<Value, Error>) {
    self.continuation = continuation
  }

  @discardableResult
  func resume(returning value: Value) -> Bool {
    guard let continuation = take() else { return false }
    continuation.resume(returning: value)
    return true
  }

  @discardableResult
  func resume(throwing error: Error) -> Bool {
    guard let continuation = take() else { return false }
    continuation.resume(throwing: error)
    return true
  }

  private func take() -> CheckedContinuation<Value, Error>? {
    lock.lock()
    defer { lock.unlock() }
    defer { continuation = nil }
    return continuation
  }
}

private enum MediaProxyHTTPToken {
  static func isNameByte(_ byte: UInt8) -> Bool {
    (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || [33, 35, 36, 37, 38, 39, 42, 43, 45, 46, 94, 95, 96, 124, 126].contains(byte)
  }

  static func isHexDigit(_ byte: UInt8) -> Bool {
    (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 70)
      || (byte >= 97 && byte <= 102)
  }
}
