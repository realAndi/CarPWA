//
//  CPWADashboardLink.m
//

#import "CPWADashboardLink.h"
#import "CPWALauncher.h"
#import "CPWALog.h"
#import <CarPWA/CarPWA.h>
#import <notify.h>

BOOL CPWADashboardRequest(NSDictionary *request, NSError **error) {
    NSMutableDictionary *body = [request mutableCopy];
    body[@"ts"] = @(floor([NSDate date].timeIntervalSince1970 * 1000));
    NSData *json = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    NSError *writeError;
    if (!json || ![json writeToFile:CPWADashboardRequestPath options:NSDataWritingAtomic error:&writeError]) {
        if (error) *error = CPWAMakeError(CPWAErrorUnavailable, @"cannot reach DashBoard: %@", writeError.localizedDescription ?: @"bad request");
        return NO;
    }
    notify_post(CPWADashboardRequestNotification);
    return YES;
}

void CPWADashboardLinkCheck(void) {
    NSString *dir = [CPWADashboardRequestPath stringByDeletingLastPathComponent];
    NSString *probe = [dir stringByAppendingPathComponent:@".launcher-write-check"];
    NSError *error;
    BOOL ok = [[NSData data] writeToFile:probe options:0 error:&error];
    if (ok) [[NSFileManager defaultManager] removeItemAtPath:probe error:nil];
    CPWALog(@"DashBoard requests %@ (%@)", ok ? @"can be written" : @"CANNOT be written", ok ? dir : error.localizedDescription);
}
