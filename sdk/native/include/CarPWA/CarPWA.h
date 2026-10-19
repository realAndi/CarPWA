//
//  CarPWA.h — public API of libcarpwa
//
//  Native plugins use this to add modules to the JavaScript bridge that CarPWA
//  apps see as `CarPWA.call('<module>', '<method>', params)` and
//  `CarPWA.on('<module>', '<event>', fn)`.
//
//  Plugins are dylibs in <jbroot>/Library/CarPWA/Plugins/. CarPWA loads them
//  into its launcher app (CarPWA.app, where the pages run) at startup, after
//  its own modules are registered, so a plugin's constructor can register
//  modules straight away:
//
//      __attribute__((constructor)) static void init(void) {
//          CPWAModule *m = [[CPWAModule alloc] initWithName:@"battery"];
//          [m addMethod:@"level" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
//              UIDevice.currentDevice.batteryMonitoringEnabled = YES;
//              reply(@(UIDevice.currentDevice.batteryLevel), nil);
//          }];
//          CPWARegisterModule(m);
//      }
//
//  Everything here runs inside the launcher, on the main queue unless noted.
//  The launcher is sandboxed like an App Store app (with CarKit access), so
//  a plugin cannot reach everything CarPlay.app itself could.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#define CARPWA_API_VERSION 1

FOUNDATION_EXPORT NSString * const CPWAVersion;           // e.g. @"1.0.0"

#pragma mark - Errors

FOUNDATION_EXPORT NSErrorDomain const CPWAErrorDomain;
/// userInfo key holding the string code that JavaScript sees (`err.code`).
FOUNDATION_EXPORT NSString * const CPWAErrorCodeKey;

FOUNDATION_EXPORT NSString * const CPWAErrorInvalid;       // @"EINVAL"
FOUNDATION_EXPORT NSString * const CPWAErrorPermission;    // @"EPERM"
FOUNDATION_EXPORT NSString * const CPWAErrorNotFound;      // @"ENOTFOUND"
FOUNDATION_EXPORT NSString * const CPWAErrorUnavailable;   // @"EUNAVAILABLE"
FOUNDATION_EXPORT NSString * const CPWAErrorInternal;      // @"EINTERNAL"

/// Builds an error JavaScript receives as `{ code, message }`.
FOUNDATION_EXPORT NSError *CPWAMakeError(NSString *code, NSString *format, ...) NS_FORMAT_FUNCTION(2, 3);

/// The string code of any error (`EINTERNAL` for errors not made by CPWAMakeError).
FOUNDATION_EXPORT NSString *CPWAErrorCode(NSError *error);

#pragma mark - Calls

/// Who is calling: one CarPWA app, identified by the host, never by the page.
@interface CPWACallContext : NSObject
@property (nonatomic, copy, readonly) NSString *appID;
@property (nonatomic, copy, readonly) NSSet<NSString *> *permissions;
/// The app's parsed carpwa.json.
@property (nonatomic, copy, readonly) NSDictionary<NSString *, id> *manifest;
- (BOOL)hasPermission:(NSString *)permission;
- (instancetype)initWithAppID:(NSString *)appID
                  permissions:(NSSet<NSString *> *)permissions
                     manifest:(nullable NSDictionary<NSString *, id> *)manifest NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@end

/// Call exactly once, from any thread. `result` must be JSON-like (NSString,
/// NSNumber, NSNull, NSArray, NSDictionary); NSDate, NSData, NSURL, NSValue
/// (CGRect/CGSize/CGPoint/UIEdgeInsets) are converted for you, see CPWAJSONSafe.
typedef void (^CPWAReply)(id _Nullable result, NSError * _Nullable error);

/// `params` is always a dictionary (possibly empty).
typedef void (^CPWAMethodHandler)(NSDictionary<NSString *, id> *params, CPWACallContext *context, CPWAReply reply);

#pragma mark - Modules

@interface CPWAModule : NSObject

- (instancetype)initWithName:(NSString *)name NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// The JavaScript-visible name. Lowercase letters, digits, `-` and `_`.
@property (nonatomic, copy, readonly) NSString *name;

/// Permission required for every method and event of this module, unless a
/// method or event sets its own. nil means none.
@property (nonatomic, copy, nullable) NSString *permission;

- (void)addMethod:(NSString *)method handler:(CPWAMethodHandler)handler;
/// `permission` overrides the module's; pass nil to make the method free even when the module has one.
- (void)addMethod:(NSString *)method permission:(nullable NSString *)permission handler:(CPWAMethodHandler)handler;

/// Declares an event (for `CarPWA.modules()` and for permission checks).
/// Undeclared events can still be emitted; they use the module's permission.
- (void)addEvent:(NSString *)event;
- (void)addEvent:(NSString *)event permission:(nullable NSString *)permission;

@property (nonatomic, readonly) NSArray<NSString *> *methodNames;
@property (nonatomic, readonly) NSArray<NSString *> *eventNames;

/// Main queue. Called when the first page starts listening to `event`
/// (`"*"` when a page subscribes to everything), and when the last stops.
/// Start and stop expensive observers here.
@property (nonatomic, copy, nullable) void (^didStartObserving)(NSString *event);
@property (nonatomic, copy, nullable) void (^didStopObserving)(NSString *event);

/// YES if any page currently receives `event` (directly or through `"*"`).
- (BOOL)hasObserversForEvent:(NSString *)event;

/// Delivers an event to every page subscribed to it that holds the event's
/// permission. Safe from any thread; delivery happens on the main queue.
- (void)emit:(NSString *)event data:(nullable id)data;

@end

#pragma mark - Registry

/// A receiver of events: one running CarPWA page. Implemented by the CarPWA
/// host; plugins normally never implement this.
@protocol CPWAEventSink <NSObject>
@property (nonatomic, readonly) CPWACallContext *callContext;
- (void)deliverEvent:(NSString *)event module:(NSString *)module data:(nullable id)data;
@end

/// Posted (main queue) when a module is registered or removed.
FOUNDATION_EXPORT NSNotificationName const CPWARegistryDidChangeNotification;

@interface CPWARegistry : NSObject

+ (instancetype)sharedRegistry;

/// Registers a module; a module with the same name is replaced.
- (void)registerModule:(CPWAModule *)module;
- (void)unregisterModuleNamed:(NSString *)name;
- (nullable CPWAModule *)moduleNamed:(NSString *)name;
@property (nonatomic, readonly) NSArray<CPWAModule *> *modules;

// Used by the host. Main queue only.
- (void)addSink:(id<CPWAEventSink>)sink;
- (void)removeSink:(id<CPWAEventSink>)sink;
/// Runs a call, including the reserved `$subscribe`, `$unsubscribe` and
/// `$registry.modules`. The reply may arrive on any thread.
- (void)invokeModule:(NSString *)module
              method:(NSString *)method
              params:(nullable NSDictionary<NSString *, id> *)params
            fromSink:(id<CPWAEventSink>)sink
               reply:(CPWAReply)reply;

@end

/// Shorthand for `[[CPWARegistry sharedRegistry] registerModule:module]`.
FOUNDATION_EXPORT void CPWARegisterModule(CPWAModule *module);

#pragma mark - Car state

/// Posted (main queue) whenever CarPWA's view of the CarPlay session changes.
/// userInfo: @{ @"state": <same dictionary as car.getState()>, @"changed": @[keys] }.
FOUNDATION_EXPORT NSNotificationName const CPWACarStateDidChangeNotification;

/// The latest `car.getState()` dictionary, or nil before CarPlay connects.
FOUNDATION_EXPORT NSDictionary<NSString *, id> * _Nullable CPWACurrentCarState(void);

/// Called by CarPWA itself. Plugins should not call this.
FOUNDATION_EXPORT void CPWAPublishCarState(NSDictionary<NSString *, id> *state, NSArray<NSString *> *changed);

#pragma mark - Helpers

/// Converts a value to something JSONSerialization accepts (see CPWAReply).
/// Unknown objects become their description; NaN and infinities become NSNull.
FOUNDATION_EXPORT id _Nullable CPWAJSONSafe(id _Nullable value);

/// Reads a typed parameter, or nil when missing or of the wrong type.
FOUNDATION_EXPORT NSString * _Nullable CPWAParamString(NSDictionary *params, NSString *key);
FOUNDATION_EXPORT NSNumber * _Nullable CPWAParamNumber(NSDictionary *params, NSString *key);
FOUNDATION_EXPORT NSDictionary * _Nullable CPWAParamDictionary(NSDictionary *params, NSString *key);
FOUNDATION_EXPORT NSArray * _Nullable CPWAParamArray(NSDictionary *params, NSString *key);

NS_ASSUME_NONNULL_END
