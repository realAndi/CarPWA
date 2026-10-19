//
//  CPWAIconSource.m
//

#import "CPWAIconSource.h"
#import "CPWAAppCatalog.h"
#import "CPWALaunch.h"
#import "CPWAPrivate.h"
#import "CPWALog.h"
#import <objc/runtime.h>

static NSCache<NSString *, UIImage *> *CPWAImageCache(void) {
    static NSCache *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSCache new]; cache.countLimit = 64; });
    return cache;
}

@implementation CPWAIconSource

+ (void)load {
    // Conform at runtime: the protocol lives in SpringBoardHome, which we do not link.
    Protocol *protocol = objc_getProtocol("SBLeafIconDataSource");
    if (protocol) class_addProtocol(self, protocol);
}

+ (instancetype)sourceForAppID:(NSString *)appID {
    static NSMutableDictionary<NSString *, CPWAIconSource *> *sources;
    if (!sources) sources = [NSMutableDictionary dictionary];
    CPWAIconSource *source = sources[appID];
    if (!source) {
        source = [self new];
        source->_appID = [appID copy];
        sources[appID] = source;
    }
    return source;
}

+ (void)purgeImageCache {
    [CPWAImageCache() removeAllObjects];
}

- (CPWAAppEntry *)app {
    return [[CPWAAppCatalog sharedCatalog] appWithID:_appID];
}

#pragma mark Label

- (NSString *)icon:(id)icon displayNameForLocation:(id)location {
    return self.app.shortName ?: _appID;
}

#pragma mark Images

- (UIImage *)renderImageWithInfo:(SBIconImageInfo)info masked:(BOOL)masked {
    CGSize size = info.size;
    if (size.width <= 0 || size.height <= 0) size = CGSizeMake(60, 60);
    CGFloat scale = info.scale > 0 ? info.scale : UIScreen.mainScreen.scale;
    CPWAAppEntry *app = self.app;

    NSString *iconPath = app.iconPath ?: @"";
    NSDate *modified = iconPath.length
        ? [[NSFileManager defaultManager] attributesOfItemAtPath:iconPath error:nil].fileModificationDate : nil;
    NSString *key = [NSString stringWithFormat:@"%@|%@|%.0fx%.0f@%.1f|%d|%.1f", _appID, @(modified.timeIntervalSince1970),
                     size.width, size.height, scale, masked, info.continuousCornerRadius];
    UIImage *cached = [CPWAImageCache() objectForKey:key];
    if (cached) return cached;

    UIImage *source = iconPath.length ? [UIImage imageWithContentsOfFile:iconPath] : nil;
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
    format.scale = scale;
    format.opaque = NO;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
    NSString *name = app.shortName ?: _appID;
    UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
        CGRect rect = (CGRect){CGPointZero, size};
        if (masked) {
            CGFloat radius = info.continuousCornerRadius > 0 ? info.continuousCornerRadius : size.width * 0.225;
            [[UIBezierPath bezierPathWithRoundedRect:rect cornerRadius:radius] addClip];
        }
        if (source) {
            [source drawInRect:rect];
            return;
        }
        // No icon.png: a flat tile with the app's initial.
        [(app.backgroundColor ?: UIColor.darkGrayColor) setFill];
        UIRectFill(rect);
        NSString *initial = name.length ? [[name substringToIndex:1] uppercaseString] : @"?";
        NSDictionary *attrs = @{
            NSFontAttributeName: [UIFont systemFontOfSize:size.height * 0.5 weight:UIFontWeightSemibold],
            NSForegroundColorAttributeName: UIColor.whiteColor,
        };
        CGSize textSize = [initial sizeWithAttributes:attrs];
        [initial drawAtPoint:CGPointMake((size.width - textSize.width) / 2, (size.height - textSize.height) / 2)
              withAttributes:attrs];
    }];
    [CPWAImageCache() setObject:image forKey:key];
    return image;
}

- (UIImage *)icon:(id)icon imageWithInfo:(SBIconImageInfo)info {
    return [self renderImageWithInfo:info masked:YES];
}

- (UIImage *)icon:(id)icon unmaskedImageWithInfo:(SBIconImageInfo)info {
    return [self renderImageWithInfo:info masked:NO];
}

- (UIImage *)icon:(id)icon defaultImageWithInfo:(SBIconImageInfo)info {
    return [self renderImageWithInfo:info masked:YES];
}

#pragma mark Launch

- (BOOL)icon:(id)icon launchFromLocation:(id)location context:(id)context {
    CPWALog(@"launch %@ from %@", _appID, location);
    NSString *appID = _appID;
    dispatch_async(dispatch_get_main_queue(), ^{
        CPWAOpenAppInLauncher(appID);
    });
    return YES;
}

- (BOOL)iconAllowsLaunch:(id)icon { return self.app != nil; }
- (BOOL)iconDisallowsLaunchForObscuredReason:(id)icon { return NO; }

#pragma mark Everything else SpringBoardHome may ask

- (BOOL)iconSupportsUninstall:(id)icon { return NO; }
- (BOOL)iconCompleteUninstall:(id)icon { return NO; }
- (BOOL)iconCanTruncateLabel:(id)icon { return YES; }
- (BOOL)iconCanTightenLabel:(id)icon { return YES; }
- (NSUInteger)priorityForIcon:(id)icon { return 0; }
- (id)badgeNumberOrStringForIcon:(id)icon { return nil; }
- (NSInteger)accessoryTypeForIcon:(id)icon { return 0; }
- (NSInteger)labelAccessoryTypeForIcon:(id)icon { return 0; }
- (id)formattedAccessoryStringForIcon:(id)icon { return nil; }
- (NSInteger)progressStateForIcon:(id)icon { return 0; }
- (double)progressPercentForIcon:(id)icon { return 0; }
- (BOOL)isProgressPausedForIcon:(id)icon { return NO; }
- (NSString *)uniqueIdentifier { return [@"carpwa." stringByAppendingString:_appID]; }
- (NSString *)configurationStorageIdentifier { return self.uniqueIdentifier; }

@end
