//
//  CPWAOverlay.m
//

#import "CPWAOverlay.h"

static UIColor *CPWADynamic(UIColor *light, UIColor *dark) {
    return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
        return traits.userInterfaceStyle == UIUserInterfaceStyleDark ? dark : light;
    }];
}

@implementation CPWAAlertView {
    void (^_completion)(NSString *);
    NSArray<NSDictionary *> *_actions;
    UIView *_card;
    BOOL _done;
}

- (instancetype)initWithTitle:(NSString *)title message:(NSString *)message actions:(NSArray<NSDictionary *> *)actions
                   completion:(void (^)(NSString *))completion {
    if ((self = [super initWithFrame:CGRectZero])) {
        _completion = [completion copy];
        NSMutableArray *clean = [NSMutableArray array];
        for (NSDictionary *a in actions) {
            if (![a isKindOfClass:[NSDictionary class]]) continue;
            NSString *actionID = [a[@"id"] isKindOfClass:[NSString class]] ? a[@"id"] : nil;
            NSString *actionTitle = [a[@"title"] isKindOfClass:[NSString class]] ? a[@"title"] : actionID;
            if (!actionID.length || !actionTitle.length) continue;
            [clean addObject:@{ @"id": actionID, @"title": actionTitle,
                                @"style": [a[@"style"] isKindOfClass:[NSString class]] ? a[@"style"] : @"default" }];
        }
        if (clean.count == 0) [clean addObject:@{ @"id": @"ok", @"title": @"OK", @"style": @"default" }];
        _actions = [clean copy];
        [self buildWithTitle:title message:message];
    }
    return self;
}

- (void)buildWithTitle:(NSString *)title message:(NSString *)message {
    self.backgroundColor = [UIColor colorWithWhite:0 alpha:0.45];
    self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;

    _card = [UIView new];
    _card.translatesAutoresizingMaskIntoConstraints = NO;
    _card.backgroundColor = CPWADynamic([UIColor colorWithWhite:0.96 alpha:1], [UIColor colorWithWhite:0.17 alpha:1]);
    _card.layer.cornerRadius = 18;
    _card.layer.cornerCurve = kCACornerCurveContinuous;
    [self addSubview:_card];

    UIStackView *stack = [UIStackView new];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = 8;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [_card addSubview:stack];

    if (title.length) {
        UILabel *label = [UILabel new];
        label.text = title;
        label.font = [UIFont systemFontOfSize:22 weight:UIFontWeightSemibold];
        label.textColor = UIColor.labelColor;
        label.textAlignment = NSTextAlignmentCenter;
        label.numberOfLines = 2;
        [stack addArrangedSubview:label];
    }
    if (message.length) {
        UILabel *label = [UILabel new];
        label.text = message;
        label.font = [UIFont systemFontOfSize:18];
        label.textColor = UIColor.secondaryLabelColor;
        label.textAlignment = NSTextAlignmentCenter;
        label.numberOfLines = 4;
        [stack addArrangedSubview:label];
    }

    UIStackView *row = [UIStackView new];
    row.axis = _actions.count <= 2 ? UILayoutConstraintAxisHorizontal : UILayoutConstraintAxisVertical;
    row.distribution = UIStackViewDistributionFillEqually;
    row.spacing = 10;
    NSMutableArray *buttons = [NSMutableArray array];
    for (NSUInteger i = 0; i < _actions.count; i++) {
        NSDictionary *a = _actions[i];
        UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
        [button setTitle:a[@"title"] forState:UIControlStateNormal];
        BOOL cancel = [a[@"style"] isEqualToString:@"cancel"];
        BOOL destructive = [a[@"style"] isEqualToString:@"destructive"];
        button.titleLabel.font = [UIFont systemFontOfSize:20 weight:cancel ? UIFontWeightRegular : UIFontWeightSemibold];
        [button setTitleColor:destructive ? UIColor.systemRedColor : UIColor.labelColor forState:UIControlStateNormal];
        button.backgroundColor = CPWADynamic([UIColor colorWithWhite:0.88 alpha:1], [UIColor colorWithWhite:0.28 alpha:1]);
        button.layer.cornerRadius = 12;
        button.layer.cornerCurve = kCACornerCurveContinuous;
        button.tag = (NSInteger)i;
        [button.heightAnchor constraintGreaterThanOrEqualToConstant:52].active = YES;
        [button addTarget:self action:@selector(tapped:) forControlEvents:UIControlEventPrimaryActionTriggered];
        [row addArrangedSubview:button];
        [buttons addObject:button];
    }
    _buttons = [buttons copy];
    [stack setCustomSpacing:18 afterView:stack.arrangedSubviews.lastObject ?: row];
    [stack addArrangedSubview:row];

    [NSLayoutConstraint activateConstraints:@[
        [_card.centerXAnchor constraintEqualToAnchor:self.safeAreaLayoutGuide.centerXAnchor],
        [_card.centerYAnchor constraintEqualToAnchor:self.safeAreaLayoutGuide.centerYAnchor],
        [_card.widthAnchor constraintLessThanOrEqualToConstant:460],
        [_card.widthAnchor constraintLessThanOrEqualToAnchor:self.safeAreaLayoutGuide.widthAnchor constant:-32],
        [_card.heightAnchor constraintLessThanOrEqualToAnchor:self.safeAreaLayoutGuide.heightAnchor constant:-24],
        [stack.topAnchor constraintEqualToAnchor:_card.topAnchor constant:22],
        [stack.bottomAnchor constraintEqualToAnchor:_card.bottomAnchor constant:-18],
        [stack.leadingAnchor constraintEqualToAnchor:_card.leadingAnchor constant:20],
        [stack.trailingAnchor constraintEqualToAnchor:_card.trailingAnchor constant:-20],
    ]];
    NSLayoutConstraint *wide = [_card.widthAnchor constraintEqualToConstant:460];
    wide.priority = UILayoutPriorityDefaultHigh;
    wide.active = YES;
}

- (void)presentInView:(UIView *)container {
    self.frame = container.bounds;
    self.alpha = 0;
    [container addSubview:self];
    _card.transform = CGAffineTransformMakeScale(1.08, 1.08);
    [UIView animateWithDuration:0.2 animations:^{
        self.alpha = 1;
        self->_card.transform = CGAffineTransformIdentity;
    }];
}

- (void)tapped:(UIButton *)button {
    NSUInteger i = (NSUInteger)button.tag;
    [self dismissWithActionID:i < _actions.count ? _actions[i][@"id"] : nil];
}

- (void)cancel {
    for (NSDictionary *a in _actions) {
        if ([a[@"style"] isEqualToString:@"cancel"]) { [self dismissWithActionID:a[@"id"]]; return; }
    }
    [self dismissWithActionID:nil];
}

- (void)dismissWithActionID:(NSString *)actionID {
    if (_done) return;
    _done = YES;
    void (^completion)(NSString *) = _completion;
    _completion = nil;
    [UIView animateWithDuration:0.15 animations:^{ self.alpha = 0; } completion:^(BOOL finished) {
        [self removeFromSuperview];
    }];
    if (completion) completion(actionID);
}

// The knob lands on the first button and stays inside the alert.
- (NSArray<id<UIFocusEnvironment>> *)preferredFocusEnvironments {
    return _buttons.count ? @[ _buttons.firstObject ] : @[];
}

@end

@implementation CPWABannerView

+ (void)showInView:(UIView *)container title:(NSString *)title subtitle:(NSString *)subtitle duration:(NSTimeInterval)duration {
    CPWABannerView *banner = [CPWABannerView new];
    banner.translatesAutoresizingMaskIntoConstraints = NO;
    banner.backgroundColor = CPWADynamic([UIColor colorWithWhite:0.97 alpha:0.97], [UIColor colorWithWhite:0.2 alpha:0.97]);
    banner.layer.cornerRadius = 16;
    banner.layer.cornerCurve = kCACornerCurveContinuous;
    banner.layer.shadowColor = UIColor.blackColor.CGColor;
    banner.layer.shadowOpacity = 0.25;
    banner.layer.shadowRadius = 12;
    banner.layer.shadowOffset = CGSizeMake(0, 4);
    banner.userInteractionEnabled = YES;

    UIStackView *stack = [UIStackView new];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = 2;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    UILabel *titleLabel = [UILabel new];
    titleLabel.text = title;
    titleLabel.font = [UIFont systemFontOfSize:18 weight:UIFontWeightSemibold];
    titleLabel.textColor = UIColor.labelColor;
    [stack addArrangedSubview:titleLabel];
    if (subtitle.length) {
        UILabel *sub = [UILabel new];
        sub.text = subtitle;
        sub.font = [UIFont systemFontOfSize:16];
        sub.textColor = UIColor.secondaryLabelColor;
        sub.numberOfLines = 2;
        [stack addArrangedSubview:sub];
    }
    [banner addSubview:stack];
    [container addSubview:banner];
    NSLayoutConstraint *hidden = [banner.bottomAnchor constraintEqualToAnchor:container.topAnchor];
    NSLayoutConstraint *shown = [banner.topAnchor constraintEqualToAnchor:container.safeAreaLayoutGuide.topAnchor constant:10];
    [NSLayoutConstraint activateConstraints:@[
        hidden,
        [banner.centerXAnchor constraintEqualToAnchor:container.centerXAnchor],
        [banner.widthAnchor constraintLessThanOrEqualToConstant:520],
        [banner.widthAnchor constraintLessThanOrEqualToAnchor:container.safeAreaLayoutGuide.widthAnchor constant:-32],
        [stack.topAnchor constraintEqualToAnchor:banner.topAnchor constant:12],
        [stack.bottomAnchor constraintEqualToAnchor:banner.bottomAnchor constant:-12],
        [stack.leadingAnchor constraintEqualToAnchor:banner.leadingAnchor constant:18],
        [stack.trailingAnchor constraintEqualToAnchor:banner.trailingAnchor constant:-18],
    ]];
    [container layoutIfNeeded];
    hidden.active = NO;
    shown.active = YES;
    [UIView animateWithDuration:0.3 delay:0 usingSpringWithDamping:0.85 initialSpringVelocity:0 options:0
                     animations:^{ [container layoutIfNeeded]; } completion:nil];

    __weak CPWABannerView *weakBanner = banner;
    void (^hide)(void) = ^{
        CPWABannerView *b = weakBanner;
        if (!b || !b.superview) return;
        [UIView animateWithDuration:0.25 animations:^{ b.alpha = 0; } completion:^(BOOL finished) { [b removeFromSuperview]; }];
    };
    UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:banner action:@selector(dismiss)];
    [banner addGestureRecognizer:tap];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(duration * NSEC_PER_SEC)), dispatch_get_main_queue(), hide);
}

- (void)dismiss {
    [UIView animateWithDuration:0.2 animations:^{ self.alpha = 0; } completion:^(BOOL finished) { [self removeFromSuperview]; }];
}

@end
