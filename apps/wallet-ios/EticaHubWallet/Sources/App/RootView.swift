import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: WalletStore
    var body: some View {
        if store.hasWallet, store.address != nil {
            TabView {
                HomeView().tabItem { Label("Wallet", systemImage: "wallet.pass") }
                SwapView().tabItem { Label("Swap", systemImage: "arrow.left.arrow.right") }
                StakeView().tabItem { Label("Stake", systemImage: "chart.line.uptrend.xyaxis") }
                EarnView().tabItem { Label("Mine", systemImage: "cpu") }
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
            }
            .task { await store.refresh() }
        } else {
            OnboardingView()
        }
    }
}
