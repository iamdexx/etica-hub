import Foundation
import BigInt
import LocalAuthentication
import web3swift
import Web3Core

@MainActor
final class WalletStore: ObservableObject {
    @Published var address: String?
    @Published var balances: [String: BigUInt] = [:]
    @Published var prices: [String: Double] = [:]
    @Published var history: [TxRecord] = []
    @Published var loading = false
    @Published var error: String?
    @Published var hasWallet: Bool
    @Published var gasPrice: BigUInt = EticaClient.minGasPrice

    let client = EticaClient()
    private var keystore: BIP32Keystore?
    private static let password = "eticahub-wallet" // keystore wrapper only; the mnemonic itself sits in the Keychain behind Face ID
    private static let addressKey = "wallet.address"
    static let sendGasLimit = BigUInt(21_000)
    static let swapGasLimit = BigUInt(250_000)

    /// The phrase lives in the Keychain, which survives a reinstall, so Keychain presence is the source of truth.
    /// The cached address lives in UserDefaults; if it is gone (reinstall) `restoreAddress` re-derives it after Face ID.
    init() {
        hasWallet = Keychain.exists()
        address = UserDefaults.standard.string(forKey: Self.addressKey)
    }

    /// True after a reinstall: phrase still in the Keychain but no cached address.
    var needsUnlock: Bool { hasWallet && address == nil }

    var ethAddress: EthereumAddress? { address.flatMap { EthereumAddress($0) } }

    // MARK: lifecycle

    static func newMnemonic() -> String {
        (try? BIP39.generateMnemonics(bitsOfEntropy: 128)) ?? ""
    }

    func create(mnemonic: String) throws {
        guard !Keychain.exists() else { throw WalletError.walletExists }
        let words = mnemonic.split(separator: " ").map(String.init)
        guard words.count == 12 || words.count == 24, BIP39.mnemonicsToEntropy(words.joined(separator: " ")) != nil else { throw WalletError.badMnemonic }
        guard let ks = try BIP32Keystore(mnemonics: words.joined(separator: " "), password: Self.password, mnemonicsPassword: ""),
              let addr = ks.addresses?.first else { throw WalletError.badMnemonic }
        try Keychain.save(mnemonic: words.joined(separator: " "))
        keystore = ks
        address = addr.address
        UserDefaults.standard.set(addr.address, forKey: Self.addressKey)
        hasWallet = true
        Task { await refresh() }
    }

    /// Face ID / passcode check. Runs before every signing action and before showing the phrase,
    /// even when the keystore is already cached in memory.
    private func authenticate(reason: String) async throws -> LAContext {
        let ctx = LAContext()
        ctx.localizedReason = reason
        do {
            guard try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else { throw WalletError.keychain("cancelled") }
        } catch let e as LAError where e.code == .userCancel || e.code == .appCancel || e.code == .systemCancel {
            throw WalletError.keychain("cancelled")
        } catch let e as LAError where e.code == .passcodeNotSet {
            throw WalletError.keychain("Set a passcode or Face ID on this iPhone first")
        } catch let e as WalletError { throw e }
        catch { throw WalletError.keychain(error.localizedDescription) }
        return ctx
    }

    /// Face ID, then the signing key for one action.
    private func unlock(reason: String) async throws -> BIP32Keystore {
        let ctx = try await authenticate(reason: reason)
        if let ks = keystore { return ks }
        let mnemonic = try Keychain.load(reason: reason, context: ctx)
        guard let ks = try BIP32Keystore(mnemonics: mnemonic, password: Self.password, mnemonicsPassword: "") else { throw WalletError.badMnemonic }
        keystore = ks
        return ks
    }

    func revealMnemonic() async throws -> String {
        let reason = "Show your recovery phrase"
        let ctx = try await authenticate(reason: reason)
        return try Keychain.load(reason: reason, context: ctx)
    }

    /// After a reinstall: derive the address again from the stored phrase (Face ID).
    func restoreAddress() async throws {
        let ks = try await unlock(reason: "Unlock your wallet")
        guard let addr = ks.addresses?.first else { throw WalletError.badMnemonic }
        address = addr.address
        UserDefaults.standard.set(addr.address, forKey: Self.addressKey)
        await refresh()
    }

    func reset() {
        Keychain.wipe()
        keystore = nil
        address = nil
        balances = [:]
        history = []
        UserDefaults.standard.removeObject(forKey: Self.addressKey)
        hasWallet = false
    }

    // MARK: data

    func refresh() async {
        guard let owner = ethAddress else { return }
        loading = true
        defer { loading = false }
        async let p = Prices.load()
        async let h = try? Explorer.history(for: owner.address)
        for token in Token.all {
            if let b = try? await client.balance(of: token, owner: owner) { balances[token.symbol] = b }
        }
        if let g = try? await client.gasPrice() { gasPrice = g }
        prices = await p
        history = (await h) ?? history
    }

    func usdValue(_ token: Token) -> Double? {
        guard let p = prices[token.symbol], let b = balances[token.symbol] else { return nil }
        return (Double(b.description) ?? 0) / pow(10, Double(token.decimals)) * p
    }

    var totalUSD: Double { Token.all.compactMap(usdValue).reduce(0, +) }

    /// Largest amount that can be spent: for EGAZ the network fee is kept back so Max does not fail.
    func maxAmount(_ token: Token, gasLimit: BigUInt) -> BigUInt {
        let b = balances[token.symbol] ?? 0
        guard token.isNative else { return b }
        let fee = gasPrice * gasLimit
        return b > fee ? b - fee : 0
    }

    // MARK: actions (all prompt Face ID through unlock)

    func send(_ token: Token, to: String, amountText: String) async throws -> String {
        guard let owner = ethAddress else { throw WalletError.badAddress }
        guard EthereumAddress(to) != nil else { throw WalletError.badAddress }
        guard let amount = Format.parse(amountText, decimals: token.decimals), amount > 0 else { throw WalletError.badAmount }
        guard amount <= maxAmount(token, gasLimit: Self.sendGasLimit) else { throw WalletError.insufficient(token.symbol) }
        let ks = try await unlock(reason: "Send \(amountText) \(token.symbol)")
        let hash = token.isNative
            ? try await client.sendNative(to: to, amount: amount, from: owner, keystore: ks, password: Self.password)
            : try await client.sendToken(token, to: to, amount: amount, from: owner, keystore: ks, password: Self.password)
        Task { try? await Task.sleep(for: .seconds(8)); await refresh() }
        return hash
    }

    private func ensureAllowance(_ token: Token, spender: String, amount: BigUInt, owner: EthereumAddress, ks: BIP32Keystore) async throws {
        guard !token.isNative else { return }
        let current = try await client.allowance(token: token, owner: owner, spender: spender)
        if current < amount {
            let hash = try await client.approve(token, spender: spender, amount: BigUInt(2).power(256) - 1, from: owner, keystore: ks, password: Self.password)
            try await client.waitForReceipt(hash)
        }
    }

    func swap(from: Token, to: Token, amountText: String, slippageBps: Int = 100) async throws -> String {
        guard let owner = ethAddress else { throw WalletError.badAddress }
        guard let amount = Format.parse(amountText, decimals: from.decimals), amount > 0 else { throw WalletError.badAmount }
        guard amount <= maxAmount(from, gasLimit: Self.swapGasLimit) else { throw WalletError.insufficient(from.symbol) }
        let quoted = try await client.quote(from: from, to: to, amountIn: amount)
        let minOut = quoted * BigUInt(10_000 - slippageBps) / 10_000
        let ks = try await unlock(reason: "Swap \(amountText) \(from.symbol) for \(to.symbol)")
        try await ensureAllowance(from, spender: Chain.swapRouter, amount: amount, owner: owner, ks: ks)
        let hash = try await client.swap(from: from, to: to, amountIn: amount, minOut: minOut, owner: owner, keystore: ks, password: Self.password)
        Task { try? await Task.sleep(for: .seconds(8)); await refresh() }
        return hash
    }

    func stake(amountText: String) async throws -> String {
        guard let owner = ethAddress else { throw WalletError.badAddress }
        guard let amount = Format.parse(amountText, decimals: 18), amount > 0 else { throw WalletError.badAmount }
        guard amount <= (balances["ETX"] ?? 0) else { throw WalletError.insufficient("ETX") }
        let ks = try await unlock(reason: "Stake \(amountText) ETX")
        try await ensureAllowance(.etx, spender: Chain.stakedETX, amount: amount, owner: owner, ks: ks)
        let hash = try await client.stake(etx: amount, owner: owner, keystore: ks, password: Self.password)
        Task { try? await Task.sleep(for: .seconds(8)); await refresh() }
        return hash
    }

    func unstake(amountText: String) async throws -> String {
        guard let owner = ethAddress else { throw WalletError.badAddress }
        guard let shares = Format.parse(amountText, decimals: 18), shares > 0 else { throw WalletError.badAmount }
        guard shares <= (balances["stETX"] ?? 0) else { throw WalletError.insufficient("stETX") }
        let ks = try await unlock(reason: "Unstake \(amountText) stETX")
        let hash = try await client.unstake(shares: shares, owner: owner, keystore: ks, password: Self.password)
        Task { try? await Task.sleep(for: .seconds(8)); await refresh() }
        return hash
    }
}
