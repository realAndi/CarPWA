//
//  CPWADisplayLink.m
//

#import "CPWADisplayLink.h"
#import "CPWALog.h"
#import "CPWAPresenter.h"
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static IMP gOriginal;
static BOOL gInside;   // main thread only: UIScreen may build its link with the method we replace

static UIScreen *CPWACarScreen(void) {
    UIScreen *screen = [CPWAPresenter sharedPresenter].window.screen;
    if (screen && screen != UIScreen.mainScreen) return screen;
    for (UIScreen *s in UIScreen.screens) if (s != UIScreen.mainScreen) return s;
    return nil;
}

static CADisplayLink *CPWADisplayLinkWithTarget(id self, SEL _cmd, id target, SEL selector) {
    UIScreen *car = (!gInside && [NSThread isMainThread]) ? CPWACarScreen() : nil;
    if (car) {
        gInside = YES;
        CADisplayLink *link = [car displayLinkWithTarget:target selector:selector];
        gInside = NO;
        if (link) return link;
    }
    return ((CADisplayLink *(*)(id, SEL, id, SEL))gOriginal)(self, _cmd, target, selector);
}

void CPWAInstallCarDisplayLinks(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Method method = class_getClassMethod([CADisplayLink class], @selector(displayLinkWithTarget:selector:));
        if (!method) {
            CPWALog(@"+[CADisplayLink displayLinkWithTarget:selector:] is missing; pages may freeze while the phone is locked");
            return;
        }
        gOriginal = method_setImplementation(method, (IMP)CPWADisplayLinkWithTarget);
    });
}
