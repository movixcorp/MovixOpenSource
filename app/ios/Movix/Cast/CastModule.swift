import Foundation
import Network
import React
import GoogleCast
import UIKit

/// React Native facade for the iOS Cast sender.
///
/// The Cast SDK is main-thread-only.  The module therefore uses the RN main
/// queue, validates all bridge values before handing them to the relay, and
/// keeps the relay alive until the receiver load request has been issued.
@objc(CastModule)
final class CastModule: RCTEventEmitter,
  GCKSessionManagerListener,
  GCKRemoteMediaClientListener {

  private static let statusEventName = "CAST_MEDIA_STATUS"
  private static let genericErrorMessage = "Cast indisponible."
  private static let maximumTitleCharacters = 512
  private static let maximumPosterCharacters = 16_384
  private static let maximumStartTime = 366.0 * 24.0 * 60.0 * 60.0
  private static let relayDisclosureKey = "com.movix.cast.relayDisclosureSuppressed"
  // Le SDK iOS n'expose aucun callback de fermeture pour `presentCastDialog()`
  // (Android a `setOnDismissListener`).  Sans borne, fermer la boite sans
  // choisir d'appareil laissait la promesse `loadProxiedMedia` en suspens pour
  // toujours : le single-flight cote JS restait occupe et le Cast etait mort
  // jusqu'au rechargement de la page.  La sentinelle se re-arme tant que le SDK
  // annonce une connexion en cours, donc seule une vraie inaction expire.
  private static let pickerWatchdogTimeout: TimeInterval = 90

  private struct PendingLoad {
    let source: PreparedCastSource
    let metadata: NSDictionary
    let startTime: TimeInterval
    let resolve: RCTPromiseResolveBlock
    let reject: RCTPromiseRejectBlock
  }

  private var context: GCKCastContext?
  private var sessionManager: GCKSessionManager?
  private weak var activeSession: GCKCastSession?
  private weak var mediaClient: GCKRemoteMediaClient?
  private var pendingLoad: PendingLoad?
  private var activeRelay: PreparedCastRelay?
  private var pickerWatchdog: DispatchWorkItem?
  private var invalidated = false

  override init() {
    super.init()
    CastBootstrap.configure()
    attachToCastContext()
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! { [Self.statusEventName] }

  override func invalidate() {
    guard !invalidated else { return }
    invalidated = true
    sessionManager?.remove(self)
    if let mediaClient { mediaClient.remove(self) }
    let relay = activeRelay
    activeRelay = nil
    activeSession = nil
    mediaClient = nil
    rejectPending(CastRelayError.sessionUnavailable)
    Task { await relay?.stop() }
    super.invalidate()
  }

  @objc
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self, !self.invalidated else { throw CastRelayError.sessionUnavailable }
      self.attachToCastContext()
      return self.context != nil
    }
  }

  @objc
  func getCapabilities(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self, !self.invalidated else { throw CastRelayError.sessionUnavailable }
      self.attachToCastContext()
      return [
        "configured": self.context != nil,
        "receiverProtocolVersion": self.context == nil ? 0 : 1,
        "castLanProxyVersion": self.context == nil ? 0 : 1,
      ]
    }
  }

  @objc
  func loadProxiedMedia(
    _ source: NSDictionary,
    metadata: NSDictionary,
    startTimeSec: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.loadProxiedMedia(
          source,
          metadata: metadata,
          startTimeSec: startTimeSec,
          resolve: resolve,
          reject: reject
        )
      }
      return
    }

    do {
      guard !invalidated else { throw CastRelayError.sessionUnavailable }
      attachToCastContext()
      guard context != nil else { throw CastRelayError.listenerUnavailable }
      let prepared = try parseSource(source)
      let title = try parseTitle(metadata["title"])
      let _ = title // Metadata is validated again while building the Cast item.
      let start = startTimeSec.doubleValue
      guard start.isFinite, start >= 0, start <= Self.maximumStartTime else {
        throw CastRelayError.invalidRequest
      }

      if let previous = pendingLoad {
        previous.reject(CastRelayError.sessionUnavailable.rawValue, Self.genericErrorMessage, nil)
      }
      pendingLoad = PendingLoad(
        source: prepared,
        metadata: metadata,
        startTime: start,
        resolve: resolve,
        reject: reject
      )

      if let session = sessionManager?.currentCastSession,
         session.connectionState == .connected,
         session.remoteMediaClient != nil {
        consumePendingLoad(on: session)
      } else {
        context?.presentCastDialog()
        armPickerWatchdog()
        emitStatus()
      }
    } catch let error as CastRelayError {
      reject(error.rawValue, Self.genericErrorMessage, nil)
    } catch {
      reject(CastRelayError.invalidSource.rawValue, Self.genericErrorMessage, nil)
    }
  }

  @objc
  func getStatus(
    _ refresh: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self, !self.invalidated else { throw CastRelayError.sessionUnavailable }
      if refresh { _ = self.mediaClient?.requestStatus() }
      return self.statusPayload()
    }
  }

  @objc
  func play(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) { issueRemoteRequest(resolve: resolve, reject: reject) { $0.play() } }

  @objc
  func pause(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) { issueRemoteRequest(resolve: resolve, reject: reject) { $0.pause() } }

  @objc
  func seekTo(
    _ seconds: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self, let client = self.mediaClient else {
        throw CastRelayError.sessionUnavailable
      }
      let position = seconds.doubleValue
      guard position.isFinite, position >= 0, position <= Self.maximumStartTime else {
        throw CastRelayError.invalidRequest
      }
      let options = GCKMediaSeekOptions()
      options.interval = position
      options.relative = false
      _ = client.seek(with: options)
      return NSNull()
    }
  }

  @objc
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self else { throw CastRelayError.sessionUnavailable }
      if let client = self.mediaClient { _ = client.stop() }
      let relay = self.activeRelay
      self.activeRelay = nil
      Task { await relay?.stop() }
      self.emitStatus()
      return NSNull()
    }
  }

  @objc
  func getRelayDisclosurePreference(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) {
      UserDefaults.standard.bool(forKey: Self.relayDisclosureKey)
    }
  }

  @objc
  func setRelayDisclosureSuppressed(
    _ suppressed: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) {
      UserDefaults.standard.set(suppressed, forKey: Self.relayDisclosureKey)
      return NSNull()
    }
  }

  @objc
  func openBatterySettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    // iOS has no Android-style per-app battery page.  Do not pretend that the
    // generic application settings URL changes Cast background policy.
    runOnMain(resolve: resolve, reject: reject) { false }
  }

  @objc
  func requestRelayNotificationPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    // Relay notifications are optional on iOS; the Cast sender remains usable.
    runOnMain(resolve: resolve, reject: reject) { true }
  }

  @objc
  func presentCastDialog(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let self, let context = self.context else {
        throw CastRelayError.listenerUnavailable
      }
      context.presentCastDialog()
      return NSNull()
    }
  }

  // MARK: - GCKSessionManagerListener

  @objc
  func sessionManager(_: GCKSessionManager, didStart session: GCKSession) {
    guard let castSession = session as? GCKCastSession else { return }
    attach(to: castSession)
    consumePendingLoad(on: castSession)
  }

  @objc
  func sessionManager(_: GCKSessionManager, didResumeSession session: GCKSession) {
    guard let castSession = session as? GCKCastSession else { return }
    attach(to: castSession)
    consumePendingLoad(on: castSession)
  }

  @objc
  func sessionManager(_: GCKSessionManager, didEnd _: GCKSession, withError _: Error?) {
    finishSession(errorCode: CastRelayError.sessionUnavailable.rawValue)
  }

  @objc
  func sessionManager(_: GCKSessionManager, didFailToStartSessionWithError _: Error?) {
    rejectPending(CastRelayError.sessionUnavailable)
    emitStatus()
  }

  @objc
  func sessionManager(_: GCKSessionManager, didFailToResumeSession _: GCKSession, withError _: Error?) {
    finishSession(errorCode: CastRelayError.sessionUnavailable.rawValue)
  }

  @objc
  func sessionManager(_: GCKSessionManager, didSuspend _: GCKSession, with _: GCKConnectionSuspendReason) {
    emitStatus()
  }

  // MARK: - GCKRemoteMediaClientListener

  @objc
  func remoteMediaClient(_: GCKRemoteMediaClient, didUpdate mediaStatus: GCKMediaStatus?) {
    emitStatus(mediaStatus: mediaStatus)
  }

  // MARK: - Cast setup and load flow

  private func attachToCastContext() {
    guard Thread.isMainThread, !invalidated else { return }
    CastBootstrap.configure()
    guard GCKCastContext.isSharedInstanceInitialized() else { return }
    let castContext = GCKCastContext.sharedInstance()
    context = castContext
    let manager = castContext.sessionManager
    if sessionManager !== manager {
      sessionManager?.remove(self)
      sessionManager = manager
      manager.add(self)
    }
    if let session = manager.currentCastSession { attach(to: session) }
  }

  private func attach(to session: GCKCastSession) {
    activeSession = session
    if let oldClient = mediaClient, oldClient !== session.remoteMediaClient { oldClient.remove(self) }
    guard let client = session.remoteMediaClient else {
      mediaClient = nil
      emitStatus()
      return
    }
    mediaClient = client
    client.add(self)
    emitStatus()
  }

  private func consumePendingLoad(on session: GCKCastSession) {
    guard pendingLoad != nil, session.remoteMediaClient != nil else {
      emitStatus()
      return
    }
    cancelPickerWatchdog()
    let pending = pendingLoad
    pendingLoad = nil
    guard let pending else { return }
    // GCKNetworkAddress.ipAddress est optionnel dans le SDK Cast, contrairement
    // a ce que supposait ce code. Une adresse absente ou vide rend le recepteur
    // inutilisable : on ne tente pas de selection de route sur une cible
    // invalide, le guard ci-dessous s'en charge dans les deux cas.
    let receiverAddress = session.device.networkAddress.ipAddress ?? ""
    Task { @MainActor [weak self] in
      guard let self, !self.invalidated else {
        pending.reject(CastRelayError.sessionUnavailable.rawValue, Self.genericErrorMessage, nil)
        return
      }
      var relayForFailure: PreparedCastRelay?
      do {
        guard !receiverAddress.isEmpty else { throw CastRelayError.sessionUnavailable }
        let selection = try await self.selectRoute(for: receiverAddress)
        let preparer = CastMediaPreparer()
        let relay = try await preparer.prepare(source: pending.source, selection: selection)
        relayForFailure = relay
        guard self.activeSession === session, !self.invalidated else {
          throw CastRelayError.sessionUnavailable
        }
        let mediaInfo = try self.makeMediaInformation(relay: relay, metadata: pending.metadata)
        let requestBuilder = GCKMediaLoadRequestDataBuilder()
        requestBuilder.mediaInformation = mediaInfo
        requestBuilder.autoplay = true
        requestBuilder.startTime = pending.startTime
        let activeTrackIDs = relay.textTracks.enumerated()
          .filter { $0.element.active }
          .map { NSNumber(value: $0.offset + 1) }
        if !activeTrackIDs.isEmpty { requestBuilder.activeTrackIDs = activeTrackIDs }
        guard let client = session.remoteMediaClient else {
          throw CastRelayError.sessionUnavailable
        }
        _ = client.loadMedia(with: requestBuilder.build())
        let oldRelay = self.activeRelay
        self.activeRelay = relay
        self.activeSession = session
        self.mediaClient = client
        relayForFailure = nil
        if let oldRelay { await oldRelay.stop() }
        pending.resolve(NSNull())
        self.emitStatus()
      } catch let error as CastRelayError {
        if let relayForFailure { await relayForFailure.stop() }
        pending.reject(error.rawValue, Self.genericErrorMessage, nil)
      } catch {
        if let relayForFailure { await relayForFailure.stop() }
        pending.reject(CastRelayError.sessionUnavailable.rawValue, Self.genericErrorMessage, nil)
      }
    }
  }

  private func selectRoute(for receiverAddress: String) async throws -> CastNetworkSelection {
    let monitor = NWPathMonitor(requiredInterfaceType: .wifi)
    let queue = DispatchQueue(label: "com.movix.cast.route-probe")
    return try await withCheckedThrowingContinuation { continuation in
      let lock = NSLock()
      var finished = false
      let finish: (Result<CastNetworkSelection, Error>) -> Void = { result in
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        lock.unlock()
        monitor.cancel()
        continuation.resume(with: result)
      }
      monitor.pathUpdateHandler = { path in
        let snapshot = CastNetworkRouteCollector().snapshot(for: path)
        if let selection = try? CastNetworkSelector.select(
          candidates: snapshot.candidates,
          receiverAddress: receiverAddress
        ) {
          finish(.success(selection))
        }
      }
      monitor.start(queue: queue)
      queue.asyncAfter(deadline: .now() + 5) {
        finish(.failure(CastNetworkSelectionError.noUsableWiFiRoute))
      }
    }
  }

  private func makeMediaInformation(
    relay: PreparedCastRelay,
    metadata: NSDictionary
  ) throws -> GCKMediaInformation {
    let title = try parseTitle(metadata["title"])
    let castMetadata = GCKMediaMetadata()
    castMetadata.setString(title, forKey: kGCKMetadataKeyTitle)
    if let rawPoster = metadata["poster"] {
      guard let poster = rawPoster as? String,
            !poster.isEmpty,
            poster.count <= Self.maximumPosterCharacters,
            let posterURL = try? MediaProxyPolicy.validatePublicHTTPSURLSyntax(poster) else {
        throw CastRelayError.invalidRequest
      }
      castMetadata.addImage(GCKImage(url: posterURL, width: 480, height: 270))
    }

    let tracks: [GCKMediaTrack] = relay.textTracks.enumerated().compactMap { index, track in
      GCKMediaTrack(
        identifier: index + 1,
        contentIdentifier: track.contentURL.absoluteString,
        contentType: track.contentType,
        type: .text,
        textSubtype: .subtitles,
        name: track.name,
        languageCode: track.language,
        customData: nil
      )
    }

    let builder = GCKMediaInformationBuilder(contentURL: relay.contentURL)
    builder.contentType = relay.contentType
    builder.streamType = .buffered
    builder.metadata = castMetadata
    if !tracks.isEmpty { builder.mediaTracks = tracks }
    return builder.build()
  }

  private func parseSource(_ dictionary: NSDictionary) throws -> PreparedCastSource {
    guard let rawURL = dictionary["url"] as? String,
          rawURL.utf8.count <= MediaProxyPolicy.maximumURLLength,
          let url = URL(string: rawURL),
          let protocolNumber = dictionary["protocolVersion"] as? NSNumber,
          protocolNumber.intValue == 1 else {
      throw CastRelayError.invalidSource
    }
    let rawHeaders: NSDictionary
    if let suppliedHeaders = dictionary["headers"] {
      guard let dictionaryHeaders = suppliedHeaders as? NSDictionary else {
        throw CastRelayError.invalidSource
      }
      rawHeaders = dictionaryHeaders
    } else {
      rawHeaders = NSDictionary()
    }
    var headers: [String: String] = [:]
    for (key, value) in rawHeaders {
      guard let name = key as? String, let headerValue = value as? String else {
        throw CastRelayError.invalidSource
      }
      headers[name] = headerValue
    }

    var tracks: [CastSourceTrack] = []
    if let rawTracks = dictionary["tracks"] {
      guard let trackArray = rawTracks as? [NSDictionary], trackArray.count <= CastSourceValidation.maximumTrackCount else {
        throw CastRelayError.tooManyTracks
      }
      tracks = try trackArray.map { track in
        let language = track["language"] as? String
        let name = track["name"] as? String
        let active = (track["active"] as? NSNumber)?.boolValue ?? false
        if let inline = track["inlineVtt"] as? String {
          return try CastSourceTrack(inlineVTT: inline, language: language, name: name, active: active)
        }
        guard let trackURLString = track["url"] as? String,
              let trackURL = URL(string: trackURLString) else {
          throw CastRelayError.invalidTextTrack
        }
        let rawTrackHeaders: NSDictionary
        if let suppliedHeaders = track["headers"] {
          guard let dictionaryHeaders = suppliedHeaders as? NSDictionary else {
            throw CastRelayError.invalidTextTrack
          }
          rawTrackHeaders = dictionaryHeaders
        } else {
          rawTrackHeaders = NSDictionary()
        }
        let trackHeaders = try parseHeaders(rawTrackHeaders)
        let target = MediaProxyTarget(
          upstreamURL: try CastSourceValidation.validatedRemoteURL(trackURL),
          method: "GET",
          headers: trackHeaders
        )
        return try CastSourceTrack(
          remoteTarget: target,
          language: language,
          name: name,
          active: active
        )
      }
    }
    let contentType = dictionary["contentType"] as? String
    return try PreparedCastSource(
      url: url,
      headers: headers,
      contentType: contentType,
      protocolVersion: 1,
      tracks: tracks
    )
  }

  private func parseHeaders(_ dictionary: NSDictionary) throws -> [String: String] {
    var result: [String: String] = [:]
    for (key, value) in dictionary {
      guard let name = key as? String, let headerValue = value as? String else {
        throw CastRelayError.invalidSource
      }
      result[name] = headerValue
    }
    return try CastSourceValidation.sanitizedHeaders(result)
  }

  private func parseTitle(_ value: Any?) throws -> String {
    guard let title = value as? String,
          !title.isEmpty,
          title.count <= Self.maximumTitleCharacters,
          !title.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
      throw CastRelayError.invalidRequest
    }
    return title
  }

  private func issueRemoteRequest(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    operation: @escaping (GCKRemoteMediaClient) -> GCKRequest
  ) {
    runOnMain(resolve: resolve, reject: reject) { [weak self] in
      guard let client = self?.mediaClient else { throw CastRelayError.sessionUnavailable }
      _ = operation(client)
      return NSNull()
    }
  }

  private func runOnMain(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    operation: @escaping () throws -> Any
  ) {
    let execute = { [weak self] in
      do {
        guard self?.invalidated != true else { throw CastRelayError.sessionUnavailable }
        resolve(try operation())
      } catch let error as CastRelayError {
        reject(error.rawValue, Self.genericErrorMessage, nil)
      } catch {
        reject(CastRelayError.sessionUnavailable.rawValue, Self.genericErrorMessage, nil)
      }
    }
    if Thread.isMainThread { execute() } else { DispatchQueue.main.async(execute: execute) }
  }

  private func rejectPending(_ error: CastRelayError) {
    cancelPickerWatchdog()
    guard let pending = pendingLoad else { return }
    pendingLoad = nil
    pending.reject(error.rawValue, Self.genericErrorMessage, nil)
  }

  private func armPickerWatchdog() {
    cancelPickerWatchdog()
    let item = DispatchWorkItem { [weak self] in self?.handlePickerWatchdog() }
    pickerWatchdog = item
    DispatchQueue.main.asyncAfter(
      deadline: .now() + Self.pickerWatchdogTimeout,
      execute: item
    )
  }

  private func cancelPickerWatchdog() {
    pickerWatchdog?.cancel()
    pickerWatchdog = nil
  }

  private func handlePickerWatchdog() {
    pickerWatchdog = nil
    guard !invalidated, pendingLoad != nil else { return }
    // Une session qui s'etablit n'est pas un abandon : laisser le SDK finir.
    if let state = context?.castState, state == .connecting || state == .connected {
      armPickerWatchdog()
      return
    }
    let relay = activeRelay
    activeRelay = nil
    rejectPending(.pickerDismissed)
    Task { await relay?.stop() }
    emitStatus(errorCode: CastRelayError.pickerDismissed.rawValue)
  }

  private func finishSession(errorCode: String?) {
    let relay = activeRelay
    activeRelay = nil
    activeSession = nil
    mediaClient = nil
    rejectPending(CastRelayError.sessionUnavailable)
    Task { await relay?.stop() }
    emitStatus(errorCode: errorCode)
  }

  private func statusPayload(
    mediaStatus suppliedStatus: GCKMediaStatus? = nil,
    errorCode: String? = nil
  ) -> [String: Any] {
    let status = suppliedStatus ?? mediaClient?.mediaStatus
    let state = Self.normalizedState(status?.playerState)
    let position: TimeInterval
    if let status,
       status.streamPosition.isFinite,
       status.streamPosition >= 0 {
      position = status.streamPosition
    } else {
      position = 0
    }
    let normalizedDuration: Any
    if let duration = status?.mediaInformation?.streamDuration,
       duration.isFinite,
       duration > 0 {
      normalizedDuration = duration
    } else {
      normalizedDuration = NSNull()
    }
    var payload: [String: Any] = [
      "connected": activeSession != nil,
      "deviceName": activeSession?.device.friendlyName ?? NSNull(),
      "mediaSessionId": status?.mediaSessionID ?? NSNull(),
      "state": state,
      "positionSec": position,
      "durationSec": normalizedDuration,
      "canSeek": status != nil,
    ]
    if let idleReason = status?.idleReason {
      payload["idleReason"] = String(describing: idleReason)
    }
    if let errorCode { payload["errorCode"] = errorCode }
    return payload
  }

  private func emitStatus(
    mediaStatus: GCKMediaStatus? = nil,
    errorCode: String? = nil
  ) {
    guard !invalidated else { return }
    sendEvent(withName: "CAST_MEDIA_STATUS", body: statusPayload(
      mediaStatus: mediaStatus,
      errorCode: errorCode
    ))
  }

  private static func normalizedState(_ state: GCKMediaPlayerState?) -> String {
    guard let state else { return "idle" }
    let raw = String(describing: state).lowercased()
    if raw.contains("playing") { return "playing" }
    if raw.contains("paused") { return "paused" }
    if raw.contains("buffer") { return "buffering" }
    if raw.contains("loading") { return "loading" }
    if raw.contains("idle") { return "idle" }
    return "error"
  }
}
