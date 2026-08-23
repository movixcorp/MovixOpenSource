import UIKit

enum MovixGlassMaterialChoice: Equatable {
  case liquidGlass
  case blur(UIBlurEffect.Style)
  case opaque
}

enum MovixGlassMaterialResolver {
  static func resolve(
    systemMajorVersion: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
    reduceTransparency: Bool = UIAccessibility.isReduceTransparencyEnabled,
    increaseContrast: Bool = UIAccessibility.isDarkerSystemColorsEnabled
  ) -> MovixGlassMaterialChoice {
    if reduceTransparency { return .opaque }
    if systemMajorVersion >= 26 { return .liquidGlass }
    return .blur(increaseContrast ? .systemMaterial : .systemThinMaterial)
  }
}

@objc(MovixGlassEffectView)
final class MovixGlassEffectView: UIView {
  private let effectView = UIVisualEffectView(effect: nil)

  @objc dynamic var interactive = false {
    didSet { rebuildEffect() }
  }

  @objc dynamic var prominent = false {
    didSet { rebuildEffect() }
  }

  @objc dynamic var cornerRadius: NSNumber? {
    didSet {
      guard let cornerRadius else {
        layer.cornerRadius = 0
        return
      }
      let value = CGFloat(truncating: cornerRadius)
      guard value.isFinite, (0...64).contains(value) else { return }
      layer.cornerRadius = value
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    configureView()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configureView()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    rebuildEffect()
  }

  private func configureView() {
    clipsToBounds = true
    effectView.isUserInteractionEnabled = false
    effectView.translatesAutoresizingMaskIntoConstraints = false
    insertSubview(effectView, at: 0)
    NSLayoutConstraint.activate([
      effectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: trailingAnchor),
      effectView.topAnchor.constraint(equalTo: topAnchor),
      effectView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(accessibilitySettingsDidChange),
      name: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(accessibilitySettingsDidChange),
      name: UIAccessibility.darkerSystemColorsStatusDidChangeNotification,
      object: nil
    )
    rebuildEffect()
  }

  @objc private func accessibilitySettingsDidChange() {
    rebuildEffect()
  }

  private func rebuildEffect() {
    let choice = MovixGlassMaterialResolver.resolve()
    switch choice {
    case .opaque:
      effectView.effect = nil
      backgroundColor = .secondarySystemBackground
    case .liquidGlass, .blur:
      backgroundColor = .clear
      effectView.effect = makeEffect(for: choice)
    }
  }

  private func makeEffect(for choice: MovixGlassMaterialChoice) -> UIVisualEffect? {
    switch choice {
    case .liquidGlass:
      if #available(iOS 26.0, *) {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = interactive
        effect.tintColor = prominent ? UIColor.tintColor.withAlphaComponent(0.35) : nil
        return effect
      }
      return UIBlurEffect(style: .systemThinMaterial)
    case let .blur(style):
      return UIBlurEffect(style: style)
    case .opaque:
      return nil
    }
  }
}
