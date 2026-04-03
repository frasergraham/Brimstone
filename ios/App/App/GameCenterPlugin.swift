import Foundation
import Capacitor
import GameKit

/// Capacitor plugin exposing Game Center authentication to the web layer.
/// Usage from JS: `await Capacitor.Plugins.GameCenterPlugin.authenticate()`
@objc(GameCenterPlugin)
class GameCenterPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GameCenterPlugin"
    let jsName = "GameCenterPlugin"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    @objc func authenticate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let localPlayer = GKLocalPlayer.local
            localPlayer.authenticateHandler = { [weak self] viewController, error in
                if let vc = viewController {
                    // Present the Game Center sign-in sheet
                    self?.bridge?.viewController?.present(vc, animated: true)
                    return
                }

                if let error = error {
                    call.reject("Game Center authentication failed", nil, error)
                    return
                }

                if localPlayer.isAuthenticated {
                    call.resolve([
                        "playerId": localPlayer.gamePlayerID,
                        "displayName": localPlayer.displayName,
                        "alias": localPlayer.alias
                    ])
                } else {
                    call.reject("Game Center not available")
                }
            }
        }
    }
}
