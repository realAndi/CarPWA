//
//  CPWALocationModule.m — `location` (permission `location`): the phone's
//  position through Core Location, as the launcher. Updates only run while a
//  page watches or a getCurrent call waits.
//

#import "CPWAModules.h"
#import "CPWALog.h"
#import <CoreLocation/CoreLocation.h>

@interface CPWALocationProvider : NSObject <CLLocationManagerDelegate>
@property (nonatomic, strong) CLLocationManager *manager;
@property (nonatomic, weak) CPWAModule *module;
@property (nonatomic) BOOL watching;
@property (nonatomic, strong) NSMutableArray *waiters;   // { reply, timer }
@end

static NSDictionary *CPWAFix(CLLocation *l) {
    return @{
        @"latitude": @(l.coordinate.latitude),
        @"longitude": @(l.coordinate.longitude),
        @"altitude": l.verticalAccuracy >= 0 ? @(l.altitude) : [NSNull null],
        @"horizontalAccuracy": @(l.horizontalAccuracy),
        @"verticalAccuracy": l.verticalAccuracy >= 0 ? @(l.verticalAccuracy) : [NSNull null],
        @"speed": l.speed >= 0 ? @(l.speed) : [NSNull null],
        @"course": l.course >= 0 ? @(l.course) : [NSNull null],
        @"timestamp": @(floor(l.timestamp.timeIntervalSince1970 * 1000)),
    };
}

@implementation CPWALocationProvider

- (instancetype)init {
    if ((self = [super init])) {
        _waiters = [NSMutableArray array];
    }
    return self;
}

- (CLLocationManager *)manager {
    if (!_manager) {
        _manager = [CLLocationManager new];
        _manager.delegate = self;
        _manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation;
        _manager.activityType = CLActivityTypeAutomotiveNavigation;
        _manager.pausesLocationUpdatesAutomatically = NO;
    }
    return _manager;
}

/// nil when updates can run; otherwise why not.
- (NSError *)availabilityError {
    if (![CLLocationManager locationServicesEnabled]) {
        return CPWAMakeError(CPWAErrorUnavailable, @"Location Services are off on this iPhone");
    }
    CLAuthorizationStatus status = self.manager.authorizationStatus;
    if (status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted) {
        return CPWAMakeError(CPWAErrorUnavailable, @"CarPWA is not allowed to use location (status %d)", (int)status);
    }
    if (status == kCLAuthorizationStatusNotDetermined) [self.manager requestWhenInUseAuthorization];
    return nil;
}

- (void)updateRunning {
    BOOL want = self.watching || self.waiters.count > 0;
    if (want) [self.manager startUpdatingLocation];
    else if (_manager) [_manager stopUpdatingLocation];
}

- (void)getCurrentWithTimeout:(NSTimeInterval)timeout maxAge:(NSTimeInterval)maxAge reply:(CPWAReply)reply {
    NSError *error = [self availabilityError];
    if (error) { reply(nil, error); return; }
    CLLocation *last = self.manager.location;
    if (last && -last.timestamp.timeIntervalSinceNow <= maxAge && last.horizontalAccuracy >= 0) {
        reply(CPWAFix(last), nil);
        return;
    }
    NSMutableDictionary *waiter = [NSMutableDictionary dictionaryWithObject:[reply copy] forKey:@"reply"];
    [self.waiters addObject:waiter];
    [self updateRunning];
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        typeof(self) self_ = weakSelf;
        if (![self_.waiters containsObject:waiter]) return;
        [self_.waiters removeObject:waiter];
        [self_ updateRunning];
        ((CPWAReply)waiter[@"reply"])(nil, CPWAMakeError(@"ETIMEOUT", @"no location fix within %.0f s", timeout));
    });
}

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    CLLocation *l = locations.lastObject;
    if (!l || l.horizontalAccuracy < 0) return;
    NSDictionary *fix = CPWAFix(l);
    NSArray *waiters = [self.waiters copy];
    [self.waiters removeAllObjects];
    for (NSDictionary *w in waiters) ((CPWAReply)w[@"reply"])(fix, nil);
    if (self.watching) [self.module emit:@"update" data:fix];
    [self updateRunning];
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    if ([error.domain isEqualToString:kCLErrorDomain] && error.code == kCLErrorLocationUnknown) return;   // transient
    NSString *message = error.localizedDescription ?: @"location failed";
    NSArray *waiters = [self.waiters copy];
    [self.waiters removeAllObjects];
    for (NSDictionary *w in waiters) ((CPWAReply)w[@"reply"])(nil, CPWAMakeError(CPWAErrorUnavailable, @"%@", message));
    if (self.watching) [self.module emit:@"error" data:@{ @"code": @"EUNAVAILABLE", @"message": message }];
    [self updateRunning];
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    CPWALog(@"location: authorization is now %d", (int)manager.authorizationStatus);
    NSError *error = [self availabilityError];
    if (error && self.watching) {
        [self.module emit:@"error" data:@{ @"code": CPWAErrorCode(error), @"message": error.localizedDescription }];
    }
}

@end

CPWAModule *CPWAMakeLocationModule(void) {
    CPWAModule *m = [[CPWAModule alloc] initWithName:@"location"];
    m.permission = @"location";
    [m addEvent:@"update"];
    [m addEvent:@"error"];
    CPWALocationProvider *provider = [CPWALocationProvider new];
    provider.module = m;
    static NSMutableSet *observed;
    observed = [NSMutableSet set];
    m.didStartObserving = ^(NSString *event) {
        [observed addObject:event];
        if ([event isEqualToString:@"error"]) return;
        provider.watching = YES;
        NSError *error = [provider availabilityError];
        if (error) [provider.module emit:@"error" data:@{ @"code": CPWAErrorCode(error), @"message": error.localizedDescription }];
        [provider updateRunning];
    };
    m.didStopObserving = ^(NSString *event) {
        [observed removeObject:event];
        provider.watching = [observed containsObject:@"update"] || [observed containsObject:@"*"];
        [provider updateRunning];
    };
    [m addMethod:@"getCurrent" handler:^(NSDictionary *params, CPWACallContext *ctx, CPWAReply reply) {
        double timeout = CPWAParamNumber(params, @"timeout") ? CPWAParamNumber(params, @"timeout").doubleValue : 10000;
        double maxAge = CPWAParamNumber(params, @"maxAge") ? CPWAParamNumber(params, @"maxAge").doubleValue : 5000;
        // Milliseconds in the API, like the Geolocation API's options.
        [provider getCurrentWithTimeout:MIN(MAX(timeout, 500), 14000) / 1000.0 maxAge:MAX(maxAge, 0) / 1000.0 reply:reply];
    }];
    return m;
}
