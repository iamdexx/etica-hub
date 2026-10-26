import Foundation
import LocalAuthentication
import Security

/// Mnemonic storage in the iOS Keychain, device-only, behind Face ID / passcode.
enum Keychain {
    private static let service = "com.eticahub.wallet"
    private static let account = "mnemonic"

    static func save(mnemonic: String) throws {
        let data = Data(mnemonic.utf8)
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.userPresence], &error) else {
            throw WalletError.keychain("access control")
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw WalletError.keychain("save \(status)") }
    }

    static func exists() -> Bool {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: false, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    /// Prompts Face ID / passcode.
    static func load(reason: String) throws -> String {
        let ctx = LAContext()
        ctx.localizedReason = reason
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecUseAuthenticationContext as String: ctx]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let s = String(data: data, encoding: .utf8) else {
            throw WalletError.keychain(status == errSecUserCanceled ? "cancelled" : "load \(status)")
        }
        return s
    }

    static func wipe() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}

enum WalletError: LocalizedError {
    case keychain(String)
    case badMnemonic
    case badAddress
    case badAmount
    case rpc(String)
    case insufficient(String)

    var errorDescription: String? {
        switch self {
        case .keychain(let s): return s == "cancelled" ? "Cancelled." : "Secure storage error (\(s))."
        case .badMnemonic: return "That is not a valid 12 or 24 word recovery phrase."
        case .badAddress: return "That is not a valid 0x address."
        case .badAmount: return "Enter a valid amount."
        case .rpc(let s): return s
        case .insufficient(let s): return "Not enough \(s)."
        }
    }
}
