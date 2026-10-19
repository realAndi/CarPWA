//
//  CPWDStorage.h — `storage.*`: one JSON object per app at
//  <data>/Data/<app id>/storage.json, capped at 5 MiB. CPWDQueue() only.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CPWDStorage : NSObject

/// One instance per app id for the daemon's lifetime, so app updates and
/// rescans never lose a pending write.
+ (instancetype)storageForAppID:(NSString *)appID;
/// Writes every pending change now (used on shutdown).
+ (void)flushAll;

@property (nonatomic, copy, readonly) NSString *appID;
@property (nonatomic, copy, readonly) NSString *path;

/// nil when the key is missing (JSON null is stored as NSNull).
- (nullable id)valueForKey:(NSString *)key;
/// Fails with a message when the value is not JSON or storage would exceed the cap.
- (BOOL)setValue:(id)value forKey:(NSString *)key error:(NSString * _Nullable * _Nullable)error;
- (void)removeValueForKey:(NSString *)key;
- (void)clear;
@property (nonatomic, readonly) NSArray<NSString *> *keys;
@property (nonatomic, readonly) NSDictionary<NSString *, id> *allValues;
/// Approximate size of storage.json in bytes.
@property (nonatomic, readonly) NSUInteger byteSize;

- (void)flush;

@end

FOUNDATION_EXPORT const NSUInteger CPWDStorageCapacity;

NS_ASSUME_NONNULL_END
