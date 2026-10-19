# The launcher: CarPWA.app (com.andi.carpwa.launcher), the CarPlay app the
# pages run in. Shared/ is a link to ../Shared (app catalog, logging,
# CPWALauncher.h), also used by the tweak.

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME = CarPWA

CarPWA_FILES = main.m CPWAPresenter.m CPWAHostViewController.m CPWAFocusCapture.m CPWAOverlay.m \
               CPWACarState.m CPWACarKit.m CPWADashboardLink.m CPWADisplayLink.m CPWAPlugins.m \
               Shared/CPWAAppCatalog.m Shared/CPWALog.m $(wildcard Modules/*.m)
CarPWA_CFLAGS = -fobjc-arc -I../sdk/native/include -I. -IShared -Wno-unguarded-availability-new -DCPWA_LOG_CATEGORY='"launcher"'
CarPWA_FRAMEWORKS = UIKit WebKit CoreLocation CoreGraphics ImageIO QuartzCore
CarPWA_CODESIGN_FLAGS = -SCarPWA.entitlements
CarPWA_RESOURCE_FILES = ../examples/hello-car/icon.png
# libcarpwa from the sibling subproject: in the shared object folder when
# built from the repository root, in its own when the launcher is built alone.
CarPWA_LDFLAGS = -L$(THEOS_OBJ_DIR) -L../libcarpwa/$(_THEOS_RELATIVE_DATA_DIR)/$(THEOS_OBJ_DIR_NAME) -lcarpwa

include $(THEOS_MAKE_PATH)/application.mk
