//
//  CPWDRegistry.m
//

#import "CPWDRegistry.h"
#import "CPWDApp.h"
#import "CPWDCore.h"
#import "CPWDManifest.h"
#import <fcntl.h>
#import <notify.h>
#import <sys/stat.h>

static const int64_t CPWDRescanDelay = 300 * NSEC_PER_MSEC;
static const int64_t CPWDRetryDelay = 10 * NSEC_PER_SEC;

@interface CPWDCandidate : NSObject
@property (nonatomic, strong) CPWDManifest *manifest;
@property (nonatomic, copy) NSString *path;
@property (nonatomic, copy) NSString *origin;
@end

@implementation CPWDCandidate
@end

@interface CPWDWatcher : NSObject
@property (nonatomic, strong) dispatch_source_t source;
@property (nonatomic) dev_t device;
@property (nonatomic) ino_t inode;
@end

@implementation CPWDWatcher
@end

@implementation CPWDRegistry {
    CPWDConfig *_config;
    NSMutableDictionary<NSString *, CPWDApp *> *_apps;
    NSMutableDictionary<NSString *, NSString *> *_sessionKeys;   // for this daemon run, kept across removals
    NSMutableDictionary<NSString *, NSNumber *> *_ports;         // ports.json
    NSMutableDictionary<NSString *, NSString *> *_problems;      // folder name → why it was skipped
    NSMutableDictionary<NSString *, NSString *> *_logged;        // path → last message logged for it
    NSMutableDictionary<NSString *, CPWDWatcher *> *_watchers;   // path → vnode source
    NSData *_published;
    BOOL _rescanScheduled;
    BOOL _retryScheduled;
    BOOL _stopped;
    int _rescanToken;
}

+ (instancetype)sharedRegistry {
    static CPWDRegistry *registry;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ registry = [CPWDRegistry new]; });
    return registry;
}

- (instancetype)init {
    if ((self = [super init])) {
        _config = [CPWDConfig load];
        _apps = [NSMutableDictionary dictionary];
        _sessionKeys = [NSMutableDictionary dictionary];
        _problems = [NSMutableDictionary dictionary];
        _logged = [NSMutableDictionary dictionary];
        _watchers = [NSMutableDictionary dictionary];
        _ports = [NSMutableDictionary dictionary];
        NSDictionary *saved = CPWDReadJSON([self portsPath]);
        if ([saved isKindOfClass:[NSDictionary class]]) {
            [saved enumerateKeysAndObjectsUsingBlock:^(NSString *appID, NSNumber *port, BOOL *stop) {
                if ([port isKindOfClass:[NSNumber class]] && port.integerValue > 0 && port.integerValue <= 65535) {
                    self->_ports[appID] = port;
                }
            }];
        }
    }
    return self;
}

- (NSString *)portsPath { return [CPWDDataDir() stringByAppendingPathComponent:@"ports.json"]; }
- (NSString *)registryPath { return [CPWDRunDir() stringByAppendingPathComponent:@"apps.json"]; }

- (BOOL)devMode { return _config.devMode; }
- (uint16_t)controlPort { return _config.basePort; }

- (NSArray<CPWDApp *> *)apps {
    return [_apps.allValues sortedArrayUsingComparator:^NSComparisonResult(CPWDApp *a, CPWDApp *b) {
        NSComparisonResult r = [a.manifest.name localizedCaseInsensitiveCompare:b.manifest.name];
        return r != NSOrderedSame ? r : [a.appID compare:b.appID];
    }];
}

- (CPWDApp *)appWithID:(NSString *)appID {
    return appID ? _apps[appID] : nil;
}

- (BOOL)isSystemAppID:(NSString *)appID {
    if (![CPWDManifest isValidAppID:appID]) return NO;
    BOOL dir = NO;
    return [[NSFileManager defaultManager] fileExistsAtPath:[CPWDSystemAppsDir() stringByAppendingPathComponent:appID]
                                                isDirectory:&dir] && dir;
}

- (NSString *)problemForAppID:(NSString *)appID {
    return appID ? _problems[appID] : nil;
}

#pragma mark Lifecycle

- (void)start {
    CPWDEnsureDirectory(CPWDUserAppsDir(), 0755);
    CPWDEnsureDirectory(CPWDRunDir(), 0755);
    __weak typeof(self) weakSelf = self;
    notify_register_dispatch(CPWDRescanNotification.UTF8String, &_rescanToken, CPWDQueue(), ^(int token) {
        CPWDLog(@"rescan requested");
        [weakSelf scheduleRescan];
    });
    [self rescan];
}

- (void)scheduleRescan {
    if (_rescanScheduled || _stopped) return;
    _rescanScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, CPWDRescanDelay), CPWDQueue(), ^{
        self->_rescanScheduled = NO;
        [self rescan];
    });
}

- (void)shutdown {
    _stopped = YES;
    for (CPWDApp *app in _apps.allValues) [app stop];
    [_apps removeAllObjects];
    for (CPWDWatcher *w in _watchers.allValues) dispatch_source_cancel(w.source);
    [_watchers removeAllObjects];
    NSDictionary *doc = @{ @"version": @1, @"controlPort": @(_config.basePort), @"devMode": @(_config.devMode),
                           @"generatedAt": CPWDNowMillis(), @"running": @NO, @"apps": @[] };
    CPWDWriteJSON(doc, [self registryPath], 0644);
    notify_post(CPWDAppsChangedNotification.UTF8String);
}

#pragma mark Scanning

/// Logs a message about a path once, until it changes.
- (void)note:(NSString *)message forPath:(NSString *)path {
    if ([_logged[path] isEqualToString:message]) return;
    _logged[path] = message;
    CPWDLog(@"%@", message);
}

- (NSArray<CPWDCandidate *> *)candidatesIn:(NSString *)dir origin:(NSString *)origin {
    NSMutableArray *out = [NSMutableArray array];
    NSArray *names = [[[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]
                      sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *name in names) {
        if ([name hasPrefix:@"."]) continue;
        NSString *path = [dir stringByAppendingPathComponent:name];
        BOOL isDir = NO;
        if (![[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDir] || !isDir) continue;
        NSString *manifestPath = [path stringByAppendingPathComponent:@"carpwa.json"];
        NSData *data = [NSData dataWithContentsOfFile:manifestPath];
        NSString *problem = nil;
        CPWDManifest *manifest = nil;
        if (!data) {
            problem = @"no carpwa.json";
        } else {
            NSString *error = nil;
            manifest = [CPWDManifest manifestWithData:data error:&error];
            if (!manifest) problem = error;
            else if (![manifest.appID isEqualToString:name]) {
                problem = [NSString stringWithFormat:@"its carpwa.json says \"id\": \"%@\"; the folder must be named after the id", manifest.appID];
                manifest = nil;
            }
        }
        if (problem) {
            _problems[name] = problem;
            [self note:[NSString stringWithFormat:@"skipping %@ app %@: %@", origin, name, problem] forPath:path];
            continue;
        }
        NSString *warnings = [manifest.warnings componentsJoinedByString:@"; "];
        if (warnings.length) [self note:[NSString stringWithFormat:@"%@: %@", name, warnings] forPath:path];
        else [_logged removeObjectForKey:path];
        CPWDCandidate *c = [CPWDCandidate new];
        c.manifest = manifest;
        c.path = path;
        c.origin = origin;
        [out addObject:c];
    }
    return out;
}

- (uint16_t)portForAppID:(NSString *)appID {
    NSInteger base = _config.basePort;
    NSNumber *assigned = _ports[appID];
    if (assigned && assigned.integerValue > base && assigned.integerValue <= 65535) return assigned.unsignedShortValue;
    NSSet *taken = [NSSet setWithArray:_ports.allValues];
    NSInteger port = base + 1;
    while (port <= 65535 && [taken containsObject:@(port)]) port++;
    if (port > 65535) return 0;
    _ports[appID] = @(port);
    CPWDWriteJSON(_ports, [self portsPath], 0644);
    CPWDLog(@"assigned port %ld to %@", (long)port, appID);
    return (uint16_t)port;
}

- (void)rescan {
    if (_stopped) return;
    _config = [CPWDConfig load];
    [_problems removeAllObjects];

    NSMutableDictionary<NSString *, CPWDCandidate *> *found = [NSMutableDictionary dictionary];
    for (CPWDCandidate *c in [self candidatesIn:CPWDSystemAppsDir() origin:@"system"]) found[c.manifest.appID] = c;
    for (CPWDCandidate *c in [self candidatesIn:CPWDUserAppsDir() origin:@"user"]) {
        if (found[c.manifest.appID]) {
            NSString *problem = @"a package installed an app with the same id, which takes precedence";
            _problems[c.manifest.appID] = problem;
            [self note:[NSString stringWithFormat:@"skipping user app %@: %@", c.manifest.appID, problem] forPath:c.path];
            continue;
        }
        found[c.manifest.appID] = c;
    }

    for (NSString *appID in _apps.allKeys) {
        if (found[appID]) continue;
        CPWDLog(@"removed %@", appID);
        [_apps[appID] stop];
        [_apps removeObjectForKey:appID];
    }

    BOOL failed = NO;
    for (NSString *appID in [found.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        CPWDCandidate *c = found[appID];
        uint16_t port = [self portForAppID:appID];
        if (port == 0) {
            _problems[appID] = @"no free port left";
            [self note:[NSString stringWithFormat:@"skipping %@: no free port left", appID] forPath:c.path];
            continue;
        }
        CPWDApp *app = _apps[appID];
        if (app && app.port != port) {
            [app stop];
            [_apps removeObjectForKey:appID];
            app = nil;
        }
        if (app) {
            if (![app.manifest.dictionary isEqualToDictionary:c.manifest.dictionary] || ![app.path isEqualToString:c.path]) {
                CPWDLog(@"updated %@ %@", appID, c.manifest.version);
            }
            app.manifest = c.manifest;
            app.path = c.path;
            app.origin = c.origin;
            continue;
        }
        NSString *key = _sessionKeys[appID];
        if (!key) {
            key = CPWDRandomHex(16);
            _sessionKeys[appID] = key;
        }
        app = [[CPWDApp alloc] initWithManifest:c.manifest path:c.path origin:c.origin port:port sessionKey:key];
        if (![app start]) {
            failed = YES;
            _problems[appID] = [NSString stringWithFormat:@"port %u is in use by another program", port];
            [self note:[NSString stringWithFormat:@"cannot start %@: port %u is busy; retrying", appID, port] forPath:c.path];
            continue;
        }
        [_logged removeObjectForKey:c.path];
        CPWDLog(@"serving %@ %@ (%@) on port %u", appID, c.manifest.version, c.origin, port);
        _apps[appID] = app;
    }

    [self publish];
    [self updateWatchers];

    if (failed && !_retryScheduled) {
        _retryScheduled = YES;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, CPWDRetryDelay), CPWDQueue(), ^{
            self->_retryScheduled = NO;
            [self rescan];
        });
    }
}

- (void)publish {
    NSMutableArray *entries = [NSMutableArray array];
    for (CPWDApp *app in self.apps) [entries addObject:app.registryEntry];
    NSDictionary *core = @{ @"version": @1, @"controlPort": @(_config.basePort), @"devMode": @(_config.devMode),
                            @"running": @YES, @"apps": entries };
    NSData *data = [NSJSONSerialization dataWithJSONObject:core options:NSJSONWritingSortedKeys error:nil];
    if (data && [data isEqualToData:_published] && [[NSFileManager defaultManager] fileExistsAtPath:[self registryPath]]) return;
    NSMutableDictionary *doc = [core mutableCopy];
    doc[@"generatedAt"] = CPWDNowMillis();
    if (!CPWDWriteJSON(doc, [self registryPath], 0644)) return;
    _published = data;
    notify_post(CPWDAppsChangedNotification.UTF8String);
    CPWDLog(@"published %lu app(s)", (unsigned long)entries.count);
}

#pragma mark Watching

// Folder sources catch apps added, removed or renamed (dpkg, Filza, scp);
// manifest sources catch carpwa.json edited in place.
- (void)updateWatchers {
    NSMutableSet<NSString *> *wanted = [NSMutableSet setWithObjects:CPWDSystemAppsDir(), CPWDUserAppsDir(), nil];
    for (NSString *dir in @[ CPWDSystemAppsDir(), CPWDUserAppsDir() ]) {
        for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
            if ([name hasPrefix:@"."]) continue;
            NSString *path = [dir stringByAppendingPathComponent:name];
            [wanted addObject:path];
            [wanted addObject:[path stringByAppendingPathComponent:@"carpwa.json"]];
        }
    }
    for (NSString *path in _watchers.allKeys) {
        CPWDWatcher *w = _watchers[path];
        struct stat st;
        BOOL same = stat(path.fileSystemRepresentation, &st) == 0 && st.st_dev == w.device && st.st_ino == w.inode;
        if (same && [wanted containsObject:path]) continue;
        dispatch_source_cancel(w.source);
        [_watchers removeObjectForKey:path];
    }
    for (NSString *path in wanted) {
        if (_watchers[path]) continue;
        struct stat st;
        if (stat(path.fileSystemRepresentation, &st) != 0) continue;
        int fd = open(path.fileSystemRepresentation, O_EVTONLY);
        if (fd < 0) continue;
        dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd,
            DISPATCH_VNODE_WRITE | DISPATCH_VNODE_EXTEND | DISPATCH_VNODE_DELETE | DISPATCH_VNODE_RENAME |
            DISPATCH_VNODE_REVOKE | DISPATCH_VNODE_LINK, CPWDQueue());
        __weak typeof(self) weakSelf = self;
        dispatch_source_set_event_handler(source, ^{ [weakSelf scheduleRescan]; });
        dispatch_source_set_cancel_handler(source, ^{ close(fd); });
        dispatch_resume(source);
        CPWDWatcher *w = [CPWDWatcher new];
        w.source = source;
        w.device = st.st_dev;
        w.inode = st.st_ino;
        _watchers[path] = w;
    }
}

@end
