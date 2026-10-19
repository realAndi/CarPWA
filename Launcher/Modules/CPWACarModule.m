//
//  CPWACarModule.m — `car` and `screen`.
//
//  Free: car.getInfo (without serialNumber), car.getState, state events,
//  screen.*. `vehicle.identity` adds serialNumber; `car.raw` unlocks
//  sendCommand, requestCarUI and the remoteEvent/openURL events.
//

#import "CPWAModules.h"
#import "CPWACarState.h"
#import "CPWAPresenter.h"
#import "CPWACarKit.h"

static CPWAModule *gCar;

static void CPWACarStateChanged(NSNotification *note) {
    NSDictionary *state = note.userInfo[@"state"];
    NSArray *changed = note.userInfo[@"changed"];
    if (![state isKindOfClass:[NSDictionary class]] || ![changed isKindOfClass:[NSArray class]]) return;
    // Hosts swap in their own `visible` before the page sees it.
    [gCar emit:@"state" data:@{ @"state": state, @"changed": changed }];
    NSSet *keys = [NSSet setWithArray:changed];
    if ([keys containsObject:@"nightMode"]) [gCar emit:@"nightMode" data:@{ @"nightMode": state[@"nightMode"] }];
    if ([keys containsObject:@"appearance"]) [gCar emit:@"appearance" data:@{ @"appearance": state[@"appearance"] }];
    if ([keys containsObject:@"limitedUI"] || [keys containsObject:@"limitedUIElements"]) {
        [gCar emit:@"limitedUI" data:@{ @"limitedUI": state[@"limitedUI"], @"limitedUIElements": state[@"limitedUIElements"] }];
    }
    if ([keys containsObject:@"viewArea"] || [keys containsObject:@"safeArea"]) {
        [gCar emit:@"viewArea" data:@{ @"viewArea": state[@"viewArea"], @"safeArea": state[@"safeArea"] }];
    }
    if ([keys containsObject:@"connected"]) {
        if ([state[@"connected"] boolValue]) [gCar emit:@"connect" data:[[CPWACarState sharedState] carInfoIncludingSerialNumber:NO]];
        else [gCar emit:@"disconnect" data:@{}];
    }
}

void CPWACarModuleRemoteEvent(NSString *event, id payload) {
    [gCar emit:@"remoteEvent" data:@{ @"event": event ?: @"", @"payload": CPWAJSONSafe(payload) ?: [NSNull null] }];
}

void CPWACarModuleOpenURL(NSURL *url) {
    if (url.absoluteString) [gCar emit:@"openURL" data:@{ @"url": url.absoluteString }];
}

static CARSession *CPWASessionOrFail(CPWAReply reply) {
    CARSession *session = [CPWACarState sharedState].session;
    if (!session) reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"no CarPlay session"));
    return session;
}

CPWAModule *CPWAMakeCarModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"car"];
    gCar = m;
    for (NSString *event in @[ @"state", @"nightMode", @"appearance", @"limitedUI", @"viewArea", @"connect", @"disconnect" ]) {
        [m addEvent:event];
    }
    [m addEvent:@"remoteEvent" permission:@"car.raw"];
    [m addEvent:@"openURL" permission:@"car.raw"];
    [[NSNotificationCenter defaultCenter] addObserverForName:CPWACarStateDidChangeNotification object:nil
                                                       queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
        CPWACarStateChanged(note);
    }];

    [m addMethod:@"getInfo" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        reply([[CPWACarState sharedState] carInfoIncludingSerialNumber:[ctx hasPermission:@"vehicle.identity"]], nil);
    }];
    [m addMethod:@"getState" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CPWAHostViewController *host = [[CPWAPresenter sharedPresenter] hostForAppID:ctx.appID];
        reply([[CPWACarState sharedState] stateForHost:host], nil);
    }];
    [m addMethod:@"sendCommand" permission:@"car.raw" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *command = CPWAParamString(params, @"command");
        if (!command.length) { reply(nil, CPWAMakeError(CPWAErrorInvalid, @"sendCommand needs params.command")); return; }
        CARSession *session = CPWASessionOrFail(reply);
        if (!session) return;
        if (![session respondsToSelector:@selector(sendCommand:withParameters:)]) {
            reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"this iOS version cannot send session commands"));
            return;
        }
        [session sendCommand:command withParameters:CPWAParamDictionary(params, @"parameters") ?: @{}];
        CPWAReplyTrue(reply);
    }];
    [m addMethod:@"requestCarUI" permission:@"car.raw" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CARSession *session = CPWASessionOrFail(reply);
        if (!session) return;
        NSString *urlString = CPWAParamString(params, @"url");
        NSURL *url = urlString.length ? [NSURL URLWithString:urlString] : nil;
        if (urlString.length && !url) { reply(nil, CPWAMakeError(CPWAErrorInvalid, @"invalid URL %@", urlString)); return; }
        if (url && [session respondsToSelector:@selector(requestCarUIForURL:)]) [session requestCarUIForURL:url];
        else if ([session respondsToSelector:@selector(requestCarUI)]) [session requestCarUI];
        else { reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"this iOS version cannot request the car's UI")); return; }
        CPWAReplyTrue(reply);
    }];
    return m;
}

CPWAModule *CPWAMakeScreenModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"screen"];
    [m addEvent:@"change"];
    [m addMethod:@"getInfo" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CPWAHostViewController *host = [[CPWAPresenter sharedPresenter] hostForAppID:ctx.appID];
        reply([[CPWACarState sharedState] screenInfoForHost:host], nil);
    }];
    return m;
}
