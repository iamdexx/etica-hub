import SwiftUI

/// "Mine to this wallet": the phone never mines (App Store rules); it shows the address to paste into the
/// desktop EticaHub Miner and tracks what the pools have paid this wallet.
struct EarnView: View {
    @EnvironmentObject var store: WalletStore
    @State private var eti: (unpaid: Double, paid: Double)?
    @State private var egaz: (unpaid: Double, paid: Double)?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Card {
                        Text("Mine to this wallet").font(.headline)
                        Text("Download the EticaHub Miner on your PC or Mac (eticahub.com/mine), paste this address, press Mine. ETI from your CPU and EGAZ from your GPU land here.").font(.subheadline).foregroundStyle(.secondary)
                        if let img = QR.image(for: store.address ?? "") {
                            Image(uiImage: img).interpolation(.none).resizable().scaledToFit().frame(width: 160, height: 160).padding(8).background(.white).clipShape(RoundedRectangle(cornerRadius: 12)).frame(maxWidth: .infinity)
                        }
                        Button { UIPasteboard.general.string = store.address } label: { Label("Copy address", systemImage: "doc.on.doc") }.buttonStyle(.borderedProminent)
                    }
                    Card {
                        Text("Pool earnings").font(.headline)
                        row("ETI pool", eti)
                        row("EGAZ pool", egaz)
                        Text("Both pools charge 0.5%. ETI pays out from 1.5 ETI, EGAZ every 20 minutes from 0.5 EGAZ.").font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(16)
            }
            .navigationTitle("Mine")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    @ViewBuilder private func row(_ name: String, _ v: (unpaid: Double, paid: Double)?) -> some View {
        HStack {
            Text(name)
            Spacer()
            VStack(alignment: .trailing) {
                Text(v.map { String(format: "%.4f unpaid", $0.unpaid) } ?? "...").font(.subheadline.monospacedDigit())
                Text(v.map { String(format: "%.4f paid", $0.paid) } ?? "no shares yet").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func load() async {
        guard let a = store.address?.lowercased() else { return }
        if let (d, _) = try? await URLSession.shared.data(from: URL(string: "https://etipool.eticahub.com/api/v2/pool/miner/\(a)")!),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let m = j["minerData"] as? [String: Any] {
            let all = Double("\(m["alltimeTokenBalance"] ?? 0)") ?? 0, paid = Double("\(m["tokensReceived"] ?? 0)") ?? 0
            eti = (max(0, all - paid) / 1e18, paid / 1e18)
        }
        if let (d, _) = try? await URLSession.shared.data(from: URL(string: "https://pool.eticahub.com/api/accounts/\(a)")!),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let s = j["stats"] as? [String: Any] {
            let bal = (s["balance"] as? Double ?? 0) + (s["immature"] as? Double ?? 0), paid = s["paid"] as? Double ?? 0
            egaz = (bal / 1e9, paid / 1e9)
        }
    }
}
