//
//  CPWAAppCatalog.h — the installed CarPWA apps, as published by carpwad in
//  <jbroot>/var/mobile/Library/CarPWA/run/apps.json.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSNotificationName const CPWAAppCatalogDidChangeNotification;

@interface CPWAAppEntry : NSObject
@property (nonatomic, copy, readonly) NSString *appID;
@property (nonatomic, copy, readonly) NSString *name;
@property (nonatomic, copy, readonly) NSString *shortName;
@property (nonatomic, copy, readonly) NSString *version;
@property (nonatomic, strong, readonly) NSURL *url;
@property (nonatomic, readonly) NSInteger port;
@property (nonatomic, copy, readonly) NSString *sessionKey;
@property (nonatomic, copy, readonly, nullable) NSString *iconPath;
@property (nonatomic, copy, readonly) NSString *path;
@property (nonatomic, copy, readonly) NSSet<NSString *> *permissions;
@property (nonatomic, strong, readonly) UIColor *backgroundColor;
@property (nonatomic, copy, readonly) NSString *origin;
@property (nonatomic, copy, readonly) NSDictionary *manifest;
/// "carpwa.<appID>", the identifier of the app's CarPlay home-screen icon.
@property (nonatomic, copy, readonly) NSString *leafIdentifier;
@end

@interface CPWAAppCatalog : NSObject
+ (instancetype)sharedCatalog;
@property (nonatomic, copy, readonly) NSArray<CPWAAppEntry *> *apps;
@property (nonatomic, readonly) BOOL devMode;
@property (nonatomic, readonly) NSInteger controlPort;
- (nullable CPWAAppEntry *)appWithID:(NSString *)appID;
- (nullable CPWAAppEntry *)appWithLeafIdentifier:(NSString *)leafIdentifier;
/// Re-reads apps.json; posts CPWAAppCatalogDidChangeNotification if anything changed.
- (void)reload;
@end

/// Parses CSS colors: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), and a few names.
UIColor * _Nullable CPWAColorFromCSS(NSString * _Nullable css);

NS_ASSUME_NONNULL_END
