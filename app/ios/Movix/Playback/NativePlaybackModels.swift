import CoreFoundation
import Foundation

enum NativePlaybackError: Error, Equatable {
  case unsupported
  case invalidSource
  case sourceNotOwned
  case sourceBusy
  case invalidHandoff
  case prepareFailed
  case seekFailed
  case notPossible
  case enterFailed
  case handoffTimeout
  case restoreTimeout
  case restoreFailed
  case cancelled

  var code: String {
    switch self {
    case .unsupported: return "PIP_UNSUPPORTED"
    case .invalidSource: return "PIP_INVALID_SOURCE"
    case .sourceNotOwned: return "PIP_SOURCE_NOT_OWNED"
    case .sourceBusy: return "PIP_SOURCE_BUSY"
    case .invalidHandoff: return "PIP_INVALID_HANDOFF"
    case .prepareFailed: return "PIP_PREPARE_FAILED"
    case .seekFailed: return "PIP_SEEK_FAILED"
    case .notPossible: return "PIP_NOT_POSSIBLE"
    case .enterFailed: return "PIP_ENTER_FAILED"
    case .handoffTimeout: return "PIP_HANDOFF_TIMEOUT"
    case .restoreTimeout: return "PIP_RESTORE_TIMEOUT"
    case .restoreFailed: return "PIP_RESTORE_FAILED"
    case .cancelled: return "PIP_CANCELLED"
    }
  }
}
struct PreparedNativePlaybackSource: Equatable {
  static let preparedSourceProtocolVersion = 1
  static let maximumPositionSec: TimeInterval = 366 * 86_400

  let protocolVersion: Int
  let handoffId: String
  let url: URL
  let positionSec: TimeInterval
  let paused: Bool
  let playbackRate: Float
  let muted: Bool
  let title: String?
  let posterURL: URL?

  static func decode(
    _ dictionary: NSDictionary,
    handoffId candidateHandoffID: Any
  ) throws -> PreparedNativePlaybackSource {
    guard let handoffId = candidateHandoffID as? String,
          isValidHandoffID(handoffId) else {
      throw NativePlaybackError.invalidHandoff
    }
    guard let protocolNumber = strictNumber(dictionary["protocolVersion"]),
          protocolNumber.doubleValue == Double(preparedSourceProtocolVersion),
          let rawURL = dictionary["url"] as? String,
          let url = canonicalLoopbackURL(rawURL),
          let positionNumber = strictNumber(dictionary["positionSec"]),
          positionNumber.doubleValue.isFinite,
          (0...maximumPositionSec).contains(positionNumber.doubleValue),
          let paused = strictBool(dictionary["paused"]),
          let playbackRateNumber = strictNumber(dictionary["playbackRate"]),
          playbackRateNumber.doubleValue.isFinite,
          (0.25...4).contains(playbackRateNumber.doubleValue),
          let muted = strictBool(dictionary["muted"]) else {
      throw NativePlaybackError.invalidSource
    }

    let title: String?
    if let value = dictionary["title"] {
      guard let candidate = value as? String, candidate.utf16.count <= 256 else {
        throw NativePlaybackError.invalidSource
      }
      title = candidate
    } else {
      title = nil
    }

    let posterURL: URL?
    if let value = dictionary["poster"] {
      guard let candidate = value as? String,
            candidate.utf16.count <= 16_384,
            let poster = canonicalHTTPSURL(candidate) else {
        throw NativePlaybackError.invalidSource
      }
      posterURL = poster
    } else {
      posterURL = nil
    }

    return PreparedNativePlaybackSource(
      protocolVersion: preparedSourceProtocolVersion,
      handoffId: handoffId,
      url: url,
      positionSec: positionNumber.doubleValue,
      paused: paused,
      playbackRate: Float(playbackRateNumber.doubleValue),
      muted: muted,
      title: title,
      posterURL: posterURL
    )
  }

  static func isValidHandoffID(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (16...128).contains(bytes.count) else { return false }
    return bytes.allSatisfy { byte in
      (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 45
        || byte == 95
    }
  }

  private static func strictNumber(_ value: Any?) -> NSNumber? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    return number
  }

  private static func strictBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else {
      return nil
    }
    return number.boolValue
  }

  private static func canonicalLoopbackURL(_ raw: String) -> URL? {
    guard isSafeURLText(raw),
          raw.hasPrefix("http://127.0.0.1:"),
          let pathStart = raw.dropFirst("http://127.0.0.1:".count).firstIndex(of: "/") else {
      return nil
    }
    let portStart = raw.index(raw.startIndex, offsetBy: "http://127.0.0.1:".count)
    let portText = String(raw[portStart..<pathStart])
    guard !portText.isEmpty,
          portText.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
          let port = Int(portText),
          (1...65_535).contains(port),
          portText == String(port) else {
      return nil
    }
    let path = String(raw[pathStart...])
    guard !path.contains("%"),
          !path.contains("?"),
          !path.contains("#") else {
      return nil
    }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 5,
          segments[0].isEmpty,
          segments[1] == "p",
          isToken(String(segments[2])),
          isToken(String(segments[3])),
          isToken(String(segments[4])),
          let components = URLComponents(string: raw),
          components.scheme == "http",
          components.host == "127.0.0.1",
          components.port == port,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.percentEncodedPath == path,
          let url = components.url,
          url.absoluteString == raw else {
      return nil
    }
    return url
  }

  private static func canonicalHTTPSURL(_ raw: String) -> URL? {
    guard !raw.isEmpty,
          isSafeURLText(raw),
          let components = URLComponents(string: raw),
          components.scheme == "https",
          components.host?.isEmpty == false,
          components.user == nil,
          components.password == nil,
          let url = components.url,
          url.absoluteString == raw else {
      return nil
    }
    return url
  }

  private static func isSafeURLText(_ value: String) -> Bool {
    !value.unicodeScalars.contains { scalar in
      scalar.value <= 0x20 || scalar.value == 0x7f || scalar.value == 0x5c
    }
  }

  private static func isToken(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 43 else { return false }
    return bytes.allSatisfy { byte in
      (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 45
        || byte == 95
    }
  }
}

enum NativePlaybackEvent: Equatable {
  case ready(handoffId: String)
  case state(handoffId: String, active: Bool)
  case restore(handoffId: String, positionSec: TimeInterval, paused: Bool)
  case error(handoffId: String, code: String)

  var payload: [String: Any] {
    switch self {
    case let .ready(handoffId):
      return ["kind": "ready", "handoffId": handoffId]
    case let .state(handoffId, active):
      return ["kind": "state", "handoffId": handoffId, "active": active]
    case let .restore(handoffId, positionSec, paused):
      return [
        "kind": "restore",
        "handoffId": handoffId,
        "positionSec": positionSec,
        "paused": paused,
      ]
    case let .error(handoffId, code):
      return ["kind": "error", "handoffId": handoffId, "code": code]
    }
  }
}

struct NativePlaybackRestoreSnapshot: Equatable {
  let handoffId: String
  let positionSec: TimeInterval
  let paused: Bool
}
