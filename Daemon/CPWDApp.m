//
//  CPWDApp.m
//

#import "CPWDApp.h"
#import "CPWDCore.h"
#import "CPWDManifest.h"
#import "CPWDStorage.h"
#import <sys/stat.h>

static const NSUInteger CPWDAppServerThreads = 8;

@implementation CPWDApp {
    CPWDServer *_server;
    NSMutableArray<CPWDClient *> *_clients;
}

- (instancetype)initWithManifest:(CPWDManifest *)manifest path:(NSString *)path origin:(NSString *)origin
                            port:(uint16_t)port sessionKey:(NSString *)sessionKey {
    if ((self = [super init])) {
        _appID = [manifest.appID copy];
        _manifest = manifest;
        _path = [path copy];
        _origin = [origin copy];
        _port = port;
        _sessionKey = [sessionKey copy];
        _storage = [CPWDStorage storageForAppID:_appID];
        _clients = [NSMutableArray array];
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<app %@ :%u %@>", _appID, _port, _origin];
}

- (BOOL)start {
    if (_server) return YES;
    CPWDServer *server = [[CPWDServer alloc] initWithName:_appID port:_port webSocketPath:@"/_carpwa/ws"];
    server.delegate = self;
    server.threadCount = CPWDAppServerThreads;
    server.maxBodySize = 1u << 20;   // pages only GET; keep stray uploads small
    if (![server start]) return NO;
    _server = server;
    return YES;
}

- (BOOL)isRunning {
    return _server != nil;
}

- (void)stop {
    for (CPWDClient *client in [_clients copy]) [client close];
    [_server stopAsync];
    _server = nil;
}

- (NSArray<CPWDClient *> *)clients {
    return [_clients copy];
}

- (NSString *)originURL {
    return [NSString stringWithFormat:@"http://127.0.0.1:%u", _port];
}

- (NSString *)startURLString {
    return [NSString stringWithFormat:@"%@/%@", self.originURL, _manifest.startURL];
}

- (NSString *)iconPath {
    NSString *icon = [_path stringByAppendingPathComponent:_manifest.icon];
    BOOL dir = NO;
    return [[NSFileManager defaultManager] fileExistsAtPath:icon isDirectory:&dir] && !dir ? icon : nil;
}

#pragma mark Entries

- (NSDictionary *)listEntry {
    return @{ @"id": _appID, @"name": _manifest.name, @"version": _manifest.version,
              @"port": @(_port), @"url": self.startURLString };
}

- (NSDictionary *)controlEntry {
    NSMutableDictionary *entry = [self.listEntry mutableCopy];
    entry[@"origin"] = _origin;
    entry[@"path"] = _path;
    return entry;
}

- (NSDictionary *)registryEntry {
    CPWDManifest *m = _manifest;
    return @{
        @"id": _appID,
        @"name": m.name,
        @"shortName": m.shortName,
        @"version": m.version,
        @"port": @(_port),
        @"url": self.startURLString,
        @"sessionKey": _sessionKey,
        @"icon": self.iconPath ?: [NSNull null],
        @"path": _path,
        @"permissions": m.permissions,
        @"backgroundColor": m.backgroundColor,
        @"origin": _origin,
        @"manifest": m.dictionary,
    };
}

#pragma mark Pages

- (NSUInteger)reloadPagesWithReason:(NSString *)reason {
    NSUInteger n = 0;
    for (CPWDClient *client in _clients) {
        [client sendEvent:@"reload" module:@"dev" data:@{ @"reason": reason ?: @"reload" }];
        n++;
    }
    return n;
}

- (void)broadcastEvent:(NSString *)event module:(NSString *)module data:(id)data except:(CPWDClient *)except {
    for (CPWDClient *client in _clients) {
        if (client != except) [client sendEvent:event module:module data:data];
    }
}

- (void)clientDidClose:(CPWDClient *)client {
    [_clients removeObject:client];
}

#pragma mark CPWDServerDelegate

// DNS-rebinding guard: a page from another site that re-points its own
// hostname at 127.0.0.1 still sends its hostname in Host.
static BOOL CPWDLoopbackHost(NSString *host) {
    if (host.length == 0) return YES;   // HTTP/1.0
    NSString *name = host.lowercaseString;
    NSRange colon = [name rangeOfString:@":" options:NSBackwardsSearch];
    if (colon.location != NSNotFound && ![name hasSuffix:@"]"]) name = [name substringToIndex:colon.location];
    return [name isEqualToString:@"127.0.0.1"] || [name isEqualToString:@"localhost"];
}

- (BOOL)server:(CPWDServer *)server shouldAcceptSocket:(CPWDSocket *)socket {
    CPWDRequest *request = socket.request;
    NSString *origin = [request header:@"origin"];
    NSString *expected1 = [NSString stringWithFormat:@"http://127.0.0.1:%u", _port];
    NSString *expected2 = [NSString stringWithFormat:@"http://localhost:%u", _port];
    if (!CPWDLoopbackHost([request header:@"host"]) || !([origin isEqualToString:expected1] || [origin isEqualToString:expected2])) {
        CPWDLog(@"%@: refused a socket from origin %@", _appID, origin ?: @"(none)");
        return NO;
    }
    NSString *key = request.query[@"key"];
    NSString *devToken = request.query[@"devtoken"];
    BOOL developer = NO;
    if (key && CPWDSecureEquals(key, _sessionKey)) {
        developer = NO;
    } else if (devToken && CPWDSecureEquals(devToken, CPWDDevToken())) {
        developer = YES;
    } else {
        CPWDLog(@"%@: refused a socket with a %@", _appID, key || devToken ? @"wrong key" : @"missing key");
        return NO;
    }
    CPWDClient *client = [[CPWDClient alloc] initWithSocket:socket app:self developer:developer owner:self];
    [_clients addObject:client];
    return YES;
}

- (CPWDResponse *)server:(CPWDServer *)server handleRequest:(CPWDRequest *)request {
    if (!CPWDLoopbackHost([request header:@"host"])) {
        return [CPWDResponse status:403 text:@"CarPWA apps only answer http://127.0.0.1 and http://localhost\n"];
    }
    if (![request.method isEqualToString:@"GET"] && ![request.method isEqualToString:@"HEAD"]) {
        CPWDResponse *r = [CPWDResponse status:405 text:@"Method not allowed\n"];
        r.headers[@"Allow"] = @"GET, HEAD";
        return r;
    }
    NSString *path = request.path;
    if ([path hasPrefix:@"/_carpwa/"] || [path isEqualToString:@"/_carpwa"]) return [self carpwaResponse:request];
    return [self staticResponse:request];
}

#pragma mark /_carpwa/

- (CPWDResponse *)carpwaResponse:(CPWDRequest *)request {
    NSString *path = request.path;
    NSString *sdk = CPWDSDKDir();
    if ([path isEqualToString:@"/_carpwa/sdk.js"]) return [self sdkFile:[sdk stringByAppendingPathComponent:@"carpwa.js"] type:@"text/javascript; charset=utf-8"];
    if ([path isEqualToString:@"/_carpwa/carpwa.css"]) return [self sdkFile:[sdk stringByAppendingPathComponent:@"carpwa.css"] type:@"text/css; charset=utf-8"];
    if ([path isEqualToString:@"/_carpwa/carpwa.d.ts"]) return [self sdkFile:[sdk stringByAppendingPathComponent:@"carpwa.d.ts"] type:@"text/plain; charset=utf-8"];
    if ([path isEqualToString:@"/_carpwa/sdk.mjs"]) {
        NSData *js = [NSData dataWithContentsOfFile:[sdk stringByAppendingPathComponent:@"carpwa.js"]];
        if (!js) return [CPWDResponse status:404 text:@"CarPWA SDK is not installed\n"];
        NSMutableData *module = [js mutableCopy];
        [module appendData:[@"\nexport default globalThis.CarPWA;\n" dataUsingEncoding:NSUTF8StringEncoding]];
        return [CPWDResponse status:200 data:module type:@"text/javascript; charset=utf-8"];
    }
    if ([path isEqualToString:@"/_carpwa/manifest"]) return [CPWDResponse status:200 json:_manifest.dictionary];
    if ([path isEqualToString:@"/_carpwa/health"]) return [CPWDResponse status:200 json:@{ @"ok": @YES, @"version": CPWD_VERSION, @"app": _appID }];
    if ([path isEqualToString:@"/_carpwa/ws"]) return [CPWDResponse status:400 text:@"WebSocket only\n"];
    return [CPWDResponse status:404 text:[NSString stringWithFormat:@"Not found: %@\n", path]];
}

- (CPWDResponse *)sdkFile:(NSString *)file type:(NSString *)type {
    if (![[NSFileManager defaultManager] fileExistsAtPath:file]) {
        return [CPWDResponse status:404 text:@"CarPWA SDK is not installed\n"];
    }
    return [CPWDResponse file:file type:type];
}

#pragma mark Static files

/// The file for a URL path, following the same rules as `carpwa sim`.
typedef NS_ENUM(NSInteger, CPWDLookup) { CPWDLookupNone, CPWDLookupFile, CPWDLookupRedirect };

- (CPWDLookup)lookup:(NSString *)urlPath file:(NSString **)file {
    NSString *root = _path;
    NSString *rel = [urlPath stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    NSString *candidate = root;
    if (rel.length) {
        NSString *clean = CPWDCleanRelativePath(rel);
        if (!clean) return CPWDLookupNone;
        candidate = [root stringByAppendingPathComponent:clean];
    }
    struct stat st;
    if (stat(candidate.fileSystemRepresentation, &st) != 0) return CPWDLookupNone;
    if (S_ISDIR(st.st_mode)) {
        NSString *index = [candidate stringByAppendingPathComponent:@"index.html"];
        if (stat(index.fileSystemRepresentation, &st) != 0 || !S_ISREG(st.st_mode)) return CPWDLookupNone;
        if (rel.length && ![urlPath hasSuffix:@"/"]) return CPWDLookupRedirect;
        candidate = index;
    } else if (!S_ISREG(st.st_mode)) {
        return CPWDLookupNone;
    }
    // Symlinks must not lead out of the app folder.
    char resolved[PATH_MAX], rootResolved[PATH_MAX];
    if (!realpath(candidate.fileSystemRepresentation, resolved) || !realpath(root.fileSystemRepresentation, rootResolved)) {
        return CPWDLookupNone;
    }
    size_t rootLen = strlen(rootResolved);
    if (strncmp(resolved, rootResolved, rootLen) != 0 || (resolved[rootLen] != '/' && resolved[rootLen] != '\0')) {
        return CPWDLookupNone;
    }
    *file = candidate;
    return CPWDLookupFile;
}

static BOOL CPWDWantsDocument(CPWDRequest *request) {
    NSString *accept = [request header:@"accept"] ?: @"";
    return [accept rangeOfString:@"text/html"].location != NSNotFound ||
           [request.path.lastPathComponent rangeOfString:@"."].location == NSNotFound;
}

- (CPWDResponse *)staticResponse:(CPWDRequest *)request {
    NSString *file = nil;
    CPWDLookup found = [self lookup:request.path file:&file];
    if (found == CPWDLookupRedirect) {
        CPWDResponse *r = [CPWDResponse status:301 text:@""];
        NSMutableString *location = [[request.path stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet] mutableCopy];
        [location appendString:@"/"];
        NSString *query = [self rawQuery:request];
        if (query.length) [location appendFormat:@"?%@", query];
        r.headers[@"Location"] = location;
        return r;
    }
    BOOL root = [request.path isEqualToString:@"/"];
    if (found == CPWDLookupNone && (root || (_manifest.spa && CPWDWantsDocument(request)))) {
        found = [self lookup:[@"/" stringByAppendingString:_manifest.startPath] file:&file];
        if (found == CPWDLookupRedirect) found = [self lookup:[NSString stringWithFormat:@"/%@/", _manifest.startPath] file:&file];
    }
    if (found != CPWDLookupFile) {
        return [CPWDResponse status:404 text:[NSString stringWithFormat:@"Not found: %@\n", request.path]];
    }
    return [CPWDResponse file:file type:CPWDMIMEType(file)];
}

- (NSString *)rawQuery:(CPWDRequest *)request {
    NSMutableArray *pairs = [NSMutableArray array];
    NSCharacterSet *allowed = NSCharacterSet.URLQueryAllowedCharacterSet;
    for (NSString *key in [request.query.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        [pairs addObject:[NSString stringWithFormat:@"%@=%@", [key stringByAddingPercentEncodingWithAllowedCharacters:allowed],
                          [request.query[key] stringByAddingPercentEncodingWithAllowedCharacters:allowed]]];
    }
    return [pairs componentsJoinedByString:@"&"];
}

@end
