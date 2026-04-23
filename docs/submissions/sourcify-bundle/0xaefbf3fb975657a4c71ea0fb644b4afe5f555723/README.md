# EticaSwapRouter

**Address:** `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723`
**Summary:** EticaSwap V2 router — swaps + addLiquidity/removeLiquidity.

## Compilation settings

- **Solc:** `0.8.26+commit.8a97fa7a`
- **Optimizer:** enabled, `1000000` runs
- **EVM version:** `paris`
- **Compilation target:** `src/swap/EticaSwapRouter.sol:EticaSwapRouter`

## Sourcify upload

1. Open https://sourcify.dev/#/verifier once chain 61803 is supported (tracking in https://github.com/argotorg/sourcify/pull/2755 / https://github.com/sourcifyeth/sourcify-chains/pull/XXX).
2. Select **Chain:** Etica Mainnet (id 61803).
3. Enter **Address:** `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723`.
4. Drop the files in this bundle directory into the uploader:
   - `metadata.json`
   - every `.sol` under `sources/`
5. Sourcify will recompile using the metadata settings and compare against the on-chain deployed bytecode.

Expected match level: **exact** or **partial** depending on whether the metadata hash embedded in the deployed bytecode matches this metadata.json's IPFS hash. A partial match still marks the contract as verified with source code on https://repo.sourcify.dev.
