//
//  CPWACarKitPrivate.h — the parts of CarKit the launcher touches, checked
//  against a class dump of iOS 17.3 (21D50). Used defensively
//  (respondsToSelector:/KVC) so a missing method degrades a feature instead
//  of crashing the launcher.
//

#import <UIKit/UIKit.h>

@interface CARDisplayInfo : NSObject
@property (nonatomic, readonly) NSString *identifier;
@property (nonatomic, readonly) CGSize physicalSize;
@property (nonatomic, readonly) CGSize pixelSize;
@property (nonatomic, readonly) BOOL supportsCarPlayContent;
@property (nonatomic, readonly) BOOL supportsInstrumentClusterContent;
@end

@interface CARScreenViewArea : NSObject
/// In pixels of the car's screen.
@property (nonatomic, readonly) CGRect visibleFrame;
@property (nonatomic, readonly) CGRect safeFrame;
@end

@interface CARScreenInfo : NSObject
@property (nonatomic, readonly) NSString *identifier;
@property (nonatomic, readonly) NSUInteger screenType;
@property (nonatomic, readonly) NSUInteger availableInteractionModels;
@property (nonatomic, readonly) NSUInteger primaryInteractionModel;
@property (nonatomic, readonly) BOOL supportsHighFidelityTouch;
@property (nonatomic, readonly) NSUInteger maxFramesPerSecond;
@property (nonatomic, readonly, getter=isLimitedUI) BOOL limitedUI;
@property (nonatomic, readonly) NSUInteger limitedUIElements;
@property (nonatomic, readonly, getter=isNightMode) BOOL nightMode;
@property (nonatomic, readonly) CGSize physicalSize;
@property (nonatomic, readonly) CGSize pixelSize;
@property (nonatomic, readonly) CARDisplayInfo *physicalDisplay;
@property (nonatomic, strong) CARScreenViewArea *currentViewArea;
@end

@interface CARSessionConfiguration : NSObject
@property (nonatomic, readonly) NSString *name;
@property (nonatomic, readonly) NSString *modelName;
@property (nonatomic, readonly) NSString *manufacturerName;
@property (nonatomic, readonly) NSString *vehicleName;
@property (nonatomic, readonly) NSString *vehicleModelName;
@property (nonatomic, readonly) NSString *vehicleManufacturer;
@property (nonatomic, readonly) NSString *vehicleSerialNumber;
@property (nonatomic, readonly) NSString *vehicleFirmwareVersion;
@property (nonatomic, readonly) NSString *vehicleHardwareVersion;
@property (nonatomic, readonly) BOOL vehicleSupportsGasoline;
@property (nonatomic, readonly) BOOL vehicleSupportsDiesel;
@property (nonatomic, readonly) BOOL vehicleSupportsElectric;
@property (nonatomic, readonly) BOOL vehicleSupportsCNG;
@property (nonatomic, readonly) BOOL vehicleSupportsDestinationSharing;
@property (nonatomic, readonly) BOOL supportsElectronicTollCollection;
@property (nonatomic, readonly) BOOL nightModeSupported;
@property (nonatomic, readonly) BOOL rightHandDrive;
@property (nonatomic, readonly) BOOL supportsACBack;
@property (nonatomic, readonly) NSUInteger limitableUserInterfaces;
@property (nonatomic, readonly) NSUInteger transportType;
@property (nonatomic, readonly) NSArray<CARScreenInfo *> *screens;
@property (nonatomic, readonly) NSArray<CARDisplayInfo *> *displays;
@end

@interface CARSession : NSObject
@property (nonatomic, readonly) CARSessionConfiguration *configuration;
@property (nonatomic, readonly) NSNumber *nightMode;
@property (nonatomic, readonly) NSNumber *limitUserInterfaces;
/// A number, not an object.
- (unsigned long long)navigationOwner;
- (BOOL)carOwnsScreen;
- (BOOL)carOwnsMainAudio;
- (void)requestTurnByTurnOwnership;
- (void)releaseTurnByTurnOwnership;
- (void)requestCarUIForURL:(NSURL *)url;
- (void)requestCarUI;
- (void)sendCommand:(NSString *)command withParameters:(NSDictionary *)parameters;
/// Observers implement CARSessionCommandObserving (see CPWACarKit.m).
- (void)addObserver:(id)observer;
- (void)removeObserver:(id)observer;
@end

/// The CarPlay session as any process with com.apple.private.carkit sees it.
/// Observers implement CARSessionObserving: -sessionDidConnect:,
/// -sessionDidDisconnect:, -session:didUpdateConfiguration:.
@interface CARSessionStatus : NSObject
- (instancetype)initAndWaitUntilSessionUpdated;
@property (nonatomic, readonly) CARSession *currentSession;
- (void)addSessionObserver:(id)observer;
- (void)removeSessionObserver:(id)observer;
@end

/// Which apps give directions (carkitd's navigation owners service). Observers
/// implement -activeNavigationIdentifiersObserver:updatedActiveNavigationIdentifiers:.
@interface CARActiveNavigationIdentifiersObserver : NSObject
@property (nonatomic, readonly, copy) NSArray<NSString *> *activeNavigationIdentifiers;
- (void)addObserver:(id)observer;
- (void)removeObserver:(id)observer;
- (void)invalidate;
@end

/// What CarKit knows about an app's CarPlay support (entitlements, Info.plist).
@interface CRCarPlayAppDeclaration : NSObject
+ (instancetype)declarationForAppProxy:(id)proxy;
@end

@interface CRCarPlayAppPolicy : NSObject
@property (nonatomic, readonly, getter=isCarPlaySupported) BOOL carPlaySupported;
@property (nonatomic, readonly) BOOL canDisplayOnCarScreen;
@end

@interface CRCarPlayAppPolicyEvaluator : NSObject
- (CRCarPlayAppPolicy *)effectivePolicyForAppDeclaration:(CRCarPlayAppDeclaration *)declaration;
@end
