//
//  CPWANavModule.m — `nav` (permission `navigation`): which apps give
//  directions, from CarKit's navigation owners service, and turn-by-turn
//  ownership on the head unit.
//

#import "CPWAModules.h"
#import "CPWACarKit.h"
#import "CPWACarState.h"

static CPWAModule *gNav;
static BOOL gObserving;
static NSDictionary *gLastNavState;

static NSDictionary *CPWANavState(void) {
    CPWACarKit *carKit = [CPWACarKit sharedCarKit];
    NSArray *apps = carKit.navigatingIdentifiers;
    NSString *recent = carKit.mostRecentNavigatingIdentifier;
    CARSession *session = [CPWACarState sharedState].session;
    id owner = [session respondsToSelector:@selector(navigationOwner)] ? @([session navigationOwner]) : [NSNull null];
    return @{
        @"navigating": @(apps.count > 0),
        @"apps": apps,
        @"mostRecent": recent ?: [NSNull null],
        @"owner": owner,
    };
}

void CPWANavModuleStateMayHaveChanged(void) {
    if (!gObserving && !gLastNavState) return;
    NSDictionary *state = CPWANavState();
    if ([state isEqualToDictionary:gLastNavState]) return;
    gLastNavState = state;
    [gNav emit:@"change" data:state];
}

static void CPWANavStartObserving(void) {
    if (gObserving) return;
    gObserving = YES;
    [[CPWACarKit sharedCarKit] startObservingNavigation];
    gLastNavState = CPWANavState();
}

static void CPWANavStopObserving(void) {
    if (!gObserving) return;
    gObserving = NO;
    [[CPWACarKit sharedCarKit] stopObservingNavigation];
    gLastNavState = nil;
}

CPWAModule *CPWAMakeNavModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"nav"];
    gNav = m;
    m.permission = @"navigation";
    [m addEvent:@"change"];
    m.didStartObserving = ^(NSString *event) { CPWANavStartObserving(); };
    m.didStopObserving = ^(NSString *event) {
        if (![gNav hasObserversForEvent:@"change"]) CPWANavStopObserving();
    };
    for (NSNotificationName name in @[ CPWACarKitNavigationDidChangeNotification, CPWACarKitSessionDidChangeNotification ]) {
        [[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:NSOperationQueue.mainQueue
                                                      usingBlock:^(NSNotification *note) { CPWANavModuleStateMayHaveChanged(); }];
    }

    [m addMethod:@"getState" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        if (gObserving) {
            reply(CPWANavState(), nil);
            return;
        }
        // One-off read: observe until carkitd has answered.
        [[CPWACarKit sharedCarKit] startObservingNavigation];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            reply(CPWANavState(), nil);
            [[CPWACarKit sharedCarKit] stopObservingNavigation];
        });
    }];
    [m addMethod:@"requestOwnership" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CARSession *session = [CPWACarState sharedState].session;
        if (![session respondsToSelector:@selector(requestTurnByTurnOwnership)]) {
            reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"no CarPlay session"));
            return;
        }
        [session requestTurnByTurnOwnership];
        CPWAReplyTrue(reply);
    }];
    [m addMethod:@"releaseOwnership" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CARSession *session = [CPWACarState sharedState].session;
        if (![session respondsToSelector:@selector(releaseTurnByTurnOwnership)]) {
            reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"no CarPlay session"));
            return;
        }
        [session releaseTurnByTurnOwnership];
        CPWAReplyTrue(reply);
    }];
    return m;
}
