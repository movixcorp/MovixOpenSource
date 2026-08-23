import Foundation
import GoogleCast

@objc final class CastBootstrap: NSObject {
  private static var isConfigured = false

  @objc static func configure() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async {
        CastBootstrap.configure()
      }
      return
    }

    guard !isConfigured else {
      return
    }
    isConfigured = true

    let criteria = GCKDiscoveryCriteria(applicationID: kGCKDefaultMediaReceiverApplicationID)
    let options = GCKCastOptions(discoveryCriteria: criteria)
    options.stopReceiverApplicationWhenEndingSession = true
    options.physicalVolumeButtonsWillControlDeviceVolume = false
    GCKCastContext.setSharedInstanceWith(options)
    GCKCastContext.sharedInstance().useDefaultExpandedMediaControls = true
  }
}
