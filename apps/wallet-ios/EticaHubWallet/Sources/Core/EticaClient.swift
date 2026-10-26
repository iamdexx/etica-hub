import Foundation
import BigInt
import web3swift
import Web3Core

/// Thin wrapper over web3swift for EticaChain: balances, ERC-20 reads, sends, swaps, staking.
/// Every call runs against the cached RPC first and falls back to the other RPCs in Chain.rpcURLs
/// when it fails; a node without chain state (still syncing) is skipped. The working RPC is cached.
final class EticaClient {
    private var web3: Web3?
    private var activeURL: URL?
    private(set) var activeHost: String?

    static let minGasPrice = BigUInt(10_000_000_000)

    private func connect(_ url: URL) async throws -> Web3 {
        if await Self.isSyncing(url) { throw WalletError.rpc("\(url.host ?? "RPC") is still syncing") }
        let p = try await Web3HttpProvider(url: url, network: .Custom(networkID: Chain.id))
        let w = Web3(provider: p)
        let code = try await w.eth.code(for: EthereumAddress(Chain.etx)!)
        guard code.count > 2 else { throw WalletError.rpc("\(url.host ?? "RPC") has no chain state yet") }
        return w
    }

    /// A syncing node answers every call with an old head, so balances and nonces would be wrong.
    /// Unreachable counts as syncing (skip it); a node that rejects eth_syncing is assumed synced.
    private static func isSyncing(_ url: URL) async -> Bool {
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(#"{"jsonrpc":"2.0","id":1,"method":"eth_syncing","params":[]}"#.utf8)
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
        if let flag = json["result"] as? Bool { return flag }
        return json["result"] != nil
    }

    /// Runs `body` on the cached provider, retrying on every other RPC if it fails.
    func withProvider<T>(_ body: (Web3) async throws -> T) async throws -> T {
        var lastError: Error?
        if let w = web3 {
            do { return try await body(w) } catch { lastError = error; web3 = nil }
        }
        for url in Chain.rpcURLs where url != activeURL {
            do {
                let w = try await connect(url)
                let out = try await body(w)
                web3 = w
                activeURL = url
                activeHost = url.host
                return out
            } catch { lastError = error }
        }
        activeURL = nil
        throw WalletError.rpc(lastError?.localizedDescription ?? "No RPC reachable")
    }

    /// Writes run exactly once: a lost reply must not resend the transaction (new nonce, double spend).
    /// The provider is resolved with the usual fallback first, then `body` runs on it with no retry.
    func withWriteProvider<T>(_ body: (Web3) async throws -> T) async throws -> T {
        let w = try await withProvider { w in
            _ = try await w.eth.blockNumber()
            return w
        }
        return try await body(w)
    }

    func balance(of token: Token, owner: EthereumAddress) async throws -> BigUInt {
        try await withProvider { w in
            if token.isNative { return try await w.eth.getBalance(for: owner) }
            let erc20 = ERC20(web3: w, provider: w.provider, address: EthereumAddress(token.address!)!)
            return try await erc20.getBalance(account: owner)
        }
    }

    func allowance(token: Token, owner: EthereumAddress, spender: String) async throws -> BigUInt {
        try await withProvider { w in
            let erc20 = ERC20(web3: w, provider: w.provider, address: EthereumAddress(token.address!)!)
            return try await erc20.getAllowance(originalOwner: owner, delegate: EthereumAddress(spender)!)
        }
    }

    /// Node gas price, floored at 10 gwei.
    func gasPrice() async throws -> BigUInt {
        try await withProvider { w in max(try await w.eth.gasPrice(), Self.minGasPrice) }
    }

    /// Polls eth_getTransactionReceipt until the tx is mined (or `timeout` seconds pass). Throws if it reverted.
    func waitForReceipt(_ hash: String, timeout: TimeInterval = 90) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        guard let data = Data.fromHex(hash) else { throw WalletError.rpc("Bad tx hash") }
        while Date() < deadline {
            let receipt = try? await withProvider { try await $0.eth.transactionReceipt(data) }
            switch receipt?.status {
            case .ok: return
            case .failed: throw WalletError.rpc("Transaction \(Format.short(hash)) failed on chain")
            default: try await Task.sleep(for: .seconds(3))
            }
        }
        throw WalletError.rpc("Transaction \(Format.short(hash)) is still pending. Check the explorer before retrying.")
    }

    // MARK: writes

    private func operation(_ w: Web3, abi: String, at: String, method: String, params: [Any], from: EthereumAddress, value: BigUInt = 0) throws -> WriteOperation {
        guard let contract = w.contract(abi, at: EthereumAddress(at)!),
              let op = contract.createWriteOperation(method, parameters: params) else {
            throw WalletError.rpc("Could not build \(method)")
        }
        op.transaction.from = from
        op.transaction.value = value
        op.transaction.chainID = Chain.id
        return op
    }

    private func send(_ w: Web3, _ op: WriteOperation, keystore: BIP32Keystore, password: String) async throws -> String {
        w.addKeystoreManager(KeystoreManager([keystore]))
        let gasPrice = max(try await w.eth.gasPrice(), Self.minGasPrice)
        let policies = Policies(gasPricePolicy: .manual(gasPrice))
        let result = try await op.writeToChain(password: password, policies: policies, sendRaw: true)
        return result.hash
    }

    func sendNative(to: String, amount: BigUInt, from: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        guard let dest = EthereumAddress(to) else { throw WalletError.badAddress }
        return try await withWriteProvider { w in
            guard let contract = w.contract(Web3.Utils.coldWalletABI, at: dest),
                  let op = contract.createWriteOperation("fallback") else { throw WalletError.rpc("Could not build transfer") }
            op.transaction.from = from
            op.transaction.value = amount
            op.transaction.chainID = Chain.id
            return try await send(w, op, keystore: keystore, password: password)
        }
    }

    func sendToken(_ token: Token, to: String, amount: BigUInt, from: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        guard let dest = EthereumAddress(to) else { throw WalletError.badAddress }
        return try await withWriteProvider { w in
            let op = try operation(w, abi: Web3.Utils.erc20ABI, at: token.address!, method: "transfer", params: [dest, amount], from: from)
            return try await send(w, op, keystore: keystore, password: password)
        }
    }

    func approve(_ token: Token, spender: String, amount: BigUInt, from: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        try await withWriteProvider { w in
            let op = try operation(w, abi: Web3.Utils.erc20ABI, at: token.address!, method: "approve", params: [EthereumAddress(spender)!, amount], from: from)
            return try await send(w, op, keystore: keystore, password: password)
        }
    }

    // MARK: swap (EticaSwapRouter: Uniswap V2 shape, native coin functions are named *EGAZ*)

    func quote(from: Token, to: Token, amountIn: BigUInt) async throws -> BigUInt {
        let path = Token.path(from: from, to: to).map { EthereumAddress($0)! }
        return try await withProvider { w in
            guard let contract = w.contract(ABI.router, at: EthereumAddress(Chain.swapRouter)!),
                  let op = contract.createReadOperation("getAmountsOut", parameters: [amountIn, path]) else { throw WalletError.rpc("quote") }
            let res = try await op.callContractMethod()
            guard let amounts = (res["amounts"] ?? res["0"]) as? [BigUInt], let out = amounts.last else { throw WalletError.rpc("No route for that pair") }
            return out
        }
    }

    func swap(from: Token, to: Token, amountIn: BigUInt, minOut: BigUInt, owner: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        let path = Token.path(from: from, to: to).map { EthereumAddress($0)! }
        let deadline = BigUInt(Date().timeIntervalSince1970) + 1200
        return try await withWriteProvider { w in
            let op: WriteOperation
            if from.isNative {
                op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactEGAZForTokens", params: [minOut, path, owner, deadline], from: owner, value: amountIn)
            } else if to.isNative {
                op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactTokensForEGAZ", params: [amountIn, minOut, path, owner, deadline], from: owner)
            } else {
                op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactTokensForTokens", params: [amountIn, minOut, path, owner, deadline], from: owner)
            }
            return try await send(w, op, keystore: keystore, password: password)
        }
    }

    // MARK: stETX (ERC-4626)

    func stakeRate() async throws -> BigUInt {
        try await withProvider { w in
            guard let contract = w.contract(ABI.erc4626, at: EthereumAddress(Chain.stakedETX)!),
                  let op = contract.createReadOperation("convertToAssets", parameters: [BigUInt(10).power(18)]) else { throw WalletError.rpc("rate") }
            let res = try await op.callContractMethod()
            return res["0"] as? BigUInt ?? BigUInt(10).power(18)
        }
    }

    func stake(etx amount: BigUInt, owner: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        try await withWriteProvider { w in
            let op = try operation(w, abi: ABI.erc4626, at: Chain.stakedETX, method: "deposit", params: [amount, owner], from: owner)
            return try await send(w, op, keystore: keystore, password: password)
        }
    }

    func unstake(shares: BigUInt, owner: EthereumAddress, keystore: BIP32Keystore, password: String) async throws -> String {
        try await withWriteProvider { w in
            let op = try operation(w, abi: ABI.erc4626, at: Chain.stakedETX, method: "redeem", params: [shares, owner, owner], from: owner)
            return try await send(w, op, keystore: keystore, password: password)
        }
    }
}

enum ABI {
    static let router = """
    [{"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"}],"name":"getAmountsOut","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"view","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactEGAZForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"payable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForEGAZ","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"}]
    """
    static let erc4626 = """
    [{"inputs":[{"internalType":"uint256","name":"shares","type":"uint256"}],"name":"convertToAssets","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"assets","type":"uint256"},{"internalType":"address","name":"receiver","type":"address"}],"name":"deposit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"shares","type":"uint256"},{"internalType":"address","name":"receiver","type":"address"},{"internalType":"address","name":"owner","type":"address"}],"name":"redeem","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"}]
    """
}
