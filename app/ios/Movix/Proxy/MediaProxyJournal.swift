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
/// (`~` requête locale du lecteur, `>` émis vers l'amont, `<` reçu), pour que
/// les deux plateformes se lisent de la même façon.
enum MediaProxyJournal {
  private static let maximumEntries = 300
  private static let logger = Logger(subsystem: "tax.movix.app", category: "MovixNet")
  private static let queue = DispatchQueue(label: "tax.movix.mediaproxy.journal")

  private static var entries: [String] = []
  private static var enabledStorage = false

  private static let timestampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    return formatter
  }()

  static var isEnabled: Bool {
    queue.sync { enabledStorage }
  }

  static func setEnabled(_ value: Bool) {
    queue.sync {
      enabledStorage = value
      if !value { entries.removeAll() }
    }
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

    var entry = "[\(timestampFormatter.string(from: Date()))] \(phase) "
    if let statusCode = statusCode {
      entry += "\(statusCode) "
    } else if error != nil {
      entry += "ERR "
    } else {
      entry += "… "
    }
    entry += "\(method) \(url)\n"
    // Ordre stable : deux journaux du même incident doivent se comparer ligne
    // à ligne, ce qu'un ordre de dictionnaire interdirait.
    for (name, value) in (localRequestHeaders ?? [:]).sorted(by: { $0.key < $1.key }) {
      entry += "  ~ \(name): \(value)\n"
    }
    for (name, value) in requestHeaders.sorted(by: { $0.key < $1.key }) {
      entry += "  > \(name): \(value)\n"
    }
    for (name, value) in (responseHeaders ?? [:]).sorted(by: { $0.key < $1.key }) {
      entry += "  < \(name): \(value)\n"
    }
    if let bodySnippet = bodySnippet, !bodySnippet.isEmpty {
      entry += "  corps: \(bodySnippet.trimmingCharacters(in: .whitespacesAndNewlines))\n"
    }
    if let error = error, !error.isEmpty {
      entry += "  erreur: \(error)\n"
    }

    queue.sync {
      entries.append(entry)
      if entries.count > maximumEntries {
        entries.removeFirst(entries.count - maximumEntries)
      }
    }
    // `privacy: .public` est délibéré : un journal de diagnostic caviardé en
    // « <private> » ne diagnostique rien. Il ne part qu'en mémoire et sur
    // demande explicite de l'utilisateur.
    logger.info("\(entry, privacy: .public)")
  }

  static func snapshot() -> [String] {
    queue.sync { entries }
  }

  static func clear() {
    queue.sync { entries.removeAll() }
  }
}
