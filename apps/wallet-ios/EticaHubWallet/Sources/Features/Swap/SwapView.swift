import SwiftUI
import BigInt

struct SwapView: View {
    @EnvironmentObject var store: WalletStore
    @State private var from: Token = .egaz
    @State private var to: Token = .etx
    @State private var amount = ""
    @State private var quote: BigUInt?
    @State private var busy = false
    @State private var error: String?
    @State private var txHash: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("You pay") {
                    Picker("From", selection: $from) { ForEach(Token.all.filter { $0 != .stetx }) { Text($0.symbol).tag($0) } }
                    HStack {
                        TextField("0.0", text: $amount).keyboardType(.decimalPad)
                        Button("Max") { amount = Format.amount(store.balances[from.symbol] ?? 0, decimals: from.decimals, maxFraction: from.decimals) }
                    }
                    Text("Balance \(Format.amount(store.balances[from.symbol] ?? 0, decimals: from.decimals)) \(from.symbol)").font(.caption).foregroundStyle(.secondary)
                }
                Section("You get") {
                    Picker("To", selection: $to) { ForEach(Token.all.filter { $0 != from && $0 != .stetx }) { Text($0.symbol).tag($0) } }
                    Text(quote.map { "\(Format.amount($0, decimals: to.decimals)) \(to.symbol)" } ?? "—").font(.title3.bold().monospacedDigit())
                    Text("Routed through ETX on EticaSwap. 1% max slippage, 0.3% pool fee.").font(.caption).foregroundStyle(.secondary)
                }
                PrimaryButton(title: "Swap", busy: busy) { swap() }.listRowBackground(Color.clear).disabled(quote == nil)
            }
            .navigationTitle("Swap")
            .task(id: amount + from.symbol + to.symbol) { await refreshQuote() }
            .onChange(of: from) { if to == from { to = from == .etx ? .egaz : .etx } }
            .sheet(item: $txHash) { TxResultSheet(hash: $0) }
            .errorAlert($error)
        }
    }

    private func refreshQuote() async {
        guard let a = Format.parse(amount, decimals: from.decimals), a > 0 else { quote = nil; return }
        try? await Task.sleep(for: .milliseconds(400))
        quote = try? await store.client.quote(from: from, to: to, amountIn: a)
    }

    private func swap() {
        busy = true
        Task {
            defer { busy = false }
            do { txHash = try await store.swap(from: from, to: to, amountText: amount); amount = "" }
            catch { self.error = error.localizedDescription }
        }
    }
}
