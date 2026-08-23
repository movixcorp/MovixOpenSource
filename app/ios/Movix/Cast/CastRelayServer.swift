import Foundation
import Network
import Security
import UIKit

enum CastRelayNetworkState: Sendable {
  case ready
  case failed
  case cancelled
}

protocol CastRelayConnection: AnyObject, Sendable {
  var endpoint: NWEndpoint { get }
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)? { get set }
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

protocol CastRelayListener: AnyObject, Sendable {
  var port: NWEndpoint.Port? { get }
  var newConnectionHandler: ((CastRelayConnection) -> Void)? { get set }
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)? { get set }
  func start(on queue: DispatchQueue)
  func cancel()
}

protocol CastRelayListenerFactory: AnyObject, Sendable {
  func makeListener(
    boundTo localAddress: MediaProxyIPAddress,
    port: NWEndpoint.Port
  ) throws -> CastRelayListener
}

protocol CastRelayPathMonitoring: AnyObject, Sendable {
  @discardableResult
  func start(_ handler: @escaping @Sendable (CastRouteSnapshot) -> Void) -> Bool
  func cancel()
}

extension CastNetworkPathMonitor: CastRelayPathMonitoring {}

protocol CastRelayUpstreamOpening: AnyObject, Sendable {
  func open(
    target: MediaProxyTarget,
    localHeaders: [String: String]
  ) async throws -> MediaProxyUpstreamResponse
}

extension MediaProxyUpstream: CastRelayUpstreamOpening {}

struct CastRelayServerTiming: Sendable {
  static let production = CastRelayServerTiming(
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

private final class CastRelayNWConnection: CastRelayConnection, @unchecked Sendable {
  private let raw: NWConnection
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)?

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

private final class CastRelayNWListener: CastRelayListener, @unchecked Sendable {
  private let raw: NWListener
  var newConnectionHandler: ((CastRelayConnection) -> Void)?
  var stateUpdateHandler: ((CastRelayNetworkState) -> Void)?

  init(_ raw: NWListener) { self.raw = raw }
  var port: NWEndpoint.Port? { raw.port }

  func start(on queue: DispatchQueue) {
    raw.newConnectionHandler = { [weak self] connection in
      self?.newConnectionHandler?(CastRelayNWConnection(connection))
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

final class CastRelayNWListenerFactory: CastRelayListenerFactory, @unchecked Sendable {
  func makeListener(
    boundTo localAddress: MediaProxyIPAddress,
    port: NWEndpoint.Port
  ) throws -> CastRelayListener {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(
      host: try Self.endpointHost(for: localAddress),
      port: port
    )
    return CastRelayNWListener(try NWListener(using: parameters, on: .any))
  }

  private static func endpointHost(for address: MediaProxyIPAddress) throws -> NWEndpoint.Host {
    switch address {
    case let .v4(bytes):
      guard let value = IPv4Address(Data(bytes)) else { throw CastRelayError.listenerUnavailable }
      return .ipv4(value)
    case let .v6(bytes):
      guard let value = IPv6Address(Data(bytes)) else { throw CastRelayError.listenerUnavailable }
      return .ipv6(value)
    }
  }
}

struct CastRelayRegistration: Equatable, Sendable {
  let sessionID: String
  let resourceID: String
}

enum CastRelayResourceKind: Hashable, Sendable {
  case media
  case hlsPlaylist
  case automatic
  case textTrack(CastTextTrackFormat)
}

enum CastRelayResourcePayload: Sendable {
  case remote(MediaProxyTarget, kind: CastRelayResourceKind)
  case inline(Data, contentType: String)
}

struct CastRelayResource: Sendable {
  let sessionID: String
  let resourceID: String
  let payload: CastRelayResourcePayload
}

struct CastRelayLeasedResource: Sendable {
  let resource: CastRelayResource
  let lease: CastRelayAccessLease
}

struct CastRelaySessionDiagnostics: Equatable, Sendable {
  let createdAt: Date
  let resourceCount: Int
  let isLive: Bool
}

private final class CastRelayLeaseState: @unchecked Sendable {
  var released = false
}

final class CastRelayAccessBarrier: @unchecked Sendable {
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var valid = true

  func makeLease() -> CastRelayAccessLease? {
    lock.castWithLock {
      guard valid else { return nil }
      return CastRelayAccessLease(
        barrier: self,
        generation: generation,
        state: CastRelayLeaseState()
      )
    }
  }

  fileprivate func withValidAccess<Result>(
    generation candidate: UInt64,
    state: CastRelayLeaseState,
    _ operation: () throws -> Result
  ) rethrows -> Result? {
    try lock.castWithLock {
      guard valid, generation == candidate, !state.released else { return nil }
      return try operation()
    }
  }

  fileprivate func release(_ state: CastRelayLeaseState) {
    lock.castWithLock { state.released = true }
  }

  func revoke() {
    lock.castWithLock {
      guard valid else { return }
      valid = false
      generation &+= 1
    }
  }

  var isValid: Bool { lock.castWithLock { valid } }
}

final class CastRelayAccessLease: @unchecked Sendable {
  private let barrier: CastRelayAccessBarrier
  private let generation: UInt64
  private let state: CastRelayLeaseState

  fileprivate init(
    barrier: CastRelayAccessBarrier,
    generation: UInt64,
    state: CastRelayLeaseState
  ) {
    self.barrier = barrier
    self.generation = generation
    self.state = state
  }

  func withValidAccess<Result>(_ operation: () throws -> Result) rethrows -> Result? {
    try barrier.withValidAccess(generation: generation, state: state, operation)
  }

  func release() { barrier.release(state) }
  deinit { release() }
}

actor CastRelaySessionStore {
  private struct TargetHeader: Hashable, Sendable {
    let name: String
    let value: String
  }

  private struct TargetKey: Hashable, Sendable {
    let url: String
    let method: String
    let headers: [TargetHeader]
    let kind: CastRelayResourceKind

    init(_ target: MediaProxyTarget, kind: CastRelayResourceKind) {
      url = target.upstreamURL.absoluteString
      method = target.method
      self.kind = kind
      headers = target.headers.map { TargetHeader(name: $0.key, value: $0.value) }
        .sorted { lhs, rhs in
          lhs.name == rhs.name ? lhs.value < rhs.value : lhs.name < rhs.name
        }
    }
  }

  private static let tokenByteCount = 32
  private static let tokenCharacterCount = 43
  private static let maximumIdentifierAttempts = 16

  nonisolated let sessionID: String
  nonisolated let accessBarrier: CastRelayAccessBarrier
  private let clock: @Sendable () -> Date
  private let createdAt: Date
  private let maximumResources: Int
  private let tokenGenerator: @Sendable () -> String
  private var resources: [String: CastRelayResourcePayload] = [:]
  private var resourceIDsByTarget: [TargetKey: String] = [:]

  init(
    accessBarrier: CastRelayAccessBarrier = CastRelayAccessBarrier(),
    clock: @escaping @Sendable () -> Date = Date.init,
    maximumResources: Int = 2_048,
    tokenGenerator: (@Sendable () -> String)? = nil
  ) {
    let generator = tokenGenerator ?? Self.makeSecureToken
    let identifier = generator()
    precondition(Self.hasExactTokenSyntax(identifier), "Cast relay token generation failed")
    sessionID = identifier
    self.accessBarrier = accessBarrier
    self.clock = clock
    createdAt = clock()
    self.maximumResources = max(0, maximumResources)
    self.tokenGenerator = generator
  }

  func registerRemote(
    _ target: MediaProxyTarget,
    kind: CastRelayResourceKind = .automatic
  ) throws -> CastRelayRegistration {
    guard accessBarrier.isValid else { throw CastRelayError.sessionUnavailable }
    let normalized = try CastSourceValidation.normalizedRemoteTarget(target, requiredMethod: "GET")
    let key = TargetKey(normalized, kind: kind)
    if let resourceID = resourceIDsByTarget[key] {
      return CastRelayRegistration(sessionID: sessionID, resourceID: resourceID)
    }
    guard resources.count < maximumResources else { throw CastRelayError.capacityExceeded }
    let resourceID = try generateUniqueIdentifier()
    resources[resourceID] = .remote(normalized, kind: kind)
    resourceIDsByTarget[key] = resourceID
    return CastRelayRegistration(sessionID: sessionID, resourceID: resourceID)
  }

  func registerInline(_ data: Data, contentType: String) throws -> CastRelayRegistration {
    guard accessBarrier.isValid else { throw CastRelayError.sessionUnavailable }
    guard resources.count < maximumResources else { throw CastRelayError.capacityExceeded }
    let resourceID = try generateUniqueIdentifier()
    resources[resourceID] = .inline(data, contentType: contentType)
    return CastRelayRegistration(sessionID: sessionID, resourceID: resourceID)
  }

  func resolve(sessionID candidateSession: String, resourceID: String) -> CastRelayLeasedResource? {
    guard candidateSession == sessionID,
          Self.hasExactTokenSyntax(candidateSession),
          Self.hasExactTokenSyntax(resourceID),
          let payload = resources[resourceID],
          let lease = accessBarrier.makeLease() else {
      return nil
    }
    return CastRelayLeasedResource(
      resource: CastRelayResource(
        sessionID: sessionID,
        resourceID: resourceID,
        payload: payload
      ),
      lease: lease
    )
  }

  func invalidateAll() {
    accessBarrier.revoke()
    resources.removeAll()
    resourceIDsByTarget.removeAll()
  }

  func diagnostics() -> CastRelaySessionDiagnostics {
    _ = clock()
    return CastRelaySessionDiagnostics(
      createdAt: createdAt,
      resourceCount: resources.count,
      isLive: accessBarrier.isValid
    )
  }

  private func generateUniqueIdentifier() throws -> String {
    for _ in 0..<Self.maximumIdentifierAttempts {
      let candidate = tokenGenerator()
      if Self.hasExactTokenSyntax(candidate), candidate != sessionID, resources[candidate] == nil {
        return candidate
      }
    }
    throw CastRelayError.sessionUnavailable
  }

  private static func makeSecureToken() -> String {
    var bytes = [UInt8](repeating: 0, count: tokenByteCount)
    let status = bytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    precondition(status == errSecSuccess, "Cast relay token generation failed")
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func hasExactTokenSyntax(_ token: String) -> Bool {
    guard token.utf8.count == tokenCharacterCount else { return false }
    return token.utf8.allSatisfy { byte in
      (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 45 || byte == 95
    }
  }
}

actor CastRelayStopGate {
  private var operation: Task<Void, Never>?
  private var finished = false

  func stop(_ cleanup: @escaping @Sendable () async -> Void) async {
    if finished { return }
    if let operation {
      await operation.value
      return
    }
    let created = Task { await cleanup() }
    operation = created
    await created.value
    finished = true
    operation = nil
  }
}

final class CastRelayServer: @unchecked Sendable {
  private static let maximumPlaylistBytes = 2 * 1_024 * 1_024
  private static let maximumTextTrackBytes = 2 * 1_024 * 1_024
  private static let maximumPlaylistReferences = 2_048
  private static let maximumConcurrentClients = 64
  private static let corsVary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network"
  private static let corsAllowedMethods = "GET, HEAD, OPTIONS"
  private static let corsAllowedHeaders = "Range, Accept-Encoding, Content-Type"
  private static let corsExposedHeaders = "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  private static let upstreamCORSHeaderNames: Set<String> = [
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-allow-private-network",
    "access-control-expose-headers",
    "access-control-max-age",
    "timing-allow-origin",
    "vary",
  ]

  private let selection: CastNetworkSelection
  private let upstream: CastRelayUpstreamOpening
  private let listenerFactory: CastRelayListenerFactory
  private let makePathMonitor: @Sendable () -> CastRelayPathMonitoring
  private let notificationCenter: NotificationCenter
  private let timing: CastRelayServerTiming
  private let monotonicNow: @Sendable () -> TimeInterval
  private let sessionBarrier: CastRelayAccessBarrier
  private let store: CastRelaySessionStore
  private let stopGate = CastRelayStopGate()
  private let queue = DispatchQueue(label: "com.movix.cast.lan-relay")
  private let lock = NSLock()
  private var listener: CastRelayListener?
  private var listeningPort: NWEndpoint.Port?
  private var pathMonitor: CastRelayPathMonitoring?
  private var backgroundObserver: NSObjectProtocol?
  private var clients: [ObjectIdentifier: CastRelayClient] = [:]
  private var stoppingOrStopped = false
  private var stopFinished = false
  private var preparationStarted = false

  private init(
    selection: CastNetworkSelection,
    upstream: CastRelayUpstreamOpening,
    listenerFactory: CastRelayListenerFactory,
    makePathMonitor: @escaping @Sendable () -> CastRelayPathMonitoring,
    notificationCenter: NotificationCenter,
    timing: CastRelayServerTiming,
    monotonicNow: @escaping @Sendable () -> TimeInterval,
    maximumResources: Int,
    tokenGenerator: (@Sendable () -> String)?
  ) {
    self.selection = selection
    self.upstream = upstream
    self.listenerFactory = listenerFactory
    self.makePathMonitor = makePathMonitor
    self.notificationCenter = notificationCenter
    self.timing = timing
    self.monotonicNow = monotonicNow
    let barrier = CastRelayAccessBarrier()
    sessionBarrier = barrier
    store = CastRelaySessionStore(
      accessBarrier: barrier,
      maximumResources: maximumResources,
      tokenGenerator: tokenGenerator
    )
  }

  static func start(
    selection: CastNetworkSelection,
    upstream: CastRelayUpstreamOpening = MediaProxyUpstream(),
    listenerFactory: CastRelayListenerFactory = CastRelayNWListenerFactory(),
    makePathMonitor: @escaping @Sendable () -> CastRelayPathMonitoring = {
      CastNetworkPathMonitor()
    },
    notificationCenter: NotificationCenter = .default,
    timing: CastRelayServerTiming = .production,
    monotonicNow: @escaping @Sendable () -> TimeInterval = {
      ProcessInfo.processInfo.systemUptime
    },
    maximumResources: Int = 2_048,
    tokenGenerator: (@Sendable () -> String)? = nil
  ) async throws -> CastRelayServer {
    let server = CastRelayServer(
      selection: selection,
      upstream: upstream,
      listenerFactory: listenerFactory,
      makePathMonitor: makePathMonitor,
      notificationCenter: notificationCenter,
      timing: timing,
      monotonicNow: monotonicNow,
      maximumResources: maximumResources,
      tokenGenerator: tokenGenerator
    )
    do {
      try await server.startListener()
      server.installLifecycleInvalidation()
      return server
    } catch {
      await server.stop()
      throw (error as? CastRelayError) ?? CastRelayError.listenerUnavailable
    }
  }

  func prepare(
    rootTarget: MediaProxyTarget,
    profile: CastMediaProfile,
    tracks: [CastSourceTrack]
  ) async throws -> PreparedCastRelay {
    guard tracks.count <= CastSourceValidation.maximumTrackCount,
          beginPreparation() else {
      throw tracks.count > CastSourceValidation.maximumTrackCount
        ? CastRelayError.tooManyTracks
        : CastRelayError.sessionUnavailable
    }
    do {
      let root = try await store.registerRemote(
        rootTarget,
        kind: profile.isHLS ? .hlsPlaylist : .media
      )
      let contentURL = try localURL(for: root)
      var preparedTracks: [PreparedCastTextTrack] = []
      preparedTracks.reserveCapacity(tracks.count)
      for track in tracks {
        let registration: CastRelayRegistration
        if let target = track.remoteTarget {
          registration = try await store.registerRemote(
            target,
            kind: .textTrack(track.format)
          )
        } else if let inlineVTT = track.inlineVTT {
          guard CastVTTValidator.validate(inlineVTT) else {
            throw CastRelayError.invalidTextTrack
          }
          registration = try await store.registerInline(
            Data(inlineVTT.utf8),
            contentType: "text/vtt; charset=utf-8"
          )
        } else {
          throw CastRelayError.invalidTextTrack
        }
        preparedTracks.append(PreparedCastTextTrack(
          contentURL: try localURL(for: registration),
          contentType: "text/vtt",
          language: track.language,
          name: track.name,
          active: track.active
        ))
      }
      guard sessionBarrier.isValid, !isStopped else { throw CastRelayError.accessRevoked }
      return PreparedCastRelay(
        contentURL: contentURL,
        profile: profile,
        textTracks: preparedTracks,
        stop: { [server = self] in await server.stop() }
      )
    } catch {
      await stop()
      throw (error as? CastRelayError) ?? CastRelayError.sessionUnavailable
    }
  }

  func stop() async {
    _ = transitionToTerminalSynchronously()
    await stopGate.stop { [weak self] in
      await self?.performStop()
    }
  }

  func invalidate() async { await stop() }

  func receiverDidChange(to receiverAddress: MediaProxyIPAddress?) async {
    guard receiverAddress == selection.receiverAddress else {
      await stop()
      return
    }
  }

  var isStopped: Bool { lock.castWithLock { stoppingOrStopped } }

  func authorizePeer(_ literal: String) -> Bool {
    guard let address = MediaProxyIPAddress(literal) else { return false }
    return Self.normalizedPeer(address, for: selection.receiverAddress) == selection.receiverAddress
  }

  func authorizePeer(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host, _) = endpoint,
          let address = Self.numericAddress(from: host) else { return false }
    return Self.normalizedPeer(address, for: selection.receiverAddress) == selection.receiverAddress
  }

  private func startListener() async throws {
    let created: CastRelayListener
    do {
      created = try listenerFactory.makeListener(boundTo: selection.localAddress, port: .any)
    } catch {
      throw CastRelayError.listenerUnavailable
    }
    let _: NWEndpoint.Port = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = CastRelayContinuationGate<NWEndpoint.Port>(continuation)
        created.newConnectionHandler = { [weak self] connection in
          self?.accept(connection)
        }
        created.stateUpdateHandler = { [weak self, weak created] state in
          guard let self, let created else { return }
          switch state {
          case .ready:
            guard let port = created.port else {
              gate.resume(throwing: CastRelayError.listenerUnavailable)
              self.scheduleStopFromCallback()
              return
            }
            let accepted = self.lock.castWithLock { () -> Bool in
              guard self.listener === created, !self.stoppingOrStopped else { return false }
              self.listeningPort = port
              return true
            }
            if accepted { gate.resume(returning: port) }
            else { gate.resume(throwing: CastRelayError.listenerUnavailable) }
          case .failed, .cancelled:
            gate.resume(throwing: CastRelayError.listenerUnavailable)
            self.scheduleStopFromCallback()
          }
        }
        let shouldStart = lock.castWithLock { () -> Bool in
          guard listener == nil, !stoppingOrStopped else { return false }
          listener = created
          return true
        }
        guard shouldStart else {
          gate.resume(throwing: CastRelayError.listenerUnavailable)
          created.cancel()
          return
        }
        created.start(on: queue)
        queue.asyncAfter(deadline: .now() + timing.listenerStartTimeout) { [weak self, weak created] in
          guard let self, let created else { return }
          let timedOut = self.lock.castWithLock {
            self.listener === created && self.listeningPort == nil && !self.stoppingOrStopped
          }
          if timedOut {
            gate.resume(throwing: CastRelayError.listenerUnavailable)
            self.scheduleStopFromCallback()
          }
        }
      }
    } onCancel: {
      self.scheduleStopFromCallback()
    }
  }

  private func installLifecycleInvalidation() {
    let monitor = makePathMonitor()
    let observer = notificationCenter.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.scheduleStopFromCallback()
    }
    let installed = lock.castWithLock { () -> Bool in
      guard !stoppingOrStopped else { return false }
      pathMonitor = monitor
      backgroundObserver = observer
      return true
    }
    guard installed else {
      notificationCenter.removeObserver(observer)
      monitor.cancel()
      return
    }
    let started = monitor.start { [weak self] snapshot in
      guard let self else { return }
      let isValid = CastNetworkSelector.selectionStillValid(
        self.selection,
        candidates: snapshot.candidates,
        receiverAddress: Self.ipLiteral(self.selection.receiverAddress)
      )
      if !isValid { self.scheduleStopFromCallback() }
    }
    if !started { scheduleStopFromCallback() }
  }

  private func performStop() async {
    let snapshot = lock.castWithLock { () -> (
      CastRelayListener?,
      CastRelayPathMonitoring?,
      NSObjectProtocol?,
      [CastRelayClient]
    ) in
      stoppingOrStopped = true
      let result = (
        listener,
        pathMonitor,
        backgroundObserver,
        Array(clients.values)
      )
      listener = nil
      listeningPort = nil
      pathMonitor = nil
      backgroundObserver = nil
      clients.removeAll()
      return result
    }
    snapshot.0?.cancel()
    snapshot.1?.cancel()
    if let observer = snapshot.2 { notificationCenter.removeObserver(observer) }
    for client in snapshot.3 { client.cancel() }
    await store.invalidateAll()
    lock.castWithLock { stopFinished = true }
  }

  private func scheduleStopFromCallback() {
    guard transitionToTerminalSynchronously() else { return }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      Task { await self.stop() }
    }
  }

  @discardableResult
  private func transitionToTerminalSynchronously() -> Bool {
    lock.castWithLock {
      guard !stoppingOrStopped else { return false }
      stoppingOrStopped = true
      sessionBarrier.revoke()
      return true
    }
  }

  private func beginPreparation() -> Bool {
    lock.castWithLock {
      guard !preparationStarted, !stoppingOrStopped, listeningPort != nil else { return false }
      preparationStarted = true
      return true
    }
  }

  private func accept(_ connection: CastRelayConnection) {
    guard authorizePeer(connection.endpoint) else {
      connection.cancel()
      return
    }
    let client = CastRelayClient(
      connection: connection,
      owner: self,
      requestDeadline: monotonicNow() + timing.requestTimeout
    )
    let accepted = lock.castWithLock { () -> Bool in
      guard listener != nil,
            listeningPort != nil,
            !stoppingOrStopped,
            sessionBarrier.isValid,
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

  fileprivate func remove(_ client: CastRelayClient) {
    lock.castWithLock { clients.removeValue(forKey: ObjectIdentifier(client)) }
  }

  fileprivate func handle(_ client: CastRelayClient) async {
    defer { client.finish() }
    let request: MediaProxyLocalRequest
    do {
      let data = try await receiveRequest(from: client)
      client.markRequestReadFinished()
      request = try CastRelayHTTPParser.parse(data)
    } catch let error as MediaProxyHTTPParserError {
      await sendLocalError(
        error == .requestTooLarge ? 431 : 400,
        headOnly: client.isHeadRequest,
        to: client
      )
      return
    } catch {
      await sendLocalError(400, headOnly: client.isHeadRequest, to: client)
      return
    }

    guard let port = currentPort(),
          request.headers["host"] == "\(selection.localURLAuthorityHost):\(port.rawValue)",
          let route = Self.parseRoute(request.path),
          route.sessionID == store.sessionID,
          let leased = await store.resolve(
            sessionID: route.sessionID,
            resourceID: route.resourceID
          ) else {
      await sendLocalError(404, headOnly: request.method == "HEAD", to: client)
      return
    }
    defer { leased.lease.release() }

    let cors: CastRelayCORSContext
    do {
      cors = try Self.validateCORS(request)
    } catch {
      await sendLeasedError(
        403,
        headOnly: request.method == "HEAD",
        cors: nil,
        lease: leased.lease,
        client: client
      )
      return
    }

    if request.method == "OPTIONS" {
      do {
        try await sendResponseHead(
          statusCode: 204,
          headers: ["Content-Length": "0"],
          final: true,
          cors: cors,
          lease: leased.lease,
          client: client
        )
      } catch {
        client.cancel()
      }
      return
    }

    await serve(
      leased.resource,
      request: request,
      cors: cors,
      lease: leased.lease,
      client: client
    )
  }

  private func serve(
    _ resource: CastRelayResource,
    request: MediaProxyLocalRequest,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async {
    switch resource.payload {
    case let .inline(data, contentType):
      do {
        try await serveInline(
          data,
          contentType: contentType,
          request: request,
          cors: cors,
          lease: lease,
          client: client
        )
      } catch {
        client.cancel()
      }
    case let .remote(target, kind):
      await serveRemote(
        target,
        kind: kind,
        request: request,
        cors: cors,
        lease: lease,
        client: client
      )
    }
  }

  private func serveInline(
    _ data: Data,
    contentType: String,
    request: MediaProxyLocalRequest,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    let range = request.headers["range"].flatMap { Self.byteRange($0, total: data.count) }
    if request.headers["range"] != nil, range == nil {
      try await sendResponseHead(
        statusCode: 416,
        headers: [
          "Content-Type": contentType,
          "Content-Length": "0",
          "Content-Range": "bytes */\(data.count)",
          "Accept-Ranges": "bytes",
        ],
        final: true,
        cors: cors,
        lease: lease,
        client: client
      )
      return
    }

    let output: Data
    let status: Int
    var headers: [String: String] = [
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    ]
    if let range {
      status = 206
      output = data.subdata(in: range)
      headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)"
    } else {
      status = 200
      output = data
    }
    headers["Content-Length"] = String(output.count)
    let headOnly = request.method == "HEAD"
    try await sendResponseHead(
      statusCode: status,
      headers: headers,
      final: headOnly || output.isEmpty,
      cors: cors,
      lease: lease,
      client: client
    )
    if !headOnly, !output.isEmpty {
      try await sendLeased(
        output,
        context: .finalMessage,
        isComplete: true,
        lease: lease,
        client: client
      )
    }
  }

  private func serveRemote(
    _ target: MediaProxyTarget,
    kind: CastRelayResourceKind,
    request: MediaProxyLocalRequest,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async {
    var responseBody: MediaProxyUpstreamBody?
    defer {
      responseBody?.cancel()
      client.setUpstreamBody(nil)
    }
    do {
      guard lease.withValidAccess({ true }) == true else {
        throw CastRelayError.accessRevoked
      }
      let effectiveKind = Self.effectiveKind(kind, for: target.upstreamURL)
      let transformsRepresentation: Bool
      switch effectiveKind {
      case .hlsPlaylist, .textTrack:
        transformsRepresentation = true
      case .media, .automatic:
        transformsRepresentation = false
      }
      let effectiveTarget = MediaProxyTarget(
        upstreamURL: target.upstreamURL,
        method: request.method,
        headers: transformsRepresentation
          ? Self.removingUnsafeTransformationHeaders(target.headers)
          : target.headers
      )
      let response = try await upstream.open(
        target: effectiveTarget,
        localHeaders: transformsRepresentation
          ? Self.removingUnsafeTransformationHeaders(request.headers)
          : request.headers
      )
      responseBody = response.body
      client.setUpstreamBody(response.body)

      if request.method == "HEAD" {
        response.body.cancel()
        if transformsRepresentation, response.statusCode != 200 {
          throw CastRelayError.upstreamUnavailable
        }
        var headers = Self.allowedResponseHeaders(response.headers)
        switch effectiveKind {
        case .hlsPlaylist:
          Self.removeRepresentationHeaders(&headers)
          headers["Content-Type"] = CastMediaProfile.canonicalHLSContentType
        case .textTrack:
          Self.removeRepresentationHeaders(&headers)
          headers["Content-Type"] = "text/vtt; charset=utf-8"
        case .media, .automatic:
          break
        }
        try await sendResponseHead(
          statusCode: response.statusCode,
          headers: headers,
          final: true,
          cors: cors,
          lease: lease,
          client: client
        )
        return
      }

      switch effectiveKind {
      case .media:
        try await serveMediaResponse(
          response,
          cors: cors,
          lease: lease,
          client: client
        )
      case .hlsPlaylist:
        try await serveHLSResponse(
          response,
          parentTarget: target,
          initialBody: nil,
          cors: cors,
          lease: lease,
          client: client
        )
      case let .textTrack(format):
        try await serveTextResponse(
          response,
          format: format,
          initialBody: nil,
          cors: cors,
          lease: lease,
          client: client
        )
      case .automatic:
        try await serveAutomaticResponse(
          response,
          parentTarget: target,
          cors: cors,
          lease: lease,
          client: client
        )
      }
    } catch is CancellationError {
      client.cancel()
    } catch CastRelayError.accessRevoked {
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
        cors: cors,
        lease: lease,
        client: client
      )
    }
  }

  private func serveMediaResponse(
    _ response: MediaProxyUpstreamResponse,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    guard !Self.headersIndicateHLS(response.headers),
          !Self.headersIndicateTextTrack(response.headers) else {
      throw CastRelayError.upstreamUnavailable
    }
    var bufferedBody = Data()
    while !Self.isConfidentBinary(bufferedBody) {
      guard lease.withValidAccess({ true }) == true else {
        throw CastRelayError.accessRevoked
      }
      guard let chunk = try await response.body.nextChunk() else { break }
      guard chunk.count <= Self.maximumPlaylistBytes - bufferedBody.count else {
        throw CastRelayError.responseTooLarge
      }
      bufferedBody.append(chunk)
      if Self.sniffedTransformKind(bufferedBody) != nil {
        throw CastRelayError.upstreamUnavailable
      }
    }
    guard response.statusCode != 206
      || Self.headersIndicateProgressiveMedia(response.headers)
      || Self.isConfidentBinary(bufferedBody) else {
      throw CastRelayError.upstreamUnavailable
    }
    try await sendStreamingResponse(
      response,
      initialBody: bufferedBody.isEmpty ? nil : bufferedBody,
      cors: cors,
      lease: lease,
      client: client
    )
  }

  private func serveAutomaticResponse(
    _ response: MediaProxyUpstreamResponse,
    parentTarget: MediaProxyTarget,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    if Self.isHLS(response.finalURL, headers: response.headers) {
      try await serveHLSResponse(
        response,
        parentTarget: parentTarget,
        initialBody: nil,
        cors: cors,
        lease: lease,
        client: client
      )
      return
    }
    if Self.isTextTrack(response.finalURL, headers: response.headers) {
      try await serveTextResponse(
        response,
        format: Self.isSubRip(response.finalURL, headers: response.headers)
          ? .subRip
          : .webVTT,
        initialBody: nil,
        cors: cors,
        lease: lease,
        client: client
      )
      return
    }

    var bufferedBody = Data()
    var sniffedKind: CastRelayResourceKind?
    while sniffedKind == nil, !Self.isConfidentBinary(bufferedBody) {
      guard lease.withValidAccess({ true }) == true else {
        throw CastRelayError.accessRevoked
      }
      guard let chunk = try await response.body.nextChunk() else { break }
      guard chunk.count <= Self.maximumPlaylistBytes - bufferedBody.count else {
        throw CastRelayError.responseTooLarge
      }
      bufferedBody.append(chunk)
      sniffedKind = Self.sniffedTransformKind(bufferedBody)
    }
    if let sniffed = sniffedKind {
      switch sniffed {
      case .hlsPlaylist:
        try await serveHLSResponse(
          response,
          parentTarget: parentTarget,
          initialBody: bufferedBody,
          cors: cors,
          lease: lease,
          client: client
        )
      case let .textTrack(format):
        try await serveTextResponse(
          response,
          format: format,
          initialBody: bufferedBody,
          cors: cors,
          lease: lease,
          client: client
        )
      case .media, .automatic:
        throw CastRelayError.upstreamUnavailable
      }
      return
    }
    guard response.statusCode != 206
      || Self.headersIndicateProgressiveMedia(response.headers)
      || Self.isConfidentBinary(bufferedBody) else {
      throw CastRelayError.upstreamUnavailable
    }
    try await sendStreamingResponse(
      response,
      initialBody: bufferedBody.isEmpty ? nil : bufferedBody,
      cors: cors,
      lease: lease,
      client: client
    )
  }

  private func serveHLSResponse(
    _ response: MediaProxyUpstreamResponse,
    parentTarget: MediaProxyTarget,
    initialBody: Data?,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    guard response.statusCode == 200 else {
      throw CastRelayError.upstreamUnavailable
    }
    let sourceData = try await readBounded(
      response.body,
      initialData: initialBody,
      lease: lease,
      maximumBytes: Self.maximumPlaylistBytes
    )
    guard let source = String(data: sourceData, encoding: .utf8),
          Self.looksLikeHLS(source) else {
      throw CastRelayError.upstreamUnavailable
    }
    let rewritten = try await rewritePlaylist(
      source,
      baseURL: response.finalURL,
      parentTarget: parentTarget
    )
    let output = Data(rewritten.utf8)
    var headers = Self.allowedResponseHeaders(response.headers)
    Self.removeRepresentationHeaders(&headers)
    headers["Content-Type"] = CastMediaProfile.canonicalHLSContentType
    headers["Content-Length"] = String(output.count)
    try await sendBufferedResponse(
      statusCode: 200,
      headers: headers,
      body: output,
      cors: cors,
      lease: lease,
      client: client
    )
  }

  private func serveTextResponse(
    _ response: MediaProxyUpstreamResponse,
    format: CastTextTrackFormat,
    initialBody: Data?,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    guard response.statusCode == 200 else {
      throw CastRelayError.upstreamUnavailable
    }
    let sourceData = try await readBounded(
      response.body,
      initialData: initialBody,
      lease: lease,
      maximumBytes: Self.maximumTextTrackBytes
    )
    guard let source = String(data: sourceData, encoding: .utf8) else {
      throw CastRelayError.upstreamUnavailable
    }
    let outputText: String
    switch format {
    case .subRip:
      guard let converted = HLSPlaylistRewriter.convertSubRipToWebVTT(source),
            CastVTTValidator.validate(converted) else {
        throw CastRelayError.upstreamUnavailable
      }
      outputText = converted
    case .webVTT:
      guard CastVTTValidator.validate(source) else {
        throw CastRelayError.upstreamUnavailable
      }
      outputText = source
    }
    let output = Data(outputText.utf8)
    var headers = Self.allowedResponseHeaders(response.headers)
    Self.removeRepresentationHeaders(&headers)
    headers["Content-Type"] = "text/vtt; charset=utf-8"
    headers["Content-Length"] = String(output.count)
    try await sendBufferedResponse(
      statusCode: 200,
      headers: headers,
      body: output,
      cors: cors,
      lease: lease,
      client: client
    )
  }

  private func rewritePlaylist(
    _ source: String,
    baseURL: URL,
    parentTarget: MediaProxyTarget
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
          throw CastRelayError.responseTooLarge
        }
        references.append(url)
      }
      return "http://127.0.0.1:1/cast/placeholder/placeholder"
    }

    let inheritedHeaders = Self.removingUnsafeTransformationHeaders(parentTarget.headers)
    var localized: [String: String] = [:]
    for reference in references {
      let registration = try await store.registerRemote(
        MediaProxyTarget(
          upstreamURL: reference,
          method: "GET",
          headers: inheritedHeaders
        ),
        kind: .automatic
      )
      localized[reference.absoluteString] = try localURL(for: registration).absoluteString
    }
    return try HLSPlaylistRewriter.rewrite(
      source,
      baseURL: baseURL,
      wrapDirectSubtitles: true
    ) { url in
      guard let value = localized[url.absoluteString] else {
        throw CastRelayError.sessionUnavailable
      }
      return value
    }
  }

  private func sendStreamingResponse(
    _ response: MediaProxyUpstreamResponse,
    initialBody: Data? = nil,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    try await sendResponseHead(
      statusCode: response.statusCode,
      headers: Self.allowedResponseHeaders(response.headers),
      final: false,
      cors: cors,
      lease: lease,
      client: client
    )
    if let initialBody, !initialBody.isEmpty {
      try await sendLeased(
        initialBody,
        context: .defaultStream,
        isComplete: false,
        lease: lease,
        client: client
      )
    }
    while true {
      guard lease.withValidAccess({ true }) == true else {
        throw CastRelayError.accessRevoked
      }
      guard let chunk = try await response.body.nextChunk() else { break }
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
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    try await sendResponseHead(
      statusCode: statusCode,
      headers: headers,
      final: body.isEmpty,
      cors: cors,
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
    final: Bool,
    cors: CastRelayCORSContext,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    client.markResponseStarted()
    try await sendLeased(
      Self.serializeResponseHead(
        statusCode: statusCode,
        headers: Self.applyingCORS(headers, context: cors)
      ),
      context: final ? .finalMessage : .defaultStream,
      isComplete: final,
      lease: lease,
      client: client
    )
  }

  private func sendLeased(
    _ data: Data?,
    context: NWConnection.ContentContext,
    isComplete: Bool,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async throws {
    try Task.checkCancellation()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let gate = CastRelayContinuationGate<Void>(continuation)
        let enqueued = lease.withValidAccess {
          client.connection.send(
            content: data,
            context: context,
            isComplete: isComplete
          ) { error in
            if error == nil {
              gate.resume(returning: Void())
            } else {
              gate.resume(throwing: CastRelayError.upstreamUnavailable)
            }
          }
          return true
        }
        guard enqueued == true else {
          gate.resume(throwing: CastRelayError.accessRevoked)
          client.cancel()
          return
        }
        queue.asyncAfter(deadline: .now() + timing.sendTimeout) {
          if gate.resume(throwing: CastRelayError.upstreamUnavailable) {
            client.cancel()
          }
        }
      }
    } onCancel: {
      client.cancel()
    }
  }

  private func receiveRequest(from client: CastRelayClient) async throws -> Data {
    var request = Data()
    while request.range(of: Data([13, 10, 13, 10])) == nil {
      let remainingCapacity = MediaProxyHTTPParser.maximumRequestBytes + 1 - request.count
      guard remainingCapacity > 0 else { throw MediaProxyHTTPParserError.requestTooLarge }
      let chunk = try await receive(
        from: client,
        maximumLength: min(8 * 1_024, remainingCapacity),
        requestDeadline: client.requestDeadline
      )
      guard let data = chunk.data, !data.isEmpty else { throw CastRelayError.invalidRequest }
      request.append(data)
      client.observeRequestPrefix(request)
      guard request.count <= MediaProxyHTTPParser.maximumRequestBytes else {
        throw MediaProxyHTTPParserError.requestTooLarge
      }
      if chunk.isComplete, request.range(of: Data([13, 10, 13, 10])) == nil {
        throw MediaProxyHTTPParserError.incompleteRequest
      }
    }
    return request
  }

  private func receive(
    from client: CastRelayClient,
    maximumLength: Int,
    requestDeadline: TimeInterval
  ) async throws -> (data: Data?, isComplete: Bool) {
    let remaining = requestDeadline - monotonicNow()
    guard maximumLength > 0, remaining > 0 else { throw CastRelayError.invalidRequest }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        // Etiquettes alignees sur le type de retour, comme dans MediaProxyServer.
        let gate = CastRelayContinuationGate<(data: Data?, isComplete: Bool)>(continuation)
        client.connection.receive(maximumLength: maximumLength) { data, isComplete, error in
          if error == nil { gate.resume(returning: (data, isComplete)) }
          else { gate.resume(throwing: CastRelayError.invalidRequest) }
        }
        queue.asyncAfter(deadline: .now() + remaining) {
          if gate.resume(throwing: CastRelayError.invalidRequest) { client.cancel() }
        }
      }
    } onCancel: {
      client.cancel()
    }
  }

  private func readBounded(
    _ body: MediaProxyUpstreamBody,
    initialData: Data? = nil,
    lease: CastRelayAccessLease,
    maximumBytes: Int
  ) async throws -> Data {
    var output = initialData ?? Data()
    guard output.count <= maximumBytes else {
      throw CastRelayError.responseTooLarge
    }
    while true {
      try Task.checkCancellation()
      guard lease.withValidAccess({ true }) == true else {
        throw CastRelayError.accessRevoked
      }
      guard let chunk = try await body.nextChunk() else { break }
      guard chunk.count <= maximumBytes - output.count else {
        throw CastRelayError.responseTooLarge
      }
      output.append(chunk)
    }
    return output
  }

  private func sendLocalError(
    _ statusCode: Int,
    headOnly: Bool,
    to client: CastRelayClient
  ) async {
    guard let lease = sessionBarrier.makeLease() else {
      client.cancel()
      return
    }
    defer { lease.release() }
    await sendLeasedError(
      statusCode,
      headOnly: headOnly,
      cors: nil,
      lease: lease,
      client: client
    )
  }

  private func sendLeasedError(
    _ statusCode: Int,
    headOnly: Bool,
    cors: CastRelayCORSContext?,
    lease: CastRelayAccessLease,
    client: CastRelayClient
  ) async {
    let body = Data("Cast relay unavailable\n".utf8)
    var headers: [String: String] = [
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(body.count),
      "Cache-Control": "no-store",
    ]
    if let cors { headers = Self.applyingCORS(headers, context: cors) }
    var response = Self.serializeResponseHead(statusCode: statusCode, headers: headers)
    if !headOnly { response.append(body) }
    try? await sendLeased(
      response,
      context: .finalMessage,
      isComplete: true,
      lease: lease,
      client: client
    )
  }

  private func localURL(for registration: CastRelayRegistration) throws -> URL {
    guard registration.sessionID == store.sessionID,
          let port = currentPort() else { throw CastRelayError.sessionUnavailable }
    let raw = "http://\(selection.localURLAuthorityHost):\(port.rawValue)/cast/\(registration.sessionID)/\(registration.resourceID)"
    guard let url = URL(string: raw),
          url.query == nil,
          url.fragment == nil else { throw CastRelayError.sessionUnavailable }
    return url
  }

  private func currentPort() -> NWEndpoint.Port? {
    lock.castWithLock { stoppingOrStopped ? nil : listeningPort }
  }

  private static func parseRoute(_ path: String) -> CastRelayRoute? {
    guard !path.contains("%"), !path.contains("?"), !path.contains("#") else { return nil }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 4,
          segments[0].isEmpty,
          segments[1] == "cast" else { return nil }
    let sessionID = String(segments[2])
    let resourceID = String(segments[3])
    guard CastSourceValidation.hasExactTokenSyntax(sessionID),
          CastSourceValidation.hasExactTokenSyntax(resourceID),
          path == "/cast/\(sessionID)/\(resourceID)" else { return nil }
    return CastRelayRoute(sessionID: sessionID, resourceID: resourceID)
  }

  private static func validateCORS(_ request: MediaProxyLocalRequest) throws -> CastRelayCORSContext {
    let rawOrigin = request.headers["origin"]
    if request.method == "OPTIONS", rawOrigin == nil { throw CastRelayError.invalidRequest }
    let origin: String?
    if let rawOrigin {
      guard canonicalHTTPSOrigin(rawOrigin) == rawOrigin else { throw CastRelayError.invalidRequest }
      origin = rawOrigin
    } else {
      origin = nil
    }

    var allowPrivateNetwork = false
    if request.method == "OPTIONS" {
      if let requestedMethod = request.headers["access-control-request-method"] {
        guard ["GET", "HEAD", "OPTIONS"].contains(requestedMethod) else {
          throw CastRelayError.invalidRequest
        }
      }
      if let requestedHeaders = request.headers["access-control-request-headers"] {
        let allowed = Set(["range", "accept-encoding", "content-type"])
        let values = requestedHeaders.split(separator: ",", omittingEmptySubsequences: false)
          .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard !values.isEmpty,
              values.allSatisfy({ !$0.isEmpty && allowed.contains($0) }) else {
          throw CastRelayError.invalidRequest
        }
      }
      if let privateNetwork = request.headers["access-control-request-private-network"] {
        guard privateNetwork.caseInsensitiveCompare("true") == .orderedSame else {
          throw CastRelayError.invalidRequest
        }
        allowPrivateNetwork = true
      }
    }
    return CastRelayCORSContext(origin: origin, allowPrivateNetwork: allowPrivateNetwork)
  }

  private static func canonicalHTTPSOrigin(_ raw: String) -> String? {
    guard !raw.isEmpty,
          !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let components = URLComponents(string: raw),
          components.scheme == "https",
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.percentEncodedPath.isEmpty,
          let rawHost = components.host,
          !rawHost.isEmpty else { return nil }
    let host = rawHost.lowercased()
    let authorityHost = host.contains(":") ? "[\(host)]" : host
    let authority: String
    if let port = components.port, port != 443 {
      guard (1...65_535).contains(port) else { return nil }
      authority = "\(authorityHost):\(port)"
    } else {
      authority = authorityHost
    }
    let canonical = "https://\(authority)"
    return raw == canonical ? canonical : nil
  }

  private static func applyingCORS(
    _ input: [String: String],
    context: CastRelayCORSContext
  ) -> [String: String] {
    var headers = input.filter { !upstreamCORSHeaderNames.contains($0.key.lowercased()) }
    headers["Access-Control-Allow-Origin"] = context.origin ?? "*"
    headers["Access-Control-Allow-Methods"] = corsAllowedMethods
    headers["Access-Control-Allow-Headers"] = corsAllowedHeaders
    headers["Access-Control-Expose-Headers"] = corsExposedHeaders
    headers["Vary"] = corsVary
    if context.allowPrivateNetwork {
      headers["Access-Control-Allow-Private-Network"] = "true"
    }
    return headers
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
    for (rawName, value) in upstream {
      let normalized = rawName.lowercased()
      guard !upstreamCORSHeaderNames.contains(normalized),
            let name = allowed[normalized],
            value.utf8.count <= MediaProxyPolicy.maximumHeaderValueLength,
            !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
        continue
      }
      output[name] = value
    }
    return output
  }

  private static func removeRepresentationHeaders(_ headers: inout [String: String]) {
    for name in ["Content-Encoding", "Content-Length", "Content-Range", "Accept-Ranges"] {
      headers.removeValue(forKey: name)
    }
  }

  private static func removingUnsafeTransformationHeaders(
    _ headers: [String: String]
  ) -> [String: String] {
    let unsafe: Set<String> = [
      "range",
      "if-range",
      "if-match",
      "if-none-match",
      "if-modified-since",
      "if-unmodified-since",
    ]
    return headers.filter { !unsafe.contains($0.key.lowercased()) }
  }

  private static func effectiveKind(
    _ storedKind: CastRelayResourceKind,
    for url: URL
  ) -> CastRelayResourceKind {
    guard storedKind == .automatic else { return storedKind }
    switch url.pathExtension.lowercased() {
    case "m3u8": return .hlsPlaylist
    case "vtt": return .textTrack(.webVTT)
    case "srt": return .textTrack(.subRip)
    default: return .automatic
    }
  }

  private static func sniffedTransformKind(_ prefix: Data) -> CastRelayResourceKind? {
    var source = String(decoding: prefix, as: UTF8.self)
    if source.unicodeScalars.first?.value == 0xFEFF { source.removeFirst() }
    source = source.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    if looksLikeHLS(source) { return .hlsPlaylist }
    if trimmed == "WEBVTT" || trimmed.hasPrefix("WEBVTT\n")
      || trimmed.hasPrefix("WEBVTT ") || trimmed.hasPrefix("WEBVTT\t") {
      return .textTrack(.webVTT)
    }
    if trimmed.first?.isNumber == true,
       trimmed.contains("-->") {
      return .textTrack(.subRip)
    }
    return nil
  }

  private static func isConfidentBinary(_ prefix: Data) -> Bool {
    if prefix.contains(0) { return true }
    let signature = [UInt8](prefix.prefix(4))
    if signature == [0x1A, 0x45, 0xDF, 0xA3]
      || prefix.starts(with: Data("ID3".utf8))
      || (signature.count >= 2 && signature[0] == 0xFF && (signature[1] & 0xE0) == 0xE0) {
      return true
    }
    if prefix.count >= 8 {
      let boxType = String(decoding: prefix[4..<8], as: UTF8.self)
      if boxType == "ftyp" || boxType == "styp" || boxType == "moof" {
        return true
      }
    }
    if prefix.count >= 3 * 188,
       prefix[prefix.startIndex] == 0x47,
       prefix[prefix.startIndex + 188] == 0x47,
       prefix[prefix.startIndex + 376] == 0x47 {
      return true
    }
    return String(data: prefix, encoding: .utf8) == nil && prefix.count >= 4
  }

  private static func looksLikeHLS(_ source: String) -> Bool {
    var normalized = source
    if normalized.unicodeScalars.first?.value == 0xFEFF { normalized.removeFirst() }
    normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized == "#EXTM3U" || normalized.hasPrefix("#EXTM3U\n")
      || normalized.hasPrefix("#EXTM3U\r")
  }

  private static func isHLS(_ url: URL, headers: [String: String]) -> Bool {
    url.path.lowercased().hasSuffix(".m3u8")
      || headersIndicateHLS(headers)
  }

  private static func headersIndicateHLS(_ headers: [String: String]) -> Bool {
    header(named: "content-type", in: headers)?.lowercased().contains("mpegurl") == true
  }

  private static func isSubRip(_ url: URL, headers: [String: String]) -> Bool {
    url.path.lowercased().hasSuffix(".srt")
      || header(named: "content-type", in: headers)?.lowercased().contains("subrip") == true
      || header(named: "content-type", in: headers)?.lowercased().contains("text/srt") == true
  }

  private static func isTextTrack(_ url: URL, headers: [String: String]) -> Bool {
    let path = url.path.lowercased()
    return path.hasSuffix(".vtt") || path.hasSuffix(".srt")
      || headersIndicateTextTrack(headers)
  }

  private static func headersIndicateTextTrack(_ headers: [String: String]) -> Bool {
    let contentType = header(named: "content-type", in: headers)?.lowercased() ?? ""
    return contentType.contains("text/vtt") || contentType.contains("subrip")
      || contentType.contains("text/srt")
  }

  private static func headersIndicateProgressiveMedia(_ headers: [String: String]) -> Bool {
    CastMediaProfile.progressive(header(named: "content-type", in: headers)) != nil
  }

  private static func header(named name: String, in headers: [String: String]) -> String? {
    headers.first(where: { $0.key.caseInsensitiveCompare(name) == .orderedSame })?.value
  }

  private static func byteRange(_ raw: String, total: Int) -> Range<Int>? {
    guard total > 0,
          raw.count >= 7,
          raw.prefix(6).lowercased() == "bytes=",
          !raw.contains(",") else { return nil }
    let values = raw.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
    guard values.count == 2 else { return nil }
    if values[0].isEmpty {
      guard let suffix = Int(values[1]), suffix > 0 else { return nil }
      let count = min(suffix, total)
      return (total - count)..<total
    }
    guard let start = Int(values[0]), start >= 0, start < total else { return nil }
    if values[1].isEmpty { return start..<total }
    guard let requestedEnd = Int(values[1]), requestedEnd >= start else { return nil }
    let exclusiveEnd = requestedEnd >= total - 1 ? total : requestedEnd + 1
    return start..<exclusiveEnd
  }

  private static func serializeResponseHead(
    statusCode: Int,
    headers: [String: String]
  ) -> Data {
    let safeStatus = (100...599).contains(statusCode) ? statusCode : 502
    var lines = ["HTTP/1.1 \(safeStatus) \(reasonPhrase(for: safeStatus))"]
    var safeHeaders = headers.filter { name, value in
      !name.contains("\r") && !name.contains("\n")
        && !value.contains("\r") && !value.contains("\n")
    }
    safeHeaders["X-Content-Type-Options"] = "nosniff"
    safeHeaders["Connection"] = "close"
    for name in safeHeaders.keys.sorted() {
      if let value = safeHeaders[name] { lines.append("\(name): \(value)") }
    }
    return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
  }

  private static func reasonPhrase(for statusCode: Int) -> String {
    switch statusCode {
    case 200: return "OK"
    case 204: return "No Content"
    case 206: return "Partial Content"
    case 304: return "Not Modified"
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

  private static func numericAddress(from host: NWEndpoint.Host) -> MediaProxyIPAddress? {
    switch host {
    case let .ipv4(address): return .v4(Array(address.rawValue))
    case let .ipv6(address): return .v6(Array(address.rawValue))
    case .name: return nil
    @unknown default: return nil
    }
  }

  private static func normalizedPeer(
    _ peer: MediaProxyIPAddress,
    for receiver: MediaProxyIPAddress
  ) -> MediaProxyIPAddress {
    guard case .v4 = receiver,
          case let .v6(bytes) = peer,
          isIPv4Mapped(bytes) else { return peer }
    return .v4(Array(bytes[12...15]))
  }

  private static func isIPv4Mapped(_ bytes: [UInt8]) -> Bool {
    bytes.count == 16
      && bytes.prefix(10).allSatisfy({ $0 == 0 })
      && bytes[10] == 0xff
      && bytes[11] == 0xff
  }

  private static func ipLiteral(_ address: MediaProxyIPAddress) -> String {
    switch address {
    case let .v4(bytes): return bytes.map(String.init).joined(separator: ".")
    case let .v6(bytes):
      guard bytes.count == 16 else { return "" }
      return stride(from: 0, to: 16, by: 2).map { index in
        String(format: "%02x%02x", bytes[index], bytes[index + 1])
      }.joined(separator: ":")
    }
  }
}

private enum CastRelayHTTPParser {
  static func parse(_ data: Data) throws -> MediaProxyLocalRequest {
    guard data.count <= MediaProxyHTTPParser.maximumRequestBytes else {
      throw MediaProxyHTTPParserError.requestTooLarge
    }
    let optionsPrefix = Data("OPTIONS ".utf8)
    guard data.starts(with: optionsPrefix) else {
      return try MediaProxyHTTPParser.parse(data)
    }
    var adapted = data
    adapted.replaceSubrange(0..<optionsPrefix.count, with: Data("GET ".utf8))
    let parsed = try MediaProxyHTTPParser.parse(adapted)
    return MediaProxyLocalRequest(method: "OPTIONS", path: parsed.path, headers: parsed.headers)
  }
}

private struct CastRelayCORSContext {
  let origin: String?
  let allowPrivateNetwork: Bool
}

private struct CastRelayRoute {
  let sessionID: String
  let resourceID: String
}

private final class CastRelayClient: @unchecked Sendable {
  let connection: CastRelayConnection
  let requestDeadline: TimeInterval
  private weak var owner: CastRelayServer?
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
    connection: CastRelayConnection,
    owner: CastRelayServer,
    requestDeadline: TimeInterval
  ) {
    self.connection = connection
    self.owner = owner
    self.requestDeadline = requestDeadline
  }

  var isDisconnected: Bool { lock.castWithLock { disconnected } }
  var hasStartedResponse: Bool { lock.castWithLock { responseStarted } }
  var isHeadRequest: Bool { lock.castWithLock { headRequest } }

  func markResponseStarted() { lock.castWithLock { responseStarted = true } }
  func markRequestReadFinished() { lock.castWithLock { requestReadFinished = true } }

  func observeRequestPrefix(_ data: Data) {
    guard data.count >= 5 else { return }
    lock.castWithLock {
      guard !methodObserved else { return }
      methodObserved = true
      headRequest = data.starts(with: Data("HEAD ".utf8))
    }
  }

  func start(on queue: DispatchQueue, requestTimeout: TimeInterval) {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: self.beginHandling()
      case .failed, .cancelled: self.markDisconnected()
      }
    }
    connection.start(on: queue)
    queue.asyncAfter(deadline: .now() + requestTimeout) { [weak self] in
      self?.expireIncompleteRequest()
    }
  }

  func setUpstreamBody(_ body: MediaProxyUpstreamBody?) {
    let cancel = lock.castWithLock { () -> Bool in
      upstreamBody = body
      return disconnected
    }
    if cancel { body?.cancel() }
  }

  func cancel() {
    markDisconnected()
    connection.cancel()
  }

  func finish() {
    let shouldFinish = lock.castWithLock { () -> Bool in
      guard !finished else { return false }
      finished = true
      return true
    }
    guard shouldFinish else { return }
    connection.cancel()
    owner?.remove(self)
  }

  private func beginHandling() {
    let task = lock.castWithLock { () -> Task<Void, Never>? in
      guard handlingTask == nil, !disconnected, let owner else { return nil }
      let task = Task { await owner.handle(self) }
      handlingTask = task
      return task
    }
    if task == nil, isDisconnected { connection.cancel() }
  }

  private func markDisconnected() {
    let state = lock.castWithLock { () -> (Task<Void, Never>?, MediaProxyUpstreamBody?, Bool) in
      guard !disconnected else { return (nil, nil, false) }
      disconnected = true
      return (handlingTask, upstreamBody, true)
    }
    state.1?.cancel()
    state.0?.cancel()
    if state.2 { owner?.remove(self) }
  }

  private func expireIncompleteRequest() {
    if lock.castWithLock({ !requestReadFinished && !disconnected }) { cancel() }
  }
}

private final class CastRelayContinuationGate<Value>: @unchecked Sendable {
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
    lock.castWithLock {
      defer { continuation = nil }
      return continuation
    }
  }
}

private extension NSLock {
  func castWithLock<Result>(_ operation: () throws -> Result) rethrows -> Result {
    lock()
    defer { unlock() }
    return try operation()
  }
}
