import Foundation

/// Bridge React Native pour le module DNS iOS.
@objc(DnsModule)
final class DnsModuleBridge: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc
  func enable(
    _ primaryDns: String,
    secondaryDns: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DnsManager.enable(
      primaryDns: primaryDns,
      secondaryDns: secondaryDns,
      resolve: resolve,
      reject: reject
    )
  }

  @objc
  func disable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DnsManager.disable(resolve: resolve, reject: reject)
  }

  @objc
  func isEnabled(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DnsManager.isEnabled(resolve: resolve, reject: reject)
  }
}
