import XCTest
@testable import Movix

final class MovixGlassEffectViewTests: XCTestCase {
  func testUsesFallbackMaterialBeforeIOS26() {
    let choice = MovixGlassMaterialResolver.resolve(
      systemMajorVersion: 25,
      reduceTransparency: false,
      increaseContrast: false
    )

    XCTAssertEqual(choice, .blur(.systemThinMaterial))
  }

  func testDisablesTransparencyForAccessibility() {
    let choice = MovixGlassMaterialResolver.resolve(
      systemMajorVersion: 26,
      reduceTransparency: true,
      increaseContrast: false
    )

    XCTAssertEqual(choice, .opaque)
  }

  func testUsesHigherContrastFallbackMaterial() {
    let choice = MovixGlassMaterialResolver.resolve(
      systemMajorVersion: 25,
      reduceTransparency: false,
      increaseContrast: true
    )

    XCTAssertEqual(choice, .blur(.systemMaterial))
  }

  func testUsesLiquidGlassOnIOS26WhenTransparencyIsAllowed() {
    let choice = MovixGlassMaterialResolver.resolve(
      systemMajorVersion: 26,
      reduceTransparency: false,
      increaseContrast: false
    )

    XCTAssertEqual(choice, .liquidGlass)
  }

  @MainActor
  func testCornerRadiusRejectsInvalidValuesAndCanReset() {
    let view = MovixGlassEffectView(frame: .zero)

    view.cornerRadius = 18
    XCTAssertEqual(view.layer.cornerRadius, 18)

    for invalid in [-1, 65, Double.nan, Double.infinity] {
      view.cornerRadius = NSNumber(value: invalid)
      XCTAssertEqual(view.layer.cornerRadius, 18)
    }

    view.cornerRadius = nil
    XCTAssertEqual(view.layer.cornerRadius, 0)
  }
}
