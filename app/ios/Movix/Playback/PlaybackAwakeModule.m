#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PlaybackAwake, NSObject)

RCT_EXTERN_METHOD(setLocalPlaybackAwake:(BOOL)active)

RCT_EXTERN_METHOD(setPlaybackAwakeOwner:(NSString *)owner
                  active:(BOOL)active)

@end
