import Foundation
import os

/// Journal réseau du proxy média — outil de diagnostic, jamais de télémétrie :
/// tout reste en mémoire, rien n'est écrit sur le disque ni envoyé nulle part,
/// et la capture est éteinte par défaut.
///
/// Sans lui, les hébergeurs qui classent leurs clients (LuluStream, Veev,
/// Fsvid…) sont indébogables sur mobile : la requête qui se fait refuser part
/// du natif, hors de portée d'un inspecteur réseau, et les en-têtes réellement
/// émis ne sont visibles nulle part. Ce sont eux qui comptent — c'est un seul
/// en-tête qui sépare un 200 d'un 403.
///
/// Parité avec MediaProxyJournal.kt : même format d'entrée, mêmes préfixes
/// (`~` requête locale du lecteur, `>` émis vers l'amont, `<` reçu), même
/// découpe des lignes de journal système, pour que les deux plateformes se
/// lisent de la même façon.
enum MediaProxyJournal {
  private static let maximumEntries = 300

  // Une ligne de la console unifiée est tronquée passé quelques milliers
  // d'octets : on découpe avant que le système le fasse à notre place, au
  // milieu d'un en-tête. Même valeur que `MAX_LOG_CHUNK` côté Android.
  private static let maximumLogChunk = 3_000

  // Le sous-système est l'identifiant du bundle, sans quoi
  // `log stream --predicate 'subsystem == "com.movix.app"'` ne rend rien.
  private static let logger = Logger(subsystem: "com.movix.app", category: "MovixNet")

  // Un verrou, pas une file série. `record` est appelé depuis les tâches
  // asynchrones de l'amont média, donc sur les fils du pool coopératif de Swift
  // Concurrency, et un `sync` sur une DispatchQueue y bloque un fil du pool :
  // quelques requêtes de segments en parallèle suffisaient à l'assécher, l'app
  // se figeait et le watchdog la tuait. Un verrou tenu quelques microsecondes
  // ne fait pas ce saut de fil.
  private static let lock = NSLock()

  // Les trois sont gardés par `lock`. `timestampFormatter` en particulier :
  // DateFormatter n'est pas sûr en concurrence, et c'est ce qui plantait
  // l'application — deux requêtes média simultanées le formataient en même
  // temps et corrompaient sa mémoire interne.
  private static var entries: [String] = []
  private static var enabledStorage = false
  private static let timestampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    return formatter
  }()

  static var isEnabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return enabledStorage
  }

  static func setEnabled(_ value: Bool) {
    lock.lock()
    defer { lock.unlock() }
    enabledStorage = value
    if !value { entries.removeAll() }
  }

  static func record(
    phase: String,
    method: String,
    url: String,
    requestHeaders: [String: String],
    statusCode: Int? = nil,
    responseHeaders: [String: String]? = nil,
    bodySnippet: String? = nil,
    error: String? = nil,
    // Ce que le lecteur a demandé à la boucle locale. À tracer séparément :
    // `sanitizeLocalOverrideHeaders` les applique APRÈS ceux du pont, donc ils
    // l'emportent pour les en-têtes qu'il laisse passer.
    localRequestHeaders: [String: String]? = nil
  ) {
    guard isEnabled else { return }

    // Horodatage capturé ici, mis en forme sous le verrou : l'entrée porte
    // l'instant de la requête, pas celui où le verrou a été obtenu.
    let capturedAt = Date()

    var body = "\(phase) "
    if let statusCode = statusCode {
      body += "\(statusCode) "
    } else if error != nil {
      body += "ERR "
    } else {
      body += "… "
    }
    body += "\(method) \(url)\n"
    // Ordre stable : deux journaux du même incident doivent se comparer ligne
    // à ligne, ce qu'un ordre de dictionnaire interdirait.
    for (name, value) in (localRequestHeaders ?? [:]).sorted(by: { $0.key < $1.key }) {
      body += "  ~ \(name): \(value)\n"
    }
    for (name, value) in requestHeaders.sorted(by: { $0.key < $1.key }) {
      body += "  > \(name): \(value)\n"
    }
    for (name, value) in (responseHeaders ?? [:]).sorted(by: { $0.key < $1.key }) {
      body += "  < \(name): \(value)\n"
    }
    if let bodySnippet = bodySnippet, !bodySnippet.isEmpty {
      body += "  corps: \(bodySnippet.trimmingCharacters(in: .whitespacesAndNewlines))\n"
    }
    if let error = error, !error.isEmpty {
      body += "  erreur: \(error)\n"
    }

    lock.lock()
    // Relecture sous le verrou : la capture a pu être coupée pendant la mise en
    // forme, et une entrée qui arrive après `setEnabled(false)` ressusciterait
    // un tampon que l'utilisateur croit vidé.
    guard enabledStorage else {
      lock.unlock()
      return
    }
    let entry = "[\(timestampFormatter.string(from: capturedAt))] " + body
    entries.append(entry)
    if entries.count > maximumEntries {
      entries.removeFirst(entries.count - maximumEntries)
    }
    lock.unlock()

    // `privacy: .public` est délibéré : un journal de diagnostic caviardé en
    // « <private> » ne diagnostique rien. Il ne part qu'en mémoire et sur
    // demande explicite de l'utilisateur.
    var offset = entry.startIndex
    while offset < entry.endIndex {
      let end = entry.index(offset, offsetBy: maximumLogChunk, limitedBy: entry.endIndex)
        ?? entry.endIndex
      logger.info("\(String(entry[offset..<end]), privacy: .public)")
      offset = end
    }
  }

  static func snapshot() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return entries
  }

  static func clear() {
    lock.lock()
    defer { lock.unlock() }
    entries.removeAll()
  }
}
