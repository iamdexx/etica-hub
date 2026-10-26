import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: WalletStore
    @State private var phrase: String?
    @State private var confirmReset = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Wallet") {
                    LabeledContent("Address", value: Format.short(store.address ?? ""))
                    Button("Show recovery phrase") { do { phrase = try store.revealMnemonic() } catch { self.error = error.localizedDescription } }
                }
                Section("Network") {
                    LabeledContent("Chain", value: "Etica (61803)")
                    LabeledContent("RPC", value: "rpc.eticahub.com")
                    Link("Explorer", destination: URL(string: "https://eticahub.com/explorer")!)
                    Link("Help and docs", destination: URL(string: "https://eticahub.com/network")!)
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
