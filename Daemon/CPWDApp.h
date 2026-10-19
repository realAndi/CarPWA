//
//  CPWDApp.h — one installed CarPWA app: its folder, its own web server on
//  127.0.0.1:<port>, and the pages connected to it. CPWDQueue() only.
//

#import <Foundation/Foundation.h>
#import "CPWDBridge.h"
#import "CPWDServer.h"

NS_ASSUME_NONNULL_BEGIN

@class CPWDManifest, CPWDStorage;

@interface CPWDApp : NSObject <CPWDServerDelegate, CPWDClientOwner>

- (instancetype)initWithManifest:(CPWDManifest *)manifest
                            path:(NSString *)path
                          origin:(NSString *)origin
                            port:(uint16_t)port
                      sessionKey:(NSString *)sessionKey;

@property (nonatomic, copy, readonly) NSString *appID;
/// Replaced in place when a rescan finds a changed carpwa.json.
@property (nonatomic, strong) CPWDManifest *manifest;
@property (nonatomic, copy) NSString *path;
/// "system" (Library/CarPWA/Apps, from a package) or "user" (pushed).
@property (nonatomic, copy) NSString *origin;
@property (nonatomic, readonly) uint16_t port;
@property (nonatomic, copy, readonly) NSString *sessionKey;
@property (nonatomic, readonly) CPWDStorage *storage;
@property (nonatomic, readonly, getter=isRunning) BOOL running;
@property (nonatomic, readonly) NSArray<CPWDClient *> *clients;

/// http://127.0.0.1:<port>/<start_url>
@property (nonatomic, readonly) NSString *startURLString;
/// The icon file when it exists.
@property (nonatomic, readonly, nullable) NSString *iconPath;

- (BOOL)start;
/// Closes every page and stops the server.
- (void)stop;

/// The entry in run/apps.json (read by the tweak).
- (NSDictionary *)registryEntry;
/// `{ id, name, version, port, url }` for app.list.
- (NSDictionary *)listEntry;
/// `{ id, name, version, port, url, origin, path }` for the control API.
- (NSDictionary *)controlEntry;

/// Sends `dev.reload` to every open page of the app; returns how many.
- (NSUInteger)reloadPagesWithReason:(NSString *)reason;
- (void)broadcastEvent:(NSString *)event module:(NSString *)module data:(nullable id)data except:(nullable CPWDClient *)client;

@end

NS_ASSUME_NONNULL_END
