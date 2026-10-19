//
//  CPWDNet.h — `net.fetch`: HTTP(S) on behalf of a page, without CORS, only
//  to hosts in the manifest's `network.allow` (checked again on every redirect).
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWDManifest;

/// On success `result` is `{ status, statusText, headers, url, body, bodyEncoding }`;
/// on failure `code`/`message` are set. Called on CPWDQueue().
typedef void (^CPWDNetCompletion)(NSDictionary * _Nullable result, NSString * _Nullable code, NSString * _Nullable message);

@interface CPWDNet : NSObject
/// `params`: `{ url, method?, headers?, body?, bodyEncoding?: "text"|"base64", timeout? (seconds) }`.
+ (void)fetchWithParams:(NSDictionary *)params manifest:(CPWDManifest *)manifest completion:(CPWDNetCompletion)completion;
@end

NS_ASSUME_NONNULL_END
