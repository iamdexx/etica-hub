# EticaHub Whitepaper

**Version 2.0 — Current Platform Edition**

---

## Abstract

EticaHub is a community-built application layer on the Etica blockchain. It introduces **ETX** (ticker `ETX`, name `EticaHub`, supply 100,000,000, fixed), a hub-and-spoke decentralized exchange where every pair shares ETX as its reserve asset, an on-chain research-proposal reader with direct author tipping that reads Etica's native proposal contract, and a permissionless research-token launchpad (**EticaResearchMarkets**) where every market trades against a shared, treasury-seeded singleton bonding curve.

Since the v1 genesis launch, EticaHub has shipped several additional surfaces — all of them non-custodial, non-dilutive to the fixed ETX supply, and built on the same hub-and-spoke invariant: a UniswapX-style **Trading Stack** (limit, stop, DCA, bounded grid, Infinity Bot), an **ERC-4626 liquid staking vault (stETX)**, the **EticaStableSwap V3 pool** — a rate-aware Curve-style AMM for stETX↔ETX with a 10-year-locked treasury seed and a live admin-fee adapter that flows back into the harvester, an on-chain **Treasury Harvester** that redistributes treasury LP-fee accruals via a deterministic 10/10/40/40 split with a permanent Protocol-Owned-Liquidity (POL) burn, an **ETXFarms** non-emissive LP-staking surface, a skinny **on-chain explorer** with Sourcify-backed contract verification, a public **market-data API**, a **community buy bot** that posts DEX swaps to Telegram, **EticaLabs** — an AI-native molecular-intelligence workstation whose 24/7 autopilot loop (Nvidia Nemotron 550B planner + ESMFold) designs, folds, and analyses candidate proteins, mints each validated discovery as a **RES NFT** whose artwork is the real ESMFold-predicted structure, and lets anyone mint, branch from, and trade those discoveries — and **EticaResearchMarkets** (§15), a permissionless launchpad for science-funding ERC-20s where every market trades against the shared 5M-ETX-seeded singleton on an internal constant-product curve with an 80/10/0/10 fee split, no withdrawable LP, a permanent floor-pull property, and auto-Sourcify verification of every minted token. All hosted on free-tier infrastructure. A frontend-only good-faith **jurisdictional gate** on `/stake` and `/farms` mirrors the same posture adopted by Uniswap and Aave; the underlying contracts remain permissionless.

This document describes what EticaHub is, what it is not, and how every live surface of the site works today.

---

## 1. Independence from the Etica Protocol Core Team

**EticaHub is not affiliated with, endorsed by, controlled by, or otherwise operated by the Etica Protocol core team.**

The relationship is purely that of any third-party application interacting with a public blockchain:

- EticaHub is a **community-built, independent project**.
- EticaHub consumes Etica's public smart contracts (ETI, EGAZ, proposal contracts) in the same way any other dapp could — by reading public state and posting transactions. There is no special access, shared multisig, shared treasury, shared roadmap, or shared branding.
- **ETX is EticaHub's own asset**, not an Etica Protocol asset. It is a separate ERC-20 deployed by the EticaHub team for EticaHub's own governance and fee economics.
- EticaHub's treasury, upgrade authority, and all operational decisions are independent.
- Nothing in this paper, in the EticaHub UI, or in EticaHub's contracts should be interpreted as a statement, commitment, or plan of the Etica Protocol core team.

If you are evaluating EticaHub, evaluate it on its own merits as a community-built dapp. Do not assume any guarantees inherited from the Etica Protocol itself.

---

## 2. Design Goals

1. **Make ETI more useful.** Etica's native asset is ETI. We build tools (a DEX, a research hub, a research-token launchpad, and an autonomous AI research lab) whose cash flows and demand vectors grow ETI's utility as a byproduct.
2. **Introduce a reward / coordination token (ETX) without diluting ETI.** ETX is a separate asset for EticaHub-specific cash flow capture: swap fees and pool-creation fees. It does not replace, fork, or compete with ETI.
3. **Hub-and-spoke liquidity.** Rather than fragment liquidity across arbitrary pairs, the DEX enforces that every pair shares a common reserve (ETX). This turns ETX into the unit of DEX-wide convertibility.
4. **Fair launch, no presale, no allocation.** ETX is seeded entirely via on-chain AMM pools opened by the EticaHub treasury with its own capital. There is no private round, public round, airdrop, team allocation, advisor allocation, vesting cliff, or unlock schedule for ETX supply.
5. **No new emissions, ever.** Every redistribution surface (stETX yield, Harvester, farms, buybacks) must be funded from *existing* DEX cash flows — LP fees and swap protocol fees — and never by minting more ETX.
6. **Ship treasury-internal surfaces first.** Surfaces that touch only the *treasury's own* capital (Harvester, POL burns, stETX yield) shipped first because their blast radius is internal. Surfaces that touch user funds — the DEX, the trading stack, liquid staking, and the research-token launchpad — are live and permissionless, each shipped once the underlying liquidity could support it.

---

## 3. ETX Token

**Canonical identity:**

| Property | Value |
|---|---|
| Name | EticaHub |
| Symbol | ETX |
| Decimals | 18 |
| Max supply | 100,000,000 (hard cap) |
| Mint function | none (supply is minted once at deploy) |
| EIP-2612 permit | yes |
| Pausable / Upgradeable | no |
| Blacklists / Freezes | no |
| Source | `packages/contracts/src/etx/ETXToken.sol`, open-source under MIT |

ETX is a standard ERC-20 with EIP-2612 permit support. There is no privileged mint authority, no proxy, no pause switch, no blacklist. Once deployed, the contract cannot be modified, and no additional ETX can ever be created.

**Initial distribution (at genesis):**

| Allocation | Amount | % of supply |
|---|---|---|
| EticaHub treasury wallet (`0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`) | 100,000,000 ETX | 100% |

From that wallet, a small fraction is immediately used to seed the two launch pools on EticaSwap (see §5). The remainder stays in treasury.

**There is no presale, no IDO, no private round, no airdrop, and no public sale of ETX.** The only way to acquire ETX post-launch is to swap for it on EticaSwap against ETI or EGAZ.

---

## 4. EticaSwap: Hub-and-Spoke DEX

EticaSwap is a Uniswap V2–style automated market maker adapted to enforce a single structural invariant: **every pair must include ETX on one side**. Users who want to trade, e.g., ETI ↔ EGAZ route through the ETX hub in two hops.

### 4.1 Contracts

| Contract | Purpose |
|---|---|
| `EticaSwapFactory` | Deploys pair contracts via CREATE2. Enforces ETX hub rule. Holds the optional `feeTo` treasury and a `trustedCreators` allow-list that can exempt designated pool creators from the creation fee. |
| `EticaSwapPair` | Constant-product pair (x·y=k), 0.30% swap fee, optional 0.05% protocol fee to treasury. |
| `EticaSwapRouter` | User-facing router. Multi-hop swaps, add/remove liquidity, native-EGAZ wrapping via WEGAZ. |
| `WEGAZ` | Canonical wrapped-EGAZ ERC-20, deposited/withdrawn at 1:1. Enables EGAZ to participate in ERC-20 pairs. |

### 4.2 Fees

| Fee | Rate | Who collects |
|---|---|---|
| Swap fee (LP) | 0.25% | LP providers of the pair |
| Swap fee (protocol) | 0.05% | EticaHub treasury (if `feeTo` is set) |
| **Pool creation fee** | **10,000 ETX per new pair** | **EticaHub treasury** |

The pool-creation fee is charged in ETX, paid by the caller at the moment a new pair is created, and routed to `feeTo` (the treasury). Key properties:

- The fee is **skipped when `feeTo == 0x0`**, so the factory can bootstrap before the treasury wallet is wired. This was used during launch day: the first two pools (ETI/ETX, EGAZ/ETX) were seeded free, then treasury wiring activated the fee for all subsequent pools.
- Addresses in the `trustedCreators` allow-list are **exempt** from the fee, so designated protocol contracts that open pools are not double-charged.
- The fee is **adjustable** by the `feeToSetter` governance key via `setPairCreationFee(uint256)`. It may be raised, lowered, or set to zero.
- The router transparently forwards the fee on first-time pair creation: users simply approve a slightly larger ETX budget to the router, no extra transaction is required.

### 4.3 Hub-and-spoke rationale

A typical AMM allows any token pair, which fragments liquidity across N² potential pairs for N assets. EticaSwap instead forces every asset to share a common quote (ETX). For N assets, this creates exactly N pools and guarantees every asset is reachable from every other asset through the ETX hub. The resulting ETX pool is, by construction, the DEX's deepest and most consequential market, aligning ETX with overall DEX health.

---

## 5. Launch Parameters (v1 Mainnet — Executed)

### 5.1 Economic parameters

| Parameter | Value | Notes |
|---|---|---|
| ETX supply | 100,000,000 | Fixed, ERC-20, MIT-licensed |
| ETX opening FDV (target) | ~$1,000 | Derived from pool math below |
| ETX opening price | $0.00001 / ETX | 77.75 ETI × $0.0372 / 289,230 ETX ≈ $2.89 / 289,230 ≈ $10⁻⁵ |
| ETI reference price | $0.0372 USDT | NonKYC exchange, reference only |
| EGAZ reference price | $0.0038 USDT | NonKYC exchange, reference only |

### 5.2 Initial liquidity (treasury-provided)

| Pool | Pair side | ETX side | Approx USD/side |
|---|---|---|---|
| ETI / ETX | 77.75 ETI | 289,230 ETX | $2.89 |
| EGAZ / ETX | 761 EGAZ | 289,230 ETX | $2.89 |
| Total ETX in LP at launch | — | **578,460 ETX** (~0.58% of supply) | — |
| Total ETX in treasury post-seed | — | **99,421,540 ETX** | — |

### 5.3 What "fair launch" means here

- **No private sale.** Zero ETX sold to anyone before mainnet.
- **No public sale / presale / IDO / IEO.** Zero ETX sold to anyone during launch.
- **No airdrop.** Zero ETX distributed for free.
- **No team/advisor allocation.** 100% of supply is in a single treasury wallet at genesis.
- **No vesting schedule.** No cliff, no unlock events, no emissions. The full 100M supply exists from block 0; there are no future "unlocks."
- **The only way to acquire ETX post-launch is to swap for it on EticaSwap against ETI or EGAZ, at whatever price the AMM quotes at the moment of the trade.**

This structure is chosen deliberately to minimize the set of plausible securities-law narratives around ETX. ETX is launched openly, at a small FDV, and the team acquires no special allocation.

### 5.4 Vercel-hosted UI

The full EticaHub frontend lives at [https://eticahub.com](https://eticahub.com), hosted on Vercel out of `apps/web`. The v1 genesis was executed via three operator-only deploy pages:

1. `/deploy/etx` — one-click MetaMask deploy of `ETXToken`. Minted 100M to the connected treasury wallet.
2. `/deploy/swap` — three-click deploy of `WEGAZ`, `EticaSwapFactory(etx)`, `EticaSwapRouter(factory, wegaz)`.
3. `/seed/pools` — four-step MetaMask flow (approve ETI, approve ETX, addLiquidity ETI/ETX, addLiquidityEGAZ ETX) that opened both launch pools.

Deploy pages are gated behind `NEXT_PUBLIC_OPERATOR_UI=true` and are **not** part of the public navigation. They are kept in the repo so that the full launch path is reproducible from source. Deployment artifacts (bytecode + ABI) are committed to the repo.

The public pages — `/swap`, `/pool`, `/trade`, `/stake`, `/farms`, `/labs`, `/research`, `/research-markets`, `/explorer`, `/status`, `/whitepaper` — run against live mainnet contracts addressed from `packages/shared/src/addresses.ts` (canonical) and mirrored in Appendix A.

---

## 6. Research Hub

Etica's native proposal contract (`EticaCoreProposals`) tracks medical-research proposals and their authors on-chain. EticaHub exposes these proposals through a reader UI at `/research/proposals`, and adds direct author tipping:

- **Tipping.** From any proposal, a visitor can tip the author in ETI. The tip is a standard ERC-20 `transfer` straight to the author address recorded on-chain by `EticaCoreProposals` — EticaHub never custodies the funds and takes no cut.

The Research Hub is live today, independent of the DEX, and does not require ETX to function: anyone can browse proposals and tip authors in ETI without holding ETX.

---

## 7. Trading Stack (Live)

EticaSwap's Market tab handles immediate one-shot swaps against the AMM. Everything beyond that — limit orders, stop-losses, dollar-cost averaging, grid bots, and Infinity Bot — lives in the **Trading Stack**, exposed at `/trade/[token]`. The stack is non-custodial, modelled on UniswapX, and uses contracts audited independently of anything EticaHub wrote.

### 7.1 Components

| Component | Audited by | Role | Status |
|---|---|---|---|
| [Permit2](https://github.com/Uniswap/permit2) | OpenZeppelin, Trail of Bits, ABDK | One-time per-token approval. Signature-based allowances with per-user nonces and per-sig deadlines. | **Deployed** at `0x165F71f549415f44883e370Df12169Dd99570eE5` |
| [UniswapX `DutchOrderReactor`](https://github.com/Uniswap/UniswapX) | Uniswap Labs audit set | Settles pre-signed Dutch orders. Pulls input via Permit2, swaps through the EticaSwap Router, pushes output to the maker. | **Deployed** at `0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8` |
| `EticaProtocolFeeController` | — (~115-line contract, active at 10 BPS) | ETX-denominated protocol fee on UniswapX fills. Currently set to **10 BPS (0.10%)**; hard-capped at 100 BPS (1%) on-chain. | **Deployed** at `0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a` |
| `OrderRegistry` | — (append-only log, no fund-handling) | On-chain append-only log of posted order envelopes + batch ids. Canonical data source for `/trade/orders` and keepers when the off-chain book is offline. | **Deployed** at `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9` |
| Order book API + reference keeper | open source, `apps/orderbook` + `apps/keeper` | Stores signed orders (off-chain), serves them to fillers, and runs one reference filler. Anyone else can run a filler. | Live |

Full design and the case against each alternative (on-chain order book, custodial bot, etc.) lives in [`docs/TRADING.md`](./TRADING.md).

### 7.2 Order types

| Mode | Semantics | Signatures per wallet popup |
|---|---|---|
| Market | AMM swap via the Router | 0 (regular on-chain tx) |
| Limit | Dutch order with `decayStart == decayEnd == limit` | 1 |
| Stop | Client-side scheduler submits a pre-signed order when the threshold hits | 1 |
| DCA | N scheduled buys | N (one popup, multicall EIP-712) |
| Grid (bounded) | N buys + N sells, linearly spaced inside `[low, high]` | 2N |
| Infinite grid ("Infinity Bot") | N buys below + M sells above a reference, **geometrically spaced** with percent-step | N + M |

### 7.3 Why the Infinity Bot exists

A bounded grid is brittle for a chain whose price can drift meaningfully over months. Once price walks past the user's `high` or `low`, the grid is dead until the user comes back and re-signs. The Infinity Bot replaces that fragility with geometric (percent-based) spacing around a reference price — `R · (1 ± p)^k`. The level structure is scale-invariant, the level count per side is tunable independently, and when price walks past the outermost signed level the user signs one more batch re-centred on the new price instead of re-authoring the whole strategy.

Guardrails baked into the builder:

- **≤ 50 levels per batch.** Wallet UX degrades past ~30 signatures in one popup; 50 is a practical hard cap.
- **Step < 50%.** Geometric progressions with `p ≥ 50%` collapse to zero or diverge within a handful of levels.
- **7-day batch validity.** Same expiry window as the bounded grid.
- **Shared `gridBatchId`.** Every level of one batch carries one batch id so the orders dashboard and any future cancel-whole-batch flow can address them as a unit.

The full Infinity Bot spec — including the math, the risk table, the deliberate non-goals, and the re-sign policy — lives in [`docs/INFINITY_BOT.md`](./INFINITY_BOT.md).

### 7.4 Non-custodial guarantees

The guarantees EticaHub makes about every order type in the Trading Stack — Market, Limit, Stop, DCA, Grid, Infinity — are identical to those of the core DEX:

- EticaHub never holds user tokens or signing keys.
- Every fill is atomic: Permit2 pulls exactly the signed input, the Reactor swaps it, and the output lands in the user's wallet in the same transaction. There is no intermediate custody.
- Users can hard-cancel any signed order by submitting a Permit2 nonce increment on-chain from `/trade/orders`.
- If EticaHub's order book goes offline, every signed order remains valid until its own deadline; users can submit directly to the Reactor or run their own keeper from `apps/keeper`. The on-chain `OrderRegistry` at `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9` serves as the canonical backup data source.

### 7.5 Protocol fee posture

EticaHub charges two structurally distinct fees, on two different trade surfaces. They do **not** stack on the same trade.

| Surface | Fee | Destination | Mechanism |
|---|---|---|---|
| **AMM direct swap** (`/swap`, `/pool`, router calls) | 0.30% to LPs + 0.05% protocol | LPs + treasury `feeTo` | Uniswap V2-style `x·y=k` fee math, hardcoded in `EticaSwapPair` |
| **UniswapX intent fills** (`/trade`, keeper flows) | **0.10% (10 BPS) in ETX** | Treasury | `EticaProtocolFeeController` — added to the resolved order as an explicit ETX fee output before the filler callback runs |

A trade sent to `/swap` pays the AMM fee. A trade sent to `/trade` pays the UniswapX fee. Both fee streams are denominated in economically sensible units: LP fees settle in the pair's native tokens (so LPs keep the mix they signed up for), and the UniswapX protocol fee settles in ETX (every pool is ETX-paired, so one leg of every trade is already ETX — no extra swap hop is needed to collect the fee).

The `EticaProtocolFeeController` owner (treasury wallet) can raise or lower the fee within a hard on-chain cap of 100 BPS (1%). It cannot exceed that cap under any circumstance. There is no owner path that can drain already-collected fees — the controller only decides what future fees *are*, not where existing balances go.

### 7.6 Keeper workflow

A reference keeper (`apps/keeper`) runs as a GitHub Actions cron (`.github/workflows/keeper.yml`) in dry-run mode by default. It reads open orders from the order book API (or the on-chain `OrderRegistry` as a fallback), simulates each fill locally against the live router, and — in "live" mode, which is not enabled by default — submits the winning fill transaction. The keeper is unprivileged: anyone can run a competing keeper, and the reactor accepts fills from any filler. The reference implementation exists so the system has a baseline liveness guarantee independent of any specific operator.

---

## 8. Liquid Staking (stETX) — Live

`StakedETX` is a minimal ERC-4626 vault for ETX deposits. It accepts ETX, issues stETX shares at a variable exchange rate, and redistributes a share of the treasury's LP-fee accruals to depositors — without minting any new ETX.

### 8.1 Design

| Aspect | Decision |
|---|---|
| Asset | ETX (`0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`) |
| Share token | stETX (`0x75d81d03a98CD9195593b8963aF17E13fAa70334`) |
| Standard | ERC-4626 |
| Mint function | none (shares are minted against deposits at the current exchange rate) |
| Owner role | **none** — the contract has no `Ownable` inheritance; the reward-injection path is permissionless |
| Upgradeability | none (contract is final implementation) |
| Withdrawal lockup | none (fully liquid; redeem at will) |
| Source | `packages/contracts/src/etx/StakedETX.sol` |

### 8.2 Yield mechanics

stETX is a pure redistribution vault, not an emitter. The flow is:

1. Treasury LP positions (ETI/ETX, EGAZ/ETX) accrue swap fees continuously as 0.30% of every trade.
2. The off-chain keeper ("Harvester", §9) periodically collects a tranche of those accrued fees, converts them to ETX on the DEX, and calls `StakedETX.distributeRewards(amount)` with the stETX share of the harvest.
3. The vault's `totalAssets()` increases by `amount`, raising the exchange rate `stETX → ETX`. Every existing stETX holder's balance, denominated in ETX, grows pro-rata.

There is no emissions contract, no inflation schedule, no minting, and no new ETX supply. If LP fees stall, stETX yield stalls. If LP fees grow, stETX yield grows. The APY is a function of *observed* harvested yield over the trailing 7 days, rendered on `/stake`.

### 8.3 UI (`/stake`)

The `/stake` page provides:

- **Deposit / Withdraw.** Standard ERC-4626 flow. Withdrawals are instant and full-liquid.
- **7-day trailing APY.** Computed from the exchange-rate trajectory (not advertised forward yield).
- **Exchange-rate chart.** The stETX/ETX ratio over time, visualizing accrual.
- **Vault stats.** `totalAssets`, `totalSupply`, number of depositors.

### 8.4 Non-custodial guarantees

- **There is no owner key.** The vault has no `Ownable` inheritance, no admin role, no pause function, no upgradeability. The only state-changing external entry points are the ERC-4626 deposit/withdraw paths and `distributeRewards`.
- `distributeRewards` is **fully permissionless**: any wallet may call it. Calling it with zero amount reverts with `ZeroAmount()`; a nonzero call requires the caller to have approved the vault for the full amount and transfers that ETX into the vault in the same transaction — shares are never minted, only the exchange rate ticks up.
- Withdrawals are not rate-limited, not paused, not subject to any cooldown.

### 8.5 Treasury commitment (stETX + LP)

The EticaHub treasury is the single largest committer of capital to the protocol. As of v1.2, the on-chain footprint across stETX and LP positions is approximately:

| Position | Treasury holding | ETX-equivalent exposure |
|---|---|---|
| stETX shares (liquid) | ~11.0M stETX | ~11.0M ETX at NAV |
| EticaStableSwap LP — locked 10y in `LiquidityTimelock10y` (§10.2) | 100% of seed | ~30M ETX (15M ETX + 15M stETX) |
| EticaSwap V2 — stETX/ETX LP | ~85.8% of pool | ~7.8M ETX + ~6.95M stETX |
| EticaSwap V2 — EGAZ/ETX LP | ~52.3% of pool | ~0.47M ETX side |
| EticaSwap V2 — ETI/ETX LP | ~7.2% of pool | ~0.13M ETX side |

These figures are read live from chain and will drift block-to-block as fees accrue, public LPs come and go, and the harvester redistributes; the structure is what is fixed, not the exact numbers. Concrete implications:

- **Real floor on TVL.** The `/stake` page does not open with an empty vault, and the V2 + stableswap pools do not open with empty books. APY math, exchange-rate history, and routing depth all have a meaningful denominator from the first block.
- **Skin-in-the-game signal.** The treasury is the largest stETX holder, the dominant LP on every ETX-paired pool, and the only LP on the stableswap. Every design decision about these venues applies to the treasury first — there is no separate "team pool" on better terms.
- **No special privileges.** Treasury stETX shares and treasury LP tokens are identical to any other holder's. Treasury cannot front-run distributions, cannot block withdrawals, cannot mint extra shares, and cannot pull anyone else's liquidity. The `distributeRewards` path is permissionless and capped by the fees the harvester actually collected.
- **Dilutive to treasury by design.** As outside stakers deposit and outside LPs join, treasury's proportional claim on the 10% harvest bucket and on swap fees falls. This is the intended direction: the seed exists to bootstrap credibility, not to lock in a permanent treasury revenue line. The 40% treasury bucket and the 40% POL burn (see §9) are unaffected by participation rate.
- **Stableswap LP is locked, the rest is liquid.** Only the treasury's stableswap LP shares are locked (10 years, principal only — fees stream out continuously via `StableSwapHarvesterAdapter`; see §10.2). The stETX position and the V2 LP positions are fully liquid under ERC-4626 / ERC-20. Any intent to unwind would be fully visible on-chain as `Redeem` / `Burn` events. Public LPs are unaffected by any of these treasury decisions.

---

## 9. Treasury Harvester & POL Flywheel

`TreasuryHarvester` is an on-chain delegation contract that formalizes how the treasury's own LP-fee accruals are redistributed. It exists so the keeper that performs the redistribution can run as a thin, inexpensive EOA with *narrowly scoped* authority, rather than as the treasury wallet itself.

### 9.1 Why a delegation contract

Before the Harvester, redistributing LP fees required the treasury EOA to sign a sequence of `removeLiquidity → swap → transfer → distributeRewards` transactions. That forced the treasury key to be online whenever a harvest was due, which is both operationally fragile and a key-compromise hazard.

The Harvester inverts this: the treasury one-time-approves the Harvester for ETX + both LP tokens, after which `harvest()` is **permissionless** — any wallet can call it, gated only by a 1-day cooldown and a small caller-tip incentive (PR #109). The original keeper-EOA design has been retired. The contract still cannot touch treasury ETX for anything except the 10/10/40/40 split encoded in it.

### 9.2 10/10/40/40 split

Every successful `harvest()` call partitions the freshly-collected fee tranche (in ETX-equivalent) into four destinations:

| Bucket | Share | Destination |
|---|---|---|
| stETX yield | 10% | Forwarded to `StakedETX.distributeRewards` on the live `0x75d8…0334` vault. |
| Farms / LP incentives | 10% | Forwarded to live `ETXFarms` (`0xEBAf…c6aD`), three-pool weighted emissions (60/25/15). |
| Treasury operations | 40% | Retained in treasury for audits, infra, community grants, reserves |
| **POL burn** | **40%** | **Paired with ETI/EGAZ and added to the ETI/ETX and EGAZ/ETX pools as LP, then the resulting LP tokens are sent to the burn sink — permanently locked liquidity** |

### 9.3 The POL burn is the flywheel

The 40% POL burn is the mechanism that makes every swap structurally accretive to pool depth *forever*. The fees leave the treasury, buy LP tokens, and burn them — depth stays in the pool and can never be withdrawn. Three consequences:

1. **Slippage curves improve monotonically.** Each harvest deepens the ETI/ETX and EGAZ/ETX pools, reducing slippage for every future trade.
2. **Depth is independent of any operator.** Because the LP tokens are burned, not held, no future EticaHub key rotation, key loss, or governance action can ever remove the burned depth.
3. **Volume begets depth begets volume.** Higher depth supports larger trades, larger trades generate more fees, more fees feed more harvests, more harvests burn more POL. The loop is self-reinforcing and requires no emissions to sustain.

### 9.4 Status

The Harvester is **deployed, wired, and live on Etica mainnet** at `0x5d8B1138559fADc3Bb90e8317eB16922eAa076f5`. The keeper role was retired in favour of a permissionless v2 (PR #109) — any wallet may now call `harvest()`, gated only by a 1-day cooldown and a small caller-tip incentive. The daily GitHub Actions workflow (`.github/workflows/harvest-live.yml`) calls it on a 24h cadence; if it is ever down, anyone can poke the contract directly. There is also a manual "Harvest now" button on `/admin/harvester` for the treasury operator.

A second fee feed comes from **§10 (EticaStableSwap)**: the stableswap pool's admin-fee slice flows through `StableSwapHarvesterAdapter`, which redeems the stETX leg into ETX via the vault and forwards a pure ETX lump into `TreasuryHarvester.harvestExternal(amount)`. Same 10/10/40/40 split applies. The two feeds (V2 LP-burn and stableswap admin-fee) compose seamlessly because both terminate in the same harvester.

### 9.5 Cron + manual fallback

`harvest()` runs on three independent triggers, in priority order: (i) the daily GitHub Actions workflow `harvest-live.yml`, which calls a small EGAZ-funded EOA to invoke `harvest()` once the cooldown elapses; (ii) any third party wallet, who pays gas and pockets the small caller-tip; (iii) a manual "Harvest now" button on `/admin/harvester` that the treasury operator can fire ad-hoc. None of the callers hold ETX/ETI/LP tokens — `harvest()` is bounded by the on-chain 10/10/40/40 split, so a compromised cron key can only burn gas, not steal funds.

### 9.6 ETXFarms — the farms-bucket consumer

The 10% "farms" slice of every harvest cycle is consumed by the `ETXFarms` contract (`packages/contracts/src/etx/ETXFarms.sol`, 25 unit tests in `test/etx/ETXFarms.t.sol`, all green). ETXFarms is an accumulator-style LP staking contract — the MasterChef pattern, but *without emissions*. It only distributes ETX that the Harvester actively pushes in.

**Architecture — pull-based, no vesting.** The Harvester calls `farms.distributeRewards(amount)` at the end of each cycle (permissionless entry point, symmetric with `StakedETX.distributeRewards`). Rewards are written directly into the per-pool `accRewardPerShare` accumulator with no drip/vesting window. Stakers see rewards spike on harvest days and flat between them. This is deliberate: it matches the cadence the Harvester actually emits at, and avoids the timing-attack surface that linear-drip models like Synthetix's `StakingRewards` carry (jump in before a big notify, jump out after).

**Pool set at launch.** Two pools, both seeded with the treasury's genesis LPs:

| pid | LP token | Default weight |
|---|---|---|
| 0 | EticaSwap ETI/ETX | 5000 |
| 1 | EticaSwap EGAZ/ETX | 5000 |

Weights are `allocPoint` values (sum = 10,000 by convention). The owner can `addPool(lp, allocPoint)` to register new pools, or `setAllocPoint(pid, newAllocPoint)` to retune weights. The sum of weights is capped so no pool can starve the others permanently.

**Reward split math.** Every `distributeRewards(amount)` call loops over pools: `poolShare = amount * pool.allocPoint / totalAllocPoint`. If a pool has zero staked LP at the moment of distribution, its share is routed to the fallback recipient (treasury, by default) rather than sitting idle forever. If a pool has stakers, `pool.accRewardPerShare += poolShare * 1e18 / pool.totalStaked`, the standard MasterChef formula, so a late joiner cannot claim a pro-rata share of rewards distributed before their deposit.

**User surface — no lockup, no penalty.**

- `deposit(pid, amount)` — auto-harvests any pending rewards into the user's ETX balance, then credits `amount` LP to their stake.
- `withdraw(pid, amount)` — same auto-harvest, then returns `amount` LP.
- `harvest(pid)` — claim pending rewards without touching the LP position.
- `emergencyWithdraw(pid)` — panic exit that returns all staked LP and *forfeits* pending rewards. Exists so a user can always get their LP back even if reward-accounting is somehow stuck.
- No deposit fee, no withdrawal fee, no cooldown. Matches the rest of the stack's "non-custodial by default" posture.

**No emissions, ever.** ETXFarms holds no mint authority on ETX (ETX is a fixed-supply ERC-20 with no minter). It can *only* distribute ETX that was transferred into the contract and then accounted for via `distributeRewards`. The total supply cap at 100M ETX is unaffected by farms going live — farms redistribute existing protocol fees, they do not create new supply.

**Owner scope.** The contract owner can register new pools, retune weights, and set the fallback recipient. The owner *cannot* steal staked LP (`rescueToken` is explicitly guarded against rescuing any registered LP token or the reward token ETX). The owner *cannot* pause withdrawals. The owner *cannot* change reward semantics retroactively. Owner is the treasury key, the same key that holds `feeToSetter` and `TreasuryHarvester.owner`.

**Audit posture.** Forge unit tests cover: metadata and shape, owner-only gates, deposit/withdraw mechanics, accumulator math for the solo-staker and two-staker-pro-rata cases, multi-harvest sequencing, late-joiner protection, empty-pool fallback routing, emergency withdrawal, rescue guards, and permissionless `distributeRewards` parity. No external audit has been commissioned — same posture as stETX and the Harvester.

**Deployment.** Operators deploy via `/deploy/farms` (browser-based, signs from the connected wallet). Post-deploy: paste the address into `packages/shared/src/addresses.ts → DEPLOYMENTS[61803].etxFarms`, call `addPool(ETI/ETX LP, 5000)` and `addPool(EGAZ/ETX LP, 5000)`, then call `TreasuryHarvester.setFarms(etxFarms)` to route the 10% farms bucket. `/farms` will light up the moment the address is non-zero.

---

## 10. EticaStableSwap (the V3 pool)

> Naming note: EticaSwap V1 was the original Etica-side AMM; EticaSwap V2 is the hub-and-spoke constant-product DEX described in §4 (still the venue for ETI/ETX, EGAZ/ETX, etc.); **EticaStableSwap is the protocol's V3 pool** — a separate, rate-aware Curve-style AMM dedicated to correlated assets (today stETX↔ETX). Where this paper says "V3 pool," it means EticaStableSwap.

`EticaStableSwap` is a rate-aware, Curve-style AMM purpose-built for stETX↔ETX. It exists because a constant-product V2 pool quotes the wrong price the moment stETX's NAV drifts above 1.0 ETX, and a naïve Curve pool would drift out of range as the vault accrues yield. EticaStableSwap **reads `stETX.convertToAssets(1e18)` directly on every swap** so the curve auto-tracks NAV forever — no manual rebalancing, no LP rotation, no stale parameters.

It also closes a strategic gap: stETX↔ETX is the canonical exit highway for the protocol's liquid-staking surface (§8). Routing it through the deepest, lowest-slippage venue keeps stETX's peg credible.

### 10.1 Architecture

Three contracts working together:

| Contract | Role |
|---|---|
| `EticaStableSwap` | Rate-aware Curve-style pool. Holds `reserveEtx` + `reserveStEtx`. Live-NAV-quotes via `stETX.convertToAssets`. Anyone can add or remove liquidity. |
| `LiquidityTimelock10y` | Holds **only the treasury seed's** LP shares for 10 years. Public LPs are unaffected — the lock is on the treasury, not the pool. |
| `StableSwapHarvesterAdapter` | Permissionless. Skims the pool's accumulated admin fees, redeems the stETX leg into ETX via the vault, forwards the pure ETX lump into `TreasuryHarvester.harvestExternal()`. |

The AMM contract is final, ownerless from a fund-custody perspective (the only owner-gated functions are parameter knobs: `rampA`, `setSwapFee`, `setAdminFee`, `setAdminFeeRecipient`), and source-public under MIT (`packages/contracts/src/stableswap/EticaStableSwap.sol`).

### 10.2 Treasury seed: 30M ETX, locked 10 years

The pool is seeded with **15,000,000 ETX + 15,000,000 stETX** (~30M ETX-equivalent at NAV) drawn from the treasury. The seed is irrevocable: the resulting LP shares are minted directly to `LiquidityTimelock10y`, which has no early-unlock path. The unlock timestamp is `2036-05-01 08:17:29 UTC`.

Key asymmetry: **the lock is on the treasury, not on public LPs.** Anyone can deposit on `/pool` and withdraw any time. The treasury chose to immobilize its own seed for 10 years; nobody else has to. This is the inverse of a typical "team unlock" schedule — the protocol's primary liquidity is *the most* locked, not *the least*.

The seed is also **not** counted in circulating supply for market-cap purposes (§12 / `/api/v1/tokens`): the locked-LP wrapper + treasury holdings are subtracted, in line with CoinGecko/CMC convention.

### 10.3 Fees and flywheel

Every swap pays a **4 bps fee** (0.04%, Curve-standard for stable pairs). Of that fee, **50% is retained in the pool** (grows LP share value for everyone, including the locked treasury seed) and **50% is the admin slice** (streams permissionlessly to `StableSwapHarvesterAdapter`).

```
     ┌───────── EticaStableSwap (stETX/ETX, A=200, 4 bps fee) ─────────┐
     │                                                                  │
     │ 50% of fee → grows LP value (incl. 10y-locked treasury shares)   │
     │ 50% of fee → admin accumulator                                   │
     │                       │                                          │
     └───────────────────────│──────────────────────────────────────────┘
                             ▼
             StableSwapHarvesterAdapter (permissionless claim)
                             │
                             ▼  redeem stETX → ETX via vault (1:1 NAV)
             TreasuryHarvester.harvestExternal(etxAmount)
                             │
                             ▼  10/10/40/40 split (§9)
              stETX vault │ ETXFarms │ POL burn │ treasury
```

The locked LP shares and the admin fees are **two separate value streams**: locking the principal does not lock the fees. The treasury can claim the admin slice continuously while the seed itself stays immobilized. Public LPs are not entitled to admin fees — they earn from the LP-retained 50% (and from stETX NAV drift on the stETX-leg side of the pool).

### 10.4 Why a separate AMM

| | EticaSwap V2 | EticaStableSwap |
|---|---|---|
| Curve | constant product (`x · y = k`) | Curve-style invariant + rate adjustment |
| Fee tier | 0.30% | 0.04% |
| stETX support | possible but mis-priced | native (`getRate` in every quote) |
| Slippage at NAV | ~tens of bps for $1k+ trades | sub-bp for $50k+ trades |
| Treasury position | LP tokens harvested via burn-route | LP tokens locked 10y; fees streamed via adapter |
| Public LP lock | none | none |

The two AMMs cohabit on `/swap`: stETX↔ETX direct routes through the stableswap; everything else goes through V2. The router checks `getDy()` on the stableswap when applicable and falls back to V2 if the stableswap is not deployed or the requested pair is not supported.

### 10.5 Public LPs (`/pool`)

`/pool` shows two cards: the V2 add/remove-liquidity flow (existing) and a public stableswap card (new). Public LPs deposit ETX + stETX, receive LP shares directly to their wallet, and can withdraw at any time via `removeLiquidity` (pro-rata, both legs) or `removeLiquidityOneCoin` (single-asset, with curve-derived slippage). No emissions on this pool — public LPs earn from fees and stETX NAV drift only.

### 10.6 Status surface

`/status` exposes live stableswap data via `/api/v1/tvl` (TVL = `reserveEtx + reserveStEtx · getRate / 1e18`) and `/api/v1/liquidity-flow` (counts `AddLiquidity`/`RemoveLiquidity`/`RemoveLiquidityOne` events as a separate per-pool entry alongside the V2 Mint/Burn flow). The 30M ETX seed appears in both endpoints. `/admin/stableswap` is the operator panel for permissionless `claimAdminFees`/`harvest` and owner-gated `rampA`/`setSwapFee`/`setAdminFee`/`setAdminFeeRecipient`/`lockedWithdraw` (only fires after 2036).

---

## 11. EticaHub Explorer

A skinny on-chain explorer lives at `/explorer`, powered by the same JSON-RPC node the rest of the site uses plus a lightweight JSONL indexer (see §11.3). It exists so that a user clicking a tx hash from `/swap`, `/trade`, or the Telegram buy bot (§13) lands on a first-party page under the EticaHub domain rather than an off-site explorer.

### 11.1 Pages

| Route | Purpose |
|---|---|
| `/explorer` | Latest blocks and transactions |
| `/explorer/block/[n]` | Block detail: header, tx list, gas used |
| `/explorer/tx/[hash]` | Tx detail: decoded calldata, decoded event logs, status, gas |
| `/explorer/address/[addr]` | Address detail: balance, token balances, recent txs, ERC-20 transfers |
| `/explorer/token/[addr]` | ERC-20 token page: metadata, holders, transfers, price, OHLCV |
| `/explorer/gas` | Live gas tracker: rolling fee stats over recent blocks |
| `/explorer/verify/[addr]` | Contract verification submission |

### 11.2 Sourcify-backed verification

Contract source verification uses [Sourcify](https://sourcify.dev) as the canonical source of truth. Users (or operators) submit a compilation artifact + sources at `/explorer/verify/[addr]`; the explorer pushes them to Sourcify, which publishes a verified metadata record. The explorer then reads back the verified ABI + sources to decode calldata and events on the tx and contract pages. There is no EticaHub-owned verification registry — we rely on Sourcify so verifications are portable to any other explorer that reads from Sourcify. See [`docs/SOURCIFY_CHAIN_ADD.md`](./SOURCIFY_CHAIN_ADD.md) for how chain 61803 was added.

### 11.3 On-chain + JSONL indexer

The explorer reads from two data sources, in order of preference:

1. **Gzipped JSONL shards** produced by a GitHub Actions cron at `.github/workflows/explorer-indexer.yml`. The indexer walks `Swap` and ERC-20 `Transfer` logs in block-range batches, writes them to size-capped JSONL shards (`apps/indexer/data/*.jsonl.gz`), and commits the shards back to the repo. This makes address + token pages fast for historical data without hammering the RPC.
2. **Live RPC fallback.** If a shard is missing or malformed, the reader falls back to `eth_getLogs` on the live RPC. The fallback is silent to the user and intentionally conservative (narrow block ranges, bounded retries) so a bad shard never breaks a page.

---

## 12. Public Market Data API

`/api/v1/*` is a small public read-only HTTP API that exposes the same data the UI uses, in a format aggregators (CoinGecko, CMC, DEX Screener, GeckoTerminal) can ingest directly. No auth, JSON only, CORS-enabled.

| Endpoint | Returns |
|---|---|
| `/api/v1/pools` | List of EticaSwap pools with reserves, 24h volume, TVL |
| `/api/v1/pairs` | Same, canonical-form pair ids |
| `/api/v1/pairs/{address}` | Pool detail (reserves, reserves-USD, last-price, fee tier) |
| `/api/v1/pairs/{address}/volume` | 24h rolling volume |
| `/api/v1/pairs/{address}/candles` | OHLCV candles (1m, 5m, 1h, 1d) |
| `/api/v1/tokens` | List of tokens with latest prices |
| `/api/v1/tokens/{address}` | Token detail (price, market cap, supply, FDV) |
| `/api/v1/health` | RPC health + indexer freshness |

Submission briefs for the major aggregators are in [`docs/aggregators/`](./aggregators/) — one markdown file per listing process (CoinGecko, CMC, DEX Screener, GeckoTerminal) with the exact payload each service expects.

---

## 13. Community Buy Bot

A Vercel-cron-hosted Telegram bot posts every swap on every ETX pair to the EticaHub community group. It is a downstream consumer of the same RPC + indexer layer as the explorer; it does not touch user funds and has no privileged access.

### 13.1 Architecture

The bot lives as a single Next.js route (`apps/web/src/app/api/cron/buybot/route.ts`) invoked by Vercel's cron scheduler at 1-minute cadence. Each invocation:

1. Reads the last-scanned block cursor from Vercel KV.
2. Calls `eth_getLogs` for every `Swap` event on every ETX pair between `lastScannedBlock + 1` and `latest`.
3. Snapshots each pool's post-swap reserves + relevant token metadata (name, symbol, supply).
4. Pulls USD anchors from NonKYC's public API (ETI/USDT, EGAZ/USDT spot).
5. Derives ETX/USD from the first pool in the window that pairs ETX with ETI or EGAZ.
6. For each swap, renders a message with the side bought, amounts in and out, ETX + USD prices, market caps of both tokens, and links to the `/explorer/tx/[hash]` and `/explorer/block/[n]` pages.
7. POSTs to `api.telegram.org/bot<token>/sendMessage`.
8. Writes the new block cursor.

### 13.2 Safety rails

- **Per-swap dedup.** Every posted swap is claimed in KV by `(txHash, logIndex)` with a 24-hour TTL. A pre-check skips any swap that was already claimed, even if the block cursor rewinds. The claim is written *after* a successful Telegram send, never before, so a failed send never locks a swap out of retries. Transient KV failures (read or write) are swallowed; the worst case is one duplicate post once KV recovers.
- **Min-USD floor.** Swaps below a configurable USD notional are skipped to avoid spam on dust trades.
- **No private keys.** The bot holds no funds, signs no transactions, has no on-chain authority.
- **Failure mode: silent.** A missing env var, a dead RPC, a Telegram rate-limit, or an indexer stall all degrade to "no messages posted this minute". The cron simply re-runs on the next tick and catches up.

### 13.3 Why Vercel cron instead of a long-lived WebSocket

A WebSocket listener is the canonical architecture for a buy bot and is ~30s faster, but it requires always-on hosting (Fly, a VPS, etc.) and its own monitoring. Vercel cron is $0, redeploys on every `git push` alongside the rest of the site, and logs every invocation in the Vercel dashboard. The ~60s lag is acceptable for a community ticker.

---

## 14. EticaLabs — AI Molecular Intelligence Workstation

EticaLabs (`/labs`) is a community-built molecular-intelligence workstation. It turns a plain-English research goal into a folded 3D protein structure, an AI structural analysis, and a continuously-running research loop — and lets anyone mint a validated discovery as an on-chain **RES NFT** whose artwork is the *real* predicted structure. The research surface itself is free and wallet-less; minting, branching, and trading discoveries are optional on-chain actions. It runs entirely on free infrastructure: Nvidia-hosted Nemotron (LLM), NVIDIA NIM ESMFold (folding), Upstash Redis (queue + archive), GitHub Actions (worker cron), and Vercel (web + cron + LLM proxy).

### 14.1 The pipeline

```
prompt
  │
  ▼
Nvidia Nemotron 3 Ultra 550B ─── plan (hypothesis, approach,
  │                              success criteria, risks,
  │                              3 candidate sequences, references)
  ▼
ESMFold cascade ─── NVIDIA NIM ESMFold → Hugging Face ESMFold
  │                 (first engine to return a PDB wins)
  ▼
PDB ─── 3Dmol.js (browser WebGL) → view, mutate, export, share
  │
  ▼
Nemotron analysis ─── secondary structure, residue patterns,
                      predicted function, stability
```

Every step is its own free API call. All LLM traffic (plan, analyse, mutate, seed) is proxied through a single Vercel route (`/api/labs/llm`) that enforces a shared **40 RPM** budget across the worker and the website and inherits the 300s Vercel Pro execution ceiling, so a slow 550B generation can finish without being aborted mid-plan.

### 14.2 Research planning layer

Before any fold runs, `/api/labs/plan` fetches **PubMed** (NCBI E-utilities, free, no auth) and **RCSB PDB** (free public search) for the most relevant papers and solved structures. Both are passed into Nemotron's planning prompt so each candidate sequence cites prior work by `[N]` index and explicitly differentiates itself from cited references rather than inventing in a vacuum. The `/labs` UI surfaces both as a clickable **Related research** panel.

### 14.3 Fold engine cascade

| Engine | Provider | Role |
|---|---|---|
| ESMFold (NVIDIA NIM) | health.api.nvidia.com | Primary — async 202-poll, most reliable host today |
| ESMFold (Hugging Face) | HF inference router | Fallback — used when NVIDIA is unavailable |

Each engine gets up to 3 attempts with exponential backoff (0s, 5s, 30s) and a 90s per-attempt timeout. The cascade exits on the first successful PDB and reports an **engine trace** on every call (which engines were tried, their status, their duration) so users can see exactly where the cascade landed. If every engine exhausts its retries the candidate is still published "structure pending" with a sequence-only score, so a flaky fold host never blocks the rest of the pipeline.

### 14.4 EticaLabs Autopilot — public research feed

`/labs` exposes a **"Run continuously"** submit panel alongside the direct-fold and create-plan buttons. Submissions land in a Redis-backed queue (`labs:queue:pending` list, `labs:feed` sorted set, `labs:job:<id>` blobs with 30-day TTL). The worker pops the oldest pending job, runs **plan → fold → analyse → mutate** for `N` iterations (1–5, user-selected), seeds each iteration from the previous round's top scorer, and writes results back to Redis. When the queue is empty it **auto-seeds** a fresh research goal from live academic data so the lab never sits idle. The worker endpoints (`POST /api/labs/queue/pop`, `POST /api/labs/queue/[id]/update`) are gated by a shared-secret bearer token (`LABS_AUTOPILOT_TOKEN`, constant-time compared).

The worker runs on GitHub Actions (`.github/workflows/labs-autopilot.yml`). Because GitHub throttles high-frequency `schedule` events on shared runners, a Vercel cron also pings `/api/labs/autopilot/dispatch` every minute, which fires a `workflow_dispatch` run — manual dispatches are not throttled, so the worker ticks reliably.

| Surface | Behavior |
|---|---|
| `/labs/feed` | Public list of every submitted run with status (pending / running / done / error), prompt preview, relative timestamps, and the pending-queue depth. |
| `/labs/feed/[id]` | Full run view: plan + references, every candidate as its own card with sequence, rationale, AI analysis, score, inline 3Dmol viewer, and per-candidate **Download PDB**. Event timeline (queued → started → planned → folded → analysed → mutated → iteration_done → completed). Auto-polls every 5s while pending/running. Share button copies a deep-linkable URL. |

Submissions are fully open — no auth, no payment, no whitelist. A per-IP rate limit (5 submissions/hour) and a 400-character prompt cap keep abuse bounded; plans that fail the safety prompt error out and are visible as such on the public feed.

### 14.5 Per-sequence structure archive

Every folded candidate's backbone is stored as a compact **Cα-only PDB trace** (~2–16 KB) in Redis, keyed by `sha256(sequence)[:32]` and de-duplicated across jobs. This archive is what lets a minted NFT render the real structure for *any* candidate, not just the first. Older discoveries that folded before the archive existed — or that lost their inline structure — are **self-healing**: a manual re-fold (`/api/labs/fold/[id]/re-fold`) or the 5-minute cron drain re-runs the fold and writes the trace back, and every structureless candidate exposes a one-tap **Regenerate structure** button.

### 14.6 RES NFTs — minting a discovery

A validated discovery can be minted as a **RES** (Research Entity Structure) NFT — an ERC-721 at `0x4B7673665543bC1ABf13a023Ae2A04e91A4259f9`. Two properties make it unusual:

- **The art is the science.** The image is the discovery's real ESMFold-predicted Cα backbone trace, coloured residue-by-residue by pLDDT confidence (deep blue ≥90 → orange <50) and projected onto the structure's principal axes — rendered live by `/api/labs/fold-render/[tokenId]` from the archived trace. It is a genuine fold, not a generative skin.
- **The record is on-chain.** The full scientific record (sequence, AI analysis, pLDDT score, iteration count, and research lineage) is written once into the contract at claim time and never altered by transfers.

Minting is permissionless and gated only by an **attestor-signed claim payload** (the attestor address is immutable; the server signs every legitimate discovery). The mint follows a **three-tier window** anchored to the discovery's timestamp:

- **Tier 1 — originator (0–24h).** Only the wallet that started the research may claim; the NFT mints to that wallet.
- **Tier 2 — open market (24h–7d).** Anyone may claim, minting the NFT to themselves. The original discoverer is still credited in the royalty cascade.
- **Tier 3 — treasury (after 7d).** The research is abandoned; anyone may settle it but the NFT is force-minted to the immutable treasury address (see §14.8).

The per-claim mint fee is paid in native EGAZ: a flat base fee plus a score-indexed slice (a higher pLDDT score pays a higher fee, capped on-chain). The fee is split **79 / 20 / 1** (holder / ancestor cascade / treasury) through the same splitter described below, and is **waived** on the Tier-3 treasury auto-forfeit so the treasury never pays itself.

### 14.7 The Mintable section + one-click cascade branching

`/labs` surfaces a **Mintable** grid (`/api/labs/mintable`) of Tier-2 discoveries — past their 24h originator window, before the 7-day forfeit — each shown as a card with the fold image, score, and a live countdown to treasury forfeit. Every card carries two actions:

- **Mint** — claim the RES NFT in one tap.
- **Branch from this** — spawn a child research goal seeded from the parent discovery's context. Branching links the child's `parentGoalId` to the parent's on-chain `branchGoalId`, so the lineage is recorded. You can also branch directly from any RES NFT you hold or any active marketplace listing.

**Royalty cascade.** Each token gets its own royalty splitter, deployed via CREATE2 with the tokenId as salt and immutable thereafter. The token's 5% ERC-2981 secondary royalty (and its mint fee) flow into that splitter and are released **79% to the current holder, 20% up the ancestor lineage, 1% to the treasury**. The ancestor leg is geometric — each ancestor takes 80% of the running pool and passes the remaining 20% up the chain, capped at 25 levels — so when a descendant discovery sells, every ancestor holder above it earns. A reverting ancestor wallet can never brick a release; its slice falls through to the current holder. Selling a RES therefore transfers its entire future royalty stream to the buyer.

### 14.8 Treasury crank

Discoveries left unminted past their 7-day window forfeit to the treasury automatically. A server-side keeper (`/api/labs/treasury/crank`) fires on **every mint anywhere on the platform**, plus an autopilot safety-net pass, and settles a batch of expired records by submitting the attestor-signed claim that force-mints them to the treasury. The settlement is a **separate transaction** the platform pays gas on — a minter never pays to settle someone else's forfeit — and the mint fee is waived on this path. The treasury becomes the first holder and can list the token on the marketplace to forward its royalty stream.

### 14.9 Secondary marketplace

`EticaResearchMarketplace` (`0x4D1eb3884927A9ad0d77E1627698f1153AAd5aDC`, bound immutably to the RES NFT) is a minimal, non-custodial fixed-price market at `/labs/market`: a holder lists a RES for a native EGAZ price; a buyer pays it; the contract auto-deducts the 5% ERC-2981 royalty, routes it to the token's splitter, and pays the seller the remainder. There is **no admin, no owner, no pause, and no platform fee beyond the ERC-2981 royalty**.

### 14.10 Research encyclopedia

`/labs/archive` indexes every completed discovery into a searchable encyclopedia, filterable by disease / target / keyword and by academic source (PubMed, PDB, UniProt, ChEMBL, STRING, KEGG, AlphaFold), so the lab's accumulated output stays browsable rather than scrolling away on the feed.

### 14.11 Non-custodial / non-financial posture

The research surface — planning, folding, analysis, the feed, and the archive — touches no funds and needs no wallet. The optional on-chain layer is fully non-custodial: claims are attestor-signed but always minted to the caller (or, on forfeit, to the treasury); the marketplace escrows nothing beyond the active listing; and EticaHub takes no cut beyond the on-chain mint fee and the fixed 1% treasury royalty slice. No new ETX is ever minted by any of this — EticaLabs creates ERC-721 records and routes EGAZ, never ETX supply.

---

## 15. EticaResearchMarkets — Permanent Floor Pull via Locked POL

**EticaResearchMarkets** is a permissionless, singleton-based launchpad for ERC-20 tokens that fund scientific research. Each token represents a research project; supporters buy in to fund the work; the price is discovered automatically on an internal constant-product bonding curve against ETX; the researcher receives a share of trading fees; and a permanent, non-withdrawable share of every trade compounds the curve's ETX-backed floor forever. This section describes the contract design, the fee split, the graduation flow, the sunset flow, the auto-Sourcify property, and how the launchpad slots into the rest of EticaHub without altering any existing surface.

### 15.1 Why a separate launchpad for research

Most token launchpads either gate who is allowed to launch or spin up a fresh AMM pool per token — fragmenting liquidity and leaving extractable LP positions behind. EticaResearchMarkets takes the opposite approach, aimed at the long tail of small, exploratory, and independent research efforts: **permissionless launch, evidence-required at deploy time, singleton liquidity, no LP positions for anyone to extract, and a fee split engineered so the curve's floor only rises**.

### 15.2 Architecture — one singleton, many markets

There are exactly two contracts in the launchpad: `EticaResearchMarkets` (the singleton) and `ResearchToken` (the per-launch ERC-20 template). All liquidity, all accounting, and all routing live in the singleton. There are no per-token pools, no LP tokens, and no external AMM positions to manage.

| Component | Role |
|---|---|
| `EticaResearchMarkets` | Singleton. Holds **all** ETX reserves. Mints/burns each `ResearchToken` against an internal accounting reserve. Routes every trade. Holds the shared treasury seed (5M ETX, see §15.6) as the free-pool backstop. Emits `Launched`, `Bought`, `Sold`, `Graduated`, `Sunset`. |
| `ResearchToken` | Plain `ERC20Permit`. Constructor stores `name`, `symbol`, `image`, `description`, `website`, `telegram`, `x`, `evidenceURI`, `market`, `researcher`. **No `Ownable`, no `AccessControl`, no pause, no transfer tax, no blacklist, no upgrade path, no `delegatecall`**. `mint` and `burn` are restricted to the `market` (the singleton). |

Because `ResearchToken` is a fixed template with no varying logic — only the constructor strings differ across launches — its bytecode is **deterministic across every launch**. This is the property that makes auto-Sourcify verification (§15.5) feasible.

### 15.3 The bonding curve and per-token solvency

Each market keeps its own pair of virtual reserves: `(etxReserve_i, tokenReserve_i)` with `k_i = etxReserve_i * tokenReserve_i`. A buy adds ETX to `etxReserve_i` and mints the constant-product delta of `ResearchToken_i` to the buyer; a sell burns tokens from the seller and pays out the constant-product delta of ETX from `etxReserve_i`. The math is identical to a Uniswap V2 pair, but there is no LP token, there is no external pool contract, and every market's reserves are physically scoped to that market in the singleton's storage.

This gives **per-token solvency**: at any block, the ETX a market can pay out to its sellers is bounded above by the ETX that market has received from its buyers (plus the in-curve fee accrual described in §15.4). No market can drain another market. The shared 5M-ETX free pool is a discovery backstop (§15.6), not a cross-collateral source.

A market enforces three additional bounds at the curve layer:

- **Per-tx 5% cap:** no single trade can move more than 5% of the curve's ETX reserve in either direction.
- **TWAP deviation guard:** a single trade's executed price cannot deviate by more than a configured threshold from the curve's recent EMA. This makes the curve resistant to flash-loan-style instantaneous wicks.
- **EOA-only first 100 blocks:** the first 100 blocks after launch are restricted to `tx.origin == msg.sender`, which blocks contract-funded sniping bots without preventing real users from interacting via wallets.

### 15.4 Fee split — C-with-lock, 80 / 10 / 0 / 10

Every trade pays a 1% fee in ETX. The fee is split at trade time:

| Slice | Destination | Property |
|---|---|---|
| **80%** | Stays in the curve's `etxReserve_i` | **Non-withdrawable by any actor, for any reason**. This is the permanent floor pull. |
| **10%** | Buys ETI on the existing ETI/ETX EticaSwap pool, pairs the resulting ETI back to ETX, and sends the resulting LP token to `0x000…dead` | Permanent POL burn on ETI's market. Same mechanism the TreasuryHarvester (§9) uses. |
| **0%** | Treasury | The launchpad takes no protocol-level cut. |
| **10%** | Researcher (the address that called `launch()`) | Funds the work. |

The critical property is the 80% slice. There is **no admin function on the singleton that can remove ETX from `etxReserve_i`**. Sells pay out from this reserve, buys add to it, and the 80% fee slice compounds on top. The curve's floor — the ETX price a holder receives if they sell back to the curve — is therefore monotonically non-decreasing in the absence of net sell pressure, and structurally rising in the presence of any trading activity at all. This is what "permanent POL lock" means in a singleton architecture: there is no LP token to burn, because there is no LP token at all; the lock is enforced by the contract not having a withdrawal path.

The 10% ETI LP burn ties launchpad activity to ETI's market in the same way TreasuryHarvester (§9) ties DEX activity to ETI's market. Every research-market trade structurally deepens ETI's liquidity. There is no scenario where launchpad volume strengthens spoke tokens at ETI's expense.

### 15.5 Auto-Sourcify verification on every launch

Research tokens are funding instruments. Buyers are trusting that the token they hold has no hidden mint, pause, transfer tax, blacklist, or upgrade hook. The most reliable way to demonstrate that — short of a per-token audit — is to:

1. Freeze `ResearchToken` behind a single, audited template (done — see §15.2), and
2. Have an independent third party confirm that every on-chain token's bytecode is an exact match of that template.

EticaHub does (2) automatically. A canonical Sourcify `standard-input.json` for `ResearchToken` is committed at `packages/contracts/sourcify-bundles/ResearchToken/`. A stateless GitHub Actions cron at `apps/research-markets-sourcify/` runs every 10 minutes: it reads `Launched` events from the singleton, asks the Sourcify server which tokens are already verified, and POSTs the canonical bundle for any token that isn't. The worker is fully idempotent — Sourcify itself is the deduplication source, so partial failures and retries are safe. Researchers do nothing.

Until chain 61803 is added to the public Sourcify server ([argotorg/sourcify#2758][add-pr]), the cron logs the expected `400/422/501` response and exits clean, and the launchpad UI shows *Chain pending Sourcify support*. The existing manifest-based explorer at `eticahub.com/explorer` continues to show source for every verified contract via the same bundle. The Sourcify pipeline is strictly additive — a second, independent verification surface that activates the moment upstream support lands.

This is an explicit **anti-MEV property**. Unverified tokens can quietly include backdoor mint, transfer-block, or pause hooks that drain liquidity once price discovery starts. Bytecode-equivalence with the verified template makes that class of attack impossible to hide. Full design lives in [`docs/RESEARCH_MARKETS_SOURCIFY.md`](./RESEARCH_MARKETS_SOURCIFY.md).

[add-pr]: https://github.com/argotorg/sourcify/pull/2758

### 15.6 The 5M ETX seed and the free-pool backstop

The EticaHub treasury seeds the singleton with **5M ETX** at deployment. This seed sits inside the singleton as a **free pool** — it is not collateral underneath any individual market, but it serves as a discovery backstop. New markets bootstrap pricing against the free pool; over time the per-market curves grow their own `etxReserve_i` from buyer ETX and from the 80% in-curve fee slice; if a market sunsets (§15.8), whatever ETX it represented is recycled back to the free pool.

The seed is not the upper bound on launchpad TVL — that bound is total ETX in circulation. As activity accumulates, the launchpad's total ETX (free pool plus all per-market reserves) can rise indefinitely, capped only by the 100M ETX fixed supply at the protocol level. There is no path by which the seed *shrinks* below the 5M deposited amount in steady state, because:

- The 80% in-curve fee slice compounds inside the per-market reserves, not the free pool, but **none of it ever leaves the singleton**.
- Sunset returns recycle dormant ETX *to* the free pool, not away from it.
- The only outflow from the singleton is sellers being paid the constant-product delta from their market's own reserve.

### 15.7 Graduation — UI only, no migration, no LP

When a market's `etxReserve_i` crosses **100,000 ETX**, the singleton emits `Graduated(token)` and the launchpad UI tags the market as graduated. **There is no contract migration.** No LP gets created, no liquidity is moved, no token state changes. The curve remains the only venue for the token, and the singleton remains the only venue for routing.

What changes is purely user-surface:

- The graduated token is listed in `/swap`'s token picker.
- `/trade/[address]` resolves the graduated token's curve price via the singleton's quoter view and posts DutchOrder fills that the keeper executes against the curve. The same UniswapX-style trading-stack surfaces (Market, Limit, Stop, DCA, Grid) become available against the graduated token.
- The launchpad detail page tags the token with a *Graduated* badge and adds a *View in /swap* link.

This design — UI-only graduation against a singleton bonding curve — preserves the per-token-solvency, no-LP-position, and floor-pull properties of the launchpad while extending the trading surface for tokens that have crossed the activity threshold. Mechanically, a graduated token is the same as a pre-graduation token; only the surfaces that show it differ.

### 15.8 Sunset — recycle to free pool, no token effects

If a market goes 30 days with no trades and has not graduated, the singleton emits `Sunset(token)` and the launchpad UI removes the market from the active list. **The ResearchToken itself is unaffected** — holders retain their balances, and the singleton's sell path remains open at the curve's posted price, so any holder can always exit back to ETX. What changes is that the dormant ETX in the market's `etxReserve_i` is reclassified as free-pool ETX for the purpose of internal accounting, available to backstop discovery on new launches.

No holder loses anything at sunset; the launchpad UI simply stops surfacing the market.

### 15.9 Metadata — image, socials, evidence — on-chain forever

Launch metadata is stored on the deployed `ResearchToken` as constructor immutables:

- `name`, `symbol` — required
- `image` — IPFS or HTTPS URI of the project image, required
- `description` — required
- `website`, `telegram`, `x` — optional social links
- `evidenceURI` — required, must link to one of: PubMed DOI, arXiv preprint, RCSB PDB structure ID, EticaLabs Autopilot run, IPFS-pinned preprint, or ORCID-signed researcher attestation

Because this metadata is in the contract constructor (and therefore in the deployed bytecode + Sourcify-verified standard-input.json), it is retrievable forever from chain alone, with no dependence on EticaHub's frontend or any centralized indexer. The launchpad UI surfaces this metadata on `/research-markets/[token]`; aggregators and other dapps can read it directly from the contract.

Image upload in the launch wizard goes through a server-side Pinata proxy at `/api/research-markets/upload-image` (the API JWT is kept off the browser). If Pinata is not configured, the wizard falls back to a paste-URI input — a researcher can pin to any IPFS gateway of their choice.

### 15.10 What EticaResearchMarkets does not do

- **It is not a 1:1 ETX wrapper.** Tokens are priced on a constant-product curve, not redeemed at parity. A 1:1 wrapper would have no price discovery, no upside for early supporters, and no launchpad utility.
- **It does not migrate to an external pool at graduation.** Graduation is UI-only (§15.7).
- **It does not give the protocol operator a withdrawal authority.** There is no admin function that can pull ETX out of any curve or out of the free pool. The 5M ETX seed and every accrued ETX is locked behind the contract's deliberate absence of a withdrawal path.
- **It does not pay the treasury.** The 0% treasury slice is deliberate. The launchpad pays researchers and pays the ETI LP burn; treasury revenue from this surface would conflict with the floor-pull property and the no-protocol-cut posture for science funding.

### 15.11 Deployment status

- `EticaResearchMarkets` singleton: deployed via the operator-only `/deploy/research-markets` browser deployer, with the 80/10/0/10 fee split pre-filled (PR #203). Treasury transfers the 5M ETX seed post-deploy and updates `packages/shared/src/addresses.ts`.
- `/research-markets` (launchpad UI): live with tabbed views (Live / Pending graduation / Graduated / Sunset), `/research-markets/launch` (token launch wizard), `/research-markets/[token]` (detail page with buy/sell card, provenance + Sourcify badge, permanent-floor-pull explainer).
- `/swap` and `/trade` wired to surface graduated tokens automatically (PR #202).
- Auto-Sourcify cron + canonical bundle + status badge (PR #204).
- The 5M ETX seed is held by the treasury and transferred in the same operator session as the singleton deploy.

---

## 16. Governance and Treasury

### 16.1 Treasury wallet

The EticaHub treasury is an EOA at `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`. It holds:

- Essentially all of the ETX supply at genesis (minus the amount seeded into pools).
- LP tokens for the initial ETI/ETX and EGAZ/ETX pools (less whatever fraction has been moved through the TreasuryHarvester POL-burn path, which permanently locks LP tokens to the burn sink).
- Swap protocol fees (after `feeTo` is set) and pool-creation fees.
- Any undistributed portion of the 10% farm bucket from the Harvester, held in treasury for `ETXFarms` distributions.

### 16.2 Administrative keys

| Contract | Key | Capabilities |
|---|---|---|
| `EticaSwapFactory` — `feeToSetter` | Treasury wallet | Can set `feeTo`, rotate `feeToSetter`, modify `pairCreationFee`, and flip `trustedCreators` entries |
| `EticaSwapFactory` — `feeTo` | Treasury wallet | Receives the 0.05% protocol swap fee and the 10,000 ETX pool-creation fee |
| `DutchOrderReactor` — `owner` | Treasury wallet | Can change the protocol fee controller; fee itself capped at 1% by the controller |
| `EticaProtocolFeeController` — `owner` | Treasury wallet | Can flip the ETX-denominated protocol fee between 0 and 100 BPS |
| `StakedETX` | **no owner** | Contract has no `Ownable` inheritance; `distributeRewards` is permissionless; **cannot** seize deposits, pause, or mint shares |
| `TreasuryHarvester` — `owner` | Treasury wallet | Can emergency-sweep to treasury and tune the 10/10/40/40 split within contract-enforced caps. The keeper role was retired in v2 (PR #109); `harvest()` is now fully permissionless with a 1-day cooldown and a small caller-tip incentive. |
| `EticaStableSwap` — `owner` | Treasury wallet | Parameter knobs only: `rampA`, `setSwapFee`, `setAdminFee`, `setAdminFeeRecipient`, `lockedWithdraw` (only fires post-2036 timelock unlock). Cannot mint shares, cannot seize LP, cannot redirect existing reserves. |
| `LiquidityTimelock10y` — `owner` | Treasury wallet | Can withdraw the locked LP only after the 2036-05-01 unlock timestamp; the contract has no early-unlock path. |
| `StableSwapHarvesterAdapter` | **no owner** | Permissionless `harvest()`. Anyone can poke it; output is fixed by the on-chain 50/50 admin-fee math. |
| `ETXFarms` — `owner` | Treasury wallet | Can register new pools, retune weights, set fallback recipient. `rescueToken` is guarded against registered LP tokens and the reward token (ETX). Cannot pause withdrawals, cannot retroactively change reward semantics. |
| `EticaResearchNFT` | **no owner** | No `Ownable`. The only privileged write is the attestor-signed `claim`; the attestor address is immutable and cannot redirect royalties, edit records, or admin-burn. |
| `EticaResearchMarketplace` | **no owner** | No admin, no pause, no fee beyond the ERC-2981 royalty. |
| `EticaResearchMarkets` — `owner` | Treasury wallet | Parameter knobs on the launchpad singleton only; cannot touch per-market reserves or the shared free pool beyond the contract-enforced math. |

The treasury-held owner keys (`feeToSetter`, `feeTo`, and the various contract `owner` roles listed above) are externally-owned accounts controlled by the treasury wallet, chosen for low operational ceremony. None of them can drain user funds, mint ETX, or alter already-collected balances — their authority is bounded by the contract-enforced caps described in each row.

### 16.3 On-chain authority of ETX

ETX itself has no admin — no pause, no mint, no blacklist, no upgrade. Governance in the "change the token" sense is impossible because the contract has no mutable configuration. All governance discretion is exercised over the DEX and treasury, not over ETX.

---

## 17. Security

- **Foundry test coverage:** 500+ tests across swap, research, launchpad, UniswapX reactor wiring, stETX, TreasuryHarvester, ETXFarms, and EticaStableSwap. All passing in CI; aggregated across `packages/contracts` and `packages/trading-contracts`.
- **Pinned dependencies:** OpenZeppelin v5.1.0 (pinned specifically to avoid Cancun-only `mcopy` on Etica's Paris-EVM).
- **No upgradeability / no proxies:** Every contract is deployed at its final implementation. There is no upgrade path that could silently change logic.
- **No admin mints:** ETX supply is fixed at deploy. stETX shares can only be minted in exchange for ETX deposits.
- **No custody paths:** `StakedETX` has no owner at all — `distributeRewards` is permissionless and can only *increase* the exchange rate. Harvester keeper can only perform the 10/10/40/40 redistribution. Reactor owner can only toggle a capped protocol fee. No key in the system can unilaterally drain user funds.
- **No external audits.** EticaHub ships without a third-party audit. Users should size their exposure accordingly.

---

## 18. Risks

This section is non-exhaustive. ETX and EticaHub are **experimental software** and exposure should be sized accordingly.

- **Liquidity risk.** The launch pools were intentionally small (~$6 total at NonKYC reference prices). Trades of even a few dollars move price substantially. Depth grows only as organic volume, LPs, and (future) POL-burn harvests arrive.
- **Smart-contract risk.** v1 ships without a third-party audit. Every surface (DEX, Trading Stack, stETX, Harvester, ETXFarms, EticaStableSwap + Timelock + adapter) is tested but unaudited.
- **Regulatory risk.** Despite the fair-launch structure (no sale, no allocation, no vesting, no promises), any token that has a market value is subject to interpretation by various regulators in various jurisdictions. ETX is not offered for sale anywhere; users who acquire it on EticaSwap do so at their own risk and on their own legal assessment. stETX is likewise not sold; it is minted 1:1 against deposited ETX. Two layered frontend access policies are applied as a good-faith gesture mirroring the posture adopted by Uniswap, Aave, and similar Western DeFi frontends:
  1. **Comprehensively sanctioned jurisdictions (KP / SY / CU / IR).** The entire EticaHub frontend is rewritten to a compliance notice for visitors whose IP geolocates to North Korea, Syria, Cuba, or Iran. Every path on the site (including `/swap`, `/pool`, `/trade`, `/labs`, `/explorer`, `/whitepaper`) is unavailable.
  2. **United States.** The stETX-related surfaces are suppressed: `/stake` and `/farms` rewrite to the compliance notice; on `/swap` stETX is removed from both pickers; on `/pool` the stETX/ETX stableswap LP card is hidden, stETX is rejected as a custom ERC20 in the V2 pair selector, and any user-held LP position whose underlying tokens include stETX is filtered out of the positions list. There is no exit affordance — the gate is a single uniform suppression of stETX from the frontend rather than a "no new entry, free exit" posture.

  The underlying smart contracts remain permissionless, open-source, and reachable on-chain regardless of jurisdiction; both layers are frontend access policies, not protocol-level restrictions. See [`apps/web/src/lib/geoBlock.ts`](../apps/web/src/lib/geoBlock.ts), [`apps/web/src/lib/geoBlockServer.ts`](../apps/web/src/lib/geoBlockServer.ts), and [`apps/web/src/middleware.ts`](../apps/web/src/middleware.ts).
- **Operator risk.** The keeper EOAs (Trading Stack reference keeper, future Harvester keeper) are hot and can be compromised. The system is designed so that a compromise of any keeper cannot drain user funds — the worst case is failed or delayed redistribution — but operational degradation is possible.
- **Oracle risk.** USD prices in the UI and the buy bot are derived from NonKYC's public API for ETI/USDT and EGAZ/USDT. A NonKYC outage or a manipulated quote would surface as wrong USD labels, not as wrong on-chain math (which is always denominated in the asset itself).
- **Chain risk.** The Etica blockchain itself is an independent L1 with its own validator set, its own client software, and its own operational history. EticaHub inherits all of Etica L1's risks (consensus, liveness, RPC availability, chain reorgs).
- **Team risk.** EticaHub is a small community-built project. There is no institutional backer and no formal legal entity.

---

## 19. FAQ

**Is ETX the same as ETI?**
No. ETI is Etica Protocol's native asset. ETX is EticaHub's own ERC-20, unrelated at the token level. They are connected only by the fact that EticaSwap trades them as the first-opened pool.

**Is EticaHub officially endorsed by the Etica Protocol core team?**
No. See §1.

**Can I buy ETX from the team?**
No. The team does not sell ETX. The only market is EticaSwap.

**Why such a small FDV?**
Small FDV + low LP depth keeps the initial unit price small ($0.00001/ETX) and reflects that real distribution happens post-launch as volume arrives, not at genesis. We explicitly do not want to open at a large implied FDV with no capital behind it.

**Does stETX mint new ETX?**
No. stETX is a pure redistribution vault. Every stETX yield dollar comes from LP fees the treasury *already earned* and redistributed. If fees stall, yield stalls. There is no emissions schedule and no new ETX can ever be created.

**What is the POL burn?**
Every Harvester cycle permanently locks 40% of the harvested fee tranche (paired with ETI/EGAZ) as LP in the ETI/ETX and EGAZ/ETX pools, then sends the resulting LP tokens to the burn sink. The depth stays in the pool forever and can never be withdrawn. See §9.3.

**How do I launch a research token?**
Go to `/research-markets/launch`, fill in the token's metadata and the required evidence link (PubMed DOI, arXiv preprint, RCSB PDB ID, an EticaLabs Autopilot run, an IPFS-pinned preprint, or an ORCID-signed attestation), and deploy. The token lists immediately on its own bonding curve against ETX, with auto-Sourcify verification of its bytecode. See §15.

**Why is stETX hidden if I'm in the US?**
Frontend good-faith gesture. Same posture as Uniswap and Aave. For visitors geolocating to the United States the EticaHub website suppresses every stETX-related surface uniformly: `/stake` and `/farms` rewrite to a compliance notice, stETX is removed from `/swap` pickers, the stETX/ETX stableswap LP card is hidden on `/pool`, stETX is rejected as a custom ERC20 in the `/pool` pair selector, and stETX-containing positions are filtered out of the `/pool` positions list. The underlying smart contracts remain permissionless and reachable on-chain; this is a frontend access policy, not a protocol-level restriction. See §18 (Risks → Regulatory).

**Why is the entire site unavailable in my region?**
If you are visiting from North Korea, Syria, Cuba, or Iran (the comprehensive-sanctions list) the EticaHub frontend is unavailable site-wide as a good-faith compliance measure. The underlying smart contracts remain permissionless on the Etica network; this is a frontend access policy, not a protocol-level restriction. See §18 (Risks → Regulatory).

**Is the buy bot official? Is it custodial?**
Yes, operated by EticaHub. Non-custodial: the bot reads on-chain `Swap` logs and posts messages. It holds no funds, signs no transactions, and has no privileged access. See §13.

**How do I verify a contract?**
Submit source + metadata at `/explorer/verify/[addr]`; we push to Sourcify. Once Sourcify acks, the explorer reads back the verified ABI + sources on every tx and contract page. See §11.2.

**Where is the code?**
[https://github.com/iamdexx/etica-hub](https://github.com/iamdexx/etica-hub) — monorepo, MIT-licensed.

---

## Appendix A — Canonical addresses

Etica mainnet (chain id `61803`). Canonical source: `packages/shared/src/addresses.ts`.

| Contract | Address |
|---|---|
| ETX (`EticaHub`) | `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044` |
| WEGAZ (`Wrapped EGAZ`) | `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a` |
| EticaSwapFactory | `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3` |
| EticaSwapRouter | `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723` |
| ETI/ETX pool | *derived from `factory.getPair(ETI, ETX)` after seeding* |
| EGAZ/ETX pool | *derived from `factory.getPair(WEGAZ, ETX)` after seeding* |
| Permit2 | `0x165F71f549415f44883e370Df12169Dd99570eE5` |
| UniswapX `DutchOrderReactor` | `0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8` |
| `EticaProtocolFeeController` | `0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a` |
| `OrderRegistry` | `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9` |
| `StakedETX` (stETX) | `0x75d81d03a98CD9195593b8963aF17E13fAa70334` |
| `TreasuryHarvester` | `0x5d8B1138559fADc3Bb90e8317eB16922eAa076f5` (live, permissionless v2) |
| `ETXFarms` | `0xEBAfdd24ABF8290f0B433E689631466ABD13c6aD` |
| `EticaStableSwap` (stETX/ETX) | `0xbbf5814C1EA0531Cb07541b80c547ee7878C036E` |
| `LiquidityTimelock10y` | `0xFdf919673570Cea9c513461604450D003716d739` (unlocks 2036-05-01) |
| `StableSwapHarvesterAdapter` | `0x9Adc6298EFDcc1604CB95DaaB33331f866DDBe76` |
| `EticaResearchMarkets` (launchpad singleton) | `0x6605d2F6A8b77a8dC7f53Fd1EDe0974d85937D17` |
| `EticaResearchNftMetadataLib` | `0x66aa725d9d18481bB937F4DF2DA68f82DF964219` |
| `EticaResearchNft` (RES — 3-tier mint) | `0x4B7673665543bC1ABf13a023Ae2A04e91A4259f9` |
| `EticaResearchMarketplace` (RES secondary market) | `0x4D1eb3884927A9ad0d77E1627698f1153AAd5aDC` |
| ETI (Etica protocol, external) | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |
| Treasury wallet | `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` |

---

## Appendix B — Chain parameters

| Parameter | Value |
|---|---|
| Network name | Etica Mainnet |
| RPC URL | `https://rpc2.etica-stats.org` |
| Chain ID | 61803 |
| Native gas token | EGAZ |
| Block explorer (EticaHub) | `https://eticahub.com/explorer` |
| Block explorer (Etica Protocol) | `https://eticascan.org` |
| Canonical ETI address | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |

---

*EticaHub is an independent, community-built project. This document describes EticaHub's own design and contracts. It does not speak for, commit, or represent the Etica Protocol core team in any capacity.*
