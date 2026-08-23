import XCTest
@testable import Movix

final class PlaybackAwakeModuleTests: XCTestCase {
  func testReleasingOneOwnerKeepsTheOtherOwnersAwake() {
    var isIdleTimerDisabled = false
    let module = PlaybackAwakeModule { disabled in
      isIdleTimerDisabled = disabled
    }

    module.setLocalPlaybackAwake(true)
    module.setPlaybackAwakeOwner("pip", active: true)
    module.setPlaybackAwakeOwner("cast", active: true)
    module.setLocalPlaybackAwake(false)
    module.setPlaybackAwakeOwner("cast", active: false)

    XCTAssertTrue(isIdleTimerDisabled)

    module.setPlaybackAwakeOwner("pip", active: false)

    XCTAssertFalse(isIdleTimerDisabled)
  }

  func testInvalidOwnersCannotChangeAwakeState() {
    var updates = [Bool]()
    let module = PlaybackAwakeModule { updates.append($0) }

    for owner in ["", "PIP", "cast!", String(repeating: "a", count: 33)] {
      module.setPlaybackAwakeOwner(owner, active: true)
    }

    XCTAssertTrue(updates.isEmpty)
  }

  func testOwnerMutationRunsOnTheMainThread() {
    let updated = expectation(description: "idle timer updated")
    let module = PlaybackAwakeModule { disabled in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertTrue(disabled)
      updated.fulfill()
    }

    DispatchQueue.global(qos: .userInitiated).async {
      module.setPlaybackAwakeOwner("pip", active: true)
    }

    wait(for: [updated], timeout: 1)
  }

  func testInvalidateReleasesEveryOwnerAndRejectsLateMutations() {
    var updates = [Bool]()
    let module = PlaybackAwakeModule { updates.append($0) }

    module.setPlaybackAwakeOwner("pip", active: true)
    module.setPlaybackAwakeOwner("cast", active: true)
    module.invalidate()
    module.invalidate()
    module.setLocalPlaybackAwake(true)

    XCTAssertEqual(updates, [true, true, false])
  }
}
