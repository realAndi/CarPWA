//
//  carpwactl.m — command-line helper for carpwad, on the phone.
//
//  Package maintainer scripts call `carpwactl rescan`; the rest is for
//  checking on the daemon over SSH.
//

#import <Foundation/Foundation.h>
#import <notify.h>
#import "CPWDCore.h"

static void usage(FILE *out) {
    fprintf(out,
        "usage: carpwactl <command>\n"
        "\n"
        "  rescan          tell carpwad to rescan the app folders\n"
        "  status          is carpwad running, and which apps it serves\n"
        "  apps            the app list as JSON (from the control server)\n"
        "  reload <id>     reload every open page of an app\n"
        "  token           print the dev token the carpwa CLI uses\n"
        "  version         print the version\n");
}

/// One request to the control server. Returns the HTTP status (0 when unreachable).
static NSInteger request(NSString *method, NSString *path, BOOL auth, id *json, NSString **failure) {
    NSDictionary *registry = CPWDReadJSON([CPWDRunDir() stringByAppendingPathComponent:@"apps.json"]);
    NSInteger port = [registry isKindOfClass:[NSDictionary class]] && [registry[@"controlPort"] isKindOfClass:[NSNumber class]]
        ? [registry[@"controlPort"] integerValue] : [CPWDConfig load].basePort;
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld%@", (long)port, path]];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = method;
    req.timeoutInterval = 10;
    if (auth) {
        NSString *token = [[NSString stringWithContentsOfFile:[CPWDDataDir() stringByAppendingPathComponent:@"dev-token"]
                                                     encoding:NSUTF8StringEncoding error:nil]
                           stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (!token.length) {
            if (failure) *failure = @"cannot read the dev token (run as mobile or root)";
            return 0;
        }
        [req setValue:token forHTTPHeaderField:@"X-CarPWA-Token"];
    }
    __block NSInteger status = 0;
    __block NSData *body = nil;
    __block NSString *error = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSURLSession *session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration ephemeralSessionConfiguration]];
    [[session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *err) {
        status = [response isKindOfClass:[NSHTTPURLResponse class]] ? [(NSHTTPURLResponse *)response statusCode] : 0;
        body = data;
        error = err.localizedDescription;
        dispatch_semaphore_signal(done);
    }] resume];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    [session finishTasksAndInvalidate];
    if (json) *json = body.length ? [NSJSONSerialization JSONObjectWithData:body options:NSJSONReadingFragmentsAllowed error:nil] : nil;
    if (failure && !status) *failure = [NSString stringWithFormat:@"carpwad is not answering on 127.0.0.1:%ld (%@)", (long)port, error ?: @"no response"];
    return status;
}

static void printJSON(id object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object ?: [NSNull null]
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingFragmentsAllowed
                                                     error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

static NSString *errorMessage(id json, NSInteger status) {
    if ([json isKindOfClass:[NSDictionary class]] && [json[@"error"] isKindOfClass:[NSDictionary class]]) {
        return [NSString stringWithFormat:@"%@", json[@"error"][@"message"]];
    }
    return [NSString stringWithFormat:@"HTTP %ld", (long)status];
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        if (argc < 2) { usage(stderr); return 64; }
        NSString *command = @(argv[1]);

        if ([command isEqualToString:@"rescan"]) {
            uint32_t status = notify_post(CPWDRescanNotification.UTF8String);
            if (status != NOTIFY_STATUS_OK) { fprintf(stderr, "carpwactl: notify_post failed (%u)\n", status); return 1; }
            return 0;
        }
        if ([command isEqualToString:@"version"] || [command isEqualToString:@"--version"]) {
            printf("carpwactl %s\n", CPWD_VERSION.UTF8String);
            return 0;
        }
        if ([command isEqualToString:@"help"] || [command isEqualToString:@"--help"] || [command isEqualToString:@"-h"]) {
            usage(stdout);
            return 0;
        }
        if ([command isEqualToString:@"token"]) {
            NSString *token = [NSString stringWithContentsOfFile:[CPWDDataDir() stringByAppendingPathComponent:@"dev-token"]
                                                        encoding:NSUTF8StringEncoding error:nil];
            if (!token.length) { fprintf(stderr, "carpwactl: no dev token yet (has carpwad started?), or no permission to read it\n"); return 1; }
            printf("%s\n", [token stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].UTF8String);
            return 0;
        }

        id json = nil;
        NSString *failure = nil;
        if ([command isEqualToString:@"status"]) {
            NSInteger status = request(@"GET", @"/_carpwa/health", NO, &json, &failure);
            if (status != 200) { fprintf(stderr, "carpwactl: %s\n", (failure ?: errorMessage(json, status)).UTF8String); return 1; }
            NSString *version = [json isKindOfClass:[NSDictionary class]] ? [json[@"version"] description] : @"?";
            printf("carpwad %s is running\n", version.UTF8String);
            NSDictionary *registry = CPWDReadJSON([CPWDRunDir() stringByAppendingPathComponent:@"apps.json"]);
            NSArray *apps = [registry isKindOfClass:[NSDictionary class]] ? registry[@"apps"] : nil;
            printf("data: %s\n", CPWDDataDir().UTF8String);
            printf("dev mode: %s\n", [registry[@"devMode"] boolValue] ? "on" : "off");
            printf("%lu app(s)\n", (unsigned long)apps.count);
            for (NSDictionary *app in apps) {
                printf("  %-28s %-8s %s  %s\n", [app[@"id"] description].UTF8String, [app[@"version"] description].UTF8String,
                       [app[@"url"] description].UTF8String, [app[@"origin"] description].UTF8String);
            }
            return 0;
        }
        if ([command isEqualToString:@"apps"]) {
            NSInteger status = request(@"GET", @"/_carpwa/apps", YES, &json, &failure);
            if (status != 200) { fprintf(stderr, "carpwactl: %s\n", (failure ?: errorMessage(json, status)).UTF8String); return 1; }
            printJSON(json);
            return 0;
        }
        if ([command isEqualToString:@"reload"]) {
            if (argc < 3) { fprintf(stderr, "usage: carpwactl reload <app id>\n"); return 64; }
            NSString *appID = [@(argv[2]) stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet];
            NSInteger status = request(@"POST", [NSString stringWithFormat:@"/_carpwa/dev/apps/%@/reload", appID], YES, &json, &failure);
            if (status != 200) { fprintf(stderr, "carpwactl: %s\n", (failure ?: errorMessage(json, status)).UTF8String); return 1; }
            printf("reloaded %s page(s)\n", [json[@"clients"] description].UTF8String);
            return 0;
        }
        fprintf(stderr, "carpwactl: unknown command %s\n\n", argv[1]);
        usage(stderr);
        return 64;
    }
}
