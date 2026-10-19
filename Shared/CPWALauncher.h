//
//  CPWALauncher.h — what the tweak (inside CarPlay.app) and the launcher app
//  (where the pages run) agree on.
//
//  - The tweak opens a CarPWA app by setting the state of the Darwin
//    notification CPWAOpenAppNotification to CPWAAppIDHash(<app id>), posting
//    it, and launching the launcher (-[DBDashboard _launchAppWithInfo:forURL:]).
//    DashBoard does not hand the URL to a UIKit CarPlay scene, so the
//    launcher reads the state when its scene connects and on every post;
//    both sides know the app ids from apps.json.
//  - The launcher asks DashBoard for what only DashBoard can do by writing
//    one JSON request to CPWADashboardRequestPath and posting the Darwin
//    notification CPWADashboardRequestNotification; the tweak reads and
//    removes it:
//        { "action": "launch",  "bundleId": "com.spotify.client", "ts": <ms> }
//        { "action": "openURL", "url": "maps://?q=coffee",          "ts": <ms> }
//        { "action": "home",                                         "ts": <ms> }
//

#import <Foundation/Foundation.h>
#import <rootless.h>

#define CPWALauncherBundleID @"com.andi.carpwa.launcher"
#define CPWALauncherURLScheme @"carpwa-launcher"

#define CPWAOpenAppNotification "com.andi.carpwa/open-app"

/// FNV-1a over the UTF-8 app id; never 0, which means "no request".
static inline uint64_t CPWAAppIDHash(NSString *appID) {
    uint64_t hash = 0xcbf29ce484222325ULL;
    for (const char *p = appID.UTF8String; p && *p; p++) hash = (hash ^ (uint8_t)*p) * 0x100000001b3ULL;
    return hash ?: 1;
}

#define CPWADashboardRequestPath ROOT_PATH_NS(@"/var/mobile/Library/CarPWA/run/dashboard-request.json")
#define CPWADashboardRequestNotification "com.andi.carpwa/dashboard-request"
/// Requests older than this are ignored (a launcher that wrote one and died).
#define CPWADashboardRequestMaxAge 10.0
