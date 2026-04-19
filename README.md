# EticaHub

A single site combining three dapps for the Etica ecosystem:

| Phase | Module | Status |
|---|---|---|
| 1 | **EticaSwap V2** — Uniswap V2 fork, first on-chain DEX for ETI / EGAZ / ERC-20 | Code complete, tested end-to-end on local mainnet fork |
| 2a | **ETX reward token + MasterChef + xETXVault + FeeRouter + vesting** | Code complete, held from deploy |
| 2b | **Research Hub** — proposal reader, IPFS renderer, ETI tipping, subscription contract | Code complete |
| 3 | **Bridge** — ETI ↔ wETI on Ethereum, 2-of-3 multisig relayer | Code + tests complete, awaiting audit |

**Nothing is deployed to any chain yet.** See [`docs/DEPLOYMENT_RUNBOOK.md`](./docs/DEPLOYMENT_RUNBOOK.md)
for the promotion path.

## Repo layout

```
apps/
  web/         Next.js 14 + wagmi + viem frontend
  indexer/     Node/TS — Etica core event watcher + IPFS proposal fetcher
  relayer/     Node/TS — bridge coordinator + per-validator signer
packages/
  contracts/   Solidity + Foundry
  shared/      TS — chain configs, ABIs, deployment addresses
docs/
  BRIDGE_AUDIT_SCOPE.md    What to hand a bridge auditor
  DEPLOYMENT_RUNBOOK.md    Step-by-step promotion from fork → testnet → mainnet
  FAQ.md                   Short answers to common questions
```

## Quick start

```bash
git clone https://github.com/iamdexx/etica-hub && cd etica-hub
pnpm install
pnpm --filter @etica-hub/contracts test    # 41 passing
pnpm --filter @etica-hub/relayer test      # 11 passing
pnpm --filter @etica-hub/web typecheck     # clean
pnpm --filter @etica-hub/web build         # clean
```

To run the frontend against a local anvil fork of Etica mainnet, see
`apps/web/README.md` (fork config + seed script).

## Chains

| Chain | ID | RPC | Purpose |
|---|---|---|---|
| Etica mainnet | 61803 | https://eticamainnet.eticascan.org | production target |
| Etica Crucible testnet | 61888 | http://173.212.202.226:8545 | optional testnet (no public faucet — see [FAQ](./docs/FAQ.md)) |
| Local anvil fork | 31337 | http://127.0.0.1:8545 | default dev target |
| Ethereum mainnet | 1 | any | bridge destination |
| Ethereum Sepolia | 11155111 | any | bridge testnet destination |

## Security

- Treasury address: `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` (repo owner, pre-DAO).
- Bridge audit scoping doc: [`docs/BRIDGE_AUDIT_SCOPE.md`](./docs/BRIDGE_AUDIT_SCOPE.md).
- `.gitignore` blocks `*.key`, `*.pem`, `*.keystore`, `secrets/`, `.secrets/`,
  and all `.env.*` except `.env.example`. Never commit a key.

## Initialized by Devin

This repo was bootstrapped via Devin (https://devin.ai) for the repo owner
(@iamdexx). Ongoing development is human-reviewed; all PRs require passing CI
(Foundry tests + pnpm typecheck/build + Devin Review).
