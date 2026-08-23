import XCTest
@testable import Movix

@MainActor
final class NativePlaybackControllerTests: XCTestCase {
  private let handoffID = "NativePipHandoff_1234567890"

  func testDecoderAcceptsOnlyCanonicalTypedV1Source() throws {
    let source = try PreparedNativePlaybackSource.decode(
      fixtureDictionary(),
      handoffId: handoffID
    )

    XCTAssertEqual(source.protocolVersion, 1)
    XCTAssertEqual(source.handoffId, handoffID)
    XCTAssertEqual(source.positionSec, 42)
    XCTAssertEqual(source.playbackRate, 1.25)
    XCTAssertFalse(source.paused)
    XCTAssertTrue(source.muted)
    XCTAssertEqual(source.title, "Movix")
    XCTAssertEqual(source.posterURL?.absoluteString, "https://example.com/poster.jpg")
  }

  func testDecoderRejectsNSNumberBoolConfusionAndNoncanonicalURLs() {
    var invalidPosition = fixtureDictionary()
    invalidPosition["positionSec"] = true
    XCTAssertThrowsError(
      try PreparedNativePlaybackSource.decode(invalidPosition, handoffId: handoffID)
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidSource) }

    var invalidPaused = fixtureDictionary()
    invalidPaused["paused"] = NSNumber(value: 1)
    XCTAssertThrowsError(
      try PreparedNativePlaybackSource.decode(invalidPaused, handoffId: handoffID)
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidSource) }

    var invalidProtocol = fixtureDictionary()
    invalidProtocol["protocolVersion"] = true
    XCTAssertThrowsError(
      try PreparedNativePlaybackSource.decode(invalidProtocol, handoffId: handoffID)
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidSource) }

    for url in [
      "http://127.0.0.1:08080/p/\(token("a"))/\(token("b"))/\(token("c"))",
      "http://127.0.0.1:8080/p/\(token("a"))/\(token("b"))/\(token("c"))?x=1",
      "http://localhost:8080/p/\(token("a"))/\(token("b"))/\(token("c"))",
      "https://127.0.0.1:8080/p/\(token("a"))/\(token("b"))/\(token("c"))",
    ] {
      var dictionary = fixtureDictionary()
      dictionary["url"] = url
      XCTAssertThrowsError(
        try PreparedNativePlaybackSource.decode(dictionary, handoffId: handoffID)
      ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidSource) }
    }
  }

  func testDecoderRejectsInvalidHandoffBoundsAndPosterWithoutFetchingIt() {
    XCTAssertThrowsError(
      try PreparedNativePlaybackSource.decode(fixtureDictionary(), handoffId: "short")
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidHandoff) }

    var invalidPoster = fixtureDictionary()
    invalidPoster["poster"] = "http://169.254.169.254/latest/meta-data"
    XCTAssertThrowsError(
      try PreparedNativePlaybackSource.decode(invalidPoster, handoffId: handoffID)
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidSource) }
  }

  func testHandoffOrdersReadyPausePlaybackEnterRestoreAndCleanupWithoutDoublePlayback() async throws {
    let harness = makeHarness()
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)

    XCTAssertEqual(harness.runtime.calls, ["prepare"])
    XCTAssertEqual(harness.events.values, [.ready(handoffId: handoffID)])
    XCTAssertFalse(harness.runtime.isAudioActive)
    XCTAssertEqual(harness.runtime.playCount, 0)
    XCTAssertFalse(harness.lease.isReleased)

    try harness.controller.acknowledgeWebViewPaused(handoffID)
    XCTAssertEqual(harness.runtime.calls, ["prepare", "activateAudio", "play"])
    XCTAssertEqual(harness.runtime.playCount, 1)

    try await harness.controller.enterPictureInPicture(handoffID)
    XCTAssertEqual(harness.runtime.calls.last, "startPiP")
    harness.runtime.callbacks.didStart?()
    XCTAssertEqual(harness.events.values.last, .state(handoffId: handoffID, active: true))

    harness.runtime.currentPosition = 61
    harness.runtime.isPaused = true
    harness.controller.exitPictureInPicture()
    XCTAssertEqual(harness.runtime.calls.last, "stopPiP")
    harness.runtime.callbacks.willStop?()
    XCTAssertEqual(
      harness.events.values.last,
      .restore(handoffId: handoffID, positionSec: 61, paused: true)
    )
    XCTAssertFalse(harness.lease.isReleased)

    try harness.controller.acknowledgeRestoreApplied(handoffID, ok: true)
    XCTAssertEqual(harness.events.values.last, .state(handoffId: handoffID, active: false))
    assertTerminalCleanup(harness)
  }

  func testPausedSourceNeverPlaysAfterWebViewAcknowledgement() async throws {
    let harness = makeHarness()
    var dictionary = fixtureDictionary()
    dictionary["paused"] = NSNumber(value: true)
    let source = try PreparedNativePlaybackSource.decode(dictionary, handoffId: handoffID)

    try await harness.controller.prepare(source, handoffId: handoffID)
    try harness.controller.acknowledgeWebViewPaused(handoffID)

    XCTAssertEqual(harness.runtime.playCount, 0)
    XCTAssertEqual(harness.runtime.pauseCount, 1)
    XCTAssertTrue(harness.runtime.isAudioActive)
  }

  func testSecondPrepareAndStaleIDsFailClosed() async throws {
    let harness = makeHarness()
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)

    await XCTAssertThrowsErrorAsync {
      try await harness.controller.prepare(
        self.fixtureSource(),
        handoffId: "DifferentHandoff_1234567890"
      )
    } verify: {
      XCTAssertEqual($0 as? NativePlaybackError, .sourceBusy)
    }
    XCTAssertThrowsError(
      try harness.controller.acknowledgeWebViewPaused("StaleHandoff_1234567890")
    ) { XCTAssertEqual($0 as? NativePlaybackError, .invalidHandoff) }
    XCTAssertEqual(harness.runtime.playCount, 0)
  }

  func testStaleRuntimeCallbacksCannotAffectANewerGeneration() async throws {
    let harness = makeHarness()
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)
    let staleCallbacks = harness.runtime.callbacks
    try harness.controller.cancel(handoffID)

    let nextID = "NextNativeHandoff_1234567890"
    harness.leaser.lease = FakeNativePlaybackLease()
    var nextDictionary = fixtureDictionary()
    nextDictionary["title"] = "Next"
    let nextSource = try PreparedNativePlaybackSource.decode(
      nextDictionary,
      handoffId: nextID
    )
    try await harness.controller.prepare(nextSource, handoffId: nextID)
    staleCallbacks.didStart?()
    staleCallbacks.didStop?()

    XCTAssertEqual(harness.events.values.last, .ready(handoffId: nextID))
    XCTAssertFalse(harness.events.values.contains(.state(handoffId: nextID, active: true)))
  }

  func testUnownedCanonicalSourceIsRejectedBeforeAVPlayerPreparation() async {
    let harness = makeHarness(owned: false)

    await XCTAssertThrowsErrorAsync {
      try await harness.controller.prepare(self.fixtureSource(), handoffId: self.handoffID)
    } verify: {
      XCTAssertEqual($0 as? NativePlaybackError, .sourceNotOwned)
    }
    XCTAssertTrue(harness.runtime.calls.isEmpty)
    XCTAssertEqual(harness.leaser.requestedURLs.count, 1)
  }

  func testMissingWebPauseAcknowledgementRestoresThenTimesOutWithFullCleanup() async throws {
    let harness = makeHarness()
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)

    harness.scheduler.fireNext()
    XCTAssertEqual(
      Array(harness.events.values.suffix(2)),
      [
        .error(handoffId: handoffID, code: "PIP_HANDOFF_TIMEOUT"),
        .restore(handoffId: handoffID, positionSec: 42, paused: true),
      ]
    )
    XCTAssertFalse(harness.lease.isReleased)

    harness.scheduler.fireNext()
    XCTAssertEqual(harness.controller.deferredRestoreSnapshot?.handoffId, handoffID)
    XCTAssertTrue(harness.events.values.contains(
      .error(handoffId: handoffID, code: "PIP_RESTORE_TIMEOUT")
    ))
    assertTerminalCleanup(harness)
  }

  func testRestoreDelegateCompletionAndRestoreEventAreExactlyOnce() async throws {
    let harness = makeHarness()
    try await enterActive(harness)
    harness.runtime.currentPosition = 77
    harness.runtime.isPaused = false

    var firstCompletions: [Bool] = []
    var secondCompletions: [Bool] = []
    harness.runtime.callbacks.restoreUserInterface? { firstCompletions.append($0) }
    harness.runtime.callbacks.restoreUserInterface? { secondCompletions.append($0) }
    harness.runtime.callbacks.didStop?()

    XCTAssertEqual(firstCompletions, [])
    XCTAssertEqual(secondCompletions, [false])
    XCTAssertEqual(
      harness.events.values.filter {
        if case .restore = $0 { return true }
        return false
      }.count,
      1
    )
    try harness.controller.acknowledgeRestoreApplied(handoffID, ok: true)
    XCTAssertEqual(firstCompletions, [true])
    XCTAssertEqual(harness.events.values.filter {
      if case let .state(id, active) = $0 { return id == handoffID && !active }
      return false
    }.count, 1)
  }

  func testExitWhilePiPBecomesPossibleCannotStartAfterTheExitRequest() async throws {
    let harness = makeHarness()
    harness.runtime.suspendPiPStart = true
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)
    try harness.controller.acknowledgeWebViewPaused(handoffID)

    let id = handoffID
    let enterTask = Task { @MainActor in
      try await harness.controller.enterPictureInPicture(id)
    }
    while harness.runtime.startContinuation == nil {
      await Task.yield()
    }
    harness.controller.exitPictureInPicture()
    harness.runtime.resumePendingPiPStart()
    try await enterTask.value

    XCTAssertFalse(harness.runtime.calls.contains("startPiP"))
    XCTAssertEqual(
      harness.events.values.last,
      .restore(handoffId: handoffID, positionSec: 42, paused: false)
    )
    try harness.controller.acknowledgeRestoreApplied(handoffID, ok: true)
    assertTerminalCleanup(harness)
  }

  func testRuntimeErrorWaitsForRestoreAckThenCleansAudioObserversLayerAndLease() async throws {
    let harness = makeHarness()
    try await enterActive(harness)
    harness.runtime.currentPosition = 90
    harness.runtime.callbacks.failed?(.prepareFailed)

    XCTAssertEqual(
      Array(harness.events.values.suffix(1)),
      [.restore(handoffId: handoffID, positionSec: 90, paused: false)]
    )
    XCTAssertFalse(harness.runtime.didCleanup)

    try harness.controller.acknowledgeRestoreApplied(handoffID, ok: false)
    XCTAssertEqual(harness.controller.deferredRestoreSnapshot?.positionSec, 90)
    XCTAssertEqual(harness.events.values.last, .error(handoffId: handoffID, code: "PIP_RESTORE_FAILED"))
    assertTerminalCleanup(harness)
  }

  func testCancelIsIdempotentForNativeResourcesButRejectsAStaleID() async throws {
    let harness = makeHarness()
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)

    try harness.controller.cancel(handoffID)
    assertTerminalCleanup(harness)
    XCTAssertThrowsError(try harness.controller.cancel(handoffID)) {
      XCTAssertEqual($0 as? NativePlaybackError, .invalidHandoff)
    }
    XCTAssertEqual(harness.runtime.cleanupCount, 1)
    XCTAssertEqual(harness.lease.releaseCount, 1)
  }

  private func enterActive(_ harness: Harness) async throws {
    try await harness.controller.prepare(fixtureSource(), handoffId: handoffID)
    try harness.controller.acknowledgeWebViewPaused(handoffID)
    try await harness.controller.enterPictureInPicture(handoffID)
    harness.runtime.callbacks.didStart?()
  }

  private func makeHarness(owned: Bool = true) -> Harness {
    let runtime = FakeNativePlaybackRuntime()
    let lease = FakeNativePlaybackLease()
    let leaser = FakeNativePlaybackSourceLeaser(lease: owned ? lease : nil)
    let scheduler = FakeNativePlaybackScheduler()
    let events = NativePlaybackEventRecorder()
    let controller = NativePlaybackController(
      runtime: runtime,
      sourceLeaser: leaser,
      scheduler: scheduler,
      events: events.send
    )
    return Harness(
      controller: controller,
      runtime: runtime,
      leaser: leaser,
      lease: lease,
      scheduler: scheduler,
      events: events
    )
  }

  private func assertTerminalCleanup(_ harness: Harness) {
    XCTAssertEqual(harness.controller.state, .idle)
    XCTAssertTrue(harness.runtime.didCleanup)
    XCTAssertTrue(harness.runtime.observersRemoved)
    XCTAssertTrue(harness.runtime.layerRemoved)
    XCTAssertFalse(harness.runtime.isAudioActive)
    XCTAssertTrue(harness.lease.isReleased)
  }

  private func fixtureSource() -> PreparedNativePlaybackSource {
    try! PreparedNativePlaybackSource.decode(fixtureDictionary(), handoffId: handoffID)
  }

  private func fixtureDictionary() -> [String: Any] {
    [
      "protocolVersion": NSNumber(value: 1),
      "url": "http://127.0.0.1:8080/p/\(token("a"))/\(token("b"))/\(token("c"))",
      "positionSec": NSNumber(value: 42),
      "paused": NSNumber(value: false),
      "playbackRate": NSNumber(value: 1.25),
      "muted": NSNumber(value: true),
      "title": "Movix",
      "poster": "https://example.com/poster.jpg",
    ]
  }

  private func token(_ character: Character) -> String {
    String(repeating: character, count: 43)
  }
}

@MainActor
private struct Harness {
  let controller: NativePlaybackController
  let runtime: FakeNativePlaybackRuntime
  let leaser: FakeNativePlaybackSourceLeaser
  let lease: FakeNativePlaybackLease
  let scheduler: FakeNativePlaybackScheduler
  let events: NativePlaybackEventRecorder
}

@MainActor
private final class FakeNativePlaybackRuntime: NativePlaybackRuntime {
  var callbacks = NativePlaybackRuntimeCallbacks()
  var calls: [String] = []
  var currentPosition: TimeInterval = 42
  var isPaused = true
  var isAudioActive = false
  var playCount = 0
  var pauseCount = 0
  var cleanupCount = 0
  var didCleanup = false
  var observersRemoved = false
  var layerRemoved = false
  var prepareError: NativePlaybackError?
  var suspendPiPStart = false
  var startContinuation: CheckedContinuation<Void, Never>?

  func installCallbacks(_ callbacks: NativePlaybackRuntimeCallbacks) {
    self.callbacks = callbacks
  }

  func prepare(_ source: PreparedNativePlaybackSource) async throws {
    calls.append("prepare")
    currentPosition = source.positionSec
    isPaused = true
    if let prepareError { throw prepareError }
  }

  func activateAudioSession() throws {
    calls.append("activateAudio")
    isAudioActive = true
  }

  func play(rate: Float) {
    calls.append("play")
    playCount += 1
    isPaused = false
  }

  func pause() {
    calls.append("pause")
    pauseCount += 1
    isPaused = true
  }

  func startPictureInPicture(
    if shouldStart: @escaping @MainActor () -> Bool
  ) async throws {
    if suspendPiPStart {
      await withCheckedContinuation { continuation in
        startContinuation = continuation
      }
      startContinuation = nil
    }
    guard shouldStart() else { throw NativePlaybackError.cancelled }
    calls.append("startPiP")
  }

  func resumePendingPiPStart() {
    startContinuation?.resume()
  }

  func stopPictureInPicture() {
    calls.append("stopPiP")
  }

  func cleanup() {
    cleanupCount += 1
    didCleanup = true
    observersRemoved = true
    layerRemoved = true
    isAudioActive = false
    callbacks = NativePlaybackRuntimeCallbacks()
  }
}

private final class FakeNativePlaybackLease: NativePlaybackLease {
  private(set) var releaseCount = 0
  var isReleased: Bool { releaseCount > 0 }

  func release() {
    guard releaseCount == 0 else { return }
    releaseCount += 1
  }
}

@MainActor
private final class FakeNativePlaybackSourceLeaser: NativePlaybackSourceLeasing {
  var lease: NativePlaybackLease?
  private(set) var requestedURLs: [URL] = []

  init(lease: NativePlaybackLease?) {
    self.lease = lease
  }

  func retainOwnedSource(_ url: URL) async -> NativePlaybackLease? {
    requestedURLs.append(url)
    return lease
  }
}

@MainActor
private final class FakeNativePlaybackScheduler: NativePlaybackScheduling {
  private var tasks: [FakeNativePlaybackScheduledTask] = []

  func schedule(
    after delay: TimeInterval,
    _ operation: @escaping @MainActor () -> Void
  ) -> NativePlaybackScheduledTask {
    let task = FakeNativePlaybackScheduledTask(operation)
    tasks.append(task)
    return task
  }

  func fireNext() {
    guard let task = tasks.first(where: { !$0.isCancelled && !$0.didFire }) else { return }
    task.fire()
  }
}

@MainActor
private final class FakeNativePlaybackScheduledTask: NativePlaybackScheduledTask {
  private let operation: @MainActor () -> Void
  private(set) var isCancelled = false
  private(set) var didFire = false

  init(_ operation: @escaping @MainActor () -> Void) {
    self.operation = operation
  }

  func cancel() { isCancelled = true }

  func fire() {
    guard !isCancelled, !didFire else { return }
    didFire = true
    operation()
  }
}

@MainActor
private final class NativePlaybackEventRecorder {
  private(set) var values: [NativePlaybackEvent] = []
  func send(_ event: NativePlaybackEvent) { values.append(event) }
}

private func XCTAssertThrowsErrorAsync(
  _ expression: @escaping @MainActor () async throws -> Void,
  verify: @escaping (Error) -> Void,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    try await expression()
    XCTFail("Expected expression to throw", file: file, line: line)
  } catch {
    verify(error)
  }
}
