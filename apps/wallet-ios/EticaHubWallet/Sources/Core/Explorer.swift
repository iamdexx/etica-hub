import Foundation

/// Etherscan-compatible explorer API at eticahub.com/api/explorer.
struct TxRecord: Identifiable, Hashable {
    let hash: String
    let time: Date
    let from: String
    let to: String
    let value: String      // wei as decimal string
    let tokenSymbol: String
    let decimals: Int
    let failed: Bool
    var id: String { hash + tokenSymbol }
}

enum Explorer {
    private struct Envelope: Decodable { let status: String; let result: [[String: String]]? }

    static func history(for address: String) async throws -> [TxRecord] {
        async let native = fetch(action: "txlist", address: address)
        async let tokens = fetch(action: "tokentx", address: address)
        var out: [TxRecord] = []
        for r in try await native where r["value"] != "0" {
            out.append(TxRecord(hash: r["hash"] ?? "", time: Date(timeIntervalSince1970: Double(r["timeStamp"] ?? "0") ?? 0),
                                from: r["from"] ?? "", to: r["to"] ?? "", value: r["value"] ?? "0",
                                tokenSymbol: "EGAZ", decimals: 18, failed: r["isError"] == "1"))
        }
        for r in try await tokens {
            let addr = (r["contractAddress"] ?? "").lowercased()
            let token = Token.all.first { $0.address?.lowercased() == addr }
            out.append(TxRecord(hash: r["hash"] ?? "", time: Date(timeIntervalSince1970: Double(r["timeStamp"] ?? "0") ?? 0),
                                from: r["from"] ?? "", to: r["to"] ?? "", value: r["value"] ?? "0",
                                tokenSymbol: token?.symbol ?? (r["tokenSymbol"] ?? "?"), decimals: token?.decimals ?? Int(r["tokenDecimal"] ?? "18") ?? 18,
                                failed: false))
        }
        return out.sorted { $0.time > $1.time }
    }

    private static func fetch(action: String, address: String) async throws -> [[String: String]] {
        var c = URLComponents(url: Chain.explorerAPI, resolvingAgainstBaseURL: false)!
        c.queryItems = [.init(name: "module", value: "account"), .init(name: "action", value: action), .init(name: "address", value: address),
                        .init(name: "page", value: "1"), .init(name: "offset", value: "50"), .init(name: "sort", value: "desc")]
        let (data, _) = try await URLSession.shared.data(from: c.url!)
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.result ?? []
    }
}

enum Prices {
    private struct Envelope: Decodable { let prices: [String: Double]? }
    private static let ids: [(String, String)] = [("egaz", "EGAZ"), ("eti", "ETI"), ("etx", "ETX"), ("stetx", "stETX")]

    /// USD price per symbol: the hub API quotes each token in every other token; the USDC.e quote is the dollar price.
    static func load() async -> [String: Double] {
        var out: [String: Double] = ["USDC.e": 1]
        await withTaskGroup(of: (String, Double?).self) { group in
            for (id, symbol) in ids {
                group.addTask {
                    let url = URL(string: "https://eticahub.com/api/v1/tokens/\(id)")!
                    guard let (data, _) = try? await URLSession.shared.data(from: url),
                          let env = try? JSONDecoder().decode(Envelope.self, from: data) else { return (symbol, nil) }
                    return (symbol, env.prices?["usdce"])
                }
            }
            for await (symbol, price) in group { if let p = price { out[symbol] = p } }
        }
        return out
    }
}
