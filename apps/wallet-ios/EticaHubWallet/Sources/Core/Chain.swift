import Foundation
import BigInt

/// EticaChain constants. Addresses mirror packages/shared/src/addresses.ts (etica mainnet).
enum Chain {
    static let id: BigUInt = 61803
    static let name = "Etica"
    static let nativeSymbol = "EGAZ"
    static let rpcURLs = [
        URL(string: "https://rpc.eticahub.com")!,
        URL(string: "https://eticamainnet.eticascan.org")!,
    ]
    static let explorerAPI = URL(string: "https://eticahub.com/api/explorer")!
    static let explorerTx = "https://eticahub.com/explorer/tx/"
    static let priceAPI = URL(string: "https://eticahub.com/api/v1/tokens")!

    static let wegaz = "0x232fb2B87CAce92B2438054A7eB79B4081E3E11a"
    static let etx = "0xa5A1Bc6307b0b87989B8456D4b35F88a68650044"
    static let swapRouter = "0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723"
    static let stakedETX = "0x75d81d03a98CD9195593b8963aF17E13fAa70334"
}

struct Token: Identifiable, Hashable, Codable {
    let symbol: String
    let name: String
    /// nil for the native coin (EGAZ)
    let address: String?
    let decimals: Int
    var id: String { symbol }
    var isNative: Bool { address == nil }

    static let egaz = Token(symbol: "EGAZ", name: "Etica Gas", address: nil, decimals: 18)
    static let eti = Token(symbol: "ETI", name: "Etica", address: "0x34c61EA91bAcdA647269d4e310A86b875c09946f", decimals: 18)
    static let etx = Token(symbol: "ETX", name: "EticaHub", address: Chain.etx, decimals: 18)
    static let stetx = Token(symbol: "stETX", name: "Staked ETX", address: Chain.stakedETX, decimals: 18)
    static let usdce = Token(symbol: "USDC.e", name: "USD Coin (bridged)", address: "0x0BA5C0BFd034639330d2CF9DBAD354d8DBc2d335", decimals: 6)
    static let all: [Token] = [.egaz, .eti, .etx, .stetx, .usdce]

    /// Swap path through the ETX hub (every pool is X/ETX). Native EGAZ trades as WEGAZ.
    static func path(from: Token, to: Token) -> [String] {
        let a = from.address ?? Chain.wegaz
        let b = to.address ?? Chain.wegaz
        if a.lowercased() == Chain.etx.lowercased() || b.lowercased() == Chain.etx.lowercased() { return [a, b] }
        return [a, Chain.etx, b]
    }
}

enum Format {
    static func amount(_ wei: BigUInt, decimals: Int, maxFraction: Int = 4) -> String {
        let divisor = BigUInt(10).power(decimals)
        let whole = wei / divisor
        let frac = wei % divisor
        var fracStr = String(frac)
        fracStr = String(repeating: "0", count: max(0, decimals - fracStr.count)) + fracStr
        fracStr = String(fracStr.prefix(maxFraction))
        while fracStr.hasSuffix("0") { fracStr.removeLast() }
        return fracStr.isEmpty ? String(whole) : "\(whole).\(fracStr)"
    }

    static func parse(_ text: String, decimals: Int) -> BigUInt? {
        let t = text.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let parts = t.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, let whole = BigUInt(parts[0].isEmpty ? "0" : String(parts[0])) else { return nil }
        var frac = parts.count == 2 ? String(parts[1]) : ""
        guard frac.count <= decimals, frac.allSatisfy(\.isNumber) else { return nil }
        frac += String(repeating: "0", count: decimals - frac.count)
        return whole * BigUInt(10).power(decimals) + (BigUInt(frac) ?? 0)
    }

    static func usd(_ v: Double) -> String {
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"
        f.maximumFractionDigits = v < 1 ? 4 : 2
        return f.string(from: NSNumber(value: v)) ?? "$0"
    }

    static func short(_ address: String) -> String {
        guard address.count > 12 else { return address }
        return "\(address.prefix(6))…\(address.suffix(4))"
    }
}
