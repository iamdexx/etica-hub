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
        } else if store.needsUnlock {
            UnlockView()
        } else {
            OnboardingView()
        }
    }
}

/// Shown after a reinstall: the recovery phrase is still in the Keychain, so unlock instead of onboarding.
struct UnlockView: View {
    @EnvironmentObject var store: WalletStore
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image("Logo").resizable().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 22))
            Text("Welcome back").font(.largeTitle.bold())
            Text("Your wallet is still on this iPhone. Unlock it with Face ID to continue.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).padding(.horizontal)
            Spacer()
            PrimaryButton(title: "Unlock wallet", busy: busy) { unlock() }
            Button("Remove wallet from this iPhone", role: .destructive) { store.reset() }.padding(.bottom)
        }
        .padding(24)
        .task { unlock() }
        .errorAlert($error)
    }

    private func unlock() {
        busy = true
        Task {
            defer { busy = false }
            do { try await store.restoreAddress() } catch { self.error = error.localizedDescription }
        }
    }
}
