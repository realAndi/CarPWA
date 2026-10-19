//
//  CPWDRegistry.h — the installed apps. Scans <jbroot>/Library/CarPWA/Apps
//  (origin "system") and <data>/Apps (origin "user"), gives each app a port
//  that never changes (ports.json), runs its server, and publishes the list
//  for the tweak in run/apps.json. CPWDQueue() only.
//
//  Ports are never handed to a second app, even after the first is removed:
//  WebKit keys localStorage, IndexedDB and cookies by origin, so a reused
//  port would hand one app's browser data to another.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWDApp;

@interface CPWDRegistry : NSObject

+ (instancetype)sharedRegistry;

/// First scan, folder watchers and the rescan notification.
- (void)start;
/// Scans now and publishes the result.
- (void)rescan;
/// Rescans shortly; repeated calls collapse into one scan.
- (void)scheduleRescan;
/// Stops every app and publishes an empty list (daemon shutdown).
- (void)shutdown;

/// Running apps, sorted by name.
@property (nonatomic, readonly) NSArray<CPWDApp *> *apps;
@property (nonatomic, readonly) BOOL devMode;
@property (nonatomic, readonly) uint16_t controlPort;

- (nullable CPWDApp *)appWithID:(NSString *)appID;
/// YES when a package installed a folder for this id (it is read-only then).
- (BOOL)isSystemAppID:(NSString *)appID;
/// Why the folder for this id was skipped by the last scan, if it was.
- (nullable NSString *)problemForAppID:(NSString *)appID;

@end

NS_ASSUME_NONNULL_END
