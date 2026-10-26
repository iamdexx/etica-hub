import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: WalletStore
    @State private var phrase: String?
    @State private var confirmReset = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Address", value: Format.short(store.address ?? ""))
                    Button("Show recovery phrase") {
                        Task { do { phrase = try await store.revealMnemonic() } catch { self.error = error.localizedDescription } }
                    }
                } header: { Text("Wallet") } footer: {
                    Text("Your keys stay on this iPhone, EticaHub never sees them. Your 12 words are the only way to recover this wallet.")
                }
                Section("Network") {
                    LabeledContent("Chain", value: "Etica (61803)")
                    LabeledContent("RPC", value: store.client.activeHost ?? Chain.rpcURLs[0].host ?? "")
                    Link("Explorer", destination: URL(string: "https://eticahub.com/explorer")!)
                    Link("Help and docs", destination: URL(string: "https://eticahub.com/network")!)
                }
                Section("Legal") {
                    Link("Privacy Policy", destination: URL(string: "https://eticahub.com/privacy")!)
                    Link("Terms of Use", destination: URL(string: "https://eticahub.com/terms")!)
                }
                Section {
                    Button("Remove wallet from this iPhone", role: .destructive) { confirmReset = true }
                } footer: { Text("Only your recovery phrase can restore it afterwards.") }
            }
            .navigationTitle("Settings")
            .alert("Recovery phrase", isPresented: Binding(get: { phrase != nil }, set: { if !$0 { phrase = nil } })) {
                Button("Copy") { UIPasteboard.general.string = phrase }
                Button("Close", role: .cancel) {}
            } message: { Text(phrase ?? "") }
            .alert("Remove wallet?", isPresented: $confirmReset) {
                Button("Remove", role: .destructive) { store.reset() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Make sure you have the 12 words written down.") }
            .errorAlert($error)
        }
    }
}
