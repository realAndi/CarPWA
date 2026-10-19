//
//  CPWADisplayLink.h — display links that tick with the car screen.
//
//  +[CADisplayLink displayLinkWithTarget:selector:] ticks with the phone's own
//  display, which stops while the phone is locked: the usual state in a car.
//  WebKit drives every page update from such a display link in this process
//  (WKDisplayLinkHandler), so a page drew once and then froze until the
//  scene went to the background and back. Everything the launcher shows is
//  on the car screen, so its display links are made from that screen.
//

#import <Foundation/Foundation.h>

/// Call once, before the first web view.
void CPWAInstallCarDisplayLinks(void);
