//
//  CarPWA.m — libcarpwa: module registry shared by the CarPWA tweak and plugins.
//

#import <CarPWA/CarPWA.h>
#import <UIKit/UIKit.h>
#import <os/log.h>

NSString * const CPWAVersion = @"1.0.0";

NSErrorDomain const CPWAErrorDomain = @"com.andi.carpwa";
NSString * const CPWAErrorCodeKey = @"CPWAErrorCode";
NSString * const CPWAErrorInvalid = @"EINVAL";
NSString * const CPWAErrorPermission = @"EPERM";
NSString * const CPWAErrorNotFound = @"ENOTFOUND";
NSString * const CPWAErrorUnavailable = @"EUNAVAILABLE";
NSString * const CPWAErrorInternal = @"EINTERNAL";

NSNotificationName const CPWARegistryDidChangeNotification = @"CPWARegistryDidChangeNotification";
NSNotificationName const CPWACarStateDidChangeNotification = @"CPWACarStateDidChangeNotification";

static os_log_t CPWALog(void) {
    static os_log_t log;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create("com.andi.carpwa", "registry"); });
    return log;
}

static void CPWAOnMain(dispatch_block_t block) {
    if ([NSThread isMainThread]) block();
    else dispatch_async(dispatch_get_main_queue(), block);
}

#pragma mark - Errors

NSError *CPWAMakeError(NSString *code, NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    return [NSError errorWithDomain:CPWAErrorDomain code:1 userInfo:@{
        CPWAErrorCodeKey: code ?: CPWAErrorInternal,
        NSLocalizedDescriptionKey: message ?: @"",
    }];
}

NSString *CPWAErrorCode(NSError *error) {
    NSString *code = error.userInfo[CPWAErrorCodeKey];
    return [code isKindOfClass:[NSString class]] ? code : CPWAErrorInternal;
}

#pragma mark - Context

@implementation CPWACallContext

- (instancetype)initWithAppID:(NSString *)appID permissions:(NSSet<NSString *> *)permissions manifest:(NSDictionary *)manifest {
    if ((self = [super init])) {
        _appID = [appID copy];
        _permissions = [permissions copy] ?: [NSSet set];
        _manifest = [manifest copy] ?: @{};
    }
    return self;
}

- (BOOL)hasPermission:(NSString *)permission {
    return permission.length == 0 || [_permissions containsObject:permission];
}

@end

#pragma mark - Module

@interface CPWARegistry ()
- (BOOL)hasObserversForModule:(NSString *)module event:(NSString *)event;
- (void)deliverEvent:(NSString *)event module:(NSString *)module data:(id)data;
@end

// Distinguishes "use the module's permission" from an explicit nil.
static NSString * const CPWAInheritPermission = @"\x01inherit";

@interface CPWAModule ()
@property (nonatomic, strong) NSMutableDictionary<NSString *, CPWAMethodHandler> *handlers;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *methodPermissions;
@property (nonatomic, strong) NSMutableOrderedSet<NSString *> *events;
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *eventPermissions;
@end

@implementation CPWAModule

- (instancetype)initWithName:(NSString *)name {
    if ((self = [super init])) {
        _name = [name copy];
        _handlers = [NSMutableDictionary dictionary];
        _methodPermissions = [NSMutableDictionary dictionary];
        _events = [NSMutableOrderedSet orderedSet];
        _eventPermissions = [NSMutableDictionary dictionary];
    }
    return self;
}

- (void)addMethod:(NSString *)method handler:(CPWAMethodHandler)handler {
    [self addMethod:method permission:CPWAInheritPermission handler:handler];
}

- (void)addMethod:(NSString *)method permission:(NSString *)permission handler:(CPWAMethodHandler)handler {
    if (method.length == 0 || [method hasPrefix:@"$"] || !handler) return;
    @synchronized (self) {
        _handlers[method] = [handler copy];
        _methodPermissions[method] = permission ?: @"";
    }
}

- (void)addEvent:(NSString *)event {
    [self addEvent:event permission:CPWAInheritPermission];
}

- (void)addEvent:(NSString *)event permission:(NSString *)permission {
    if (event.length == 0) return;
    @synchronized (self) {
        [_events addObject:event];
        _eventPermissions[event] = permission ?: @"";
    }
}

- (NSArray<NSString *> *)methodNames {
    @synchronized (self) { return [_handlers.allKeys sortedArrayUsingSelector:@selector(compare:)]; }
}

- (NSArray<NSString *> *)eventNames {
    @synchronized (self) { return _events.array; }
}

- (CPWAMethodHandler)handlerForMethod:(NSString *)method {
    @synchronized (self) { return _handlers[method]; }
}

- (NSString *)resolvedPermission:(NSString *)stored {
    if (!stored || [stored isEqualToString:CPWAInheritPermission]) return _permission;
    return stored.length ? stored : nil;
}

- (NSString *)permissionForMethod:(NSString *)method {
    @synchronized (self) { return [self resolvedPermission:_methodPermissions[method]]; }
}

- (NSString *)permissionForEvent:(NSString *)event {
    @synchronized (self) { return [self resolvedPermission:_eventPermissions[event]]; }
}

- (BOOL)hasObserversForEvent:(NSString *)event {
    return [[CPWARegistry sharedRegistry] hasObserversForModule:_name event:event];
}

- (void)emit:(NSString *)event data:(id)data {
    if (event.length == 0) return;
    id safe = CPWAJSONSafe(data) ?: [NSNull null];
    NSString *name = _name;
    CPWAOnMain(^{ [[CPWARegistry sharedRegistry] deliverEvent:event module:name data:safe]; });
}

@end

#pragma mark - Registry

@implementation CPWARegistry {
    NSMutableDictionary<NSString *, CPWAModule *> *_modules;
    NSMutableArray<id<CPWAEventSink>> *_sinks;               // main queue
    NSMapTable<id<CPWAEventSink>, NSMutableSet<NSString *> *> *_subscriptions; // "module.event"
}

+ (instancetype)sharedRegistry {
    static CPWARegistry *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [[self alloc] init]; });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _modules = [NSMutableDictionary dictionary];
        _sinks = [NSMutableArray array];
        _subscriptions = [NSMapTable strongToStrongObjectsMapTable];
    }
    return self;
}

- (void)registerModule:(CPWAModule *)module {
    if (module.name.length == 0) return;
    @synchronized (_modules) { _modules[module.name] = module; }
    os_log(CPWALog(), "registered module %{public}@", module.name);
    CPWAOnMain(^{
        [[NSNotificationCenter defaultCenter] postNotificationName:CPWARegistryDidChangeNotification object:self];
    });
}

- (void)unregisterModuleNamed:(NSString *)name {
    @synchronized (_modules) { [_modules removeObjectForKey:name]; }
    CPWAOnMain(^{
        [[NSNotificationCenter defaultCenter] postNotificationName:CPWARegistryDidChangeNotification object:self];
    });
}

- (CPWAModule *)moduleNamed:(NSString *)name {
    @synchronized (_modules) { return _modules[name]; }
}

- (NSArray<CPWAModule *> *)modules {
    @synchronized (_modules) {
        return [_modules.allValues sortedArrayUsingComparator:^NSComparisonResult(CPWAModule *a, CPWAModule *b) {
            return [a.name compare:b.name];
        }];
    }
}

#pragma mark Sinks

- (void)addSink:(id<CPWAEventSink>)sink {
    NSAssert([NSThread isMainThread], @"CPWARegistry sinks are main-queue only");
    if (!sink || [_sinks containsObject:sink]) return;
    [_sinks addObject:sink];
    [_subscriptions setObject:[NSMutableSet set] forKey:sink];
}

- (void)removeSink:(id<CPWAEventSink>)sink {
    NSAssert([NSThread isMainThread], @"CPWARegistry sinks are main-queue only");
    if (!sink || ![_sinks containsObject:sink]) return;
    NSSet<NSString *> *keys = [[_subscriptions objectForKey:sink] copy];
    [_sinks removeObject:sink];
    [_subscriptions removeObjectForKey:sink];
    for (NSString *key in keys) [self noteKeyMaybeUnobserved:key];
}

- (BOOL)isKeyObserved:(NSString *)key {
    for (id<CPWAEventSink> sink in _sinks) {
        if ([[_subscriptions objectForKey:sink] containsObject:key]) return YES;
    }
    return NO;
}

- (BOOL)hasObserversForModule:(NSString *)module event:(NSString *)event {
    __block BOOL result = NO;
    dispatch_block_t check = ^{
        result = [self isKeyObserved:[NSString stringWithFormat:@"%@.%@", module, event]] ||
                 [self isKeyObserved:[module stringByAppendingString:@".*"]];
    };
    if ([NSThread isMainThread]) check();
    else dispatch_sync(dispatch_get_main_queue(), check);
    return result;
}

static void CPWASplitKey(NSString *key, NSString **module, NSString **event) {
    NSRange dot = [key rangeOfString:@"."];
    *module = [key substringToIndex:dot.location];
    *event = [key substringFromIndex:NSMaxRange(dot)];
}

- (void)noteKeyMaybeUnobserved:(NSString *)key {
    if ([self isKeyObserved:key]) return;
    NSString *moduleName, *event;
    CPWASplitKey(key, &moduleName, &event);
    CPWAModule *module = [self moduleNamed:moduleName];
    if (module.didStopObserving) module.didStopObserving(event);
}

- (void)deliverEvent:(NSString *)event module:(NSString *)moduleName data:(id)data {
    CPWAModule *module = [self moduleNamed:moduleName];
    NSString *permission = [module permissionForEvent:event];
    NSString *exact = [NSString stringWithFormat:@"%@.%@", moduleName, event];
    NSString *wildcard = [moduleName stringByAppendingString:@".*"];
    for (id<CPWAEventSink> sink in [_sinks copy]) {
        NSSet *subs = [_subscriptions objectForKey:sink];
        if (![subs containsObject:exact] && ![subs containsObject:wildcard]) continue;
        if (permission && ![sink.callContext hasPermission:permission]) continue;
        @try {
            [sink deliverEvent:event module:moduleName data:data];
        } @catch (NSException *e) {
            os_log_error(CPWALog(), "sink threw delivering %{public}@: %{public}@", exact, e.reason);
        }
    }
}

#pragma mark Calls

- (void)invokeModule:(NSString *)moduleName method:(NSString *)method params:(NSDictionary *)params
            fromSink:(id<CPWAEventSink>)sink reply:(CPWAReply)reply {
    if (![params isKindOfClass:[NSDictionary class]]) params = @{};
    CPWACallContext *context = sink.callContext;

    // One reply per call, whatever the handler does.
    __block BOOL replied = NO;
    NSString *label = [NSString stringWithFormat:@"%@.%@", moduleName, method];
    CPWAReply once = ^(id result, NSError *error) {
        @synchronized (sink) {
            if (replied) {
                os_log_error(CPWALog(), "%{public}@ replied twice; ignoring", label);
                return;
            }
            replied = YES;
        }
        reply(error ? nil : CPWAJSONSafe(result), error);
    };

    if ([moduleName isEqualToString:@"$registry"]) {
        if ([method isEqualToString:@"modules"]) {
            NSMutableArray *list = [NSMutableArray array];
            for (CPWAModule *m in self.modules) {
                [list addObject:@{
                    @"name": m.name,
                    @"methods": m.methodNames,
                    @"events": m.eventNames,
                    @"permission": m.permission ?: [NSNull null],
                }];
            }
            once(list, nil);
        } else {
            once(nil, CPWAMakeError(CPWAErrorNotFound, @"No method $registry.%@", method));
        }
        return;
    }

    CPWAModule *module = [self moduleNamed:moduleName];
    if (!module) {
        once(nil, CPWAMakeError(CPWAErrorNotFound, @"No module named '%@' (is its plugin installed?)", moduleName));
        return;
    }

    if ([method isEqualToString:@"$subscribe"] || [method isEqualToString:@"$unsubscribe"]) {
        NSString *event = CPWAParamString(params, @"event");
        if (event.length == 0) {
            once(nil, CPWAMakeError(CPWAErrorInvalid, @"%@ needs params.event", method));
            return;
        }
        if ([method isEqualToString:@"$subscribe"]) {
            NSString *permission = [event isEqualToString:@"*"] ? module.permission : [module permissionForEvent:event];
            if (permission && ![context hasPermission:permission]) {
                once(nil, CPWAMakeError(CPWAErrorPermission, @"%@.%@ events need the '%@' permission in carpwa.json",
                                        moduleName, event, permission));
                return;
            }
        }
        NSString *key = [NSString stringWithFormat:@"%@.%@", moduleName, event];
        CPWAOnMain(^{
            NSMutableSet *subs = [self->_subscriptions objectForKey:sink];
            if (!subs) { once(nil, CPWAMakeError(CPWAErrorUnavailable, @"page is not attached")); return; }
            if ([method isEqualToString:@"$subscribe"]) {
                BOOL wasObserved = [self isKeyObserved:key];
                [subs addObject:key];
                if (!wasObserved && module.didStartObserving) module.didStartObserving(event);
            } else if ([subs containsObject:key]) {
                [subs removeObject:key];
                [self noteKeyMaybeUnobserved:key];
            }
            once(@YES, nil);
        });
        return;
    }

    CPWAMethodHandler handler = [module handlerForMethod:method];
    if (!handler) {
        once(nil, CPWAMakeError(CPWAErrorNotFound, @"No method %@.%@", moduleName, method));
        return;
    }
    NSString *permission = [module permissionForMethod:method];
    if (permission && ![context hasPermission:permission]) {
        once(nil, CPWAMakeError(CPWAErrorPermission, @"%@.%@ needs the '%@' permission in carpwa.json",
                                moduleName, method, permission));
        return;
    }
    @try {
        handler(params, context, once);
    } @catch (NSException *e) {
        os_log_error(CPWALog(), "%{public}@ threw: %{public}@", label, e.reason);
        once(nil, CPWAMakeError(CPWAErrorInternal, @"%@ threw %@: %@", label, e.name, e.reason));
    }
}

@end

void CPWARegisterModule(CPWAModule *module) {
    [[CPWARegistry sharedRegistry] registerModule:module];
}

#pragma mark - Car state

static NSDictionary *gCarState;

NSDictionary *CPWACurrentCarState(void) {
    @synchronized ([CPWARegistry class]) { return gCarState; }
}

void CPWAPublishCarState(NSDictionary *state, NSArray<NSString *> *changed) {
    @synchronized ([CPWARegistry class]) { gCarState = [state copy]; }
    NSDictionary *info = @{ @"state": state ?: @{}, @"changed": changed ?: @[] };
    CPWAOnMain(^{
        [[NSNotificationCenter defaultCenter] postNotificationName:CPWACarStateDidChangeNotification object:nil userInfo:info];
    });
}

#pragma mark - JSON

id CPWAJSONSafe(id value) {
    if (!value || value == [NSNull null]) return value;
    if ([value isKindOfClass:[NSString class]]) return value;
    if ([value isKindOfClass:[NSNumber class]]) {
        if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return value;
        double d = [value doubleValue];
        return (isnan(d) || isinf(d)) ? [NSNull null] : value;
    }
    if ([value isKindOfClass:[NSArray class]] || [value isKindOfClass:[NSSet class]] || [value isKindOfClass:[NSOrderedSet class]]) {
        NSMutableArray *out = [NSMutableArray array];
        for (id item in value) [out addObject:CPWAJSONSafe(item) ?: [NSNull null]];
        return out;
    }
    if ([value isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
            out[[key description]] = CPWAJSONSafe(obj) ?: [NSNull null];
        }];
        return out;
    }
    if ([value isKindOfClass:[NSDate class]]) return @(floor([(NSDate *)value timeIntervalSince1970] * 1000.0));
    if ([value isKindOfClass:[NSData class]]) return [(NSData *)value base64EncodedStringWithOptions:0];
    if ([value isKindOfClass:[NSURL class]]) return [(NSURL *)value absoluteString];
    if ([value isKindOfClass:[NSUUID class]]) return [(NSUUID *)value UUIDString];
    if ([value isKindOfClass:[NSValue class]]) {
        const char *type = [(NSValue *)value objCType];
        if (strcmp(type, @encode(CGRect)) == 0) {
            CGRect r = [(NSValue *)value CGRectValue];
            return @{ @"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height) };
        }
        if (strcmp(type, @encode(CGSize)) == 0) {
            CGSize s = [(NSValue *)value CGSizeValue];
            return @{ @"width": @(s.width), @"height": @(s.height) };
        }
        if (strcmp(type, @encode(CGPoint)) == 0) {
            CGPoint p = [(NSValue *)value CGPointValue];
            return @{ @"x": @(p.x), @"y": @(p.y) };
        }
        if (strcmp(type, @encode(UIEdgeInsets)) == 0) {
            UIEdgeInsets i = [(NSValue *)value UIEdgeInsetsValue];
            return @{ @"top": @(i.top), @"left": @(i.left), @"bottom": @(i.bottom), @"right": @(i.right) };
        }
    }
    return [value description];
}

#pragma mark - Params

NSString *CPWAParamString(NSDictionary *params, NSString *key) {
    id v = params[key];
    return [v isKindOfClass:[NSString class]] ? v : nil;
}

NSNumber *CPWAParamNumber(NSDictionary *params, NSString *key) {
    id v = params[key];
    return [v isKindOfClass:[NSNumber class]] ? v : nil;
}

NSDictionary *CPWAParamDictionary(NSDictionary *params, NSString *key) {
    id v = params[key];
    return [v isKindOfClass:[NSDictionary class]] ? v : nil;
}

NSArray *CPWAParamArray(NSDictionary *params, NSString *key) {
    id v = params[key];
    return [v isKindOfClass:[NSArray class]] ? v : nil;
}
