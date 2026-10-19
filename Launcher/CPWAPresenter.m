//
//  CPWAPresenter.m
//

#import "CPWAPresenter.h"
#import "CPWAAppCatalog.h"
#import "CPWACarState.h"
#import "CPWADashboardLink.h"
#import "CPWAHostViewController.h"
#import "CPWALauncher.h"
#import "CPWALog.h"
#import <CarPWA/CarPWA.h>
#import <notify.h>

// Pages kept alive in the background; the least recently shown go first.
static const NSUInteger CPWAMaxLiveHosts = 3;

/// The window's root: holds the visible host, routes focus and the back button to it.
@interface CPWARootViewController : UIViewController
@property (nonatomic, strong, readonly) UILabel *placeholder;
@end

@implementation CPWARootViewController

- (void)loadView {
    UIView *view = [[UIView alloc] initWithFrame:UIScreen.mainScreen.bounds];
    view.backgroundColor = UIColor.blackColor;
    _placeholder = [UILabel new];
    _placeholder.numberOfLines = 0;
    _placeholder.textAlignment = NSTextAlignmentCenter;
    _placeholder.font = [UIFont systemFontOfSize:18 weight:UIFontWeightMedium];
    _placeholder.textColor = [UIColor colorWithWhite:0.8 alpha:1];
    _placeholder.text = @"Open a CarPWA app from the CarPlay home screen.";
    [view addSubview:_placeholder];
    self.view = view;
}

- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];
    _placeholder.frame = UIEdgeInsetsInsetRect(UIEdgeInsetsInsetRect(self.view.bounds, self.view.safeAreaInsets),
                                               UIEdgeInsetsMake(16, 24, 16, 24));
    [[CPWAPresenter sharedPresenter] layoutHosts];
}

- (void)viewSafeAreaInsetsDidChange {
    [super viewSafeAreaInsetsDidChange];
    [[CPWACarState sharedState] update];
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
    [super traitCollectionDidChange:previous];
    [[CPWACarState sharedState] update];
}

- (NSArray<id<UIFocusEnvironment>> *)preferredFocusEnvironments {
    CPWAHostViewController *host = [CPWAPresenter sharedPresenter].visibleHost;
    return host ? @[ host ] : @[];
}

static BOOL CPWAIsBack(NSSet<UIPress *> *presses) {
    for (UIPress *press in presses) if (press.type == UIPressTypeMenu) return YES;
    return NO;
}

// The car's back button arrives as a Menu press. Unhandled, it goes on to
// CarPlay, which takes the user back to the home screen.
- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
    if (CPWAIsBack(presses) && [[CPWAPresenter sharedPresenter] handleBackButton]) return;
    [super pressesBegan:presses withEvent:event];
}

- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
    if (CPWAIsBack(presses) && [CPWAPresenter sharedPresenter].visibleHost) return;
    [super pressesEnded:presses withEvent:event];
}

@end

@implementation CPWAPresenter {
    NSMutableArray<CPWAHostViewController *> *_hosts;   // most recently shown last
    CPWARootViewController *_root;
    NSString *_pendingAppID;
    CGSize _lastSize;
    int _openToken;
}

+ (instancetype)sharedPresenter {
    static CPWAPresenter *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [CPWAPresenter new]; });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _hosts = [NSMutableArray array];
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(catalogDidChange:)
                                                     name:CPWAAppCatalogDidChangeNotification object:nil];
        __weak typeof(self) weakSelf = self;
        _openToken = NOTIFY_TOKEN_INVALID;
        notify_register_dispatch(CPWAOpenAppNotification, &_openToken, dispatch_get_main_queue(), ^(int token) {
            [weakSelf openRequestedApp];
        });
    }
    return self;
}

/// The app the tweak asked for (CPWALauncher.h).
- (void)openRequestedApp {
    uint64_t wanted = 0;
    if (_openToken == NOTIFY_TOKEN_INVALID || notify_get_state(_openToken, &wanted) != NOTIFY_STATUS_OK || !wanted) return;
    for (int attempt = 0; attempt < 2; attempt++) {
        for (CPWAAppEntry *app in [CPWAAppCatalog sharedCatalog].apps) {
            if (CPWAAppIDHash(app.appID) == wanted) {
                [self openAppWithID:app.appID];
                return;
            }
        }
        [[CPWAAppCatalog sharedCatalog] reload];   // pushed a moment ago?
    }
    CPWALog(@"the requested app is not in the catalog (%lu app(s))", (unsigned long)[CPWAAppCatalog sharedCatalog].apps.count);
}

- (NSArray<CPWAHostViewController *> *)hosts {
    return [_hosts copy];
}

- (BOOL)connected {
    return _window != nil;
}

- (CPWAHostViewController *)hostForAppID:(NSString *)appID {
    for (CPWAHostViewController *host in _hosts) if ([host.app.appID isEqualToString:appID]) return host;
    return nil;
}

#pragma mark Scene

- (void)sceneDidConnect:(UIWindowScene *)scene {
    if (_window) [self sceneDidDisconnect];
    _root = [CPWARootViewController new];
    _window = [[UIWindow alloc] initWithWindowScene:scene];
    _window.backgroundColor = UIColor.blackColor;
    _window.rootViewController = _root;
    [_window makeKeyAndVisible];
    [[CPWAAppCatalog sharedCatalog] reload];
    CPWALog(@"car scene connected, %@ (%lu app(s))", NSStringFromCGRect(_window.bounds),
            (unsigned long)[CPWAAppCatalog sharedCatalog].apps.count);
    if (_pendingAppID) {
        NSString *appID = _pendingAppID;
        _pendingAppID = nil;
        [self openAppWithID:appID];
    } else {
        [self openRequestedApp];
    }
    [[CPWACarState sharedState] update];
}

- (void)sceneDidDisconnect {
    CPWALog(@"car scene gone; closing %lu page(s)", (unsigned long)_hosts.count);
    for (CPWAHostViewController *host in [_hosts copy]) [self removeHost:host];
    _visibleHost = nil;
    _onScreen = NO;
    _window.hidden = YES;
    _window = nil;
    _root = nil;
    [[CPWACarState sharedState] update];
}

- (void)sceneDidEnterForeground {
    if (_onScreen) return;
    _onScreen = YES;
    [_visibleHost hostDidAppear];
    [[CPWACarState sharedState] update];
    [self requestFocusUpdate];
}

- (void)sceneDidEnterBackground {
    if (!_onScreen) return;
    _onScreen = NO;
    [_visibleHost hostDidDisappear];
    [[CPWACarState sharedState] update];
}

- (BOOL)handleURL:(NSURL *)url {
    if (![url.scheme.lowercaseString isEqualToString:CPWALauncherURLScheme]) return NO;
    NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    if (![components.host isEqualToString:@"open"]) return NO;
    for (NSURLQueryItem *item in components.queryItems) {
        if ([item.name isEqualToString:@"app"] && item.value.length) return [self openAppWithID:item.value];
    }
    return NO;
}

#pragma mark Showing

- (BOOL)openAppWithID:(NSString *)appID {
    CPWAAppEntry *app = [[CPWAAppCatalog sharedCatalog] appWithID:appID];
    if (!app) [[CPWAAppCatalog sharedCatalog] reload];   // pushed a moment ago?
    app = [[CPWAAppCatalog sharedCatalog] appWithID:appID];
    if (!app) {
        CPWALog(@"cannot open %@: no such app", appID);
        return NO;
    }
    if (!_root) {
        _pendingAppID = [appID copy];   // the scene is still connecting
        return YES;
    }
    CPWAHostViewController *host = [self hostForAppID:appID];
    if (host && host == _visibleHost) return YES;
    if (_visibleHost) [self hideVisibleHost];

    if (!host) {
        host = [[CPWAHostViewController alloc] initWithApp:app];
        [_root addChildViewController:host];
        [host didMoveToParentViewController:_root];
    } else {
        [_hosts removeObject:host];
    }
    [_hosts addObject:host];
    [self trimHosts];

    UIView *hostView = host.view;
    hostView.frame = _root.view.bounds;
    hostView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [_root.view addSubview:hostView];
    // Under CarPlay's sidebar the app's own colour shows, not the launcher's.
    _root.view.backgroundColor = app.backgroundColor;
    _window.backgroundColor = app.backgroundColor;
    _root.placeholder.hidden = YES;

    _visibleHost = host;
    CPWALog(@"showing %@", appID);
    if (_onScreen) [host hostDidAppear];
    [[CPWACarState sharedState] update];
    [self requestFocusUpdate];
    return YES;
}

- (void)hideVisibleHost {
    CPWAHostViewController *host = _visibleHost;
    if (!host) return;
    _visibleHost = nil;
    [host.view removeFromSuperview];
    if (_onScreen) [host hostDidDisappear];
    _root.placeholder.hidden = NO;
    CPWALog(@"hid %@", host.app.appID);
    [[CPWACarState sharedState] update];
    [self requestFocusUpdate];
}

- (void)closeVisibleApp {
    // The page stays in the window, so coming back to the launcher shows it again.
    NSError *error;
    if (!CPWADashboardRequest(@{ @"action": @"home" }, &error)) CPWALog(@"ui.close: %@", error.localizedDescription);
}

- (void)removeHost:(CPWAHostViewController *)host {
    if (host == _visibleHost) [self hideVisibleHost];
    [host tearDown];
    [host willMoveToParentViewController:nil];
    [host.view removeFromSuperview];
    [host removeFromParentViewController];
    [_hosts removeObject:host];
}

- (void)trimHosts {
    while (_hosts.count > CPWAMaxLiveHosts) {
        CPWAHostViewController *oldest = _hosts.firstObject;
        CPWALog(@"closing %@ (more than %lu pages open)", oldest.app.appID, (unsigned long)CPWAMaxLiveHosts);
        [self removeHost:oldest];
    }
}

#pragma mark Buttons

- (BOOL)handleBackButton {
    CPWAHostViewController *host = _visibleHost;
    return host && _onScreen && [host handleBack];
}

#pragma mark Layout and focus

- (void)layoutHosts {
    if (!_root || !_visibleHost) return;
    UIView *container = _root.view;
    if (_visibleHost.view.superview == container && !CGRectEqualToRect(_visibleHost.view.frame, container.bounds)) {
        _visibleHost.view.frame = container.bounds;
    }
    CGSize size = container.bounds.size;
    if (!CGSizeEqualToSize(size, _lastSize)) {
        _lastSize = size;
        CPWAModule *screen = [[CPWARegistry sharedRegistry] moduleNamed:@"screen"];
        [screen emit:@"change" data:[[CPWACarState sharedState] screenInfoForHost:_visibleHost]];
        [[CPWACarState sharedState] update];
    }
}

- (void)requestFocusUpdate {
    [_root setNeedsFocusUpdate];
    [_root updateFocusIfNeeded];
}

#pragma mark Catalog

- (void)catalogDidChange:(NSNotification *)note {
    CPWAAppCatalog *catalog = [CPWAAppCatalog sharedCatalog];
    for (CPWAHostViewController *host in [_hosts copy]) {
        CPWAAppEntry *app = [catalog appWithID:host.app.appID];
        if (!app) {
            CPWALog(@"%@ was removed; closing its page", host.app.appID);
            [self removeHost:host];
        } else {
            [host updateApp:app];
        }
    }
}

@end
