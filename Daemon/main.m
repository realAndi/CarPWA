//
//  main.m — carpwad, the CarPWA launch daemon (runs as mobile).
//
//  Environment, for running it somewhere else (the tests run it on macOS):
//    CARPWA_JBROOT     jailbreak root to use instead of the real one
//    CARPWA_BASE_PORT  control port; apps get the ports above it
//

#import <Foundation/Foundation.h>
#import <sys/stat.h>
#import "CPWDControl.h"
#import "CPWDCore.h"
#import "CPWDRegistry.h"
#import "CPWDServer.h"
#import "CPWDStorage.h"

static const off_t CPWDMaxLogSize = 2 << 20;

static CPWDControl *gControl;

static void CPWDTrimLog(void) {
    // launchd appends stderr to run/carpwad.log; keep it from growing forever.
    struct stat st;
    if (fstat(STDERR_FILENO, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > CPWDMaxLogSize) {
        ftruncate(STDERR_FILENO, 0);
        lseek(STDERR_FILENO, 0, SEEK_SET);
    }
}

static void CPWDShutdown(int sig) {
    CPWDLog(@"stopping (signal %d)", sig);
    [[CPWDRegistry sharedRegistry] shutdown];
    [CPWDStorage flushAll];
    exit(0);
}

static void CPWDHandleSignal(int sig, dispatch_block_t handler) {
    signal(sig, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)sig, 0, CPWDQueue());
    dispatch_source_set_event_handler(source, handler);
    dispatch_resume(source);
    // Keep the source alive for the life of the process.
    static NSMutableArray *sources;
    if (!sources) sources = [NSMutableArray array];
    [sources addObject:source];
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v"))) {
            printf("carpwad %s\n", CPWD_VERSION.UTF8String);
            return 0;
        }
        if (argc > 1) {
            fprintf(stderr, "usage: carpwad [--version]\nRun by launchd; use carpwactl to talk to it.\n");
            return 64;
        }
        signal(SIGPIPE, SIG_IGN);
        umask(022);
        CPWDTrimLog();

        CPWDLog(@"carpwad %@ starting (jbroot %@, uid %d)", CPWD_VERSION, CPWDJBRoot(), getuid());
        if (!CPWDEnsureDirectory(CPWDDataDir(), 0755) || !CPWDEnsureDirectory(CPWDRunDir(), 0755)) return 1;
        CPWDEnsureDirectory(CPWDUserAppsDir(), 0755);
        CPWDEnsureDirectory([CPWDDataDir() stringByAppendingPathComponent:@"Data"], 0700);

        // Leftovers of pushes and uploads that died with the previous run.
        NSString *staging = [CPWDRunDir() stringByAppendingPathComponent:@"staging"];
        NSString *spool = [CPWDRunDir() stringByAppendingPathComponent:@"spool"];
        [[NSFileManager defaultManager] removeItemAtPath:staging error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:spool error:nil];
        CPWDEnsureDirectory(spool, 0700);

        if (!CPWDDevToken().length) return 1;

        [CPWDServer initializeLibrary];
        [CPWDServer setSpoolDirectory:spool];
        CPWDHandleSignal(SIGTERM, ^{ CPWDShutdown(SIGTERM); });
        CPWDHandleSignal(SIGINT, ^{ CPWDShutdown(SIGINT); });
        CPWDHandleSignal(SIGHUP, ^{ [[CPWDRegistry sharedRegistry] rescan]; });

        dispatch_async(CPWDQueue(), ^{
            CPWDRegistry *registry = [CPWDRegistry sharedRegistry];
            gControl = [[CPWDControl alloc] initWithPort:registry.controlPort];
            if (![gControl start]) {
                // Most likely another carpwad. launchd will try again.
                CPWDLog(@"cannot open the control port %u; exiting", registry.controlPort);
                exit(1);
            }
            [registry start];
        });
        dispatch_main();
    }
}
