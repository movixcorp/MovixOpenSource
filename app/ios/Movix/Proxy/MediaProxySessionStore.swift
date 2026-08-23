import Foundation
import Security

fileprivate final class MediaProxyLeaseState: @unchecked Sendable {
  var isReleased = false
}

fileprivate final class MediaProxySessionAccessState: @unchecked Sendable {
  private let lock = NSLock()
  private let clock: @Sendable () -> Date
  private let idleTTL: TimeInterval
  fileprivate let absoluteDeadline: Date
  private var idleDeadline: Date
  private var isValid = true

  init(
    clock: @escaping @Sendable () -> Date,
    createdAt: Date,
    idleTTL: TimeInterval,
    absoluteTTL: TimeInterval
  ) {
    self.clock = clock
    self.idleTTL = idleTTL
    absoluteDeadline = createdAt.addingTimeInterval(absoluteTTL)
    idleDeadline = min(
      createdAt.addingTimeInterval(idleTTL),
      absoluteDeadline
    )
  }

  fileprivate func synchronized<Result>(
    _ body: () throws -> Result
  ) rethrows -> Result {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  fileprivate func nowLocked() -> Date {
    clock()
  }

  fileprivate func isLiveLocked(at now: Date) -> Bool {
    guard isValid else { return false }
    guard now < absoluteDeadline, now < idleDeadline else {
      isValid = false
      return false
    }
    return true
  }

  fileprivate func refreshIdleDeadlineLocked(at now: Date) {
    guard isValid, now < absoluteDeadline else {
      isValid = false
      return
    }
    idleDeadline = min(
      absoluteDeadline,
      max(idleDeadline, now.addingTimeInterval(idleTTL))
    )
  }

  func refresh(at now: Date) -> Bool {
    synchronized {
      guard isLiveLocked(at: now) else { return false }
      refreshIdleDeadlineLocked(at: now)
      return true
    }
  }

  func isExpired(at now: Date) -> Bool {
    synchronized {
      !isLiveLocked(at: now)
    }
  }

  func revoke() {
    synchronized {
      isValid = false
    }
  }
}

fileprivate final class MediaProxyAccessBarrier: @unchecked Sendable {
  private let sessionAccessState: MediaProxySessionAccessState
  private var generation: UInt64 = 0
  private var isValid = true

  init(sessionAccessState: MediaProxySessionAccessState) {
    self.sessionAccessState = sessionAccessState
  }

  func makeLease() -> MediaProxyAccessLease? {
    sessionAccessState.synchronized {
      guard isValid,
            sessionAccessState.isLiveLocked(at: sessionAccessState.nowLocked()) else {
        return nil
      }
      return MediaProxyAccessLease(
        barrier: self,
        generation: generation,
        state: MediaProxyLeaseState()
      )
    }
  }

  func withValidAccess<Result>(
    generation candidateGeneration: UInt64,
    state: MediaProxyLeaseState,
    _ body: () throws -> Result
  ) rethrows -> Result? {
    try sessionAccessState.synchronized {
      let now = sessionAccessState.nowLocked()
      guard isValid,
            generation == candidateGeneration,
            !state.isReleased,
            sessionAccessState.isLiveLocked(at: now) else {
        return nil
      }
      let result = try body()
      sessionAccessState.refreshIdleDeadlineLocked(
        at: sessionAccessState.nowLocked()
      )
      return result
    }
  }

  func release(_ state: MediaProxyLeaseState) {
    sessionAccessState.synchronized {
      state.isReleased = true
    }
  }

  func revoke() {
    sessionAccessState.synchronized {
      isValid = false
      generation &+= 1
    }
  }
}

final class MediaProxyAccessLease: @unchecked Sendable {
  private let barrier: MediaProxyAccessBarrier
  private let generation: UInt64
  private let state: MediaProxyLeaseState

  fileprivate init(
    barrier: MediaProxyAccessBarrier,
    generation: UInt64,
    state: MediaProxyLeaseState
  ) {
    self.barrier = barrier
    self.generation = generation
    self.state = state
  }

  /// The body must be synchronous, short, and limited to enqueueing headers or
  /// one chunk. The same session lock enforces idle/absolute deadlines and
  /// revocation, then refreshes idle time only after a successful section.
  func withValidAccess<Result>(_ body: () throws -> Result) rethrows -> Result? {
    try barrier.withValidAccess(
      generation: generation,
      state: state,
      body
    )
  }

  func release() {
    barrier.release(state)
  }

  deinit {
    release()
  }
}

actor MediaProxySessionStore {
  nonisolated let processSecret: String

  private struct TargetHeader: Hashable, Sendable {
    let name: String
    let value: String
  }

  private struct TargetKey: Hashable, Sendable {
    let upstreamURL: String
    let method: String
    let headers: [TargetHeader]

    init(_ target: MediaProxyTarget) {
      upstreamURL = target.upstreamURL.absoluteString
      method = target.method
      headers = target.headers.map {
        TargetHeader(name: $0.key, value: $0.value)
      }.sorted { lhs, rhs in
        if lhs.name != rhs.name { return lhs.name < rhs.name }
        return lhs.value < rhs.value
      }
    }
  }

  private struct ResourceState: Sendable {
    let target: MediaProxyTarget
    let key: TargetKey
    var accessOrder: UInt64
    let accessBarrier: MediaProxyAccessBarrier
  }

  private struct SessionState: Sendable {
    let createdAt: Date
    let accessState: MediaProxySessionAccessState
    var accessOrder: UInt64
    let rootResourceID: String
    var resources: [String: ResourceState]
    var resourceIDsByTarget: [TargetKey: String]
  }

  private struct TransitionState: Sendable {
    let successorSessionID: String
    var resources: [String: MediaProxyRegistration]
    let expiresAt: Date
    var accessOrder: UInt64
  }

  private struct IdentifierTombstone: Sendable {
    let expiresAt: Date
    let accessOrder: UInt64
  }

  private static let tokenByteCount = 32
  private static let tokenCharacterCount = 43
  private static let maximumIdentifierAttempts = 16
  private static let defaultIdleTTL: TimeInterval = 120
  private static let defaultAbsoluteTTL: TimeInterval = 1_800
  private static let defaultRotationLeadTime: TimeInterval = 120
  private static let defaultTransitionGraceTTL: TimeInterval = 30
  private static let minimumExpiringTTL: TimeInterval = 1
  private static let maximumIdleTTL: TimeInterval = 1_800
  private static let maximumAbsoluteTTL: TimeInterval = 1_800
  private static let maximumRotationLeadTime: TimeInterval = 300
  private static let maximumTransitionGraceTTL: TimeInterval = 300

  private let clock: @Sendable () -> Date
  private let idleTTL: TimeInterval
  private let absoluteTTL: TimeInterval
  private let maximumSessions: Int
  private let maximumResourcesPerSession: Int
  private let rotationLeadTime: TimeInterval
  private let transitionGraceTTL: TimeInterval
  private let maximumTransitions: Int
  private let maximumIdentifierTombstones: Int
  private let identifierTombstoneTTL: TimeInterval
  private let tokenGenerator: @Sendable () -> String

  private var sessions: [String: SessionState] = [:]
  private var transitions: [String: TransitionState] = [:]
  private var identifierTombstones: [String: IdentifierTombstone] = [:]
  private var accessOrder: UInt64 = 0

  init(
    clock: @escaping @Sendable () -> Date = Date.init,
    idleTTL: TimeInterval = 120,
    absoluteTTL: TimeInterval = 1_800,
    maximumSessions: Int = 32,
    maximumResourcesPerSession: Int = 2_048,
    rotationLeadTime: TimeInterval = 120,
    transitionGraceTTL: TimeInterval = 30,
    maximumTransitions: Int = 64,
    maximumIdentifierTombstones: Int = 8_192
  ) {
    let generator: @Sendable () -> String = Self.makeSecureToken
    let secret = generator()
    precondition(Self.hasExactTokenSyntax(secret), "Secure token generation failed")
    let configuration = Self.normalizedConfiguration(
      idleTTL: idleTTL,
      absoluteTTL: absoluteTTL,
      rotationLeadTime: rotationLeadTime,
      transitionGraceTTL: transitionGraceTTL
    )
    processSecret = secret
    self.clock = clock
    self.idleTTL = configuration.idleTTL
    self.absoluteTTL = configuration.absoluteTTL
    self.maximumSessions = max(0, maximumSessions)
    self.maximumResourcesPerSession = max(0, maximumResourcesPerSession)
    self.rotationLeadTime = configuration.rotationLeadTime
    self.transitionGraceTTL = configuration.transitionGraceTTL
    self.maximumTransitions = max(0, maximumTransitions)
    self.maximumIdentifierTombstones = max(0, maximumIdentifierTombstones)
    identifierTombstoneTTL = configuration.absoluteTTL + configuration.transitionGraceTTL
    tokenGenerator = generator
  }

  init(
    clock: @escaping @Sendable () -> Date = Date.init,
    idleTTL: TimeInterval = 120,
    absoluteTTL: TimeInterval = 1_800,
    maximumSessions: Int = 32,
    maximumResourcesPerSession: Int = 2_048,
    rotationLeadTime: TimeInterval = 120,
    transitionGraceTTL: TimeInterval = 30,
    maximumTransitions: Int = 64,
    maximumIdentifierTombstones: Int = 8_192,
    tokenGenerator: @escaping @Sendable () -> String
  ) {
    let secret = tokenGenerator()
    precondition(Self.hasExactTokenSyntax(secret), "Secure token generation failed")
    let configuration = Self.normalizedConfiguration(
      idleTTL: idleTTL,
      absoluteTTL: absoluteTTL,
      rotationLeadTime: rotationLeadTime,
      transitionGraceTTL: transitionGraceTTL
    )
    processSecret = secret
    self.clock = clock
    self.idleTTL = configuration.idleTTL
    self.absoluteTTL = configuration.absoluteTTL
    self.maximumSessions = max(0, maximumSessions)
    self.maximumResourcesPerSession = max(0, maximumResourcesPerSession)
    self.rotationLeadTime = configuration.rotationLeadTime
    self.transitionGraceTTL = configuration.transitionGraceTTL
    self.maximumTransitions = max(0, maximumTransitions)
    self.maximumIdentifierTombstones = max(0, maximumIdentifierTombstones)
    identifierTombstoneTTL = configuration.absoluteTTL + configuration.transitionGraceTTL
    self.tokenGenerator = tokenGenerator
  }

  func registerLoopback(_ target: MediaProxyTarget) throws -> MediaProxyRegistration {
    let normalizedTarget = try normalize(target)
    let now = clock()
    purgeExpired(at: now)

    guard maximumSessions > 0, maximumResourcesPerSession > 0 else {
      throw MediaProxySessionStoreError.capacityExceeded
    }
    let evictedSessionID: String?
    if sessions.count >= maximumSessions {
      guard let candidate = leastRecentlyUsedSessionID() else {
        throw MediaProxySessionStoreError.capacityExceeded
      }
      evictedSessionID = candidate
    } else {
      evictedSessionID = nil
    }

    let sessionID = try generateUniqueIdentifier()
    let resourceID = try generateUniqueIdentifier(additionalReserved: [sessionID])
    let key = TargetKey(normalizedTarget)
    let sessionAccessState = MediaProxySessionAccessState(
      clock: clock,
      createdAt: now,
      idleTTL: idleTTL,
      absoluteTTL: absoluteTTL
    )
    let resource = ResourceState(
      target: normalizedTarget,
      key: key,
      accessOrder: nextAccessOrder(),
      accessBarrier: MediaProxyAccessBarrier(sessionAccessState: sessionAccessState)
    )
    let session = SessionState(
      createdAt: now,
      accessState: sessionAccessState,
      accessOrder: nextAccessOrder(),
      rootResourceID: resourceID,
      resources: [resourceID: resource],
      resourceIDsByTarget: [key: resourceID]
    )
    if let evictedSessionID = evictedSessionID {
      removeSession(evictedSessionID, at: now)
    }
    sessions[sessionID] = session
    return MediaProxyRegistration(sessionID: sessionID, resourceID: resourceID)
  }

  func localize(
    sessionID: String,
    target: MediaProxyTarget
  ) throws -> MediaProxyRegistration {
    guard Self.hasExactTokenSyntax(sessionID) else {
      throw MediaProxySessionStoreError.sessionUnavailable
    }
    let normalizedTarget = try normalize(target)
    let key = TargetKey(normalizedTarget)
    let now = clock()
    purgeExpired(at: now)
    guard var session = sessions[sessionID] else {
      throw MediaProxySessionStoreError.sessionUnavailable
    }

    if let existingID = session.resourceIDsByTarget[key],
       var existing = session.resources[existingID] {
      existing.accessOrder = nextAccessOrder()
      session.resources[existingID] = existing
      touch(&session, at: now)
      sessions[sessionID] = session
      return MediaProxyRegistration(sessionID: sessionID, resourceID: existingID)
    }

    let evictedResourceID: String?
    if session.resources.count >= maximumResourcesPerSession {
      guard let candidate = leastRecentlyUsedEvictableResourceID(in: session) else {
        throw MediaProxySessionStoreError.capacityExceeded
      }
      evictedResourceID = candidate
    } else {
      evictedResourceID = nil
    }

    let resourceID = try generateUniqueIdentifier()
    if let evictedResourceID = evictedResourceID {
      evictResource(
        evictedResourceID,
        sessionID: sessionID,
        session: &session,
        at: now
      )
    }
    session.resources[resourceID] = ResourceState(
      target: normalizedTarget,
      key: key,
      accessOrder: nextAccessOrder(),
      accessBarrier: MediaProxyAccessBarrier(sessionAccessState: session.accessState)
    )
    session.resourceIDsByTarget[key] = resourceID
    touch(&session, at: now)
    sessions[sessionID] = session
    return MediaProxyRegistration(sessionID: sessionID, resourceID: resourceID)
  }

  /// Atomically replaces a live session during its pre-expiry lead window. The
  /// previous IDs become redirect-only credentials and never expose media again.
  func rotate(sessionID: String) throws -> MediaProxySessionRotation {
    guard Self.hasExactTokenSyntax(sessionID) else {
      throw MediaProxySessionStoreError.sessionUnavailable
    }
    let now = clock()
    purgeExpired(at: now)
    guard let previous = sessions[sessionID] else {
      throw MediaProxySessionStoreError.sessionUnavailable
    }
    let absoluteExpiry = previous.createdAt.addingTimeInterval(absoluteTTL)
    guard now >= absoluteExpiry.addingTimeInterval(-rotationLeadTime) else {
      throw MediaProxySessionStoreError.rotationNotDue
    }
    guard maximumTransitions > 0 else {
      throw MediaProxySessionStoreError.capacityExceeded
    }

    var generated: Set<String> = []
    let successorSessionID = try generateUniqueIdentifier(additionalReserved: generated)
    generated.insert(successorSessionID)
    var registrations: [String: MediaProxyRegistration] = [:]
    var successorResources: [String: ResourceState] = [:]
    var successorIDsByTarget: [TargetKey: String] = [:]
    let successorAccessState = MediaProxySessionAccessState(
      clock: clock,
      createdAt: now,
      idleTTL: idleTTL,
      absoluteTTL: absoluteTTL
    )

    for previousResourceID in previous.resources.keys.sorted() {
      guard let previousResource = previous.resources[previousResourceID] else { continue }
      let successorResourceID = try generateUniqueIdentifier(additionalReserved: generated)
      generated.insert(successorResourceID)
      let registration = MediaProxyRegistration(
        sessionID: successorSessionID,
        resourceID: successorResourceID
      )
      registrations[previousResourceID] = registration
      successorResources[successorResourceID] = ResourceState(
        target: previousResource.target,
        key: previousResource.key,
        accessOrder: nextAccessOrder(),
        accessBarrier: MediaProxyAccessBarrier(sessionAccessState: successorAccessState)
      )
      successorIDsByTarget[previousResource.key] = successorResourceID
    }

    guard let successorRoot = registrations[previous.rootResourceID] else {
      throw MediaProxySessionStoreError.sessionUnavailable
    }
    revokeAccess(in: previous)
    sessions.removeValue(forKey: sessionID)
    sessions[successorSessionID] = SessionState(
      createdAt: now,
      accessState: successorAccessState,
      accessOrder: nextAccessOrder(),
      rootResourceID: successorRoot.resourceID,
      resources: successorResources,
      resourceIDsByTarget: successorIDsByTarget
    )
    retargetTransitions(
      from: sessionID,
      to: successorSessionID,
      registrations: registrations,
      at: now
    )
    makeRoomForTransition(at: now)
    transitions[sessionID] = TransitionState(
      successorSessionID: successorSessionID,
      resources: registrations,
      expiresAt: absoluteExpiry.addingTimeInterval(transitionGraceTTL),
      accessOrder: nextAccessOrder()
    )
    return MediaProxySessionRotation(
      previousSessionID: sessionID,
      successorSessionID: successorSessionID,
      resources: registrations
    )
  }

  /// Task 4 must exclusively use this method when serving bytes. Every
  /// synchronous header or chunk enqueue must run inside `withValidAccess`, and
  /// the lease must be released when the response finishes.
  func resolveLoopbackRequestWithLease(
    processSecret candidateSecret: String,
    sessionID: String,
    resourceID: String
  ) -> MediaProxyLeasedResolution? {
    guard Self.hasExactTokenSyntax(candidateSecret),
          Self.hasExactTokenSyntax(sessionID),
          Self.hasExactTokenSyntax(resourceID),
          Self.constantTimeEqual(candidateSecret, processSecret) else {
      return nil
    }

    let now = clock()
    purgeExpired(at: now)
    if var session = sessions[sessionID], var resource = session.resources[resourceID] {
      guard let lease = resource.accessBarrier.makeLease() else { return nil }
      resource.accessOrder = nextAccessOrder()
      session.resources[resourceID] = resource
      touch(&session, at: now)
      sessions[sessionID] = session
      return .resource(MediaProxyLeasedResource(
        resource: MediaProxyResource(
          sessionID: sessionID,
          resourceID: resourceID,
          target: resource.target
        ),
        lease: lease
      ))
    }
    if var transition = transitions[sessionID],
       let successor = transition.resources[resourceID] {
      transition.accessOrder = nextAccessOrder()
      transitions[sessionID] = transition
      return .redirect(successor)
    }
    return nil
  }

  /// Compatibility-only metadata resolution. Byte-serving code must use
  /// `resolveLoopbackRequestWithLease` so lifecycle invalidation can revoke it.
  func resolveLoopbackRequest(
    processSecret candidateSecret: String,
    sessionID: String,
    resourceID: String
  ) -> MediaProxyResolution? {
    guard let resolution = resolveLoopbackRequestWithLease(
      processSecret: candidateSecret,
      sessionID: sessionID,
      resourceID: resourceID
    ) else { return nil }
    switch resolution {
    case let .resource(leasedResource):
      leasedResource.lease.release()
      return .resource(leasedResource.resource)
    case let .redirect(registration):
      return .redirect(registration)
    }
  }

  func resolveLoopback(
    processSecret candidateSecret: String,
    sessionID: String,
    resourceID: String
  ) -> MediaProxyResource? {
    guard case let .resource(resource)? = resolveLoopbackRequest(
      processSecret: candidateSecret,
      sessionID: sessionID,
      resourceID: resourceID
    ) else { return nil }
    return resource
  }

  func resolveLoopbackURLForCast(_ url: URL) -> MediaProxyTarget? {
    guard let registration = parseCanonicalLoopbackURL(url),
          case let .resource(resource)? = resolveLoopbackRequest(
            processSecret: registration.processSecret,
            sessionID: registration.sessionID,
            resourceID: registration.resourceID
          ) else {
      return nil
    }
    return resource.target
  }

  func invalidate(sessionID: String) {
    guard Self.hasExactTokenSyntax(sessionID) else { return }
    let now = clock()
    if sessions[sessionID] != nil {
      removeSession(sessionID, at: now)
    }
    if transitions[sessionID] != nil {
      removeTransition(sessionID, at: now)
    }
  }

  func invalidateAll() {
    let now = clock()
    for sessionID in sessions.keys.sorted() {
      removeSession(sessionID, at: now)
    }
    for sessionID in transitions.keys.sorted() {
      removeTransition(sessionID, at: now)
    }
  }

  func diagnostics() -> MediaProxySessionStoreDiagnostics {
    purgeExpired(at: clock())
    return MediaProxySessionStoreDiagnostics(
      activeSessionCount: sessions.count,
      activeResourceCount: sessions.values.reduce(0) { $0 + $1.resources.count },
      transitionCount: transitions.count,
      transitionResourceCount: transitions.values.reduce(0) { $0 + $1.resources.count },
      identifierTombstoneCount: identifierTombstones.count
    )
  }

  func configuration() -> MediaProxySessionStoreConfiguration {
    MediaProxySessionStoreConfiguration(
      idleTTL: idleTTL,
      absoluteTTL: absoluteTTL,
      rotationLeadTime: rotationLeadTime,
      transitionGraceTTL: transitionGraceTTL
    )
  }

  private func normalize(_ target: MediaProxyTarget) throws -> MediaProxyTarget {
    let method = target.method.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard method == "GET" || method == "HEAD",
          let upstreamURL = try? MediaProxyPolicy.validatePublicHTTPSURLSyntax(
            target.upstreamURL.absoluteString
          ) else {
      throw MediaProxySessionStoreError.invalidTarget
    }
    return MediaProxyTarget(
      upstreamURL: upstreamURL,
      method: method,
      headers: MediaProxyPolicy.sanitizeRequestHeaders(target.headers)
    )
  }

  private static func normalizedConfiguration(
    idleTTL: TimeInterval,
    absoluteTTL: TimeInterval,
    rotationLeadTime: TimeInterval,
    transitionGraceTTL: TimeInterval
  ) -> MediaProxySessionStoreConfiguration {
    // Initializers stay nonthrowing for compatibility. Non-finite inputs fall
    // back to defaults; finite values are bounded to 1...1_800 seconds for
    // expiry TTLs, 1...300 for rotation lead, and 0...300 for redirect grace.
    let normalizedAbsoluteTTL = normalizedDuration(
      absoluteTTL,
      default: defaultAbsoluteTTL,
      minimum: minimumExpiringTTL,
      maximum: maximumAbsoluteTTL
    )
    return MediaProxySessionStoreConfiguration(
      idleTTL: normalizedDuration(
        idleTTL,
        default: defaultIdleTTL,
        minimum: minimumExpiringTTL,
        maximum: maximumIdleTTL
      ),
      absoluteTTL: normalizedAbsoluteTTL,
      rotationLeadTime: normalizedDuration(
        rotationLeadTime,
        default: defaultRotationLeadTime,
        minimum: minimumExpiringTTL,
        maximum: min(maximumRotationLeadTime, normalizedAbsoluteTTL)
      ),
      transitionGraceTTL: normalizedDuration(
        transitionGraceTTL,
        default: defaultTransitionGraceTTL,
        minimum: 0,
        maximum: maximumTransitionGraceTTL
      )
    )
  }

  private static func normalizedDuration(
    _ value: TimeInterval,
    default defaultValue: TimeInterval,
    minimum: TimeInterval,
    maximum: TimeInterval
  ) -> TimeInterval {
    let finiteValue = value.isFinite ? value : defaultValue
    return min(max(finiteValue, minimum), maximum)
  }

  private struct ParsedLoopbackRegistration {
    let processSecret: String
    let sessionID: String
    let resourceID: String
  }

  private func parseCanonicalLoopbackURL(_ url: URL) -> ParsedLoopbackRegistration? {
    let raw = url.absoluteString
    guard raw.hasPrefix("http://"),
          let pathStart = raw.dropFirst("http://".count).firstIndex(of: "/") else {
      return nil
    }
    let authorityStart = raw.index(raw.startIndex, offsetBy: "http://".count)
    let rawAuthority = String(raw[authorityStart..<pathStart])
    guard let (canonicalAuthority, expectedHost, expectedPort) =
      Self.canonicalLoopbackAuthority(rawAuthority),
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme == "http",
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.host == expectedHost || components.host == "[\(expectedHost)]",
      components.port == expectedPort else {
      return nil
    }

    let path = components.percentEncodedPath
    guard !path.contains("%"),
          raw == "http://\(canonicalAuthority)\(path)" else {
      return nil
    }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 5,
          segments[0].isEmpty,
          segments[1] == "p" else {
      return nil
    }
    let candidateSecret = String(segments[2])
    let sessionID = String(segments[3])
    let resourceID = String(segments[4])
    guard Self.hasExactTokenSyntax(candidateSecret),
          Self.hasExactTokenSyntax(sessionID),
          Self.hasExactTokenSyntax(resourceID),
          path == "/p/\(candidateSecret)/\(sessionID)/\(resourceID)" else {
      return nil
    }
    return ParsedLoopbackRegistration(
      processSecret: candidateSecret,
      sessionID: sessionID,
      resourceID: resourceID
    )
  }

  private static func canonicalLoopbackAuthority(
    _ authority: String
  ) -> (authority: String, host: String, port: Int)? {
    let host: String
    let portText: String
    if authority.hasPrefix("127.0.0.1:") {
      host = "127.0.0.1"
      portText = String(authority.dropFirst("127.0.0.1:".count))
    } else if authority.hasPrefix("[::1]:") {
      host = "::1"
      portText = String(authority.dropFirst("[::1]:".count))
    } else {
      return nil
    }
    guard !portText.isEmpty,
          portText.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
          let port = Int(portText),
          (1...65_535).contains(port),
          portText == String(port) else {
      return nil
    }
    let canonicalHost = host == "::1" ? "[::1]" : host
    return ("\(canonicalHost):\(port)", host, port)
  }

  private func touch(_ session: inout SessionState, at now: Date) {
    _ = session.accessState.refresh(at: now)
    session.accessOrder = nextAccessOrder()
  }

  private func purgeExpired(at now: Date) {
    purgeIdentifierTombstones(at: now)
    let expiredTransitions = transitions.compactMap { sessionID, transition in
      now >= transition.expiresAt ? sessionID : nil
    }.sorted()
    for sessionID in expiredTransitions {
      removeTransition(sessionID, at: now)
    }
    let expiredSessions = sessions.compactMap { sessionID, session in
      isExpired(session, at: now) ? sessionID : nil
    }.sorted()
    for sessionID in expiredSessions {
      removeSession(sessionID, at: now)
    }
  }

  private func isExpired(_ session: SessionState, at now: Date) -> Bool {
    session.accessState.isExpired(at: now)
  }

  private func leastRecentlyUsedSessionID() -> String? {
    sessions.min(by: { lhs, rhs in
      if lhs.value.accessOrder != rhs.value.accessOrder {
        return lhs.value.accessOrder < rhs.value.accessOrder
      }
      return lhs.key < rhs.key
    })?.key
  }

  private func leastRecentlyUsedEvictableResourceID(
    in session: SessionState
  ) -> String? {
    session.resources.filter({ $0.key != session.rootResourceID }).min(by: {
      if $0.value.accessOrder != $1.value.accessOrder {
        return $0.value.accessOrder < $1.value.accessOrder
      }
      return $0.key < $1.key
    })?.key
  }

  private func evictResource(
    _ resourceID: String,
    sessionID: String,
    session: inout SessionState,
    at now: Date
  ) {
    guard let removed = session.resources.removeValue(forKey: resourceID) else {
      return
    }
    removed.accessBarrier.revoke()
    session.resourceIDsByTarget.removeValue(forKey: removed.key)
    retireIdentifier(resourceID, at: now)
    pruneTransitionDestinations(
      successorSessionID: sessionID,
      resourceID: resourceID,
      at: now
    )
  }

  private func removeSession(_ sessionID: String, at now: Date) {
    guard let removed = sessions[sessionID] else { return }
    revokeAccess(in: removed)
    sessions.removeValue(forKey: sessionID)
    retireIdentifier(sessionID, at: now)
    for resourceID in removed.resources.keys.sorted() {
      retireIdentifier(resourceID, at: now)
    }
    for transitionID in transitions.compactMap({ key, value in
      value.successorSessionID == sessionID ? key : nil
    }).sorted() {
      removeTransition(transitionID, at: now)
    }
  }

  private func revokeAccess(in session: SessionState) {
    session.accessState.revoke()
  }

  private func removeTransition(_ sessionID: String, at now: Date) {
    guard let removed = transitions.removeValue(forKey: sessionID) else { return }
    retireIdentifier(sessionID, at: now)
    for resourceID in removed.resources.keys.sorted() {
      retireIdentifier(resourceID, at: now)
    }
  }

  private func retargetTransitions(
    from previousSessionID: String,
    to successorSessionID: String,
    registrations: [String: MediaProxyRegistration],
    at now: Date
  ) {
    for transitionID in transitions.keys.sorted() {
      guard var transition = transitions[transitionID],
            transition.successorSessionID == previousSessionID else { continue }
      transition.resources = transition.resources.reduce(into: [:]) { output, entry in
        if let successor = registrations[entry.value.resourceID] {
          output[entry.key] = successor
        }
      }
      if transition.resources.isEmpty {
        removeTransition(transitionID, at: now)
      } else {
        transitions[transitionID] = TransitionState(
          successorSessionID: successorSessionID,
          resources: transition.resources,
          expiresAt: transition.expiresAt,
          accessOrder: transition.accessOrder
        )
      }
    }
  }

  private func pruneTransitionDestinations(
    successorSessionID: String,
    resourceID: String,
    at now: Date
  ) {
    for transitionID in transitions.keys.sorted() {
      guard var transition = transitions[transitionID],
            transition.successorSessionID == successorSessionID else { continue }
      transition.resources = transition.resources.filter { $0.value.resourceID != resourceID }
      if transition.resources.isEmpty {
        removeTransition(transitionID, at: now)
      } else {
        transitions[transitionID] = transition
      }
    }
  }

  private func makeRoomForTransition(at now: Date) {
    while transitions.count >= maximumTransitions {
      guard let transitionID = transitions.min(by: { lhs, rhs in
        if lhs.value.expiresAt != rhs.value.expiresAt {
          return lhs.value.expiresAt < rhs.value.expiresAt
        }
        if lhs.value.accessOrder != rhs.value.accessOrder {
          return lhs.value.accessOrder < rhs.value.accessOrder
        }
        return lhs.key < rhs.key
      })?.key else { return }
      removeTransition(transitionID, at: now)
    }
  }

  private func retireIdentifier(_ identifier: String, at now: Date) {
    guard maximumIdentifierTombstones > 0 else { return }
    purgeIdentifierTombstones(at: now)
    while identifierTombstones[identifier] == nil
      && identifierTombstones.count >= maximumIdentifierTombstones {
      guard let oldest = identifierTombstones.min(by: { lhs, rhs in
        if lhs.value.expiresAt != rhs.value.expiresAt {
          return lhs.value.expiresAt < rhs.value.expiresAt
        }
        if lhs.value.accessOrder != rhs.value.accessOrder {
          return lhs.value.accessOrder < rhs.value.accessOrder
        }
        return lhs.key < rhs.key
      })?.key else { break }
      identifierTombstones.removeValue(forKey: oldest)
    }
    identifierTombstones[identifier] = IdentifierTombstone(
      expiresAt: now.addingTimeInterval(identifierTombstoneTTL),
      accessOrder: nextAccessOrder()
    )
  }

  private func purgeIdentifierTombstones(at now: Date) {
    for identifier in identifierTombstones.compactMap({ key, value in
      now >= value.expiresAt ? key : nil
    }) {
      identifierTombstones.removeValue(forKey: identifier)
    }
  }

  private func nextAccessOrder() -> UInt64 {
    accessOrder &+= 1
    return accessOrder
  }

  private func generateUniqueIdentifier(
    additionalReserved: Set<String> = []
  ) throws -> String {
    for _ in 0..<Self.maximumIdentifierAttempts {
      let candidate = tokenGenerator()
      if Self.hasExactTokenSyntax(candidate),
         !additionalReserved.contains(candidate),
         !isIdentifierReserved(candidate) {
        return candidate
      }
    }
    throw MediaProxySessionStoreError.identifierGenerationFailed
  }

  private func isIdentifierReserved(_ candidate: String) -> Bool {
    if Self.constantTimeEqual(candidate, processSecret)
      || identifierTombstones[candidate] != nil
      || sessions[candidate] != nil
      || transitions[candidate] != nil {
      return true
    }
    if sessions.values.contains(where: { $0.resources[candidate] != nil }) {
      return true
    }
    return transitions.values.contains { transition in
      transition.resources[candidate] != nil
        || transition.resources.values.contains { $0.resourceID == candidate }
    }
  }

  private static func makeSecureToken() -> String {
    var bytes = [UInt8](repeating: 0, count: tokenByteCount)
    let status = bytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    precondition(status == errSecSuccess, "Secure token generation failed")
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func hasExactTokenSyntax(_ token: String) -> Bool {
    guard token.utf8.count == tokenCharacterCount else { return false }
    return token.utf8.allSatisfy { byte in
      (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || (byte >= 48 && byte <= 57)
        || byte == 45
        || byte == 95
    }
  }

  private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    guard left.count == right.count else { return false }
    var difference: UInt8 = 0
    for index in left.indices {
      difference |= left[index] ^ right[index]
    }
    return difference == 0
  }
}
