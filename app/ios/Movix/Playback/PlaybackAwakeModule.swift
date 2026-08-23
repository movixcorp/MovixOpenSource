import Foundation
import UIKit

@objc(PlaybackAwake)
final class PlaybackAwakeModule: NSObject {
  private static let allowedOwners: Set<String> = ["local-playback", "pip", "cast"]
  private let setIdleTimerDisabled: (Bool) -> Void
  private var owners = Set<String>()
  private var invalidated = false

  override init() {
    setIdleTimerDisabled = { UIApplication.shared.isIdleTimerDisabled = $0 }
    super.init()
  }

  init(setIdleTimerDisabled: @escaping (Bool) -> Void) {
    self.setIdleTimerDisabled = setIdleTimerDisabled
    super.init()
  }

  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func setLocalPlaybackAwake(_ active: Bool) {
    setOwner("local-playback", active: active)
  }

  @objc func setPlaybackAwakeOwner(_ owner: String, active: Bool) {
    guard
      Self.allowedOwners.contains(owner),
      owner.range(of: #"^[a-z0-9-]{1,32}$"#, options: .regularExpression) != nil
    else {
      return
    }
    setOwner(owner, active: active)
  }

  @objc func invalidate() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async {
        self.invalidate()
      }
      return
    }
    guard !invalidated else { return }
    invalidated = true
    owners.removeAll()
    setIdleTimerDisabled(false)
  }

  private func setOwner(_ owner: String, active: Bool) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.setOwner(owner, active: active)
      }
      return
    }
    guard !invalidated else { return }

    let changed: Bool
    if active {
      changed = owners.insert(owner).inserted
    } else {
      changed = owners.remove(owner) != nil
    }
    guard changed else { return }
    setIdleTimerDisabled(!owners.isEmpty)
  }
}
