import AVFAudio
import AVFoundation
import AVKit
import Foundation
import UIKit

protocol NativePlaybackLease: AnyObject {
  func release()
}

extension MediaProxyAccessLease: NativePlaybackLease {}

@MainActor
protocol NativePlaybackSourceLeasing: AnyObject {
  func retainOwnedSource(_ url: URL) async -> NativePlaybackLease?
}

@MainActor
final class MediaProxyNativePlaybackSourceLeaser: NativePlaybackSourceLeasing {
  private let server: MediaProxyServer

  init(server: MediaProxyServer = .shared) {
    self.server = server
  }

  func retainOwnedSource(_ url: URL) async -> NativePlaybackLease? {
    await server.retainForNativePlayback(url)
  }
}

struct NativePlaybackRuntimeCallbacks {
  var didStart: (() -> Void)?
  var failed: ((NativePlaybackError) -> Void)?
  var willStop: (() -> Void)?
  var restoreUserInterface: (((@escaping (Bool) -> Void)) -> Void)?
  var didStop: (() -> Void)?

  init(
    didStart: (() -> Void)? = nil,
    failed: ((NativePlaybackError) -> Void)? = nil,
    willStop: (() -> Void)? = nil,
    restoreUserInterface: (((@escaping (Bool) -> Void)) -> Void)? = nil,
    didStop: (() -> Void)? = nil
  ) {
    self.didStart = didStart
    self.failed = failed
    self.willStop = willStop
    self.restoreUserInterface = restoreUserInterface
    self.didStop = didStop
  }
}

@MainActor
protocol NativePlaybackRuntime: AnyObject {
  var currentPosition: TimeInterval { get }
  var isPaused: Bool { get }
  func installCallbacks(_ callbacks: NativePlaybackRuntimeCallbacks)
  func prepare(_ source: PreparedNativePlaybackSource) async throws
  func activateAudioSession() throws
  func play(rate: Float)
  func pause()
  func startPictureInPicture(
    if shouldStart: @escaping @MainActor () -> Bool
  ) async throws
  func stopPictureInPicture()
  func cleanup()
}

@MainActor
protocol NativePlaybackScheduledTask: AnyObject {
  func cancel()
}

@MainActor
protocol NativePlaybackScheduling: AnyObject {
  func schedule(
    after delay: TimeInterval,
    _ operation: @escaping @MainActor () -> Void
  ) -> NativePlaybackScheduledTask
}

@MainActor
final class TaskNativePlaybackScheduler: NativePlaybackScheduling {
  func schedule(
    after delay: TimeInterval,
    _ operation: @escaping @MainActor () -> Void
  ) -> NativePlaybackScheduledTask {
    TaskNativePlaybackScheduledTask(delay: delay, operation: operation)
  }
}

@MainActor
private final class TaskNativePlaybackScheduledTask: NativePlaybackScheduledTask {
  private var task: Task<Void, Never>?

  init(delay: TimeInterval, operation: @escaping @MainActor () -> Void) {
    let boundedDelay = delay.isFinite ? min(max(delay, 0.05), 60) : 5
    task = Task { @MainActor in
      do {
        try await Task.sleep(nanoseconds: UInt64(boundedDelay * 1_000_000_000))
      } catch {
        return
      }
      guard !Task.isCancelled else { return }
      operation()
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
  }

  deinit {
    task?.cancel()
  }
}

@MainActor
final class NativePlaybackController {
  enum State: Equatable {
    case idle
    case preparing(handoffId: String, generation: UInt64)
    case awaitingWebPause(handoffId: String, generation: UInt64)
    case entering(handoffId: String, generation: UInt64)
    case active(handoffId: String, generation: UInt64)
    case restoring(handoffId: String, generation: UInt64)
  }

  private static let webPauseTimeout: TimeInterval = 5
  private static let enterTimeout: TimeInterval = 8
  private static let exitCallbackTimeout: TimeInterval = 3
  private static let restoreTimeout: TimeInterval = 5

  private let runtime: NativePlaybackRuntime
  private let sourceLeaser: NativePlaybackSourceLeasing
  private let scheduler: NativePlaybackScheduling
  private let events: (NativePlaybackEvent) -> Void

  private var generation: UInt64 = 0
  private var source: PreparedNativePlaybackSource?
  private var sourceLease: NativePlaybackLease?
  private var phaseTimeout: NativePlaybackScheduledTask?
  private var requestedPiPStart = false
  private var exitRequested = false
  private var emittedActiveState = false
  private var pendingRestoreSnapshot: NativePlaybackRestoreSnapshot?
  private var pendingRestoreError: NativePlaybackError?
  private var pendingRestoreCompletion: NativePlaybackCompletionOnce?

  private(set) var state: State = .idle
  private(set) var deferredRestoreSnapshot: NativePlaybackRestoreSnapshot?

  // Les dependances par defaut sont construites dans le corps de l'init, pas
  // en valeur par defaut de parametre : ces expressions sont evaluees au site
  // d'appel en contexte nonisolated, alors que les types sont @MainActor.
  // Le corps de l'init, lui, est bien isole sur le main actor.
  init(
    runtime: NativePlaybackRuntime? = nil,
    sourceLeaser: NativePlaybackSourceLeasing? = nil,
    scheduler: NativePlaybackScheduling? = nil,
    events: @escaping (NativePlaybackEvent) -> Void
  ) {
    self.runtime = runtime ?? AVNativePlaybackRuntime()
    self.sourceLeaser = sourceLeaser ?? MediaProxyNativePlaybackSourceLeaser()
    self.scheduler = scheduler ?? TaskNativePlaybackScheduler()
    self.events = events
  }

  func prepare(
    _ source: PreparedNativePlaybackSource,
    handoffId: String
  ) async throws {
    guard state == .idle else { throw NativePlaybackError.sourceBusy }
    guard PreparedNativePlaybackSource.isValidHandoffID(handoffId),
          source.handoffId == handoffId,
          source.protocolVersion == PreparedNativePlaybackSource.preparedSourceProtocolVersion else {
      throw NativePlaybackError.invalidHandoff
    }

    generation &+= 1
    let candidateGeneration = generation
    state = .preparing(handoffId: handoffId, generation: candidateGeneration)
    self.source = source
    deferredRestoreSnapshot = nil
    requestedPiPStart = false
    exitRequested = false
    emittedActiveState = false
    installRuntimeCallbacks(handoffId: handoffId, generation: candidateGeneration)

    guard let lease = await sourceLeaser.retainOwnedSource(source.url) else {
      failPreparation(
        handoffId: handoffId,
        generation: candidateGeneration,
        error: .sourceNotOwned
      )
      throw NativePlaybackError.sourceNotOwned
    }
    guard isCurrent(.preparing(handoffId: handoffId, generation: candidateGeneration)) else {
      lease.release()
      throw NativePlaybackError.cancelled
    }
    sourceLease = lease

    do {
      try await runtime.prepare(source)
    } catch {
      let stableError = (error as? NativePlaybackError) ?? .prepareFailed
      guard isCurrent(.preparing(handoffId: handoffId, generation: candidateGeneration)) else {
        throw NativePlaybackError.cancelled
      }
      failPreparation(
        handoffId: handoffId,
        generation: candidateGeneration,
        error: stableError
      )
      throw stableError
    }

    guard isCurrent(.preparing(handoffId: handoffId, generation: candidateGeneration)) else {
      throw NativePlaybackError.cancelled
    }
    state = .awaitingWebPause(handoffId: handoffId, generation: candidateGeneration)
    events(.ready(handoffId: handoffId))
    schedulePhaseTimeout(after: Self.webPauseTimeout) { [weak self] in
      guard let self = self,
            self.isCurrent(.awaitingWebPause(
              handoffId: handoffId,
              generation: candidateGeneration
            )) else { return }
      self.beginRestoring(
        handoffId: handoffId,
        generation: candidateGeneration,
        error: .handoffTimeout
      )
    }
  }

  func acknowledgeWebViewPaused(_ handoffId: String) throws {
    guard case let .awaitingWebPause(currentID, currentGeneration) = state,
          currentID == handoffId else {
      throw NativePlaybackError.invalidHandoff
    }
    phaseTimeout?.cancel()
    phaseTimeout = nil

    do {
      try runtime.activateAudioSession()
    } catch {
      beginRestoring(
        handoffId: currentID,
        generation: currentGeneration,
        error: .prepareFailed
      )
      return
    }
    if source?.paused == true {
      runtime.pause()
    } else {
      runtime.play(rate: source?.playbackRate ?? 1)
    }
    state = .entering(handoffId: currentID, generation: currentGeneration)
    schedulePhaseTimeout(after: Self.enterTimeout) { [weak self] in
      guard let self = self,
            self.isCurrent(.entering(
              handoffId: currentID,
              generation: currentGeneration
            )),
            !self.requestedPiPStart else { return }
      self.beginRestoring(
        handoffId: currentID,
        generation: currentGeneration,
        error: .enterFailed
      )
    }
  }

  func enterPictureInPicture(_ handoffId: String) async throws {
    if case let .restoring(currentID, _) = state, currentID == handoffId {
      // A preparation/enter failure has already emitted a restore event. The
      // JS bridge may still be completing the ordered PREPARED -> ENTER
      // sequence; accepting this late call keeps the restore/ACK channel open.
      return
    }
    guard case let .entering(currentID, currentGeneration) = state,
          currentID == handoffId,
          !requestedPiPStart else {
      throw NativePlaybackError.invalidHandoff
    }
    phaseTimeout?.cancel()
    phaseTimeout = nil
    requestedPiPStart = true
    exitRequested = false
    do {
      try await runtime.startPictureInPicture { [weak self] in
        guard let self = self else { return false }
        return self.requestedPiPStart
          && !self.exitRequested
          && self.isCurrent(.entering(
            handoffId: currentID,
            generation: currentGeneration
          ))
      }
    } catch {
      let stableError = (error as? NativePlaybackError) ?? .enterFailed
      if exitRequested,
         isCurrent(.entering(
           handoffId: currentID,
           generation: currentGeneration
         )) {
        beginRestoring(
          handoffId: currentID,
          generation: currentGeneration,
          error: nil
        )
        return
      }
      guard isCurrent(.entering(
        handoffId: currentID,
        generation: currentGeneration
      )) else {
        throw NativePlaybackError.cancelled
      }
      beginRestoring(
        handoffId: currentID,
        generation: currentGeneration,
        error: stableError
      )
      return
    }
    guard isCurrent(.entering(
      handoffId: currentID,
      generation: currentGeneration
    )), requestedPiPStart, !exitRequested else {
      if exitRequested,
         isCurrent(.entering(
           handoffId: currentID,
           generation: currentGeneration
         )) {
        beginRestoring(
          handoffId: currentID,
          generation: currentGeneration,
          error: nil
        )
        return
      }
      throw NativePlaybackError.cancelled
    }
    schedulePhaseTimeout(after: Self.enterTimeout) { [weak self] in
      guard let self = self,
            self.isCurrent(.entering(
              handoffId: currentID,
              generation: currentGeneration
            )) else { return }
      self.beginRestoring(
        handoffId: currentID,
        generation: currentGeneration,
        error: .enterFailed
      )
    }
  }

  func acknowledgeRestoreApplied(_ handoffId: String, ok: Bool) throws {
    guard case let .restoring(currentID, currentGeneration) = state,
          currentID == handoffId else {
      throw NativePlaybackError.invalidHandoff
    }
    phaseTimeout?.cancel()
    phaseTimeout = nil
    let restoreError = pendingRestoreError
    pendingRestoreError = nil
    if ok {
      deferredRestoreSnapshot = nil
    } else {
      deferredRestoreSnapshot = pendingRestoreSnapshot
      events(.error(handoffId: currentID, code: NativePlaybackError.restoreFailed.code))
    }
    pendingRestoreCompletion?.complete(ok)
    pendingRestoreCompletion = nil
    finishRestoration(handoffId: currentID, generation: currentGeneration)
    // The WebView has already applied and acknowledged the restore. Any
    // native failure is therefore safe to report after the handoff is closed;
    // emitting it before restore would make the JS bridge discard the video.
    if ok, let restoreError {
      events(.error(handoffId: currentID, code: restoreError.code))
    }
  }

  func exitPictureInPicture() {
    guard let context = currentContext() else { return }
    switch state {
    case .entering, .active:
      exitRequested = true
      requestedPiPStart = false
      runtime.stopPictureInPicture()
      schedulePhaseTimeout(after: Self.exitCallbackTimeout) { [weak self] in
        guard let self = self, self.matches(context) else { return }
        self.beginRestoring(
          handoffId: context.handoffId,
          generation: context.generation,
          error: nil
        )
      }
    case .restoring:
      runtime.stopPictureInPicture()
    default:
      break
    }
  }

  func cancel(_ handoffId: String) throws {
    guard let context = currentContext(), context.handoffId == handoffId else {
      throw NativePlaybackError.invalidHandoff
    }
    let shouldEmitInactive = emittedActiveState
    runtime.stopPictureInPicture()
    cleanupTerminal(
      handoffId: context.handoffId,
      emitInactive: shouldEmitInactive
    )
  }

  func setPlaybackActive(_ active: Bool) {
    guard !active else { return }
    if case .idle = state { return }
    // The WebView pause that forms part of an iOS handoff must not pause the
    // native player. Navigation/unmount uses the explicit handoff-bound cancel.
  }

  func shutdown() {
    guard let context = currentContext() else {
      runtime.cleanup()
      return
    }
    runtime.stopPictureInPicture()
    cleanupTerminal(handoffId: context.handoffId, emitInactive: emittedActiveState)
  }

  private func installRuntimeCallbacks(handoffId: String, generation: UInt64) {
    runtime.installCallbacks(NativePlaybackRuntimeCallbacks(
      didStart: { [weak self] in
        guard let self = self,
              self.isCurrent(.entering(handoffId: handoffId, generation: generation)),
              self.requestedPiPStart else { return }
        self.phaseTimeout?.cancel()
        self.phaseTimeout = nil
        self.state = .active(handoffId: handoffId, generation: generation)
        self.emittedActiveState = true
        self.events(.state(handoffId: handoffId, active: true))
      },
      failed: { [weak self] error in
        guard let self = self,
              self.matches((handoffId: handoffId, generation: generation)) else { return }
        self.beginRestoring(
          handoffId: handoffId,
          generation: generation,
          error: error
        )
      },
      willStop: { [weak self] in
        guard let self = self,
              self.matches((handoffId: handoffId, generation: generation)) else { return }
        self.beginRestoring(
          handoffId: handoffId,
          generation: generation,
          error: nil
        )
      },
      restoreUserInterface: { [weak self] completion in
        guard let self = self,
              self.matches((handoffId: handoffId, generation: generation)) else {
          completion(false)
          return
        }
        if self.pendingRestoreCompletion != nil {
          completion(false)
          return
        }
        self.pendingRestoreCompletion = NativePlaybackCompletionOnce(completion)
        self.beginRestoring(
          handoffId: handoffId,
          generation: generation,
          error: nil
        )
      },
      didStop: { [weak self] in
        guard let self = self,
              self.matches((handoffId: handoffId, generation: generation)) else { return }
        self.beginRestoring(
          handoffId: handoffId,
          generation: generation,
          error: nil
        )
      }
    ))
  }

  private func beginRestoring(
    handoffId: String,
    generation: UInt64,
    error: NativePlaybackError?
  ) {
    guard matches((handoffId: handoffId, generation: generation)) else { return }
    if case .restoring = state { return }

    let wasAwaitingWebPause: Bool
    if case .awaitingWebPause = state {
      wasAwaitingWebPause = true
    } else {
      wasAwaitingWebPause = false
    }
    phaseTimeout?.cancel()
    phaseTimeout = nil
    let position = boundedPosition(runtime.currentPosition, fallback: source?.positionSec ?? 0)
    let paused = wasAwaitingWebPause ? (source?.paused ?? true) : runtime.isPaused
    runtime.pause()
    state = .restoring(handoffId: handoffId, generation: generation)
    let snapshot = NativePlaybackRestoreSnapshot(
      handoffId: handoffId,
      positionSec: position,
      paused: paused
    )
    pendingRestoreSnapshot = snapshot
    pendingRestoreError = error
    events(.restore(handoffId: handoffId, positionSec: position, paused: paused))
    schedulePhaseTimeout(after: Self.restoreTimeout) { [weak self] in
      guard let self = self,
            self.isCurrent(.restoring(
              handoffId: handoffId,
              generation: generation
            )) else { return }
      self.deferredRestoreSnapshot = snapshot
      self.pendingRestoreCompletion?.complete(false)
      self.pendingRestoreCompletion = nil
      self.events(.error(
        handoffId: handoffId,
        code: NativePlaybackError.restoreTimeout.code
      ))
      self.finishRestoration(handoffId: handoffId, generation: generation)
    }
  }

  private func finishRestoration(handoffId: String, generation: UInt64) {
    guard isCurrent(.restoring(handoffId: handoffId, generation: generation)) else {
      return
    }
    cleanupTerminal(handoffId: handoffId, emitInactive: true)
  }

  private func failPreparation(
    handoffId: String,
    generation: UInt64,
    error: NativePlaybackError
  ) {
    guard isCurrent(.preparing(handoffId: handoffId, generation: generation)) else {
      return
    }
    events(.error(handoffId: handoffId, code: error.code))
    cleanupTerminal(handoffId: handoffId, emitInactive: false)
  }

  private func cleanupTerminal(handoffId: String, emitInactive: Bool) {
    phaseTimeout?.cancel()
    phaseTimeout = nil
    generation &+= 1
    requestedPiPStart = false
    exitRequested = false
    emittedActiveState = false
    source = nil
    pendingRestoreSnapshot = nil
    pendingRestoreError = nil
    pendingRestoreCompletion?.complete(false)
    pendingRestoreCompletion = nil
    runtime.cleanup()
    sourceLease?.release()
    sourceLease = nil
    state = .idle
    if emitInactive {
      events(.state(handoffId: handoffId, active: false))
    }
  }

  private func schedulePhaseTimeout(
    after delay: TimeInterval,
    _ operation: @escaping @MainActor () -> Void
  ) {
    phaseTimeout?.cancel()
    phaseTimeout = scheduler.schedule(after: delay, operation)
  }

  private func isCurrent(_ expected: State) -> Bool {
    state == expected
  }

  private func currentContext() -> (handoffId: String, generation: UInt64)? {
    switch state {
    case .idle:
      return nil
    case let .preparing(handoffId, generation),
         let .awaitingWebPause(handoffId, generation),
         let .entering(handoffId, generation),
         let .active(handoffId, generation),
         let .restoring(handoffId, generation):
      return (handoffId, generation)
    }
  }

  private func matches(_ context: (handoffId: String, generation: UInt64)) -> Bool {
    guard let current = currentContext() else { return false }
    return current.handoffId == context.handoffId && current.generation == context.generation
  }

  private func boundedPosition(_ value: TimeInterval, fallback: TimeInterval) -> TimeInterval {
    let candidate = value.isFinite ? value : fallback
    return min(max(candidate, 0), PreparedNativePlaybackSource.maximumPositionSec)
  }

}

@MainActor
private final class NativePlaybackCompletionOnce {
  private var completion: ((Bool) -> Void)?

  init(_ completion: @escaping (Bool) -> Void) {
    self.completion = completion
  }

  func complete(_ restored: Bool) {
    guard let completion = completion else { return }
    self.completion = nil
    completion(restored)
  }
}

@MainActor
protocol NativePlaybackAudioSession: AnyObject {
  func activate() throws
  func deactivate()
}

@MainActor
final class AVNativePlaybackAudioSession: NativePlaybackAudioSession {
  private let session: AVAudioSession
  private var isActive = false

  init(session: AVAudioSession = .sharedInstance()) {
    self.session = session
  }

  func activate() throws {
    guard !isActive else { return }
    try session.setCategory(.playback, mode: .moviePlayback)
    try session.setActive(true)
    isActive = true
  }

  func deactivate() {
    guard isActive else { return }
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    isActive = false
  }
}

@MainActor
protocol NativePlaybackSurfaceHosting: AnyObject {
  func attach(_ playerLayer: AVPlayerLayer) throws -> UIView
}

@MainActor
final class ApplicationNativePlaybackSurfaceHost: NativePlaybackSurfaceHosting {
  func attach(_ playerLayer: AVPlayerLayer) throws -> UIView {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
      .flatMap(\.windows)
    guard let window = windows.first(where: \.isKeyWindow) ?? windows.first,
          let rootView = window.rootViewController?.view else {
      throw NativePlaybackError.notPossible
    }

    let surface = UIView(frame: rootView.bounds)
    surface.isHidden = false
    surface.alpha = 1
    surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    surface.isUserInteractionEnabled = false
    surface.accessibilityElementsHidden = true
    surface.clipsToBounds = true
    playerLayer.frame = surface.bounds
    surface.layer.addSublayer(playerLayer)
    rootView.insertSubview(surface, at: 0)
    return surface
  }
}

@MainActor
final class AVNativePlaybackRuntime: NSObject, NativePlaybackRuntime,
  AVPictureInPictureControllerDelegate {
  private static let itemReadyTimeout: TimeInterval = 12
  private static let seekTimeout: TimeInterval = 5
  private static let pictureInPicturePossibleTimeout: TimeInterval = 5

  private let audioSession: NativePlaybackAudioSession
  private let surfaceHost: NativePlaybackSurfaceHosting
  private var callbacks = NativePlaybackRuntimeCallbacks()
  private var generation: UInt64 = 0
  private var player: AVPlayer?
  private var playerItem: AVPlayerItem?
  private var playerLayer: AVPlayerLayer?
  private var surfaceView: UIView?
  private var pictureInPictureController: AVPictureInPictureController?
  private var itemStatusObservation: NSKeyValueObservation?
  private var pictureInPicturePossibleObservation: NSKeyValueObservation?
  private var notificationObservers: [NSObjectProtocol] = []
  private var timeObserver: Any?
  private var observedItemStatus: AVPlayerItem.Status = .unknown
  private var observedPictureInPicturePossible = false
  private var seekResult: Bool?
  private var lastKnownPosition: TimeInterval = 0
  private var hasCompletedPreparation = false

  // Meme raison que pour NativePlaybackController : ces deux types sont
  // @MainActor et ne peuvent pas etre instancies depuis une valeur par defaut
  // de parametre, evaluee en contexte nonisolated.
  init(
    audioSession: NativePlaybackAudioSession? = nil,
    surfaceHost: NativePlaybackSurfaceHosting? = nil
  ) {
    self.audioSession = audioSession ?? AVNativePlaybackAudioSession()
    self.surfaceHost = surfaceHost ?? ApplicationNativePlaybackSurfaceHost()
    super.init()
  }

  var currentPosition: TimeInterval {
    guard let seconds = player?.currentTime().seconds, seconds.isFinite else {
      return lastKnownPosition
    }
    return seconds
  }

  var isPaused: Bool {
    guard let player = player else { return true }
    return player.timeControlStatus == .paused
  }

  func installCallbacks(_ callbacks: NativePlaybackRuntimeCallbacks) {
    self.callbacks = callbacks
  }

  func prepare(_ source: PreparedNativePlaybackSource) async throws {
    resetMediaResources(clearCallbacks: false)
    generation &+= 1
    let candidateGeneration = generation
    observedItemStatus = .unknown
    observedPictureInPicturePossible = false
    seekResult = nil
    lastKnownPosition = source.positionSec
    hasCompletedPreparation = false

    let item = AVPlayerItem(url: source.url)
    let player = AVPlayer(playerItem: item)
    player.isMuted = source.muted
    player.pause()
    self.playerItem = item
    self.player = player

    itemStatusObservation = item.observe(\.status, options: [.initial, .new]) {
      [weak self] item, _ in
      Task { @MainActor [weak self] in
        guard let self = self, self.generation == candidateGeneration else { return }
        self.observedItemStatus = item.status
        if item.status == .failed, self.hasCompletedPreparation {
          self.callbacks.failed?(.prepareFailed)
        }
      }
    }
    installPlaybackObservers(item: item, generation: candidateGeneration)
    installTimeObserver(player: player, generation: candidateGeneration)

    try await waitUntil(timeout: Self.itemReadyTimeout, timeoutError: .prepareFailed) {
      self.generation != candidateGeneration || self.observedItemStatus != .unknown
    }
    guard generation == candidateGeneration else { throw NativePlaybackError.cancelled }
    guard observedItemStatus == .readyToPlay else {
      throw NativePlaybackError.prepareFailed
    }

    player.seek(
      to: CMTime(seconds: source.positionSec, preferredTimescale: 600),
      toleranceBefore: .zero,
      toleranceAfter: .zero
    ) { [weak self] finished in
      Task { @MainActor [weak self] in
        guard let self = self, self.generation == candidateGeneration else { return }
        self.seekResult = finished
      }
    }
    try await waitUntil(timeout: Self.seekTimeout, timeoutError: .seekFailed) {
      self.generation != candidateGeneration || self.seekResult != nil
    }
    guard generation == candidateGeneration else { throw NativePlaybackError.cancelled }
    guard seekResult == true else { throw NativePlaybackError.seekFailed }

    guard AVPictureInPictureController.isPictureInPictureSupported() else {
      throw NativePlaybackError.unsupported
    }
    let playerLayer = AVPlayerLayer(player: player)
    playerLayer.videoGravity = .resizeAspect
    self.playerLayer = playerLayer
    surfaceView = try surfaceHost.attach(playerLayer)
    guard let controller = AVPictureInPictureController(playerLayer: playerLayer) else {
      throw NativePlaybackError.notPossible
    }
    controller.delegate = self
    pictureInPictureController = controller
    pictureInPicturePossibleObservation = controller.observe(
      \.isPictureInPicturePossible,
      options: [.initial, .new]
    ) { [weak self] controller, _ in
      Task { @MainActor [weak self] in
        guard let self = self, self.generation == candidateGeneration else { return }
        self.observedPictureInPicturePossible = controller.isPictureInPicturePossible
      }
    }
    player.pause()
    hasCompletedPreparation = true
  }

  func activateAudioSession() throws {
    try audioSession.activate()
  }

  func play(rate: Float) {
    player?.playImmediately(atRate: min(max(rate, 0.25), 4))
  }

  func pause() {
    player?.pause()
  }

  func startPictureInPicture(
    if shouldStart: @escaping @MainActor () -> Bool
  ) async throws {
    guard let controller = pictureInPictureController,
          !controller.isPictureInPictureActive else {
      throw NativePlaybackError.enterFailed
    }
    let candidateGeneration = generation
    try await waitUntil(
      timeout: Self.pictureInPicturePossibleTimeout,
      timeoutError: .notPossible
    ) {
      self.generation != candidateGeneration
        || !shouldStart()
        || self.observedPictureInPicturePossible
    }
    guard generation == candidateGeneration else { throw NativePlaybackError.cancelled }
    guard shouldStart() else { throw NativePlaybackError.cancelled }
    guard controller.isPictureInPicturePossible else {
      throw NativePlaybackError.notPossible
    }
    controller.startPictureInPicture()
  }

  func stopPictureInPicture() {
    pictureInPictureController?.stopPictureInPicture()
  }

  func cleanup() {
    resetMediaResources(clearCallbacks: true)
  }

  private func resetMediaResources(clearCallbacks: Bool) {
    generation &+= 1
    phaseCleanupObservers()
    pictureInPictureController?.delegate = nil
    pictureInPictureController?.stopPictureInPicture()
    pictureInPictureController = nil
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    playerItem = nil
    playerLayer?.player = nil
    playerLayer?.removeFromSuperlayer()
    playerLayer = nil
    surfaceView?.removeFromSuperview()
    surfaceView = nil
    audioSession.deactivate()
    observedItemStatus = .unknown
    observedPictureInPicturePossible = false
    seekResult = nil
    hasCompletedPreparation = false
    if clearCallbacks {
      callbacks = NativePlaybackRuntimeCallbacks()
    }
  }

  private func phaseCleanupObservers() {
    itemStatusObservation?.invalidate()
    itemStatusObservation = nil
    pictureInPicturePossibleObservation?.invalidate()
    pictureInPicturePossibleObservation = nil
    if let timeObserver = timeObserver, let player = player {
      player.removeTimeObserver(timeObserver)
    }
    timeObserver = nil
    for observer in notificationObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    notificationObservers.removeAll()
  }

  private func installPlaybackObservers(item: AVPlayerItem, generation: UInt64) {
    let events: [(name: Notification.Name, didFinish: Bool)] = [
      (.AVPlayerItemFailedToPlayToEndTime, false),
      (.AVPlayerItemDidPlayToEndTime, true),
    ]
    for event in events {
      let observer = NotificationCenter.default.addObserver(
        forName: event.name,
        object: item,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          guard let self = self, self.generation == generation else { return }
          if self.hasCompletedPreparation {
            if event.didFinish {
              self.callbacks.willStop?()
            } else {
              self.callbacks.failed?(.prepareFailed)
            }
          }
        }
      }
      notificationObservers.append(observer)
    }
  }

  private func installTimeObserver(player: AVPlayer, generation: UInt64) {
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      Task { @MainActor [weak self] in
        guard let self = self,
              self.generation == generation,
              time.seconds.isFinite else { return }
        self.lastKnownPosition = time.seconds
      }
    }
  }

  private func waitUntil(
    timeout: TimeInterval,
    timeoutError: NativePlaybackError,
    condition: @escaping @MainActor () -> Bool
  ) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while !condition() {
      try Task.checkCancellation()
      guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw timeoutError
      }
      try await Task.sleep(nanoseconds: 25_000_000)
    }
  }

  func pictureInPictureControllerDidStartPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    callbacks.didStart?()
  }

  func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    callbacks.failed?(.enterFailed)
  }

  func pictureInPictureControllerWillStopPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    callbacks.willStop?()
  }

  func pictureInPictureControllerDidStopPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    callbacks.didStop?()
  }

  func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler:
      @escaping (Bool) -> Void
  ) {
    callbacks.restoreUserInterface?(completionHandler)
      ?? completionHandler(false)
  }

}
