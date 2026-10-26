import SwiftUI
import VisionKit

struct SendView: View {
    @EnvironmentObject var store: WalletStore
    @Environment(\.dismiss) private var dismiss
    @State var token: Token
    @State private var to = ""
    @State private var amount = ""
    @State private var busy = false
    @State private var scanning = false
    @State private var error: String?
    @State private var txHash: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Asset", selection: $token) { ForEach(Token.all) { Text($0.symbol).tag($0) } }
                Section("To") {
                    HStack {
                        TextField("0x…", text: $to).font(.footnote.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button { scanning = true } label: { Image(systemName: "qrcode.viewfinder") }
                        Button { to = UIPasteboard.general.string ?? to } label: { Image(systemName: "doc.on.clipboard") }
                    }
                }
                Section {
                    HStack {
                        TextField("0.0", text: $amount).keyboardType(.decimalPad)
                        Button("Max") { amount = Format.amount(store.balances[token.symbol] ?? 0, decimals: token.decimals, maxFraction: token.decimals) }
                    }
                } header: { Text("Amount") } footer: {
                    Text("Balance: \(Format.amount(store.balances[token.symbol] ?? 0, decimals: token.decimals)) \(token.symbol). Network fee is paid in EGAZ.")
                }
                PrimaryButton(title: "Send \(token.symbol)", busy: busy) { send() }.listRowBackground(Color.clear)
            }
            .navigationTitle("Send").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $scanning) { QRScanner { code in to = code.replacingOccurrences(of: "ethereum:", with: "").components(separatedBy: "@").first ?? code; scanning = false } }
            .sheet(item: $txHash) { TxResultSheet(hash: $0) }
            .errorAlert($error)
        }
    }

    private func send() {
        busy = true
        Task {
            defer { busy = false }
            do { txHash = try await store.send(token, to: to.trimmingCharacters(in: .whitespaces), amountText: amount) }
            catch { self.error = error.localizedDescription }
        }
    }
}

extension String: @retroactive Identifiable { public var id: String { self } }

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }
    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ s: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            if case .barcode(let b) = added.first ?? allItems.first ?? .barcode(.init()), let v = b.payloadStringValue { onCode(v) }
        }
    }
}
