# EticaHub

DeSci + DeFi application layer for the Etica Protocol (chain id 61803), live at
**https://eticahub.com**.

| Module | Status |
|---|---|
| **EticaSwap V2** — AMM DEX for ETI / EGAZ / ERC-20 (factory, router, Permit2, Dutch reactor + order registry) | Live on Etica mainnet |
| **ETX** token, **stETX** liquid staking (ERC-4626), farms, treasury harvester, fee controller | Live on Etica mainnet |
| **EticaStableSwap** + harvester adapter | Live on Etica mainnet |
| **Research Markets** + **RES NFT** (ERC-721 research discoveries) + marketplace | Live on Etica mainnet |
| **EticaLabs Autopilot** — autonomous AI protein-design / research loop, public archive at `/labs/archive` | Live (GitHub Actions worker + Vercel API) |
| **Bridge** — ETX ↔ wrapped ETX on Ethereum / BNB via Hyperlane, optimistic veto | Contracts + watcher bots complete; remote deployments not yet configured |

Canonical deployment addresses live in [`packages/shared/src/addresses.ts`](./packages/shared/src/addresses.ts).
See [`docs/DEPLOYMENT_RUNBOOK.md`](./docs/DEPLOYMENT_RUNBOOK.md) for the promotion path of new contracts.

### Operations

- Frontend + API: Vercel (`apps/web`), Redis for Labs queue / rate limits / uptime history.
- Automation: GitHub Actions cron — bridge heartbeat/monitor/execute, explorer indexer, harvest, keeper,
  Labs autopilot, research automation. A weekly `keepalive` workflow re-enables anything GitHub
  auto-disables for inactivity; `ops-alerts` posts to Telegram on failed/timed-out runs or a stale `/api/v1/health`.
- Status: https://eticahub.com/status (chain head, RPC failover, 7-day uptime).

## Repo layout

```
apps/
  web/             Next.js 14 + wagmi + viem frontend + API routes (Vercel)
  labs-autopilot/  AI research worker loop (GitHub Actions)
  bridge-watcher/  Bridge heartbeat / monitor / executor bots
  indexer/         Explorer event indexer
  keeper/, wres-keeper/, orderbook/, research-markets-sourcify/, eticascan/
packages/
  contracts/       Solidity + Foundry
  trading-contracts/
  shared/          TS — chain configs, ABIs, deployment addresses
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
| Etica mainnet | 61803 | https://rpc2.etica-stats.org | production target |
| Etica Crucible testnet | 61888 | http://173.212.202.226:8545 | optional testnet (no public faucet — see [FAQ](./docs/FAQ.md)) |
| Local anvil fork | 31337 | http://127.0.0.1:8545 | default dev target |
| Ethereum mainnet | 1 | any | bridge destination |
| Ethereum Sepolia | 11155111 | any | bridge testnet destination |

## Security

- Treasury address: `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` (repo owner, pre-DAO).
- Bridge audit scoping doc: [`docs/BRIDGE_AUDIT_SCOPE.md`](./docs/BRIDGE_AUDIT_SCOPE.md).
- `.gitignore` blocks `*.key`, `*.pem`, `*.keystore`, `secrets/`, `.secrets/`,
  and all `.env.*` except `.env.example`. Never commit a key.

## License

This repository is **proprietary and source-available** under the
[EticaHub Proprietary License v1.0](./LICENSE).

- The source is published for inspection, security review, and public
  audit. Sourcify verification, aggregator vetting, and community
  scrutiny all work against the published source.
- **No rights to use, run, fork, modify, or redistribute the Software
  are granted by this License.** Any such use requires a separately
  signed Commercial License from the EticaHub treasury.
- Commercial licensing inquiries: contact the EticaHub treasury at
  on-chain address `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` or via
  https://eticahub.com.

See [`LICENSE`](./LICENSE) for the full terms, including the ethics
conditions, trademark notice, and contribution assignment.

## Initialized by Devin

This repo was bootstrapped via Devin (https://devin.ai) for the repo owner
(@iamdexx). Ongoing development is human-reviewed; all PRs require passing CI
(Foundry tests + pnpm typecheck/build + Devin Review).
