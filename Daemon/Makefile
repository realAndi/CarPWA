# carpwad (launch daemon) and carpwactl (its command-line helper).
#
#   make                 iOS build through Theos (from the repository root: make package)
#   make -C Daemon test  builds both for macOS and runs Daemon/test against them

CIVETWEB_FLAGS = -DNO_SSL -DNO_CGI -DUSE_WEBSOCKET -Ivendor/civetweb
DAEMON_SOURCES = main.m CPWDCore.m CPWDServer.m CPWDManifest.m CPWDStorage.m CPWDNet.m \
                 CPWDBridge.m CPWDApp.m CPWDRegistry.m CPWDControl.m

ifneq ($(filter macos test,$(MAKECMDGOALS)),)

# ------------------------------------------------------------------- macOS

MACOS_DIR = .build/macos
MACOS_CFLAGS = -fobjc-arc -O1 -g -Wall -Werror $(CIVETWEB_FLAGS)
MACOS_LIBS = -framework Foundation -framework Security

.PHONY: macos test

macos: $(MACOS_DIR)/carpwad $(MACOS_DIR)/carpwactl

$(MACOS_DIR)/civetweb.o: vendor/civetweb/civetweb.c vendor/civetweb/civetweb.h
	@mkdir -p $(MACOS_DIR)
	clang -c -O1 -g -w $(CIVETWEB_FLAGS) $< -o $@

$(MACOS_DIR)/carpwad: $(DAEMON_SOURCES) $(wildcard *.h) $(MACOS_DIR)/civetweb.o
	clang $(MACOS_CFLAGS) $(DAEMON_SOURCES) $(MACOS_DIR)/civetweb.o $(MACOS_LIBS) -o $@

$(MACOS_DIR)/carpwactl: carpwactl.m CPWDCore.m CPWDCore.h
	clang $(MACOS_CFLAGS) carpwactl.m CPWDCore.m $(MACOS_LIBS) -o $@

test: macos
	node --test test/*.test.mjs

else

# --------------------------------------------------------------------- iOS

include $(THEOS)/makefiles/common.mk

TOOL_NAME = carpwad carpwactl

carpwad_FILES = $(DAEMON_SOURCES) vendor/civetweb/civetweb.c
carpwad_CFLAGS = -fobjc-arc $(CIVETWEB_FLAGS)
carpwad_FRAMEWORKS = Foundation Security
carpwad_CODESIGN_FLAGS = -Sentitlements.plist
carpwad_INSTALL_PATH = /usr/libexec

# Vendored as-is; its warnings are upstream's business.
vendor/civetweb/civetweb.c_CFLAGS = -w -Wno-error

carpwactl_FILES = carpwactl.m CPWDCore.m
carpwactl_CFLAGS = -fobjc-arc
carpwactl_FRAMEWORKS = Foundation Security
carpwactl_CODESIGN_FLAGS = -Sentitlements.plist
carpwactl_INSTALL_PATH = /usr/bin

include $(THEOS_MAKE_PATH)/tool.mk

endif
