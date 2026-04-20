# EticaHub

> One unified dapp for the [Etica mainnet](https://www.eticaprotocol.org/): on-chain DEX, Ethereum bridge, and DeSci research hub.

EticaHub fills the three biggest infrastructure gaps on Etica (chain ID `61803`, native gas `EGAZ`):

1. **EticaSwap** — the first on-chain AMM on Etica. Uniswap V2-style pairs for ETI/EGAZ and any ERC20 deployed on Etica. (Phase 1)
2. **Etica Research Hub** — proposal indexer + IPFS renderer + tip-in-ETI widget + optional subscription tier for NGOs and researchers. (Phase 2)
3. **EticaBridge** — lock-and-mint bridge between Etica mainnet and Ethereum, unlocking wETI / wEGAZ for external liquidity. (Phase 3)

All three modules live in a single monorepo and ship under one frontend shell.

## Networks

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Etica Mainnet | 61803 | https://eticamainnet.eticascan.org | https://eticascan.org |
| Crucible Testnet | 61888 | http://173.212.202.226:8545 | — |

- **ETI (mainnet)** contract: `0x34c61EA91bAcdA647269d4e310A86b875c09946f`
- **ETI (Crucible)** contract: `0x558593Bc92E6F242a604c615d93902fc98efcA82`

Contracts deploy to Crucible first, then mainnet after review (and for the bridge, an audit).

## Monorepo layout

```
etica-hub/
├── apps/
│   ├── web/              # Next.js 14 frontend (swap, pools, research hub, bridge)
│   └── indexer/          # Node/TS indexer (pairs, swaps, research proposals, bridge msgs)
└── packages/
    ├── contracts/        # Foundry project — all Solidity contracts + tests
    └── shared/           # chain configs, ABIs, shared types
```

## Dev setup

```bash
# install deps
pnpm install

# contracts
pnpm contracts:build
pnpm contracts:test

# web
pnpm dev:web         # http://localhost:3000

# indexer
pnpm dev:indexer
```

Requires Node >=20, pnpm 9+, and [Foundry](https://book.getfoundry.sh/getting-started/installation).

## Status

| Module | Phase | Status |
|---|---|---|
| EticaSwap | 1 | in development |
| Research Hub | 2 | planned |
| Bridge | 3 | planned |

## License

GPL-3.0 — consistent with Etica protocol itself and with Uniswap V2 core.
