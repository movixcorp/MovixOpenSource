import XCTest
@testable import Movix

final class MovixTests: XCTestCase {
  func testCanonicalBundleIdentifier() {
    XCTAssertEqual(Bundle.main.bundleIdentifier, "com.movix.app")
  }
}
