# EticaHub Wallet (iOS)

SwiftUI wallet for EticaChain (chain 61803): EGAZ, ETI, ETX, stETX, USDC.e. Keys are a BIP-39 phrase in the iOS Keychain
(device-only, Face ID / passcode on every signing action); the app never mines (App Store rules), the Mine tab only shows
the address for the desktop EticaHub Miner and the pools' earnings for it.

- Send / receive (QR), activity from `eticahub.com/api/explorer` (Etherscan-style `txlist` + `tokentx`)
- Swap on EticaSwap (`swapRouter`, every pair is X/ETX so paths route through ETX), 1% slippage cap
- Stake / unstake ETX in the stETX ERC-4626 vault
- Dollar values from `eticahub.com/api/v1/tokens/{id}` (`prices.usdce`)
- RPC `rpc.eticahub.com`, falls back to `eticamainnet.eticascan.org`

Build: `brew install xcodegen && cd apps/wallet-ios && xcodegen generate && open EticaHubWallet.xcodeproj` (iOS 17, Xcode 15.4+).
Dependencies: web3swift 3.x (BIP39, keystore, ABI, RPC).
