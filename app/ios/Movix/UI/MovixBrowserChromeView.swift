import UIKit

@objc(MovixBrowserChromeView)
final class MovixBrowserChromeView: UIView {
  @objc dynamic var canGoBack = false { didSet { updateButtons() } }
  @objc dynamic var canGoForward = false { didSet { updateButtons() } }
  @objc dynamic var loading = false { didSet { updateButtons() } }
  @objc dynamic var currentURL = "" { didSet { updateDomain() } }
  @objc dynamic var dnsEnabled = false { didSet { updateDNSState() } }
  @objc dynamic var showURLBar = true { didSet { updateVisibility() } }
  @objc dynamic var showNavBar = true { didSet { updateVisibility() } }

  @objc dynamic var onGoBack: RCTBubblingEventBlock?
  @objc dynamic var onGoForward: RCTBubblingEventBlock?
  @objc dynamic var onReload: RCTBubblingEventBlock?
  @objc dynamic var onHome: RCTBubblingEventBlock?
  @objc dynamic var onSettings: RCTBubblingEventBlock?

  private let glassView = MovixGlassEffectView(frame: .zero)
  private let contentStack = UIStackView()
  private let addressCapsule = UIView()
  private let addressStack = UIStackView()
  private let lockView = UIImageView()
  private let loadingIndicator = UIActivityIndicatorView(style: .medium)
  private let domainLabel = UILabel()
  private let navigationStack = UIStackView()
  private lazy var regularAddressWidthConstraint = addressCapsule.widthAnchor.constraint(
    greaterThanOrEqualToConstant: 220
  )

  private lazy var backButton = makeButton(
    symbol: "chevron.backward",
    accessibilityLabel: "Page précédente",
    action: #selector(goBack)
  )
  private lazy var forwardButton = makeButton(
    symbol: "chevron.forward",
    accessibilityLabel: "Page suivante",
    action: #selector(goForward)
  )
  private lazy var reloadButton = makeButton(
    symbol: "arrow.clockwise",
    accessibilityLabel: "Recharger",
    action: #selector(reload)
  )
  private lazy var homeButton = makeButton(
    symbol: "house",
    accessibilityLabel: "Accueil",
    action: #selector(goHome)
  )
  private lazy var settingsButton = makeButton(
    symbol: "gearshape",
    accessibilityLabel: "Réglages",
    action: #selector(openSettings)
  )

  override init(frame: CGRect) {
    super.init(frame: frame)
    configureView()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configureView()
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    updateAdaptiveAxis()
    updateButtons()
  }

  private func configureView() {
    directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12)

    glassView.interactive = true
    glassView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glassView)

    contentStack.spacing = 8
    contentStack.alignment = .fill
    contentStack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(contentStack)

    let compactFillWidth = contentStack.widthAnchor.constraint(equalTo: layoutMarginsGuide.widthAnchor)
    compactFillWidth.priority = .defaultHigh

    NSLayoutConstraint.activate([
      glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
      glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
      glassView.topAnchor.constraint(equalTo: topAnchor),
      glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
      contentStack.topAnchor.constraint(equalTo: layoutMarginsGuide.topAnchor),
      contentStack.bottomAnchor.constraint(equalTo: layoutMarginsGuide.bottomAnchor),
      contentStack.centerXAnchor.constraint(equalTo: centerXAnchor),
      contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: layoutMarginsGuide.leadingAnchor),
      contentStack.trailingAnchor.constraint(lessThanOrEqualTo: layoutMarginsGuide.trailingAnchor),
      contentStack.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
      compactFillWidth,
    ])

    configureAddressCapsule()
    configureNavigationStack()
    contentStack.addArrangedSubview(addressCapsule)
    contentStack.addArrangedSubview(navigationStack)

    updateDomain()
    updateDNSState()
    updateButtons()
    updateVisibility()
  }

  private func configureAddressCapsule() {
    addressCapsule.backgroundColor = .secondarySystemFill
    addressCapsule.layer.cornerRadius = 12
    addressCapsule.isAccessibilityElement = true
    addressCapsule.accessibilityLabel = "Adresse"
    addressCapsule.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    addressCapsule.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    addressStack.axis = .horizontal
    addressStack.alignment = .center
    addressStack.spacing = 8
    addressStack.translatesAutoresizingMaskIntoConstraints = false
    addressCapsule.addSubview(addressStack)
    NSLayoutConstraint.activate([
      addressStack.leadingAnchor.constraint(equalTo: addressCapsule.leadingAnchor, constant: 12),
      addressStack.trailingAnchor.constraint(equalTo: addressCapsule.trailingAnchor, constant: -12),
      addressStack.topAnchor.constraint(equalTo: addressCapsule.topAnchor),
      addressStack.bottomAnchor.constraint(equalTo: addressCapsule.bottomAnchor),
    ])

    lockView.image = UIImage(systemName: "lock.fill")
    lockView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
    lockView.contentMode = .scaleAspectFit
    lockView.isAccessibilityElement = false
    lockView.setContentHuggingPriority(.required, for: .horizontal)

    loadingIndicator.hidesWhenStopped = true
    loadingIndicator.color = .secondaryLabel
    loadingIndicator.isAccessibilityElement = false
    loadingIndicator.setContentHuggingPriority(.required, for: .horizontal)

    domainLabel.font = .preferredFont(forTextStyle: .subheadline)
    domainLabel.adjustsFontForContentSizeCategory = true
    domainLabel.textColor = .secondaryLabel
    domainLabel.lineBreakMode = .byTruncatingMiddle
    domainLabel.numberOfLines = 1
    domainLabel.isAccessibilityElement = false

    addressStack.addArrangedSubview(lockView)
    addressStack.addArrangedSubview(loadingIndicator)
    addressStack.addArrangedSubview(domainLabel)
  }

  private func configureNavigationStack() {
    navigationStack.axis = .horizontal
    navigationStack.alignment = .center
    navigationStack.distribution = .equalSpacing
    navigationStack.spacing = 6
    for button in [backButton, forwardButton, reloadButton, homeButton, settingsButton] {
      navigationStack.addArrangedSubview(button)
    }
  }

  private func makeButton(
    symbol: String,
    accessibilityLabel: String,
    action: Selector
  ) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.image = UIImage(systemName: symbol)
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
      pointSize: 17,
      weight: .semibold
    )
    configuration.baseForegroundColor = .label
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)

    let button = UIButton(configuration: configuration)
    button.accessibilityLabel = accessibilityLabel
    button.addTarget(self, action: action, for: .touchUpInside)
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    button.configurationUpdateHandler = { updatedButton in
      var updatedConfiguration = updatedButton.configuration
      updatedConfiguration?.baseForegroundColor = updatedButton.isEnabled ? UIColor.label : UIColor.secondaryLabel
      updatedButton.configuration = updatedConfiguration
    }
    return button
  }

  private func updateAdaptiveAxis() {
    let useHorizontalLayout = traitCollection.horizontalSizeClass == .regular
      && showURLBar
      && showNavBar
    contentStack.axis = useHorizontalLayout ? .horizontal : .vertical
    regularAddressWidthConstraint.isActive = useHorizontalLayout
  }

  private func updateVisibility() {
    addressCapsule.isHidden = !showURLBar
    navigationStack.isHidden = !showNavBar
    isHidden = !showURLBar && !showNavBar
    updateAdaptiveAxis()
  }

  private func updateButtons() {
    backButton.isEnabled = canGoBack
    forwardButton.isEnabled = canGoForward
    let reloadSymbol = loading ? "xmark" : "arrow.clockwise"
    var configuration = reloadButton.configuration
    configuration?.image = UIImage(systemName: reloadSymbol)
    reloadButton.configuration = configuration
    reloadButton.accessibilityLabel = loading ? "Arrêter le chargement" : "Recharger"

    if loading {
      loadingIndicator.startAnimating()
    } else {
      loadingIndicator.stopAnimating()
    }
  }

  private func updateDomain() {
    let value: String
    if currentURL.utf8.count <= 4_096,
      let components = URLComponents(string: currentURL),
      let host = components.host,
      !host.isEmpty
    {
      value = host.lowercased()
    } else {
      value = "Adresse indisponible"
    }
    domainLabel.text = value
    updateAddressAccessibilityValue()
  }

  private func updateDNSState() {
    lockView.tintColor = dnsEnabled ? .systemGreen : .secondaryLabel
    updateAddressAccessibilityValue()
  }

  private func updateAddressAccessibilityValue() {
    let domain = domainLabel.text ?? "Adresse indisponible"
    addressCapsule.accessibilityValue = dnsEnabled
      ? "\(domain), DNS sécurisé activé"
      : domain
  }

  @objc private func goBack() { onGoBack?([:]) }
  @objc private func goForward() { onGoForward?([:]) }
  @objc private func reload() { onReload?([:]) }
  @objc private func goHome() { onHome?([:]) }
  @objc private func openSettings() { onSettings?([:]) }
}
