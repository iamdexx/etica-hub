import SwiftUI
import CoreImage.CIFilterBuiltins

struct ReceiveView: View {
    @EnvironmentObject var store: WalletStore
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let img = QR.image(for: store.address ?? "") {
                    Image(uiImage: img).interpolation(.none).resizable().scaledToFit().frame(width: 240, height: 240)
                        .padding(12).background(.white).clipShape(RoundedRectangle(cornerRadius: 16))
                }
                Text(store.address ?? "").font(.footnote.monospaced()).multilineTextAlignment(.center).padding(.horizontal)
                Text("Works for EGAZ, ETI, ETX, stETX and USDC.e on EticaChain (chain 61803).").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                HStack {
                    Button { UIPasteboard.general.string = store.address; copied = true } label: { Label(copied ? "Copied" : "Copy address", systemImage: "doc.on.doc") }.buttonStyle(.borderedProminent)
                    ShareLink(item: store.address ?? "") { Label("Share", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
                }
                Spacer()
            }.padding(24)
            .navigationTitle("Receive").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

enum QR {
    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
