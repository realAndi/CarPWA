//
//  CPWADashboardLink.h — asks the tweak in CarPlay.app for what only
//  DashBoard can do (CPWALauncher.h): launch another CarPlay app, open a URL
//  the way the car would, go to the home screen. Fire and forget.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// `request`: { action, bundleId?, url? }; the timestamp is added here.
/// NO (with an EUNAVAILABLE error) when the request could not be handed over.
BOOL CPWADashboardRequest(NSDictionary *request, NSError **error);

/// Logs once whether requests can be written (the launcher is sandboxed).
void CPWADashboardLinkCheck(void);

NS_ASSUME_NONNULL_END
