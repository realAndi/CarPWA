//
//  CPWACarKit.m
//

#import "CPWACarKit.h"
#import "CPWALog.h"
#import "Modules/CPWAModules.h"
#import <dlfcn.h>

NSNotificationName const CPWACarKitSessionDidChangeNotification = @"CPWACarKitSessionDidChangeNotification";
NSNotificationName const CPWACarKitNavigationDidChangeNotification = @"CPWACarKitNavigationDidChangeNotification";

@implementation CPWACarKit {
    CARSessionStatus *_status;
    CARSession *_observedSession;
    CARActiveNavigationIdentifiersObserver *_navigation;
    NSUInteger _navigationObservers;
}

+ (instancetype)sharedCarKit {
    static CPWACarKit *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [CPWACarKit new]; });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _navigatingIdentifiers = @[];
    }
    return self;
}

- (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (!dlopen("/System/Library/PrivateFrameworks/CarKit.framework/CarKit", RTLD_LAZY)) {
            CPWALog(@"CarKit did not load: %s", dlerror());
            return;
        }
        Class statusClass = NSClassFromString(@"CARSessionStatus");
        if (!statusClass) {
            CPWALog(@"CARSessionStatus is missing on this iOS version");
            return;
        }
        // The first session update arrives over XPC; wait for it off the main queue.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            CARSessionStatus *status = [[statusClass alloc] initAndWaitUntilSessionUpdated];
            dispatch_async(dispatch_get_main_queue(), ^{
                self->_status = status;
                if ([status respondsToSelector:@selector(addSessionObserver:)]) [status addSessionObserver:self];
                [self sessionMayHaveChanged];
            });
        });
    });
}

- (CARSession *)session {
    id session = [_status respondsToSelector:@selector(currentSession)] ? _status.currentSession : nil;
    return session;
}

/// Follows the current session's command callbacks and tells everyone.
- (void)sessionMayHaveChanged {
    CARSession *session = self.session;
    if (session != _observedSession) {
        if ([_observedSession respondsToSelector:@selector(removeObserver:)]) [_observedSession removeObserver:self];
        _observedSession = session;
        if ([session respondsToSelector:@selector(addObserver:)]) [session addObserver:self];
        CPWALog(@"CarPlay session %@", session ? @"connected" : @"gone");
    }
    [[NSNotificationCenter defaultCenter] postNotificationName:CPWACarKitSessionDidChangeNotification object:self];
}

- (void)onMain:(dispatch_block_t)block {
    if ([NSThread isMainThread]) block();
    else dispatch_async(dispatch_get_main_queue(), block);
}

#pragma mark CARSessionObserving

- (void)sessionDidConnect:(id)session {
    [self onMain:^{ [self sessionMayHaveChanged]; }];
}

- (void)sessionDidDisconnect:(id)session {
    [self onMain:^{ [self sessionMayHaveChanged]; }];
}

- (void)session:(id)session didUpdateConfiguration:(id)configuration {
    [self onMain:^{ [self sessionMayHaveChanged]; }];
}

#pragma mark CARSessionCommandObserving

- (void)session:(id)session didUpdateNightMode:(BOOL)nightMode {
    [self onMain:^{ [self sessionMayHaveChanged]; }];
}

- (void)session:(id)session didUpdateAppearanceStyle:(long long)style forScreenUUID:(id)uuid {
    [self onMain:^{ [self sessionMayHaveChanged]; }];
}

- (void)session:(id)session didSetViewArea:(id)area forScreenID:(id)screenID withDuration:(double)duration
    transitionControlType:(unsigned long long)type {
    // The window follows with its own geometry update; measure once it is done.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((duration + 0.05) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self sessionMayHaveChanged];
    });
}

- (void)session:(id)session openURL:(id)url {
    [self onMain:^{ if ([url isKindOfClass:[NSURL class]]) CPWACarModuleOpenURL(url); }];
}

- (void)session:(id)session receivedUnhandledRemoteEvent:(id)event withPayload:(id)payload {
    [self onMain:^{
        CPWACarModuleRemoteEvent([event isKindOfClass:[NSString class]] ? event : [event description], payload);
    }];
}

#pragma mark Navigation

- (void)startObservingNavigation {
    if (_navigationObservers++ > 0) return;
    Class cls = NSClassFromString(@"CARActiveNavigationIdentifiersObserver");
    if (!cls) {
        CPWALog(@"CARActiveNavigationIdentifiersObserver is missing on this iOS version");
        return;
    }
    _navigation = [cls new];
    [_navigation addObserver:self];
    [self setNavigatingIdentifiers:_navigation.activeNavigationIdentifiers];
}

- (void)stopObservingNavigation {
    if (_navigationObservers == 0 || --_navigationObservers > 0) return;
    [_navigation removeObserver:self];
    if ([_navigation respondsToSelector:@selector(invalidate)]) [_navigation invalidate];
    _navigation = nil;
}

- (void)setNavigatingIdentifiers:(NSArray *)identifiers {
    NSMutableArray *ids = [NSMutableArray array];
    for (id item in [identifiers isKindOfClass:[NSArray class]] ? identifiers : @[]) {
        [ids addObject:[item isKindOfClass:[NSString class]] ? item : [item description]];
    }
    if (ids.count) _mostRecentNavigatingIdentifier = ids.firstObject;
    if ([ids isEqualToArray:_navigatingIdentifiers]) return;
    _navigatingIdentifiers = [ids copy];
    [[NSNotificationCenter defaultCenter] postNotificationName:CPWACarKitNavigationDidChangeNotification object:self];
}

- (void)activeNavigationIdentifiersObserver:(id)observer updatedActiveNavigationIdentifiers:(id)identifiers {
    [self onMain:^{ [self setNavigatingIdentifiers:identifiers]; }];
}

@end
