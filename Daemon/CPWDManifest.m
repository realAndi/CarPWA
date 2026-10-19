//
//  CPWDManifest.m
//

#import "CPWDManifest.h"
#import "CPWDCore.h"

static BOOL CPWDMatches(NSString *pattern, NSString *string) {
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    return string && [re firstMatchInString:string options:0 range:NSMakeRange(0, string.length)] != nil;
}

static NSString *CPWDTrimmed(id value) {
    if (![value isKindOfClass:[NSString class]]) return nil;
    NSString *s = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return s.length ? s : nil;
}

NSComparisonResult CPWDCompareVersions(NSString *a, NSString *b) {
    NSArray *pa = [a componentsSeparatedByString:@"."], *pb = [b componentsSeparatedByString:@"."];
    for (NSUInteger i = 0; i < MAX(pa.count, pb.count); i++) {
        NSInteger x = i < pa.count ? [pa[i] integerValue] : 0;
        NSInteger y = i < pb.count ? [pb[i] integerValue] : 0;
        if (x != y) return x < y ? NSOrderedAscending : NSOrderedDescending;
    }
    return NSOrderedSame;
}

@implementation CPWDManifest

+ (NSArray<NSString *> *)knownPermissions {
    return @[ @"media", @"media.control", @"location", @"network", @"navigation",
              @"vehicle.identity", @"car.raw", @"apps.launch" ];
}

+ (BOOL)isValidAppID:(NSString *)appID {
    if (![appID isKindOfClass:[NSString class]]) return NO;
    return CPWDMatches(@"^[A-Za-z0-9.-]{1,128}$", appID) && !CPWDMatches(@"^\\.+$", appID);
}

+ (instancetype)manifestWithData:(NSData *)data error:(NSString **)error {
    NSError *jsonError = nil;
    id json = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError] : nil;
    if (![json isKindOfClass:[NSDictionary class]]) {
        if (error) *error = json ? @"carpwa.json must contain a JSON object"
                                 : [NSString stringWithFormat:@"carpwa.json is not valid JSON (%@)",
                                    jsonError.localizedDescription ?: @"empty file"];
        return nil;
    }
    NSDictionary *raw = json;
    NSString *appID = raw[@"id"];
    if (![self isValidAppID:appID]) {
        if (error) *error = appID ? [NSString stringWithFormat:@"\"id\" %@ may only use letters, digits, \".\" and \"-\" (1-128 characters)", raw[@"id"]]
                                  : @"\"id\" is required";
        return nil;
    }
    NSString *name = CPWDTrimmed(raw[@"name"]);
    if (!name) {
        if (error) *error = @"\"name\" is required";
        return nil;
    }
    NSString *minCarPWA = nil;
    if (raw[@"min_carpwa"]) {
        minCarPWA = CPWDTrimmed(raw[@"min_carpwa"]);
        if (minCarPWA && CPWDMatches(@"^\\d+(\\.\\d+)*$", minCarPWA) &&
            CPWDCompareVersions(minCarPWA, CPWD_VERSION) == NSOrderedDescending) {
            if (error) *error = [NSString stringWithFormat:@"needs CarPWA %@ or newer (this is %@)", minCarPWA, CPWD_VERSION];
            return nil;
        }
    }
    CPWDManifest *m = [CPWDManifest new];
    [m parse:raw appID:appID name:name minCarPWA:minCarPWA];
    return m;
}

- (void)parse:(NSDictionary *)raw appID:(NSString *)appID name:(NSString *)name minCarPWA:(NSString *)minCarPWA {
    NSMutableArray *warnings = [NSMutableArray array];
    _appID = [appID copy];
    _name = [name copy];
    _minCarPWA = [minCarPWA copy];

    _shortName = CPWDTrimmed(raw[@"short_name"]) ?: name;
    if (raw[@"short_name"] && !CPWDTrimmed(raw[@"short_name"])) [warnings addObject:@"\"short_name\" must be a non-empty string"];

    _version = CPWDTrimmed(raw[@"version"]) ?: @"0.0.0";
    if (raw[@"version"] && !CPWDTrimmed(raw[@"version"])) [warnings addObject:@"\"version\" must be a string"];

    // start_url: a path inside the app folder, optionally with ?query/#hash.
    _startURL = @"index.html";
    _startPath = @"index.html";
    NSString *start = CPWDTrimmed(raw[@"start_url"]);
    if (raw[@"start_url"]) {
        while ([start hasPrefix:@"./"]) start = [start substringFromIndex:2];
        while ([start hasPrefix:@"/"] && ![start hasPrefix:@"//"]) start = [start substringFromIndex:1];
        NSString *path = [start componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"?#"]].firstObject;
        if (!start || CPWDMatches(@"^[A-Za-z][A-Za-z0-9+.-]*:", start) || [start hasPrefix:@"//"]) {
            [warnings addObject:@"\"start_url\" must be a path relative to the app folder; using index.html"];
        } else if (path.length == 0) {
            _startURL = [@"index.html" stringByAppendingString:start];
        } else if (!CPWDCleanRelativePath(path)) {
            [warnings addObject:@"\"start_url\" points outside the app folder; using index.html"];
        } else {
            _startURL = [start copy];
            _startPath = [path copy];
        }
    }

    NSString *icon = CPWDTrimmed(raw[@"icon"]);
    while ([icon hasPrefix:@"./"]) icon = [icon substringFromIndex:2];
    _icon = CPWDCleanRelativePath(icon) ?: @"icon.png";
    if (raw[@"icon"] && !CPWDCleanRelativePath(icon)) [warnings addObject:@"\"icon\" must be a path inside the app folder; using icon.png"];

    _backgroundColor = CPWDTrimmed(raw[@"background_color"]) ?: @"#000000";

    _spa = [raw[@"spa"] isKindOfClass:[NSNumber class]] && [raw[@"spa"] boolValue];
    if (raw[@"spa"] && ![raw[@"spa"] isKindOfClass:[NSNumber class]]) [warnings addObject:@"\"spa\" must be true or false"];

    NSMutableOrderedSet *permissions = [NSMutableOrderedSet orderedSet];
    NSArray *known = [CPWDManifest knownPermissions];
    if ([raw[@"permissions"] isKindOfClass:[NSArray class]]) {
        for (id p in raw[@"permissions"]) {
            if ([p isKindOfClass:[NSString class]] && [known containsObject:p]) [permissions addObject:p];
            else [warnings addObject:[NSString stringWithFormat:@"unknown permission %@ ignored", p]];
        }
    } else if (raw[@"permissions"]) {
        [warnings addObject:@"\"permissions\" must be an array of strings"];
    }
    _permissions = permissions.array;

    NSMutableOrderedSet *allow = [NSMutableOrderedSet orderedSet];
    NSDictionary *network = [raw[@"network"] isKindOfClass:[NSDictionary class]] ? raw[@"network"] : nil;
    if ([network[@"allow"] isKindOfClass:[NSArray class]]) {
        for (id h in network[@"allow"]) {
            NSString *host = [CPWDTrimmed(h) lowercaseString];
            if (host && CPWDMatches(@"^(\\*\\.)?([a-z0-9-]+\\.)*[a-z0-9-]+$", host)) [allow addObject:host];
            else [warnings addObject:[NSString stringWithFormat:@"\"network.allow\" entry %@ is not a host name; ignored", h]];
        }
    }
    _networkAllow = allow.array;

    _warnings = [warnings copy];

    NSMutableDictionary *dict = [raw mutableCopy];
    dict[@"id"] = _appID;
    dict[@"name"] = _name;
    dict[@"short_name"] = _shortName;
    dict[@"version"] = _version;
    dict[@"start_url"] = _startURL;
    dict[@"startPath"] = _startPath;
    dict[@"icon"] = _icon;
    dict[@"background_color"] = _backgroundColor;
    dict[@"spa"] = @(_spa);
    dict[@"permissions"] = _permissions;
    NSMutableDictionary *net = [network mutableCopy] ?: [NSMutableDictionary dictionary];
    net[@"allow"] = _networkAllow;
    dict[@"network"] = net;
    dict[@"min_carpwa"] = _minCarPWA ?: [NSNull null];
    _dictionary = [dict copy];
}

- (BOOL)hasPermission:(NSString *)permission {
    return [_permissions containsObject:permission];
}

- (BOOL)allowsHost:(NSString *)host {
    host = host.lowercaseString;
    while ([host hasSuffix:@"."]) host = [host substringToIndex:host.length - 1];
    if (host.length == 0) return NO;
    for (NSString *pattern in _networkAllow) {
        if ([pattern hasPrefix:@"*."]) {
            NSString *base = [pattern substringFromIndex:2];
            if ([host hasSuffix:[@"." stringByAppendingString:base]] && host.length > base.length + 1) return YES;
        } else if ([host isEqualToString:pattern]) {
            return YES;
        }
    }
    return NO;
}

@end
