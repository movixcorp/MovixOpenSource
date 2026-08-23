import AVKit
import Foundation
import React

@objc(PictureInPicture)
final class PictureInPictureModule: RCTEventEmitter {
  private static let eventName = "MOVIX_PICTURE_IN_PICTURE"
  private static let genericFailureMessage = "Picture in Picture request failed."

  private let invalidationLock = NSLock()
  private var controller: NativePlaybackController?
  private var invalidationRequested = false

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func constantsToExport() -> [AnyHashable: Any]! {
    [
      "preparedSourceProtocolVersion": PreparedNativePlaybackSource.preparedSourceProtocolVersion,
    ]
  }

  override func supportedEvents() -> [String]! {
    ["MOVIX_PICTURE_IN_PICTURE"]
  }

  @objc
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) {
      AVPictureInPictureController.isPictureInPictureSupported()
    }
  }

  @objc
  func setPlaybackActive(_ active: Bool) {
    Task { @MainActor [weak self] in
      guard let self = self, !self.hasRequestedInvalidation() else { return }
      guard let controller = try? self.requireController() else { return }
      controller.setPlaybackActive(active)
    }
  }

  @objc
  func prepare(
    _ dictionary: NSDictionary,
    handoffId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      let source = try PreparedNativePlaybackSource.decode(
        dictionary,
        handoffId: handoffId
      )
      try await self.requireController().prepare(source, handoffId: handoffId)
      return nil
    }
  }

  @objc
  func acknowledgeWebViewPaused(
    _ handoffId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      try self.requireController().acknowledgeWebViewPaused(handoffId)
      return nil
    }
  }

  @objc
  func acknowledgeRestoreApplied(
    _ handoffId: String,
    ok: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      try self.requireController().acknowledgeRestoreApplied(handoffId, ok: ok)
      return nil
    }
  }

  @objc
  func cancel(
    _ handoffId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      try self.requireController().cancel(handoffId)
      return nil
    }
  }

  @objc
  func enter(
    _ handoffId: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      try await self.requireController().enterPictureInPicture(handoffId)
      return nil
    }
  }

  @objc
  func exit(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runPromise(resolve: resolve, reject: reject) { [weak self] in
      guard let self = self else { throw NativePlaybackError.cancelled }
      if let controller = self.controller {
        controller.exitPictureInPicture()
      }
      return nil
    }
  }

  override func invalidate() {
    invalidationLock.lock()
    invalidationRequested = true
    invalidationLock.unlock()
    Task { @MainActor [self] in
      controller?.shutdown()
      controller = nil
    }
    super.invalidate()
  }

  @MainActor
  private func requireController() throws -> NativePlaybackController {
    guard !hasRequestedInvalidation() else { throw NativePlaybackError.cancelled }
    if let controller = controller { return controller }
    let created = NativePlaybackController { [weak self] event in
      guard let self = self, !self.hasRequestedInvalidation() else { return }
      self.sendEvent(withName: Self.eventName, body: event.payload)
    }
    controller = created
    return created
  }

  private func hasRequestedInvalidation() -> Bool {
    invalidationLock.lock()
    defer { invalidationLock.unlock() }
    return invalidationRequested
  }

  private func runPromise(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    operation: @escaping @MainActor () async throws -> Any?
  ) {
    Task { @MainActor in
      do {
        let value = try await operation()
        resolve(value ?? NSNull())
      } catch {
        let stableError = (error as? NativePlaybackError) ?? .prepareFailed
        reject(stableError.code, Self.genericFailureMessage, nil)
      }
    }
  }
}
