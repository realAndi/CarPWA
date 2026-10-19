//
//  CPWAFocusCapture.m
//

#import "CPWAFocusCapture.h"

@interface CPWAFocusTarget : UIView
@property (nonatomic, weak) CPWAFocusCaptureView *owner;
@end

@interface CPWAFocusGuide : UIView
@property (nonatomic, weak) CPWAFocusCaptureView *owner;
@end

@interface CPWAFocusCaptureView ()
- (void)selectPhase:(NSString *)phase;
@end

@implementation CPWAFocusTarget

- (BOOL)canBecomeFocused {
    return self.owner.capturing;
}

- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
    BOOL handled = NO;
    for (UIPress *press in presses) {
        if (press.type == UIPressTypeSelect) { [self.owner selectPhase:@"down"]; handled = YES; }
    }
    if (!handled) [super pressesBegan:presses withEvent:event];
}

- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
    BOOL handled = NO;
    for (UIPress *press in presses) {
        if (press.type == UIPressTypeSelect) { [self.owner selectPhase:@"up"]; handled = YES; }
    }
    if (!handled) [super pressesEnded:presses withEvent:event];
}

- (void)pressesCancelled:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
    BOOL handled = NO;
    for (UIPress *press in presses) {
        if (press.type == UIPressTypeSelect) { [self.owner selectPhase:@"up"]; handled = YES; }
    }
    if (!handled) [super pressesCancelled:presses withEvent:event];
}

@end

@implementation CPWAFocusGuide

- (BOOL)canBecomeFocused {
    return self.owner.capturing;
}

@end

@implementation CPWAFocusCaptureView {
    NSArray<CPWAFocusGuide *> *_guides;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        self.userInteractionEnabled = YES;
        self.backgroundColor = UIColor.clearColor;
        CPWAFocusTarget *target = [[CPWAFocusTarget alloc] initWithFrame:CGRectMake(0, 0, 2, 2)];
        target.owner = self;
        target.userInteractionEnabled = YES;
        target.focusEffect = nil;
        _target = target;
        [self addSubview:target];
        NSMutableArray *guides = [NSMutableArray array];
        for (int i = 0; i < 4; i++) {
            CPWAFocusGuide *guide = [[CPWAFocusGuide alloc] initWithFrame:CGRectMake(0, 0, 2, 2)];
            guide.owner = self;
            guide.focusEffect = nil;
            [self addSubview:guide];
            [guides addObject:guide];
        }
        _guides = [guides copy];
    }
    return self;
}

// Touches go through to the web view underneath.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    return nil;
}

- (void)layoutSubviews {
    [super layoutSubviews];
    CGRect b = self.bounds;
    CGFloat midX = CGRectGetMidX(b), midY = CGRectGetMidY(b);
    _target.center = CGPointMake(midX, midY);
    // Top, bottom, left, right: something to move to in every direction,
    // and before/after the target in reading order for knob rotation.
    CGPoint centers[4] = {
        CGPointMake(midX, CGRectGetMinY(b) + 2), CGPointMake(midX, CGRectGetMaxY(b) - 2),
        CGPointMake(CGRectGetMinX(b) + 2, midY), CGPointMake(CGRectGetMaxX(b) - 2, midY),
    };
    for (NSUInteger i = 0; i < _guides.count; i++) _guides[i].center = centers[i];
}

- (void)setCapturing:(BOOL)capturing {
    if (_capturing == capturing) return;
    _capturing = capturing;
    [self setNeedsFocusUpdate];
}

- (NSArray<id<UIFocusEnvironment>> *)preferredFocusEnvironments {
    return _capturing ? @[ _target ] : @[];
}

static NSString *CPWADirection(UIFocusHeading heading) {
    if (heading & UIFocusHeadingNext) return @"next";
    if (heading & UIFocusHeadingPrevious) return @"previous";
    if (heading & UIFocusHeadingUp) return @"up";
    if (heading & UIFocusHeadingDown) return @"down";
    if (heading & UIFocusHeadingLeft) return @"left";
    if (heading & UIFocusHeadingRight) return @"right";
    return nil;
}

- (BOOL)shouldUpdateFocusInContext:(UIFocusUpdateContext *)context {
    if (!_capturing) return [super shouldUpdateFocusInContext:context];
    id next = context.nextFocusedItem;
    BOOL toGuide = [next isKindOfClass:[CPWAFocusGuide class]];
    if (context.previouslyFocusedItem == _target && (toGuide || next == nil)) {
        NSString *direction = CPWADirection(context.focusHeading);
        if (direction) [self.delegate focusCapture:self didMove:direction];
        // Into a guide is allowed (and undone in didUpdateFocusInContext:); out of the view is not.
        return toGuide;
    }
    return YES;
}

// Focus never rests on a guide: it goes back to the target, whether it got
// there from the target or arrived from elsewhere.
- (void)didUpdateFocusInContext:(UIFocusUpdateContext *)context withAnimationCoordinator:(UIFocusAnimationCoordinator *)coordinator {
    [super didUpdateFocusInContext:context withAnimationCoordinator:coordinator];
    if (_capturing && [context.nextFocusedItem isKindOfClass:[CPWAFocusGuide class]]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self setNeedsFocusUpdate]; [self updateFocusIfNeeded]; });
    }
}

- (void)selectPhase:(NSString *)phase {
    [self.delegate focusCapture:self didSelect:phase];
}

@end
