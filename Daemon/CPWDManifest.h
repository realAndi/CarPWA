//
//  CPWDManifest.h — carpwa.json as the daemon reads it (docs/guides/manifest.md).
//
//  The phone is lenient where `carpwa validate` is strict: only a missing or
//  unparsable manifest, a bad `id`/`name` or a too-new `min_carpwa` refuse the
//  app. Any other bad field falls back to its default and is reported in
//  `warnings`.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CPWDManifest : NSObject

@property (nonatomic, copy, readonly) NSString *appID;
@property (nonatomic, copy, readonly) NSString *name;
@property (nonatomic, copy, readonly) NSString *shortName;
@property (nonatomic, copy, readonly) NSString *version;
/// Relative to the app folder, may carry a query string ("index.html?x=1").
@property (nonatomic, copy, readonly) NSString *startURL;
/// `startURL` without query or fragment ("index.html").
@property (nonatomic, copy, readonly) NSString *startPath;
@property (nonatomic, copy, readonly) NSString *icon;
@property (nonatomic, copy, readonly) NSString *backgroundColor;
@property (nonatomic, readonly) BOOL spa;
@property (nonatomic, copy, readonly) NSArray<NSString *> *permissions;
/// Lowercased host patterns: "example.com" or "*.example.com".
@property (nonatomic, copy, readonly) NSArray<NSString *> *networkAllow;
@property (nonatomic, copy, readonly, nullable) NSString *minCarPWA;
@property (nonatomic, copy, readonly) NSArray<NSString *> *warnings;

/// The raw carpwa.json with every known field replaced by its normalized
/// value (plus "startPath"). Unknown fields are kept, so plugins can read
/// their own settings. Published in apps.json and at /_carpwa/manifest.
@property (nonatomic, copy, readonly) NSDictionary<NSString *, id> *dictionary;

+ (nullable instancetype)manifestWithData:(NSData *)data error:(NSString * _Nullable * _Nullable)error;

+ (BOOL)isValidAppID:(nullable NSString *)appID;
+ (NSArray<NSString *> *)knownPermissions;

- (BOOL)hasPermission:(NSString *)permission;
/// `network.allow` matching: exact host, or "*.domain" for subdomains only.
- (BOOL)allowsHost:(nullable NSString *)host;

@end

/// Numeric dotted comparison ("1.10" > "1.9"); missing parts count as 0.
NSComparisonResult CPWDCompareVersions(NSString *a, NSString *b);

NS_ASSUME_NONNULL_END
