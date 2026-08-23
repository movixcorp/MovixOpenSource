import Foundation
import Network

enum MediaProxyLoopbackState: Sendable {
  case ready
  case failed
  case cancelled
}

protocol MediaProxyLoopbackConnection: AnyObject, Sendable {
  var endpoint: NWEndpoint { get }
  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)? { get set }
  func start(on queue: DispatchQueue)
  func cancel()
  func receive(
    maximumLength: Int,
    completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
  )
  func send(
    content: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    completion: @escaping @Sendable (Error?) -> Void
  )
}

protocol MediaProxyLoopbackListener: AnyObject, Sendable {
  var port: NWEndpoint.Port? { get }
  var newConnectionHandler: ((MediaProxyLoopbackConnection) -> Void)? { get set }
  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)? { get set }
  func start(on queue: DispatchQueue)
  func cancel()
}

struct MediaProxyServerTiming: Sendable {
  static let production = MediaProxyServerTiming(
    listenerStartTimeout: 10,
    requestTimeout: 10,
    sendTimeout: 15
  )

  let listenerStartTimeout: TimeInterval
  let requestTimeout: TimeInterval
  let sendTimeout: TimeInterval

  init(
    listenerStartTimeout: TimeInterval,
    requestTimeout: TimeInterval,
    sendTimeout: TimeInterval
  ) {
    self.listenerStartTimeout = Self.normalized(listenerStartTimeout, fallback: 10)
    self.requestTimeout = Self.normalized(requestTimeout, fallback: 10)
    self.sendTimeout = Self.normalized(sendTimeout, fallback: 15)
  }

  private static func normalized(_ value: TimeInterval, fallback: TimeInterval) -> TimeInterval {
    value.isFinite && value > 0 ? value : fallback
  }
}

private final class MediaProxyNWLoopbackConnection: MediaProxyLoopbackConnection,
  @unchecked Sendable {
  private let raw: NWConnection
  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)?

  init(_ raw: NWConnection) { self.raw = raw }
  var endpoint: NWEndpoint { raw.endpoint }

  func start(on queue: DispatchQueue) {
    raw.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: self?.stateUpdateHandler?(.ready)
      case .failed: self?.stateUpdateHandler?(.failed)
      case .cancelled: self?.stateUpdateHandler?(.cancelled)
      default: break
      }
    }
    raw.start(queue: queue)
  }

  func cancel() { raw.cancel() }

  func receive(
    maximumLength: Int,
    completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
  ) {
    raw.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) {
      data, _, isComplete, error in
      completion(data, isComplete, error)
    }
  }

  func send(
    content: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    completion: @escaping @Sendable (Error?) -> Void
  ) {
    raw.send(
      content: content,
      contentContext: context,
      isComplete: isComplete,
      completion: .contentProcessed { error in completion(error) }
    )
  }
}

final class MediaProxyNWLoopbackListener: MediaProxyLoopbackListener,
  @unchecked Sendable {
  private let raw: NWListener
  var newConnectionHandler: ((MediaProxyLoopbackConnection) -> Void)?
  var stateUpdateHandler: ((MediaProxyLoopbackState) -> Void)?

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(
      host: NWEndpoint.Host("127.0.0.1"),
      port: .any
    )
    raw = try NWListener(using: parameters, on: .any)
  }

  var port: NWEndpoint.Port? { raw.port }

  func start(on queue: DispatchQueue) {
    raw.newConnectionHandler = { [weak self] connection in
      self?.newConnectionHandler?(MediaProxyNWLoopbackConnection(connection))
    }
    raw.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: self?.stateUpdateHandler?(.ready)
      case .failed: self?.stateUpdateHandler?(.failed)
      case .cancelled: self?.stateUpdateHandler?(.cancelled)
      default: break
      }
    }
    raw.start(queue: queue)
  }

  func cancel() { raw.cancel() }
}

enum MediaProxyServerError: Error, Equatable {
  case listenerUnavailable
  case invalidRequest
  case accessExpired
  case responseTooLarge
  case invalidUpstreamBody
  case sessionUnavailable
  case disconnected
}

final class MediaProxyServer: @unchecked Sendable {
  static let shared = MediaProxyServer()

  private static let maximumPlaylistBytes = 2 * 1_024 * 1_024
  private static let maximumSubtitleBytes = 4 * 1_024 * 1_024
  private static let maximumPlaylistReferences = 2_048
  private static let maximumConcurrentClients = 64
  private static let localHost = NWEndpoint.Host("127.0.0.1")

  private let store: MediaProxySessionStore
  private let upstream: MediaProxyUpstream
  private let makeListener: @Sendable () throws -> MediaProxyLoopbackListener
  private let timing: MediaProxyServerTiming
  private let monotonicNow: @Sendable () -> TimeInterval
  private let queue = DispatchQueue(label: "com.movix.media-proxy.loopback")
  private let lock = NSLock()
  private var listener: MediaProxyLoopbackListener?
  private var listeningPort: NWEndpoint.Port?
  private var listenerGeneration: UInt64 = 0
  private var listenerWaiters: [MediaProxyListenerWaiter] = []
  private var closeOperations = 0
  private var activeRegistrations = 0
  private var registrationDrainWaiters: [CheckedContinuation<Void, Never>] = []
  private var clients: [ObjectIdentifier: MediaProxyClientConnection] = [:]

  init(
    store: MediaProxySessionStore = MediaProxySessionStore(),
    upstream: MediaProxyUpstream = MediaProxyUpstream(),
    makeListener: @escaping @Sendable () throws -> MediaProxyLoopbackListener = {
      try MediaProxyNWLoopbackListener()
    },
    timing: MediaProxyServerTiming = .production,
    monotonicNow: @escaping @Sendable () -> TimeInterval = {
      ProcessInfo.processInfo.systemUptime
    }
  ) {
    self.store = store
    self.upstream = upstream
    self.makeListener = makeListener
    self.timing = timing
    self.monotonicNow = monotonicNow
  }

  func open(target: MediaProxyTarget) async throws -> URL {
    let endpoint = try await ensureListener()
    guard beginRegistration(for: endpoint) else {
      throw MediaProxyServerError.listenerUnavailable
    }
    defer { endRegistration() }
    let registration = try await store.registerLoopback(target)
    guard isLive(endpoint) else { throw MediaProxyServerError.listenerUnavailable }
    return try localURL(for: registration, port: endpoint.port)
  }

  func resolveForCast(_ localURL: URL) async -> MediaProxyTarget? {
    guard let port = currentPort(),
          let components = URLComponents(url: localURL, resolvingAgainstBaseURL: false),
          components.scheme == "http",
          components.host == "127.0.0.1",
          components.port == Int(port.rawValue),
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil else {
      return nil
    }
    return await store.resolveLoopbackURLForCast(localURL)
  }

  /// Proves that a canonical loopback URL belongs to this live server and
  /// retains its revocable access lease for the native playback handoff.
  /// Releasing this lease never closes or invalidates the shared proxy.
  func retainForNativePlayback(_ localURL: URL) async -> MediaProxyAccessLease? {
    guard let port = currentPort(),
          let components = URLComponents(url: localURL, resolvingAgainstBaseURL: false),
          components.scheme == "http",
          components.host == "127.0.0.1",
          components.port == Int(port.rawValue),
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          !components.percentEncodedPath.contains("%"),
          let route = Self.parseRoute(components.percentEncodedPath) else {
      return nil
    }
    let canonicalURL = "http://127.0.0.1:\(port.rawValue)\(components.percentEncodedPath)"
    guard localURL.absoluteString == canonicalURL else { return nil }

    var resolution = await resolveAfterDueRotations(route)
    for _ in 0..<8 {
      guard let current = resolution else { return nil }
      switch current {
      case let .resource(leased):
        return leased.lease
      case let .redirect(registration):
        resolution = await store.resolveLoopbackRequestWithLease(
          processSecret: route.processSecret,
          sessionID: registration.sessionID,
          resourceID: registration.resourceID
        )
      }
    }
    return nil
  }

  func close() async {
    let snapshot = lock.withLock { () -> (
      MediaProxyLoopbackListener?,
      [MediaProxyClientConnection],
      [MediaProxyListenerWaiter]
    ) in
      closeOperations += 1
      listenerGeneration &+= 1
      let listener = self.listener
      let clients = Array(self.clients.values)
      let waiters = listenerWaiters
      self.listener = nil
      listeningPort = nil
      self.clients.removeAll()
      listenerWaiters.removeAll()
      return (listener, clients, waiters)
    }
    snapshot.0?.cancel()
    for client in snapshot.1 { client.cancel() }
    for waiter in snapshot.2 {
      waiter.gate.resume(throwing: MediaProxyServerError.listenerUnavailable)
    }
    await waitForRegistrationsToDrain()
    await store.invalidateAll()
    lock.withLock { closeOperations -= 1 }
  }

  private func ensureListener() async throws -> MediaProxyListenerEndpoint {
    let waiterID = UUID()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = MediaProxyServerContinuationGate<MediaProxyListenerEndpoint>(continuation)
        var listenerToStart: MediaProxyLoopbackListener?
        var generation: UInt64 = 0
        do {
          try lock.withLock {
            guard closeOperations == 0 else {
              throw MediaProxyServerError.listenerUnavailable
            }
            if let listener = listener, let listeningPort = listeningPort {
              gate.resume(returning: MediaProxyListenerEndpoint(
                port: listeningPort,
                generation: listenerGeneration
              ))
              _ = listener
              return
            }
            if listener == nil {
              listenerGeneration &+= 1
              let created = try makeListener()
              listener = created
              listenerToStart = created
            }
            generation = listenerGeneration
            listenerWaiters.append(MediaProxyListenerWaiter(
              id: waiterID,
              generation: generation,
              gate: gate
            ))
          }
        } catch {
          gate.resume(throwing: MediaProxyServerError.listenerUnavailable)
          return
        }
        if Task.isCancelled {
          cancelListenerWaiter(waiterID)
          if listenerToStart == nil { return }
        }
        guard let listenerToStart = listenerToStart else { return }
        listenerToStart.newConnectionHandler = { [weak self] connection in
          self?.accept(connection)
        }
        listenerToStart.stateUpdateHandler = { [weak self, weak listenerToStart] state in
          guard let self = self, let listenerToStart = listenerToStart else { return }
          switch state {
          case .ready:
            self.listenerBecameReady(listenerToStart, generation: generation)
          case .failed, .cancelled:
            self.failListener(listenerToStart, generation: generation)
          }
        }
        let started = lock.withLock { () -> Bool in
          guard listener === listenerToStart,
                listenerGeneration == generation,
                closeOperations == 0 else { return false }
          listenerToStart.start(on: queue)
          return true
        }
        guard started else {
          listenerToStart.cancel()
          return
        }
        queue.asyncAfter(deadline: .now() + timing.listenerStartTimeout) { [weak self, weak listenerToStart] in
          guard let self = self, let listenerToStart = listenerToStart else { return }
          self.listenerStartTimedOut(listenerToStart, generation: generation)
        }
      }
    } onCancel: {
      self.cancelListenerWaiter(waiterID)
    }
  }

  private func listenerBecameReady(
    _ readyListener: MediaProxyLoopbackListener,
    generation: UInt64
  ) {
    guard let port = readyListener.port else {
      failListener(readyListener, generation: generation)
      return
    }
    let waiters = lock.withLock { () -> [MediaProxyListenerWaiter] in
      guard listener === readyListener,
            listenerGeneration == generation,
            closeOperations == 0 else { return [] }
      listeningPort = port
      let matching = listenerWaiters.filter { $0.generation == generation }
      listenerWaiters.removeAll { $0.generation == generation }
      return matching
    }
    let endpoint = MediaProxyListenerEndpoint(port: port, generation: generation)
    for waiter in waiters { waiter.gate.resume(returning: endpoint) }
  }

  private func failListener(
    _ failedListener: MediaProxyLoopbackListener,
    generation: UInt64
  ) {
    let snapshot = lock.withLock { () -> (
      [MediaProxyListenerWaiter],
      [MediaProxyClientConnection]
    ) in
      guard listener === failedListener, listenerGeneration == generation else {
        return ([], [])
      }
      listener = nil
      listeningPort = nil
      let matching = listenerWaiters.filter { $0.generation == generation }
      listenerWaiters.removeAll { $0.generation == generation }
      let activeClients = Array(clients.values)
      clients.removeAll()
      return (matching, activeClients)
    }
    failedListener.cancel()
    for client in snapshot.1 { client.cancel() }
    for waiter in snapshot.0 {
      waiter.gate.resume(throwing: MediaProxyServerError.listenerUnavailable)
    }
  }

  private func listenerStartTimedOut(
    _ timedOutListener: MediaProxyLoopbackListener,
    generation: UInt64
  ) {
    let isStillStarting = lock.withLock {
      listener === timedOutListener
        && listenerGeneration == generation
        && listeningPort == nil
    }
    if isStillStarting { failListener(timedOutListener, generation: generation) }
  }

  private func cancelListenerWaiter(_ id: UUID) {
    let waiter = lock.withLock { () -> MediaProxyListenerWaiter? in
      guard let index = listenerWaiters.firstIndex(where: { $0.id == id }) else { return nil }
      return listenerWaiters.remove(at: index)
    }
    waiter?.gate.resume(throwing: CancellationError())
  }

  private func accept(_ connection: MediaProxyLoopbackConnection) {
    guard Self.isLiteralIPv4Loopback(connection.endpoint) else {
      connection.cancel()
      return
    }
    let acceptedAt = monotonicNow()
    let client = MediaProxyClientConnection(
      connection: connection,
      owner: self,
      requestDeadline: acceptedAt + timing.requestTimeout
    )
    let accepted = lock.withLock { () -> Bool in
      guard listener != nil,
             listeningPort != nil,
            closeOperations == 0,
            clients.count < Self.maximumConcurrentClients else { return false }
      clients[ObjectIdentifier(client)] = client
      return true
    }
    guard accepted else {
      connection.cancel()
      return
    }
    client.start(
      on: queue,
      requestTimeout: max(0, client.requestDeadline - monotonicNow())
    )
  }

  fileprivate func handle(_ client: MediaProxyClientConnection) async {
    defer { client.finish() }
    let localRequest: MediaProxyLocalRequest
    do {
      let data = try await receiveRequest(from: client)
      client.markRequestReadFinished()
      localRequest = try MediaProxyHTTPParser.parse(data)
    } catch let error as MediaProxyHTTPParserError {
      let status = error == .requestTooLarge ? 431 : 400
      await sendLocalError(status, headOnly: client.isHeadRequest, to: client)
      return
    } catch {
      await sendLocalError(400, headOnly: client.isHeadRequest, to: client)
      return
    }

    guard let port = currentPort(),
          localRequest.headers["host"] == "127.0.0.1:\(port.rawValue)",
          let route = Self.parseRoute(localRequest.path) else {
      await sendLocalError(404, headOnly: localRequest.method == "HEAD", to: client)
      return
    }

    guard let resolution = await resolveAfterDueRotations(route) else {
      await sendLocalError(404, headOnly: localRequest.method == "HEAD", to: client)
      return
    }
    switch resolution {
    case let .redirect(registration):
      guard let location = try? localURL(for: registration, port: port) else {
        await sendLocalError(404, headOnly: localRequest.method == "HEAD", to: client)
        return
      }
      await sendLocalRedirect(location, to: client)
    case let .resource(leasedResource):
      await serve(
        leasedResource,
        route: route,
        request: localRequest,
        port: port,
        client: client
      )
    }
  }

  fileprivate func remove(_ client: MediaProxyClientConnection) {
    lock.withLock { clients.removeValue(forKey: ObjectIdentifier(client)) }
  }

  private func beginRegistration(for endpoint: MediaProxyListenerEndpoint) -> Bool {
    lock.withLock {
      guard closeOperations == 0,
            listener != nil,
            listenerGeneration == endpoint.generation,
            listeningPort == endpoint.port else { return false }
      activeRegistrations += 1
      return true
    }
  }

  private func endRegistration() {
    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      activeRegistrations = max(0, activeRegistrations - 1)
      guard activeRegistrations == 0 else { return [] }
      defer { registrationDrainWaiters.removeAll() }
      return registrationDrainWaiters
    }
    for waiter in waiters { waiter.resume() }
  }

  private func waitForRegistrationsToDrain() async {
    await withCheckedContinuation { continuation in
      let alreadyDrained = lock.withLock { () -> Bool in
        guard activeRegistrations > 0 else { return true }
        registrationDrainWaiters.append(continuation)
        return false
      }
      if alreadyDrained { continuation.resume() }
    }
  }

  private func isLive(_ endpoint: MediaProxyListenerEndpoint) -> Bool {
    lock.withLock {
      closeOperations == 0
        && listener != nil
        && listenerGeneration == endpoint.generation
        && listeningPort == endpoint.port
    }
  }

  private func resolveAfterDueRotations(
    _ route: MediaProxyRoute
  ) async -> MediaProxyLeasedResolution? {
    var candidateSessionID = route.sessionID
    for _ in 0..<8 {
      do {
        _ = try await store.rotate(sessionID: candidateSessionID)
      } catch MediaProxySessionStoreError.rotationNotDue {
        // The generation is still safely outside its pre-expiry lead window.
      } catch MediaProxySessionStoreError.sessionUnavailable {
        // It may already be a redirect-only generation; resolve it below.
      } catch {
        return nil
      }
      guard let resolution = await store.resolveLoopbackRequestWithLease(
        processSecret: route.processSecret,
        sessionID: route.sessionID,
        resourceID: route.resourceID
      ) else { return nil }
      switch resolution {
      case .resource:
        return resolution
      case let .redirect(registration):
        do {
          _ = try await store.rotate(sessionID: registration.sessionID)
          candidateSessionID = registration.sessionID
          continue
        } catch MediaProxySessionStoreError.rotationNotDue {
          return .redirect(registration)
        } catch MediaProxySessionStoreError.sessionUnavailable {
          candidateSessionID = registration.sessionID
          continue
        } catch {
          return .redirect(registration)
        }
      }
    }
    return await store.resolveLoopbackRequestWithLease(
      processSecret: route.processSecret,
      sessionID: route.sessionID,
      resourceID: route.resourceID
    )
  }

  private func serve(
    _ leasedResource: MediaProxyLeasedResource,
    route: MediaProxyRoute,
    request: MediaProxyLocalRequest,
    port: NWEndpoint.Port,
    client: MediaProxyClientConnection
  ) async {
    let lease = leasedResource.lease
    var responseBody: MediaProxyUpstreamBody?
    defer {
      responseBody?.cancel()
      client.setUpstreamBody(nil)
      lease.release()
    }
    do {
      let effectiveTarget = MediaProxyTarget(
        upstreamURL: leasedResource.resource.target.upstreamURL,
        method: request.method,
        headers: leasedResource.resource.target.headers
      )
      let upstreamResponse = try await upstream.open(
        target: effectiveTarget,
        localHeaders: request.headers
      )
      responseBody = upstreamResponse.body
      client.setUpstreamBody(upstreamResponse.body)

      if request.method == "HEAD" {
        upstreamResponse.body.cancel()
        try await sendResponseHead(
          statusCode: upstreamResponse.statusCode,
          headers: Self.allowedResponseHeaders(upstreamResponse.headers),
          isFinal: true,
          lease: lease,
          client: client
        )
        return
      }

      if upstreamResponse.statusCode == 200,
         Self.isSubRip(upstreamResponse.finalURL, headers: upstreamResponse.headers) {
        guard Self.header(named: "content-encoding", in: upstreamResponse.headers)
          .map({ $0.caseInsensitiveCompare("identity") == .orderedSame }) ?? true else {
          throw MediaProxyServerError.invalidUpstreamBody
        }
        let sourceData = try await readBounded(
          upstreamResponse.body,
          maximumBytes: Self.maximumSubtitleBytes
        )
        guard let source = String(data: sourceData, encoding: .utf8),
              let converted = HLSPlaylistRewriter.convertSubRipToWebVTT(source) else {
          throw MediaProxyServerError.invalidUpstreamBody
        }
        let output = Data(converted.utf8)
        var headers = Self.allowedResponseHeaders(upstreamResponse.headers)
        Self.removeRepresentationHeaders(&headers)
        headers["Content-Type"] = "text/vtt; charset=utf-8"
        headers["Content-Length"] = String(output.count)
        try await sendBufferedResponse(
          statusCode: 200,
          headers: headers,
          body: output,
          lease: lease,
          client: client
        )
        return
      }

      if upstreamResponse.statusCode == 200,
         Self.isHLS(upstreamResponse.finalURL, headers: upstreamResponse.headers) {
        guard Self.header(named: "content-encoding", in: upstreamResponse.headers)
          .map({ $0.caseInsensitiveCompare("identity") == .orderedSame }) ?? true else {
          throw MediaProxyServerError.invalidUpstreamBody
        }
        let sourceData = try await readBounded(
          upstreamResponse.body,
          maximumBytes: Self.maximumPlaylistBytes
        )
        guard let source = String(data: sourceData, encoding: .utf8) else {
          throw MediaProxyServerError.invalidUpstreamBody
        }
        let rewritten = try await rewritePlaylist(
          source,
          baseURL: upstreamResponse.finalURL,
          parent: leasedResource.resource,
          route: route,
          port: port
        )
        let output = Data(rewritten.utf8)
        var headers = Self.allowedResponseHeaders(upstreamResponse.headers)
        Self.removeRepresentationHeaders(&headers)
        headers["Content-Type"] = "application/vnd.apple.mpegurl"
        headers["Content-Length"] = String(output.count)
        try await sendBufferedResponse(
          statusCode: upstreamResponse.statusCode,
          headers: headers,
          body: output,
          lease: lease,
          client: client
        )
        return
      }

      try await sendStreamingResponse(
        upstreamResponse,
        lease: lease,
        client: client
      )
    } catch is CancellationError {
      client.cancel()
    } catch MediaProxyServerError.accessExpired {
      client.cancel()
    } catch {
      guard !client.isDisconnected else { return }
      guard !client.hasStartedResponse else {
        client.cancel()
        return
      }
      await sendLeasedError(
        502,
        headOnly: request.method == "HEAD",
        lease: lease,
        client: client
      )
    }
  }

  private func rewritePlaylist(
    _ source: String,
    baseURL: URL,
    parent: MediaProxyResource,
    route: MediaProxyRoute,
    port: NWEndpoint.Port
  ) async throws -> String {
    var references: [URL] = []
    var seen: Set<String> = []
    _ = try HLSPlaylistRewriter.rewrite(
      source,
      baseURL: baseURL,
      wrapDirectSubtitles: true
    ) { url in
      if seen.insert(url.absoluteString).inserted {
        guard references.count < Self.maximumPlaylistReferences else {
          throw MediaProxyServerError.responseTooLarge
        }
        references.append(url)
      }
      return "http://127.0.0.1:1/r/\(references.count)"
    }

    var localized: [String: String] = [:]
    var headers = parent.target.headers
    for name in ["Range", "If-Modified-Since", "If-None-Match"] {
      headers.removeValue(forKey: name)
    }
    for reference in references {
      let target = MediaProxyTarget(
        upstreamURL: reference,
        method: "GET",
        headers: headers
      )
      let registration = try await localizeFollowingSuccessor(
        target,
        parent: parent,
        route: route
      )
      localized[reference.absoluteString] = try localURL(
        for: registration,
        port: port
      ).absoluteString
    }
    return try HLSPlaylistRewriter.rewrite(
      source,
      baseURL: baseURL,
      wrapDirectSubtitles: true
    ) { url in
      guard let value = localized[url.absoluteString] else {
        throw MediaProxyServerError.sessionUnavailable
      }
      return value
    }
  }

  private func localizeFollowingSuccessor(
    _ target: MediaProxyTarget,
    parent: MediaProxyResource,
    route: MediaProxyRoute
  ) async throws -> MediaProxyRegistration {
    var sessionID = parent.sessionID
    for _ in 0..<8 {
      do {
        return try await store.localize(sessionID: sessionID, target: target)
      } catch MediaProxySessionStoreError.sessionUnavailable {
        guard let resolution = await store.resolveLoopbackRequestWithLease(
          processSecret: route.processSecret,
          sessionID: route.sessionID,
          resourceID: route.resourceID
        ) else { throw MediaProxyServerError.sessionUnavailable }
        switch resolution {
        case let .redirect(registration):
          sessionID = registration.sessionID
        case let .resource(leased):
          sessionID = leased.resource.sessionID
          leased.lease.release()
        }
      }
    }
    throw MediaProxyServerError.sessionUnavailable
  }

  private func sendStreamingResponse(
    _ response: MediaProxyUpstreamResponse,
    lease: MediaProxyAccessLease,
    client: MediaProxyClientConnection
  ) async throws {
    try await sendResponseHead(
      statusCode: response.statusCode,
      headers: Self.allowedResponseHeaders(response.headers),
      isFinal: false,
      lease: lease,
      client: client
    )
    while let chunk = try await response.body.nextChunk() {
      guard !chunk.isEmpty else { continue }
      try await sendLeased(
        chunk,
        context: .defaultStream,
        isComplete: false,
        lease: lease,
        client: client
      )
    }
    try await sendLeased(
      nil,
      context: .finalMessage,
      isComplete: true,
      lease: lease,
      client: client
    )
  }

  private func sendBufferedResponse(
    statusCode: Int,
    headers: [String: String],
    body: Data,
    lease: MediaProxyAccessLease,
    client: MediaProxyClientConnection
  ) async throws {
    try await sendResponseHead(
      statusCode: statusCode,
      headers: headers,
      isFinal: body.isEmpty,
      lease: lease,
      client: client
    )
    if !body.isEmpty {
      try await sendLeased(
        body,
        context: .finalMessage,
        isComplete: true,
        lease: lease,
        client: client
      )
    }
  }

  private func sendResponseHead(
    statusCode: Int,
    headers: [String: String],
    isFinal: Bool,
    lease: MediaProxyAccessLease,
    client: MediaProxyClientConnection
  ) async throws {
    let data = Self.serializeResponseHead(statusCode: statusCode, headers: headers)
    client.markResponseStarted()
    try await sendLeased(
      data,
      context: isFinal ? .finalMessage : .defaultStream,
      isComplete: isFinal,
      lease: lease,
      client: client
    )
  }

  private func sendLeased(
    _ data: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    lease: MediaProxyAccessLease,
    client: MediaProxyClientConnection
  ) async throws {
    try Task.checkCancellation()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = MediaProxyServerContinuationGate<Void>(continuation)
        let enqueued = lease.withValidAccess {
          client.connection.send(
            content: data,
            context: context,
            isComplete: isComplete
          ) { error in
            if error == nil {
              gate.resume(returning: ())
            } else {
              gate.resume(throwing: MediaProxyServerError.disconnected)
            }
          }
          return true
        }
        guard enqueued == true else {
          gate.resume(throwing: MediaProxyServerError.accessExpired)
          client.cancel()
          return
        }
        queue.asyncAfter(deadline: .now() + timing.sendTimeout) {
          if gate.resume(throwing: MediaProxyServerError.disconnected) {
            client.cancel()
          }
        }
      }
    } onCancel: {
      client.cancel()
    }
  }

  private func receiveRequest(from client: MediaProxyClientConnection) async throws -> Data {
    var request = Data()
    let requestDeadline = client.requestDeadline
    while request.range(of: Data([13, 10, 13, 10])) == nil {
      let chunk = try await receive(
        from: client,
        maximumLength: min(8 * 1_024, MediaProxyHTTPParser.maximumRequestBytes + 1 - request.count),
        requestDeadline: requestDeadline
      )
      guard let data = chunk.data, !data.isEmpty else {
        throw MediaProxyServerError.invalidRequest
      }
      request.append(data)
      client.observeRequestPrefix(request)
      guard request.count <= MediaProxyHTTPParser.maximumRequestBytes else {
        throw MediaProxyHTTPParserError.requestTooLarge
      }
      if chunk.isComplete,
         request.range(of: Data([13, 10, 13, 10])) == nil {
        throw MediaProxyHTTPParserError.incompleteRequest
      }
    }
    return request
  }

  private func receive(
    from client: MediaProxyClientConnection,
    maximumLength: Int,
    requestDeadline: TimeInterval
  ) async throws -> (data: Data?, isComplete: Bool) {
    guard maximumLength > 0 else { throw MediaProxyHTTPParserError.requestTooLarge }
    let remaining = requestDeadline - monotonicNow()
    guard remaining > 0 else {
      client.cancel()
      throw MediaProxyServerError.invalidRequest
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        // Meme contrainte d'etiquettes que dans MediaProxyUpstream.receiveMore.
        let gate = MediaProxyServerContinuationGate<(data: Data?, isComplete: Bool)>(continuation)
        client.connection.receive(maximumLength: maximumLength) { data, isComplete, error in
          if error == nil {
            gate.resume(returning: (data, isComplete))
          } else {
            gate.resume(throwing: MediaProxyServerError.disconnected)
          }
        }
        queue.asyncAfter(deadline: .now() + remaining) {
          if gate.resume(throwing: MediaProxyServerError.invalidRequest) {
            client.cancel()
          }
        }
      }
    } onCancel: {
      client.cancel()
    }
  }

  private func readBounded(
    _ body: MediaProxyUpstreamBody,
    maximumBytes: Int
  ) async throws -> Data {
    var output = Data()
    while let chunk = try await body.nextChunk() {
      guard chunk.count <= maximumBytes - output.count else {
        throw MediaProxyServerError.responseTooLarge
      }
      output.append(chunk)
    }
    return output
  }

  private func sendLocalRedirect(_ location: URL, to client: MediaProxyClientConnection) async {
    let response = Data((
      "HTTP/1.1 307 Temporary Redirect\r\n"
        + "Location: \(location.absoluteString)\r\n"
        + "Content-Length: 0\r\n"
        + "Cache-Control: no-store\r\n"
        + "Connection: close\r\n\r\n"
    ).utf8)
    await sendLocal(response, to: client)
  }

  private func sendLocalError(
    _ statusCode: Int,
    headOnly: Bool,
    to client: MediaProxyClientConnection
  ) async {
    let body = Data("Media proxy error\n".utf8)
    var response = Self.serializeResponseHead(
      statusCode: statusCode,
      headers: [
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(body.count),
        "Cache-Control": "no-store",
      ]
    )
    if !headOnly { response.append(body) }
    await sendLocal(response, to: client)
  }

  private func sendLeasedError(
    _ statusCode: Int,
    headOnly: Bool,
    lease: MediaProxyAccessLease,
    client: MediaProxyClientConnection
  ) async {
    let body = Data("Media proxy error\n".utf8)
    var response = Self.serializeResponseHead(
      statusCode: statusCode,
      headers: [
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(body.count),
        "Cache-Control": "no-store",
      ]
    )
    if !headOnly { response.append(body) }
    try? await sendLeased(
      response,
      context: .finalMessage,
      isComplete: true,
      lease: lease,
      client: client
    )
  }

  private func sendLocal(_ data: Data, to client: MediaProxyClientConnection) async {
    try? await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = MediaProxyServerContinuationGate<Void>(continuation)
        client.connection.send(
          content: data,
          context: .finalMessage,
          isComplete: true
        ) { error in
          if error == nil {
            gate.resume(returning: ())
          } else {
            gate.resume(throwing: MediaProxyServerError.disconnected)
          }
        }
        queue.asyncAfter(deadline: .now() + timing.sendTimeout) {
          if gate.resume(throwing: MediaProxyServerError.disconnected) {
            client.cancel()
          }
        }
      }
    } onCancel: {
      client.cancel()
    }
  }

  private func localURL(
    for registration: MediaProxyRegistration,
    port: NWEndpoint.Port
  ) throws -> URL {
    let raw = "http://127.0.0.1:\(port.rawValue)/p/\(store.processSecret)/\(registration.sessionID)/\(registration.resourceID)"
    guard let url = URL(string: raw) else { throw MediaProxyServerError.listenerUnavailable }
    return url
  }

  private func currentPort() -> NWEndpoint.Port? {
    lock.withLock { closeOperations == 0 ? listeningPort : nil }
  }

  private static func parseRoute(_ path: String) -> MediaProxyRoute? {
    guard !path.contains("%"), !path.contains("?"), !path.contains("#") else { return nil }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 5,
          segments[0].isEmpty,
          segments[1] == "p" else { return nil }
    let processSecret = String(segments[2])
    let sessionID = String(segments[3])
    let resourceID = String(segments[4])
    guard [processSecret, sessionID, resourceID].allSatisfy(isToken) else { return nil }
    return MediaProxyRoute(
      processSecret: processSecret,
      sessionID: sessionID,
      resourceID: resourceID
    )
  }

  private static func isToken(_ value: String) -> Bool {
    value.utf8.count == 43 && value.utf8.allSatisfy { byte in
      (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 45 || byte == 95
    }
  }

  private static func isLiteralIPv4Loopback(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host, _) = endpoint else { return false }
    return host == NWEndpoint.Host("127.0.0.1") && host == localHost
  }

  private static func isHLS(_ url: URL, headers: [String: String]) -> Bool {
    if url.path.lowercased().hasSuffix(".m3u8") { return true }
    let contentType = header(named: "content-type", in: headers)?.lowercased() ?? ""
    return contentType.contains("mpegurl") || contentType.contains("vnd.apple.mpegurl")
  }

  private static func isSubRip(_ url: URL, headers: [String: String]) -> Bool {
    if url.path.lowercased().hasSuffix(".srt") { return true }
    let contentType = header(named: "content-type", in: headers)?.lowercased() ?? ""
    return contentType.contains("subrip")
  }

  private static func allowedResponseHeaders(_ upstream: [String: String]) -> [String: String] {
    let allowed: [String: String] = [
      "accept-ranges": "Accept-Ranges",
      "cache-control": "Cache-Control",
      "content-disposition": "Content-Disposition",
      "content-encoding": "Content-Encoding",
      "content-language": "Content-Language",
      "content-length": "Content-Length",
      "content-range": "Content-Range",
      "content-type": "Content-Type",
      "etag": "ETag",
      "expires": "Expires",
      "last-modified": "Last-Modified",
    ]
    var output: [String: String] = [:]
    for (rawName, rawValue) in upstream {
      guard let name = allowed[rawName.lowercased()],
            rawValue.utf8.count <= MediaProxyPolicy.maximumHeaderValueLength,
            !rawValue.unicodeScalars.contains(where: {
              CharacterSet.controlCharacters.contains($0)
            }) else { continue }
      output[name] = rawValue
    }
    return output
  }

  private static func removeRepresentationHeaders(_ headers: inout [String: String]) {
    for name in ["Content-Encoding", "Content-Length", "Content-Range", "Accept-Ranges"] {
      headers.removeValue(forKey: name)
    }
  }

  private static func header(named name: String, in headers: [String: String]) -> String? {
    headers.first(where: { $0.key.caseInsensitiveCompare(name) == .orderedSame })?.value
  }

  private static func serializeResponseHead(
    statusCode: Int,
    headers: [String: String]
  ) -> Data {
    let safeStatus = (100...599).contains(statusCode) ? statusCode : 502
    var lines = ["HTTP/1.1 \(safeStatus) \(reasonPhrase(for: safeStatus))"]
    var sanitized = headers.filter { name, value in
      !name.contains("\r") && !name.contains("\n")
        && !value.contains("\r") && !value.contains("\n")
    }
    sanitized["Access-Control-Allow-Origin"] = "*"
    sanitized["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges, Content-Type"
    sanitized["X-Content-Type-Options"] = "nosniff"
    sanitized["Connection"] = "close"
    for name in sanitized.keys.sorted() {
      if let value = sanitized[name] { lines.append("\(name): \(value)") }
    }
    return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
  }

  private static func reasonPhrase(for statusCode: Int) -> String {
    switch statusCode {
    case 200: return "OK"
    case 206: return "Partial Content"
    case 204: return "No Content"
    case 304: return "Not Modified"
    case 307: return "Temporary Redirect"
    case 400: return "Bad Request"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 416: return "Range Not Satisfiable"
    case 431: return "Request Header Fields Too Large"
    case 502: return "Bad Gateway"
    case 504: return "Gateway Timeout"
    default: return "Response"
    }
  }
}

private struct MediaProxyListenerEndpoint {
  let port: NWEndpoint.Port
  let generation: UInt64
}

private struct MediaProxyListenerWaiter {
  let id: UUID
  let generation: UInt64
  let gate: MediaProxyServerContinuationGate<MediaProxyListenerEndpoint>
}

private struct MediaProxyRoute {
  let processSecret: String
  let sessionID: String
  let resourceID: String
}

private final class MediaProxyClientConnection: @unchecked Sendable {
  let connection: MediaProxyLoopbackConnection
  let requestDeadline: TimeInterval
  private weak var owner: MediaProxyServer?
  private let lock = NSLock()
  private var handlingTask: Task<Void, Never>?
  private var upstreamBody: MediaProxyUpstreamBody?
  private var disconnected = false
  private var finished = false
  private var responseStarted = false
  private var requestReadFinished = false
  private var headRequest = false
  private var methodObserved = false

  init(
    connection: MediaProxyLoopbackConnection,
    owner: MediaProxyServer,
    requestDeadline: TimeInterval
  ) {
    self.connection = connection
    self.owner = owner
    self.requestDeadline = requestDeadline
  }

  var isDisconnected: Bool { lock.withLock { disconnected } }
  var hasStartedResponse: Bool { lock.withLock { responseStarted } }
  var isHeadRequest: Bool { lock.withLock { headRequest } }

  func markResponseStarted() {
    lock.withLock { responseStarted = true }
  }

  func markRequestReadFinished() {
    lock.withLock { requestReadFinished = true }
  }

  func observeRequestPrefix(_ data: Data) {
    guard data.count >= 5 else { return }
    lock.withLock {
      guard !methodObserved else { return }
      methodObserved = true
      headRequest = data.starts(with: Data("HEAD ".utf8))
    }
  }

  func start(on queue: DispatchQueue, requestTimeout: TimeInterval) {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        self.beginHandling()
      case .failed, .cancelled:
        self.markDisconnected()
      default:
        break
      }
    }
    connection.start(on: queue)
    queue.asyncAfter(deadline: .now() + requestTimeout) { [weak self] in
      self?.expireIncompleteRequest()
    }
  }

  func setUpstreamBody(_ body: MediaProxyUpstreamBody?) {
    let shouldCancel = lock.withLock { () -> Bool in
      upstreamBody = body
      return disconnected
    }
    if shouldCancel { body?.cancel() }
  }

  func cancel() {
    markDisconnected()
    connection.cancel()
  }

  func finish() {
    let shouldFinish = lock.withLock { () -> Bool in
      guard !finished else { return false }
      finished = true
      return true
    }
    guard shouldFinish else { return }
    connection.cancel()
    owner?.remove(self)
  }

  private func beginHandling() {
    let task = lock.withLock { () -> Task<Void, Never>? in
      guard handlingTask == nil, !disconnected, let owner = owner else { return nil }
      let task = Task { await owner.handle(self) }
      handlingTask = task
      return task
    }
    if task == nil, isDisconnected { connection.cancel() }
  }

  private func markDisconnected() {
    let state = lock.withLock { () -> (Task<Void, Never>?, MediaProxyUpstreamBody?, Bool) in
      guard !disconnected else { return (nil, nil, false) }
      disconnected = true
      return (handlingTask, upstreamBody, true)
    }
    state.1?.cancel()
    state.0?.cancel()
    if state.2 { owner?.remove(self) }
  }

  private func expireIncompleteRequest() {
    let shouldCancel = lock.withLock { !requestReadFinished && !disconnected }
    if shouldCancel { cancel() }
  }
}

private final class MediaProxyServerContinuationGate<Value>: @unchecked Sendable {
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
    lock.withLock {
      defer { continuation = nil }
      return continuation
    }
  }
}

private extension NSLock {
  func withLock<Result>(_ body: () throws -> Result) rethrows -> Result {
    lock()
    defer { unlock() }
    return try body()
  }
}
