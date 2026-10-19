//
//  CPWAOverlay.h — `ui.alert` and `ui.banner`, drawn by CarPWA over the page.
//  UIAlertController is not used: it is laid out for the phone, not for a
//  car screen driven by a knob.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface CPWAAlertView : UIView

/// `actions`: `{ id, title, style?: "default"|"cancel"|"destructive" }`. Empty means one "OK".
- (instancetype)initWithTitle:(nullable NSString *)title
                      message:(nullable NSString *)message
                      actions:(NSArray<NSDictionary *> *)actions
                   completion:(void (^)(NSString * _Nullable actionID))completion;

- (void)presentInView:(UIView *)container;
/// Dismisses as if the action was chosen (nil: dismissed without a choice).
- (void)dismissWithActionID:(nullable NSString *)actionID;
/// Back button: picks the cancel action if there is one.
- (void)cancel;

@property (nonatomic, readonly) NSArray<UIButton *> *buttons;

@end

@interface CPWABannerView : UIView
+ (void)showInView:(UIView *)container title:(NSString *)title subtitle:(nullable NSString *)subtitle duration:(NSTimeInterval)duration;
@end

NS_ASSUME_NONNULL_END
