//
//  CPWAHostViewController.h — one running CarPWA app: a WKWebView on the car
//  screen plus the page side of the car bridge.
//

#import <UIKit/UIKit.h>
#import <CarPWA/CarPWA.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWAAppEntry;

@interface CPWAHostViewController : UIViewController <CPWAEventSink>

- (instancetype)initWithApp:(CPWAAppEntry *)app;

@property (nonatomic, strong, readonly) CPWAAppEntry *app;
@property (nonatomic, readonly) CPWACallContext *callContext;
/// A newer apps.json entry for the same app: permissions and manifest apply
/// to the next call, a new session key or URL to the next page load.
- (void)updateApp:(CPWAAppEntry *)app;
/// YES between hostDidAppear and hostDidDisappear.
@property (nonatomic, readonly, getter=isOnScreen) BOOL onScreen;

/// Sends an event to this page only (input and ui events, which belong to
/// the app on screen, not to every page that subscribed).
- (void)sendEvent:(NSString *)event module:(NSString *)module data:(nullable id)data;

/// YES: knob, touchpad and D-pad input become `input.move` / `input.select`
/// events. NO: the web view gets normal focus behaviour.
@property (nonatomic) BOOL capturesInput;
/// YES: the car's back button sends `input.back` instead of navigating back.
@property (nonatomic) BOOL interceptsBack;

/// The insets the page should keep clear, in points.
@property (nonatomic, readonly) UIEdgeInsets contentSafeArea;

- (void)hostDidAppear;
- (void)hostDidDisappear;
/// Handles the car's back button. Returns YES when the host consumed it.
- (BOOL)handleBack;

- (void)showBannerWithTitle:(NSString *)title subtitle:(nullable NSString *)subtitle duration:(NSTimeInterval)duration;
- (void)presentAlertWithTitle:(nullable NSString *)title
                      message:(nullable NSString *)message
                      actions:(NSArray<NSDictionary *> *)actions
                   completion:(void (^)(NSString * _Nullable actionID))completion;
- (void)setPageBackgroundColor:(UIColor *)color;

/// Refreshes window.__CARPWA_NATIVE__ for the next page load.
- (void)refreshInjectedState;
- (void)reloadPage;
/// Detaches from the registry and stops the page. The host is unusable afterwards.
- (void)tearDown;

@end

NS_ASSUME_NONNULL_END
