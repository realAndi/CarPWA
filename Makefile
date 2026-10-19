TARGET := iphone:clang:15.6:15.0
ARCHS = arm64 arm64e
THEOS_PACKAGE_SCHEME = rootless
INSTALL_TARGET_PROCESSES = CarPlay CarPWA

include $(THEOS)/makefiles/common.mk

SUBPROJECTS += libcarpwa Tweak Daemon Launcher
include $(THEOS_MAKE_PATH)/aggregate.mk

# Staged without the /var/jb prefix: the rootless scheme moves everything under it.
CARPWA_STAGE = $(THEOS_STAGING_DIR)

# The JS SDK, the native headers and the bundled demo apps ship in the package.
internal-stage::
	$(ECHO_NOTHING)mkdir -p $(CARPWA_STAGE)/Library/CarPWA/SDK $(CARPWA_STAGE)/Library/CarPWA/Plugins $(CARPWA_STAGE)/usr/include/CarPWA$(ECHO_END)
	$(ECHO_NOTHING)cp sdk/js/carpwa.js sdk/js/carpwa.css sdk/js/carpwa.d.ts $(CARPWA_STAGE)/Library/CarPWA/SDK/$(ECHO_END)
	$(ECHO_NOTHING)cp sdk/native/include/CarPWA/*.h $(CARPWA_STAGE)/usr/include/CarPWA/$(ECHO_END)
	$(ECHO_NOTHING)for app in hello-car:com.carpwa.example.hello terminal:com.carpwa.example.terminal; do \
		dir=$${app%%:*}; id=$${app#*:}; \
		if [ -d examples/$$dir ]; then mkdir -p $(CARPWA_STAGE)/Library/CarPWA/Apps && rsync -a --exclude README.md examples/$$dir/ $(CARPWA_STAGE)/Library/CarPWA/Apps/$$id/; fi; \
	done$(ECHO_END)
