//
//  main.m — the CarPWA launcher: a CarPlay app (CARCapableApp, one
//  UIWindowSceneSessionRoleCarPlay scene) that shows CarPWA apps on the car
//  screen. The tweak in CarPlay.app opens it with carpwa-launcher://open?app=<id>.
//
//  It runs in the container sandbox like Safari and WebSheet: the platform
//  policy only lets sandboxed apps start WebKit's processes.
//

#import <UIKit/UIKit.h>
#import <CarPWA/CarPWA.h>
#import "CPWAAppCatalog.h"
#import "CPWACarKit.h"
#import "CPWACarState.h"
#import "CPWADashboardLink.h"
#import "CPWADisplayLink.h"
#import "CPWALog.h"
#import "CPWAPlugins.h"
#import "CPWAPresenter.h"
#import "Modules/CPWAModules.h"

@interface CPWALauncherAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation CPWALauncherAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    CPWAInstallCarDisplayLinks();
    CPWARegisterBuiltinModules();
    CPWALoadPlugins();
    [CPWAAppCatalog sharedCatalog];
    [CPWACarState sharedState];
    [[CPWACarKit sharedCarKit] start];
    CPWADashboardLinkCheck();
    CPWALog(@"CarPWA launcher %@ started (%lu app(s), %lu plugin(s))", CPWAVersion,
            (unsigned long)[CPWAAppCatalog sharedCatalog].apps.count, (unsigned long)CPWALoadedPlugins().count);
    return YES;
}

@end

@interface CPWALauncherSceneDelegate : UIResponder <UIWindowSceneDelegate>
@end

@implementation CPWALauncherSceneDelegate

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
        CPWALog(@"unexpected %@ for role %@", NSStringFromClass([scene class]), session.role);
        return;
    }
    [[CPWAPresenter sharedPresenter] sceneDidConnect:(UIWindowScene *)scene];
    [self openURLContexts:options.URLContexts];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    [self openURLContexts:contexts];
}

- (void)openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    for (UIOpenURLContext *context in contexts) {
        if (![[CPWAPresenter sharedPresenter] handleURL:context.URL]) CPWALog(@"ignoring URL %@", context.URL);
    }
}

- (void)sceneWillEnterForeground:(UIScene *)scene {
    [[CPWAPresenter sharedPresenter] sceneDidEnterForeground];
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
    [[CPWAPresenter sharedPresenter] sceneDidEnterBackground];
}

- (void)sceneDidDisconnect:(UIScene *)scene {
    [[CPWAPresenter sharedPresenter] sceneDidDisconnect];
}

- (void)windowScene:(UIWindowScene *)scene didUpdateCoordinateSpace:(id<UICoordinateSpace>)previous
    interfaceOrientation:(UIInterfaceOrientation)orientation traitCollection:(UITraitCollection *)traits {
    [[CPWAPresenter sharedPresenter] layoutHosts];
    [[CPWACarState sharedState] update];
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([CPWALauncherAppDelegate class]));
    }
}
