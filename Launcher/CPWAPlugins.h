//
//  CPWAPlugins.h — loads native plugins from <jbroot>/Library/CarPWA/Plugins.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// dlopens every *.dylib in the plugins folder, once. Call after the built-in
/// modules are registered, so plugins can see (and replace) them.
void CPWALoadPlugins(void);

/// File names of the plugins that loaded.
NSArray<NSString *> *CPWALoadedPlugins(void);

NS_ASSUME_NONNULL_END
