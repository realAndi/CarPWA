//
//  CPWAPresenter.h — shows CarPWA apps in the launcher's car window.
//
//  The launcher has one CarPlay scene (UIWindowSceneSessionRoleCarPlay) and
//  one window; the app on show is a CPWAHostViewController filling it. Hosts
//  stay alive when another app is shown or the scene goes to the background
//  (home button, another CarPlay app), so coming back is instant; the least
//  recently shown are torn down beyond a small limit.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWAHostViewController;

@interface CPWAPresenter : NSObject

+ (instancetype)sharedPresenter;

@property (nonatomic, readonly, nullable) UIWindow *window;
/// The car scene exists.
@property (nonatomic, readonly) BOOL connected;
/// The car scene is in the foreground: the visible host is on the car screen.
@property (nonatomic, readonly) BOOL onScreen;
/// The app shown in the window (on the car screen when `onScreen`).
@property (nonatomic, readonly, nullable) CPWAHostViewController *visibleHost;

- (void)sceneDidConnect:(UIWindowScene *)scene;
- (void)sceneDidDisconnect;
- (void)sceneDidEnterForeground;
- (void)sceneDidEnterBackground;
/// carpwa-launcher://open?app=<id>
- (BOOL)handleURL:(NSURL *)url;

/// Shows the app, creating its page if needed. NO when there is no such app or no car scene.
- (BOOL)openAppWithID:(NSString *)appID;
/// `ui.close`: back to the CarPlay home screen (the page keeps running).
- (void)closeVisibleApp;
/// The car's back button. YES when CarPWA consumed it.
- (BOOL)handleBackButton;

/// Re-frames hosts after the window's geometry changed.
- (void)layoutHosts;

- (nullable CPWAHostViewController *)hostForAppID:(NSString *)appID;
@property (nonatomic, readonly) NSArray<CPWAHostViewController *> *hosts;

@end

NS_ASSUME_NONNULL_END
