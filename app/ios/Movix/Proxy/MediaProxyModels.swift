import Foundation

struct MediaProxyTarget: Equatable, Sendable {
  let upstreamURL: URL
  let method: String
  let headers: [String: String]
}

struct MediaProxyRegistration: Equatable, Sendable {
  let sessionID: String
  let resourceID: String
}

struct MediaProxyResource: Equatable, Sendable {
  let sessionID: String
  let resourceID: String
  let target: MediaProxyTarget
}

enum MediaProxyResolution: Equatable, Sendable {
  case resource(MediaProxyResource)
  case redirect(MediaProxyRegistration)
}

struct MediaProxyLeasedResource: Sendable {
  let resource: MediaProxyResource
  let lease: MediaProxyAccessLease
}

enum MediaProxyLeasedResolution: Sendable {
  case resource(MediaProxyLeasedResource)
  case redirect(MediaProxyRegistration)
}

struct MediaProxySessionRotation: Equatable, Sendable {
  let previousSessionID: String
  let successorSessionID: String
  /// Maps each previous resource ID to the successor registration that replaces it.
  let resources: [String: MediaProxyRegistration]
}

struct MediaProxySessionStoreDiagnostics: Equatable, Sendable {
  let activeSessionCount: Int
  let activeResourceCount: Int
  let transitionCount: Int
  let transitionResourceCount: Int
  let identifierTombstoneCount: Int
}

struct MediaProxySessionStoreConfiguration: Equatable, Sendable {
  let idleTTL: TimeInterval
  let absoluteTTL: TimeInterval
  let rotationLeadTime: TimeInterval
  let transitionGraceTTL: TimeInterval
}

enum MediaProxySessionStoreError: Error, Equatable {
  case invalidTarget
  case capacityExceeded
  case identifierGenerationFailed
  case sessionUnavailable
  case rotationNotDue
}
