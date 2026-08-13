#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <AVFoundation/AVFoundation.h>

#if __has_include(<GoogleCast/GoogleCast.h>)
#import <GoogleCast/GoogleCast.h>
#define MOVIX_CAST_AVAILABLE 1
#endif

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"Movix";
  self.initialProps = @{};

  // Session audio "playback" : indispensable pour que la lecture (son) et le
  // Picture-in-Picture continuent quand l'app passe en arrière-plan ou que
  // l'écran se verrouille. Sans ça, WKWebView coupe la vidéo dès le background.
  AVAudioSession *audioSession = [AVAudioSession sharedInstance];
  [audioSession setCategory:AVAudioSessionCategoryPlayback
                       mode:AVAudioSessionModeMoviePlayback
                    options:0
                      error:nil];
  [audioSession setActive:YES error:nil];

#ifdef MOVIX_CAST_AVAILABLE
  // Initialise le contexte Google Cast. L'App ID DEFAULT_MEDIA_RECEIVER_APP_ID
  // pointe vers le récepteur générique (pas de compte Cast Console requis).
  GCKDiscoveryCriteria *criteria = [[GCKDiscoveryCriteria alloc]
      initWithApplicationID:kGCKDefaultMediaReceiverApplicationID];
  GCKCastOptions *castOptions = [[GCKCastOptions alloc] initWithDiscoveryCriteria:criteria];
  castOptions.physicalVolumeButtonsWillControlDeviceVolume = YES;
  [GCKCastContext setSharedInstanceWithOptions:castOptions];
#endif

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

// Note : le Picture-in-Picture automatique est géré côté Web via l'attribut
// video.autoPictureInPicture = true (voir media-session.ts). WebKit bascule
// alors la vidéo en PiP tout seul au passage en arrière-plan, par le même
// chemin que le bouton PiP du lecteur. On n'injecte donc PLUS de PiP manuel
// depuis applicationWillResignActive: (ça échouait faute de user-gesture et
// bloquait le tactile au retour dans l'app).

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
