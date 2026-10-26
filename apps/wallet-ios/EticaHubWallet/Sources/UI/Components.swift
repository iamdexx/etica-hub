import SwiftUI

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.047, green: 0.102, blue: 0.075))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.08)))
    }
}

struct PrimaryButton: View {
    let title: String
    var busy = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack { if busy { ProgressView().tint(.black) }; Text(title).fontWeight(.bold) }
                .frame(maxWidth: .infinity).padding(.vertical, 15)
                .background(LinearGradient(colors: [Color(red: 0.5, green: 0.89, blue: 0.69), Color(red: 0.33, green: 0.76, blue: 0.54)], startPoint: .leading, endPoint: .trailing))
                .foregroundStyle(.black).clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .disabled(busy)
    }
}

struct TokenIcon: View {
    let symbol: String
    var body: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.18))
            Text(String(symbol.prefix(symbol.hasPrefix("st") ? 2 : 1))).font(.headline).foregroundStyle(Color.accentColor)
        }.frame(width: 40, height: 40)
    }
}

struct TxResultSheet: View {
    let hash: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Color.accentColor)
            Text("Sent").font(.title2.bold())
            Text(hash).font(.footnote.monospaced()).multilineTextAlignment(.center).foregroundStyle(.secondary).padding(.horizontal)
            Link("View on explorer", destination: URL(string: Chain.explorerTx + hash)!)
            PrimaryButton(title: "Done") { dismiss() }.padding(.top)
        }.padding(24).presentationDetents([.medium])
    }
}

extension View {
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert("Something went wrong", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(message.wrappedValue ?? "") }
    }
}
