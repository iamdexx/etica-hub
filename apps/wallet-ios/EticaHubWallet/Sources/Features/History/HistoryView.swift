import SwiftUI
import BigInt

struct HistoryView: View {
    @EnvironmentObject var store: WalletStore
    var body: some View {
        Card {
            Text("Activity").font(.headline)
            if store.history.isEmpty {
                Text("No transactions yet.").foregroundStyle(.secondary).font(.subheadline)
            }
            ForEach(store.history.prefix(25)) { tx in
                let outgoing = tx.from.lowercased() == (store.address ?? "").lowercased()
                Link(destination: URL(string: Chain.explorerTx + tx.hash)!) {
                    HStack {
                        Image(systemName: outgoing ? "arrow.up.right" : "arrow.down.left").foregroundStyle(outgoing ? .orange : Color.accentColor)
                        VStack(alignment: .leading) {
                            Text(outgoing ? "Sent to \(Format.short(tx.to))" : "Received from \(Format.short(tx.from))").font(.subheadline)
                            Text(tx.time, style: .relative).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(outgoing ? "-" : "+")\(Format.amount(BigUInt(tx.value) ?? 0, decimals: tx.decimals)) \(tx.tokenSymbol)")
                            .font(.subheadline.monospacedDigit()).foregroundStyle(tx.failed ? .red : .primary)
                    }
                }.buttonStyle(.plain)
            }
        }
    }
}
