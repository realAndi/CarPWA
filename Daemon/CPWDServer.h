//
//  CPWDServer.h — Objective-C wrapper around civetweb.
//
//  civetweb owns the sockets and its worker threads. This wrapper hops every
//  request and WebSocket message onto CPWDQueue(), so delegates run on the
//  daemon's single serial queue and never need locks.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWDServer, CPWDSocket;

@interface CPWDRequest : NSObject
@property (nonatomic, copy, readonly) NSString *method;
/// Percent-decoded path without the query, e.g. "/img/logo.png".
@property (nonatomic, copy, readonly) NSString *path;
@property (nonatomic, copy, readonly) NSDictionary<NSString *, NSString *> *query;
/// Header names are lowercased.
@property (nonatomic, copy, readonly) NSDictionary<NSString *, NSString *> *headers;
@property (nonatomic, strong, readonly) NSData *body;
@property (nonatomic, readonly) uint16_t localPort;
- (nullable NSString *)header:(NSString *)name;
/// The body parsed as JSON, or nil.
- (nullable id)JSONBody;
/// Puts the body at `path` (replacing it). Large bodies were spooled to disk
/// while they arrived, so this is a rename when `path` is on the same volume
/// as the spool directory, and a write otherwise.
- (BOOL)moveBodyToPath:(NSString *)path error:(NSError **)error;
@end

@interface CPWDResponse : NSObject
@property (nonatomic) NSInteger status;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *headers;
@property (nonatomic, strong, nullable) NSData *body;
/// When set, civetweb streams this file (Range, ETag and HEAD handled) and `body` is ignored.
@property (nonatomic, copy, nullable) NSString *filePath;
@property (nonatomic, copy, nullable) NSString *fileMIMEType;

+ (instancetype)status:(NSInteger)status json:(id)object;
+ (instancetype)status:(NSInteger)status text:(NSString *)text;
+ (instancetype)status:(NSInteger)status data:(NSData *)data type:(NSString *)type;
/// `{ "error": { "code": code, "message": message } }`
+ (instancetype)status:(NSInteger)status code:(NSString *)code message:(NSString *)message;
+ (instancetype)file:(NSString *)path type:(NSString *)type;
@end

@protocol CPWDSocketDelegate <NSObject>
- (void)socket:(CPWDSocket *)socket didReceiveText:(NSString *)text;
- (void)socketDidClose:(CPWDSocket *)socket;
@end

/// One accepted WebSocket. Methods are safe from any thread.
@interface CPWDSocket : NSObject
@property (nonatomic, weak, nullable) id<CPWDSocketDelegate> delegate;
@property (nonatomic, readonly, getter=isOpen) BOOL open;
@property (nonatomic, readonly) CPWDRequest *request;
- (void)sendText:(NSString *)text;
- (void)sendJSON:(id)object;
- (void)close;
@end

@protocol CPWDServerDelegate <NSObject>
- (CPWDResponse *)server:(CPWDServer *)server handleRequest:(CPWDRequest *)request;
/// Return YES (and set socket.delegate) to accept an upgrade on `server.webSocketPath`.
- (BOOL)server:(CPWDServer *)server shouldAcceptSocket:(CPWDSocket *)socket;
@end

@interface CPWDServer : NSObject
@property (nonatomic, weak, nullable) id<CPWDServerDelegate> delegate;
@property (nonatomic, readonly) uint16_t port;
@property (nonatomic, copy, readonly) NSString *name;

/// Call once before starting any server.
+ (void)initializeLibrary;
/// Where request bodies over 1 MiB are written while they arrive (default:
/// the temporary directory). Put it on the volume the bodies end up on.
+ (void)setSpoolDirectory:(NSString *)path;

- (instancetype)initWithName:(NSString *)name port:(uint16_t)port webSocketPath:(NSString *)path;
/// civetweb worker threads (default 8). Every open WebSocket holds one, and
/// so does an idle keep-alive connection for up to two seconds.
@property (nonatomic) NSUInteger threadCount;
/// Larger request bodies get 413 (default 512 MiB).
@property (nonatomic) unsigned long long maxBodySize;
/// Listens on 127.0.0.1:port. Returns NO if the port cannot be bound.
- (BOOL)start;
/// Stops listening and closes every connection. Blocks until civetweb's
/// threads exit, so never call it on CPWDQueue(); `stopAsync` does it right.
- (void)stopAsync;
@end

NS_ASSUME_NONNULL_END
