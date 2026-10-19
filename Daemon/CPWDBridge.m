//
//  CPWDBridge.m
//

#import "CPWDBridge.h"
#import "CPWDApp.h"
#import "CPWDCore.h"
#import "CPWDManifest.h"
#import "CPWDNet.h"
#import "CPWDRegistry.h"
#import "CPWDStorage.h"

static const NSUInteger CPWDLogRingSize = 500;
static const NSUInteger CPWDMaxChannelName = 256;

typedef void (^CPWDBridgeReply)(id _Nullable result, NSString * _Nullable code, NSString * _Nullable message);

#pragma mark - Client

@implementation CPWDClient {
    __weak id<CPWDClientOwner> _owner;
}

- (instancetype)initWithSocket:(CPWDSocket *)socket app:(CPWDApp *)app developer:(BOOL)developer owner:(id<CPWDClientOwner>)owner {
    if ((self = [super init])) {
        _socket = socket;
        _app = app;
        _developer = developer;
        _owner = owner;
        _senderName = [app ? app.appID : @"dev" copy];
        socket.delegate = self;
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<client %@%@>", _senderName, _developer ? @" (dev)" : @""];
}

- (void)sendEvent:(NSString *)event module:(NSString *)module data:(id)data {
    [_socket sendJSON:@{ @"type": @"event", @"module": module, @"event": event, @"data": data ?: [NSNull null] }];
}

- (void)close {
    [_socket close];
}

#pragma mark CPWDSocketDelegate

- (void)socketDidClose:(CPWDSocket *)socket {
    [[CPWDHub sharedHub] removeClient:self];
    [_owner clientDidClose:self];
}

- (void)socket:(CPWDSocket *)socket didReceiveText:(NSString *)text {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    id msg = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![msg isKindOfClass:[NSDictionary class]]) return;
    id rawID = msg[@"id"];
    BOOL validID = [rawID isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)rawID) != CFBooleanGetTypeID() &&
                   [rawID doubleValue] >= 1 && [rawID doubleValue] == floor([rawID doubleValue]);
    if (!validID) return;   // nothing to reply to
    NSNumber *callID = rawID;

    __weak CPWDSocket *weakSocket = _socket;
    __block BOOL replied = NO;
    CPWDBridgeReply reply = ^(id result, NSString *code, NSString *message) {
        if (replied) return;
        replied = YES;
        CPWDSocket *s = weakSocket;
        if (!s) return;
        if (code) {
            [s sendJSON:@{ @"id": callID, @"type": @"error",
                           @"error": @{ @"code": code, @"message": message ?: code } }];
        } else {
            [s sendJSON:@{ @"id": callID, @"type": @"result", @"result": result ?: [NSNull null] }];
        }
    };

    NSString *module = msg[@"module"], *method = msg[@"method"];
    if (![msg[@"type"] isEqual:@"call"] || ![module isKindOfClass:[NSString class]] || ![method isKindOfClass:[NSString class]]) {
        reply(nil, @"EINVAL", @"expected { id, type: \"call\", module, method, params }");
        return;
    }
    NSDictionary *params = [msg[@"params"] isKindOfClass:[NSDictionary class]] ? msg[@"params"] : @{};
    @try {
        [self callModule:module method:method params:params reply:reply];
    } @catch (NSException *e) {
        CPWDLog(@"%@ %@.%@ threw %@: %@", self, module, method, e.name, e.reason);
        reply(nil, @"EINTERNAL", [NSString stringWithFormat:@"%@.%@ failed: %@", module, method, e.reason]);
    }
}

#pragma mark Modules

- (void)callModule:(NSString *)module method:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    // Server events are pushed without a subscription; accept the reserved
    // calls anyway so a generic client can treat both bridges alike.
    if ([method isEqualToString:@"$subscribe"] || [method isEqualToString:@"$unsubscribe"]) {
        static NSSet *modules;
        if (!modules) modules = [NSSet setWithObjects:@"app", @"storage", @"channel", @"net", @"dev", nil];
        if ([modules containsObject:module]) reply(@YES, nil, nil);
        else reply(nil, @"ENOTFOUND", [NSString stringWithFormat:@"No module named '%@' on the server bridge", module]);
        return;
    }
    if ([module isEqualToString:@"app"]) [self appMethod:method params:params reply:reply];
    else if ([module isEqualToString:@"storage"]) [self storageMethod:method params:params reply:reply];
    else if ([module isEqualToString:@"channel"]) [self channelMethod:method params:params reply:reply];
    else if ([module isEqualToString:@"net"]) [self netMethod:method params:params reply:reply];
    else if ([module isEqualToString:@"dev"]) [self devMethod:method params:params reply:reply];
    else reply(nil, @"ENOTFOUND", [NSString stringWithFormat:@"No module named '%@' on the server bridge", module]);
}

static void CPWDNoMethod(CPWDBridgeReply reply, NSString *module, NSString *method) {
    reply(nil, @"ENOTFOUND", [NSString stringWithFormat:@"No method %@.%@", module, method]);
}

- (void)appMethod:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    if ([method isEqualToString:@"list"]) {
        NSMutableArray *list = [NSMutableArray array];
        for (CPWDApp *app in [CPWDRegistry sharedRegistry].apps) [list addObject:app.listEntry];
        reply(list, nil, nil);
    } else if ([method isEqualToString:@"info"]) {
        CPWDApp *app = _app;
        if (!app) { reply(nil, @"ENOTFOUND", @"app.info: this connection does not belong to an app"); return; }
        CPWDManifest *m = app.manifest;
        reply(@{ @"id": app.appID, @"name": m.name, @"version": m.version, @"port": @(app.port),
                 @"permissions": m.permissions, @"origin": app.origin }, nil, nil);
    } else {
        CPWDNoMethod(reply, @"app", method);
    }
}

static NSString *CPWDKeyParam(NSDictionary *params) {
    NSString *key = params[@"key"];
    return [key isKindOfClass:[NSString class]] && key.length ? key : nil;
}

- (void)storageMethod:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    CPWDApp *app = _app;
    if (!app) { reply(nil, @"EINVAL", @"storage needs an app connection"); return; }
    CPWDStorage *storage = app.storage;
    BOOL needsKey = [@[ @"get", @"set", @"remove" ] containsObject:method];
    NSString *key = CPWDKeyParam(params);
    if (needsKey && !key) { reply(nil, @"EINVAL", @"key must be a non-empty string"); return; }

    if ([method isEqualToString:@"get"]) {
        reply([storage valueForKey:key] ?: [NSNull null], nil, nil);
    } else if ([method isEqualToString:@"set"]) {
        id value = params[@"value"] ?: [NSNull null];
        NSString *error = nil;
        if (![storage setValue:value forKey:key error:&error]) { reply(nil, @"EINVAL", error); return; }
        [app broadcastEvent:@"changed" module:@"storage" data:@{ @"key": key, @"value": value } except:self];
        reply(@YES, nil, nil);
    } else if ([method isEqualToString:@"remove"]) {
        [storage removeValueForKey:key];
        [app broadcastEvent:@"changed" module:@"storage" data:@{ @"key": key, @"value": [NSNull null] } except:self];
        reply(@YES, nil, nil);
    } else if ([method isEqualToString:@"keys"]) {
        reply(storage.keys, nil, nil);
    } else if ([method isEqualToString:@"getAll"]) {
        reply(storage.allValues, nil, nil);
    } else if ([method isEqualToString:@"clear"]) {
        [storage clear];
        [app broadcastEvent:@"changed" module:@"storage" data:@{ @"key": [NSNull null], @"value": [NSNull null] } except:self];
        reply(@YES, nil, nil);
    } else {
        CPWDNoMethod(reply, @"storage", method);
    }
}

- (void)channelMethod:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    NSString *channel = params[@"channel"];
    if (![channel isKindOfClass:[NSString class]] || channel.length == 0 || channel.length > CPWDMaxChannelName) {
        if ([@[ @"join", @"leave", @"publish" ] containsObject:method]) {
            reply(nil, @"EINVAL", @"channel must be a non-empty string (at most 256 characters)");
        } else {
            CPWDNoMethod(reply, @"channel", method);
        }
        return;
    }
    CPWDHub *hub = [CPWDHub sharedHub];
    if ([method isEqualToString:@"join"]) {
        [hub client:self joinChannel:channel];
        reply(@YES, nil, nil);
    } else if ([method isEqualToString:@"leave"]) {
        [hub client:self leaveChannel:channel];
        reply(@YES, nil, nil);
    } else if ([method isEqualToString:@"publish"]) {
        NSUInteger n = [hub publishData:params[@"data"] ?: [NSNull null] toChannel:channel from:_senderName sender:self];
        reply(@(n), nil, nil);
    } else {
        CPWDNoMethod(reply, @"channel", method);
    }
}

- (void)netMethod:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    if (![method isEqualToString:@"fetch"]) { CPWDNoMethod(reply, @"net", method); return; }
    CPWDApp *app = _app;
    if (!app) { reply(nil, @"EINVAL", @"net.fetch needs an app connection"); return; }
    if (![app.manifest hasPermission:@"network"]) {
        reply(nil, @"EPERM", @"net.fetch needs the 'network' permission in carpwa.json");
        return;
    }
    [CPWDNet fetchWithParams:params manifest:app.manifest completion:^(NSDictionary *result, NSString *code, NSString *message) {
        reply(result, code, message);
    }];
}

- (void)devMethod:(NSString *)method params:(NSDictionary *)params reply:(CPWDBridgeReply)reply {
    CPWDHub *hub = [CPWDHub sharedHub];
    if ([method isEqualToString:@"log"]) {
        static NSSet *levels;
        if (!levels) levels = [NSSet setWithObjects:@"log", @"info", @"warn", @"error", @"debug", nil];
        NSString *level = [levels containsObject:params[@"level"]] ? params[@"level"] : @"log";
        id args = params[@"args"];
        if (![args isKindOfClass:[NSArray class]]) args = args ? @[ args ] : @[];
        NSNumber *ts = [params[@"ts"] isKindOfClass:[NSNumber class]] ? params[@"ts"] : CPWDNowMillis();
        [hub appendLog:@{ @"app": _senderName, @"level": level, @"args": args, @"ts": ts }];
        reply(@YES, nil, nil);
        return;
    }
    if ([method isEqualToString:@"tailLogs"] || [method isEqualToString:@"untailLogs"]) {
        if (!_developer) {
            reply(nil, @"EPERM", [NSString stringWithFormat:@"dev.%@ needs a developer-token connection", method]);
            return;
        }
        if ([method isEqualToString:@"tailLogs"]) {
            NSString *appID = [params[@"app"] isKindOfClass:[NSString class]] && [params[@"app"] length] ? params[@"app"] : nil;
            NSUInteger backlog = [params[@"backlog"] isKindOfClass:[NSNumber class]] ? MIN([params[@"backlog"] unsignedIntegerValue], CPWDLogRingSize) : 0;
            [hub client:self tailLogsForApp:appID backlog:backlog];
        } else {
            [hub untailClient:self];
        }
        reply(@YES, nil, nil);
        return;
    }
    CPWDNoMethod(reply, @"dev", method);
}

@end

#pragma mark - Hub

@implementation CPWDHub {
    NSMutableDictionary<NSString *, NSHashTable<CPWDClient *> *> *_channels;
    NSMapTable<CPWDClient *, NSString *> *_tails;      // client → app filter ("" for all)
    NSMutableArray<NSDictionary *> *_logs;
}

+ (instancetype)sharedHub {
    static CPWDHub *hub;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ hub = [CPWDHub new]; });
    return hub;
}

- (instancetype)init {
    if ((self = [super init])) {
        _channels = [NSMutableDictionary dictionary];
        _tails = [NSMapTable weakToStrongObjectsMapTable];
        _logs = [NSMutableArray array];
    }
    return self;
}

- (void)client:(CPWDClient *)client joinChannel:(NSString *)channel {
    NSHashTable *members = _channels[channel];
    if (!members) {
        members = [NSHashTable weakObjectsHashTable];
        _channels[channel] = members;
    }
    [members addObject:client];
}

- (void)client:(CPWDClient *)client leaveChannel:(NSString *)channel {
    NSHashTable *members = _channels[channel];
    [members removeObject:client];
    if (members.allObjects.count == 0) [_channels removeObjectForKey:channel];
}

- (NSUInteger)publishData:(id)data toChannel:(NSString *)channel from:(NSString *)from sender:(CPWDClient *)sender {
    NSDictionary *message = @{ @"channel": channel, @"data": data ?: [NSNull null], @"from": from };
    NSUInteger count = 0;
    for (CPWDClient *client in _channels[channel].allObjects) {
        if (client == sender) continue;
        [client sendEvent:@"message" module:@"channel" data:message];
        count++;
    }
    return count;
}

- (void)appendLog:(NSDictionary *)entry {
    [_logs addObject:entry];
    if (_logs.count > CPWDLogRingSize) [_logs removeObjectsInRange:NSMakeRange(0, _logs.count - CPWDLogRingSize)];
    for (CPWDClient *client in _tails.keyEnumerator.allObjects) {
        NSString *filter = [_tails objectForKey:client];
        if (filter.length && ![filter isEqualToString:entry[@"app"]]) continue;
        [client sendEvent:@"log" module:@"dev" data:entry];
    }
}

- (void)client:(CPWDClient *)client tailLogsForApp:(NSString *)appID backlog:(NSUInteger)backlog {
    [_tails setObject:appID ?: @"" forKey:client];
    if (backlog == 0) return;
    NSMutableArray *matching = [NSMutableArray array];
    for (NSDictionary *entry in _logs.reverseObjectEnumerator) {
        if (appID && ![appID isEqualToString:entry[@"app"]]) continue;
        [matching insertObject:entry atIndex:0];
        if (matching.count == backlog) break;
    }
    for (NSDictionary *entry in matching) [client sendEvent:@"log" module:@"dev" data:entry];
}

- (void)untailClient:(CPWDClient *)client {
    [_tails removeObjectForKey:client];
}

- (void)removeClient:(CPWDClient *)client {
    for (NSString *channel in _channels.allKeys) [self client:client leaveChannel:channel];
    [_tails removeObjectForKey:client];
}

@end
