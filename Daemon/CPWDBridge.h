//
//  CPWDBridge.h — the server bridge (protocol.md, "Server bridge"): one
//  CPWDClient per WebSocket, the `storage`, `channel`, `net`, `app` and `dev`
//  modules, and the hub that connects clients across apps. CPWDQueue() only.
//

#import <Foundation/Foundation.h>
#import "CPWDServer.h"

NS_ASSUME_NONNULL_BEGIN

@class CPWDApp, CPWDClient;

/// Whoever keeps the client alive: its app, or the control server for tools.
@protocol CPWDClientOwner <NSObject>
- (void)clientDidClose:(CPWDClient *)client;
@end

@interface CPWDClient : NSObject <CPWDSocketDelegate>

- (instancetype)initWithSocket:(CPWDSocket *)socket
                           app:(nullable CPWDApp *)app
                     developer:(BOOL)developer
                         owner:(id<CPWDClientOwner>)owner;

@property (nonatomic, strong, readonly) CPWDSocket *socket;
/// The app whose port the socket arrived on; nil for a tool connection on the control port.
@property (nonatomic, weak, readonly, nullable) CPWDApp *app;
/// Connected with the dev token rather than a session key.
@property (nonatomic, readonly) BOOL developer;
/// `from` in channel messages: the app id, or "dev" for tools.
@property (nonatomic, copy, readonly) NSString *senderName;

- (void)sendEvent:(NSString *)event module:(NSString *)module data:(nullable id)data;
- (void)close;

@end

@interface CPWDHub : NSObject

+ (instancetype)sharedHub;

- (void)client:(CPWDClient *)client joinChannel:(NSString *)channel;
- (void)client:(CPWDClient *)client leaveChannel:(NSString *)channel;
/// Sends `channel.message` to every joined client except the sender; returns how many got it.
- (NSUInteger)publishData:(id)data toChannel:(NSString *)channel from:(NSString *)from sender:(nullable CPWDClient *)sender;

/// `{ app, level, args, ts }` into the ring buffer and out to tailing clients.
- (void)appendLog:(NSDictionary *)entry;
/// `appID` nil follows every app. `backlog` replays that many buffered entries first.
- (void)client:(CPWDClient *)client tailLogsForApp:(nullable NSString *)appID backlog:(NSUInteger)backlog;
- (void)untailClient:(CPWDClient *)client;

- (void)removeClient:(CPWDClient *)client;

@end

NS_ASSUME_NONNULL_END
