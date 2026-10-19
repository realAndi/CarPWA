//
//  CPWALaunch.h — opening CarPWA apps from DashBoard: they run in the
//  launcher app (CPWALauncher.h), which this asks DashBoard to bring forward.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Opens the app in the launcher on the car screen. NO when there is no
/// CarPlay session or the launcher is not installed.
BOOL CPWAOpenAppInLauncher(NSString *appID);

NS_ASSUME_NONNULL_END
