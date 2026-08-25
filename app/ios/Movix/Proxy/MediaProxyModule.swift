import Foundation

@objc(MediaProxy)
final class MediaProxyModule: NSObject {
  private let server = MediaProxyServer.shared

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc
  func open(
    _ url: String,
    method: String,
    headers: [String: String],
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      do {
        let normalizedMethod = method.uppercased()
        guard normalizedMethod == "GET" || normalizedMethod == "HEAD",
              headers.count <= 32,
              headers.allSatisfy({ name, value in
                !name.isEmpty
                  && name.utf8.count <= 128
                  && value.utf8.count <= 8_192
                  && !name.contains("\r")
                  && !name.contains("\n")
                  && !value.contains("\r")
                  && !value.contains("\n")
              }) else {
          reject("MEDIA_PROXY_OPEN_FAILED", "Local media proxy unavailable", nil)
          return
        }

        let upstream = try MediaProxyPolicy.validatePublicHTTPSURLSyntax(url)
        let target = MediaProxyTarget(
          upstreamURL: upstream,
          method: normalizedMethod,
          headers: MediaProxyPolicy.sanitizeRequestHeaders(headers)
        )
        let localURL = try await server.open(target: target)
        resolve(localURL.absoluteString)
      } catch {
        reject("MEDIA_PROXY_OPEN_FAILED", "Local media proxy unavailable", nil)
      }
    }
  }

  @objc
  func resolveForCast(
    _ localURL: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let url = URL(string: localURL),
            let target = await server.resolveForCast(url) else {
        reject(
          "MEDIA_PROXY_CAST_RESOLVE_FAILED",
          "Local media source unavailable",
          nil
        )
        return
      }
      let payload: [String: Any] = [
        "url": target.upstreamURL.absoluteString,
        "headers": target.headers,
        "protocolVersion": 1,
      ]
      resolve(payload)
    }
  }

  // MARK: - Journal réseau (diagnostic)
  // La requête média part du natif : sans ces méthodes, ni l'utilisateur ni un
  // inspecteur réseau ne voient les en-têtes réellement émis, et un 403
  // d'hébergeur reste indébogable. Tout est en mémoire, éteint par défaut.
  // Parité avec MediaProxyModule.kt.

  @objc
  func setJournalEnabled(
    _ enabled: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    MediaProxyJournal.setEnabled(enabled)
    resolve(enabled)
  }

  @objc
  func getJournal(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(MediaProxyJournal.snapshot())
  }

  @objc
  func clearJournal(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    MediaProxyJournal.clear()
    resolve(true)
  }

  @objc
  func recordJournalEntry(
    _ phase: String,
    method: String,
    url: String,
    headers: [String: String],
    statusCode: NSNumber,
    error: String?,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let code = statusCode.intValue
    MediaProxyJournal.record(
      phase: phase,
      method: method,
      url: url,
      requestHeaders: MediaProxyPolicy.sanitizeRequestHeaders(headers),
      statusCode: code > 0 ? code : nil,
      error: error
    )
    resolve(true)
  }
}
