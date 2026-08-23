import XCTest
@testable import Movix

final class CastNetworkSelectorTests: XCTestCase {
  func testSelectsOnlyActiveRunningWiFiOnTheReceiverSubnet() throws {
    let selection = try CastNetworkSelector.select(
      candidates: [
        candidate("pdp_ip0", "192.168.1.10", type: .cellular),
        candidate("wifi42", "192.168.1.20"),
        candidate("wifi-down", "192.168.1.30", isUp: false),
        candidate("wifi-stopped", "192.168.1.31", isRunning: false),
      ],
      receiverAddress: "192.168.1.40"
    )

    XCTAssertEqual(selection.interfaceName, "wifi42")
    XCTAssertEqual(selection.localAddress, ip("192.168.1.20"))
    XCTAssertEqual(selection.receiverAddress, ip("192.168.1.40"))
    XCTAssertEqual(selection.prefixLength, 24)
  }

  func testRejectsSameFamilyAddressesOnDifferentSubnets() {
    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi42", "192.168.2.20")],
        receiverAddress: "192.168.1.40"
      )
    ) { error in
      XCTAssertEqual(error as? CastNetworkSelectionError, .noUsableWiFiRoute)
    }
  }

  func testRejectsAddressFamilyMismatch() {
    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi-ipv6", "fd12:3456:789a:1::20", prefixLength: 64)],
        receiverAddress: "192.168.1.40"
      )
    ) { error in
      XCTAssertEqual(error as? CastNetworkSelectionError, .noUsableWiFiRoute)
    }
  }

  func testChoosesLongestPrefixBeforeDeterministicInterfaceOrdering() throws {
    let selection = try CastNetworkSelector.select(
      candidates: [
        candidate("a-wifi", "10.10.0.30", prefixLength: 16),
        candidate("z-wifi", "10.10.8.20", prefixLength: 24),
      ],
      receiverAddress: "10.10.8.40"
    )

    XCTAssertEqual(selection.interfaceName, "z-wifi")
    XCTAssertEqual(selection.prefixLength, 24)
  }

  func testSelectsIPv4SubnetsWithNonByteAlignedPrefixes() throws {
    let cases = [
      (local: "192.168.2.10", receiver: "192.168.3.40", prefix: 23),
      (local: "192.168.1.130", receiver: "192.168.1.200", prefix: 25),
      (local: "192.168.1.10", receiver: "192.168.1.11", prefix: 31),
    ]

    for route in cases {
      let selection = try CastNetworkSelector.select(
        candidates: [candidate("wifi42", route.local, prefixLength: route.prefix)],
        receiverAddress: route.receiver
      )
      XCTAssertEqual(selection.localAddress, ip(route.local))
      XCTAssertEqual(selection.receiverAddress, ip(route.receiver))
      XCTAssertEqual(selection.prefixLength, route.prefix)
    }
  }

  func testSelectsIPv6SubnetsWithNonByteAlignedPrefixes() throws {
    let cases = [
      (
        local: "fd12:3456:789a:1:1::20",
        receiver: "fd12:3456:789a:1:2::40",
        prefix: 65
      ),
      (
        local: "fd12:3456:789a:1::20",
        receiver: "fd12:3456:789a:1::21",
        prefix: 127
      ),
    ]

    for route in cases {
      let selection = try CastNetworkSelector.select(
        candidates: [candidate("wifi-ipv6", route.local, prefixLength: route.prefix)],
        receiverAddress: route.receiver
      )
      XCTAssertEqual(selection.localAddress, ip(route.local))
      XCTAssertEqual(selection.receiverAddress, ip(route.receiver))
      XCTAssertEqual(selection.prefixLength, route.prefix)
    }
  }

  func testRejectsTheLocalAddressAsReceiverForHostRoutes() {
    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi42", "192.168.1.20", prefixLength: 32)],
        receiverAddress: "192.168.1.20"
      )
    ) { error in
      XCTAssertEqual(error as? CastNetworkSelectionError, .noUsableWiFiRoute)
    }

    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi-ipv6", "fd12:3456:789a:1::20", prefixLength: 128)],
        receiverAddress: "fd12:3456:789a:1::20"
      )
    ) { error in
      XCTAssertEqual(error as? CastNetworkSelectionError, .noUsableWiFiRoute)
    }
  }

  func testBreaksEqualPrefixTiesByInterfaceNameThenAddressBytes() throws {
    let byName = try CastNetworkSelector.select(
      candidates: [
        candidate("z-wifi", "192.168.1.10"),
        candidate("a-wifi", "192.168.1.30"),
      ],
      receiverAddress: "192.168.1.40"
    )
    XCTAssertEqual(byName.interfaceName, "a-wifi")

    let byAddress = try CastNetworkSelector.select(
      candidates: [
        candidate("wifi42", "192.168.1.30"),
        candidate("wifi42", "192.168.1.10"),
      ],
      receiverAddress: "192.168.1.40"
    )
    XCTAssertEqual(byAddress.localAddress, ip("192.168.1.10"))
  }

  func testSelectsIPv6ULAAndFormatsBracketedURLAuthority() throws {
    let selection = try CastNetworkSelector.select(
      candidates: [candidate("wifi-ipv6", "fd12:3456:789a:1::20", prefixLength: 64)],
      receiverAddress: "fd12:3456:789a:1::40"
    )

    XCTAssertEqual(selection.localAddress, ip("fd12:3456:789a:1::20"))
    XCTAssertEqual(selection.receiverAddress, ip("fd12:3456:789a:1::40"))
    XCTAssertTrue(selection.localURLAuthorityHost.hasPrefix("["))
    XCTAssertTrue(selection.localURLAuthorityHost.hasSuffix("]"))
    XCTAssertFalse(selection.localURLAuthorityHost.contains("%"))
  }

  func testRejectsInvalidScopedAndIPv4MappedReceiverAddresses() {
    for literal in ["", "chromecast.local", "fe80::1%wifi42"] {
      XCTAssertThrowsError(
        try CastNetworkSelector.select(
          candidates: [candidate("wifi42", "192.168.1.20")],
          receiverAddress: literal
        )
      ) { error in
        XCTAssertEqual(error as? CastNetworkSelectionError, .invalidReceiverAddress, literal)
      }
    }

    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi42", "fd12:3456:789a:1::20", prefixLength: 64)],
        receiverAddress: "::ffff:192.168.1.40"
      )
    ) { error in
      XCTAssertEqual(error as? CastNetworkSelectionError, .unusableReceiverAddress)
    }

    for literal in ["0.0.0.0", "127.0.0.1", "169.254.1.2", "224.0.0.1", "::", "::1", "fe80::1", "ff02::1"] {
      XCTAssertThrowsError(
        try CastNetworkSelector.select(
          candidates: [candidate("wifi42", "192.168.1.20")],
          receiverAddress: literal
        ),
        literal
      ) { error in
        XCTAssertEqual(error as? CastNetworkSelectionError, .unusableReceiverAddress, literal)
      }
    }
  }

  func testRejectsUnspecifiedLoopbackLinkLocalMulticastAndReservedAddresses() {
    let invalidIPv4 = ["0.0.0.0", "127.0.0.1", "169.254.1.2", "224.0.0.1", "240.0.0.1", "255.255.255.255"]
    for literal in invalidIPv4 {
      XCTAssertThrowsError(
        try CastNetworkSelector.select(
          candidates: [candidate("wifi42", literal)],
          receiverAddress: "192.168.1.40"
        ),
        literal
      )
    }

    let invalidIPv6 = ["::", "::1", "fe80::1", "ff02::1", "::192.0.2.1", "::ffff:192.0.2.1"]
    for literal in invalidIPv6 {
      XCTAssertThrowsError(
        try CastNetworkSelector.select(
          candidates: [candidate("wifi42", literal, prefixLength: 64)],
          receiverAddress: "fd12:3456:789a:1::40"
        ),
        literal
      )
    }
  }

  func testRejectsIPv4NetworkAndDirectedBroadcastHosts() {
    for localAddress in ["192.168.1.0", "192.168.1.255"] {
      XCTAssertThrowsError(
        try CastNetworkSelector.select(
          candidates: [candidate("wifi42", localAddress)],
          receiverAddress: "192.168.1.40"
        ),
        localAddress
      )
    }

    XCTAssertThrowsError(
      try CastNetworkSelector.select(
        candidates: [candidate("wifi42", "192.168.1.20")],
        receiverAddress: "192.168.1.255"
      )
    )
  }

  func testSelectionStillValidRequiresTheExactBestRoute() throws {
    let originalCandidates = [candidate("wifi42", "192.168.1.20")]
    let selection = try CastNetworkSelector.select(
      candidates: originalCandidates,
      receiverAddress: "192.168.1.40"
    )

    XCTAssertTrue(
      CastNetworkSelector.selectionStillValid(
        selection,
        candidates: originalCandidates,
        receiverAddress: "192.168.1.40"
      )
    )
    XCTAssertFalse(
      CastNetworkSelector.selectionStillValid(
        selection,
        candidates: [candidate("other-wifi", "192.168.1.21")],
        receiverAddress: "192.168.1.40"
      )
    )
    XCTAssertFalse(
      CastNetworkSelector.selectionStillValid(
        selection,
        candidates: originalCandidates,
        receiverAddress: "192.168.1.41"
      )
    )
  }

  func testCollectorUsesArbitraryActiveWiFiNamesAndPreservesInterfaceState() {
    let records = [
      candidate("wifi42", "192.168.1.20", type: .other),
      candidate("ethernet9", "192.168.1.21", type: .other),
    ]
    let collector = CastNetworkRouteCollector(enumerateAddresses: { records })

    let snapshot = collector.snapshot(
      pathSatisfied: true,
      activeInterfaces: [
        CastRouteInterface(name: "wifi42", type: .wifi),
        CastRouteInterface(name: "ethernet9", type: .wired),
      ]
    )

    XCTAssertEqual(snapshot.candidates.count, 1)
    XCTAssertEqual(snapshot.candidates.first?.name, "wifi42")
    XCTAssertEqual(snapshot.candidates.first?.type, .wifi)
    XCTAssertEqual(snapshot.candidates.first?.isUp, true)
    XCTAssertEqual(snapshot.candidates.first?.isRunning, true)
  }

  func testCollectorReturnsNoRouteWhenPathIsNotSatisfied() {
    let records = [candidate("wifi42", "192.168.1.20", type: .other)]
    let collector = CastNetworkRouteCollector(enumerateAddresses: { records })

    XCTAssertEqual(
      collector.snapshot(
        pathSatisfied: false,
        activeInterfaces: [CastRouteInterface(name: "wifi42", type: .wifi)]
      ),
      CastRouteSnapshot(candidates: [])
    )
  }

  func testDeliveryCancelWaitsForAnAdmittedHandlerAndRejectsLaterDelivery() {
    let queue = DispatchQueue(label: "com.movix.tests.cast-delivery-barrier")
    let delivery = CastNetworkSnapshotDelivery(queue: queue)
    let handlerEntered = DispatchSemaphore(value: 0)
    let allowHandlerToReturn = DispatchSemaphore(value: 0)
    let cancelStarted = DispatchSemaphore(value: 0)
    let cancelReturned = DispatchSemaphore(value: 0)
    let laterHandler = expectation(description: "cancelled delivery must never invoke its handler again")
    laterHandler.isInverted = true
    let invocationCount = CastNetworkTestCounter()

    XCTAssertTrue(
      delivery.start { _ in
        let currentInvocation = invocationCount.increment()
        if currentInvocation == 1 {
          handlerEntered.signal()
          XCTAssertEqual(allowHandlerToReturn.wait(timeout: .now() + 2), .success)
        } else {
          laterHandler.fulfill()
        }
      }
    )

    delivery.deliver { CastRouteSnapshot(candidates: []) }
    XCTAssertEqual(handlerEntered.wait(timeout: .now() + 1), .success)

    DispatchQueue.global(qos: .userInitiated).async {
      cancelStarted.signal()
      delivery.cancel()
      cancelReturned.signal()
    }
    XCTAssertEqual(cancelStarted.wait(timeout: .now() + 1), .success)
    XCTAssertEqual(
      cancelReturned.wait(timeout: .now() + 0.05),
      .timedOut,
      "cancel must be a synchronous barrier for an admitted callback"
    )

    allowHandlerToReturn.signal()
    XCTAssertEqual(cancelReturned.wait(timeout: .now() + 1), .success)
    delivery.deliver { CastRouteSnapshot(candidates: []) }
    wait(for: [laterHandler], timeout: 0.1)

    XCTAssertEqual(invocationCount.value, 1)
  }

  func testDeliveryCanCancelFromItsOwnHandlerWithoutDeadlockOrRedelivery() {
    let queue = DispatchQueue(label: "com.movix.tests.cast-delivery-self-cancel")
    let delivery = CastNetworkSnapshotDelivery(queue: queue)
    let firstHandlerReturned = expectation(description: "self-cancelling handler returned")
    let laterHandler = expectation(description: "queued delivery after self-cancel is rejected")
    laterHandler.isInverted = true
    let invocationCount = CastNetworkTestCounter()

    XCTAssertTrue(
      delivery.start { _ in
        let currentInvocation = invocationCount.increment()
        if currentInvocation == 1 {
          delivery.cancel()
          firstHandlerReturned.fulfill()
        } else {
          laterHandler.fulfill()
        }
      }
    )

    delivery.deliver { CastRouteSnapshot(candidates: []) }
    delivery.deliver { CastRouteSnapshot(candidates: []) }
    wait(for: [firstHandlerReturned], timeout: 1)
    wait(for: [laterHandler], timeout: 0.1)

    XCTAssertEqual(invocationCount.value, 1)
  }

  private func candidate(
    _ name: String,
    _ address: String,
    prefixLength: Int = 24,
    type: LocalInterfaceType = .wifi,
    isUp: Bool = true,
    isRunning: Bool = true
  ) -> LocalInterfaceAddress {
    LocalInterfaceAddress(
      name: name,
      address: ip(address),
      prefixLength: prefixLength,
      type: type,
      isUp: isUp,
      isRunning: isRunning
    )
  }

  private func ip(_ literal: String) -> MediaProxyIPAddress {
    guard let address = MediaProxyIPAddress(literal) else {
      XCTFail("Expected a valid test IP literal: \(literal)")
      return .v4([0, 0, 0, 0])
    }
    return address
  }
}

private final class CastNetworkTestCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  func increment() -> Int {
    lock.lock()
    defer { lock.unlock() }
    count += 1
    return count
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}
