//
//  CPWAUIModules.m — `input`, `ui`, `apps` and `system`.
//
//  input and ui act on the calling app's own page; their events are sent by
//  the host to that page alone. apps.open/openURL need `apps.launch`.
//

#import "CPWAModules.h"
#import "CPWAAppCatalog.h"
#import "CPWAHostViewController.h"
#import "CPWALog.h"
#import "CPWAPlugins.h"
#import "CPWACarKit.h"
#import "CPWADashboardLink.h"
#import "CPWALauncher.h"
#import "CPWAPresenter.h"
#import <sys/sysctl.h>

static CPWAHostViewController *CPWAHostOrFail(CPWACallContext *ctx, CPWAReply reply) {
    CPWAHostViewController *host = [[CPWAPresenter sharedPresenter] hostForAppID:ctx.appID];
    if (!host) reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"%@ has no page on the car screen", ctx.appID));
    return host;
}

#pragma mark - input

CPWAModule *CPWAMakeInputModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"input"];
    [m addEvent:@"move"];
    [m addEvent:@"select"];
    [m addEvent:@"back"];
    [m addMethod:@"setCaptureMode" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *mode = CPWAParamString(params, @"mode");
        if (![mode isEqualToString:@"app"] && ![mode isEqualToString:@"native"]) {
            reply(nil, CPWAMakeError(CPWAErrorInvalid, @"mode must be \"app\" or \"native\""));
            return;
        }
        CPWAHostViewController *host = CPWAHostOrFail(ctx, reply);
        if (!host) return;
        host.capturesInput = [mode isEqualToString:@"app"];
        CPWAReplyTrue(reply);
    }];
    [m addMethod:@"interceptBack" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CPWAHostViewController *host = CPWAHostOrFail(ctx, reply);
        if (!host) return;
        NSNumber *enabled = CPWAParamNumber(params, @"enabled");
        host.interceptsBack = enabled ? enabled.boolValue : YES;
        CPWAReplyTrue(reply);
    }];
    return m;
}

#pragma mark - ui

CPWAModule *CPWAMakeUIModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"ui"];
    [m addEvent:@"foreground"];
    [m addEvent:@"background"];
    [m addMethod:@"close" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CPWAPresenter *presenter = [CPWAPresenter sharedPresenter];
        if ([presenter.visibleHost.app.appID isEqualToString:ctx.appID]) [presenter closeVisibleApp];
        CPWAReplyTrue(reply);
    }];
    [m addMethod:@"alert" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CPWAHostViewController *host = CPWAHostOrFail(ctx, reply);
        if (!host) return;
        if (!host.onScreen) {
            reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"alerts need the app on screen"));
            return;
        }
        NSString *title = CPWAParamString(params, @"title"), *message = CPWAParamString(params, @"message");
        if (!title.length && !message.length) {
            reply(nil, CPWAMakeError(CPWAErrorInvalid, @"alert needs a title or a message"));
            return;
        }
        [host presentAlertWithTitle:title message:message actions:CPWAParamArray(params, @"actions") ?: @[]
                         completion:^(NSString *actionID) { reply(actionID ?: [NSNull null], nil); }];
    }];
    [m addMethod:@"banner" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *title = CPWAParamString(params, @"title");
        if (!title.length) { reply(nil, CPWAMakeError(CPWAErrorInvalid, @"banner needs a title")); return; }
        CPWAHostViewController *host = CPWAHostOrFail(ctx, reply);
        if (!host) return;
        if (!host.onScreen) { reply(@NO, nil); return; }
        double seconds = CPWAParamNumber(params, @"duration") ? CPWAParamNumber(params, @"duration").doubleValue : 3;
        [host showBannerWithTitle:title subtitle:CPWAParamString(params, @"subtitle") duration:MIN(MAX(seconds, 1), 10)];
        CPWAReplyTrue(reply);
    }];
    [m addMethod:@"setBackgroundColor" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        UIColor *color = CPWAColorFromCSS(CPWAParamString(params, @"color"));
        if (!color) {
            reply(nil, CPWAMakeError(CPWAErrorInvalid, @"color must be #rgb, #rrggbb, #rrggbbaa or rgb()/rgba()"));
            return;
        }
        CPWAHostViewController *host = CPWAHostOrFail(ctx, reply);
        if (!host) return;
        [host setPageBackgroundColor:color];
        CPWAReplyTrue(reply);
    }];
    return m;
}

#pragma mark - apps

// LaunchServices, for the installed apps; CarKit, for which of them CarPlay shows.
@interface LSApplicationWorkspace : NSObject
+ (instancetype)defaultWorkspace;
- (NSArray *)allInstalledApplications;
@end

@interface LSApplicationProxy : NSObject
@property (nonatomic, readonly) NSString *bundleIdentifier;
@property (nonatomic, readonly) NSString *localizedName;
@property (nonatomic, readonly) NSDictionary *entitlements;
@end

/// The CarPlay apps on this phone, as CarKit's policy sees them (what
/// DashBoard puts on its home screen, minus the hidden ones). Cached briefly:
/// asking LaunchServices for every app is slow.
static NSArray<NSDictionary *> *CPWACarPlayApps(void) {
    static NSArray *cached;
    static NSDate *cachedAt;
    if (cached && -cachedAt.timeIntervalSinceNow < 30) return cached;
    Class workspaceClass = NSClassFromString(@"LSApplicationWorkspace");
    Class declarationClass = NSClassFromString(@"CRCarPlayAppDeclaration");
    Class evaluatorClass = NSClassFromString(@"CRCarPlayAppPolicyEvaluator");
    if (!workspaceClass || !declarationClass || !evaluatorClass) return @[];
    CRCarPlayAppPolicyEvaluator *evaluator = [evaluatorClass new];
    NSMutableArray *apps = [NSMutableArray array];
    for (LSApplicationProxy *proxy in [[workspaceClass defaultWorkspace] allInstalledApplications]) {
        NSString *bundleID = [proxy respondsToSelector:@selector(bundleIdentifier)] ? proxy.bundleIdentifier : nil;
        if (!bundleID.length || [bundleID isEqualToString:CPWALauncherBundleID]) continue;
        NSDictionary *entitlements = [proxy respondsToSelector:@selector(entitlements)] ? proxy.entitlements : nil;
        if ([entitlements[@"CARAppHidden"] boolValue]) continue;
        CRCarPlayAppDeclaration *declaration = [declarationClass declarationForAppProxy:proxy];
        CRCarPlayAppPolicy *policy = declaration ? [evaluator effectivePolicyForAppDeclaration:declaration] : nil;
        if (!policy.isCarPlaySupported || !policy.canDisplayOnCarScreen) continue;
        NSString *name = [proxy respondsToSelector:@selector(localizedName)] ? proxy.localizedName : nil;
        [apps addObject:@{ @"bundleId": bundleID, @"name": name.length ? name : [NSNull null] }];
    }
    [apps sortUsingDescriptors:@[ [NSSortDescriptor sortDescriptorWithKey:@"bundleId" ascending:YES] ]];
    cached = [apps copy];
    cachedAt = [NSDate date];
    return cached;
}

static BOOL CPWAIsCarPlayApp(NSString *bundleID) {
    for (NSDictionary *app in CPWACarPlayApps()) if ([app[@"bundleId"] isEqualToString:bundleID]) return YES;
    return NO;
}

CPWAModule *CPWAMakeAppsModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"apps"];
    [m addMethod:@"list" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSMutableArray *carpwa = [NSMutableArray array];
        for (CPWAAppEntry *app in [CPWAAppCatalog sharedCatalog].apps) {
            [carpwa addObject:@{ @"id": app.appID, @"name": app.name, @"version": app.version, @"port": @(app.port),
                                 @"url": app.url.absoluteString ?: @"" }];
        }
        reply(@{ @"carpwa": carpwa, @"carplay": CPWACarPlayApps() }, nil);
    }];
    [m addMethod:@"open" permission:@"apps.launch" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *appID = CPWAParamString(params, @"id");
        if (!appID.length) { reply(nil, CPWAMakeError(CPWAErrorInvalid, @"open needs params.id")); return; }
        CPWAPresenter *presenter = [CPWAPresenter sharedPresenter];
        if (!presenter.connected) { reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"no CarPlay session")); return; }
        if ([[CPWAAppCatalog sharedCatalog] appWithID:appID]) {
            reply(@([presenter openAppWithID:appID]), nil);
            return;
        }
        if (!CPWAIsCarPlayApp(appID)) {
            reply(nil, CPWAMakeError(CPWAErrorNotFound, @"%@ is neither a CarPWA app nor a CarPlay app", appID));
            return;
        }
        NSError *error;
        if (CPWADashboardRequest(@{ @"action": @"launch", @"bundleId": appID }, &error)) CPWAReplyTrue(reply);
        else reply(nil, error);
    }];
    [m addMethod:@"openURL" permission:@"apps.launch" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *string = CPWAParamString(params, @"url");
        NSURL *url = string.length ? [NSURL URLWithString:string] : nil;
        if (!url.scheme.length) { reply(nil, CPWAMakeError(CPWAErrorInvalid, @"openURL needs an absolute URL")); return; }
        // DashBoard opens it the way it does when the car asks: in the CarPlay app for it.
        NSError *error;
        if (CPWADashboardRequest(@{ @"action": @"openURL", @"url": url.absoluteString }, &error)) CPWAReplyTrue(reply);
        else reply(nil, error);
    }];
    return m;
}

#pragma mark - system

static NSString *CPWAHardwareModel(void) {
    char buf[64] = { 0 };
    size_t len = sizeof(buf) - 1;
    if (sysctlbyname("hw.machine", buf, &len, NULL, 0) != 0) return UIDevice.currentDevice.model;
    return @(buf);
}

CPWAModule *CPWAMakeSystemModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"system"];
    [m addMethod:@"info" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        reply(@{
            @"carpwaVersion": CPWAVersion,
            @"iosVersion": UIDevice.currentDevice.systemVersion,
            @"device": CPWAHardwareModel(),
            @"locale": NSLocale.currentLocale.localeIdentifier,
            @"timeZone": NSTimeZone.localTimeZone.name,
            @"devMode": @([CPWAAppCatalog sharedCatalog].devMode),
            @"plugins": CPWALoadedPlugins(),
        }, nil);
    }];
    [m addMethod:@"log" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSString *message = CPWAParamString(params, @"message") ?: @"";
        NSString *level = CPWAParamString(params, @"level") ?: @"info";
        CPWALog(@"[%@] %@: %@", ctx.appID, level, message);
        CPWAReplyTrue(reply);
    }];
    return m;
}
