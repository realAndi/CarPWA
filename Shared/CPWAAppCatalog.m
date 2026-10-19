//
//  CPWAAppCatalog.m
//

#import "CPWAAppCatalog.h"
#import "CPWALog.h"
#import <notify.h>
#import <rootless.h>

NSNotificationName const CPWAAppCatalogDidChangeNotification = @"CPWAAppCatalogDidChangeNotification";

static NSString *CPWAString(id value, NSString *fallback) {
    return [value isKindOfClass:[NSString class]] && [value length] ? value : fallback;
}

@implementation CPWAAppEntry

- (instancetype)initWithDictionary:(NSDictionary *)d {
    NSString *appID = CPWAString(d[@"id"], nil);
    NSURL *url = [NSURL URLWithString:CPWAString(d[@"url"], @"")];
    if (!appID || !url) return nil;
    if ((self = [super init])) {
        _appID = [appID copy];
        _name = [CPWAString(d[@"name"], appID) copy];
        _shortName = [CPWAString(d[@"shortName"], _name) copy];
        _version = [CPWAString(d[@"version"], @"0.0.0") copy];
        _url = url;
        _port = [d[@"port"] isKindOfClass:[NSNumber class]] ? [d[@"port"] integerValue] : url.port.integerValue;
        _sessionKey = [CPWAString(d[@"sessionKey"], @"") copy];
        _iconPath = [CPWAString(d[@"icon"], nil) copy];
        _path = [CPWAString(d[@"path"], @"") copy];
        NSArray *perms = [d[@"permissions"] isKindOfClass:[NSArray class]] ? d[@"permissions"] : @[];
        NSMutableSet *set = [NSMutableSet set];
        for (id p in perms) if ([p isKindOfClass:[NSString class]]) [set addObject:p];
        _permissions = [set copy];
        _backgroundColor = CPWAColorFromCSS(CPWAString(d[@"backgroundColor"], nil)) ?: UIColor.blackColor;
        _origin = [CPWAString(d[@"origin"], @"user") copy];
        _manifest = [d[@"manifest"] isKindOfClass:[NSDictionary class]] ? [d[@"manifest"] copy] : @{};
        _leafIdentifier = [@"carpwa." stringByAppendingString:appID];
    }
    return self;
}

@end

@implementation CPWAAppCatalog {
    NSData *_lastData;
    NSDictionary<NSString *, CPWAAppEntry *> *_byID;
    int _notifyToken;
}

+ (instancetype)sharedCatalog {
    static CPWAAppCatalog *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [[self alloc] init]; });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _apps = @[];
        _byID = @{};
        _controlPort = 47800;
        __weak typeof(self) weakSelf = self;
        notify_register_dispatch("com.andi.carpwa/apps-changed", &_notifyToken, dispatch_get_main_queue(), ^(int token) {
            [weakSelf reload];
        });
        [self reload];
    }
    return self;
}

+ (NSString *)registryPath {
    return ROOT_PATH_NS(@"/var/mobile/Library/CarPWA/run/apps.json");
}

- (void)reload {
    NSString *path = [CPWAAppCatalog registryPath];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) {
        CPWALog(@"no app registry at %@ (is carpwad running?)", path);
        data = [NSData data];
    }
    if ([data isEqualToData:_lastData ?: [NSData new]] && _lastData) return;
    _lastData = data;

    NSDictionary *json = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSMutableArray *apps = [NSMutableArray array];
    NSMutableDictionary *byID = [NSMutableDictionary dictionary];
    if ([json isKindOfClass:[NSDictionary class]]) {
        _devMode = [json[@"devMode"] respondsToSelector:@selector(boolValue)] ? [json[@"devMode"] boolValue] : NO;
        if ([json[@"controlPort"] isKindOfClass:[NSNumber class]]) _controlPort = [json[@"controlPort"] integerValue];
        NSArray *list = [json[@"apps"] isKindOfClass:[NSArray class]] ? json[@"apps"] : @[];
        for (NSDictionary *d in list) {
            if (![d isKindOfClass:[NSDictionary class]]) continue;
            CPWAAppEntry *entry = [[CPWAAppEntry alloc] initWithDictionary:d];
            if (!entry || byID[entry.appID]) continue;
            [apps addObject:entry];
            byID[entry.appID] = entry;
        }
    }
    _apps = [apps copy];
    _byID = [byID copy];
    CPWALog(@"catalog: %lu app(s)", (unsigned long)_apps.count);
    [[NSNotificationCenter defaultCenter] postNotificationName:CPWAAppCatalogDidChangeNotification object:self];
}

- (CPWAAppEntry *)appWithID:(NSString *)appID {
    return appID ? _byID[appID] : nil;
}

- (CPWAAppEntry *)appWithLeafIdentifier:(NSString *)leafIdentifier {
    if (![leafIdentifier hasPrefix:@"carpwa."]) return nil;
    return [self appWithID:[leafIdentifier substringFromIndex:7]];
}

@end

UIColor *CPWAColorFromCSS(NSString *css) {
    NSString *s = [[css stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] lowercaseString];
    if (s.length == 0) return nil;
    NSDictionary *names = @{
        @"black": UIColor.blackColor, @"white": UIColor.whiteColor, @"transparent": UIColor.clearColor,
        @"red": UIColor.redColor, @"green": UIColor.greenColor, @"blue": UIColor.blueColor,
        @"gray": UIColor.grayColor, @"grey": UIColor.grayColor,
    };
    if (names[s]) return names[s];
    if ([s hasPrefix:@"#"]) {
        NSString *hex = [s substringFromIndex:1];
        if (hex.length == 3 || hex.length == 4) {
            NSMutableString *expanded = [NSMutableString string];
            for (NSUInteger i = 0; i < hex.length; i++) {
                unichar c = [hex characterAtIndex:i];
                [expanded appendFormat:@"%C%C", c, c];
            }
            hex = expanded;
        }
        if (hex.length != 6 && hex.length != 8) return nil;
        unsigned long long value = 0;
        if (![[NSScanner scannerWithString:hex] scanHexLongLong:&value]) return nil;
        if (hex.length == 6) value = (value << 8) | 0xff;
        return [UIColor colorWithRed:((value >> 24) & 0xff) / 255.0
                               green:((value >> 16) & 0xff) / 255.0
                                blue:((value >> 8) & 0xff) / 255.0
                               alpha:(value & 0xff) / 255.0];
    }
    if ([s hasPrefix:@"rgb"]) {
        NSRange open = [s rangeOfString:@"("], close = [s rangeOfString:@")" options:NSBackwardsSearch];
        if (open.location == NSNotFound || close.location == NSNotFound || close.location <= open.location) return nil;
        NSString *inner = [s substringWithRange:NSMakeRange(NSMaxRange(open), close.location - NSMaxRange(open))];
        NSArray *parts = [inner componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@", /"]];
        NSMutableArray *numbers = [NSMutableArray array];
        for (NSString *p in parts) if (p.length) [numbers addObject:p];
        if (numbers.count < 3) return nil;
        CGFloat alpha = numbers.count > 3 ? [numbers[3] doubleValue] : 1.0;
        if (numbers.count > 3 && [numbers[3] hasSuffix:@"%"]) alpha /= 100.0;
        return [UIColor colorWithRed:[numbers[0] doubleValue] / 255.0
                               green:[numbers[1] doubleValue] / 255.0
                                blue:[numbers[2] doubleValue] / 255.0
                               alpha:alpha];
    }
    return nil;
}
