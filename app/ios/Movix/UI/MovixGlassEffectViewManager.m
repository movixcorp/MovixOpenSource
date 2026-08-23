#import <React/RCTViewManager.h>
#import <React/RCTConvert.h>

// Voir AppDelegate.mm : l'en-tete genere declare tout le module, y compris les
// classes qui heritent de RCTEventEmitter ou adoptent des protocoles AVKit et
// GoogleCast. Ces frameworks doivent etre importes avant.
#import <AVKit/AVKit.h>
#import <GoogleCast/GoogleCast.h>
#import <React/RCTEventEmitter.h>

#import "Movix-Swift.h"

#import <math.h>

@interface MovixGlassEffectViewManager : RCTViewManager
@end

@implementation MovixGlassEffectViewManager

RCT_EXPORT_MODULE(MovixGlassEffectView)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (UIView *)view
{
  return [[MovixGlassEffectView alloc] initWithFrame:CGRectZero];
}

RCT_EXPORT_VIEW_PROPERTY(interactive, BOOL)
RCT_EXPORT_VIEW_PROPERTY(prominent, BOOL)
RCT_CUSTOM_VIEW_PROPERTY(cornerRadius, NSNumber, MovixGlassEffectView)
{
  if (json == nil || json == (id)kCFNull) {
    view.cornerRadius = nil;
    return;
  }

  NSNumber *value = [RCTConvert NSNumber:json];
  double radius = value.doubleValue;
  if (isfinite(radius) && radius >= 0.0 && radius <= 64.0) {
    view.cornerRadius = value;
  }
}

@end
