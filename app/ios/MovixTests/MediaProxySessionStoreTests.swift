import XCTest
@testable import Movix

final class MediaProxySessionStoreTests: XCTestCase {
  private let firstTarget = MediaProxyTarget(
    upstreamURL: URL(string: "https://cdn.example/master.m3u8")!,
    method: "GET",
    headers: ["Origin": "https://movix.tax"]
  )

  func testOnlyAuthenticatedLiveTokensResolveAndAbsoluteExpiryIsIndependentFromIdle() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(clock: { clock.now }, idleTTL: 60, absoluteTTL: 300)
    let registered = try await store.registerLoopback(firstTarget)

    let resolved = await store.resolveLoopback(
      processSecret: store.processSecret,
      sessionID: registered.sessionID,
      resourceID: registered.resourceID
    )
    XCTAssertEqual(resolved?.target, firstTarget)
    let wrongSecret = await store.resolveLoopback(
      processSecret: differentValidToken(from: store.processSecret),
      sessionID: registered.sessionID,
      resourceID: registered.resourceID
    )
    XCTAssertNil(wrongSecret)

    for _ in 0..<5 {
      clock.advance(by: 59)
      let refreshed = await resolve(registered, in: store)
      XCTAssertNotNil(refreshed)
    }
    clock.advance(by: 5)
    let expired = await store.resolveLoopback(
      processSecret: store.processSecret,
      sessionID: registered.sessionID,
      resourceID: registered.resourceID
    )
    XCTAssertNil(expired)
  }

  func testIdleExpiryAppliesAtTheExactBoundary() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(clock: { clock.now }, idleTTL: 10, absoluteTTL: 100)
    let registered = try await store.registerLoopback(firstTarget)

    clock.advance(by: 10)

    let expired = await resolve(registered, in: store)
    XCTAssertNil(expired)
  }

  func testIdleExpiryRefreshesOnlyAfterSuccessfulAccess() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(clock: { clock.now }, idleTTL: 10, absoluteTTL: 100)
    let registered = try await store.registerLoopback(firstTarget)

    clock.advance(by: 9)
    let firstRefresh = await resolve(registered, in: store)
    XCTAssertNotNil(firstRefresh)
    clock.advance(by: 9)
    let secondRefresh = await resolve(registered, in: store)
    XCTAssertNotNil(secondRefresh)
    let wrongSecret = await store.resolveLoopback(
      processSecret: differentValidToken(from: store.processSecret),
      sessionID: registered.sessionID,
      resourceID: registered.resourceID
    )
    XCTAssertNil(wrongSecret)
    clock.advance(by: 11)
    let expired = await resolve(registered, in: store)
    XCTAssertNil(expired)
  }

  func testRejectsBadTokenSyntaxBeforeResolution() async throws {
    let store = MediaProxySessionStore()
    let registered = try await store.registerLoopback(firstTarget)
    let malformed = ["", "short", String(repeating: "A", count: 42), String(repeating: "A", count: 44), String(repeating: ".", count: 43)]

    for token in malformed {
      let badSecret = await store.resolveLoopback(
        processSecret: token,
        sessionID: registered.sessionID,
        resourceID: registered.resourceID
      )
      XCTAssertNil(badSecret)
      let badSession = await store.resolveLoopback(
        processSecret: store.processSecret,
        sessionID: token,
        resourceID: registered.resourceID
      )
      XCTAssertNil(badSession)
      let badResource = await store.resolveLoopback(
        processSecret: store.processSecret,
        sessionID: registered.sessionID,
        resourceID: token
      )
      XCTAssertNil(badResource)
    }
  }

  func testNormalizesMethodURLAndHeadersAtStorageBoundary() async throws {
    let store = MediaProxySessionStore()
    let target = MediaProxyTarget(
      upstreamURL: URL(string: "HTTPS://video.example:443/stream.m3u8")!,
      method: " head ",
      headers: [
        " origin ": " https://movix.tax ",
        "Range": " bytes=10- ",
        "Cookie": "session=secret",
        "Authorization": "Bearer secret",
        "Host": "private.internal",
        "X-Other": "discarded",
      ]
    )

    let registered = try await store.registerLoopback(target)
    let storedResource = await resolve(registered, in: store)
    let resolved = try XCTUnwrap(storedResource)

    XCTAssertEqual(resolved.target.method, "HEAD")
    XCTAssertEqual(resolved.target.upstreamURL.scheme?.lowercased(), "https")
    XCTAssertEqual(resolved.target.upstreamURL.port, 443)
    XCTAssertEqual(resolved.target.headers, [
      "Origin": "https://movix.tax",
      "Range": "bytes=10-",
    ])
  }

  func testRejectsUnsupportedMethodsAndUnsafeUpstreamURLs() async {
    let store = MediaProxySessionStore()
    let badTargets = [
      MediaProxyTarget(upstreamURL: URL(string: "http://video.example/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://user:pass@video.example/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://localhost/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://127.0.0.1/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://10.0.0.1/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://video.example:8443/a")!, method: "GET", headers: [:]),
      MediaProxyTarget(upstreamURL: URL(string: "https://video.example/a")!, method: "POST", headers: [:]),
    ]

    for target in badTargets {
      do {
        _ = try await store.registerLoopback(target)
        XCTFail("Expected target rejection")
      } catch {
        XCTAssertEqual(error as? MediaProxySessionStoreError, .invalidTarget)
      }
    }
  }

  func testSessionCapacityEvictsTheLeastRecentlyUsedLiveSession() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 100,
      absoluteTTL: 1_000,
      maximumSessions: 2
    )
    let first = try await store.registerLoopback(firstTarget)
    clock.advance(by: 1)
    let second = try await store.registerLoopback(firstTarget)
    clock.advance(by: 1)
    let refreshedFirst = await resolve(first, in: store)
    XCTAssertNotNil(refreshedFirst)
    clock.advance(by: 1)
    let third = try await store.registerLoopback(firstTarget)

    let retainedFirst = await resolve(first, in: store)
    let evictedSecond = await resolve(second, in: store)
    let retainedThird = await resolve(third, in: store)
    XCTAssertNotNil(retainedFirst)
    XCTAssertNil(evictedSecond)
    XCTAssertNotNil(retainedThird)
  }

  func testExpiredSessionsArePurgedBeforeCapacityEviction() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 5,
      absoluteTTL: 100,
      maximumSessions: 1
    )
    let expired = try await store.registerLoopback(firstTarget)
    clock.advance(by: 6)
    let replacement = try await store.registerLoopback(firstTarget)

    let expiredResult = await resolve(expired, in: store)
    let replacementResult = await resolve(replacement, in: store)
    XCTAssertNil(expiredResult)
    XCTAssertNotNil(replacementResult)
  }

  func testLocalizationRequiresALiveSessionAndDeduplicatesNormalizedTargets() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 10,
      absoluteTTL: 100,
      maximumResourcesPerSession: 2
    )
    let root = try await store.registerLoopback(firstTarget)
    let localizedTarget = MediaProxyTarget(
      upstreamURL: URL(string: "https://cdn.example/segment.ts")!,
      method: "get",
      headers: [" range ": " bytes=0- "]
    )
    clock.advance(by: 9)
    let localized = try await store.localize(sessionID: root.sessionID, target: localizedTarget)
    XCTAssertEqual(localized.sessionID, root.sessionID)
    XCTAssertNotEqual(localized.resourceID, root.resourceID)
    let localizedResource = await resolve(localized, in: store)
    XCTAssertEqual(localizedResource?.target.method, "GET")
    let duplicate = try await store.localize(
      sessionID: root.sessionID,
      target: MediaProxyTarget(
        upstreamURL: URL(string: "https://cdn.example/segment.ts")!,
        method: " GET ",
        headers: ["Range": "bytes=0-"]
      )
    )
    XCTAssertEqual(duplicate, localized)

    clock.advance(by: 11)
    do {
      _ = try await store.localize(sessionID: root.sessionID, target: localizedTarget)
      XCTFail("Expected expired session rejection")
    } catch {
      XCTAssertEqual(error as? MediaProxySessionStoreError, .sessionUnavailable)
    }
  }

  func testSlidingPlaylistChurnKeepsRootAndRecentWindowWithinBounds() async throws {
    let store = MediaProxySessionStore(
      maximumResourcesPerSession: 4,
      maximumIdentifierTombstones: 5
    )
    let root = try await store.registerLoopback(firstTarget)
    var registrations: [Int: MediaProxyRegistration] = [:]

    for newest in 0..<50 {
      for sequence in max(0, newest - 2)...newest {
        registrations[sequence] = try await store.localize(
          sessionID: root.sessionID,
          target: segmentTarget(sequence)
        )
      }
    }

    let retainedRoot = await resolve(root, in: store)
    XCTAssertNotNil(retainedRoot)
    for sequence in 47...49 {
      let registration = try XCTUnwrap(registrations[sequence])
      let retainedSegment = await resolve(registration, in: store)
      XCTAssertNotNil(retainedSegment)
    }
    let evicted = try XCTUnwrap(registrations[0])
    let evictedSegment = await resolve(evicted, in: store)
    XCTAssertNil(evictedSegment)
    let diagnostics = await store.diagnostics()
    XCTAssertEqual(diagnostics.activeSessionCount, 1)
    XCTAssertEqual(diagnostics.activeResourceCount, 4)
    XCTAssertLessThanOrEqual(diagnostics.identifierTombstoneCount, 5)
  }

  func testIdentifierCollisionsRetryAndNeverReuseResourceIDs() async throws {
    let secret = token("S")
    let session = token("A")
    let firstResource = token("B")
    let secondResource = token("C")
    let tokens = MediaProxyTokenSequence([
      secret, session, firstResource,
      firstResource, firstResource, secondResource,
    ])
    let store = MediaProxySessionStore(tokenGenerator: { tokens.next() })
    let root = try await store.registerLoopback(firstTarget)
    let localized = try await store.localize(
      sessionID: root.sessionID,
      target: segmentTarget(1)
    )

    XCTAssertEqual(store.processSecret, secret)
    XCTAssertEqual(root.resourceID, firstResource)
    XCTAssertEqual(localized.resourceID, secondResource)
  }

  func testRotationAtomicallyRedirectsOldCredentialsDuringBoundedGrace() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 1_000,
      absoluteTTL: 100,
      rotationLeadTime: 20,
      transitionGraceTTL: 10,
      maximumTransitions: 1,
      maximumIdentifierTombstones: 3
    )
    let root = try await store.registerLoopback(firstTarget)
    let segment = try await store.localize(sessionID: root.sessionID, target: segmentTarget(1))

    clock.advance(by: 79)
    do {
      _ = try await store.rotate(sessionID: root.sessionID)
      XCTFail("Expected rotation to be unavailable before the lead window")
    } catch {
      XCTAssertEqual(error as? MediaProxySessionStoreError, .rotationNotDue)
    }
    clock.advance(by: 1)
    let rotation = try await store.rotate(sessionID: root.sessionID)
    let successorRoot = try XCTUnwrap(rotation.resources[root.resourceID])
    let successorSegment = try XCTUnwrap(rotation.resources[segment.resourceID])

    XCTAssertEqual(rotation.previousSessionID, root.sessionID)
    XCTAssertEqual(rotation.successorSessionID, successorRoot.sessionID)
    XCTAssertEqual(successorSegment.sessionID, successorRoot.sessionID)
    let oldDirectResolution = await resolve(root, in: store)
    XCTAssertNil(oldDirectResolution)
    let initialRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: root.sessionID,
      resourceID: root.resourceID
    )
    XCTAssertEqual(
      initialRedirect,
      .redirect(successorRoot)
    )
    let initialSegmentRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: segment.sessionID,
      resourceID: segment.resourceID
    )
    XCTAssertEqual(initialSegmentRedirect, .redirect(successorSegment))
    let resolvedSuccessorRoot = await resolve(successorRoot, in: store)
    let resolvedSuccessorSegment = await resolve(successorSegment, in: store)
    XCTAssertEqual(resolvedSuccessorRoot?.target, firstTarget)
    XCTAssertEqual(resolvedSuccessorSegment?.target, segmentTarget(1))
    let liveDiagnostics = await store.diagnostics()
    XCTAssertEqual(liveDiagnostics.activeSessionCount, 1)
    XCTAssertEqual(liveDiagnostics.transitionCount, 1)
    XCTAssertEqual(liveDiagnostics.transitionResourceCount, 2)

    clock.advance(by: 29)
    let finalRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: root.sessionID,
      resourceID: root.resourceID
    )
    XCTAssertEqual(
      finalRedirect,
      .redirect(successorRoot)
    )
    clock.advance(by: 1)
    let expiredRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: root.sessionID,
      resourceID: root.resourceID
    )
    XCTAssertNil(expiredRedirect)
    let liveSuccessor = await resolve(successorRoot, in: store)
    XCTAssertNotNil(liveSuccessor)
    let expiredDiagnostics = await store.diagnostics()
    XCTAssertEqual(expiredDiagnostics.transitionCount, 0)
    XCTAssertLessThanOrEqual(expiredDiagnostics.identifierTombstoneCount, 3)
    clock.advance(by: 69)
    let successorBeforeAbsoluteExpiry = await resolve(successorRoot, in: store)
    XCTAssertNotNil(successorBeforeAbsoluteExpiry)
    clock.advance(by: 1)
    let successorAtAbsoluteExpiry = await resolve(successorRoot, in: store)
    XCTAssertNil(successorAtAbsoluteExpiry)
  }

  func testRotationSynchronouslyRevokesRootAndSegmentLeases() async throws {
    let store = MediaProxySessionStore(
      idleTTL: 1_000,
      absoluteTTL: 100,
      rotationLeadTime: 100,
      transitionGraceTTL: 10
    )
    let root = try await store.registerLoopback(firstTarget)
    let segment = try await store.localize(sessionID: root.sessionID, target: segmentTarget(1))
    let rootAccessResult = await leasedResolve(root, in: store)
    let segmentAccessResult = await leasedResolve(segment, in: store)
    let rootAccess = try XCTUnwrap(rootAccessResult)
    let segmentAccess = try XCTUnwrap(segmentAccessResult)
    var emitted: [String] = []

    let rootBefore = rootAccess.lease.withValidAccess {
      emitted.append("root-before")
      return true
    }
    let segmentBefore = segmentAccess.lease.withValidAccess {
      emitted.append("segment-before")
      return true
    }
    XCTAssertEqual(rootBefore, true)
    XCTAssertEqual(segmentBefore, true)

    _ = try await store.rotate(sessionID: root.sessionID)

    let rootAfter = rootAccess.lease.withValidAccess {
      emitted.append("root-after")
      return true
    }
    let segmentAfter = segmentAccess.lease.withValidAccess {
      emitted.append("segment-after")
      return true
    }
    XCTAssertNil(rootAfter)
    XCTAssertNil(segmentAfter)
    XCTAssertEqual(emitted, ["root-before", "segment-before"])
    rootAccess.lease.release()
    segmentAccess.lease.release()
  }

  func testInvalidationWaitsForActiveEmissionThenRejectsEveryLaterSection() async throws {
    let store = MediaProxySessionStore()
    let root = try await store.registerLoopback(firstTarget)
    let accessResult = await leasedResolve(root, in: store)
    let access = try XCTUnwrap(accessResult)
    let enteredEmission = DispatchSemaphore(value: 0)
    let allowEmissionToFinish = DispatchSemaphore(value: 0)
    let emissionFinished = DispatchSemaphore(value: 0)
    let invalidationStarted = DispatchSemaphore(value: 0)
    let invalidationFinished = DispatchSemaphore(value: 0)

    DispatchQueue.global().async {
      _ = access.lease.withValidAccess {
        enteredEmission.signal()
        _ = allowEmissionToFinish.wait(timeout: .now() + 2)
      }
      emissionFinished.signal()
    }
    XCTAssertEqual(enteredEmission.wait(timeout: .now() + 2), .success)

    Task {
      invalidationStarted.signal()
      await store.invalidate(sessionID: root.sessionID)
      invalidationFinished.signal()
    }
    XCTAssertEqual(invalidationStarted.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(invalidationFinished.wait(timeout: .now() + 0.05), .timedOut)

    allowEmissionToFinish.signal()
    XCTAssertEqual(emissionFinished.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(invalidationFinished.wait(timeout: .now() + 2), .success)

    var emittedAfterInvalidation = false
    let denied = access.lease.withValidAccess {
      emittedAfterInvalidation = true
      return true
    }
    XCTAssertNil(denied)
    XCTAssertFalse(emittedAfterInvalidation)
    access.lease.release()
  }

  func testLeaseEnforcesIdleAndAbsoluteDeadlinesWithoutActorPurge() async throws {
    let idleClock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let idleStore = MediaProxySessionStore(
      clock: { idleClock.now },
      idleTTL: 10,
      absoluteTTL: 100
    )
    let idleRoot = try await idleStore.registerLoopback(firstTarget)
    let idleSegment = try await idleStore.localize(
      sessionID: idleRoot.sessionID,
      target: segmentTarget(1)
    )
    let idleRootAccessResult = await leasedResolve(idleRoot, in: idleStore)
    let idleSegmentAccessResult = await leasedResolve(idleSegment, in: idleStore)
    let idleRootAccess = try XCTUnwrap(idleRootAccessResult)
    let idleSegmentAccess = try XCTUnwrap(idleSegmentAccessResult)

    idleClock.advance(by: 10)
    XCTAssertNil(idleRootAccess.lease.withValidAccess { true })
    XCTAssertNil(idleSegmentAccess.lease.withValidAccess { true })
    idleRootAccess.lease.release()
    idleSegmentAccess.lease.release()

    let absoluteClock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let absoluteStore = MediaProxySessionStore(
      clock: { absoluteClock.now },
      idleTTL: 10,
      absoluteTTL: 30
    )
    let absoluteRoot = try await absoluteStore.registerLoopback(firstTarget)
    let absoluteSegment = try await absoluteStore.localize(
      sessionID: absoluteRoot.sessionID,
      target: segmentTarget(1)
    )
    let absoluteRootAccessResult = await leasedResolve(absoluteRoot, in: absoluteStore)
    let absoluteSegmentAccessResult = await leasedResolve(absoluteSegment, in: absoluteStore)
    let absoluteRootAccess = try XCTUnwrap(absoluteRootAccessResult)
    let absoluteSegmentAccess = try XCTUnwrap(absoluteSegmentAccessResult)

    absoluteClock.advance(by: 9)
    XCTAssertEqual(absoluteRootAccess.lease.withValidAccess { true }, true)
    absoluteClock.advance(by: 9)
    XCTAssertEqual(absoluteSegmentAccess.lease.withValidAccess { true }, true)
    absoluteClock.advance(by: 9)
    XCTAssertEqual(absoluteRootAccess.lease.withValidAccess { true }, true)
    absoluteClock.advance(by: 3)
    XCTAssertNil(absoluteSegmentAccess.lease.withValidAccess { true })
    XCTAssertNil(absoluteRootAccess.lease.withValidAccess { true })
    absoluteRootAccess.lease.release()
    absoluteSegmentAccess.lease.release()
  }

  func testInvalidationAndResourceEvictionRevokeAffectedLeases() async throws {
    let evictionStore = MediaProxySessionStore(maximumResourcesPerSession: 2)
    let retainedRoot = try await evictionStore.registerLoopback(firstTarget)
    let evictedSegment = try await evictionStore.localize(
      sessionID: retainedRoot.sessionID,
      target: segmentTarget(1)
    )
    let retainedAccessResult = await leasedResolve(retainedRoot, in: evictionStore)
    let evictedAccessResult = await leasedResolve(evictedSegment, in: evictionStore)
    let retainedAccess = try XCTUnwrap(retainedAccessResult)
    let evictedAccess = try XCTUnwrap(evictedAccessResult)
    _ = try await evictionStore.localize(
      sessionID: retainedRoot.sessionID,
      target: segmentTarget(2)
    )
    XCTAssertEqual(retainedAccess.lease.withValidAccess { true }, true)
    XCTAssertNil(evictedAccess.lease.withValidAccess { true })

    await evictionStore.invalidate(sessionID: retainedRoot.sessionID)
    XCTAssertNil(retainedAccess.lease.withValidAccess { true })
    retainedAccess.lease.release()
    evictedAccess.lease.release()

    let sessionEvictionStore = MediaProxySessionStore(maximumSessions: 1)
    let evictedRoot = try await sessionEvictionStore.registerLoopback(firstTarget)
    let evictedRootAccessResult = await leasedResolve(evictedRoot, in: sessionEvictionStore)
    let evictedRootAccess = try XCTUnwrap(evictedRootAccessResult)
    _ = try await sessionEvictionStore.registerLoopback(firstTarget)
    XCTAssertNil(evictedRootAccess.lease.withValidAccess { true })
    evictedRootAccess.lease.release()
  }

  func testSuccessiveRotationsRetargetRootAndSegmentDirectlyToTerminalSuccessor() async throws {
    let clock = MutableMediaProxyClock(now: Date(timeIntervalSince1970: 100))
    let store = MediaProxySessionStore(
      clock: { clock.now },
      idleTTL: 1_000,
      absoluteTTL: 100,
      rotationLeadTime: 100,
      transitionGraceTTL: 10
    )
    let rootA = try await store.registerLoopback(firstTarget)
    let segmentA = try await store.localize(sessionID: rootA.sessionID, target: segmentTarget(1))
    let rotationAB = try await store.rotate(sessionID: rootA.sessionID)
    let rootB = try XCTUnwrap(rotationAB.resources[rootA.resourceID])
    let segmentB = try XCTUnwrap(rotationAB.resources[segmentA.resourceID])
    clock.advance(by: 1)
    let rotationBC = try await store.rotate(sessionID: rootB.sessionID)
    let rootC = try XCTUnwrap(rotationBC.resources[rootB.resourceID])
    let segmentC = try XCTUnwrap(rotationBC.resources[segmentB.resourceID])

    let rootAResult = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: rootA.sessionID,
      resourceID: rootA.resourceID
    )
    let segmentAResult = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: segmentA.sessionID,
      resourceID: segmentA.resourceID
    )
    let rootBResult = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: rootB.sessionID,
      resourceID: rootB.resourceID
    )
    let segmentBResult = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: segmentB.sessionID,
      resourceID: segmentB.resourceID
    )
    XCTAssertEqual(rootAResult, .redirect(rootC))
    XCTAssertEqual(segmentAResult, .redirect(segmentC))
    XCTAssertEqual(rootBResult, .redirect(rootC))
    XCTAssertEqual(segmentBResult, .redirect(segmentC))

    clock.advance(by: 100)
    _ = await store.diagnostics()
    let terminalA = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: rootA.sessionID,
      resourceID: rootA.resourceID
    )
    let terminalB = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: rootB.sessionID,
      resourceID: rootB.resourceID
    )
    XCTAssertNil(terminalA)
    XCTAssertNil(terminalB)
  }

  func testNonFiniteDurationsUseFiniteDefaultsForBothInitializers() async {
    let injectedToken = String(repeating: "S", count: 43)
    for invalid in [TimeInterval.nan, .infinity, -.infinity] {
      let stores = [
        MediaProxySessionStore(
          idleTTL: invalid,
          absoluteTTL: invalid,
          rotationLeadTime: invalid,
          transitionGraceTTL: invalid
        ),
        MediaProxySessionStore(
          idleTTL: invalid,
          absoluteTTL: invalid,
          rotationLeadTime: invalid,
          transitionGraceTTL: invalid,
          tokenGenerator: { injectedToken }
        ),
      ]
      for store in stores {
        let configuration = await store.configuration()
        XCTAssertEqual(configuration.idleTTL, 120)
        XCTAssertEqual(configuration.absoluteTTL, 1_800)
        XCTAssertEqual(configuration.rotationLeadTime, 120)
        XCTAssertEqual(configuration.transitionGraceTTL, 30)
        XCTAssertTrue(configuration.idleTTL.isFinite)
        XCTAssertTrue(configuration.absoluteTTL.isFinite)
        XCTAssertTrue(configuration.transitionGraceTTL.isFinite)
      }
    }
  }

  func testFiniteDurationBoundsUseSafeMinimumsAndMaximums() async {
    let minimumStore = MediaProxySessionStore(
      idleTTL: -1,
      absoluteTTL: 0,
      rotationLeadTime: -1,
      transitionGraceTTL: -1
    )
    let minimum = await minimumStore.configuration()
    XCTAssertEqual(minimum.idleTTL, 1)
    XCTAssertEqual(minimum.absoluteTTL, 1)
    XCTAssertEqual(minimum.rotationLeadTime, 1)
    XCTAssertEqual(minimum.transitionGraceTTL, 0)

    let maximumStore = MediaProxySessionStore(
      idleTTL: 10_000,
      absoluteTTL: 10_000,
      rotationLeadTime: 10_000,
      transitionGraceTTL: 10_000
    )
    let maximum = await maximumStore.configuration()
    XCTAssertEqual(maximum.idleTTL, 1_800)
    XCTAssertEqual(maximum.absoluteTTL, 1_800)
    XCTAssertEqual(maximum.rotationLeadTime, 300)
    XCTAssertEqual(maximum.transitionGraceTTL, 300)
  }

  func testIdentifierCollisionRetriesAreBounded() async throws {
    let secret = token("S")
    let session = token("A")
    let resource = token("B")
    let tokens = MediaProxyTokenSequence([secret, session, resource] + Array(repeating: session, count: 16))
    let store = MediaProxySessionStore(tokenGenerator: { tokens.next() })
    _ = try await store.registerLoopback(firstTarget)

    do {
      _ = try await store.registerLoopback(firstTarget)
      XCTFail("Expected bounded collision failure")
    } catch {
      XCTAssertEqual(error as? MediaProxySessionStoreError, .identifierGenerationFailed)
    }
  }

  func testCapacityCollisionFailureLeavesSessionTransitionsTombstonesAndLeaseUnchanged() async throws {
    let secret = token("S")
    let sessionA = token("A")
    let rootAID = token("B")
    let segmentAID = token("C")
    let sessionB = token("D")
    let rootBID = token("E")
    let segmentBID = token("F")
    let tokens = MediaProxyTokenSequence([
      secret,
      sessionA,
      rootAID,
      segmentAID,
      sessionB,
      rootBID,
      segmentBID,
    ] + Array(repeating: segmentBID, count: 16))
    let store = MediaProxySessionStore(
      idleTTL: 1_000,
      absoluteTTL: 100,
      maximumResourcesPerSession: 2,
      rotationLeadTime: 100,
      transitionGraceTTL: 10,
      tokenGenerator: { tokens.next() }
    )
    let rootA = try await store.registerLoopback(firstTarget)
    let segmentA = try await store.localize(
      sessionID: rootA.sessionID,
      target: segmentTarget(1)
    )
    let rotation = try await store.rotate(sessionID: rootA.sessionID)
    let rootB = try XCTUnwrap(rotation.resources[rootA.resourceID])
    let segmentB = try XCTUnwrap(rotation.resources[segmentA.resourceID])
    let segmentBAccessResult = await leasedResolve(segmentB, in: store)
    let segmentBAccess = try XCTUnwrap(segmentBAccessResult)
    let diagnosticsBefore = await store.diagnostics()

    do {
      _ = try await store.localize(
        sessionID: sessionB,
        target: segmentTarget(2)
      )
      XCTFail("Expected bounded collision failure")
    } catch {
      XCTAssertEqual(error as? MediaProxySessionStoreError, .identifierGenerationFailed)
    }

    let diagnosticsAfter = await store.diagnostics()
    XCTAssertEqual(diagnosticsAfter, diagnosticsBefore)
    XCTAssertEqual(segmentBAccess.lease.withValidAccess { true }, true)
    let retainedRoot = await resolve(rootB, in: store)
    let retainedSegment = await resolve(segmentB, in: store)
    XCTAssertNotNil(retainedRoot)
    XCTAssertNotNil(retainedSegment)
    let rootRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: rootA.sessionID,
      resourceID: rootA.resourceID
    )
    let segmentRedirect = await store.resolveLoopbackRequest(
      processSecret: store.processSecret,
      sessionID: segmentA.sessionID,
      resourceID: segmentA.resourceID
    )
    XCTAssertEqual(rootRedirect, .redirect(rootB))
    XCTAssertEqual(segmentRedirect, .redirect(segmentB))
    segmentBAccess.lease.release()
  }

  func testSessionCapacityCollisionFailureLeavesExistingSessionAndLeaseUnchanged() async throws {
    let secret = token("S")
    let existingSessionID = token("A")
    let existingResourceID = token("B")
    let tokens = MediaProxyTokenSequence([
      secret,
      existingSessionID,
      existingResourceID,
    ] + Array(repeating: existingSessionID, count: 16))
    let store = MediaProxySessionStore(
      maximumSessions: 1,
      tokenGenerator: { tokens.next() }
    )
    let existing = try await store.registerLoopback(firstTarget)
    let existingAccessResult = await leasedResolve(existing, in: store)
    let existingAccess = try XCTUnwrap(existingAccessResult)
    let diagnosticsBefore = await store.diagnostics()

    do {
      _ = try await store.registerLoopback(firstTarget)
      XCTFail("Expected bounded collision failure")
    } catch {
      XCTAssertEqual(error as? MediaProxySessionStoreError, .identifierGenerationFailed)
    }

    let diagnosticsAfter = await store.diagnostics()
    XCTAssertEqual(diagnosticsAfter, diagnosticsBefore)
    XCTAssertEqual(existingAccess.lease.withValidAccess { true }, true)
    let retained = await resolve(existing, in: store)
    XCTAssertNotNil(retained)
    existingAccess.lease.release()
  }

  func testRecentTombstonesRejectReplayWhileHistoricalStateStaysBounded() async throws {
    let secret = token("S")
    let retiredSession = token("A")
    let retiredResource = token("B")
    let successorSession = token("C")
    let successorResource = token("D")
    let tokens = MediaProxyTokenSequence([
      secret,
      retiredSession,
      retiredResource,
      retiredSession,
      successorSession,
      successorResource,
    ])
    let store = MediaProxySessionStore(
      maximumIdentifierTombstones: 2,
      tokenGenerator: { tokens.next() }
    )
    let first = try await store.registerLoopback(firstTarget)

    await store.invalidate(sessionID: first.sessionID)
    let second = try await store.registerLoopback(firstTarget)

    XCTAssertEqual(second.sessionID, successorSession)
    XCTAssertEqual(second.resourceID, successorResource)
    let diagnostics = await store.diagnostics()
    XCTAssertLessThanOrEqual(diagnostics.identifierTombstoneCount, 2)
  }

  func testInvalidateAndInvalidateAllTakeEffectImmediately() async throws {
    let store = MediaProxySessionStore()
    let first = try await store.registerLoopback(firstTarget)
    let second = try await store.registerLoopback(firstTarget)

    await store.invalidate(sessionID: first.sessionID)
    let invalidatedFirst = await resolve(first, in: store)
    let retainedSecond = await resolve(second, in: store)
    XCTAssertNil(invalidatedFirst)
    XCTAssertNotNil(retainedSecond)

    await store.invalidateAll()
    let invalidatedSecond = await resolve(second, in: store)
    XCTAssertNil(invalidatedSecond)
  }

  func testCastURLParserAcceptsOnlyExactAuthenticatedLoopbackPaths() async throws {
    let store = MediaProxySessionStore()
    let registered = try await store.registerLoopback(firstTarget)
    let basePath = "/p/\(store.processSecret)/\(registered.sessionID)/\(registered.resourceID)"

    let ipv4 = URL(string: "http://127.0.0.1:49152\(basePath)")!
    let ipv6 = URL(string: "http://[::1]:49152\(basePath)")!
    let ipv4Result = await store.resolveLoopbackURLForCast(ipv4)
    let ipv6Result = await store.resolveLoopbackURLForCast(ipv6)
    XCTAssertEqual(ipv4Result, firstTarget)
    XCTAssertEqual(ipv6Result, firstTarget)

    let rejected = [
      "https://127.0.0.1:49152\(basePath)",
      "http://localhost:49152\(basePath)",
      "http://127.0.0.2:49152\(basePath)",
      "http://[::ffff:127.0.0.1]:49152\(basePath)",
      "http://127.0.0.1\(basePath)",
      "http://user@127.0.0.1:49152\(basePath)",
      "http://127.0.0.1:49152\(basePath)?x=1",
      "http://127.0.0.1:49152\(basePath)#fragment",
      "http://127.0.0.1:49152/p/%53\(String(basePath.dropFirst(4)))",
      "http://127.0.0.1:49152/p/../\(registered.sessionID)/\(registered.resourceID)",
      "http://127.0.0.1:49152\(basePath)/extra",
    ]
    for raw in rejected {
      let result = await store.resolveLoopbackURLForCast(URL(string: raw)!)
      XCTAssertNil(result)
    }

    let adversarialAuthorities = [
      "HTTP://127.0.0.1:49152\(basePath)",
      "http://127.0.0.1:049152\(basePath)",
      "http://[0:0:0:0:0:0:0:1]:49152\(basePath)",
      "http://%31%32%37.0.0.1:49152\(basePath)",
      "http://127%2E0%2E0%2E1:49152\(basePath)",
      "http://127.0.0.1:%34%39%31%35%32\(basePath)",
    ]
    var foundationAcceptedCount = 0
    for raw in adversarialAuthorities {
      guard let url = URL(string: raw) else { continue }
      foundationAcceptedCount += 1
      let result = await store.resolveLoopbackURLForCast(url)
      XCTAssertNil(result, raw)
    }
    XCTAssertGreaterThanOrEqual(foundationAcceptedCount, 3)
  }

  private func resolve(
    _ registration: MediaProxyRegistration,
    in store: MediaProxySessionStore
  ) async -> MediaProxyResource? {
    await store.resolveLoopback(
      processSecret: store.processSecret,
      sessionID: registration.sessionID,
      resourceID: registration.resourceID
    )
  }

  private func leasedResolve(
    _ registration: MediaProxyRegistration,
    in store: MediaProxySessionStore
  ) async -> MediaProxyLeasedResource? {
    guard case let .resource(resource)? = await store.resolveLoopbackRequestWithLease(
      processSecret: store.processSecret,
      sessionID: registration.sessionID,
      resourceID: registration.resourceID
    ) else { return nil }
    return resource
  }

  private func token(_ character: Character) -> String {
    String(repeating: String(character), count: 43)
  }

  private func differentValidToken(from token: String) -> String {
    let replacement = token.first == "A" ? "B" : "A"
    return replacement + String(token.dropFirst())
  }

  private func segmentTarget(_ sequence: Int) -> MediaProxyTarget {
    MediaProxyTarget(
      upstreamURL: URL(string: "https://cdn.example/segment-\(sequence).ts")!,
      method: "GET",
      headers: [:]
    )
  }
}

private final class MutableMediaProxyClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date

  init(now: Date) {
    value = now
  }

  var now: Date {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func advance(by interval: TimeInterval) {
    lock.lock()
    defer { lock.unlock() }
    value.addTimeInterval(interval)
  }
}

private final class MediaProxyTokenSequence: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [String]

  init(_ tokens: [String]) {
    self.tokens = tokens
  }

  func next() -> String {
    lock.lock()
    defer { lock.unlock() }
    precondition(!tokens.isEmpty, "Test token sequence exhausted")
    return tokens.removeFirst()
  }
}
