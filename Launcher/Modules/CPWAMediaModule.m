//
//  CPWAMediaModule.m — `media`: what is playing on the phone, and its
//  controls, through MediaRemote (resolved at runtime, so a missing symbol
//  degrades to EUNAVAILABLE instead of keeping CarPlay from launching).
//
//  Permissions: `media` for reading and events, `media.control` for the
//  transport methods.
//

#import "CPWAModules.h"
#import "CPWALog.h"
#import <CommonCrypto/CommonDigest.h>
#import <UIKit/UIKit.h>
#import <dlfcn.h>

typedef void (*MRGetInfoFn)(dispatch_queue_t, void (^)(CFDictionaryRef));
typedef void (*MRGetBoolFn)(dispatch_queue_t, void (^)(Boolean));
typedef void (*MRGetStringFn)(dispatch_queue_t, void (^)(CFStringRef));
typedef void (*MRRegisterFn)(dispatch_queue_t);
typedef void (*MRUnregisterFn)(void);
typedef Boolean (*MRSendCommandFn)(uint32_t, CFDictionaryRef);
typedef void (*MRSetElapsedFn)(double);

enum { kMRPlay = 0, kMRPause = 1, kMRTogglePlayPause = 2, kMRStop = 3, kMRNextTrack = 4, kMRPreviousTrack = 5 };

static struct {
    MRGetInfoFn getInfo;
    MRGetBoolFn getIsPlaying;
    MRGetStringFn getDisplayID;
    MRRegisterFn registerNotifications;
    MRUnregisterFn unregisterNotifications;
    MRSendCommandFn sendCommand;
    MRSetElapsedFn setElapsed;
    NSString *infoDidChange;
    NSString *isPlayingDidChange;
    NSString *appDidChange;
} MR;

static NSString *CPWAMRString(void *handle, const char *symbol, NSString *fallback) {
    CFStringRef *value = handle ? (CFStringRef *)dlsym(handle, symbol) : NULL;
    return value && *value ? (__bridge NSString *)*value : fallback;
}

static BOOL CPWAMediaRemoteLoad(void) {
    static BOOL loaded;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void *h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY);
        if (!h) { CPWALog(@"media: MediaRemote did not load: %s", dlerror()); return; }
        MR.getInfo = (MRGetInfoFn)dlsym(h, "MRMediaRemoteGetNowPlayingInfo");
        MR.getIsPlaying = (MRGetBoolFn)dlsym(h, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
        MR.getDisplayID = (MRGetStringFn)dlsym(h, "MRMediaRemoteGetNowPlayingApplicationDisplayID");
        MR.registerNotifications = (MRRegisterFn)dlsym(h, "MRMediaRemoteRegisterForNowPlayingNotifications");
        MR.unregisterNotifications = (MRUnregisterFn)dlsym(h, "MRMediaRemoteUnregisterForNowPlayingNotifications");
        MR.sendCommand = (MRSendCommandFn)dlsym(h, "MRMediaRemoteSendCommand");
        MR.setElapsed = (MRSetElapsedFn)dlsym(h, "MRMediaRemoteSetElapsedTime");
        MR.infoDidChange = CPWAMRString(h, "kMRMediaRemoteNowPlayingInfoDidChangeNotification", @"kMRMediaRemoteNowPlayingInfoDidChangeNotification");
        MR.isPlayingDidChange = CPWAMRString(h, "kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification",
                                             @"kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification");
        MR.appDidChange = CPWAMRString(h, "kMRMediaRemoteNowPlayingApplicationDidChangeNotification",
                                       @"kMRMediaRemoteNowPlayingApplicationDidChangeNotification");
        loaded = MR.getInfo != NULL;
        if (!loaded) CPWALog(@"media: MRMediaRemoteGetNowPlayingInfo is missing");
    });
    return loaded;
}

#pragma mark - Now playing

static NSString *CPWAAppName(NSString *bundleID) {
    static NSCache *names;
    if (!names) names = [NSCache new];
    if (!bundleID.length) return nil;
    NSString *cached = [names objectForKey:bundleID];
    if (cached) return cached.length ? cached : nil;
    NSString *name = nil;
    Class proxyClass = NSClassFromString(@"LSApplicationProxy");
    if ([proxyClass respondsToSelector:@selector(applicationProxyForIdentifier:)]) {
        id proxy = [proxyClass performSelector:@selector(applicationProxyForIdentifier:) withObject:bundleID];
        if ([proxy respondsToSelector:@selector(localizedName)]) name = [proxy valueForKey:@"localizedName"];
    }
    [names setObject:name ?: @"" forKey:bundleID];
    return name;
}

static NSString *CPWAArtworkID(NSDictionary *info) {
    id identifier = info[@"kMRMediaRemoteNowPlayingInfoArtworkIdentifier"];
    if ([identifier isKindOfClass:[NSString class]] && [identifier length]) return identifier;
    NSData *data = info[@"kMRMediaRemoteNowPlayingInfoArtworkData"];
    if (![data isKindOfClass:[NSData class]] || data.length == 0) return nil;
    uint8_t digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString string];
    for (int i = 0; i < 8; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

static id CPWANumber(id value) {
    return [value isKindOfClass:[NSNumber class]] ? value : [NSNull null];
}

static id CPWAStringOrNull(id value) {
    return [value isKindOfClass:[NSString class]] && [value length] ? value : [NSNull null];
}

/// carpwa.d.ts NowPlaying, or NSNull when nothing is loaded.
static id CPWANowPlayingFromInfo(NSDictionary *info, BOOL playing, NSString *bundleID) {
    if (info.count == 0) return [NSNull null];
    NSDate *timestamp = info[@"kMRMediaRemoteNowPlayingInfoTimestamp"];
    NSNumber *rate = [info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] isKindOfClass:[NSNumber class]]
        ? info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] : @(playing ? 1 : 0);
    return @{
        @"title": CPWAStringOrNull(info[@"kMRMediaRemoteNowPlayingInfoTitle"]),
        @"artist": CPWAStringOrNull(info[@"kMRMediaRemoteNowPlayingInfoArtist"]),
        @"album": CPWAStringOrNull(info[@"kMRMediaRemoteNowPlayingInfoAlbum"]),
        @"genre": CPWAStringOrNull(info[@"kMRMediaRemoteNowPlayingInfoGenre"]),
        @"duration": CPWANumber(info[@"kMRMediaRemoteNowPlayingInfoDuration"]),
        @"elapsed": CPWANumber(info[@"kMRMediaRemoteNowPlayingInfoElapsedTime"]),
        @"elapsedAt": [timestamp isKindOfClass:[NSDate class]] ? @(floor(timestamp.timeIntervalSince1970 * 1000)) : [NSNull null],
        @"rate": rate,
        @"playing": @(playing),
        @"artworkId": CPWAArtworkID(info) ?: [NSNull null],
        @"app": @{ @"bundleId": bundleID.length ? bundleID : [NSNull null], @"name": CPWAAppName(bundleID) ?: [NSNull null] },
    };
}

/// Fetches info, playing state and app; calls back on the main queue.
static void CPWAFetchNowPlaying(void (^completion)(NSDictionary *info, BOOL playing, NSString *bundleID)) {
    if (!CPWAMediaRemoteLoad()) { completion(nil, NO, nil); return; }
    dispatch_queue_t main = dispatch_get_main_queue();
    MR.getInfo(main, ^(CFDictionaryRef raw) {
        NSDictionary *info = [(__bridge NSDictionary *)raw copy] ?: @{};
        void (^withPlaying)(BOOL) = ^(BOOL playing) {
            if (!MR.getDisplayID) { completion(info, playing, nil); return; }
            MR.getDisplayID(main, ^(CFStringRef displayID) {
                completion(info, playing, [(__bridge NSString *)displayID copy]);
            });
        };
        if (MR.getIsPlaying) MR.getIsPlaying(main, ^(Boolean playing) { withPlaying(playing); });
        else withPlaying([info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] doubleValue] > 0);
    });
}

#pragma mark - Module

static CPWAModule *gMedia;
static NSUInteger gObservers;
static id gLastNowPlaying;
static NSNumber *gLastPlaying;
static NSMutableArray<id> *gTokens;

static void CPWAMediaRefresh(void) {
    CPWAFetchNowPlaying(^(NSDictionary *info, BOOL playing, NSString *bundleID) {
        if (!gObservers) return;
        id now = CPWANowPlayingFromInfo(info, playing, bundleID);
        if (![now isEqual:gLastNowPlaying]) {
            gLastNowPlaying = now;
            [gMedia emit:@"nowPlaying" data:now];
        }
        if (!gLastPlaying || gLastPlaying.boolValue != playing) {
            gLastPlaying = @(playing);
            [gMedia emit:@"playbackState" data:@{ @"playing": @(playing) }];
        }
    });
}

static void CPWAMediaStartObserving(void) {
    if (gObservers++ > 0 || !CPWAMediaRemoteLoad()) return;
    if (MR.registerNotifications) MR.registerNotifications(dispatch_get_main_queue());
    gTokens = [NSMutableArray array];
    for (NSString *name in @[ MR.infoDidChange, MR.isPlayingDidChange, MR.appDidChange ]) {
        [gTokens addObject:[[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:NSOperationQueue.mainQueue
                                                                          usingBlock:^(NSNotification *n) { CPWAMediaRefresh(); }]];
    }
    gLastNowPlaying = nil;
    gLastPlaying = nil;
    CPWAMediaRefresh();
}

static void CPWAMediaStopObserving(void) {
    if (gObservers == 0 || --gObservers > 0) return;
    for (id token in gTokens) [[NSNotificationCenter defaultCenter] removeObserver:token];
    gTokens = nil;
    if (MR.unregisterNotifications) MR.unregisterNotifications();
}

static void CPWAMediaCommand(uint32_t command, CPWAReply reply) {
    if (!CPWAMediaRemoteLoad() || !MR.sendCommand) {
        reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"MediaRemote is not available on this iOS version"));
        return;
    }
    reply(@(MR.sendCommand(command, NULL) != 0), nil);
}

static void CPWAMediaSeek(double position, CPWAReply reply) {
    if (!CPWAMediaRemoteLoad() || !MR.setElapsed) {
        reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"seeking is not available on this iOS version"));
        return;
    }
    MR.setElapsed(MAX(0, position));
    reply(@YES, nil);
}

static UIImage *CPWAScaledImage(UIImage *image, CGFloat maxSide) {
    CGSize size = image.size;
    CGFloat longest = MAX(size.width, size.height);
    if (longest <= maxSide || longest <= 0) return image;
    CGFloat factor = maxSide / longest;
    CGSize target = CGSizeMake(round(size.width * factor), round(size.height * factor));
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
    format.scale = 1;
    return [[[UIGraphicsImageRenderer alloc] initWithSize:target format:format] imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
        [image drawInRect:(CGRect){CGPointZero, target}];
    }];
}

CPWAModule *CPWAMakeMediaModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"media"];
    gMedia = m;
    m.permission = @"media";
    [m addEvent:@"nowPlaying"];
    [m addEvent:@"playbackState"];
    m.didStartObserving = ^(NSString *event) { CPWAMediaStartObserving(); };
    m.didStopObserving = ^(NSString *event) { CPWAMediaStopObserving(); };

    [m addMethod:@"getNowPlaying" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        if (!CPWAMediaRemoteLoad()) {
            reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"MediaRemote is not available on this iOS version"));
            return;
        }
        CPWAFetchNowPlaying(^(NSDictionary *info, BOOL playing, NSString *bundleID) {
            reply(CPWANowPlayingFromInfo(info, playing, bundleID), nil);
        });
    }];

    [m addMethod:@"getArtwork" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        CGFloat size = CPWAParamNumber(params, @"size") ? CPWAParamNumber(params, @"size").doubleValue : 512;
        size = MIN(MAX(size, 16), 2048);
        CPWAFetchNowPlaying(^(NSDictionary *info, BOOL playing, NSString *bundleID) {
            NSData *data = info[@"kMRMediaRemoteNowPlayingInfoArtworkData"];
            UIImage *image = [data isKindOfClass:[NSData class]] ? [UIImage imageWithData:data] : nil;
            if (!image) { reply([NSNull null], nil); return; }
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                NSData *jpeg = UIImageJPEGRepresentation(CPWAScaledImage(image, size), 0.85);
                reply(jpeg ? [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]]
                           : [NSNull null], nil);
            });
        });
    }];

    NSDictionary<NSString *, NSNumber *> *commands = @{
        @"play": @(kMRPlay), @"pause": @(kMRPause), @"togglePlayPause": @(kMRTogglePlayPause),
        @"stop": @(kMRStop), @"next": @(kMRNextTrack), @"previous": @(kMRPreviousTrack),
    };
    [commands enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSNumber *command, BOOL *stop) {
        [m addMethod:name permission:@"media.control" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
            CPWAMediaCommand(command.unsignedIntValue, reply);
        }];
    }];

    [m addMethod:@"seek" permission:@"media.control" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSNumber *position = CPWAParamNumber(params, @"position");
        if (!position || !isfinite(position.doubleValue)) {
            reply(nil, CPWAMakeError(CPWAErrorInvalid, @"seek needs params.position (seconds)"));
            return;
        }
        CPWAMediaSeek(position.doubleValue, reply);
    }];

    [m addMethod:@"skip" permission:@"media.control" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        NSNumber *seconds = CPWAParamNumber(params, @"seconds");
        if (!seconds || !isfinite(seconds.doubleValue)) {
            reply(nil, CPWAMakeError(CPWAErrorInvalid, @"skip needs params.seconds, e.g. 15 or -15"));
            return;
        }
        CPWAFetchNowPlaying(^(NSDictionary *info, BOOL playing, NSString *bundleID) {
            NSNumber *elapsed = info[@"kMRMediaRemoteNowPlayingInfoElapsedTime"];
            if (![elapsed isKindOfClass:[NSNumber class]]) {
                reply(nil, CPWAMakeError(CPWAErrorUnavailable, @"nothing seekable is playing"));
                return;
            }
            // Elapsed is a sample: advance it to now at the playback rate.
            double position = elapsed.doubleValue;
            NSDate *at = info[@"kMRMediaRemoteNowPlayingInfoTimestamp"];
            double rate = [info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] doubleValue];
            if ([at isKindOfClass:[NSDate class]] && playing) position += -at.timeIntervalSinceNow * (rate > 0 ? rate : 1);
            position += seconds.doubleValue;
            NSNumber *duration = info[@"kMRMediaRemoteNowPlayingInfoDuration"];
            if ([duration isKindOfClass:[NSNumber class]] && duration.doubleValue > 0) position = MIN(position, duration.doubleValue);
            CPWAMediaSeek(position, reply);
        });
    }];
    return m;
}
