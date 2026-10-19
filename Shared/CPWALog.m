//
//  CPWALog.m
//

#import "CPWALog.h"
#import <os/log.h>

#ifndef CPWA_LOG_CATEGORY
#define CPWA_LOG_CATEGORY "tweak"
#endif

void CPWALog(NSString *format, ...) {
    static os_log_t log;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create("com.andi.carpwa", CPWA_LOG_CATEGORY); });
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    os_log(log, "%{public}@", message);
}
