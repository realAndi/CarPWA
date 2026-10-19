//
//  CPWDControl.m
//
//  A push is three requests (see sync.js in the CLI):
//    sync    the CLI sends { path: sha1 } for every file; we answer which
//            paths we need and which of ours it no longer has.
//    PUT     each needed file lands in run/staging/<id>/, never in the app.
//    commit  deletes the removed paths, moves the staged files into the app
//            folder, and rescans. The app only changes here, so a push that
//            dies halfway leaves the old version intact.
//

#import "CPWDControl.h"
#import "CPWDApp.h"
#import "CPWDCore.h"
#import "CPWDManifest.h"
#import "CPWDRegistry.h"
#import <CommonCrypto/CommonDigest.h>
#import <sys/stat.h>

static const NSUInteger CPWDMaxSyncFiles = 20000;

@interface CPWDFileHash : NSObject
@property (nonatomic) off_t size;
@property (nonatomic) struct timespec mtime;
@property (nonatomic, copy) NSString *sha1;
@end

@implementation CPWDFileHash
@end

@implementation CPWDControl {
    uint16_t _port;
    CPWDServer *_server;
    NSMutableArray<CPWDClient *> *_tools;
    NSMutableDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *_expected;   // id → hashes from the last sync
    NSMutableDictionary<NSString *, CPWDFileHash *> *_hashes;                           // absolute path → cached hash
}

- (instancetype)initWithPort:(uint16_t)port {
    if ((self = [super init])) {
        _port = port;
        _tools = [NSMutableArray array];
        _expected = [NSMutableDictionary dictionary];
        _hashes = [NSMutableDictionary dictionary];
    }
    return self;
}

- (BOOL)start {
    _server = [[CPWDServer alloc] initWithName:@"control" port:_port webSocketPath:@"/_carpwa/ws"];
    _server.delegate = self;
    _server.threadCount = 12;   // the CLI uploads four files at a time, and tools keep sockets open
    return [_server start];
}

static NSString *CPWDStagingDir(NSString *appID) {
    return [[CPWDRunDir() stringByAppendingPathComponent:@"staging"] stringByAppendingPathComponent:appID];
}

static CPWDResponse *CPWDError(NSInteger status, NSString *code, NSString *format, ...) NS_FORMAT_FUNCTION(3, 4);
static CPWDResponse *CPWDError(NSInteger status, NSString *code, NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    return [CPWDResponse status:status code:code message:message];
}

#pragma mark CPWDServerDelegate

- (BOOL)server:(CPWDServer *)server shouldAcceptSocket:(CPWDSocket *)socket {
    CPWDRequest *request = socket.request;
    NSString *origin = [request header:@"origin"];
    if (origin && !([origin hasPrefix:@"http://127.0.0.1:"] || [origin hasPrefix:@"http://localhost:"] ||
                    [origin isEqualToString:@"http://127.0.0.1"] || [origin isEqualToString:@"http://localhost"])) {
        CPWDLog(@"control: refused a tool socket from origin %@", origin);
        return NO;
    }
    if (!CPWDSecureEquals(request.query[@"devtoken"], CPWDDevToken())) {
        CPWDLog(@"control: refused a tool socket with a %@ dev token", request.query[@"devtoken"] ? @"wrong" : @"missing");
        return NO;
    }
    [_tools addObject:[[CPWDClient alloc] initWithSocket:socket app:nil developer:YES owner:self]];
    return YES;
}

- (void)clientDidClose:(CPWDClient *)client {
    [_tools removeObject:client];
}

- (CPWDResponse *)server:(CPWDServer *)server handleRequest:(CPWDRequest *)request {
    NSString *path = request.path;
    NSString *method = request.method;
    if ([path isEqualToString:@"/_carpwa/health"]) {
        return [CPWDResponse status:200 json:@{ @"ok": @YES, @"version": CPWD_VERSION }];
    }
    if (!CPWDSecureEquals([request header:@"x-carpwa-token"], CPWDDevToken())) {
        return CPWDError(401, @"EPERM", @"%@ X-CarPWA-Token header", [request header:@"x-carpwa-token"] ? @"wrong" : @"missing");
    }
    CPWDRegistry *registry = [CPWDRegistry sharedRegistry];

    if ([path isEqualToString:@"/_carpwa/apps"]) {
        if (![method isEqualToString:@"GET"]) return CPWDError(405, @"EINVAL", @"use GET");
        return [CPWDResponse status:200 json:[self appList]];
    }
    if ([path isEqualToString:@"/_carpwa/dev/rescan"]) {
        if (![method isEqualToString:@"POST"]) return CPWDError(405, @"EINVAL", @"use POST");
        [registry rescan];
        return [CPWDResponse status:200 json:[self appList]];
    }

    NSString *prefix = @"/_carpwa/dev/apps/";
    if (![path hasPrefix:prefix]) return CPWDError(404, @"ENOTFOUND", @"no route %@ %@", method, path);
    NSString *rest = [path substringFromIndex:prefix.length];
    NSRange slash = [rest rangeOfString:@"/"];
    NSString *appID = slash.location == NSNotFound ? rest : [rest substringToIndex:slash.location];
    NSString *tail = slash.location == NSNotFound ? @"" : [rest substringFromIndex:NSMaxRange(slash)];
    if (![CPWDManifest isValidAppID:appID]) return CPWDError(400, @"EINVAL", @"\"%@\" is not a valid app id", appID);
    if (!registry.devMode) {
        return CPWDError(403, @"EPERM", @"dev mode is off on the phone (\"devMode\": false in %@/config.json)", CPWDDataDir());
    }

    NSString *action = tail;
    NSString *filePath = nil;
    if ([tail hasPrefix:@"files/"]) {
        action = @"files";
        filePath = [tail substringFromIndex:6];
    }
    if ([action isEqualToString:@""] && [method isEqualToString:@"DELETE"]) return [self deleteApp:appID];
    if ([action isEqualToString:@"reload"] && [method isEqualToString:@"POST"]) return [self reloadApp:appID];

    BOOL writes = [action isEqualToString:@"sync"] || [action isEqualToString:@"files"] || [action isEqualToString:@"commit"];
    if (!writes) return CPWDError(404, @"ENOTFOUND", @"no route %@ %@", method, path);
    if ([registry isSystemAppID:appID]) {
        return CPWDError(403, @"EPERM", @"%@ was installed from a package and is read-only; change it with your package manager", appID);
    }
    if ([action isEqualToString:@"sync"] && [method isEqualToString:@"POST"]) return [self syncApp:appID request:request];
    if ([action isEqualToString:@"files"] && [method isEqualToString:@"PUT"]) return [self putFile:filePath app:appID request:request];
    if ([action isEqualToString:@"commit"] && [method isEqualToString:@"POST"]) return [self commitApp:appID request:request];
    return CPWDError(405, @"EINVAL", @"%@ is not allowed on %@", method, path);
}

- (NSArray *)appList {
    NSMutableArray *list = [NSMutableArray array];
    for (CPWDApp *app in [CPWDRegistry sharedRegistry].apps) [list addObject:app.controlEntry];
    return list;
}

#pragma mark Sync

/// Regular files under `root` (no dot-files, symlinks not followed), by relative path.
static NSDictionary<NSString *, NSString *> *CPWDListFiles(NSString *root) {
    NSMutableDictionary *files = [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *stack = [NSMutableArray arrayWithObject:@""];
    while (stack.count) {
        NSString *rel = stack.lastObject;
        [stack removeLastObject];
        NSString *dir = rel.length ? [root stringByAppendingPathComponent:rel] : root;
        for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
            if ([name hasPrefix:@"."]) continue;
            NSString *childRel = rel.length ? [rel stringByAppendingPathComponent:name] : name;
            NSString *child = [root stringByAppendingPathComponent:childRel];
            struct stat st;
            if (lstat(child.fileSystemRepresentation, &st) != 0) continue;
            if (S_ISDIR(st.st_mode)) [stack addObject:childRel];
            else if (S_ISREG(st.st_mode)) files[childRel] = child;
        }
    }
    return files;
}

- (NSString *)hashOfFile:(NSString *)path {
    struct stat st;
    if (stat(path.fileSystemRepresentation, &st) != 0) return nil;
    CPWDFileHash *cached = _hashes[path];
    if (cached && cached.size == st.st_size && cached.mtime.tv_sec == st.st_mtimespec.tv_sec &&
        cached.mtime.tv_nsec == st.st_mtimespec.tv_nsec) {
        return cached.sha1;
    }
    NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
    if (!data) return nil;
    CPWDFileHash *hash = [CPWDFileHash new];
    hash.size = st.st_size;
    hash.mtime = st.st_mtimespec;
    hash.sha1 = CPWDSHA1Hex(data);
    _hashes[path] = hash;
    return hash.sha1;
}

- (CPWDResponse *)syncApp:(NSString *)appID request:(CPWDRequest *)request {
    NSDictionary *body = [request JSONBody];
    NSDictionary *wanted = [body isKindOfClass:[NSDictionary class]] ? body[@"files"] : nil;
    if (![wanted isKindOfClass:[NSDictionary class]]) return CPWDError(400, @"EINVAL", @"expected { files: { \"<path>\": \"<sha1>\" } }");
    if (wanted.count > CPWDMaxSyncFiles) return CPWDError(400, @"EINVAL", @"an app may have at most %lu files", (unsigned long)CPWDMaxSyncFiles);
    NSMutableDictionary<NSString *, NSString *> *clean = [NSMutableDictionary dictionary];
    for (NSString *rel in wanted) {
        NSString *path = CPWDCleanRelativePath(rel);
        NSString *sha1 = wanted[rel];
        if (!path || ![path isEqualToString:rel]) return CPWDError(400, @"EINVAL", @"\"%@\" is not a path inside the app folder", rel);
        if (![sha1 isKindOfClass:[NSString class]] || sha1.length != 40) return CPWDError(400, @"EINVAL", @"bad sha1 for %@", rel);
        clean[path] = sha1.lowercaseString;
    }
    if (!clean[@"carpwa.json"]) return CPWDError(400, @"EINVAL", @"the app has no carpwa.json");

    NSString *appDir = [CPWDUserAppsDir() stringByAppendingPathComponent:appID];
    NSDictionary<NSString *, NSString *> *existing = CPWDListFiles(appDir);
    NSMutableArray *need = [NSMutableArray array];
    for (NSString *rel in clean) {
        NSString *have = existing[rel] ? [self hashOfFile:existing[rel]] : nil;
        if (![have isEqualToString:clean[rel]]) [need addObject:rel];
    }
    NSMutableArray *remove = [NSMutableArray array];
    for (NSString *rel in existing) if (!clean[rel]) [remove addObject:rel];

    // A new sync starts a new upload.
    [[NSFileManager defaultManager] removeItemAtPath:CPWDStagingDir(appID) error:nil];
    _expected[appID] = clean;
    return [CPWDResponse status:200 json:@{ @"need": [need sortedArrayUsingSelector:@selector(compare:)],
                                            @"remove": [remove sortedArrayUsingSelector:@selector(compare:)] }];
}

/// Makes room for a file at `path` inside `root`: parents become folders, a folder in the way goes.
static BOOL CPWDPrepareFilePath(NSString *root, NSString *rel, NSError **error) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *dir = root;
    NSArray *parts = rel.pathComponents;
    for (NSUInteger i = 0; i + 1 < parts.count; i++) {
        dir = [dir stringByAppendingPathComponent:parts[i]];
        struct stat st;
        if (lstat(dir.fileSystemRepresentation, &st) == 0 && !S_ISDIR(st.st_mode)) [fm removeItemAtPath:dir error:nil];
    }
    if (![fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    NSString *target = [root stringByAppendingPathComponent:rel];
    struct stat st;
    if (lstat(target.fileSystemRepresentation, &st) == 0 && S_ISDIR(st.st_mode)) [fm removeItemAtPath:target error:nil];
    return YES;
}

- (CPWDResponse *)putFile:(NSString *)rel app:(NSString *)appID request:(CPWDRequest *)request {
    NSString *clean = CPWDCleanRelativePath(rel);
    if (!clean) return CPWDError(400, @"EINVAL", @"\"%@\" is not a path inside the app folder", rel);
    NSString *expected = _expected[appID][clean];
    if (expected && ![CPWDSHA1Hex(request.body) isEqualToString:expected]) {
        return CPWDError(400, @"EINVAL", @"%@ does not match the sha1 sent with sync; was it changed during the upload?", clean);
    }
    NSString *staging = CPWDStagingDir(appID);
    NSError *error = nil;
    if (!CPWDPrepareFilePath(staging, clean, &error) ||
        ![request moveBodyToPath:[staging stringByAppendingPathComponent:clean] error:&error]) {
        return CPWDError(500, @"EINTERNAL", @"cannot store %@: %@", clean, error.localizedDescription);
    }
    return [CPWDResponse status:200 json:@{ @"ok": @YES }];
}

static void CPWDPruneEmptyDirectories(NSString *dir, BOOL removeSelf) {
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *name in [fm contentsOfDirectoryAtPath:dir error:nil]) {
        NSString *child = [dir stringByAppendingPathComponent:name];
        struct stat st;
        if (lstat(child.fileSystemRepresentation, &st) == 0 && S_ISDIR(st.st_mode)) CPWDPruneEmptyDirectories(child, YES);
    }
    if (removeSelf && [fm contentsOfDirectoryAtPath:dir error:nil].count == 0) rmdir(dir.fileSystemRepresentation);
}

- (CPWDResponse *)commitApp:(NSString *)appID request:(CPWDRequest *)request {
    NSDictionary *body = [request JSONBody];
    NSArray *remove = [body isKindOfClass:[NSDictionary class]] && [body[@"remove"] isKindOfClass:[NSArray class]] ? body[@"remove"] : @[];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *appDir = [CPWDUserAppsDir() stringByAppendingPathComponent:appID];
    NSString *staging = CPWDStagingDir(appID);
    NSError *error = nil;
    if (!CPWDEnsureDirectory(appDir, 0755)) return CPWDError(500, @"EINTERNAL", @"cannot create %@", appDir);

    for (id rel in remove) {
        NSString *clean = CPWDCleanRelativePath(rel);
        if (!clean) return CPWDError(400, @"EINVAL", @"\"%@\" is not a path inside the app folder", rel);
        [fm removeItemAtPath:[appDir stringByAppendingPathComponent:clean] error:nil];
    }
    NSDictionary<NSString *, NSString *> *staged = CPWDListFiles(staging);
    for (NSString *rel in [staged.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        NSString *target = [appDir stringByAppendingPathComponent:rel];
        if (!CPWDPrepareFilePath(appDir, rel, &error) ||
            rename(staged[rel].fileSystemRepresentation, target.fileSystemRepresentation) != 0) {
            return CPWDError(500, @"EINTERNAL", @"cannot move %@ into place: %@", rel,
                             error.localizedDescription ?: @(strerror(errno)));
        }
        [_hashes removeObjectForKey:target];
    }
    CPWDPruneEmptyDirectories(appDir, NO);
    [fm removeItemAtPath:staging error:nil];
    [_expected removeObjectForKey:appID];

    CPWDRegistry *registry = [CPWDRegistry sharedRegistry];
    [registry rescan];
    CPWDApp *app = [registry appWithID:appID];
    if (!app) {
        NSString *problem = [registry problemForAppID:appID] ?: @"unknown reason";
        return CPWDError(422, @"EINVAL", @"the files were copied, but carpwad cannot run %@: %@", appID, problem);
    }
    CPWDLog(@"pushed %@ (%lu file(s) changed, %lu removed)", appID, (unsigned long)staged.count, (unsigned long)remove.count);
    return [CPWDResponse status:200 json:app.controlEntry];
}

#pragma mark Other app actions

- (CPWDResponse *)reloadApp:(NSString *)appID {
    CPWDApp *app = [[CPWDRegistry sharedRegistry] appWithID:appID];
    if (!app) return CPWDError(404, @"ENOTFOUND", @"no app %@", appID);
    return [CPWDResponse status:200 json:@{ @"clients": @([app reloadPagesWithReason:@"push"]) }];
}

- (CPWDResponse *)deleteApp:(NSString *)appID {
    CPWDRegistry *registry = [CPWDRegistry sharedRegistry];
    if ([registry isSystemAppID:appID]) {
        return CPWDError(403, @"EPERM", @"%@ was installed from a package; remove it with your package manager", appID);
    }
    NSString *appDir = [CPWDUserAppsDir() stringByAppendingPathComponent:appID];
    if (![[NSFileManager defaultManager] fileExistsAtPath:appDir]) return CPWDError(404, @"ENOTFOUND", @"no app %@", appID);
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:appDir error:&error]) {
        return CPWDError(500, @"EINTERNAL", @"cannot remove %@: %@", appDir, error.localizedDescription);
    }
    [[NSFileManager defaultManager] removeItemAtPath:CPWDStagingDir(appID) error:nil];
    [_expected removeObjectForKey:appID];
    for (NSString *path in _hashes.allKeys) {
        if ([path hasPrefix:[appDir stringByAppendingString:@"/"]]) [_hashes removeObjectForKey:path];
    }
    [registry rescan];
    CPWDLog(@"deleted %@", appID);
    return [CPWDResponse status:200 json:@{ @"ok": @YES }];
}

@end
