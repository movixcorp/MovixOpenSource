#import <React/RCTViewManager.h>

// Voir AppDelegate.mm : l'en-tete genere declare tout le module, y compris les
// classes qui heritent de RCTEventEmitter ou adoptent des protocoles AVKit,
// GoogleCast et WebKit. Ces frameworks doivent etre importes avant.
#import <AVKit/AVKit.h>
#import <GoogleCast/GoogleCast.h>
#import <React/RCTEventEmitter.h>
#import <WebKit/WebKit.h>

#import "Movix-Swift.h"

@interface MovixBrowserChromeViewManager : RCTViewManager
@end

@implementation MovixBrowserChromeViewManager

RCT_EXPORT_MODULE(MovixBrowserChromeView)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (UIView *)view
{
  return [[MovixBrowserChromeView alloc] initWithFrame:CGRectZero];
}

RCT_EXPORT_VIEW_PROPERTY(canGoBack, BOOL)
RCT_EXPORT_VIEW_PROPERTY(canGoForward, BOOL)
RCT_EXPORT_VIEW_PROPERTY(loading, BOOL)
RCT_EXPORT_VIEW_PROPERTY(currentURL, NSString)
RCT_EXPORT_VIEW_PROPERTY(dnsEnabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(showURLBar, BOOL)
RCT_EXPORT_VIEW_PROPERTY(showNavBar, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onGoBack, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onGoForward, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onReload, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onHome, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSettings, RCTBubblingEventBlock)

@end
