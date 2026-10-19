//
//  CPWAPrivate.h — the parts of DashBoard (CarPlay's UI) and SpringBoardHome
//  that the tweak touches. Checked against a class dump of iOS 17.3 (21D50);
//  everything is used defensively (respondsToSelector:/KVC) so a missing
//  method degrades a feature instead of crashing CarPlay. The launcher's
//  CarKit declarations are in Launcher/CPWACarKit.h.
//

#import <UIKit/UIKit.h>

typedef struct SBIconImageInfo {
    CGSize size;
    CGFloat scale;
    CGFloat continuousCornerRadius;
} SBIconImageInfo;

#pragma mark - SpringBoardHome

@interface SBIcon : NSObject
@property (nonatomic, copy, readonly) NSString *leafIdentifier;
@property (nonatomic, copy, readonly) NSString *applicationBundleID;
@property (nonatomic, copy, readonly) NSString *displayName;
- (void)reloadIconImage;
@end

@interface SBLeafIcon : SBIcon
- (instancetype)initWithLeafIdentifier:(NSString *)identifier applicationBundleID:(NSString *)bundleID;
- (void)addIconDataSource:(id)dataSource;
- (void)removeIconDataSource:(id)dataSource;
- (id)activeDataSource;
@end

@interface SBIconView : UIView
@property (nonatomic, strong) SBIcon *icon;
@end

@interface SBFolder : NSObject
- (BOOL)containsIcon:(SBIcon *)icon;
- (id)addIcon:(SBIcon *)icon;
@end

@interface SBHIconModel : NSObject
- (SBLeafIcon *)leafIconForIdentifier:(NSString *)identifier;
- (void)addIcon:(SBIcon *)icon;
- (void)removeIcon:(SBIcon *)icon;
- (BOOL)addIconToDesignatedLocation:(SBIcon *)icon options:(unsigned long long)options listGridCellInfoOptions:(unsigned long long)gridOptions;
- (void)reloadIcons;
- (void)layout;
- (SBFolder *)rootFolder;
- (NSSet *)leafIcons;
@end

#pragma mark - DashBoard

@interface DBIconModel : SBHIconModel
- (void)loadAllIcons;
- (BOOL)isIconVisible:(SBIcon *)icon;
- (id)exportStateForCarKit;
- (id)exportIconLayoutState;
@end

@interface DBDashboardEntity : NSObject
- (BOOL)isHomescreenEntity;
- (BOOL)isApplicationEntity;
- (BOOL)isSiriEntity;
@end

@interface DBDashboardWorkspaceState : NSObject
@property (nonatomic, readonly) DBDashboardEntity *baseEntity;
@property (nonatomic, readonly) DBDashboardEntity *stackedEntity;
@property (nonatomic, readonly) NSString *activeBundleIdentifier;
@end

@interface LSApplicationProxy : NSObject
+ (instancetype)applicationProxyForIdentifier:(NSString *)bundleID;
@end

/// FBSApplicationInfo subclass: what DashBoard launches. -initWithApplicationProxy:
/// is FBSApplicationInfo's; it calls DashBoard's -_loadFromProxy:.
@interface DBApplicationInfo : NSObject
@property (nonatomic, readonly) NSString *bundleIdentifier;
- (instancetype)initWithApplicationProxy:(LSApplicationProxy *)proxy;
- (NSString *)displayName;
@end

/// What -[DBDashboard _launchAppWithInfo:forURL:] takes.
@interface DBApplicationLaunchInfo : NSObject
@property (nonatomic, readonly) DBApplicationInfo *application;
+ (instancetype)launchInfoForApplication:(DBApplicationInfo *)application;
@end

/// DashBoard's data source for real app icons.
@interface DBLeafIconDataSource : NSObject
@property (nonatomic, strong) DBApplicationInfo *applicationInfo;
@end

@interface DBNavigationStateProvider : NSObject
@property (nonatomic, readonly) NSArray *navigatingIdentifiers;
@property (nonatomic, readonly) NSString *mostRecentNavigatingApp;
/// Observers implement DBNavigationStateObserving:
///   -navigationStateProvider:frontmostIdentifierDidChange:
///   -navigationStateProvider:navigatingIdentifiersDidChange:
- (void)addObserver:(id)observer;
- (void)removeObserver:(id)observer;
@end

@class CARSession;

@interface DBEnvironmentConfiguration : NSObject
@property (nonatomic, readonly) CARSession *session;
@property (nonatomic, readonly) CGRect currentViewAreaFrame;
@property (nonatomic, readonly) UIEdgeInsets currentViewAreaSafeAreaInsets;
@property (nonatomic, readonly) CGRect currentSafeViewAreaFrame;
@property (nonatomic, readonly) UITraitCollection *traitCollection;
@property (nonatomic, readonly) CGFloat screenScale;
@property (nonatomic, readonly) BOOL screenSupportsFocus;
@property (nonatomic, readonly, getter=isConnectedWirelessly) BOOL connectedWirelessly;
@property (nonatomic, readonly, getter=isRightHandDrive) BOOL rightHandDrive;
@property (nonatomic, readonly, getter=isACBackSupported) BOOL acBackSupported;
@property (nonatomic, readonly) NSInteger carUserInterfaceStyle;
@property (nonatomic, readonly) NSInteger nightModeUserInterfaceStyle;
@property (nonatomic, readonly) DBNavigationStateProvider *navigationStateProvider;
@end

@interface DBDashboardHomeViewController : UIViewController
@property (nonatomic, strong) DBIconModel *iconModel;
@property (nonatomic, readonly, copy) NSArray *allApplicationIcons;
- (id)iconForIdentifier:(NSString *)identifier;
- (BOOL)isIconVisible:(SBIcon *)icon;
- (void)iconManager:(id)manager launchIconForIconView:(SBIconView *)iconView;
@end

/// contentView (a CPUIPassthroughView) holds baseContainerView (home screen
/// or the active app) and stackedContainerView (Siri and the like) on top.
@interface DBDashboardRootViewController : UIViewController
@property (nonatomic, strong) UIView *contentView;
@property (nonatomic, strong) UIView *baseContainerView;
@property (nonatomic, strong) UIView *stackedContainerView;
@property (nonatomic, readonly) DBDashboardHomeViewController *homeViewController;
@property (nonatomic) CGFloat contentCornerRadius;
@end

@interface DBDashboard : NSObject
@property (nonatomic, strong) UIWindow *mainWindow;
@property (nonatomic, strong) NSMutableDictionary *identifierToAppInfoMap;
@property (nonatomic, readonly) NSString *activeBundleIdentifier;
@property (nonatomic, strong) UIWindowScene *windowScene;
@property (nonatomic, strong) DBDashboardRootViewController *rootViewController;
@property (nonatomic, strong) DBEnvironmentConfiguration *environmentConfiguration;
- (UIEdgeInsets)statusBarInsets;
- (void)handleConnect;
- (void)invalidate;
- (void)_handleHomeEvent:(id)event;
- (void)_homeTapped:(id)sender;
- (void)_acBackPressed:(id)sender;
- (void)workspace:(id)workspace stateDidChangeFromState:(DBDashboardWorkspaceState *)from toState:(DBDashboardWorkspaceState *)to;
- (void)environmentConfiguration:(id)config nightModeDidChange:(BOOL)nightMode;
- (void)environmentConfiguration:(id)config appearanceStyleDidChange:(NSInteger)style;
- (void)environmentConfiguration:(id)config viewAreaDidChangeFromViewAreaFrame:(CGRect)fromFrame
                  safeAreaInsets:(UIEdgeInsets)fromInsets
                toViewAreaFrame:(CGRect)toFrame
                  safeAreaInsets:(UIEdgeInsets)toInsets
                        duration:(double)duration
           transitionControlType:(NSUInteger)type;
- (void)session:(id)session openURL:(NSURL *)url;
- (void)session:(id)session receivedUnhandledRemoteEvent:(id)event withPayload:(id)payload;
- (void)_launchAppWithInfo:(DBApplicationLaunchInfo *)launchInfo forURL:(NSURL *)url;
/// What DashBoard does with a URL the car asks it to open.
- (void)_handleSessionURL:(NSURL *)url;
@end
