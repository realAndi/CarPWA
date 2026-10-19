include $(THEOS)/makefiles/common.mk

TWEAK_NAME = CarPWA

# Shared/ is a link to ../Shared (the app catalog and logging, also used by the launcher).
CarPWA_FILES = Tweak.x CPWAIconSource.m Shared/CPWAAppCatalog.m Shared/CPWALog.m
CarPWA_CFLAGS = -fobjc-arc -I. -IShared -Wno-unguarded-availability-new -DCPWA_LOG_CATEGORY='"tweak"'
CarPWA_FRAMEWORKS = UIKit CoreGraphics ImageIO

include $(THEOS_MAKE_PATH)/tweak.mk
