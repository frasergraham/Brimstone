#import <Capacitor/Capacitor.h>

CAP_PLUGIN(GameCenterPlugin, "GameCenterPlugin",
    CAP_PLUGIN_METHOD(authenticate, CAPPluginReturnPromise);
)
