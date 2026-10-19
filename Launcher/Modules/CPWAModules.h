//
//  CPWAModules.h — the built-in car-bridge modules (carpwa.d.ts, and the
//  permission matrix in docs/guides/manifest.md).
//

#import <Foundation/Foundation.h>
#import <CarPWA/CarPWA.h>

NS_ASSUME_NONNULL_BEGIN

/// Registers car, screen, media, nav, location, input, ui, apps and system.
void CPWARegisterBuiltinModules(void);

CPWAModule *CPWAMakeCarModule(void);
CPWAModule *CPWAMakeScreenModule(void);
CPWAModule *CPWAMakeMediaModule(void);
CPWAModule *CPWAMakeNavModule(void);
CPWAModule *CPWAMakeLocationModule(void);
CPWAModule *CPWAMakeInputModule(void);
CPWAModule *CPWAMakeUIModule(void);
CPWAModule *CPWAMakeAppsModule(void);
CPWAModule *CPWAMakeSystemModule(void);

/// Called by CPWACarKit for the session's command callbacks.
void CPWACarModuleRemoteEvent(NSString *event, id _Nullable payload);
void CPWACarModuleOpenURL(NSURL *url);
/// Called when the navigating apps or the session may have changed.
void CPWANavModuleStateMayHaveChanged(void);

/// `reply(@YES, nil)`.
FOUNDATION_EXPORT void CPWAReplyTrue(CPWAReply reply);

NS_ASSUME_NONNULL_END
