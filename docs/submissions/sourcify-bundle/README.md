# Sourcify verification bundles — EticaHub mainnet (chain 61803)

Each subdirectory here is a self-contained Sourcify upload bundle for one deployed EticaHub contract:

- [WEGAZ](./0x232fb2b87cace92b2438054a7eb79b4081e3e11a/README.md) — `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a`
- [ETXToken](./0xa5a1bc6307b0b87989b8456d4b35f88a68650044/README.md) — `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- [EticaSwapFactory](./0xfc8de5a5087c8825aa54e2c57b3ffe0e23784bc3/README.md) — `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3`
- [EticaSwapRouter](./0xaefbf3fb975657a4c71ea0fb644b4afe5f555723/README.md) — `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723`
- [StakedETX](./0x75d81d03a98cd9195593b8963af17e13faa70334/README.md) — `0x75d81d03a98CD9195593b8963aF17E13fAa70334`
- [ETXFarms](./0xb9b36258642d94823a6d6059c5a7b54c441bc7e9/README.md) — `0xB9b36258642D94823A6d6059c5a7B54c441BC7E9`
- [DutchOrderReactor](./0xe2fc7eaceb0146560bfcf46cc5b167df60e970b8/README.md) — `0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8`
- [EticaProtocolFeeController](./0xb9a4fbfc4ca598be18e09bb9c0cf19e4a1a4350a/README.md) — `0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a`
- [OrderRegistry](./0xa6f3e48cf31dce3a8d36659f5bc6a61785c404a9/README.md) — `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9`

## How to verify

1. Wait for chain 61803 support to land in Sourcify (tracking: https://github.com/argotorg/sourcify/pull/2755 and https://github.com/sourcifyeth/sourcify-chains).
2. Open https://sourcify.dev/#/verifier.
3. Pick **Etica Mainnet** as the chain.
4. Enter the contract address.
5. Drag the entire bundle directory into the upload area. The `metadata.json` + the `sources/` tree together give Sourcify everything needed to recompile and compare against the on-chain bytecode.

## Regenerating

Bundles are produced by `apps/web/scripts/build-sourcify-bundle.mjs` from each forge artifact. To refresh:

```bash
cd packages/contracts && forge build
cd ../trading-contracts && forge build
cd ../../apps/web && node scripts/build-sourcify-bundle.mjs
```

Bundle output is deterministic given the same sources + compiler settings.
