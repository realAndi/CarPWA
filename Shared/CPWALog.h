//
//  CPWALog.h — logging for the tweak and the launcher (subsystem
//  com.andi.carpwa, category "tweak" or "launcher", set by CPWA_LOG_CATEGORY).
//  View with Console.app, filtering on "carpwa".
//

#import <Foundation/Foundation.h>

void CPWALog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
