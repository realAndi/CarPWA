//
//  CPWACarState.h — CarPWA's view of the CarPlay session: the `car.getState()`
//  snapshot, kept current and diffed, plus `car.getInfo()` and
//  `screen.getInfo()`. Main queue only.
//
//  `visible` is per app: the snapshot holds whether any CarPWA app is on
//  screen, and each host patches in its own visibility before a page sees it.
//
//  Sources: CarKit's CARSession (CPWACarKit) for the car, the launcher's car
//  window (CPWAPresenter) for geometry and appearance.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@class CARSession, CPWAHostViewController;

@interface CPWACarState : NSObject

+ (instancetype)sharedState;

@property (nonatomic, readonly, nullable) CARSession *session;

/// Recomputes the snapshot; when anything changed, publishes it
/// (CPWAPublishCarState) with the changed keys.
- (void)update;

/// The latest snapshot (carpwa.d.ts CarState), or a disconnected one.
@property (nonatomic, readonly) NSDictionary<NSString *, id> *state;
/// `state` with `visible` set for one app.
- (NSDictionary<NSString *, id> *)stateForHost:(nullable CPWAHostViewController *)host;

/// carpwa.d.ts CarInfo.
- (NSDictionary<NSString *, id> *)carInfoIncludingSerialNumber:(BOOL)serial;
/// carpwa.d.ts ScreenInfo for a host's area (the content area when nil).
- (NSDictionary<NSString *, id> *)screenInfoForHost:(nullable CPWAHostViewController *)host;

@end

NS_ASSUME_NONNULL_END
