import Foundation
import Network
import NetworkExtension

private enum DnsError: String {
  case invalidServer = "DNS_INVALID_SERVER"
  case loadFailed = "DNS_LOAD_FAILED"
  case saveFailed = "DNS_SAVE_FAILED"
  case removeFailed = "DNS_REMOVE_FAILED"

  var message: String {
    switch self {
    case .invalidServer:
      return "Invalid DNS server configuration"
    case .loadFailed:
      return "Unable to load DNS settings"
    case .saveFailed:
      return "Unable to save DNS settings"
    case .removeFailed:
      return "Unable to remove DNS settings"
    }
  }
}

private final class DnsPromiseCompletion {
  private let lock = NSLock()
  private var completed = false
  private let resolveBlock: RCTPromiseResolveBlock
  private let rejectBlock: RCTPromiseRejectBlock
  private let onComplete: () -> Void

  init(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    onComplete: @escaping () -> Void
  ) {
    resolveBlock = resolve
    rejectBlock = reject
    self.onComplete = onComplete
  }

  func resolve(_ value: Any) {
    guard beginCompletion() else { return }
    resolveBlock(value)
    onComplete()
  }

  func reject(_ error: DnsError) {
    guard beginCompletion() else { return }
    rejectBlock(error.rawValue, error.message, nil)
    onComplete()
  }

  private func beginCompletion() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !completed else { return false }
    completed = true
    return true
  }
}

/// Serializes asynchronous preference transactions so two bridge calls cannot
/// interleave their load/mutate/save sequences on the shared system manager.
private final class DnsOperationScheduler {
  typealias Operation = (@escaping () -> Void) -> Void

  private let queue = DispatchQueue(label: "com.movix.dns-settings")
  private var pending = [Operation]()
  private var operationIsRunning = false

  func enqueue(_ operation: @escaping Operation) {
    queue.async { [weak self] in
      guard let self else { return }
      pending.append(operation)
      startNextIfNeeded()
    }
  }

  private func startNextIfNeeded() {
    guard !operationIsRunning, !pending.isEmpty else { return }
    operationIsRunning = true
    let operation = pending.removeFirst()
    operation { [weak self] in
      self?.queue.async { [weak self] in
        guard let self else { return }
        operationIsRunning = false
        startNextIfNeeded()
      }
    }
  }
}

/// Gestion du DNS via NEDNSSettingsManager et DNS-over-HTTPS (iOS 14+).
@objc(DnsManager)
final class DnsManager: NSObject {
  private static let scheduler = DnsOperationScheduler()
  private static let dohEndpointString = "https://cloudflare-dns.com/dns-query"

  @objc
  static func enable(
    primaryDns: String,
    secondaryDns: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      isIPAddressLiteral(primaryDns),
      isIPAddressLiteral(secondaryDns),
      let endpoint = URL(string: dohEndpointString),
      endpoint.scheme?.lowercased() == "https",
      endpoint.host != nil
    else {
      DnsPromiseCompletion(
        resolve: resolve,
        reject: reject,
        onComplete: {}
      ).reject(.invalidServer)
      return
    }

    scheduler.enqueue { finish in
      let completion = DnsPromiseCompletion(
        resolve: resolve,
        reject: reject,
        onComplete: finish
      )
      let manager = NEDNSSettingsManager.shared()
      manager.loadFromPreferences { error in
        guard error == nil else {
          completion.reject(.loadFailed)
          return
        }

        let settings = NEDNSOverHTTPSSettings(servers: [primaryDns, secondaryDns])
        settings.serverURL = endpoint
        manager.dnsSettings = settings
        manager.saveToPreferences { error in
          guard error == nil else {
            completion.reject(.saveFailed)
            return
          }

          // Saving installs the configuration, but iOS still requires the user
          // to enable it in Settings. Reload so the promise reports the actual
          // system state instead of claiming that the DNS is already active.
          manager.loadFromPreferences { error in
            guard error == nil else {
              completion.reject(.loadFailed)
              return
            }
            completion.resolve(manager.isEnabled)
          }
        }
      }
    }
  }

  @objc
  static func disable(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    scheduler.enqueue { finish in
      let completion = DnsPromiseCompletion(
        resolve: resolve,
        reject: reject,
        onComplete: finish
      )
      let manager = NEDNSSettingsManager.shared()
      manager.loadFromPreferences { error in
        guard error == nil else {
          completion.reject(.loadFailed)
          return
        }

        manager.removeFromPreferences { error in
          guard error == nil else {
            completion.reject(.removeFailed)
            return
          }
          completion.resolve(true)
        }
      }
    }
  }

  @objc
  static func isEnabled(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    scheduler.enqueue { finish in
      let completion = DnsPromiseCompletion(
        resolve: resolve,
        reject: reject,
        onComplete: finish
      )
      let manager = NEDNSSettingsManager.shared()
      manager.loadFromPreferences { error in
        guard error == nil else {
          completion.reject(.loadFailed)
          return
        }

        guard
          manager.isEnabled,
          let settings = manager.dnsSettings as? NEDNSOverHTTPSSettings,
          let serverURL = settings.serverURL,
          serverURL.scheme?.lowercased() == "https",
          serverURL.host != nil
        else {
          completion.resolve(false)
          return
        }
        completion.resolve(true)
      }
    }
  }

  private static func isIPAddressLiteral(_ server: String) -> Bool {
    guard
      !server.isEmpty,
      server.count <= 64,
      !server.contains("%"),
      server.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else {
      return false
    }
    return IPv4Address(server) != nil || IPv6Address(server) != nil
  }
}
