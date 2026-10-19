//
//  CPWAIconSource.h — supplies label, image and launch behaviour for a CarPWA
//  app's icon on the CarPlay home screen (an SBLeafIconDataSource).
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface CPWAIconSource : NSObject
+ (instancetype)sourceForAppID:(NSString *)appID;
@property (nonatomic, copy, readonly) NSString *appID;
/// Drops cached images, e.g. after an app update changed its icon.
+ (void)purgeImageCache;
@end

NS_ASSUME_NONNULL_END
