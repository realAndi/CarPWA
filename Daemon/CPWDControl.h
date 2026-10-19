//
//  CPWDControl.h — the control server on 127.0.0.1:<basePort> (protocol.md,
//  "Control server"): what the `carpwa` CLI talks to through its SSH tunnel.
//  Everything except /_carpwa/health needs the X-CarPWA-Token header.
//

#import <Foundation/Foundation.h>
#import "CPWDBridge.h"
#import "CPWDServer.h"

NS_ASSUME_NONNULL_BEGIN

@interface CPWDControl : NSObject <CPWDServerDelegate, CPWDClientOwner>
- (instancetype)initWithPort:(uint16_t)port;
- (BOOL)start;
@end

NS_ASSUME_NONNULL_END
