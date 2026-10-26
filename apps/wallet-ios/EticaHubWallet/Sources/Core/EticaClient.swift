import Foundation
import BigInt
import web3swift
import Web3Core

/// Thin wrapper over web3swift for EticaChain: balances, ERC-20 reads, sends, swaps, staking.
/// Tries rpc.eticahub.com first and falls back to the public RPC.
final class EticaClient {
    private var web3: Web3?

    func provider() async throws -> Web3 {
        if let w = web3 { return w }
        var lastError: Error?
        for url in Chain.rpcURLs {
            do {
                let p = try await Web3HttpProvider(url: url, network: .Custom(networkID: Chain.id))
                let w = Web3(provider: p)
                web3 = w
                return w
            } catch { lastError = error }
        }
        throw WalletError.rpc(lastError?.localizedDescription ?? "No RPC reachable")
    }

    func balance(of token: Token, owner: EthereumAddress) async throws -> BigUInt {
        let w = try await provider()
        if token.isNative { return try await w.eth.getBalance(for: owner) }
        let erc20 = ERC20(web3: w, provider: w.provider, address: EthereumAddress(token.address!)!)
        return try await erc20.getBalance(account: owner)
    }

    func allowance(token: Token, owner: EthereumAddress, spender: String) async throws -> BigUInt {
        let w = try await provider()
        let erc20 = ERC20(web3: w, provider: w.provider, address: EthereumAddress(token.address!)!)
        return try await erc20.getAllowance(originalOwner: owner, delegate: EthereumAddress(spender)!)
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

    private func send(_ op: WriteOperation, keystore: AbstractKeystore, password: String) async throws -> String {
        op.web3.addKeystoreManager(KeystoreManager([keystore as! BIP32Keystore]))
        let gasPrice = try await op.web3.eth.gasPrice()
        op.transaction.gasPrice = max(gasPrice, BigUInt(10_000_000_000))
        let result = try await op.writeToChain(password: password, sendRaw: true)
        return result.hash
    }

    func sendNative(to: String, amount: BigUInt, from: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        guard let dest = EthereumAddress(to) else { throw WalletError.badAddress }
        guard let contract = w.contract(Web3.Utils.coldWalletABI, at: dest),
              let op = contract.createWriteOperation("fallback") else { throw WalletError.rpc("Could not build transfer") }
        op.transaction.from = from
        op.transaction.value = amount
        op.transaction.chainID = Chain.id
        return try await send(op, keystore: keystore, password: password)
    }

    func sendToken(_ token: Token, to: String, amount: BigUInt, from: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        guard let dest = EthereumAddress(to) else { throw WalletError.badAddress }
        let op = try operation(w, abi: Web3.Utils.erc20ABI, at: token.address!, method: "transfer", params: [dest, amount], from: from)
        return try await send(op, keystore: keystore, password: password)
    }

    func approve(_ token: Token, spender: String, amount: BigUInt, from: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        let op = try operation(w, abi: Web3.Utils.erc20ABI, at: token.address!, method: "approve", params: [EthereumAddress(spender)!, amount], from: from)
        return try await send(op, keystore: keystore, password: password)
    }

    // MARK: swap (EticaSwap = Uniswap V2 router)

    func quote(from: Token, to: Token, amountIn: BigUInt) async throws -> BigUInt {
        let w = try await provider()
        let path = Token.path(from: from, to: to).map { EthereumAddress($0)! }
        guard let contract = w.contract(ABI.router, at: EthereumAddress(Chain.swapRouter)!),
              let op = contract.createReadOperation("getAmountsOut", parameters: [amountIn, path]) else { throw WalletError.rpc("quote") }
        let res = try await op.callContractMethod()
        guard let amounts = res["0"] as? [BigUInt], let out = amounts.last else { throw WalletError.rpc("No route for that pair") }
        return out
    }

    func swap(from: Token, to: Token, amountIn: BigUInt, minOut: BigUInt, owner: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        let path = Token.path(from: from, to: to).map { EthereumAddress($0)! }
        let deadline = BigUInt(Date().timeIntervalSince1970) + 1200
        let op: WriteOperation
        if from.isNative {
            op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactETHForTokens", params: [minOut, path, owner, deadline], from: owner, value: amountIn)
        } else if to.isNative {
            op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactTokensForETH", params: [amountIn, minOut, path, owner, deadline], from: owner)
        } else {
            op = try operation(w, abi: ABI.router, at: Chain.swapRouter, method: "swapExactTokensForTokens", params: [amountIn, minOut, path, owner, deadline], from: owner)
        }
        return try await send(op, keystore: keystore, password: password)
    }

    // MARK: stETX (ERC-4626)

    func stakeRate() async throws -> BigUInt {
        let w = try await provider()
        guard let contract = w.contract(ABI.erc4626, at: EthereumAddress(Chain.stakedETX)!),
              let op = contract.createReadOperation("convertToAssets", parameters: [BigUInt(10).power(18)]) else { throw WalletError.rpc("rate") }
        let res = try await op.callContractMethod()
        return res["0"] as? BigUInt ?? BigUInt(10).power(18)
    }

    func stake(etx amount: BigUInt, owner: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        let op = try operation(w, abi: ABI.erc4626, at: Chain.stakedETX, method: "deposit", params: [amount, owner], from: owner)
        return try await send(op, keystore: keystore, password: password)
    }

    func unstake(shares: BigUInt, owner: EthereumAddress, keystore: AbstractKeystore, password: String) async throws -> String {
        let w = try await provider()
        let op = try operation(w, abi: ABI.erc4626, at: Chain.stakedETX, method: "redeem", params: [shares, owner, owner], from: owner)
        return try await send(op, keystore: keystore, password: password)
    }
}

enum ABI {
    static let router = """
    [{"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"}],"name":"getAmountsOut","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"view","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactETHForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"payable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForETH","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"}]
    """
    static let erc4626 = """
    [{"inputs":[{"internalType":"uint256","name":"shares","type":"uint256"}],"name":"convertToAssets","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"assets","type":"uint256"},{"internalType":"address","name":"receiver","type":"address"}],"name":"deposit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
     {"inputs":[{"internalType":"uint256","name":"shares","type":"uint256"},{"internalType":"address","name":"receiver","type":"address"},{"internalType":"address","name":"owner","type":"address"}],"name":"redeem","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"}]
    """
}
