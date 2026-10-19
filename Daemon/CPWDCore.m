//
//  CPWDCore.m
//

#import "CPWDCore.h"
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <os/log.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <TargetConditionals.h>
#if TARGET_OS_IPHONE && !defined(CPWD_NO_LIBROOT)
#import <libroot.h>
#endif

NSString * const CPWDAppsChangedNotification = @"com.andi.carpwa/apps-changed";
NSString * const CPWDRescanNotification = @"com.andi.carpwa/rescan";

dispatch_queue_t CPWDQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("com.andi.carpwad", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

void CPWDLog(NSString *format, ...) {
    static os_log_t log;
    static NSDateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create("com.andi.carpwa", "daemon");
        formatter = [NSDateFormatter new];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
    });
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    os_log(log, "%{public}s", message.UTF8String);
    NSString *line;
    @synchronized (formatter) {
        line = [NSString stringWithFormat:@"%@ carpwad: %@\n", [formatter stringFromDate:[NSDate date]], message];
    }
    fputs(line.UTF8String, stderr);
}

NSString *CPWDJBRoot(void) {
    static NSString *root;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        const char *env = getenv("CARPWA_JBROOT");
        if (env && *env) {
            root = [@(env) stringByStandardizingPath];
        } else {
#if TARGET_OS_IPHONE && !defined(CPWD_NO_LIBROOT)
            root = JBROOT_PATH_NSSTRING(@"/");
#else
            root = @"/";
#endif
        }
        while (root.length > 1 && [root hasSuffix:@"/"]) root = [root substringToIndex:root.length - 1];
        if (root.length == 0) root = @"/";
    });
    return root;
}

NSString *CPWDPath(NSString *relative) {
    NSString *root = CPWDJBRoot();
    if ([root isEqualToString:@"/"]) return relative;
    return [root stringByAppendingString:relative];
}

NSString *CPWDDataDir(void) { return CPWDPath(@"/var/mobile/Library/CarPWA"); }
NSString *CPWDSystemAppsDir(void) { return CPWDPath(@"/Library/CarPWA/Apps"); }
NSString *CPWDUserAppsDir(void) { return [CPWDDataDir() stringByAppendingPathComponent:@"Apps"]; }
NSString *CPWDSDKDir(void) { return CPWDPath(@"/Library/CarPWA/SDK"); }
NSString *CPWDRunDir(void) { return [CPWDDataDir() stringByAppendingPathComponent:@"run"]; }

BOOL CPWDEnsureDirectory(NSString *path, mode_t mode) {
    NSError *error = nil;
    if (![[NSFileManager defaultManager] createDirectoryAtPath:path withIntermediateDirectories:YES
                                                    attributes:nil error:&error]) {
        CPWDLog(@"cannot create %@: %@", path, error.localizedDescription);
        return NO;
    }
    chmod(path.fileSystemRepresentation, mode);
    return YES;
}

NSString *CPWDCleanRelativePath(NSString *path) {
    if (![path isKindOfClass:[NSString class]]) return nil;
    while ([path hasPrefix:@"/"]) path = [path substringFromIndex:1];
    if (path.length == 0 || path.length > 1024) return nil;
    static NSCharacterSet *forbidden;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableCharacterSet *set = [NSMutableCharacterSet characterSetWithRange:NSMakeRange(0, 0x20)];
        [set addCharactersInString:@"\\\x7f"];
        forbidden = [set copy];
    });
    if ([path rangeOfCharacterFromSet:forbidden].location != NSNotFound) return nil;
    for (NSString *segment in [path componentsSeparatedByString:@"/"]) {
        if (segment.length == 0 || [segment hasPrefix:@"."]) return nil;
        if (strlen(segment.fileSystemRepresentation) > 255) return nil;
    }
    return path;
}

NSString *CPWDMIMEType(NSString *path) {
    static NSDictionary<NSString *, NSString *> *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        types = @{
            @"html": @"text/html; charset=utf-8", @"htm": @"text/html; charset=utf-8",
            @"js": @"text/javascript; charset=utf-8", @"mjs": @"text/javascript; charset=utf-8",
            @"cjs": @"text/javascript; charset=utf-8", @"css": @"text/css; charset=utf-8",
            @"json": @"application/json; charset=utf-8", @"map": @"application/json; charset=utf-8",
            @"webmanifest": @"application/manifest+json; charset=utf-8",
            @"txt": @"text/plain; charset=utf-8", @"md": @"text/markdown; charset=utf-8",
            @"csv": @"text/csv; charset=utf-8", @"xml": @"application/xml; charset=utf-8",
            @"svg": @"image/svg+xml", @"png": @"image/png", @"apng": @"image/apng",
            @"jpg": @"image/jpeg", @"jpeg": @"image/jpeg", @"gif": @"image/gif", @"webp": @"image/webp",
            @"avif": @"image/avif", @"ico": @"image/x-icon", @"bmp": @"image/bmp", @"heic": @"image/heic",
            @"woff": @"font/woff", @"woff2": @"font/woff2", @"ttf": @"font/ttf", @"otf": @"font/otf",
            @"wasm": @"application/wasm",
            @"mp3": @"audio/mpeg", @"m4a": @"audio/mp4", @"aac": @"audio/aac", @"wav": @"audio/wav",
            @"ogg": @"audio/ogg", @"oga": @"audio/ogg", @"opus": @"audio/opus", @"flac": @"audio/flac",
            @"mp4": @"video/mp4", @"m4v": @"video/mp4", @"mov": @"video/quicktime", @"webm": @"video/webm",
            @"pdf": @"application/pdf", @"zip": @"application/zip",
            @"glb": @"model/gltf-binary", @"gltf": @"model/gltf+json",
            @"geojson": @"application/geo+json", @"pbf": @"application/x-protobuf",
        };
    });
    return types[path.pathExtension.lowercaseString] ?: @"application/octet-stream";
}

BOOL CPWDIsTextualType(NSString *contentType) {
    if (contentType.length == 0) return NO;
    static NSRegularExpression *re;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        re = [NSRegularExpression regularExpressionWithPattern:@"^text/|[/+](json|xml|javascript)\\b|^application/(javascript|ecmascript)"
                                                       options:NSRegularExpressionCaseInsensitive error:nil];
    });
    return [re firstMatchInString:contentType options:0 range:NSMakeRange(0, contentType.length)] != nil;
}

NSString *CPWDRandomHex(NSUInteger bytes) {
    NSMutableData *data = [NSMutableData dataWithLength:bytes];
    if (SecRandomCopyBytes(kSecRandomDefault, bytes, data.mutableBytes) != errSecSuccess) {
        arc4random_buf(data.mutableBytes, bytes);
    }
    NSMutableString *hex = [NSMutableString stringWithCapacity:bytes * 2];
    const uint8_t *p = data.bytes;
    for (NSUInteger i = 0; i < bytes; i++) [hex appendFormat:@"%02x", p[i]];
    return hex;
}

NSString *CPWDSHA1Hex(NSData *data) {
    uint8_t digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA1_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

BOOL CPWDSecureEquals(NSString *a, NSString *b) {
    if (!a || !b) return NO;
    NSData *x = [a dataUsingEncoding:NSUTF8StringEncoding];
    NSData *y = [b dataUsingEncoding:NSUTF8StringEncoding];
    if (x.length != y.length || x.length == 0) return NO;
    const uint8_t *p = x.bytes, *q = y.bytes;
    uint8_t diff = 0;
    for (NSUInteger i = 0; i < x.length; i++) diff |= p[i] ^ q[i];
    return diff == 0;
}

NSString *CPWDDevToken(void) {
    static NSString *token;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [CPWDDataDir() stringByAppendingPathComponent:@"dev-token"];
        NSString *existing = [[NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil]
                              stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (existing.length >= 32) {
            token = existing;
            chmod(path.fileSystemRepresentation, 0600);
            return;
        }
        token = CPWDRandomHex(32);
        NSString *tmp = [path stringByAppendingFormat:@".%@.tmp", CPWDRandomHex(4)];
        int fd = open(tmp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL, 0600);
        NSData *data = [[token stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
        BOOL ok = fd >= 0 && write(fd, data.bytes, data.length) == (ssize_t)data.length;
        if (fd >= 0) close(fd);
        if (ok && rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) == 0) {
            CPWDLog(@"created a new dev token at %@", path);
        } else {
            unlink(tmp.fileSystemRepresentation);
            CPWDLog(@"cannot write the dev token to %@ (%s); the CLI will not be able to connect", path, strerror(errno));
        }
    });
    return token;
}

BOOL CPWDWriteJSON(id object, NSString *path, mode_t mode) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes
                                                     error:&error];
    if (!data) {
        CPWDLog(@"cannot encode %@: %@", path.lastPathComponent, error.localizedDescription);
        return NO;
    }
    [[NSFileManager defaultManager] createDirectoryAtPath:path.stringByDeletingLastPathComponent
                              withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *tmp = [path stringByAppendingFormat:@".%@.tmp", CPWDRandomHex(4)];
    if (![data writeToFile:tmp options:0 error:&error]) {
        CPWDLog(@"cannot write %@: %@", path, error.localizedDescription);
        return NO;
    }
    chmod(tmp.fileSystemRepresentation, mode);
    if (rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) != 0) {
        CPWDLog(@"cannot move %@ into place: %s", path, strerror(errno));
        unlink(tmp.fileSystemRepresentation);
        return NO;
    }
    return YES;
}

id CPWDReadJSON(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    return [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
}

NSNumber *CPWDNowMillis(void) {
    return @((long long)floor([[NSDate date] timeIntervalSince1970] * 1000.0));
}

@implementation CPWDConfig

+ (instancetype)load {
    CPWDConfig *config = [CPWDConfig new];
    config->_devMode = YES;
    config->_basePort = CPWD_DEFAULT_BASE_PORT;
    NSDictionary *json = CPWDReadJSON([CPWDDataDir() stringByAppendingPathComponent:@"config.json"]);
    if ([json isKindOfClass:[NSDictionary class]]) {
        if ([json[@"devMode"] isKindOfClass:[NSNumber class]]) config->_devMode = [json[@"devMode"] boolValue];
        NSInteger port = [json[@"basePort"] isKindOfClass:[NSNumber class]] ? [json[@"basePort"] integerValue] : 0;
        if (port >= 1024 && port <= 65000) config->_basePort = (uint16_t)port;
    }
    const char *envPort = getenv("CARPWA_BASE_PORT");
    if (envPort && atoi(envPort) >= 1024 && atoi(envPort) <= 65000) config->_basePort = (uint16_t)atoi(envPort);
    return config;
}

@end
