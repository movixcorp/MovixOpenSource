#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MediaProxy, NSObject)

RCT_EXTERN_METHOD(open:(NSString *)url
                  method:(NSString *)method
                  headers:(NSDictionary<NSString *, NSString *> *)headers
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resolveForCast:(NSString *)localURL
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
