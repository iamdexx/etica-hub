import SwiftUI
import BigInt

struct StakeView: View {
    @EnvironmentObject var store: WalletStore
    @State private var unstaking = false
    @State private var amount = ""
    @State private var rate: BigUInt?
    @State private var busy = false
    @State private var error: String?
    @State private var txHash: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("", selection: $unstaking) { Text("Stake ETX").tag(false); Text("Unstake").tag(true) }.pickerStyle(.segmented)
                    HStack {
                        TextField("0.0", text: $amount).keyboardType(.decimalPad)
                        Button("Max") { let t: Token = unstaking ? .stetx : .etx; amount = Format.amount(store.balances[t.symbol] ?? 0, decimals: 18, maxFraction: 18) }
                    }
                } footer: {
                    Text(unstaking
                         ? "Balance \(Format.amount(store.balances["stETX"] ?? 0, decimals: 18)) stETX. Redeems to ETX at the current rate."
                         : "Balance \(Format.amount(store.balances["ETX"] ?? 0, decimals: 18)) ETX. stETX grows in value as protocol fees are harvested; no lockup.")
                }
                Section("Rate") {
                    Text(rate.map { "1 stETX = \(Format.amount($0, decimals: 18)) ETX" } ?? "...").font(.headline.monospacedDigit())
                }
                PrimaryButton(title: unstaking ? "Unstake" : "Stake", busy: busy) { go() }.listRowBackground(Color.clear)
            }
            .navigationTitle("Stake")
            .task { rate = try? await store.client.stakeRate() }
            .sheet(item: $txHash) { TxResultSheet(hash: $0) }
            .errorAlert($error)
        }
    }

    private func go() {
        busy = true
        Task {
            defer { busy = false }
            do { txHash = unstaking ? try await store.unstake(amountText: amount) : try await store.stake(amountText: amount); amount = "" }
            catch { self.error = error.localizedDescription }
        }
    }
}
