import SwiftUI

@main
struct EticaHubWalletApp: App {
    @StateObject private var store = WalletStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .tint(Color("AccentColor"))
                .preferredColorScheme(.dark)
        }
    }
}
