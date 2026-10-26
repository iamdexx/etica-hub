import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: WalletStore
    @State private var showSend: Token?
    @State private var showReceive = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Card {
                        Text("Total").font(.caption).foregroundStyle(.secondary)
                        Text(Format.usd(store.totalUSD)).font(.system(size: 40, weight: .bold, design: .rounded))
                        Text(Format.short(store.address ?? "")).font(.footnote.monospaced()).foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            Button { showSend = .egaz } label: { Label("Send", systemImage: "arrow.up") }.buttonStyle(.borderedProminent)
                            Button { showReceive = true } label: { Label("Receive", systemImage: "qrcode") }.buttonStyle(.bordered)
                            Spacer()
                            if store.loading { ProgressView() }
                        }.padding(.top, 4)
                    }
                    Card {
                        Text("Assets").font(.headline)
                        ForEach(Token.all) { token in
                            Button { showSend = token } label: {
                                HStack {
                                    TokenIcon(symbol: token.symbol)
                                    VStack(alignment: .leading) {
                                        Text(token.symbol).fontWeight(.semibold)
                                        Text(token.name).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing) {
                                        Text(Format.amount(store.balances[token.symbol] ?? 0, decimals: token.decimals)).fontWeight(.semibold)
                                        Text(store.usdValue(token).map(Format.usd) ?? "—").font(.caption).foregroundStyle(.secondary)
                                    }
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if token != Token.all.last { Divider().overlay(.white.opacity(0.06)) }
                        }
                    }
                    HistoryView()
                }.padding(16)
            }
            .background(Color(red: 0.016, green: 0.035, blue: 0.027).ignoresSafeArea())
            .navigationTitle("Wallet")
            .refreshable { await store.refresh() }
            .sheet(item: $showSend) { SendView(token: $0) }
            .sheet(isPresented: $showReceive) { ReceiveView() }
        }
    }
}
