import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject var store: WalletStore
    @State private var mode: Mode?
    @State private var mnemonic = WalletStore.newMnemonic()
    @State private var imported = ""
    @State private var confirmed = false
    @State private var error: String?
    enum Mode { case create, importPhrase }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()
                Image("Logo").resizable().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 22))
                Text("EticaHub Wallet").font(.largeTitle.bold())
                Text("EGAZ, ETI, ETX, stETX and USDC.e in one place, locked with Face ID.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary).padding(.horizontal)
                Text("Your keys stay on this iPhone, EticaHub never sees them. Your 12 words are the only way to recover this wallet.")
                    .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary).padding(.horizontal)
                Spacer()
                PrimaryButton(title: "Create a new wallet") { mode = .create }
                Button("I already have a recovery phrase") { mode = .importPhrase }.padding(.bottom)
            }
            .padding(24)
            .navigationDestination(item: $mode) { m in
                switch m {
                case .create: createView
                case .importPhrase: importView
                }
            }
            .errorAlert($error)
        }
    }

    private var words: [String] { mnemonic.split(separator: " ").map(String.init) }

    private var createView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Your recovery phrase").font(.title2.bold())
                Text("Write these 12 words down, in order, and keep them offline. Anyone with them controls your funds; nobody can recover them for you.").foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(Array(words.enumerated()), id: \.offset) { i, w in
                        HStack(spacing: 6) { Text("\(i + 1).").foregroundStyle(.secondary).font(.caption); Text(w).fontWeight(.semibold) }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                            .background(.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
                Toggle("I wrote the 12 words down", isOn: $confirmed).padding(.top)
                PrimaryButton(title: "Continue") {
                    do { try store.create(mnemonic: mnemonic) } catch { self.error = error.localizedDescription }
                }.disabled(!confirmed).opacity(confirmed ? 1 : 0.5)
            }.padding(20)
        }
        .navigationTitle("New wallet").navigationBarTitleDisplayMode(.inline)
    }

    private var importView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Paste or type your 12 or 24 word phrase, separated by spaces.").foregroundStyle(.secondary)
            TextEditor(text: $imported).frame(minHeight: 120).padding(8).background(.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 12))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            PrimaryButton(title: "Import wallet") {
                do { try store.create(mnemonic: imported.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)) } catch { self.error = error.localizedDescription }
            }
            Spacer()
        }.padding(20).navigationTitle("Import").navigationBarTitleDisplayMode(.inline)
    }
}
