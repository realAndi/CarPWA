//
//  CPWDNet.m
//

#import "CPWDNet.h"
#import "CPWDCore.h"
#import "CPWDManifest.h"

static const NSUInteger CPWDMaxRedirects = 5;
static const NSUInteger CPWDMaxResponseSize = 16u << 20;

@interface CPWDFetch : NSObject
@property (nonatomic, strong) CPWDManifest *manifest;
@property (nonatomic, copy) CPWDNetCompletion completion;
@property (nonatomic, strong) NSMutableData *data;
@property (nonatomic, strong, nullable) NSHTTPURLResponse *response;
@property (nonatomic) NSUInteger redirects;
/// Set when we cancel the task ourselves, so completion reports why.
@property (nonatomic, copy, nullable) NSString *failCode;
@property (nonatomic, copy, nullable) NSString *failMessage;
@property (nonatomic, copy) NSString *label;
@end

@implementation CPWDFetch
@end

@interface CPWDNet () <NSURLSessionDataDelegate>
@end

@implementation CPWDNet {
    NSURLSession *_session;
    NSMutableDictionary<NSNumber *, CPWDFetch *> *_fetches;   // by task identifier
}

+ (instancetype)shared {
    static CPWDNet *net;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ net = [CPWDNet new]; });
    return net;
}

- (instancetype)init {
    if ((self = [super init])) {
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        config.HTTPCookieStorage = nil;           // pages manage cookies themselves, per request
        config.HTTPShouldSetCookies = NO;
        config.URLCache = nil;
        config.HTTPMaximumConnectionsPerHost = 6;
        config.HTTPAdditionalHeaders = @{ @"User-Agent": @"carpwad/" CPWD_VERSION };
        NSOperationQueue *queue = [NSOperationQueue new];
        queue.underlyingQueue = CPWDQueue();
        queue.maxConcurrentOperationCount = 1;
        _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:queue];
        _fetches = [NSMutableDictionary dictionary];
    }
    return self;
}

+ (void)fetchWithParams:(NSDictionary *)params manifest:(CPWDManifest *)manifest completion:(CPWDNetCompletion)completion {
    [[self shared] fetchWithParams:params manifest:manifest completion:completion];
}

static BOOL CPWDIsHTTPURL(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    return ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) && url.host.length > 0;
}

- (void)fetchWithParams:(NSDictionary *)params manifest:(CPWDManifest *)manifest completion:(CPWDNetCompletion)completion {
    NSString *urlString = params[@"url"];
    if (![urlString isKindOfClass:[NSString class]] || urlString.length == 0) {
        completion(nil, @"EINVAL", @"net.fetch needs a url");
        return;
    }
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) {
        completion(nil, @"EINVAL", [NSString stringWithFormat:@"invalid URL %@", urlString]);
        return;
    }
    if (!CPWDIsHTTPURL(url)) {
        completion(nil, @"EINVAL", @"net.fetch only supports http and https URLs");
        return;
    }
    if (![manifest allowsHost:url.host]) {
        completion(nil, @"EPERM", [NSString stringWithFormat:@"%@ is not in network.allow", url.host]);
        return;
    }

    NSString *method = [params[@"method"] isKindOfClass:[NSString class]] ? [params[@"method"] uppercaseString] : @"GET";
    NSCharacterSet *token = [[NSCharacterSet characterSetWithCharactersInString:
                              @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-.^_`|~"] invertedSet];
    if (method.length == 0 || [method rangeOfCharacterFromSet:token].location != NSNotFound) {
        completion(nil, @"EINVAL", [NSString stringWithFormat:@"invalid HTTP method %@", params[@"method"]]);
        return;
    }

    double timeout = [params[@"timeout"] isKindOfClass:[NSNumber class]] ? [params[@"timeout"] doubleValue] : 30;
    if (!(timeout >= 1)) timeout = 1;
    if (timeout > 300) timeout = 300;

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = method;
    request.timeoutInterval = timeout;
    request.HTTPShouldHandleCookies = NO;
    NSDictionary *headers = [params[@"headers"] isKindOfClass:[NSDictionary class]] ? params[@"headers"] : @{};
    static NSSet *managed;
    if (!managed) managed = [NSSet setWithObjects:@"host", @"content-length", @"connection", @"transfer-encoding", @"keep-alive", @"upgrade", nil];
    [headers enumerateKeysAndObjectsUsingBlock:^(NSString *name, id value, BOOL *stop) {
        if (![name isKindOfClass:[NSString class]] || [managed containsObject:name.lowercaseString]) return;
        NSString *v = [value isKindOfClass:[NSString class]] ? value : [value description];
        [request setValue:v forHTTPHeaderField:name];
    }];

    id body = params[@"body"];
    if (body && body != [NSNull null] && ![method isEqualToString:@"GET"] && ![method isEqualToString:@"HEAD"]) {
        NSString *text = [body isKindOfClass:[NSString class]] ? body : nil;
        if (!text) {
            completion(nil, @"EINVAL", @"net.fetch body must be a string");
            return;
        }
        NSData *data = [params[@"bodyEncoding"] isEqual:@"base64"]
            ? [[NSData alloc] initWithBase64EncodedString:text options:NSDataBase64DecodingIgnoreUnknownCharacters]
            : [text dataUsingEncoding:NSUTF8StringEncoding];
        if (!data) {
            completion(nil, @"EINVAL", @"net.fetch body is not valid base64");
            return;
        }
        request.HTTPBody = data;
    }

    CPWDFetch *fetch = [CPWDFetch new];
    fetch.manifest = manifest;
    fetch.completion = completion;
    fetch.data = [NSMutableData data];
    fetch.label = [NSString stringWithFormat:@"%@ %@", method, url.absoluteString];
    NSURLSessionDataTask *task = [_session dataTaskWithRequest:request];
    _fetches[@(task.taskIdentifier)] = fetch;
    [task resume];

    // timeoutInterval is an idle timeout; this bounds the whole request.
    __weak NSURLSessionDataTask *weakTask = task;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), CPWDQueue(), ^{
        NSURLSessionDataTask *t = weakTask;
        CPWDFetch *f = t ? self->_fetches[@(t.taskIdentifier)] : nil;
        if (!f || f.failCode) return;
        f.failCode = @"ETIMEOUT";
        f.failMessage = [NSString stringWithFormat:@"net.fetch %@ timed out after %.0f s", url.absoluteString, timeout];
        [t cancel];
    });
}

static NSString *CPWDReasonPhrase(NSInteger status) {
    static NSDictionary<NSNumber *, NSString *> *phrases;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        phrases = @{
            @100: @"Continue", @101: @"Switching Protocols", @200: @"OK", @201: @"Created", @202: @"Accepted",
            @203: @"Non-Authoritative Information", @204: @"No Content", @205: @"Reset Content", @206: @"Partial Content",
            @300: @"Multiple Choices", @301: @"Moved Permanently", @302: @"Found", @303: @"See Other",
            @304: @"Not Modified", @307: @"Temporary Redirect", @308: @"Permanent Redirect",
            @400: @"Bad Request", @401: @"Unauthorized", @402: @"Payment Required", @403: @"Forbidden",
            @404: @"Not Found", @405: @"Method Not Allowed", @406: @"Not Acceptable", @408: @"Request Timeout",
            @409: @"Conflict", @410: @"Gone", @411: @"Length Required", @412: @"Precondition Failed",
            @413: @"Payload Too Large", @414: @"URI Too Long", @415: @"Unsupported Media Type",
            @416: @"Range Not Satisfiable", @418: @"I'm a Teapot", @422: @"Unprocessable Entity",
            @425: @"Too Early", @426: @"Upgrade Required", @428: @"Precondition Required",
            @429: @"Too Many Requests", @431: @"Request Header Fields Too Large",
            @451: @"Unavailable For Legal Reasons", @500: @"Internal Server Error", @501: @"Not Implemented",
            @502: @"Bad Gateway", @503: @"Service Unavailable", @504: @"Gateway Timeout",
            @505: @"HTTP Version Not Supported",
        };
    });
    return phrases[@(status)] ?: @"";
}

#pragma mark NSURLSessionDataDelegate (CPWDQueue)

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler {
    CPWDFetch *fetch = _fetches[@(task.taskIdentifier)];
    NSURL *next = request.URL;
    if (!fetch) { completionHandler(nil); return; }
    if (++fetch.redirects > CPWDMaxRedirects) {
        fetch.failCode = @"EUNAVAILABLE";
        fetch.failMessage = [NSString stringWithFormat:@"net.fetch: more than %lu redirects", (unsigned long)CPWDMaxRedirects];
    } else if (!CPWDIsHTTPURL(next)) {
        fetch.failCode = @"EINVAL";
        fetch.failMessage = [NSString stringWithFormat:@"net.fetch: redirected to a non-HTTP URL %@", next.absoluteString];
    } else if (![fetch.manifest allowsHost:next.host]) {
        fetch.failCode = @"EPERM";
        fetch.failMessage = [NSString stringWithFormat:@"redirected to %@, which is not in network.allow", next.host];
    }
    if (fetch.failCode) {
        completionHandler(nil);
        [task cancel];
        return;
    }
    completionHandler(request);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    CPWDFetch *fetch = _fetches[@(dataTask.taskIdentifier)];
    fetch.response = [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;
    if (fetch && response.expectedContentLength > (long long)CPWDMaxResponseSize) {
        fetch.failCode = @"EUNAVAILABLE";
        fetch.failMessage = @"net.fetch: the response is larger than 16 MiB";
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
    CPWDFetch *fetch = _fetches[@(dataTask.taskIdentifier)];
    if (!fetch || fetch.failCode) return;
    if (fetch.data.length + data.length > CPWDMaxResponseSize) {
        fetch.failCode = @"EUNAVAILABLE";
        fetch.failMessage = @"net.fetch: the response is larger than 16 MiB";
        [dataTask cancel];
        return;
    }
    [fetch.data appendData:data];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    NSNumber *key = @(task.taskIdentifier);
    CPWDFetch *fetch = _fetches[key];
    [_fetches removeObjectForKey:key];
    if (!fetch) return;
    if (fetch.failCode) {
        fetch.completion(nil, fetch.failCode, fetch.failMessage);
        return;
    }
    if (error) {
        NSString *code = error.code == NSURLErrorTimedOut ? @"ETIMEOUT" : @"EUNAVAILABLE";
        fetch.completion(nil, code, [NSString stringWithFormat:@"net.fetch %@: %@", task.originalRequest.URL.absoluteString,
                                     error.localizedDescription]);
        return;
    }
    NSHTTPURLResponse *response = fetch.response;
    if (!response) {
        fetch.completion(nil, @"EUNAVAILABLE", @"net.fetch: no HTTP response");
        return;
    }
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    [response.allHeaderFields enumerateKeysAndObjectsUsingBlock:^(id name, id value, BOOL *stop) {
        headers[[[name description] lowercaseString]] = [value description];
    }];
    NSString *type = headers[@"content-type"];
    NSString *text = CPWDIsTextualType(type) ? [[NSString alloc] initWithData:fetch.data encoding:NSUTF8StringEncoding] : nil;
    if (!text && CPWDIsTextualType(type)) {
        // Not UTF-8 after all (e.g. Latin-1 without a charset): hand over the bytes.
        CPWDLog(@"net.fetch %@: textual response is not UTF-8; sending base64", fetch.label);
    }
    fetch.completion(@{
        @"status": @(response.statusCode),
        @"statusText": CPWDReasonPhrase(response.statusCode),
        @"headers": headers,
        @"url": response.URL.absoluteString ?: task.originalRequest.URL.absoluteString ?: @"",
        @"body": text ?: [fetch.data base64EncodedStringWithOptions:0],
        @"bodyEncoding": text ? @"text" : @"base64",
    }, nil, nil);
}

@end
