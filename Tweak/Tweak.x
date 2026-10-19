//
//  Tweak.x — CarPWA inside CarPlay.app (DashBoard).
//
//  The pages run in the launcher app (com.andi.carpwa.launcher); this tweak
//  only does what needs DashBoard:
//
//  - Icons: one SBLeafIcon per app ("carpwa.<id>") added when DashBoard loads
//    its icons; launching one opens the launcher on that app. The launcher's
//    own icon is hidden.
//  - Requests from the launcher (CPWALauncher.h): launch another CarPlay app,
//    open a URL the way the car would, go to the home screen.
//
//  Every hook is in one group that only starts when DashBoard's classes are
//  there, so a changed iOS release loses CarPWA instead of CarPlay.
//

#import <UIKit/UIKit.h>
#import "CPWAAppCatalog.h"
#import "CPWAIconSource.h"
#import "CPWALaunch.h"
#import "CPWALauncher.h"
#import "CPWALog.h"
#import "CPWAPrivate.h"
#import <notify.h>
#import <rootless.h>

static __weak SBHIconModel *gIconModel;
static __weak DBDashboard *gDashboard;

static NSString *CPWALeafIdentifier(id icon) {
    NSString *leaf = [icon respondsToSelector:@selector(leafIdentifier)] ? [icon leafIdentifier] : nil;
    return [leaf isKindOfClass:[NSString class]] && [leaf hasPrefix:@"carpwa."] ? leaf : nil;
}

static CPWAAppEntry *CPWAAppForIcon(id icon) {
    NSString *leaf = CPWALeafIdentifier(icon);
    return leaf ? [[CPWAAppCatalog sharedCatalog] appWithLeafIdentifier:leaf] : nil;
}

static BOOL CPWAIsLauncherIcon(id icon) {
    NSString *bundleID = [icon respondsToSelector:@selector(applicationBundleID)] ? [icon applicationBundleID] : nil;
    return [bundleID isKindOfClass:[NSString class]] && [bundleID isEqualToString:CPWALauncherBundleID];
}

/// Makes the model hold exactly one icon per CarPWA app.
static void CPWASyncIcons(SBHIconModel *model) {
    Class leafClass = NSClassFromString(@"SBLeafIcon");
    if (!model || !leafClass) return;
    NSArray<CPWAAppEntry *> *apps = [CPWAAppCatalog sharedCatalog].apps;
    NSMutableSet *wanted = [NSMutableSet set];
    for (CPWAAppEntry *app in apps) [wanted addObject:app.leafIdentifier];

    NSSet *leafIcons = [model respondsToSelector:@selector(leafIcons)] ? [model leafIcons] : nil;
    for (id icon in [leafIcons allObjects]) {
        NSString *leaf = CPWALeafIdentifier(icon);
        if (leaf && ![wanted containsObject:leaf]) {
            CPWALog(@"removing icon %@", leaf);
            [model removeIcon:icon];
        }
    }

    SBFolder *root = [model respondsToSelector:@selector(rootFolder)] ? [model rootFolder] : nil;
    for (CPWAAppEntry *app in apps) {
        SBLeafIcon *icon = [model leafIconForIdentifier:app.leafIdentifier];
        if (!icon) {
            icon = [[leafClass alloc] initWithLeafIdentifier:app.leafIdentifier applicationBundleID:nil];
            [icon addIconDataSource:[CPWAIconSource sourceForAppID:app.appID]];
            [model addIcon:icon];
            CPWALog(@"added icon %@", app.leafIdentifier);
        } else if ([icon respondsToSelector:@selector(reloadIconImage)]) {
            [icon reloadIconImage];   // the app may have a new icon or label
        }
        if (root && ![root containsIcon:icon] && [model respondsToSelector:@selector(addIconToDesignatedLocation:options:listGridCellInfoOptions:)]) {
            [model addIconToDesignatedLocation:icon options:0 listGridCellInfoOptions:0];
        }
    }
}

/// CarKit copies the icon layout to the phone's CarPlay settings; keep our ids out of it.
static id CPWAStripIdentifiers(id value) {
    if ([value isKindOfClass:[NSArray class]]) {
        NSMutableArray *out = [NSMutableArray array];
        for (id item in value) {
            if ([item isKindOfClass:[NSString class]] && [item hasPrefix:@"carpwa."]) continue;
            [out addObject:CPWAStripIdentifiers(item)];
        }
        return out;
    }
    if ([value isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
            if ([key isKindOfClass:[NSString class]] && [key hasPrefix:@"carpwa."]) return;
            out[key] = CPWAStripIdentifiers(obj);
        }];
        return out;
    }
    return value;
}

#pragma mark Launching

/// DashBoard's description of a CarPlay app, which is what it launches: the
/// one its icon carries, or one made from LaunchServices the way DashBoard
/// makes its own (the launcher has no icon: it is hidden).
static DBApplicationInfo *CPWAApplicationInfo(NSString *bundleID) {
    SBHIconModel *model = gIconModel;
    SBLeafIcon *icon = [model respondsToSelector:@selector(leafIconForIdentifier:)] ? [model leafIconForIdentifier:bundleID] : nil;
    id source = [icon respondsToSelector:@selector(activeDataSource)] ? [icon activeDataSource] : nil;
    id info = [source respondsToSelector:@selector(applicationInfo)] ? [source applicationInfo] : nil;
    if (info) return info;
    DBDashboard *dashboard = gDashboard;
    info = [dashboard respondsToSelector:@selector(identifierToAppInfoMap)] ? dashboard.identifierToAppInfoMap[bundleID] : nil;
    if (info) return info;

    static NSMutableDictionary<NSString *, DBApplicationInfo *> *made;
    if (!made) made = [NSMutableDictionary dictionary];
    if (made[bundleID]) return made[bundleID];
    Class proxyClass = NSClassFromString(@"LSApplicationProxy"), infoClass = NSClassFromString(@"DBApplicationInfo");
    LSApplicationProxy *proxy = [proxyClass respondsToSelector:@selector(applicationProxyForIdentifier:)]
        ? [proxyClass applicationProxyForIdentifier:bundleID] : nil;
    info = proxy && [infoClass instancesRespondToSelector:@selector(initWithApplicationProxy:)]
        ? [[infoClass alloc] initWithApplicationProxy:proxy] : nil;
    if (info) made[bundleID] = info;
    else CPWALog(@"no application info for %@ (no icon, LaunchServices proxy %@)", bundleID, proxy ? @"found" : @"missing");
    return info;
}

static BOOL CPWALaunch(NSString *bundleID, NSURL *url) {
    DBDashboard *dashboard = gDashboard;
    DBApplicationInfo *info = CPWAApplicationInfo(bundleID);
    if (!dashboard || !info || ![dashboard respondsToSelector:@selector(_launchAppWithInfo:forURL:)]) {
        CPWALog(@"cannot launch %@: %@", bundleID, !dashboard ? @"no CarPlay session" : info ? @"no -_launchAppWithInfo:forURL:" : @"not a CarPlay app here");
        return NO;
    }
    Class launchInfoClass = NSClassFromString(@"DBApplicationLaunchInfo");
    DBApplicationLaunchInfo *launchInfo = [launchInfoClass respondsToSelector:@selector(launchInfoForApplication:)]
        ? [launchInfoClass launchInfoForApplication:info] : nil;
    if (!launchInfo) {
        CPWALog(@"cannot launch %@: no DBApplicationLaunchInfo on this iOS version", bundleID);
        return NO;
    }
    CPWALog(@"launching %@%@%@", bundleID, url ? @" with " : @"", url.absoluteString ?: @"");
    // Private API: a wrong guess must cost the launch, not CarPlay.
    @try {
        [dashboard _launchAppWithInfo:launchInfo forURL:url];
    } @catch (NSException *e) {
        CPWALog(@"launching %@ failed: %@", bundleID, e.reason);
        return NO;
    }
    return YES;
}

BOOL CPWAOpenAppInLauncher(NSString *appID) {
    // Which app: the state of CPWAOpenAppNotification (CPWALauncher.h).
    static int token = NOTIFY_TOKEN_INVALID;
    if (token == NOTIFY_TOKEN_INVALID) notify_register_check(CPWAOpenAppNotification, &token);
    notify_set_state(token, CPWAAppIDHash(appID));
    notify_post(CPWAOpenAppNotification);
    NSURLComponents *url = [NSURLComponents new];
    url.scheme = CPWALauncherURLScheme;
    url.host = @"open";
    url.queryItems = @[ [NSURLQueryItem queryItemWithName:@"app" value:appID] ];
    CPWALog(@"opening %@ in the launcher", appID);
    return CPWALaunch(CPWALauncherBundleID, url.URL);
}

/// One request from the launcher (CPWALauncher.h).
static void CPWAHandleDashboardRequest(void) {
    NSString *path = CPWADashboardRequestPath;
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return;
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![request isKindOfClass:[NSDictionary class]]) return;
    double ts = [request[@"ts"] respondsToSelector:@selector(doubleValue)] ? [request[@"ts"] doubleValue] / 1000.0 : 0;
    if (fabs([NSDate date].timeIntervalSince1970 - ts) > CPWADashboardRequestMaxAge) {
        CPWALog(@"ignoring a stale launcher request");
        return;
    }
    NSString *action = request[@"action"];
    DBDashboard *dashboard = gDashboard;
    CPWALog(@"launcher request: %@", action);
    @try {
        if ([action isEqual:@"launch"] && [request[@"bundleId"] isKindOfClass:[NSString class]]) {
            CPWALaunch(request[@"bundleId"], nil);
        } else if ([action isEqual:@"openURL"] && [request[@"url"] isKindOfClass:[NSString class]]) {
            NSURL *url = [NSURL URLWithString:request[@"url"]];
            // What DashBoard does when the car asks to open a URL: picks the CarPlay app for it.
            if (url && [dashboard respondsToSelector:@selector(_handleSessionURL:)]) [dashboard _handleSessionURL:url];
        } else if ([action isEqual:@"home"]) {
            if ([dashboard respondsToSelector:@selector(_homeTapped:)]) [dashboard _homeTapped:nil];
        } else {
            CPWALog(@"unknown launcher request %@", action);
        }
    } @catch (NSException *e) {
        CPWALog(@"launcher request %@ failed: %@", action, e.reason);
    }
}

%group DashBoard

%hook DBIconModel

- (void)loadAllIcons {
    %orig;
    gIconModel = self;
    CPWASyncIcons(self);
}

- (BOOL)isIconVisible:(id)icon {
    if (CPWAAppForIcon(icon)) return YES;
    if (CPWAIsLauncherIcon(icon)) return NO;
    return %orig;
}

- (id)exportStateForCarKit {
    id state = %orig;
    return CPWAStripIdentifiers(state);
}

- (id)exportIconLayoutState {
    id state = %orig;
    return CPWAStripIdentifiers(state);
}

%end

%hook DBDashboardHomeViewController

- (void)iconManager:(id)manager launchIconForIconView:(id)iconView {
    id icon = [iconView respondsToSelector:@selector(icon)] ? [iconView icon] : nil;
    CPWAAppEntry *app = CPWAAppForIcon(icon);
    if (app) {
        CPWAOpenAppInLauncher(app.appID);
        return;
    }
    %orig;
}

- (BOOL)isIconVisible:(id)icon {
    if (CPWAAppForIcon(icon)) return YES;
    if (CPWAIsLauncherIcon(icon)) return NO;
    return %orig;
}

%end

%hook DBDashboard

- (void)handleConnect {
    %orig;
    gDashboard = self;
    [[CPWAAppCatalog sharedCatalog] reload];
    CPWALog(@"CarPlay connected");
}

- (void)invalidate {
    if (gDashboard == self) {
        gDashboard = nil;
        CPWALog(@"CarPlay disconnected");
    }
    %orig;
}

%end

%end

%ctor {
    @autoreleasepool {
        // Escape hatch if CarPWA ever keeps CarPlay from starting:
        //   touch /var/jb/var/mobile/Library/CarPWA/disable-tweak && killall -9 CarPlay
        if ([[NSFileManager defaultManager] fileExistsAtPath:ROOT_PATH_NS(@"/var/mobile/Library/CarPWA/disable-tweak")]) {
            CPWALog(@"disable-tweak is present; CarPWA stays off");
            return;
        }
        NSArray *required = @[ @"DBDashboard", @"DBIconModel", @"DBDashboardHomeViewController", @"SBLeafIcon" ];
        for (NSString *name in required) {
            if (!NSClassFromString(name)) {
                CPWALog(@"%@ is missing on this iOS version; CarPWA stays off", name);
                return;
            }
        }
        [CPWAAppCatalog sharedCatalog];
        [[NSNotificationCenter defaultCenter] addObserverForName:CPWAAppCatalogDidChangeNotification object:nil
                                                           queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            [CPWAIconSource purgeImageCache];
            CPWASyncIcons(gIconModel);
        }];
        int token;
        notify_register_dispatch(CPWADashboardRequestNotification, &token, dispatch_get_main_queue(), ^(int t) {
            CPWAHandleDashboardRequest();
        });
        %init(DashBoard);
        CPWALog(@"CarPWA tweak loaded (%lu app(s))", (unsigned long)[CPWAAppCatalog sharedCatalog].apps.count);
    }
}
