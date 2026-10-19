//
//  CPWACarKit.h — the CarPlay session, through CarKit (with the
//  com.apple.private.carkit entitlement): the same CARSession DashBoard reads,
//  its command callbacks (the car's URLs and remote events, night mode, view
//  areas) and the navigating apps. Main queue only.
//
//  The CarKit classes (CPWACarKitPrivate.h) are private and resolved at
//  runtime, so they are only ever messaged, never referenced as classes.
//

#import <UIKit/UIKit.h>
#import "CPWACarKitPrivate.h"

NS_ASSUME_NONNULL_BEGIN

/// Posted when the session connects, disconnects or changes (night mode,
/// view area, appearance, configuration).
FOUNDATION_EXPORT NSNotificationName const CPWACarKitSessionDidChangeNotification;
/// Posted when the list of navigating apps changes.
FOUNDATION_EXPORT NSNotificationName const CPWACarKitNavigationDidChangeNotification;

@class CARSession;

@interface CPWACarKit : NSObject

+ (instancetype)sharedCarKit;
/// Loads CarKit and starts following the session.
- (void)start;

@property (nonatomic, readonly, nullable) CARSession *session;

/// Bundle ids of the apps giving directions, while navigation is observed.
@property (nonatomic, readonly) NSArray<NSString *> *navigatingIdentifiers;
/// The last app that gave directions, if any did since the launcher started.
@property (nonatomic, readonly, nullable) NSString *mostRecentNavigatingIdentifier;
- (void)startObservingNavigation;
- (void)stopObservingNavigation;

@end

NS_ASSUME_NONNULL_END
