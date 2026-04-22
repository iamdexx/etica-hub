# OrderRegistry

**Address:** `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9`
**Summary:** On-chain open-order registry read by the keeper and /trade/orders UI.

## Compilation settings

- **Solc:** `0.8.29+commit.ab55807c`
- **Optimizer:** enabled, `1000000` runs
- **EVM version:** `prague`
- **Compilation target:** `src/OrderRegistry.sol:OrderRegistry`

## Sourcify upload

1. Open https://sourcify.dev/#/verifier once chain 61803 is supported (tracking in https://github.com/argotorg/sourcify/pull/2755 / https://github.com/sourcifyeth/sourcify-chains/pull/XXX).
2. Select **Chain:** Etica Mainnet (id 61803).
3. Enter **Address:** `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9`.
4. Drop the files in this bundle directory into the uploader:
   - `metadata.json`
   - every `.sol` under `sources/`
5. Sourcify will recompile using the metadata settings and compare against the on-chain deployed bytecode.

Expected match level: **exact** or **partial** depending on whether the metadata hash embedded in the deployed bytecode matches this metadata.json's IPFS hash. A partial match still marks the contract as verified with source code on https://repo.sourcify.dev.
