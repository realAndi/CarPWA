//
//  CPWAPlugins.m
//

#import "CPWAPlugins.h"
#import "CPWALog.h"
#import <dlfcn.h>
#import <rootless.h>

static NSMutableArray<NSString *> *gLoaded;

void CPWALoadPlugins(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        gLoaded = [NSMutableArray array];
        NSString *dir = ROOT_PATH_NS(@"/Library/CarPWA/Plugins");
        NSArray *names = [[[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]
                          sortedArrayUsingSelector:@selector(compare:)];
        for (NSString *name in names) {
            if (![name.pathExtension isEqualToString:@"dylib"] || [name hasPrefix:@"."]) continue;
            NSString *path = [dir stringByAppendingPathComponent:name];
            // A plugin's constructor registers its modules; a broken one only costs itself.
            void *handle = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
            if (!handle) {
                CPWALog(@"plugin %@ failed to load: %s", name, dlerror());
                continue;
            }
            [gLoaded addObject:name];
            CPWALog(@"loaded plugin %@", name);
        }
    });
}

NSArray<NSString *> *CPWALoadedPlugins(void) {
    return [gLoaded copy] ?: @[];
}
