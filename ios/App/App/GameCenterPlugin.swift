import Foundation
import Capacitor
import GameKit
import UIKit

/// Capacitor plugin exposing Game Center and native sharing to the web layer.
/// Usage from JS: `await Capacitor.Plugins.GameCenterPlugin.authenticate()`
@objc(GameCenterPlugin)
class GameCenterPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GameCenterPlugin"
    let jsName = "GameCenterPlugin"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadFriends", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareInvite", returnType: CAPPluginReturnPromise),
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

    @objc func loadFriends(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else {
            call.reject("Not authenticated with Game Center")
            return
        }

        Task {
            do {
                let friends = try await GKLocalPlayer.local.loadFriends()
                let result = friends.map { player in
                    [
                        "gamePlayerID": player.gamePlayerID,
                        "displayName": player.displayName,
                        "alias": player.alias,
                    ]
                }
                call.resolve(["friends": result])
            } catch {
                call.reject("Failed to load friends", nil, error)
            }
        }
    }

    @objc func shareInvite(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let urlString = call.getString("url") ?? ""

        var items: [Any] = []
        if !text.isEmpty { items.append(text) }
        if let url = URL(string: urlString) { items.append(url) }

        guard !items.isEmpty else {
            call.reject("Nothing to share")
            return
        }

        DispatchQueue.main.async { [weak self] in
            let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
            // iPad requires a popover anchor or it will crash
            if let popover = vc.popoverPresentationController {
                popover.sourceView = self?.bridge?.viewController?.view
                popover.sourceRect = CGRect(
                    x: UIScreen.main.bounds.midX,
                    y: UIScreen.main.bounds.midY,
                    width: 0, height: 0
                )
                popover.permittedArrowDirections = []
            }
            self?.bridge?.viewController?.present(vc, animated: true) {
                call.resolve()
            }
        }
    }
}
