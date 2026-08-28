#import "AppDelegate.h"

// Movix-Swift.h declare toutes les classes @objc du module, dont CastModule
// (RCTEventEmitter <GCKRemoteMediaClientListener, GCKSessionManagerListener>),
// le controleur PiP et MovixMediaSchemeHandler (WKURLSchemeHandler). Swift ne
// forward-declare que les types de son propre module : ces frameworks doivent
// etre visibles avant l'en-tete genere.
#import <AVKit/AVKit.h>
#import <GoogleCast/GoogleCast.h>
#import <React/RCTEventEmitter.h>
#import <WebKit/WebKit.h>

#import "Movix-Swift.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  [CastBootstrap configure];

  self.moduleName = @"Movix";
  self.initialProps = @{};
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (BOOL)application:(UIApplication *)application
continueUserActivity:(NSUserActivity *)userActivity
  restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> *))restorationHandler
{
  return [RCTLinkingManager application:application
                          continueUserActivity:userActivity
                            restorationHandler:restorationHandler];
}

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
