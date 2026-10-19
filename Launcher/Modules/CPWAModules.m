//
//  CPWAModules.m
//

#import "CPWAModules.h"

void CPWAReplyTrue(CPWAReply reply) {
    reply(@YES, nil);
}

void CPWARegisterBuiltinModules(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        CPWAModule *(*makers[])(void) = {
            CPWAMakeCarModule, CPWAMakeScreenModule, CPWAMakeMediaModule, CPWAMakeNavModule,
            CPWAMakeLocationModule, CPWAMakeInputModule, CPWAMakeUIModule, CPWAMakeAppsModule,
            CPWAMakeSystemModule,
        };
        for (size_t i = 0; i < sizeof(makers) / sizeof(makers[0]); i++) CPWARegisterModule(makers[i]());
    });
}
