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

// Journal réseau (diagnostic) — parité avec MediaProxyModule.kt.
RCT_EXTERN_METHOD(setJournalEnabled:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getJournal:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearJournal:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(recordJournalEntry:(NSString *)phase
                  method:(NSString *)method
                  url:(NSString *)url
                  headers:(NSDictionary<NSString *, NSString *> *)headers
                  statusCode:(nonnull NSNumber *)statusCode
                  error:(NSString *)error
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
