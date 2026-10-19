//
//  CPWACarState.m
//

#import "CPWACarState.h"
#import "CPWAHostViewController.h"
#import "CPWALog.h"
#import "CPWACarKit.h"
#import "CPWAPresenter.h"
#import <CarPWA/CarPWA.h>

/// KVC read that never throws: nil when the object lacks the property (or its is-getter).
static id CPWAGet(id object, NSString *key) {
    if (!object || key.length == 0) return nil;
    NSString *isKey = [@"is" stringByAppendingFormat:@"%@%@", [[key substringToIndex:1] uppercaseString], [key substringFromIndex:1]];
    if (![object respondsToSelector:NSSelectorFromString(key)] && ![object respondsToSelector:NSSelectorFromString(isKey)]) return nil;
    @try {
        return [object valueForKey:key];
    } @catch (NSException *e) {
        return nil;
    }
}

static BOOL CPWABool(id object, NSString *key, BOOL fallback) {
    id v = CPWAGet(object, key);
    return [v respondsToSelector:@selector(boolValue)] ? [v boolValue] : fallback;
}

static id CPWAStringOrNull(id value) {
    return [value isKindOfClass:[NSString class]] && [value length] ? value : [NSNull null];
}

static NSDictionary *CPWARect(CGRect r) {
    return @{ @"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height) };
}

static NSDictionary *CPWAInsets(UIEdgeInsets i) {
    return @{ @"top": @(i.top), @"left": @(i.left), @"bottom": @(i.bottom), @"right": @(i.right) };
}

static id CPWASize(id value) {
    if (![value isKindOfClass:[NSValue class]] || strcmp([value objCType], @encode(CGSize)) != 0) return [NSNull null];
    CGSize s = [value CGSizeValue];
    if (s.width <= 0 || s.height <= 0) return [NSNull null];
    return @{ @"width": @(s.width), @"height": @(s.height) };
}

// The interaction-model bits are not documented; this mapping is a guess
// (carpwa.d.ts passes the raw values through as interaction.raw).
static NSString *CPWAInteractionName(NSUInteger model) {
    switch (model) {
        case 1: return @"touch";
        case 2: return @"knob";
        case 4: return @"touchpad";
        default: return @"unknown";
    }
}

@implementation CPWACarState {
    NSDictionary *_state;
}

+ (instancetype)sharedState {
    static CPWACarState *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        shared = [CPWACarState new];
        [[NSNotificationCenter defaultCenter] addObserverForName:CPWACarKitSessionDidChangeNotification object:nil
                                                           queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            [shared update];
        }];
    });
    return shared;
}

- (CARSession *)session {
    return [CPWACarKit sharedCarKit].session;
}

- (CARScreenInfo *)mainScreen {
    NSArray *screens = CPWAGet(CPWAGet(self.session, @"configuration"), @"screens");
    if (![screens isKindOfClass:[NSArray class]]) return nil;
    for (id screen in screens) {
        if ([CPWAGet(screen, @"screenType") integerValue] == 0) return screen;
    }
    return screens.firstObject;
}

/// The area apps are drawn in: the launcher's car window (the whole screen;
/// CarPlay's sidebar is in its safe area).
- (UIView *)contentView {
    return [CPWAPresenter sharedPresenter].window;
}

#pragma mark State

- (NSDictionary *)state {
    return _state ?: [self disconnectedState];
}

- (NSDictionary *)disconnectedState {
    return @{
        @"connected": @NO, @"nightMode": @NO, @"appearance": @"dark", @"limitedUI": @NO,
        @"limitedUIElements": @{ @"keyboard": @NO, @"lists": @NO, @"raw": @0 },
        @"viewArea": [NSNull null], @"safeArea": CPWAInsets(UIEdgeInsetsZero),
        @"carOwnsScreen": [NSNull null], @"carOwnsMainAudio": [NSNull null], @"visible": @NO,
    };
}

- (NSDictionary *)computeState {
    CARSession *session = self.session;
    if (!session) return [self disconnectedState];
    CARScreenInfo *screen = self.mainScreen;
    UIView *content = self.contentView;

    NSNumber *night = CPWAGet(session, @"nightMode");
    BOOL nightMode = [night isKindOfClass:[NSNumber class]] ? night.boolValue : CPWABool(screen, @"nightMode", NO);

    // The car window's traits follow the car's appearance setting.
    NSString *appearance = content.traitCollection.userInterfaceStyle == UIUserInterfaceStyleLight ? @"light" : @"dark";

    NSNumber *limited = CPWAGet(session, @"limitUserInterfaces");
    BOOL limitedUI = [limited isKindOfClass:[NSNumber class]] ? limited.boolValue : CPWABool(screen, @"limitedUI", NO);
    // Bits as CarPlay sends them: soft keyboard, phone keypad, non-music lists, music lists, Japan maps.
    NSUInteger raw = [CPWAGet(screen, @"limitedUIElements") unsignedIntegerValue];
    if (raw == 0) raw = [CPWAGet(CPWAGet(session, @"configuration"), @"limitableUserInterfaces") unsignedIntegerValue];

    id viewArea = [NSNull null];
    UIEdgeInsets safe = UIEdgeInsetsZero;
    if (content) {
        viewArea = CPWARect(content.bounds);
        safe = content.safeAreaInsets;
    } else {
        // No car scene yet: CarKit's view area, which is in pixels.
        id area = CPWAGet(screen, @"currentViewArea");
        id frame = CPWAGet(area, @"visibleFrame");
        CGFloat scale = UIScreen.mainScreen.scale;
        for (UIScreen *s in UIScreen.screens) if (s != UIScreen.mainScreen) scale = s.scale;
        if ([frame isKindOfClass:[NSValue class]] && scale > 0) {
            CGRect r = [frame CGRectValue];
            viewArea = CPWARect(CGRectMake(r.origin.x / scale, r.origin.y / scale, r.size.width / scale, r.size.height / scale));
        }
    }

    id ownsScreen = [session respondsToSelector:@selector(carOwnsScreen)] ? @([session carOwnsScreen]) : [NSNull null];
    id ownsAudio = [session respondsToSelector:@selector(carOwnsMainAudio)] ? @([session carOwnsMainAudio]) : [NSNull null];

    return @{
        @"connected": @YES,
        @"nightMode": @(nightMode),
        @"appearance": appearance,
        @"limitedUI": @(limitedUI),
        @"limitedUIElements": @{ @"keyboard": @((raw & 0x3) != 0), @"lists": @((raw & 0xC) != 0), @"raw": @(raw) },
        @"viewArea": viewArea,
        @"safeArea": CPWAInsets(safe),
        @"carOwnsScreen": ownsScreen,
        @"carOwnsMainAudio": ownsAudio,
        @"visible": @([CPWAPresenter sharedPresenter].visibleHost != nil && [CPWAPresenter sharedPresenter].onScreen),
    };
}

- (void)update {
    NSDictionary *old = self.state;
    NSDictionary *now = [self computeState];
    NSMutableArray *changed = [NSMutableArray array];
    for (NSString *key in now) {
        if (![now[key] isEqual:old[key]]) [changed addObject:key];
    }
    if (_state && changed.count == 0) return;
    _state = now;
    if (changed.count) CPWAPublishCarState(now, [changed sortedArrayUsingSelector:@selector(compare:)]);
}

- (NSDictionary *)stateForHost:(CPWAHostViewController *)host {
    NSMutableDictionary *state = [self.state mutableCopy];
    state[@"visible"] = @(host != nil && host.isOnScreen);
    if (host.isViewLoaded && host.view.window) state[@"safeArea"] = CPWAInsets(host.contentSafeArea);
    return state;
}

#pragma mark Info

- (NSDictionary *)carInfoIncludingSerialNumber:(BOOL)serial {
    CARSession *session = self.session;
    CARSessionConfiguration *c = CPWAGet(session, @"configuration");
    NSMutableArray *fuel = [NSMutableArray array];
    if (CPWABool(c, @"vehicleSupportsGasoline", NO)) [fuel addObject:@"gasoline"];
    if (CPWABool(c, @"vehicleSupportsDiesel", NO)) [fuel addObject:@"diesel"];
    if (CPWABool(c, @"vehicleSupportsElectric", NO)) [fuel addObject:@"electric"];
    if (CPWABool(c, @"vehicleSupportsCNG", NO)) [fuel addObject:@"cng"];

    // CarKit's transport types: 1 USB, 2 wireless (Wi-Fi).
    NSUInteger transportType = [CPWAGet(c, @"transportType") unsignedIntegerValue];
    NSString *transport = transportType == 1 ? @"wired" : transportType == 2 ? @"wireless" : @"unknown";

    NSMutableArray *displays = [NSMutableArray array];
    NSArray *list = CPWAGet(c, @"displays");
    for (id d in [list isKindOfClass:[NSArray class]] ? list : @[]) {
        [displays addObject:@{
            @"id": CPWAStringOrNull(CPWAGet(d, @"identifier")),
            @"pixelSize": CPWASize(CPWAGet(d, @"pixelSize")),
            @"physicalSize": CPWASize(CPWAGet(d, @"physicalSize")),
            @"carPlay": @(CPWABool(d, @"supportsCarPlayContent", NO)),
            @"instrumentCluster": @(CPWABool(d, @"supportsInstrumentClusterContent", NO)),
        }];
    }

    NSMutableDictionary *info = [@{
        @"connected": @(session != nil),
        @"name": CPWAStringOrNull(CPWAGet(c, @"vehicleName") ?: CPWAGet(c, @"name")),
        @"model": CPWAStringOrNull(CPWAGet(c, @"vehicleModelName") ?: CPWAGet(c, @"modelName")),
        @"manufacturer": CPWAStringOrNull(CPWAGet(c, @"vehicleManufacturer") ?: CPWAGet(c, @"manufacturerName")),
        @"firmwareVersion": CPWAStringOrNull(CPWAGet(c, @"vehicleFirmwareVersion")),
        @"hardwareVersion": CPWAStringOrNull(CPWAGet(c, @"vehicleHardwareVersion")),
        @"fuelTypes": fuel,
        @"rightHandDrive": @(CPWABool(c, @"rightHandDrive", NO)),
        @"transport": transport,
        @"supportsACBack": @(CPWABool(c, @"supportsACBack", NO)),
        @"supportsNightMode": @(CPWABool(c, @"nightModeSupported", NO)),
        @"supportsElectronicTollCollection": @(CPWABool(c, @"supportsElectronicTollCollection", NO)),
        @"supportsDestinationSharing": @(CPWABool(c, @"vehicleSupportsDestinationSharing", NO)),
        @"displays": displays,
    } mutableCopy];
    if (serial) info[@"serialNumber"] = CPWAStringOrNull(CPWAGet(c, @"vehicleSerialNumber"));
    return info;
}

- (NSDictionary *)screenInfoForHost:(CPWAHostViewController *)host {
    CARScreenInfo *screen = self.mainScreen;
    UIView *area = host.isViewLoaded ? host.view : self.contentView;
    CGSize size = area.bounds.size;
    UIEdgeInsets safe = host.isViewLoaded ? host.contentSafeArea : area.safeAreaInsets;
    CGFloat scale = area.window.screen.scale ?: 1;

    NSUInteger available = [CPWAGet(screen, @"availableInteractionModels") unsignedIntegerValue];
    NSUInteger primary = [CPWAGet(screen, @"primaryInteractionModel") unsignedIntegerValue];
    id pixel = CPWASize(CPWAGet(screen, @"pixelSize"));
    id physical = CPWASize(CPWAGet(screen, @"physicalSize"));
    NSNumber *fps = CPWAGet(screen, @"maxFramesPerSecond");

    return @{
        @"id": CPWAStringOrNull(CPWAGet(screen, @"identifier")),
        @"width": @(size.width),
        @"height": @(size.height),
        @"scale": @(scale),
        @"pixelWidth": pixel != [NSNull null] ? pixel[@"width"] : [NSNull null],
        @"pixelHeight": pixel != [NSNull null] ? pixel[@"height"] : [NSNull null],
        @"physicalWidthMM": physical != [NSNull null] ? physical[@"width"] : [NSNull null],
        @"physicalHeightMM": physical != [NSNull null] ? physical[@"height"] : [NSNull null],
        @"maxFPS": fps.unsignedIntegerValue ? fps : [NSNull null],
        @"safeArea": CPWAInsets(safe),
        @"interaction": @{
            @"primary": CPWAInteractionName(primary),
            @"touch": @((available & 1) != 0),
            @"knob": @((available & 2) != 0),
            @"touchpad": @((available & 4) != 0),
            @"highFidelityTouch": @(CPWABool(screen, @"supportsHighFidelityTouch", NO)),
            @"raw": @{ @"available": @(available), @"primary": @(primary) },
        },
    };
}

@end
