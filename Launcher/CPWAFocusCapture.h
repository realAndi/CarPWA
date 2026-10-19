//
//  CPWAFocusCapture.h — turns knob, touchpad and D-pad input into
//  `input.move` / `input.select` while the page captures input.
//
//  CarPlay has no API for raw knob events; it moves UIKit focus. So a small
//  focusable target sits in the middle with invisible focusable guides around
//  it. Every move the focus engine proposes (target → guide) becomes a
//  direction, and focus goes straight back to the target. The move itself is
//  allowed: a refused one is reported to CarPlay, which then moves focus out
//  of the launcher to its sidebar. Select presses on the target become
//  `select` down/up.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@class CPWAFocusCaptureView;

@protocol CPWAFocusCaptureDelegate <NSObject>
/// "up", "down", "left", "right", "next" or "previous".
- (void)focusCapture:(CPWAFocusCaptureView *)capture didMove:(NSString *)direction;
/// "down" or "up".
- (void)focusCapture:(CPWAFocusCaptureView *)capture didSelect:(NSString *)phase;
@end

@interface CPWAFocusCaptureView : UIView
@property (nonatomic, weak, nullable) id<CPWAFocusCaptureDelegate> delegate;
/// NO: nothing here can take focus, so focus goes to the web view.
@property (nonatomic, getter=isCapturing) BOOL capturing;
/// The view that holds focus while capturing.
@property (nonatomic, readonly) UIView *target;
@end

NS_ASSUME_NONNULL_END
