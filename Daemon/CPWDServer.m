//
//  CPWDServer.m
//
//  Threading: civetweb calls us on its worker threads. HTTP requests are
//  read there, handled with dispatch_sync on CPWDQueue(), and written back
//  from the worker (so a slow client never blocks the daemon). WebSocket
//  frames are reassembled on the worker and delivered with dispatch_async,
//  which keeps them in order. Each socket writes on its own serial queue.
//

#import "CPWDServer.h"
#import "CPWDCore.h"
#import "civetweb.h"
#import <pthread.h>
#import <sys/stat.h>

static const unsigned long long CPWDSpoolThreshold = 1ull << 20;
static const NSUInteger CPWDMaxMessageSize = 16u << 20;

static NSString *gSpoolDirectory;

#pragma mark - Request

@interface CPWDRequest ()
@property (nonatomic, copy, nullable) NSString *spoolPath;
@end

@implementation CPWDRequest

- (void)dealloc {
    if (_spoolPath) unlink(_spoolPath.fileSystemRepresentation);
}

- (NSString *)header:(NSString *)name {
    return _headers[name.lowercaseString];
}

- (id)JSONBody {
    if (_body.length == 0) return nil;
    return [NSJSONSerialization JSONObjectWithData:_body options:NSJSONReadingFragmentsAllowed error:nil];
}

- (BOOL)moveBodyToPath:(NSString *)path error:(NSError **)error {
    if (_spoolPath) {
        if (rename(_spoolPath.fileSystemRepresentation, path.fileSystemRepresentation) == 0) {
            _spoolPath = nil;
            chmod(path.fileSystemRepresentation, 0644);
            return YES;
        }
        if (errno != EXDEV) {
            if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
            return NO;
        }
    }
    // Different volume (or a small body): write it, atomically.
    return [_body writeToFile:path options:NSDataWritingAtomic error:error];
}

static NSString *CPWDFormDecode(NSString *s) {
    NSString *plus = [s stringByReplacingOccurrencesOfString:@"+" withString:@" "];
    return plus.stringByRemovingPercentEncoding ?: plus;
}

static NSDictionary<NSString *, NSString *> *CPWDParseQuery(const char *qs) {
    if (!qs || !*qs) return @{};
    NSString *query = [NSString stringWithUTF8String:qs];
    if (!query) return @{};
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    for (NSString *pair in [query componentsSeparatedByString:@"&"]) {
        if (pair.length == 0) continue;
        NSRange eq = [pair rangeOfString:@"="];
        NSString *key = eq.location == NSNotFound ? pair : [pair substringToIndex:eq.location];
        NSString *value = eq.location == NSNotFound ? @"" : [pair substringFromIndex:NSMaxRange(eq)];
        key = CPWDFormDecode(key);
        if (key.length && !out[key]) out[key] = CPWDFormDecode(value);
    }
    return out;
}

/// Everything but the body. Safe on a `const` connection (WebSocket connect handler).
static CPWDRequest *CPWDRequestFromConnection(const struct mg_connection *conn) {
    const struct mg_request_info *ri = mg_get_request_info(conn);
    CPWDRequest *r = [CPWDRequest new];
    r->_method = [@(ri->request_method ?: "GET") uppercaseString];
    // local_uri_raw is percent-decoded but not dot-cleaned: callers validate
    // paths themselves and refuse "..", rather than having it rewritten.
    const char *uri = ri->local_uri_raw ?: ri->local_uri;
    NSString *path = uri ? [NSString stringWithUTF8String:uri] : nil;
    r->_path = path.length ? path : @"/";
    r->_query = CPWDParseQuery(ri->query_string);
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    for (int i = 0; i < ri->num_headers; i++) {
        NSString *name = [@(ri->http_headers[i].name ?: "") lowercaseString];
        NSString *value = ri->http_headers[i].value ? [NSString stringWithUTF8String:ri->http_headers[i].value] : nil;
        if (!name.length || !value) continue;
        headers[name] = headers[name] ? [NSString stringWithFormat:@"%@, %@", headers[name], value] : value;
    }
    r->_headers = headers;
    r->_body = [NSData data];
    r->_localPort = (uint16_t)ri->server_port;
    return r;
}

/// Reads the body: into memory while it is small, then into a spool file.
/// Returns an HTTP status on failure, 0 on success.
static int CPWDReadBody(struct mg_connection *conn, CPWDRequest *request, unsigned long long limit) {
    const struct mg_request_info *ri = mg_get_request_info(conn);
    const char *expect = mg_get_header(conn, "Expect");
    if (expect && mg_strcasecmp(expect, "100-continue") == 0) {
        if (ri->content_length > 0 && (unsigned long long)ri->content_length > limit) return 413;
        mg_printf(conn, "HTTP/1.1 100 Continue\r\n\r\n");
    }
    if (ri->content_length == 0) return 0;
    if (ri->content_length > 0 && (unsigned long long)ri->content_length > limit) return 413;

    NSMutableData *memory = [NSMutableData data];
    FILE *spool = NULL;
    NSString *spoolPath = nil;
    unsigned long long total = 0;
    char buf[64 * 1024];
    int status = 0;
    for (;;) {
        int n = mg_read(conn, buf, sizeof(buf));
        if (n < 0) { status = 400; break; }
        if (n == 0) break;
        total += (unsigned long long)n;
        if (total > limit) { status = 413; break; }
        if (!spool && total > CPWDSpoolThreshold) {
            NSString *dir = gSpoolDirectory ?: NSTemporaryDirectory();
            [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
            spoolPath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"body-%@", CPWDRandomHex(8)]];
            spool = fopen(spoolPath.fileSystemRepresentation, "wx");
            if (!spool) { status = 507; spoolPath = nil; break; }
            if (fwrite(memory.bytes, 1, memory.length, spool) != memory.length) { status = 507; break; }
            memory = nil;
        }
        if (spool) {
            if (fwrite(buf, 1, (size_t)n, spool) != (size_t)n) { status = 507; break; }
        } else {
            [memory appendBytes:buf length:(NSUInteger)n];
        }
    }
    if (spool) {
        if (fclose(spool) != 0 && !status) status = 507;
        if (status) {
            unlink(spoolPath.fileSystemRepresentation);
            return status;
        }
        request.spoolPath = spoolPath;
        NSData *mapped = [NSData dataWithContentsOfFile:spoolPath options:NSDataReadingMappedIfSafe error:nil];
        if (!mapped) return 500;
        request->_body = mapped;
        return 0;
    }
    if (status) return status;
    request->_body = memory;
    return 0;
}

@end

#pragma mark - Response

@implementation CPWDResponse

- (instancetype)init {
    if ((self = [super init])) {
        _status = 200;
        _headers = [NSMutableDictionary dictionary];
    }
    return self;
}

+ (instancetype)status:(NSInteger)status data:(NSData *)data type:(NSString *)type {
    CPWDResponse *r = [self new];
    r.status = status;
    r.body = data ?: [NSData data];
    if (type) r.headers[@"Content-Type"] = type;
    return r;
}

+ (instancetype)status:(NSInteger)status json:(id)object {
    NSData *data = object ? [NSJSONSerialization dataWithJSONObject:object
                                                            options:NSJSONWritingPrettyPrinted | NSJSONWritingFragmentsAllowed | NSJSONWritingWithoutEscapingSlashes
                                                              error:nil] : nil;
    if (object && !data) {
        return [self status:500 code:@"EINTERNAL" message:@"response is not JSON-encodable"];
    }
    return [self status:status data:data ?: [@"null" dataUsingEncoding:NSUTF8StringEncoding]
                   type:@"application/json; charset=utf-8"];
}

+ (instancetype)status:(NSInteger)status text:(NSString *)text {
    return [self status:status data:[text dataUsingEncoding:NSUTF8StringEncoding] type:@"text/plain; charset=utf-8"];
}

+ (instancetype)status:(NSInteger)status code:(NSString *)code message:(NSString *)message {
    return [self status:status json:@{ @"error": @{ @"code": code ?: @"EINTERNAL", @"message": message ?: @"" } }];
}

+ (instancetype)file:(NSString *)path type:(NSString *)type {
    CPWDResponse *r = [self new];
    r.filePath = path;
    r.fileMIMEType = type;
    return r;
}

@end

static BOOL CPWDHeaderValueOK(NSString *s) {
    return [s rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"\r\n"]].location == NSNotFound;
}

static void CPWDWriteResponse(struct mg_connection *conn, CPWDRequest *request, CPWDResponse *response) {
    BOOL head = [request.method isEqualToString:@"HEAD"];
    NSMutableDictionary<NSString *, NSString *> *headers = [NSMutableDictionary dictionary];
    headers[@"X-Content-Type-Options"] = @"nosniff";
    [headers addEntriesFromDictionary:response.headers];

    if (response.filePath) {
        // civetweb sets Content-Type, Content-Length, ETag, Last-Modified,
        // Cache-Control (static_file_cache_control) and handles Range/HEAD.
        NSMutableString *extra = [NSMutableString string];
        [headers enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *value, BOOL *stop) {
            NSString *lower = name.lowercaseString;
            if ([lower isEqualToString:@"content-type"] || [lower isEqualToString:@"content-length"] ||
                [lower isEqualToString:@"cache-control"] || !CPWDHeaderValueOK(name) || !CPWDHeaderValueOK(value)) return;
            [extra appendFormat:@"%@: %@\r\n", name, value];
        }];
        mg_send_mime_file2(conn, response.filePath.fileSystemRepresentation,
                           response.fileMIMEType.UTF8String, extra.length ? extra.UTF8String : NULL);
        return;
    }

    NSData *body = response.body ?: [NSData data];
    int status = (int)(response.status ?: 200);
    BOOL noBody = head || status == 204 || status == 304 || (status >= 100 && status < 200);
    if (!headers[@"Cache-Control"]) headers[@"Cache-Control"] = @"no-store";
    mg_response_header_start(conn, status);
    [headers enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *value, BOOL *stop) {
        if ([name.lowercaseString isEqualToString:@"content-length"]) return;
        if (!CPWDHeaderValueOK(name) || !CPWDHeaderValueOK(value)) return;
        mg_response_header_add(conn, name.UTF8String, value.UTF8String, -1);
    }];
    if (status != 204 && status != 304) {
        mg_response_header_add(conn, "Content-Length", [NSString stringWithFormat:@"%lu", (unsigned long)body.length].UTF8String, -1);
    }
    mg_response_header_send(conn);
    if (!noBody && body.length) mg_write(conn, body.bytes, body.length);
}

#pragma mark - Socket

@interface CPWDSocket ()
- (instancetype)initWithConnection:(struct mg_connection *)conn request:(CPWDRequest *)request;
- (void)handshakeDidComplete;
- (int)handleFrameBits:(int)bits data:(const char *)data length:(size_t)length;
- (void)connectionDidClose;
@end

@implementation CPWDSocket {
    pthread_mutex_t _lock;          // guards _conn, _ready, _closed, _closeSent
    struct mg_connection *_conn;    // NULL once civetweb has let go of it
    BOOL _ready;
    BOOL _closed;
    BOOL _closeSent;
    dispatch_queue_t _sendQueue;    // suspended until the handshake completes
    // Reassembly, touched only by the connection's worker thread.
    NSMutableData *_fragments;
    int _fragmentOpcode;
}

- (instancetype)initWithConnection:(struct mg_connection *)conn request:(CPWDRequest *)request {
    if ((self = [super init])) {
        pthread_mutex_init(&_lock, NULL);
        _conn = conn;
        _request = request;
        _sendQueue = dispatch_queue_create("com.andi.carpwad.socket", DISPATCH_QUEUE_SERIAL);
        dispatch_suspend(_sendQueue);
    }
    return self;
}

- (void)dealloc {
    pthread_mutex_lock(&_lock);
    BOOL resume = !_ready;
    _ready = YES;
    pthread_mutex_unlock(&_lock);
    if (resume) dispatch_resume(_sendQueue);   // a suspended queue must not be released
    pthread_mutex_destroy(&_lock);
}

- (BOOL)isOpen {
    pthread_mutex_lock(&_lock);
    BOOL open = _conn && _ready && !_closed && !_closeSent;
    pthread_mutex_unlock(&_lock);
    return open;
}

- (void)handshakeDidComplete {
    pthread_mutex_lock(&_lock);
    BOOL resume = !_ready;
    _ready = YES;
    pthread_mutex_unlock(&_lock);
    if (resume) dispatch_resume(_sendQueue);
}

- (void)writeOpcode:(int)opcode data:(NSData *)data {
    pthread_mutex_lock(&_lock);
    if (_conn && !_closed && !_closeSent) {
        if (opcode == MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE) _closeSent = YES;
        mg_websocket_write(_conn, opcode, data.bytes, data.length);
    }
    pthread_mutex_unlock(&_lock);
}

- (void)sendText:(NSString *)text {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return;
    dispatch_async(_sendQueue, ^{ [self writeOpcode:MG_WEBSOCKET_OPCODE_TEXT data:data]; });
}

- (void)sendJSON:(id)object {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingFragmentsAllowed | NSJSONWritingWithoutEscapingSlashes error:nil];
    if (!data) {
        CPWDLog(@"socket: dropping a message that is not JSON-encodable");
        return;
    }
    dispatch_async(_sendQueue, ^{ [self writeOpcode:MG_WEBSOCKET_OPCODE_TEXT data:data]; });
}

static NSData *CPWDCloseBody(uint16_t code) {
    uint8_t bytes[2] = { (uint8_t)(code >> 8), (uint8_t)(code & 0xff) };
    return [NSData dataWithBytes:bytes length:2];
}

- (void)close {
    // The peer answers with its own close frame, which ends civetweb's read loop.
    dispatch_async(_sendQueue, ^{ [self writeOpcode:MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE data:CPWDCloseBody(1000)]; });
}

- (void)deliverMessage:(NSData *)data {
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!text) return;
    dispatch_async(CPWDQueue(), ^{
        [self.delegate socket:self didReceiveText:text];
    });
}

/// Worker thread. Returns 0 to make civetweb close the connection.
- (int)handleFrameBits:(int)bits data:(const char *)data length:(size_t)length {
    BOOL fin = (bits & 0x80) != 0;
    int opcode = bits & 0x0f;
    switch (opcode) {
        case MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE: {
            pthread_mutex_lock(&_lock);
            BOOL answer = _conn && !_closeSent;
            _closeSent = YES;
            if (answer) {
                // Echo the peer's status code, as RFC 6455 asks.
                uint16_t code = length >= 2 ? (uint16_t)(((uint8_t)data[0] << 8) | (uint8_t)data[1]) : 1000;
                NSData *body = CPWDCloseBody(code);
                mg_websocket_write(_conn, MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE, body.bytes, body.length);
            }
            pthread_mutex_unlock(&_lock);
            return 0;
        }
        case MG_WEBSOCKET_OPCODE_PING: {
            // Only reached when civetweb's own ping handling is off.
            NSData *payload = [NSData dataWithBytes:data length:length];
            dispatch_async(_sendQueue, ^{ [self writeOpcode:MG_WEBSOCKET_OPCODE_PONG data:payload]; });
            return 1;
        }
        case MG_WEBSOCKET_OPCODE_PONG:
            return 1;
        case MG_WEBSOCKET_OPCODE_TEXT:
        case MG_WEBSOCKET_OPCODE_BINARY:
            if (_fragments) return [self failWithCode:1002];   // new message inside a fragmented one
            if (length > CPWDMaxMessageSize) return [self failWithCode:1009];
            if (fin) {
                if (opcode == MG_WEBSOCKET_OPCODE_TEXT) [self deliverMessage:[NSData dataWithBytes:data length:length]];
                return 1;   // binary frames are not part of the protocol; ignore them
            }
            _fragments = [NSMutableData dataWithBytes:data length:length];
            _fragmentOpcode = opcode;
            return 1;
        case MG_WEBSOCKET_OPCODE_CONTINUATION:
            if (!_fragments) return [self failWithCode:1002];
            if (_fragments.length + length > CPWDMaxMessageSize) return [self failWithCode:1009];
            [_fragments appendBytes:data length:length];
            if (fin) {
                NSData *message = _fragments;
                _fragments = nil;
                if (_fragmentOpcode == MG_WEBSOCKET_OPCODE_TEXT) [self deliverMessage:message];
            }
            return 1;
        default:
            return [self failWithCode:1002];
    }
}

- (int)failWithCode:(uint16_t)code {
    _fragments = nil;
    [self writeOpcode:MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE data:CPWDCloseBody(code)];
    return 0;
}

/// Worker thread, exactly once per accepted socket.
- (void)connectionDidClose {
    pthread_mutex_lock(&_lock);
    BOOL already = _closed;
    _closed = YES;
    _conn = NULL;
    pthread_mutex_unlock(&_lock);
    if (already) return;
    [self handshakeDidComplete];   // let queued sends drain (they are dropped now)
    dispatch_async(CPWDQueue(), ^{
        [self.delegate socketDidClose:self];
    });
}

@end

#pragma mark - civetweb callbacks

@interface CPWDServer ()
- (CPWDResponse *)responseForRequest:(CPWDRequest *)request;
- (BOOL)acceptSocket:(CPWDSocket *)socket;
@end

static CPWDSocket *CPWDSocketForConnection(const struct mg_connection *conn) {
    void *data = mg_get_user_connection_data(conn);
    return data ? (__bridge CPWDSocket *)data : nil;
}

/// Drops our reference to the socket stored in the connection, notifying the delegate.
static void CPWDReleaseSocket(const struct mg_connection *conn) {
    void *data = mg_get_user_connection_data(conn);
    if (!data) return;
    mg_set_user_connection_data(conn, NULL);
    CPWDSocket *socket = (__bridge_transfer CPWDSocket *)data;
    [socket connectionDidClose];
}

static int CPWDHandleRequest(struct mg_connection *conn, void *cbdata) {
    @autoreleasepool {
        CPWDServer *server = (__bridge CPWDServer *)cbdata;
        CPWDRequest *request = CPWDRequestFromConnection(conn);
        int bodyStatus = CPWDReadBody(conn, request, server.maxBodySize);
        if (bodyStatus) {
            CPWDResponse *error = [CPWDResponse status:bodyStatus code:bodyStatus == 413 ? @"EINVAL" : @"EINTERNAL"
                                               message:bodyStatus == 413 ? @"request body too large" : @"could not read the request body"];
            error.headers[@"Connection"] = @"close";
            CPWDWriteResponse(conn, request, error);
            return bodyStatus;
        }
        CPWDResponse *response = [server responseForRequest:request];
        CPWDWriteResponse(conn, request, response);
        return response.filePath ? 200 : (int)response.status;
    }
}

static int CPWDWebSocketConnect(const struct mg_connection *conn, void *cbdata) {
    @autoreleasepool {
        CPWDServer *server = (__bridge CPWDServer *)cbdata;
        CPWDRequest *request = CPWDRequestFromConnection(conn);
        CPWDSocket *socket = [[CPWDSocket alloc] initWithConnection:(struct mg_connection *)conn request:request];
        if (![server acceptSocket:socket]) {
            // Still plain HTTP on the wire, so the client can be told why. civetweb
            // already counts the connection as a WebSocket and its response
            // helpers refuse to run, hence the hand-written reply.
            static const char reply[] = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n"
                                        "Content-Length: 10\r\nConnection: close\r\n\r\nForbidden\n";
            mg_write((struct mg_connection *)conn, reply, sizeof(reply) - 1);
            return 1;
        }
        mg_set_user_connection_data(conn, (__bridge_retained void *)socket);
        return 0;
    }
}

static void CPWDWebSocketReady(struct mg_connection *conn, void *cbdata) {
    @autoreleasepool {
        [CPWDSocketForConnection(conn) handshakeDidComplete];
    }
}

static int CPWDWebSocketData(struct mg_connection *conn, int bits, char *data, size_t length, void *cbdata) {
    @autoreleasepool {
        CPWDSocket *socket = CPWDSocketForConnection(conn);
        return socket ? [socket handleFrameBits:bits data:data length:length] : 0;
    }
}

static void CPWDWebSocketClose(const struct mg_connection *conn, void *cbdata) {
    @autoreleasepool {
        CPWDReleaseSocket(conn);
    }
}

// civetweb skips the WebSocket close handler when the handshake fails after
// the connect handler accepted; this catches that case.
static void CPWDConnectionClose(const struct mg_connection *conn) {
    @autoreleasepool {
        CPWDReleaseSocket(conn);
    }
}

static int CPWDLogMessage(const struct mg_connection *conn, const char *message) {
    CPWDLog(@"civetweb: %s", message ?: "");
    return 1;
}

#pragma mark - Server

@implementation CPWDServer {
    struct mg_context *_context;
    NSString *_webSocketPath;
}

+ (void)initializeLibrary {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        unsigned features = mg_init_library(MG_FEATURES_WEBSOCKET);
        if (!(features & MG_FEATURES_WEBSOCKET)) CPWDLog(@"civetweb was built without WebSocket support");
    });
}

+ (void)setSpoolDirectory:(NSString *)path {
    gSpoolDirectory = [path copy];
}

- (instancetype)initWithName:(NSString *)name port:(uint16_t)port webSocketPath:(NSString *)path {
    if ((self = [super init])) {
        _name = [name copy];
        _port = port;
        _webSocketPath = [path copy];
        _threadCount = 8;
        _maxBodySize = 512ull << 20;
    }
    return self;
}

- (BOOL)start {
    if (_context) return YES;
    NSString *listen = [NSString stringWithFormat:@"127.0.0.1:%u", _port];
    NSString *threads = [NSString stringWithFormat:@"%lu", (unsigned long)MAX(_threadCount, (NSUInteger)2)];
    const char *options[] = {
        "listening_ports", listen.UTF8String,
        "num_threads", threads.UTF8String,
        "enable_keep_alive", "yes",
        "keep_alive_timeout_ms", "2000",
        "request_timeout_ms", "30000",
        "websocket_timeout_ms", "30000",
        "enable_websocket_ping_pong", "yes",
        "enable_directory_listing", "no",
        "static_file_cache_control", "no-store",
        "decode_url", "yes",
        "tcp_nodelay", "1",
        NULL,
    };
    struct mg_callbacks callbacks;
    memset(&callbacks, 0, sizeof(callbacks));
    callbacks.log_message = CPWDLogMessage;
    callbacks.connection_close = CPWDConnectionClose;

    char errorText[256] = "";
    struct mg_error_data error = { 0, 0, errorText, sizeof(errorText) };
    struct mg_init_data init = { &callbacks, (__bridge void *)self, options };
    _context = mg_start2(&init, &error);
    if (!_context) {
        CPWDLog(@"%@: cannot listen on %@: %s", _name, listen, errorText[0] ? errorText : "unknown error");
        return NO;
    }
    void *cbdata = (__bridge void *)self;
    mg_set_websocket_handler(_context, _webSocketPath.UTF8String, CPWDWebSocketConnect, CPWDWebSocketReady,
                             CPWDWebSocketData, CPWDWebSocketClose, cbdata);
    mg_set_request_handler(_context, "**", CPWDHandleRequest, cbdata);
    CPWDLog(@"%@: listening on http://%@", _name, listen);
    return YES;
}

- (void)stopAsync {
    struct mg_context *context = _context;
    _context = NULL;
    if (!context) return;
    NSString *name = _name;
    // mg_stop joins the worker threads, and a worker may be waiting in
    // dispatch_sync for CPWDQueue(): stop from somewhere else. The block keeps
    // self (the callbacks' cbdata) alive until civetweb is done with it.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        mg_stop(context);
        CPWDLog(@"%@: stopped", name);
        (void)self;
    });
}

- (CPWDResponse *)responseForRequest:(CPWDRequest *)request {
    __block CPWDResponse *response = nil;
    dispatch_sync(CPWDQueue(), ^{
        @autoreleasepool {
            @try {
                response = [self.delegate server:self handleRequest:request];
            } @catch (NSException *e) {
                CPWDLog(@"%@: %@ %@ threw %@: %@", self.name, request.method, request.path, e.name, e.reason);
                response = [CPWDResponse status:500 code:@"EINTERNAL" message:e.reason ?: e.name];
            }
        }
    });
    return response ?: [CPWDResponse status:503 code:@"EUNAVAILABLE" message:@"server is shutting down"];
}

- (BOOL)acceptSocket:(CPWDSocket *)socket {
    __block BOOL accepted = NO;
    dispatch_sync(CPWDQueue(), ^{
        @autoreleasepool {
            @try {
                accepted = [self.delegate server:self shouldAcceptSocket:socket];
            } @catch (NSException *e) {
                CPWDLog(@"%@: accepting a socket threw %@: %@", self.name, e.name, e.reason);
            }
        }
    });
    return accepted;
}

@end
