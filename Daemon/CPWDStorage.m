//
//  CPWDStorage.m
//

#import "CPWDStorage.h"
#import "CPWDCore.h"

const NSUInteger CPWDStorageCapacity = 5u << 20;

// Changes are written this long after the first unsaved one, so a burst of
// set() calls costs one write.
static const int64_t CPWDStorageWriteDelay = 250 * NSEC_PER_MSEC;

static NSMutableDictionary<NSString *, CPWDStorage *> *CPWDAllStorage(void) {
    static NSMutableDictionary *all;
    if (!all) all = [NSMutableDictionary dictionary];
    return all;
}

/// Byte length of `value` as JSON (fragments allowed), or NSNotFound.
static NSUInteger CPWDJSONLength(id value) {
    if (![NSJSONSerialization isValidJSONObject:@[ value ]]) return NSNotFound;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
    return data ? data.length : NSNotFound;
}

@implementation CPWDStorage {
    NSMutableDictionary<NSString *, id> *_values;     // nil until first use
    NSMutableDictionary<NSString *, NSNumber *> *_sizes;
    NSUInteger _total;
    BOOL _dirty;
    BOOL _writeScheduled;
}

+ (instancetype)storageForAppID:(NSString *)appID {
    CPWDStorage *storage = CPWDAllStorage()[appID];
    if (!storage) {
        storage = [[CPWDStorage alloc] initWithAppID:appID];
        CPWDAllStorage()[appID] = storage;
    }
    return storage;
}

+ (void)flushAll {
    for (CPWDStorage *storage in CPWDAllStorage().allValues) [storage flush];
}

- (instancetype)initWithAppID:(NSString *)appID {
    if ((self = [super init])) {
        _appID = [appID copy];
        NSString *dir = [[CPWDDataDir() stringByAppendingPathComponent:@"Data"] stringByAppendingPathComponent:appID];
        _path = [dir stringByAppendingPathComponent:@"storage.json"];
    }
    return self;
}

- (void)load {
    if (_values) return;
    _values = [NSMutableDictionary dictionary];
    _sizes = [NSMutableDictionary dictionary];
    _total = 2;
    NSData *data = [NSData dataWithContentsOfFile:_path];
    if (!data) return;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) {
        NSString *aside = [_path stringByAppendingFormat:@".corrupt-%@", CPWDNowMillis()];
        rename(_path.fileSystemRepresentation, aside.fileSystemRepresentation);
        CPWDLog(@"storage for %@ was not a JSON object; moved it to %@ and started empty", _appID, aside.lastPathComponent);
        return;
    }
    [(NSDictionary *)json enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
        NSUInteger size = CPWDJSONLength(value);
        if (size == NSNotFound) return;
        [self account:key size:size];
        self->_values[key] = value;
    }];
}

- (NSUInteger)entrySizeForKey:(NSString *)key valueSize:(NSUInteger)size {
    NSUInteger keySize = CPWDJSONLength(key);
    return (keySize == NSNotFound ? key.length + 2 : keySize) + size + 2;   // "key":value,
}

- (void)account:(NSString *)key size:(NSUInteger)valueSize {
    NSUInteger old = _sizes[key].unsignedIntegerValue;
    NSUInteger entry = [self entrySizeForKey:key valueSize:valueSize];
    _total = _total - old + entry;
    _sizes[key] = @(entry);
}

- (id)valueForKey:(NSString *)key {
    [self load];
    return _values[key];
}

- (BOOL)setValue:(id)value forKey:(NSString *)key error:(NSString **)error {
    [self load];
    value = value ?: [NSNull null];
    NSUInteger size = CPWDJSONLength(value);
    if (size == NSNotFound) {
        if (error) *error = @"value is not JSON";
        return NO;
    }
    NSUInteger old = _sizes[key].unsignedIntegerValue;
    NSUInteger after = _total - old + [self entrySizeForKey:key valueSize:size];
    if (after > CPWDStorageCapacity) {
        if (error) *error = [NSString stringWithFormat:@"storage is full (%lu of %lu bytes used; 5 MiB per app)",
                             (unsigned long)_total, (unsigned long)CPWDStorageCapacity];
        return NO;
    }
    _values[key] = value;
    [self account:key size:size];
    [self markDirty];
    return YES;
}

- (void)removeValueForKey:(NSString *)key {
    [self load];
    if (!_values[key]) return;
    [_values removeObjectForKey:key];
    _total -= _sizes[key].unsignedIntegerValue;
    [_sizes removeObjectForKey:key];
    [self markDirty];
}

- (void)clear {
    [self load];
    if (_values.count == 0 && ![[NSFileManager defaultManager] fileExistsAtPath:_path]) return;
    [_values removeAllObjects];
    [_sizes removeAllObjects];
    _total = 2;
    [self markDirty];
}

- (NSArray<NSString *> *)keys {
    [self load];
    return [_values.allKeys sortedArrayUsingSelector:@selector(compare:)];
}

- (NSDictionary<NSString *, id> *)allValues {
    [self load];
    return [_values copy];
}

- (NSUInteger)byteSize {
    [self load];
    return _total;
}

- (void)markDirty {
    [self markDirtyWriteAfter:CPWDStorageWriteDelay];
}

- (void)markDirtyWriteAfter:(int64_t)delay {
    _dirty = YES;
    if (_writeScheduled) return;
    _writeScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay), CPWDQueue(), ^{
        self->_writeScheduled = NO;
        [self flush];
    });
}

- (void)flush {
    if (!_dirty) return;
    _dirty = NO;
    NSString *dir = _path.stringByDeletingLastPathComponent;
    CPWDEnsureDirectory(dir.stringByDeletingLastPathComponent, 0700);
    CPWDEnsureDirectory(dir, 0700);
    if (!CPWDWriteJSON(_values, _path, 0600)) {
        CPWDLog(@"storage for %@ could not be saved; retrying in 5 s", _appID);
        [self markDirtyWriteAfter:5 * NSEC_PER_SEC];
    }
}

@end
