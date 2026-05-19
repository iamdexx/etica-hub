# Sourcify verification status — Etica mainnet (chain 61803)

All production contracts deployed on Etica mainnet (chain ID **61803**) are
verified on [Sourcify](https://sourcify.dev). This document tracks the
canonical verification status and the procedure used to verify every contract.

## Current status

| Contract | Address | Sourcify match |
|---|---|---|
| ETX | [`0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`](https://sourcify.dev/#/lookup/0xa5A1Bc6307b0b87989B8456D4b35F88a68650044) | `match` |
| WEGAZ | [`0x232fb2B87CAce92B2438054A7eB79B4081E3E11a`](https://sourcify.dev/#/lookup/0x232fb2B87CAce92B2438054A7eB79B4081E3E11a) | `match` |
| EticaSwapFactory | [`0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3`](https://sourcify.dev/#/lookup/0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3) | `match` |
| EticaSwapRouter | [`0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723`](https://sourcify.dev/#/lookup/0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723) | `match` |
| Permit2 | [`0x165F71f549415f44883e370Df12169Dd99570eE5`](https://sourcify.dev/#/lookup/0x165F71f549415f44883e370Df12169Dd99570eE5) | `match` |
| DutchOrderReactor | [`0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8`](https://sourcify.dev/#/lookup/0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8) | `exact_match` |
| EticaProtocolFeeController | [`0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a`](https://sourcify.dev/#/lookup/0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a) | `match` |
| OrderRegistry | [`0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9`](https://sourcify.dev/#/lookup/0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9) | `match` |
| StakedETX (stETX) | [`0x75d81d03a98CD9195593b8963aF17E13fAa70334`](https://sourcify.dev/#/lookup/0x75d81d03a98CD9195593b8963aF17E13fAa70334) | `match` |
| TreasuryHarvester | [`0x5d8B1138559fADc3Bb90e8317eB16922eAa076f5`](https://sourcify.dev/#/lookup/0x5d8B1138559fADc3Bb90e8317eB16922eAa076f5) | `match` |
| ETXFarms | [`0xEBAfdd24ABF8290f0B433E689631466ABD13c6aD`](https://sourcify.dev/#/lookup/0xEBAfdd24ABF8290f0B433E689631466ABD13c6aD) | `match` |
| EticaStableSwap | [`0xbbf5814C1EA0531Cb07541b80c547ee7878C036E`](https://sourcify.dev/#/lookup/0xbbf5814C1EA0531Cb07541b80c547ee7878C036E) | `match` |
| LiquidityTimelock10y | [`0xFdf919673570Cea9c513461604450D003716d739`](https://sourcify.dev/#/lookup/0xFdf919673570Cea9c513461604450D003716d739) | `match` |
| StableSwapHarvesterAdapter | [`0x9Adc6298EFDcc1604CB95DaaB33331f866DDBe76`](https://sourcify.dev/#/lookup/0x9Adc6298EFDcc1604CB95DaaB33331f866DDBe76) | `match` |
| EticaResearchMarkets | [`0x6605d2F6A8b77a8dC7f53Fd1EDe0974d85937D17`](https://sourcify.dev/#/lookup/0x6605d2F6A8b77a8dC7f53Fd1EDe0974d85937D17) | `match` |

**15 / 15 verified.** Status last refreshed against `https://sourcify.dev/server/v2/contract/61803/{addr}`
in the PR that introduced this doc.

### Match types

- **`exact_match`** — runtime + creation bytecode match including the metadata
  hash trailer (perfect match in legacy Sourcify terminology).
- **`match`** — runtime bytecode matches; metadata trailer is absent because
  `bytecode_hash = "none"` is set in `packages/contracts/foundry.toml` (this is
  intentional so contracts have deterministic, audit-stable bytecode that does
  not depend on local filesystem paths).

Both `exact_match` and `match` mean "the deployed bytecode is provably produced
by this source tree + compiler config." Either is acceptable for explorers,
wallets, and on-chain auditors.

## Re-verifying contracts

To re-check status for every contract in `DEPLOYMENTS[61803]`:

```bash
node apps/web/scripts/verify-all-on-sourcify.mjs
```

The script reads addresses straight from `packages/shared/src/addresses.ts`,
queries Sourcify's `/v2/contract/{chainId}/{address}` endpoint per address, and
prints a status table. It exits non-zero if any contract is unverified — safe
to wire into CI as a periodic check.

## Verifying a freshly deployed contract

`ResearchToken` instances are auto-verified by the
`.github/workflows/research-markets-sourcify.yml` cron (every 10 minutes;
reads `Launched` events from the singleton, POSTs the canonical bundle at
`packages/contracts/sourcify-bundles/ResearchToken/`). No manual action needed.

For any other one-off contract deploy, run from inside the foundry project
that built the contract:

```bash
cd packages/contracts                                  # (or trading-contracts)
export ETICASCAN_API_KEY=dummy                         # placeholder; not used by sourcify
forge verify-contract \
  --verifier sourcify \
  --verifier-url https://sourcify.dev/server \
  --chain-id 61803 \
  <CONTRACT_ADDRESS> \
  src/path/To/Contract.sol:ContractName \
  --skip-is-verified-check \
  --watch
```

`forge verify-contract` reuses the local `foundry.toml` (compiler version,
optimizer runs, evm version, `bytecode_hash`), so it produces a Sourcify
standard-input JSON that mirrors the original compile exactly.

## How the bulk verification was performed

The 15 contracts in this table were deployed across multiple commits over many
months. Their source moved between commits, so straight verification from
current `main` produces bytecode mismatches.

To recover an exact match, each contract was verified from a git worktree
checked out at the commit **before** its address was wired into
`packages/shared/src/addresses.ts` — i.e. the source tree as it was at deploy
time. Sourcify then accepted the standard-input JSON produced by
`forge verify-contract` from that historical state.

Deploy-era commits used:

| Contracts | Deploy-era commit (parent of wiring commit) |
|---|---|
| ETX, WEGAZ, EticaSwapFactory, EticaSwapRouter | `6cec33a^` (PR #19) |
| Permit2, DutchOrderReactor, EticaProtocolFeeController | `221ce37^` (PR #39) |
| OrderRegistry | `76d6f53^` (PR #52) |
| StakedETX | `c50703e^` (PR #93) |
| TreasuryHarvester | `4381fcb^` (PR #110) |
| ETXFarms | `cd15b04^` (PR #106) |
| EticaStableSwap, LiquidityTimelock10y, StableSwapHarvesterAdapter | `e9ded85^` (PR #149) |
| EticaResearchMarkets | current `main` (PR #207) |

These commits are recorded here for reproducibility — anyone can re-derive the
same Sourcify match by checking out the listed commit, running `forge build`,
and calling `forge verify-contract`.
