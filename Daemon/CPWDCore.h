//
//  CPWDCore.h — shared bits of carpwad: paths, logging, the network queue.
//
//  carpwad is single-threaded by design: every socket, timer, storage write
//  and bridge message runs on CPWDQueue(). Nothing in the daemon takes a lock.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#define CPWD_VERSION @"1.0.0"
#define CPWD_DEFAULT_BASE_PORT 47800

FOUNDATION_EXPORT NSString * const CPWDAppsChangedNotification;   // Darwin, posted by us
FOUNDATION_EXPORT NSString * const CPWDRescanNotification;        // Darwin, observed by us

dispatch_queue_t CPWDQueue(void);

void CPWDLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

/// The jailbreak root ("/var/jb" on rootless, "/" on rootful). Overridable
/// with $CARPWA_JBROOT, which the test suite uses to run on macOS.
NSString *CPWDJBRoot(void);
/// `relative` must start with "/"; returns it inside the jailbreak root.
NSString *CPWDPath(NSString *relative);

NSString *CPWDDataDir(void);        // <jbroot>/var/mobile/Library/CarPWA
NSString *CPWDSystemAppsDir(void);  // <jbroot>/Library/CarPWA/Apps
NSString *CPWDUserAppsDir(void);    // <data>/Apps
NSString *CPWDSDKDir(void);         // <jbroot>/Library/CarPWA/SDK
NSString *CPWDRunDir(void);         // <data>/run

/// mkdir -p, then chmod. Returns NO and logs on failure.
BOOL CPWDEnsureDirectory(NSString *path, mode_t mode);

/// Checks a path relative to an app folder ("img/logo.png"): no empty, "."
/// or ".." segments, no dot-files, no backslashes or NUL. Returns it without
/// a leading "/", or nil when it is not acceptable.
NSString * _Nullable CPWDCleanRelativePath(NSString *path);

/// Content-Type for a file name (same table as the CLI's mime.js).
NSString *CPWDMIMEType(NSString *path);
/// text/*, JSON, XML and JavaScript: what net.fetch returns as text.
BOOL CPWDIsTextualType(NSString * _Nullable contentType);

/// Random lowercase hex, `bytes` bytes of entropy.
NSString *CPWDRandomHex(NSUInteger bytes);
/// SHA-1 of data, lowercase hex.
NSString *CPWDSHA1Hex(NSData *data);
/// Constant-time string comparison for tokens.
BOOL CPWDSecureEquals(NSString * _Nullable a, NSString * _Nullable b);

/// The control-server token from <data>/dev-token (mode 0600), created on
/// first use. Stable across restarts; delete the file to rotate it.
NSString *CPWDDevToken(void);

/// Writes JSON atomically with the given POSIX mode. Returns NO and logs on failure.
BOOL CPWDWriteJSON(id object, NSString *path, mode_t mode);
id _Nullable CPWDReadJSON(NSString *path);

/// Milliseconds since the Unix epoch.
NSNumber *CPWDNowMillis(void);

/// Settings from <data>/config.json, with defaults.
@interface CPWDConfig : NSObject
@property (nonatomic, readonly) BOOL devMode;
@property (nonatomic, readonly) uint16_t basePort;
+ (instancetype)load;
@end

NS_ASSUME_NONNULL_END
