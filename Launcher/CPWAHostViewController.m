//
//  CPWAHostViewController.m
//

#import "CPWAHostViewController.h"
#import "CPWAAppCatalog.h"
#import "CPWACarState.h"
#import "CPWAFocusCapture.h"
#import "CPWALog.h"
#import "CPWAOverlay.h"
#import <WebKit/WebKit.h>
#import <objc/message.h>

static NSString * const CPWAHandlerName = @"carpwa";

/// WKUserContentController keeps its handlers alive; this keeps the host out of that cycle.
@interface CPWAWeakScriptHandler : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, weak) id<WKScriptMessageHandlerWithReply> target;
@end

@implementation CPWAWeakScriptHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    id<WKScriptMessageHandlerWithReply> target = self.target;
    if (target) [target userContentController:controller didReceiveScriptMessage:message replyHandler:replyHandler];
    else replyHandler(nil, @"EUNAVAILABLE: the page is closing");
}
@end

@interface CPWAHostViewController () <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, CPWAFocusCaptureDelegate>
@end

@implementation CPWAHostViewController {
    WKWebView *_webView;
    CPWAFocusCaptureView *_capture;
    CPWAWeakScriptHandler *_handler;
    CPWAAlertView *_alert;
    UILabel *_errorLabel;
    NSURL *_loadedURL;
    NSString *_loadedSessionKey;
    NSMutableArray<NSDate *> *_crashes;
    BOOL _attached;
    BOOL _tornDown;
    BOOL _retryScheduled;
}

- (instancetype)initWithApp:(CPWAAppEntry *)app {
    if ((self = [super initWithNibName:nil bundle:nil])) {
        _app = app;
        _callContext = [[CPWACallContext alloc] initWithAppID:app.appID permissions:app.permissions manifest:app.manifest];
        _crashes = [NSMutableArray array];
    }
    return self;
}

- (void)dealloc {
    if (!_tornDown) CPWALog(@"%@: host released without tearDown", _app.appID);
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<CPWAHost %@%@>", _app.appID, _onScreen ? @" on screen" : @""];
}

- (void)updateApp:(CPWAAppEntry *)app {
    if (![app.appID isEqualToString:_app.appID]) return;
    _app = app;
    _callContext = [[CPWACallContext alloc] initWithAppID:app.appID permissions:app.permissions manifest:app.manifest];
    if (self.isViewLoaded) self.view.backgroundColor = app.backgroundColor;
    BOOL keyChanged = _loadedSessionKey && ![_loadedSessionKey isEqualToString:app.sessionKey];
    BOOL urlChanged = _loadedURL && ![_loadedURL isEqual:app.url];
    [self refreshInjectedState];
    // carpwad restarted (new key) or the app moved: the open page cannot reach its server.
    if (keyChanged || urlChanged) {
        CPWALog(@"%@: %@ changed; reloading", app.appID, keyChanged ? @"session key" : @"URL");
        [self loadStartURL];
    }
}

#pragma mark View

- (void)loadView {
    UIView *view = [[UIView alloc] initWithFrame:UIScreen.mainScreen.bounds];
    view.backgroundColor = _app.backgroundColor;
    view.clipsToBounds = YES;
    self.view = view;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    // The default (persistent) store: localStorage and IndexedDB survive, keyed
    // by origin, which is why carpwad never reuses a port.
    config.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    config.allowsInlineMediaPlayback = YES;
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    config.applicationNameForUserAgent = [@"CarPWA/" stringByAppendingString:CPWAVersion];
    config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
    _handler = [CPWAWeakScriptHandler new];
    _handler.target = self;
    [config.userContentController addScriptMessageHandlerWithReply:_handler contentWorld:WKContentWorld.pageWorld name:CPWAHandlerName];

    _webView = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
    _webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _webView.opaque = NO;
    _webView.backgroundColor = UIColor.clearColor;
    _webView.underPageBackgroundColor = _app.backgroundColor;
    _webView.scrollView.backgroundColor = UIColor.clearColor;
    _webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    _webView.scrollView.bounces = NO;
    _webView.allowsBackForwardNavigationGestures = NO;
    _webView.allowsLinkPreview = NO;
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    // Safari ▸ Develop ▸ <iPhone> ▸ CarPlay lists the page while dev mode is on.
    // (-setInspectable: is iOS 16.4+, newer than the SDK we build against.)
    SEL setInspectable = NSSelectorFromString(@"setInspectable:");
    if ([_webView respondsToSelector:setInspectable]) {
        ((void (*)(id, SEL, BOOL))objc_msgSend)(_webView, setInspectable, [CPWAAppCatalog sharedCatalog].devMode);
    }
    [self.view addSubview:_webView];

    _capture = [[CPWAFocusCaptureView alloc] initWithFrame:self.view.bounds];
    _capture.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _capture.delegate = self;
    [self.view addSubview:_capture];

    [[CPWARegistry sharedRegistry] addSink:self];
    _attached = YES;
    [self refreshInjectedState];
    [self loadStartURL];
}

- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];
    _errorLabel.frame = UIEdgeInsetsInsetRect(self.view.bounds, UIEdgeInsetsMake(20, 30, 20, 30));
}

// CarPlay tells a new window about its sidebar a moment after it appears,
// often while the first page is still loading and before its SDK listens.
- (void)viewSafeAreaInsetsDidChange {
    [super viewSafeAreaInsetsDidChange];
    [self refreshInjectedState];
    [self sendGeometry];
}

/// The page's area and safe area, straight to this page (whether or not it subscribed).
- (void)sendGeometry {
    if (!self.view.window) return;
    CPWACarState *car = [CPWACarState sharedState];
    [self sendEvent:@"change" module:@"screen" data:[car screenInfoForHost:self]];
    [self sendEvent:@"state" module:@"car" data:@{ @"state": [car stateForHost:self], @"changed": @[ @"safeArea", @"viewArea" ] }];
}

- (UIEdgeInsets)contentSafeArea {
    // CarPlay puts its sidebar (and the car's safe frame) in the window's safe area.
    return self.isViewLoaded ? self.view.safeAreaInsets : UIEdgeInsetsZero;
}

#pragma mark Loading

- (NSString *)originString {
    return [NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)_app.port];
}

- (BOOL)isAppOrigin:(WKSecurityOrigin *)origin {
    if (![origin.protocol isEqualToString:@"http"] || origin.port != _app.port) return NO;
    return [origin.host isEqualToString:@"127.0.0.1"] || [origin.host isEqualToString:@"localhost"];
}

- (BOOL)isAppURL:(NSURL *)url {
    if (![url.scheme.lowercaseString isEqualToString:@"http"] || url.port.integerValue != _app.port) return NO;
    return [url.host isEqualToString:@"127.0.0.1"] || [url.host isEqualToString:@"localhost"];
}

- (void)refreshInjectedState {
    if (!_webView) return;
    CPWACarState *car = [CPWACarState sharedState];
    NSDictionary *native = @{
        @"appId": _app.appID,
        @"version": CPWAVersion,
        @"sessionKey": _app.sessionKey ?: @"",
        @"devMode": @([CPWAAppCatalog sharedCatalog].devMode),
        @"controlPort": @([CPWAAppCatalog sharedCatalog].controlPort),
        @"initialState": @{ @"car": [car stateForHost:self], @"screen": [car screenInfoForHost:self] },
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:CPWAJSONSafe(native) options:0 error:nil];
    NSString *origins = [NSString stringWithFormat:@"['http://127.0.0.1:%ld','http://localhost:%ld']", (long)_app.port, (long)_app.port];
    // Only the app's own origin gets the session key, even if the page navigates away.
    NSString *source = [NSString stringWithFormat:
        @"(function(){if(%@.indexOf(location.origin)<0)return;"
        @"window.__CARPWA_NATIVE__=%@;"
        @"try{window.webkit.messageHandlers.%@.postMessage({type:'lifecycle',event:'pageStart'});}catch(e){}})();",
        origins, [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding], CPWAHandlerName];
    WKUserContentController *ucc = _webView.configuration.userContentController;
    [ucc removeAllUserScripts];
    [ucc addUserScript:[[WKUserScript alloc] initWithSource:source injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                           forMainFrameOnly:YES inContentWorld:WKContentWorld.pageWorld]];
}

- (void)loadStartURL {
    if (_tornDown || !_webView) return;
    [self refreshInjectedState];
    _loadedURL = _app.url;
    _loadedSessionKey = _app.sessionKey;
    [_webView loadRequest:[NSURLRequest requestWithURL:_app.url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:15]];
}

- (void)reloadPage {
    if (!_webView.URL || [_webView.URL.absoluteString isEqualToString:@"about:blank"] || _errorLabel) [self loadStartURL];
    else {
        [self refreshInjectedState];
        [_webView reload];
    }
}

- (void)showError:(NSString *)message {
    if (!_errorLabel) {
        _errorLabel = [UILabel new];
        _errorLabel.numberOfLines = 0;
        _errorLabel.textAlignment = NSTextAlignmentCenter;
        _errorLabel.font = [UIFont systemFontOfSize:20 weight:UIFontWeightMedium];
        _errorLabel.textColor = [UIColor colorWithWhite:0.85 alpha:1];
        [self.view addSubview:_errorLabel];
        [self.view setNeedsLayout];
    }
    _errorLabel.text = [NSString stringWithFormat:@"%@\n\n%@", _app.name, message];
}

- (void)clearError {
    [_errorLabel removeFromSuperview];
    _errorLabel = nil;
}

- (void)scheduleRetry {
    if (_retryScheduled || _tornDown) return;
    _retryScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        self->_retryScheduled = NO;
        if (!self->_tornDown && self->_errorLabel) [self loadStartURL];
    });
}

#pragma mark Lifecycle

- (void)hostDidAppear {
    if (_onScreen) return;
    _onScreen = YES;
    [self sendEvent:@"foreground" module:@"ui" data:@{}];
    [self sendVisibilityChange];
    if (_errorLabel) [self loadStartURL];
}

- (void)hostDidDisappear {
    if (!_onScreen) return;
    _onScreen = NO;
    [_alert cancel];
    [self sendEvent:@"background" module:@"ui" data:@{}];
    [self sendVisibilityChange];
}

- (void)sendVisibilityChange {
    NSDictionary *state = [[CPWACarState sharedState] stateForHost:self];
    [self sendEvent:@"state" module:@"car" data:@{ @"state": state, @"changed": @[ @"visible" ] }];
}

- (void)tearDown {
    if (_tornDown) return;
    _tornDown = YES;
    [_alert dismissWithActionID:nil];
    if (_attached) [[CPWARegistry sharedRegistry] removeSink:self];
    _attached = NO;
    [_webView.configuration.userContentController removeAllScriptMessageHandlers];
    [_webView stopLoading];
    _webView.navigationDelegate = nil;
    _webView.UIDelegate = nil;
    [_webView removeFromSuperview];
    _webView = nil;
    _capture.delegate = nil;
}

/// A new document started in the main frame: forget what the last one set up.
- (void)pageDidStart {
    if (_attached) {
        [[CPWARegistry sharedRegistry] removeSink:self];
        [[CPWARegistry sharedRegistry] addSink:self];
    }
    self.capturesInput = NO;
    self.interceptsBack = NO;
    [_alert dismissWithActionID:nil];
}

#pragma mark CPWAEventSink

- (void)deliverEvent:(NSString *)event module:(NSString *)module data:(id)data {
    if ([module isEqualToString:@"car"] && [event isEqualToString:@"state"] && [data isKindOfClass:[NSDictionary class]]) {
        data = @{ @"state": [[CPWACarState sharedState] stateForHost:self], @"changed": data[@"changed"] ?: @[] };
    }
    [self sendEvent:event module:module data:data];
}

- (void)sendEvent:(NSString *)event module:(NSString *)module data:(id)data {
    if (!_webView || _tornDown) return;
    NSDictionary *message = @{ @"type": @"event", @"module": module, @"event": event, @"data": CPWAJSONSafe(data) ?: [NSNull null] };
    NSData *json = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (!json) return;
    NSString *js = [NSString stringWithFormat:@"window.__carpwa_native_event&&window.__carpwa_native_event(%@)",
                    [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]];
    [_webView evaluateJavaScript:js inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
}

#pragma mark Car bridge

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    if (!message.frameInfo.isMainFrame || ![self isAppOrigin:message.frameInfo.securityOrigin]) {
        replyHandler(nil, @"EPERM: the CarPWA bridge only answers the app's own page");
        return;
    }
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    if ([body[@"type"] isEqual:@"lifecycle"]) {
        if ([body[@"event"] isEqual:@"pageStart"]) [self pageDidStart];
        replyHandler(nil, nil);
        return;
    }
    NSString *module = body[@"module"], *method = body[@"method"];
    if (![body[@"type"] isEqual:@"call"] || ![module isKindOfClass:[NSString class]] || ![method isKindOfClass:[NSString class]]) {
        replyHandler(nil, @"EINVAL: expected { type: \"call\", module, method, params }");
        return;
    }
    NSDictionary *params = [body[@"params"] isKindOfClass:[NSDictionary class]] ? body[@"params"] : @{};
    [[CPWARegistry sharedRegistry] invokeModule:module method:method params:params fromSink:self reply:^(id result, NSError *error) {
        dispatch_block_t send = ^{
            if (error) {
                replyHandler(nil, [NSString stringWithFormat:@"%@: %@", CPWAErrorCode(error), error.localizedDescription ?: @""]);
            } else {
                replyHandler(result, nil);
            }
        };
        if ([NSThread isMainThread]) send();
        else dispatch_async(dispatch_get_main_queue(), send);
    }];
}

#pragma mark Input

- (void)setCapturesInput:(BOOL)capturesInput {
    _capturesInput = capturesInput;
    _capture.capturing = capturesInput;
    [self requestFocusUpdate];
}

- (void)requestFocusUpdate {
    UIViewController *root = self.parentViewController ?: self;
    [root setNeedsFocusUpdate];
    [root updateFocusIfNeeded];
}

- (NSArray<id<UIFocusEnvironment>> *)preferredFocusEnvironments {
    if (_alert) return @[ _alert ];
    if (_capturesInput && _capture) return @[ _capture ];
    return _webView ? @[ _webView ] : @[];
}

- (void)focusCapture:(CPWAFocusCaptureView *)capture didMove:(NSString *)direction {
    if (_onScreen) [self sendEvent:@"move" module:@"input" data:@{ @"direction": direction }];
}

- (void)focusCapture:(CPWAFocusCaptureView *)capture didSelect:(NSString *)phase {
    if (_onScreen) [self sendEvent:@"select" module:@"input" data:@{ @"phase": phase }];
}

- (BOOL)handleBack {
    if (_alert) {
        [_alert cancel];
        return YES;
    }
    if (_interceptsBack) {
        [self sendEvent:@"back" module:@"input" data:@{}];
        return YES;
    }
    if (_webView.canGoBack) {
        [_webView goBack];
        return YES;
    }
    return NO;
}

#pragma mark UI

- (void)setPageBackgroundColor:(UIColor *)color {
    self.view.backgroundColor = color;
    _webView.underPageBackgroundColor = color;
}

- (void)showBannerWithTitle:(NSString *)title subtitle:(NSString *)subtitle duration:(NSTimeInterval)duration {
    [CPWABannerView showInView:self.view title:title subtitle:subtitle duration:duration];
}

- (void)presentAlertWithTitle:(NSString *)title message:(NSString *)message actions:(NSArray<NSDictionary *> *)actions
                   completion:(void (^)(NSString *))completion {
    [_alert dismissWithActionID:nil];   // one at a time; the old one resolves with null
    __weak typeof(self) weakSelf = self;
    __block CPWAAlertView *alert = [[CPWAAlertView alloc] initWithTitle:title message:message actions:actions completion:^(NSString *actionID) {
        typeof(self) self_ = weakSelf;
        if (self_ && self_->_alert == alert) {
            self_->_alert = nil;
            [self_ requestFocusUpdate];
        }
        alert = nil;
        completion(actionID);
    }];
    _alert = alert;
    [alert presentInView:self.view];
    [self requestFocusUpdate];
}

#pragma mark WKNavigationDelegate

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    NSString *scheme = url.scheme.lowercaseString;
    if (!action.targetFrame.isMainFrame && action.targetFrame) {
        decisionHandler(WKNavigationActionPolicyAllow);   // iframes may show other sites; they get no bridge
        return;
    }
    if ([self isAppURL:url] || [scheme isEqualToString:@"about"] || [scheme isEqualToString:@"blob"] || [scheme isEqualToString:@"data"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    CPWALog(@"%@: blocked navigation to %@ (use CarPWA.apps.openURL to open other URLs)", _app.appID, url.absoluteString);
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    [self clearError];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [self sendGeometry];   // in case it changed after the page's initial state was injected
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
    CPWALog(@"%@: cannot load %@: %@", _app.appID, _app.url, error.localizedDescription);
    [self showError:@"Cannot reach the app's local server (carpwad).\nRetrying…"];
    [self scheduleRetry];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
    CPWALog(@"%@: navigation failed: %@", _app.appID, error.localizedDescription);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    NSDate *now = [NSDate date];
    [_crashes addObject:now];
    [_crashes filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDate *d, NSDictionary *b) {
        return [now timeIntervalSinceDate:d] < 60;
    }]];
    CPWALog(@"%@: web content process ended (%lu in the last minute)", _app.appID, (unsigned long)_crashes.count);
    if (_crashes.count >= 3) {
        [self showError:@"The page keeps crashing. Fix it and push again."];
        return;
    }
    [self loadStartURL];
}

#pragma mark WKUIDelegate

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
   forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    // window.open / target=_blank: same-origin pages open in place, others nowhere.
    if ([self isAppURL:action.request.URL]) [webView loadRequest:action.request];
    return nil;
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    if (!_onScreen) { completionHandler(); return; }
    [self presentAlertWithTitle:nil message:message actions:@[] completion:^(NSString *actionID) { completionHandler(); }];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    if (!_onScreen) { completionHandler(NO); return; }
    [self presentAlertWithTitle:nil message:message
                        actions:@[ @{ @"id": @"cancel", @"title": @"Cancel", @"style": @"cancel" }, @{ @"id": @"ok", @"title": @"OK" } ]
                     completion:^(NSString *actionID) { completionHandler([actionID isEqualToString:@"ok"]); }];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText
initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completionHandler {
    // No text entry on the car screen.
    completionHandler(nil);
}

@end
