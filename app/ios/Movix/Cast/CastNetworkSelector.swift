import Darwin
import Foundation
import Network

enum LocalInterfaceType: Equatable, Sendable {
  case wifi
  case cellular
  case wired
  case other
}

struct LocalInterfaceAddress: Equatable, Sendable {
  let name: String
  let address: MediaProxyIPAddress
  let prefixLength: Int
  let type: LocalInterfaceType
  let isUp: Bool
  let isRunning: Bool
}

struct CastNetworkSelection: Equatable, Sendable {
  let localAddress: MediaProxyIPAddress
  let receiverAddress: MediaProxyIPAddress
  let interfaceName: String
  let prefixLength: Int

  var localURLAuthorityHost: String {
    CastNetworkSelector.urlAuthorityHost(for: localAddress)
  }
}

struct CastRouteInterface: Equatable, Sendable {
  let name: String
  let type: LocalInterfaceType
}

struct CastRouteSnapshot: Equatable, Sendable {
  let candidates: [LocalInterfaceAddress]
}

enum CastNetworkSelectionError: String, Error, Equatable, Sendable {
  case invalidReceiverAddress = "MOVIX_CAST_RECEIVER_ADDRESS_INVALID"
  case unusableReceiverAddress = "MOVIX_CAST_RECEIVER_ADDRESS_UNUSABLE"
  case noUsableWiFiRoute = "MOVIX_CAST_NO_WIFI_ROUTE"
}

enum CastNetworkSelector {
  static func select(
    candidates: [LocalInterfaceAddress],
    receiverAddress receiverLiteral: String
  ) throws -> CastNetworkSelection {
    guard !receiverLiteral.contains("%"),
          let receiverAddress = MediaProxyIPAddress(receiverLiteral) else {
      throw CastNetworkSelectionError.invalidReceiverAddress
    }
    guard isUsableUnicast(receiverAddress) else {
      throw CastNetworkSelectionError.unusableReceiverAddress
    }

    let matchingCandidates = candidates.filter { candidate in
      guard candidate.type == .wifi,
            candidate.isUp && candidate.isRunning,
            validPrefixLength(candidate.prefixLength, for: candidate.address),
            sameFamily(candidate.address, receiverAddress),
            candidate.address != receiverAddress,
            isUsableUnicast(candidate.address),
            sameSubnet(candidate.address, receiverAddress, prefixLength: candidate.prefixLength),
            isUsableHost(candidate.address, prefixLength: candidate.prefixLength),
            isUsableHost(receiverAddress, prefixLength: candidate.prefixLength) else {
        return false
      }
      return true
    }

    guard let selected = matchingCandidates.sorted(by: deterministicRouteOrder).first else {
      throw CastNetworkSelectionError.noUsableWiFiRoute
    }

    return CastNetworkSelection(
      localAddress: selected.address,
      receiverAddress: receiverAddress,
      interfaceName: selected.name,
      prefixLength: selected.prefixLength
    )
  }

  static func selectionStillValid(
    _ selection: CastNetworkSelection,
    candidates: [LocalInterfaceAddress],
    receiverAddress: String
  ) -> Bool {
    guard let current = try? select(candidates: candidates, receiverAddress: receiverAddress) else {
      return false
    }
    return current == selection
  }

  static func urlAuthorityHost(for address: MediaProxyIPAddress) -> String {
    let literal = ipLiteral(address)
    switch address {
    case .v4:
      return literal
    case .v6:
      return "[\(literal)]"
    }
  }

  private static func deterministicRouteOrder(
    _ lhs: LocalInterfaceAddress,
    _ rhs: LocalInterfaceAddress
  ) -> Bool {
    if lhs.prefixLength != rhs.prefixLength {
      return lhs.prefixLength > rhs.prefixLength
    }
    if addressFamilyRank(lhs.address) != addressFamilyRank(rhs.address) {
      return addressFamilyRank(lhs.address) < addressFamilyRank(rhs.address)
    }
    if lhs.name != rhs.name {
      return lhs.name < rhs.name
    }
    return addressBytes(lhs.address).lexicographicallyPrecedes(addressBytes(rhs.address))
  }

  private static func addressFamilyRank(_ address: MediaProxyIPAddress) -> Int {
    switch address {
    case .v4: return 0
    case .v6: return 1
    }
  }

  private static func sameFamily(
    _ lhs: MediaProxyIPAddress,
    _ rhs: MediaProxyIPAddress
  ) -> Bool {
    switch (lhs, rhs) {
    case (.v4, .v4), (.v6, .v6): return true
    default: return false
    }
  }

  private static func validPrefixLength(
    _ prefixLength: Int,
    for address: MediaProxyIPAddress
  ) -> Bool {
    switch address {
    case .v4: return (1...32).contains(prefixLength)
    case .v6: return (1...128).contains(prefixLength)
    }
  }

  private static func sameSubnet(
    _ lhs: MediaProxyIPAddress,
    _ rhs: MediaProxyIPAddress,
    prefixLength: Int
  ) -> Bool {
    guard sameFamily(lhs, rhs), validPrefixLength(prefixLength, for: lhs) else {
      return false
    }
    let left = addressBytes(lhs)
    let right = addressBytes(rhs)
    guard left.count == right.count else { return false }

    let fullByteCount = prefixLength / 8
    guard left.prefix(fullByteCount).elementsEqual(right.prefix(fullByteCount)) else {
      return false
    }

    let remainingBits = prefixLength % 8
    guard remainingBits > 0 else { return true }
    let mask = UInt8.max << (8 - remainingBits)
    return left[fullByteCount] & mask == right[fullByteCount] & mask
  }

  private static func isUsableUnicast(_ address: MediaProxyIPAddress) -> Bool {
    switch address {
    case let .v4(bytes):
      guard bytes.count == 4 else { return false }
      let isThisNetwork = bytes[0] == 0
      let isLoopback = bytes[0] == 127
      let isLinkLocal = bytes[0] == 169 && bytes[1] == 254
      let isMulticastOrReserved = bytes[0] >= 224
      return !isThisNetwork && !isLoopback && !isLinkLocal && !isMulticastOrReserved

    case let .v6(bytes):
      guard bytes.count == 16 else { return false }
      let isUnspecified = bytes.allSatisfy { $0 == 0 }
      let isLoopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
      let isLinkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
      let isMulticast = bytes[0] == 0xff
      return !isUnspecified
        && !isLoopback
        && !isLinkLocal
        && !isMulticast
        && !isIPv4MappedOrCompatible(bytes)
    }
  }

  private static func isIPv4MappedOrCompatible(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 16 else { return false }
    let isCompatible = bytes.prefix(12).allSatisfy { $0 == 0 }
    let isMapped = bytes.prefix(10).allSatisfy { $0 == 0 }
      && bytes[10] == 0xff
      && bytes[11] == 0xff
    return isCompatible || isMapped
  }

  private static func isUsableHost(
    _ address: MediaProxyIPAddress,
    prefixLength: Int
  ) -> Bool {
    guard isUsableUnicast(address), validPrefixLength(prefixLength, for: address) else {
      return false
    }
    guard case let .v4(bytes) = address else { return true }
    return isUsableIPv4Host(bytes, prefixLength: prefixLength)
  }

  private static func isUsableIPv4Host(
    _ bytes: [UInt8],
    prefixLength: Int
  ) -> Bool {
    guard bytes.count == 4, (1...32).contains(prefixLength) else { return false }
    guard prefixLength < 31 else { return true }

    var allHostBitsZero = true
    var allHostBitsOne = true
    for bitIndex in prefixLength..<32 {
      let byteIndex = bitIndex / 8
      let bitMask = UInt8(0x80 >> (bitIndex % 8))
      let bitIsSet = bytes[byteIndex] & bitMask != 0
      allHostBitsZero = allHostBitsZero && !bitIsSet
      allHostBitsOne = allHostBitsOne && bitIsSet
    }
    return !allHostBitsZero && !allHostBitsOne
  }

  private static func addressBytes(_ address: MediaProxyIPAddress) -> [UInt8] {
    switch address {
    case let .v4(bytes), let .v6(bytes): return bytes
    }
  }

  private static func ipLiteral(_ address: MediaProxyIPAddress) -> String {
    switch address {
    case let .v4(bytes):
      return bytes.map(String.init).joined(separator: ".")
    case let .v6(bytes):
      guard bytes.count == 16 else { return "" }
      return stride(from: 0, to: bytes.count, by: 2).map { index in
        String(format: "%02x%02x", bytes[index], bytes[index + 1])
      }.joined(separator: ":")
    }
  }
}

struct CastNetworkRouteCollector: Sendable {
  typealias AddressEnumerator = @Sendable () -> [LocalInterfaceAddress]

  private let enumerateAddresses: AddressEnumerator

  init(enumerateAddresses: @escaping AddressEnumerator = CastNetworkRouteCollector.enumerateSystemInterfaces) {
    self.enumerateAddresses = enumerateAddresses
  }

  func snapshot(for path: NWPath) -> CastRouteSnapshot {
    let pathSatisfied = path.status == .satisfied && path.usesInterfaceType(.wifi)
    let activeInterfaces = path.availableInterfaces.map { interface in
      CastRouteInterface(
        name: interface.name,
        type: Self.localInterfaceType(for: interface.type)
      )
    }
    return snapshot(pathSatisfied: pathSatisfied, activeInterfaces: activeInterfaces)
  }

  func snapshot(
    pathSatisfied: Bool,
    activeInterfaces: [CastRouteInterface]
  ) -> CastRouteSnapshot {
    guard pathSatisfied else { return CastRouteSnapshot(candidates: []) }
    let activeWiFiNames = Set(
      activeInterfaces.lazy
        .filter { $0.type == .wifi }
        .map(\.name)
    )
    guard !activeWiFiNames.isEmpty else { return CastRouteSnapshot(candidates: []) }

    let candidates = enumerateAddresses().compactMap { candidate -> LocalInterfaceAddress? in
      guard activeWiFiNames.contains(candidate.name) else { return nil }
      return LocalInterfaceAddress(
        name: candidate.name,
        address: candidate.address,
        prefixLength: candidate.prefixLength,
        type: .wifi,
        isUp: candidate.isUp,
        isRunning: candidate.isRunning
      )
    }
    return CastRouteSnapshot(candidates: candidates)
  }

  static func localInterfaceType(for type: NWInterface.InterfaceType) -> LocalInterfaceType {
    switch type {
    case .wifi: return .wifi
    case .cellular: return .cellular
    case .wiredEthernet: return .wired
    case .loopback, .other: return .other
    @unknown default: return .other
    }
  }

  static func enumerateSystemInterfaces() -> [LocalInterfaceAddress] {
    var firstInterface: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&firstInterface) == 0,
          let firstInterface = firstInterface else { return [] }
    defer { freeifaddrs(firstInterface) }

    var results: [LocalInterfaceAddress] = []
    var currentInterface: UnsafeMutablePointer<ifaddrs>? = firstInterface
    while let interface = currentInterface {
      defer { currentInterface = interface.pointee.ifa_next }
      let record = interface.pointee
      guard let namePointer = record.ifa_name,
            let addressPointer = record.ifa_addr,
            let netmaskPointer = record.ifa_netmask else {
        continue
      }

      let family = Int32(addressPointer.pointee.sa_family)
      guard family == AF_INET || family == AF_INET6,
            let literal = numericLiteral(for: UnsafePointer(addressPointer), family: family),
            !literal.contains("%"),
            let address = MediaProxyIPAddress(literal),
            let prefixLength = prefixLength(
              from: UnsafePointer(netmaskPointer),
              family: family
            ) else {
        continue
      }

      let flags = record.ifa_flags
      results.append(
        LocalInterfaceAddress(
          name: String(cString: namePointer),
          address: address,
          prefixLength: prefixLength,
          type: .other,
          isUp: flags & UInt32(IFF_UP) != 0,
          isRunning: flags & UInt32(IFF_RUNNING) != 0
        )
      )
    }
    return results
  }

  private static func numericLiteral(
    for address: UnsafePointer<sockaddr>,
    family: Int32
  ) -> String? {
    let addressLength: socklen_t
    switch family {
    case AF_INET:
      addressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
    case AF_INET6:
      addressLength = socklen_t(MemoryLayout<sockaddr_in6>.size)
    default:
      return nil
    }

    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    let result = host.withUnsafeMutableBufferPointer { buffer in
      getnameinfo(
        address,
        addressLength,
        buffer.baseAddress,
        socklen_t(buffer.count),
        nil,
        0,
        NI_NUMERICHOST
      )
    }
    guard result == 0 else { return nil }
    return String(cString: host)
  }

  private static func prefixLength(
    from netmask: UnsafePointer<sockaddr>,
    family: Int32
  ) -> Int? {
    let bytes: [UInt8]
    switch family {
    case AF_INET:
      var mask = UnsafeRawPointer(netmask)
        .assumingMemoryBound(to: sockaddr_in.self)
        .pointee
        .sin_addr
      bytes = withUnsafeBytes(of: &mask) { Array($0) }
    case AF_INET6:
      var mask = UnsafeRawPointer(netmask)
        .assumingMemoryBound(to: sockaddr_in6.self)
        .pointee
        .sin6_addr
      bytes = withUnsafeBytes(of: &mask) { Array($0) }
    default:
      return nil
    }

    var prefixLength = 0
    var encounteredZero = false
    for byte in bytes {
      for bitOffset in 0..<8 {
        let bitIsSet = byte & UInt8(0x80 >> bitOffset) != 0
        if bitIsSet {
          guard !encounteredZero else { return nil }
          prefixLength += 1
        } else {
          encounteredZero = true
        }
      }
    }
    guard prefixLength > 0 else { return nil }
    return prefixLength
  }
}

final class CastNetworkSnapshotDelivery: @unchecked Sendable {
  typealias SnapshotHandler = @Sendable (CastRouteSnapshot) -> Void

  private let queue: DispatchQueue
  private let queueKey = DispatchSpecificKey<UInt8>()
  private var generation: UInt64 = 0
  private var started = false
  private var cancelled = false
  private var handler: SnapshotHandler?

  init(queue: DispatchQueue) {
    self.queue = queue
    queue.setSpecific(key: queueKey, value: 1)
  }

  @discardableResult
  func start(_ handler: @escaping SnapshotHandler) -> Bool {
    synchronized {
      guard !started, !cancelled else { return false }
      generation &+= 1
      started = true
      self.handler = handler
      return true
    }
  }

  func deliver(_ makeSnapshot: @escaping @Sendable () -> CastRouteSnapshot) {
    let operation = { [weak self] in
      guard let self = self, self.started, !self.cancelled else { return }
      let admittedGeneration = self.generation
      let snapshot = makeSnapshot()
      guard self.started,
            !self.cancelled,
            self.generation == admittedGeneration,
            let handler = self.handler else {
        return
      }
      handler(snapshot)
    }

    if isOnQueue {
      operation()
    } else {
      queue.async(execute: operation)
    }
  }

  @discardableResult
  func cancel() -> Bool {
    synchronized {
      guard !cancelled else { return false }
      cancelled = true
      started = false
      generation &+= 1
      handler = nil
      return true
    }
  }

  func synchronized<T>(_ operation: () -> T) -> T {
    // External callers wait behind an admitted callback. A callback cancelling
    // itself invalidates inline, which avoids a self-sync deadlock and prevents
    // every later delivery even though the current callback must still return.
    if isOnQueue {
      return operation()
    }
    return queue.sync(execute: operation)
  }

  private var isOnQueue: Bool {
    DispatchQueue.getSpecific(key: queueKey) == 1
  }
}

final class CastNetworkPathMonitor: @unchecked Sendable {
  typealias SnapshotHandler = @Sendable (CastRouteSnapshot) -> Void

  private let monitor: NWPathMonitor
  private let collector: CastNetworkRouteCollector
  private let queue: DispatchQueue
  private let delivery: CastNetworkSnapshotDelivery

  init(
    collector: CastNetworkRouteCollector = CastNetworkRouteCollector(),
    queue: DispatchQueue = DispatchQueue(label: "com.movix.cast.network-path")
  ) {
    self.collector = collector
    self.queue = queue
    delivery = CastNetworkSnapshotDelivery(queue: queue)
    monitor = NWPathMonitor(requiredInterfaceType: .wifi)
  }

  @discardableResult
  func start(_ handler: @escaping SnapshotHandler) -> Bool {
    delivery.synchronized {
      guard delivery.start(handler) else { return false }
      monitor.pathUpdateHandler = { [weak self] path in
        guard let self = self else { return }
        self.delivery.deliver {
          self.collector.snapshot(for: path)
        }
      }
      monitor.start(queue: queue)
      return true
    }
  }

  func cancel() {
    delivery.synchronized {
      guard delivery.cancel() else { return }
      monitor.pathUpdateHandler = nil
      monitor.cancel()
    }
  }

  deinit {
    cancel()
  }
}
